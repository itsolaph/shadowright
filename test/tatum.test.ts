import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RpcError, TatumSuiClient, TokenBucket } from '../src/tatum.ts';

/** A clock whose `sleep` advances time instantly. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fetch stub that serves canned replies in order and records each request. */
function stubFetch(replies: Reply[]) {
  const requests: Array<{ headers: Record<string, string>; body: { method: string; params: unknown[] } }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    requests.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const reply = replies.shift() ?? { status: 500 };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const ok = (result: unknown): Reply => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result } });
const API_KEY = 'test-key-not-a-secret';

function client(replies: Reply[], cacheDir?: string) {
  const { fetchImpl, requests } = stubFetch(replies);
  const clock = fakeClock();
  const tatum = new TatumSuiClient({
    url: 'https://rpc.example',
    apiKey: API_KEY,
    cacheDir,
    fetchImpl,
    sleep: clock.sleep,
    bucket: new TokenBucket(100, 1, clock),
  });
  return { tatum, requests };
}

describe('TokenBucket', () => {
  it('spaces requests evenly at the configured rate', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2.5, 1, clock);
    const grants: number[] = [];
    for (let i = 0; i < 5; i++) {
      await bucket.take();
      grants.push(clock.now());
    }
    assert.deepEqual(grants, [0, 400, 800, 1200, 1600]);
  });

  it('serves concurrent callers one at a time', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 1, clock);
    const grants: number[] = [];
    await Promise.all([1, 2, 3].map(() => bucket.take().then(() => grants.push(clock.now()))));
    assert.deepEqual(grants, [0, 500, 1000]);
  });
});

describe('TatumSuiClient', () => {
  let cacheDir: string;
  before(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'shadowright-test-'));
  });
  after(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('sends JSON-RPC with the API key header', async () => {
    const { tatum, requests } = client([ok('42')]);
    assert.equal(await tatum.getLatestCheckpoint(), '42');
    assert.equal(requests[0]?.headers['x-api-key'], API_KEY);
    assert.equal(requests[0]?.body.method, 'sui_getLatestCheckpointSequenceNumber');
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const { tatum, requests } = client([{ status: 429, headers: { 'retry-after': '1' } }, { status: 503 }, ok('7')]);
    assert.equal(await tatum.call('sui_getLatestCheckpointSequenceNumber', [], { noCache: true }), '7');
    assert.equal(requests.length, 3);
    assert.deepEqual(tatum.stats, { networkCalls: 3, cacheHits: 0, retries: 2 });
  });

  it('gives up after the maximum attempts without leaking the key', async () => {
    const { tatum, requests } = client([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    await assert.rejects(tatum.call('m', [], { noCache: true }), (error: Error) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.message, 'm: HTTP 503');
      assert.ok(!error.message.includes(API_KEY));
      return true;
    });
    assert.equal(requests.length, 5);
  });

  it('does not retry JSON-RPC errors or client errors', async () => {
    const rpc = client([{ status: 200, body: { error: { code: -32602, message: 'Invalid params' } } }]);
    await assert.rejects(rpc.tatum.call('m', [], { noCache: true }), /m: Invalid params/);
    assert.equal(rpc.requests.length, 1);

    const http = client([{ status: 401 }]);
    await assert.rejects(http.tatum.call('m', [], { noCache: true }), /m: HTTP 401/);
    assert.equal(http.requests.length, 1);
  });

  it('serves repeated calls from the disk cache', async () => {
    const { tatum, requests } = client([ok({ decimals: 6, symbol: 'USDC', name: 'USD Coin' })], cacheDir);
    const first = await tatum.getCoinMetadata('0x1::usdc::USDC');
    const second = await tatum.getCoinMetadata('0x1::usdc::USDC');
    assert.deepEqual(first, second);
    assert.equal(requests.length, 1);
    assert.equal(tatum.stats.cacheHits, 1);

    // A brand-new client over the same directory pays nothing either.
    const fresh = client([], cacheDir);
    assert.deepEqual(await fresh.tatum.getCoinMetadata('0x1::usdc::USDC'), first);
    assert.equal(fresh.requests.length, 0);
  });

  it('does not cache results rejected by cacheIf', async () => {
    const page = { data: [], nextCursor: null, hasNextPage: false };
    const { tatum, requests } = client([ok(page), ok(page)], cacheDir);
    const options = { cacheIf: (r: unknown) => (r as typeof page).hasNextPage };
    await tatum.queryTransactionBlocks({ FromAddress: '0xabc' }, null, 50, options);
    await tatum.queryTransactionBlocks({ FromAddress: '0xabc' }, null, 50, options);
    assert.equal(requests.length, 2);
  });
});
