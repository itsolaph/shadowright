import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemWalMock } from '@mysten-incubation/memwal';
import { contextQuery, formatMemory, parseMemory, ShadowMemory, type MemoryBackend } from '../src/memory.ts';
import { action, MON_AFTERNOON, record } from './helpers.ts';

const CLAIM = action({ category: 'claim', target: '0xvault::vault', coin: 'vSUI' });
const REDEEM = action({ category: 'stake', target: '0xlst::pool', coin: 'vSUI' });

describe('memory format', () => {
  it('round-trips a record through text', () => {
    const original = record({
      after: 'transfer',
      predicted: action({ target: '0xdex::router', coin: 'SUI>USDC' }),
      actual: action({ target: '0xother pool::v2', coin: 'SUI>USDT', amountBucket: '10-100' }),
      correct: false,
      misses: ['target', 'coin'],
    });
    assert.deepEqual(parseMemory(formatMemory(original)), original);
  });

  it('keeps the live prediction time and says it came before the reading', () => {
    const live = record({ predictedAtMs: MON_AFTERNOON - 60_000 });
    const text = formatMemory(live);
    assert.match(text, /I predicted live at 2026-10-19 13:59 UTC, before reading the transaction:/);
    assert.deepEqual(parseMemory(text), live);
  });

  it('reads like a sentence and states the lesson', () => {
    const text = formatMemory(
      record({ after: 'stake', actual: action({ coin: 'SUI>USDT' }), correct: false, misses: ['coin'] }),
    );
    assert.match(text, /^Shadowright memory \[swap\]\. Context: Mon afternoon \(2026-10-19 14:00 UTC\), after a stake\./);
    assert.match(text, /Verdict: wrong coin\./);
    assert.match(text, /Lesson: I expected swap 1-10 SUI>USDC via 0xdex::router but the user did swap 1-10 SUI>USDT/);
  });

  it('ignores memories it did not write', () => {
    assert.equal(parseMemory('The user likes coffee.'), undefined);
    assert.equal(parseMemory('#sr1 tx=abc pc=nonsense'), undefined);
  });

  it('builds recall queries in the same words as the memories', () => {
    assert.equal(
      contextQuery(MON_AFTERNOON, { after: 'swap' }),
      'Shadowright memory. Context: Mon afternoon, after a swap. What did the user do?',
    );
    assert.equal(
      contextQuery(MON_AFTERNOON, { after: 'claim', previous: CLAIM, sinceMs: 2 * 60_000 }),
      'Shadowright memory. Context: Mon afternoon, 2 minutes after claim 1-10 vSUI via 0xvault::vault. What did the user do?',
    );
  });

  it('remembers the previous action and the gap, and states the habit as the lesson', () => {
    const habit = record({ after: 'claim', previous: CLAIM, sinceMs: 60_000, actual: REDEEM, predicted: REDEEM });
    const text = formatMemory(habit);
    assert.match(text, /Context: Mon afternoon \(2026-10-19 14:00 UTC\), 1 minute after claim 1-10 vSUI via 0xvault::vault\./);
    assert.match(text, /Lesson: after claim 1-10 vSUI via 0xvault::vault, the user does stake 1-10 vSUI via 0xlst::pool; keep predicting it\./);
    assert.deepEqual(parseMemory(text), habit);
  });

  it('turns a miss after a break into an explicit lesson', () => {
    const miss = record({ after: 'claim', previous: CLAIM, sinceMs: 3 * 24 * 3600_000, predicted: REDEEM, actual: action(), correct: false, misses: ['category'] });
    assert.match(
      formatMemory(miss),
      /Lesson: after claim 1-10 vSUI via 0xvault::vault and a break, I expected stake 1-10 vSUI via 0xlst::pool but the user did swap 1-10 SUI>USDC via 0xdex::router; next time prefer swap/,
    );
  });
});

