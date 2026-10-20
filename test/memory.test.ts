import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemWalMock } from '@mysten-incubation/memwal';
import { contextQuery, formatMemory, parseMemory, ShadowMemory } from '../src/memory.ts';
import { action, MON_AFTERNOON, record } from './helpers.ts';

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
      contextQuery(MON_AFTERNOON, 'swap'),
      'Shadowright memory. Context: Mon afternoon, after a swap. What did the user do?',
    );
  });
});

describe('ShadowMemory', () => {
  it('remembers and recalls records through a MemWal-compatible backend', async () => {
    const memory = new ShadowMemory(MemWalMock.create({ namespace: 'test' }), 'test');
    const stored = await memory.remember(record({ digest: 'tx1', after: 'swap' }));
    assert.ok(stored.jobId);
    assert.ok(stored.blobId);

    const recalled = await memory.recall(contextQuery(MON_AFTERNOON, 'swap'));
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0]?.record.digest, 'tx1');
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
