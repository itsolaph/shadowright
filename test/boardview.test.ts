import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildBoardView, correctCallsToLicence, learningCurve, licenceProgress } from '../src/boardview.ts';
import { DEFAULT_LICENCE_POLICY, initialStatus, type LicenceStatus } from '../src/licence.ts';
import type { StoredRecord } from '../src/memory.ts';
import { action, DAY, MON_AFTERNOON, record } from './helpers.ts';

function stored(i: number, correct: boolean, overrides: Partial<StoredRecord> = {}): StoredRecord {
  const predicted = action();
  const actual = correct ? predicted : action({ target: '0xother::pool' });
  return {
    ...record({ digest: `tx${i}`, timestampMs: MON_AFTERNOON + i * DAY, predicted, actual, correct, misses: correct ? [] : ['target'] }),
    blobId: `blob${i}`,
    ...overrides,
  };
}

function status(overrides: Partial<LicenceStatus>): LicenceStatus {
  return { ...initialStatus('swap'), ...overrides };
}

describe('board view', () => {
  it('aggregates memories into cards, a newest-first timeline and a curve', () => {
    const outcomes = [false, true, true, true, true, true, false];
    const view = buildBoardView(outcomes.map((ok, i) => stored(i, ok)), DEFAULT_LICENCE_POLICY);

    assert.equal(view.memories, 7);
    assert.equal(view.correct, 5);
    const swap = view.categories.find((c) => c.category === 'swap');
    assert.equal(swap?.state, 'SHADOWING');
    assert.equal(swap?.revocations, 1);
    assert.match(swap?.lastRevokeReason ?? '', /revoked: wrong call \(target\)/);
    assert.equal(swap?.onProbation, true);
    assert.equal(view.categories.length, 7, 'every category gets a card, even untouched ones');

    assert.equal(view.timeline[0]?.digest, 'tx6');
    assert.equal(view.timeline[0]?.blobId, 'blob6');
    assert.match(view.timeline[0]?.lesson ?? '', /prefer swap/);
    assert.deepEqual(
      view.events.map((e) => `${e.from}->${e.to}`),
      ['LOCKED->LICENSED', 'LICENSED->SHADOWING'],
    );
  });

  it('orders memories by time whatever order recall returned them in', () => {
    const view = buildBoardView([stored(2, true), stored(0, false), stored(1, true)], DEFAULT_LICENCE_POLICY);
    assert.deepEqual(
      view.curve.map((p) => p.correct),
      [false, true, true],
    );
  });

  it('computes cumulative and rolling accuracy for the learning curve', () => {
    const records = [false, false, true, true, true].map((ok, i) => stored(i, ok));
    const curve = learningCurve(records, 2);
    assert.deepEqual(
      curve.map((p) => Math.round(p.cumulative * 100)),
      [0, 0, 33, 50, 60],
    );
    assert.deepEqual(
      curve.map((p) => p.rolling),
      [0, 0, 0.5, 1, 1],
    );
  });

  it('marks live memories with the time the prediction was made', () => {
    const view = buildBoardView([stored(0, true, { predictedAtMs: MON_AFTERNOON - 5000 })], DEFAULT_LICENCE_POLICY);
    assert.equal(view.timeline[0]?.predictedAtMs, MON_AFTERNOON - 5000);
  });
});

describe('licence progress', () => {
  const policy = DEFAULT_LICENCE_POLICY;

  it('counts memories while locked', () => {
    assert.deepEqual(licenceProgress(status({ memories: 3, recent: [true, true, true] }), policy), {
      progress: 0.6,
      needed: '2 more memories to start judging',
    });
  });

  it('counts the correct calls in a row still needed to reach 80% over the window', () => {
    const recent = [true, false, true, false, true, true, false, true, true, true];
    const s = status({ state: 'SHADOWING', memories: 10, recent, streak: 3 });
    assert.equal(correctCallsToLicence(s, policy), 2);
    assert.equal(licenceProgress(s, policy).needed, '2 correct calls in a row to licence');
  });

  it('includes the probation streak after a revocation', () => {
    const s = status({ state: 'SHADOWING', memories: 12, recent: [...Array<boolean>(9).fill(true), false], streak: 0, onProbation: true });
    assert.equal(correctCallsToLicence(s, policy), 3);
  });

  it('reports a licensed category as complete', () => {
    assert.equal(licenceProgress(status({ state: 'LICENSED', memories: 6, recent: [true] }), policy).progress, 1);
  });
});