describe('ShadowMemory', () => {
  it('remembers and recalls records through a MemWal-compatible backend', async () => {
    const memory = new ShadowMemory(MemWalMock.create({ namespace: 'test' }), 'test');
    const stored = await memory.remember(record({ digest: 'tx1', after: 'swap' }));
    assert.ok(stored.jobId);
    assert.ok(stored.blobId);

    const recalled = await memory.recall(contextQuery(MON_AFTERNOON, { after: 'swap' }));
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]?.record.digest, 'tx1');
  });

  it('resubmits a memory whose job failed on the relayer, under a fresh idempotency key', async () => {
    const mock = MemWalMock.create({ namespace: 'test' });
    const keys: string[] = [];
    let failures = 1;
    const flaky: MemoryBackend = {
      remember: (text, namespace, options) => {
        keys.push(options?.idempotencyKey ?? '');
        return mock.remember(text, namespace, options);
      },
      waitForRememberJob: async (jobId, opts) => {
        if (failures-- > 0) throw new Error('remember job failed: durable upload exceeded step budget');
        return mock.waitForRememberJob(jobId, opts);
      },
      recall: (params) => mock.recall(params),
      restore: (namespace, limit) => mock.restore(namespace, limit),
      health: () => mock.health(),
    };
    const stored = await new ShadowMemory(flaky, 'test').remember(record({ digest: 'tx1' }));
    assert.ok(stored.blobId);
    assert.deepEqual(keys, ['shadowright:test:tx1', 'shadowright:test:tx1:retry-1']);
  });

  it('waits out a relayer rate limit for as long as the relayer asks, when told to', async () => {
    const mock = MemWalMock.create({ namespace: 'test' });
    let limited = 1;
    const busy: MemoryBackend = {
      remember: (text, namespace, options) => mock.remember(text, namespace, options),
      waitForRememberJob: (jobId, opts) => mock.waitForRememberJob(jobId, opts),
      recall: async (params) => {
        if (limited-- > 0) {
          throw new Error('Walrus Memory server error (429): {"error":"Rate limit exceeded","retry_after_seconds":300}');
        }
        return mock.recall(params);
      },
      restore: (namespace, limit) => mock.restore(namespace, limit),
      health: () => mock.health(),
    };
    const waits: number[] = [];
    const patient = new ShadowMemory(busy, 'test', { rateLimitRetries: 1, sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(await patient.recall('anything'), []);
    assert.deepEqual(waits, [300_000]);

    limited = 1;
    await assert.rejects(new ShadowMemory(busy, 'test').recall('anything'), /\(429\)/, 'fails fast by default (web requests)');
  });

  it('retries a recall that timed out on the relayer', async () => {
    const mock = MemWalMock.create({ namespace: 'test' });
    let timeouts = 1;
    const slow = {
      remember: mock.remember.bind(mock),
      waitForRememberJob: mock.waitForRememberJob.bind(mock),
      restore: mock.restore.bind(mock),
      health: mock.health.bind(mock),
      recall: async (params: Parameters<MemoryBackend['recall']>[0]) => {
        if (timeouts-- > 0) throw new Error('Walrus Memory server error (504): Recall timed out after 13000ms during seal_decrypt');
        return mock.recall(params);
      },
    } satisfies MemoryBackend;
    const memory = new ShadowMemory(slow, 'test', { sleep: async () => undefined });
    assert.deepEqual(await memory.recall('anything'), []);
  });

  it('recallAll deduplicates and orders by time', async () => {
    const memory = new ShadowMemory(MemWalMock.create({ namespace: 'test' }), 'test');
    await memory.remember(record({ digest: 'late', timestampMs: MON_AFTERNOON + 1000 }));
    await memory.remember(record({ digest: 'early', actual: action({ category: 'transfer' }), correct: false, misses: ['category'] }));
    const all = await memory.recallAll();
    assert.deepEqual(
      all.map((r) => r.digest),
      ['early', 'late'],
    );
  });
});
