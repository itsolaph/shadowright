import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DiskCache, GRAPHQL_ERROR_CODE, graphqlUrl, RpcError, TatumSuiClient, TokenBucket } from '../src/tatum.ts';

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
  const requests: Array<{ url: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const reply = replies.shift() ?? { status: 500 };
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const ok = (data: unknown): Reply => ({ status: 200, body: { data } });
const API_KEY = 'test-key-not-a-secret';
const checkpoint = (sequenceNumber: number) => ok({ checkpoint: { sequenceNumber } });
const pageInfo = { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };

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

  it('posts GraphQL to the /graphql endpoint with the API key header', async () => {
    const { tatum, requests } = client([checkpoint(42)]);
    assert.equal(await tatum.getLatestCheckpoint(), '42');
    assert.equal(requests[0]?.url, 'https://rpc.example/graphql');
    assert.equal(requests[0]?.headers['x-api-key'], API_KEY);
    assert.match(requests[0]?.body.query ?? '', /checkpoint \{ sequenceNumber \}/);
    assert.equal(graphqlUrl('https://rpc.example/graphql/'), 'https://rpc.example/graphql');
  });

  it('retries rate limits and server errors, then succeeds', async () => {
    const { tatum, requests } = client([{ status: 429, headers: { 'retry-after': '1' } }, { status: 503 }, checkpoint(7)]);
    assert.equal(await tatum.getLatestCheckpoint(), '7');
    assert.equal(requests.length, 3);
    assert.deepEqual(tatum.stats, { networkCalls: 3, cacheHits: 0, retries: 2 });
  });

  it('gives up after the maximum attempts without leaking the key', async () => {
    const { tatum, requests } = client([{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    await assert.rejects(tatum.getLatestCheckpoint(), (error: Error) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.message, 'latestCheckpoint: HTTP 503');
      assert.ok(!error.message.includes(API_KEY));
      return true;
    });
    assert.equal(requests.length, 5);
  });

  it('does not retry GraphQL errors or client errors', async () => {
    const gql = client([{ status: 200, body: { data: null, errors: [{ message: 'Unknown field' }] } }]);
    await assert.rejects(gql.tatum.getLatestCheckpoint(), (error: Error) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.message, 'latestCheckpoint: Unknown field');
      assert.equal(error.code, GRAPHQL_ERROR_CODE);
      return true;
    });
    assert.equal(gql.requests.length, 1);

    const http = client([{ status: 401 }]);
    await assert.rejects(http.tatum.getLatestCheckpoint(), /latestCheckpoint: HTTP 401/);
    assert.equal(http.requests.length, 1);
  });

  it('pages transactions newest first with last/before and maps them', async () => {
    const connection = {
      pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: 'opaque-start', endCursor: 'opaque-end' },
      nodes: [{ digest: 'older' }, { digest: 'newer' }],
    };
    const { tatum, requests } = client([ok({ transactions: connection })]);
    const page = await tatum.queryTransactionBlocks({ FromAddress: '0xabc' }, 'opaque-cursor', 2, { descending: true, digestsOnly: true, noCache: true });
    assert.deepEqual(page, { data: [{ digest: 'newer' }, { digest: 'older' }], nextCursor: 'opaque-start', hasNextPage: true });
    assert.deepEqual(requests[0]?.body.variables, { filter: { sentAddress: '0xabc' }, last: 2, before: 'opaque-cursor' });
    assert.match(requests[0]?.body.query ?? '', /nodes \{ digest \}/);
  });

  it('maps events with opaque cursors', async () => {
    const event = {
      sequenceNumber: 3,
      timestamp: '2025-10-21T10:00:00.000Z',
      transaction: { digest: 'tx1' },
      sender: { address: '0xabc' },
      transactionModule: { name: 'pool', package: { address: '0xdex' } },
      contents: { type: { repr: '0xdex::pool::SwapEvent' }, json: { amount: '5' } },
    };
    const { tatum, requests } = client([ok({ events: { pageInfo: { ...pageInfo, hasNextPage: true, endCursor: 'next' }, nodes: [event] } })]);
    const page = await tatum.queryEvents({ MoveEventType: '0xdex::pool::SwapEvent' }, null, 50, { noCache: true });
    assert.deepEqual(requests[0]?.body.variables, { filter: { type: '0xdex::pool::SwapEvent' }, first: 50 });
    assert.equal(page.nextCursor, 'next');
    assert.deepEqual(page.data[0], {
      type: '0xdex::pool::SwapEvent',
      sender: '0xabc',
      packageId: '0xdex',
      transactionModule: 'pool',
      parsedJson: { amount: '5' },
      id: { txDigest: 'tx1', eventSeq: '3' },
      timestampMs: String(Date.UTC(2025, 9, 21, 10)),
    });
  });

  it('reads coins, the gas price and simulations', async () => {
    const coins = { address: { objects: { pageInfo, nodes: [{ address: '0xc01', version: 12, digest: 'd1', contents: { json: { id: '0xc01', balance: '900' } } }] } } };
    const simulation = { simulateTransaction: { effects: { status: 'FAILURE', executionError: { message: 'InsufficientGas' } } } };
    const { tatum, requests } = client([ok(coins), ok({ epoch: { referenceGasPrice: '750' } }), ok(simulation)]);
    assert.deepEqual((await tatum.getCoins('0xabc', '0x2::sui::SUI', 5)).data, [
      { coinType: '0x2::sui::SUI', coinObjectId: '0xc01', version: '12', digest: 'd1', balance: '900' },
    ]);
    assert.equal(requests[0]?.body.variables.type, '0x2::coin::Coin<0x2::sui::SUI>');
    assert.equal(await tatum.getReferenceGasPrice(), '750');
    const dryRun = await tatum.dryRunTransactionBlock('AAEC');
    assert.deepEqual(dryRun.effects?.status, { status: 'failure', error: 'InsufficientGas' });
    assert.deepEqual(requests[2]?.body.variables, { tx: { bcs: { value: 'AAEC' } } });
  });

  it('serves repeated calls from the disk cache', async () => {
    const { tatum, requests } = client([ok({ coinMetadata: { decimals: 6, symbol: 'USDC', name: 'USD Coin' } })], cacheDir);
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
    const reply = ok({ transactions: { pageInfo, nodes: [] } });
    const { tatum, requests } = client([reply, reply], cacheDir);
    const options = { cacheIf: (r: unknown) => (r as { hasNextPage: boolean }).hasNextPage };
    await tatum.queryTransactionBlocks({ FromAddress: '0xabc' }, null, 50, options);
    await tatum.queryTransactionBlocks({ FromAddress: '0xabc' }, null, 50, options);
    assert.equal(requests.length, 2);
  });

  it('never reads responses cached by the old JSON-RPC client', async () => {
    const old = new DiskCache(cacheDir);
    await old.set(DiskCache.keyOf('suix_getCoinMetadata', ['0x8::old::OLD']), { decimals: 1, symbol: 'OLD', name: 'stale' });
    const { tatum, requests } = client([ok({ coinMetadata: { decimals: 9, symbol: 'NEW', name: 'New' } })], cacheDir);
    assert.equal((await tatum.getCoinMetadata('0x8::old::OLD'))?.symbol, 'NEW');
    assert.equal(requests.length, 1);
  });

  it('does not cache partial data that came with errors', async () => {
    const partial = { status: 200, body: { data: { coinMetadata: null }, errors: [{ message: 'timeout' }] } };
    const { tatum, requests } = client([partial, ok({ coinMetadata: null })], cacheDir);
    await assert.rejects(tatum.getCoinMetadata('0x9::x::X'), /coinMetadata: timeout/);
    assert.equal(await tatum.getCoinMetadata('0x9::x::X'), null);
    assert.equal(requests.length, 2);
  });
});
