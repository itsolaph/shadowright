import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemWalMock } from '@mysten-incubation/memwal';
import { emptyBoard, DEFAULT_LICENCE_POLICY } from '../src/licence.ts';
import { ShadowMemory } from '../src/memory.ts';
import { HeuristicPredictor } from '../src/predictor.ts';
import { Watcher, type WatchPorts, type WatchState } from '../src/watch.ts';
import type { Decision } from '../src/types.ts';
import { decision, MON_AFTERNOON } from './helpers.ts';

/** A fake chain plus clock that logs every port call, so the order of operations is visible. */
function harness(chain: Decision[], initial: WatchState = { cursor: null, processed: 0 }) {
  const log: string[] = [];
  const saved: WatchState[] = [];
  let clock = MON_AFTERNOON;
  const ports: WatchPorts = {
    async listNew(cursor) {
      log.push('list');
      const start = cursor === null ? 0 : chain.findIndex((d) => d.digest === cursor) + 1;
      return chain.slice(start).map((d) => d.digest);
    },
    async read(digest) {
      log.push(`read ${digest}`);
      const found = chain.find((d) => d.digest === digest);
      if (!found) throw new Error(`unknown ${digest}`);
      return found;
    },
    async saveState(state) {
      log.push(state.standing ? `save prediction after ${state.standing.afterDigest ?? 'start'}` : `save cursor ${state.cursor}`);
      saved.push(structuredClone(state));
    },
    now: () => (clock += 1000),
  };
  const memory = new ShadowMemory(MemWalMock.create({ namespace: 'watch-test' }), 'watch-test');
  const watcher = new Watcher(initial, emptyBoard(), {
    memory,
    predictor: new HeuristicPredictor(),
    policy: DEFAULT_LICENCE_POLICY,
    ports,
  });
  return { watcher, log, saved, memory };
}

describe('live mode', () => {
  it('stores each prediction before the transaction it predicts is read', async () => {
    const chain = [
      decision({ digest: 'a', timestampMs: MON_AFTERNOON + 10 }),
      decision({ digest: 'b', timestampMs: MON_AFTERNOON + 20 }),
    ];
    const { watcher, log } = harness(chain);
    const steps = await watcher.poll();

    assert.deepEqual(log, [
      'list',
      'save prediction after start',
      'read a',
      'save cursor a',
      'save prediction after a',
      'read b',
      'save cursor b',
      'save prediction after b',
    ]);
    assert.equal(steps.length, 2);
  });

  it('timestamps each memory with the moment the prediction was stored, before the reading', async () => {
    const chain = [decision({ digest: 'a' }), decision({ digest: 'b' })];
    const { watcher, saved, memory } = harness(chain);
    const steps = await watcher.poll();

    for (const step of steps) {
      const storedPrediction = saved.find((s) => s.standing?.predictedAtMs === step.record.predictedAtMs);
      assert.ok(storedPrediction, 'the compared prediction is exactly the one saved earlier');
      assert.equal(step.record.predicted.category, step.standing.prediction.action.category);
    }
    const memories = await memory.recallAll();
    assert.deepEqual(
      memories.map((m) => m.predictedAtMs),
      steps.map((s) => s.standing.predictedAtMs),
      'Walrus Memory keeps when each prediction was made',
    );
  });

  it('predicts from the previous transaction, never from the one being judged', async () => {
    const chain = [
      decision({ digest: 'swap-1', category: 'swap' }),
      decision({ digest: 'stake-1', category: 'stake', calls: ['0x3::sui_system::request_add_stake'], modules: ['0x3::sui_system'], packages: ['0x3'] }),
    ];
    const { watcher } = harness(chain);
    const [first, second] = await watcher.poll();
    assert.equal(first?.standing.afterDigest, null);
    assert.equal(second?.standing.afterDigest, 'swap-1');
    assert.equal(second?.record.after, 'swap');
    assert.equal(second?.record.predicted.category, 'swap', 'after a swap, with no memories yet, it repeats the swap');
    assert.equal(second?.record.correct, false);
  });

  it('continues from the persisted cursor and keeps a standing prediction while idle', async () => {
    const chain = [decision({ digest: 'old' }), decision({ digest: 'new' })];
    const { watcher, log } = harness(chain, { cursor: 'old', previous: chain[0], processed: 1 });
    const steps = await watcher.poll();
    assert.deepEqual(
      steps.map((s) => s.decision.digest),
      ['new'],
    );
    const idle = await watcher.poll();
    assert.equal(idle.length, 0);
    assert.ok(watcher.current.state.standing, 'a prediction is always waiting for the next transaction');
    assert.equal(log.filter((l) => l.startsWith('read')).length, 1);
  });

  it('skips failed transactions without spending the prediction', async () => {
    const chain = [decision({ digest: 'failed', success: false }), decision({ digest: 'ok' })];
    const { watcher } = harness(chain);
    const steps = await watcher.poll();
    assert.deepEqual(
      steps.map((s) => s.decision.digest),
      ['ok'],
    );
    assert.equal(steps[0]?.record.after, 'none');
  });
});
