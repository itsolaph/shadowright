import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RecalledRecord } from '../src/memory.ts';
import { createPredictor, HeuristicPredictor } from '../src/predictor.ts';
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

describe('createPredictor', () => {
  it('creates predictors by name and rejects unknown names', () => {
    assert.equal(createPredictor('heuristic').name, 'heuristic-v1');
    assert.throws(() => createPredictor('oracle'), /Unknown predictor "oracle"/);
  });
});
