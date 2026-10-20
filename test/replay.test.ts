import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemWalMock } from '@mysten-incubation/memwal';
import { ShadowMemory } from '../src/memory.ts';
import { HeuristicPredictor } from '../src/predictor.ts';
import { replay } from '../src/replay.ts';
import type { Decision } from '../src/types.ts';
import { DAY, decision, MON_AFTERNOON } from './helpers.ts';

/** A user who swaps SUI for USDC on the same DEX every Monday afternoon, then switches DEX once. */
function weeklySwapper(): Decision[] {
  const decisions: Decision[] = [];
  for (let week = 0; week < 11; week++) {
    decisions.push(decision({ digest: `swap-${week}`, timestampMs: MON_AFTERNOON + week * 7 * DAY }));
  }
  decisions.push(
    decision({ digest: 'incoming', timestampMs: MON_AFTERNOON + DAY, initiatedByUser: false, category: 'transfer' }),
    decision({ digest: 'failed', timestampMs: MON_AFTERNOON + 2 * DAY, success: false, category: 'other' }),
    decision({
      digest: 'new-dex',
      timestampMs: MON_AFTERNOON + 11 * 7 * DAY,
      calls: ['0xnewdex::pool::swap'],
      modules: ['0xnewdex::pool'],
      packages: ['0xnewdex'],
    }),
  );
  return decisions.sort((a, b) => a.timestampMs - b.timestampMs);
}

function freshMemory(): ShadowMemory {
  return new ShadowMemory(MemWalMock.create({ namespace: 'replay-test' }), 'replay-test');
}

describe('replay', () => {
  it('learns a habit from its own memories, earns a licence, and loses it on a miss', async () => {
    const memory = freshMemory();
    const result = await replay({ decisions: weeklySwapper(), memory, predictor: new HeuristicPredictor() });

    assert.equal(result.steps.length, 12, 'incoming and failed transactions are not the user’s decisions');
    const outcomes = result.steps.map((s) => (s.record.correct ? '+' : '-')).join('');
    assert.equal(outcomes, '-++++++++++-');

    const [first, second] = result.steps;
    assert.match(first?.prediction.reasons[0] ?? '', /cold start/);
    assert.equal(second?.recalled, 1);
    assert.match(second?.prediction.reasons.join('\n') ?? '', /user did swap/);

    const licensedAt = result.steps.findIndex((s) => s.events.some((e) => e.category === 'swap' && e.to === 'LICENSED'));
    assert.equal(licensedAt, 4, 'licensed on the 5th memory at 80% accuracy');
    assert.equal(result.steps[5]?.wouldActAlone, true);

    assert.equal(result.board.swap.state, 'SHADOWING');
    assert.equal(result.board.swap.revocations, 1);
    assert.equal(result.board.transfer.state, 'LOCKED', 'the cold-start guess counts against transfer too');
    assert.equal((await memory.recallAll()).length, 12);
  });

  it('respects limit and skip, keeping the previous decision as context', async () => {
    const decisions = weeklySwapper();
    const result = await replay({
      decisions,
      memory: freshMemory(),
      predictor: new HeuristicPredictor(),
      limit: 2,
      skip: (d) => d.digest === 'swap-0' || d.digest === 'swap-1',
    });
    assert.deepEqual(
      result.steps.map((s) => s.decision.digest),
      ['swap-2', 'swap-3'],
    );
    assert.equal(result.steps[0]?.record.after, 'swap');
  });

  it('seeds the board from existing memories', async () => {
    const first = await replay({ decisions: weeklySwapper(), memory: freshMemory(), predictor: new HeuristicPredictor(), limit: 6 });
    const existing = first.steps.map((s) => s.record);
    const second = await replay({
      decisions: weeklySwapper(),
      memory: freshMemory(),
      predictor: new HeuristicPredictor(),
      existing,
      skip: (d) => existing.some((r) => r.digest === d.digest),
      limit: 1,
    });
    assert.equal(second.steps[0]?.wouldActAlone, true);
  });
});
