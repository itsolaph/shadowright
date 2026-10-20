import { actionOf, compareActions } from './action.ts';
import { applyRecord, computeBoard, DEFAULT_LICENCE_POLICY, mayActAlone, type LicenceBoard, type LicenceEvent, type LicencePolicy } from './licence.ts';
import { contextQuery, type MemoryRecord, type ShadowMemory, type StoredMemory } from './memory.ts';
import type { Prediction, Predictor } from './predictor.ts';
import type { Decision } from './types.ts';

export interface ReplayOptions {
  /** The wallet's history, oldest first. Only the user's own successful decisions are replayed. */
  decisions: Decision[];
  memory: ShadowMemory;
  predictor: Predictor;
  policy?: LicencePolicy;
  /** Maximum number of decisions to process in this run. */
  limit?: number;
  /** Decisions to pass over, e.g. those already stored by an earlier run. */
  skip?: (decision: Decision) => boolean;
  /** Memories that already exist, used to seed the licence board. */
  existing?: MemoryRecord[];
  recallLimit?: number;
  onStep?: (step: ReplayStep) => void | Promise<void>;
}

export interface ReplayStep {
  /** 1-based position among decisions processed in this run. */
  index: number;
  decision: Decision;
  prediction: Prediction;
  record: MemoryRecord;
  recalled: number;
  /** True if the predicted category was licensed, i.e. the agent would have acted alone (dry-run first). */
  wouldActAlone: boolean;
  stored: StoredMemory;
  board: LicenceBoard;
  events: LicenceEvent[];
  correctSoFar: number;
}

export interface ReplayResult {
  steps: ReplayStep[];
  board: LicenceBoard;
  events: LicenceEvent[];
  correct: number;
}

/**
 * Walks the user's decisions in order. For each: recall memories of similar moments,
 * predict privately, reveal what the user actually did, store the episode as a new memory,
 * and update the licence board. Memories written in one step are recalled by later steps,
 * which is how the agent learns.
 */
export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const policy = options.policy ?? DEFAULT_LICENCE_POLICY;
  const ownDecisions = options.decisions.filter((d) => d.initiatedByUser && d.success);
  let { board, events } = computeBoard(options.existing ?? [], policy);
  const steps: ReplayStep[] = [];
  let correct = 0;

  for (const [position, decision] of ownDecisions.entries()) {
    if (options.limit !== undefined && steps.length >= options.limit) break;
    if (options.skip?.(decision)) continue;

    const previous = ownDecisions[position - 1];
    const after = previous?.category ?? 'none';
    const recalled = (await options.memory.recall(contextQuery(decision.timestampMs, after), options.recallLimit ?? 10))
      // Never let the agent peek at memories from the future (possible when re-running a replay).
      .filter(({ record }) => record.timestampMs < decision.timestampMs && record.digest !== decision.digest);

    const prediction = await options.predictor.predict({
      timestampMs: decision.timestampMs,
      after,
      previous: previous ? actionOf(previous) : undefined,
      recalled,
    });
    const actual = actionOf(decision);
    const { correct: isCorrect, misses } = compareActions(prediction.action, actual);
    const record: MemoryRecord = {
      digest: decision.digest,
      timestampMs: decision.timestampMs,
      after,
      predicted: prediction.action,
      actual,
      correct: isCorrect,
      misses,
      predictor: options.predictor.name,
    };

    const wouldActAlone = mayActAlone(board, prediction.action.category);
    const stored = await options.memory.remember(record);
    const applied = applyRecord(board, record, policy);
    board = applied.board;
    events = [...events, ...applied.events];
    if (isCorrect) correct += 1;

    const step: ReplayStep = {
      index: steps.length + 1,
      decision,
      prediction,
      record,
      recalled: recalled.length,
      wouldActAlone,
      stored,
      board,
      events: applied.events,
      correctSoFar: correct,
    };
    steps.push(step);
    await options.onStep?.(step);
  }

  return { steps, board, events, correct };
}
