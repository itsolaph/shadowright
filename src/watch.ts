import { applyRecord, mayActAlone, type LicenceBoard, type LicenceEvent, type LicencePolicy } from './licence.ts';
import type { MemoryRecord, ShadowMemory, StoredMemory } from './memory.ts';
import type { Prediction, Predictor } from './predictor.ts';
import { judge, predictNext } from './replay.ts';
import type { Decision } from './types.ts';

/**
 * Live mode. The agent always holds a standing prediction of the subject's next action,
 * stored with its timestamp *before* any new transaction is read. Polling only lists new
 * digests; each one is then read, compared with the stored prediction, remembered, and a
 * fresh standing prediction is made from the new context.
 */

export interface StandingPrediction {
  prediction: Prediction;
  predictedAtMs: number;
  /** Digest of the latest decision the prediction was based on. */
  afterDigest: string | null;
}

/** Persisted between polls (`data/subjects/<name>/watch.json`). */
export interface WatchState {
  /** Newest own transaction already processed; polling continues after it. */
  cursor: string | null;
  /** The user's latest decision, the context of the next prediction. */
  previous?: Decision;
  standing?: StandingPrediction;
  processed: number;
}

/** Everything the watcher touches outside its own logic, so tests can observe the order. */
export interface WatchPorts {
  /** Digests of own transactions after `cursor`, oldest first, without details. */
  listNew(cursor: string | null): Promise<string[]>;
  /** Reads and normalises one transaction. Only called once its prediction is stored. */
  read(digest: string): Promise<Decision>;
  saveState(state: WatchState): Promise<void>;
  now(): number;
}

export interface WatchStep {
  decision: Decision;
  standing: StandingPrediction;
  record: MemoryRecord;
  stored: StoredMemory;
  /** The predicted category was licensed when the prediction was made: the agent would have acted. */
  wouldAct: boolean;
  events: LicenceEvent[];
  board: LicenceBoard;
}

export interface WatchOptions {
  memory: ShadowMemory;
  predictor: Predictor;
  policy: LicencePolicy;
  ports: WatchPorts;
  recallLimit?: number;
  /** Re-predict when the standing prediction is older than this (time of day matters). */
  refreshMs?: number;
  onStep?: (step: WatchStep) => void | Promise<void>;
}

const DEFAULT_REFRESH_MS = 15 * 60 * 1000;

export class Watcher {
  private state: WatchState;
  private board: LicenceBoard;
  private readonly options: WatchOptions;

  constructor(state: WatchState, board: LicenceBoard, options: WatchOptions) {
    this.state = state;
    this.board = board;
    this.options = options;
  }

  get current(): { state: WatchState; board: LicenceBoard } {
    return { state: this.state, board: this.board };
  }

  /** Makes sure a fresh standing prediction is stored. Returns it. */
  async ensureStanding(): Promise<StandingPrediction> {
    const { standing } = this.state;
    const refreshMs = this.options.refreshMs ?? DEFAULT_REFRESH_MS;
    if (standing && this.options.ports.now() - standing.predictedAtMs < refreshMs) return standing;

    const predictedAtMs = this.options.ports.now();
    const { prediction } = await predictNext(this.options.memory, this.options.predictor, {
      timestampMs: predictedAtMs,
      previous: this.state.previous,
      recallLimit: this.options.recallLimit,
    });
    const fresh = { prediction, predictedAtMs, afterDigest: this.state.previous?.digest ?? null };
    await this.save({ ...this.state, standing: fresh });
    return fresh;
  }

  /** One poll: process every new transaction in order. Returns the steps taken. */
  async poll(): Promise<WatchStep[]> {
    const { ports } = this.options;
    const digests = await ports.listNew(this.state.cursor);
    const steps: WatchStep[] = [];
    for (const digest of digests) {
      // The prediction is stored before the transaction is read.
      const standing = await this.ensureStanding();
      const decision = await ports.read(digest);
      if (!decision.success) {
        await this.save({ ...this.state, cursor: digest });
        continue;
      }
      steps.push(await this.settle(standing, decision));
    }
    await this.ensureStanding();
    return steps;
  }

  private async settle(standing: StandingPrediction, decision: Decision): Promise<WatchStep> {
    const { memory, predictor, policy } = this.options;
    const record = judge(standing.prediction, decision, this.state.previous, predictor.name, standing.predictedAtMs);
    const wouldAct = mayActAlone(this.board, standing.prediction.action.category);
    const stored = await memory.remember(record);
    const applied = applyRecord(this.board, record, policy);
    this.board = applied.board;
    // The used prediction is dropped: the next one must be made from the new context.
    await this.save({ cursor: decision.digest, previous: decision, processed: this.state.processed + 1 });

    const step = { decision, standing, record, stored, wouldAct, events: applied.events, board: this.board };
    await this.options.onStep?.(step);
    return step;
  }

  private async save(state: WatchState): Promise<void> {
    this.state = state;
    await this.options.ports.saveState(state);
  }
}
