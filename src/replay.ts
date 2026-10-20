import { actionOf, compareActions } from './action.ts';
import { applyRecord, computeBoard, DEFAULT_LICENCE_POLICY, mayActAlone, type LicenceBoard, type LicenceEvent, type LicencePolicy } from './licence.ts';
import { contextQuery, type MemoryRecord, type RecalledRecord, type ShadowMemory, type StoredMemory } from './memory.ts';
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
    const { prediction, recalled } = await predictNext(options.memory, options.predictor, {
      timestampMs: decision.timestampMs,
      previous,
      recallLimit: options.recallLimit,
    });
    const record = judge(prediction, decision, previous, options.predictor.name);

    const wouldActAlone = mayActAlone(board, prediction.action.category);
    const stored = await options.memory.remember(record);
    const applied = applyRecord(board, record, policy);
    board = applied.board;
    events = [...events, ...applied.events];
    if (record.correct) correct += 1;

    const step: ReplayStep = {
      index: steps.length + 1,
      decision,
      prediction,
      record,
      recalled,
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

export interface NextContext {
  /** The moment of the prediction: when the user is about to act. */
  timestampMs: number;
  /** The user's latest decision so far, if any. */
  previous: Decision | undefined;
  recallLimit?: number;
}

/**
 * Recalls memories of similar moments and predicts the user's next action. Sees nothing of
 * the decision being predicted: only the time, the previous decision and past memories.
 * Two recalls with the same query: the most similar memories, and the most recent similar
 * ones, so a habit that changed lately is not outvoted by older ones.
 */
export async function predictNext(
  memory: ShadowMemory,
  predictor: Predictor,
  context: NextContext,
): Promise<{ prediction: Prediction; recalled: number }> {
  const { previous, timestampMs } = context;
  const situation = {
    after: previous?.category ?? 'none',
    previous: previous ? actionOf(previous) : undefined,
    sinceMs: previous ? timestampMs - previous.timestampMs : undefined,
  } as const;
  const query = contextQuery(timestampMs, situation);
  const limit = context.recallLimit ?? 10;
  const [similar, recent] = await Promise.all([memory.recall(query, limit), memory.recall(query, limit, 'recent')]);
  const recalled = uniqueByDigest([...similar, ...recent])
    // Never let the agent peek at memories from the future (possible when re-running a replay).
    .filter(({ record }) => record.timestampMs < timestampMs);
  const prediction = await predictor.predict({ timestampMs, ...situation, recalled });
  return { prediction, recalled: recalled.length };
}

function uniqueByDigest(recalled: RecalledRecord[]): RecalledRecord[] {
  const byDigest = new Map<string, RecalledRecord>();
  for (const hit of recalled) {
    const seen = byDigest.get(hit.record.digest);
    if (!seen || hit.distance < seen.distance) byDigest.set(hit.record.digest, hit);
  }
  return [...byDigest.values()];
}

/** Compares a prediction with what the user actually did, as a memory record. */
export function judge(
  prediction: Prediction,
  decision: Decision,
  previous: Decision | undefined,
  predictorName: string,
  predictedAtMs?: number,
): MemoryRecord {
  const actual = actionOf(decision);
  const { correct, misses } = compareActions(prediction.action, actual);
  return {
    digest: decision.digest,
    timestampMs: decision.timestampMs,
    after: previous?.category ?? 'none',
    ...(previous ? { previous: actionOf(previous), sinceMs: decision.timestampMs - previous.timestampMs } : {}),
    predicted: prediction.action,
    actual,
    correct,
    misses,
    predictor: predictorName,
    ...(predictedAtMs === undefined ? {} : { predictedAtMs }),
  };
}
