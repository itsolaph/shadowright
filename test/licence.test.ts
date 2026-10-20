import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { accuracyOf, categoriesOf, computeBoard, DEFAULT_LICENCE_POLICY, initialStatus, step, type LicenceStatus } from '../src/licence.ts';
import type { MemoryRecord } from '../src/memory.ts';
import { action, DAY, MON_AFTERNOON, record } from './helpers.ts';

/** A sequence of swap memories, one per day, from a string like "++-+": + correct, - wrong. */
function swaps(pattern: string): MemoryRecord[] {
  return [...pattern].map((symbol, i) =>
    record({
      digest: `swap${i}`,
      timestampMs: MON_AFTERNOON + i * DAY,
      correct: symbol === '+',
      misses: symbol === '+' ? [] : ['target'],
      actual: symbol === '+' ? action() : action({ target: '0xother::pool' }),
    }),
  );
}

function run(records: MemoryRecord[]): LicenceStatus {
  let status = initialStatus('swap');
  for (const r of records) status = step(status, r).status;
  return status;
}

describe('licence state machine', () => {
  it('stays LOCKED until enough memories exist', () => {
    const status = run(swaps('++++'));
    assert.equal(status.state, 'LOCKED');
    assert.equal(status.memories, 4);
  });

  it('grants a licence at the minimum number of memories with enough accuracy', () => {
    const result = step(run(swaps('++++')), swaps('+++++')[4]!);
    assert.equal(result.status.state, 'LICENSED');
    assert.equal(result.event?.from, 'LOCKED');
    assert.equal(result.event?.to, 'LICENSED');
    assert.match(result.event?.reason ?? '', /100% over last 5/);
  });

  it('keeps SHADOWING while accuracy is below the threshold', () => {
    const status = run(swaps('++-+-+'));
    assert.equal(status.state, 'SHADOWING');
    assert.equal(accuracyOf(status), 4 / 6);
  });

  it('revokes the licence on a single wrong call', () => {
    const records = swaps('++++++-');
    const licensed = run(records.slice(0, 6));
    assert.equal(licensed.state, 'LICENSED');

    const result = step(licensed, records[6]!);
    assert.equal(result.status.state, 'SHADOWING');
    assert.equal(result.status.revocations, 1);
    assert.match(result.event?.reason ?? '', /^revoked: wrong call \(target\) while licensed$/);
  });

  it('requires a probation streak before re-licensing even if window accuracy is high', () => {
    const records = swaps('+++++++++-+++');
    const afterTwo = run(records.slice(0, 12));
    assert.ok(accuracyOf(afterTwo) >= DEFAULT_LICENCE_POLICY.minAccuracy);
    assert.equal(afterTwo.state, 'SHADOWING');
    assert.equal(afterTwo.onProbation, true);

    const afterThree = run(records);
    assert.equal(afterThree.state, 'LICENSED');
    assert.equal(afterThree.onProbation, false);
  });

  it('measures accuracy over a sliding window only', () => {
    const status = run(swaps('-----++++++++++'));
    assert.equal(status.recent.length, DEFAULT_LICENCE_POLICY.window);
    assert.equal(accuracyOf(status), 1);
    assert.equal(status.state, 'LICENSED');
  });

  it('honours a custom policy', () => {
    const policy = { minMemories: 2, window: 4, minAccuracy: 0.5, probation: 1 };
    let status = initialStatus('swap');
    for (const r of swaps('+-')) status = step(status, r, policy).status;
    assert.equal(status.state, 'LICENSED');
  });
});

describe('board', () => {
  it('counts a wrong prediction against both the actual and the predicted category', () => {
    const r = record({
      predicted: action({ category: 'transfer', target: '0xfriend', coin: 'SUI' }),
      actual: action(),
      correct: false,
      misses: ['category', 'target', 'coin'],
    });
    assert.deepEqual(categoriesOf(r), ['swap', 'transfer']);

    const { board } = computeBoard([r]);
    assert.equal(board.swap.memories, 1);
    assert.equal(board.transfer.memories, 1);
    assert.equal(board.stake.memories, 0);
  });

  it('replays memories in time order regardless of input order and reports transitions', () => {
    const records = swaps('++++++-');
    const { board, events } = computeBoard([...records].reverse());
    assert.equal(board.swap.state, 'SHADOWING');
    assert.deepEqual(
      events.map((e) => `${e.from}->${e.to}`),
      ['LOCKED->LICENSED', 'LICENSED->SHADOWING'],
    );
  });
});
