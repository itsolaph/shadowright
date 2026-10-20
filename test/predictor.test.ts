import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RecalledRecord } from '../src/memory.ts';
import { createPredictor, HabitPredictor, HeuristicPredictor } from '../src/predictor.ts';
import { action, DAY, MON_AFTERNOON, record } from './helpers.ts';

const LAST_WEEK = MON_AFTERNOON - 7 * DAY;
const SWAP_A = action({ target: '0xdexa::router', coin: 'SUI>USDC' });
const SWAP_B = action({ target: '0xdexb::router', coin: 'SUI>USDC' });

function recalled(distance: number, overrides: Parameters<typeof record>[0]): RecalledRecord {
  return { record: record({ timestampMs: LAST_WEEK, after: 'swap', ...overrides }), distance, blobId: 'blob' };
}

describe('HeuristicPredictor', () => {
  const predictor = new HeuristicPredictor();

  it('falls back to a cold-start guess with zero confidence when it knows nothing', async () => {
    const prediction = await predictor.predict({ timestampMs: MON_AFTERNOON, after: 'none', recalled: [] });
    assert.equal(prediction.confidence, 0);
    assert.match(prediction.reasons[0] ?? '', /cold start/);
  });

  it('repeats the previous decision when there are no memories', async () => {
    const previous = action({ category: 'stake', target: '0x3::sui_system', coin: 'SUI' });
    const prediction = await predictor.predict({ timestampMs: MON_AFTERNOON, after: 'stake', previous, recalled: [] });
    assert.deepEqual(prediction.action, previous);
    assert.match(prediction.reasons[0] ?? '', /previous decision was stake/);
    assert.ok(prediction.confidence < 0.5, 'a lone hint is not a confident prediction');
  });

  it('predicts what the user did in the most similar remembered moments', async () => {
    const prediction = await predictor.predict({
      timestampMs: MON_AFTERNOON,
      after: 'swap',
      recalled: [
        recalled(0.2, { actual: SWAP_A, predicted: SWAP_A }),
        recalled(0.3, { actual: SWAP_A, predicted: SWAP_A }),
        recalled(0.25, { actual: action({ category: 'transfer', target: '0xfriend', coin: 'SUI' }) }),
      ],
    });
    assert.deepEqual(prediction.action, SWAP_A);
    assert.ok(prediction.confidence > 0.5 && prediction.confidence < 1);
    assert.match(prediction.reasons[0] ?? '', /user did swap 1-10 SUI>USDC via 0xdexa::router \(Mon afternoon; same afternoon, same Mon, also after swap\)/);
  });

  it('learns from a remembered mistake and says so', async () => {
    const prediction = await predictor.predict({
      timestampMs: MON_AFTERNOON,
      after: 'swap',
      recalled: [
        recalled(0.1, { actual: SWAP_A, predicted: SWAP_A }),
        recalled(0.2, { predicted: SWAP_A, actual: SWAP_B, correct: false, misses: ['target'] }),
      ],
    });
    assert.deepEqual(prediction.action, SWAP_B);
    assert.match(prediction.reasons[0] ?? '', /^lesson applied: avoided swap 1-10 SUI>USDC via 0xdexa::router because .* I wrongly predicted/);
  });

  it('weights recent memories above old ones', async () => {
    const prediction = await predictor.predict({
      timestampMs: MON_AFTERNOON,
      after: 'swap',
      recalled: [
        recalled(0.2, { actual: SWAP_A, timestampMs: LAST_WEEK - 140 * DAY }),
        recalled(0.2, { actual: SWAP_B, timestampMs: LAST_WEEK }),
      ],
    });
    assert.deepEqual(prediction.action, SWAP_B);
  });

  it('picks the amount bucket the supporting memories agree on', async () => {
    const prediction = await predictor.predict({
      timestampMs: MON_AFTERNOON,
      after: 'swap',
      recalled: [
        recalled(0.2, { actual: { ...SWAP_A, amountBucket: '10-100' } }),
        recalled(0.2, { actual: { ...SWAP_A, amountBucket: '10-100' } }),
        recalled(0.2, { actual: { ...SWAP_A, amountBucket: '1-10' } }),
      ],
    });
    assert.equal(prediction.action.amountBucket, '10-100');
  });
});

describe('HabitPredictor', () => {
  const predictor = new HabitPredictor();
  const MINUTE = 60_000;
  const CLAIM = action({ category: 'claim', target: '0xvault::vault', coin: 'vSUI' });
  const REDEEM = action({ category: 'stake', target: '0xlst::pool', coin: 'vSUI' });
  const SEND = action({ category: 'transfer', target: '0xexchange', coin: 'SUI' });
  const OLD_SEND = action({ category: 'transfer', target: '0xoldexchange', coin: 'SUI' });

  /** A memory of `actual` happening `sinceMs` after `previous`, `daysAgo` days back. */
  function step(previous: typeof CLAIM, actual: typeof CLAIM, daysAgo: number, sinceMs = MINUTE): RecalledRecord {
    return recalled(0.3, { previous, after: previous.category, sinceMs, actual, predicted: actual, timestampMs: MON_AFTERNOON - daysAgo * DAY });
  }

  it('follows a learned sequence: after the claim comes the redeem', async () => {
    const prediction = await predictor.predict({
      timestampMs: MON_AFTERNOON,
      after: 'claim',
      previous: CLAIM,
      sinceMs: MINUTE,
      recalled: [step(CLAIM, REDEEM, 4), step(REDEEM, SEND, 4), step(CLAIM, REDEEM, 8), step(SEND, CLAIM, 4, 4 * DAY)],
    });
    assert.deepEqual(prediction.action, REDEEM);
    assert.match(prediction.reasons[0] ?? '', /after claim 1-10 vSUI via 0xvault::vault, 1 minute later, the user did stake/);
  });

  it('lets a new habit take over from an older, more frequent one', async () => {
    const recalledMemories = [
      step(REDEEM, OLD_SEND, 60),
      step(REDEEM, OLD_SEND, 50),
      step(REDEEM, OLD_SEND, 40),
      step(REDEEM, SEND, 8),
      step(REDEEM, SEND, 4),
    ];
    const prediction = await predictor.predict({ timestampMs: MON_AFTERNOON, after: 'stake', previous: REDEEM, sinceMs: MINUTE, recalled: recalledMemories });
    assert.deepEqual(prediction.action, SEND);
  });

  it('tells a new session from the middle of one', async () => {
    const recalledMemories = [step(SEND, CLAIM, 4, 4 * DAY), step(SEND, SEND, 5, MINUTE)];
    const later = await predictor.predict({ timestampMs: MON_AFTERNOON, after: 'transfer', previous: SEND, sinceMs: 3 * DAY, recalled: recalledMemories });
    const soon = await predictor.predict({ timestampMs: MON_AFTERNOON, after: 'transfer', previous: SEND, sinceMs: 2 * MINUTE, recalled: recalledMemories });
    assert.deepEqual(later.action, CLAIM);
    assert.deepEqual(soon.action, SEND);
  });

  it('applies the lesson of a remembered miss', async () => {
    const miss = recalled(0.3, { previous: CLAIM, after: 'claim', sinceMs: MINUTE, predicted: SEND, actual: REDEEM, correct: false, misses: ['category'] });
    const prediction = await predictor.predict({
      timestampMs: MON_AFTERNOON,
      after: 'claim',
      previous: CLAIM,
      sinceMs: MINUTE,
      recalled: [miss, step(CLAIM, SEND, 30), step(CLAIM, SEND, 31)],
    });
    assert.deepEqual(prediction.action, REDEEM);
    assert.match(prediction.reasons[0] ?? '', /^lesson applied: avoided transfer .* I wrongly predicted transfer/);
  });

  it('starts cold without memories', async () => {
    const prediction = await predictor.predict({ timestampMs: MON_AFTERNOON, after: 'none', recalled: [] });
    assert.match(prediction.reasons[0] ?? '', /cold start/);
  });
});

describe('createPredictor', () => {
  it('creates predictors by name and rejects unknown names', () => {
    assert.equal(createPredictor().name, 'habit-v2');
    assert.equal(createPredictor('heuristic').name, 'heuristic-v1');
    assert.throws(() => createPredictor('oracle'), /Unknown predictor "oracle"/);
  });
});
