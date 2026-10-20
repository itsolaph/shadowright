import type { MemoryRecord } from './memory.ts';
import { CATEGORIES, type Category } from './types.ts';

/**
 * LOCKED: too few memories to judge. SHADOWING: the agent predicts privately but may not act.
 * LICENSED: the agent may act alone in this category (dry-run first).
 */
export type LicenceState = 'LOCKED' | 'SHADOWING' | 'LICENSED';

export interface LicencePolicy {
  /** Memories needed before a category leaves LOCKED. */
  minMemories: number;
  /** How many of the most recent memories accuracy is measured over. */
  window: number;
  /** Accuracy over the window required for a licence. */
  minAccuracy: number;
  /** Consecutive correct calls needed to regain a licence after it was revoked. */
  probation: number;
}

export const DEFAULT_LICENCE_POLICY: LicencePolicy = {
  minMemories: 5,
  window: 10,
  minAccuracy: 0.8,
  probation: 3,
};

export interface LicenceStatus {
  category: Category;
  state: LicenceState;
  memories: number;
  /** Outcomes of the most recent memories, oldest first, at most `window` long. */
  recent: boolean[];
  /** Consecutive correct calls up to now. */
  streak: number;
  revocations: number;
  onProbation: boolean;
}

export interface LicenceEvent {
  category: Category;
  from: LicenceState;
  to: LicenceState;
  digest: string;
  timestampMs: number;
  reason: string;
}

export function initialStatus(category: Category): LicenceStatus {
  return { category, state: 'LOCKED', memories: 0, recent: [], streak: 0, revocations: 0, onProbation: false };
}

export function accuracyOf(status: LicenceStatus): number {
  return status.recent.length === 0 ? 0 : status.recent.filter(Boolean).length / status.recent.length;
}

/**
 * A memory counts toward the category the user acted in and, if different, the category
 * the agent predicted: a licensed agent acting on a false prediction would be just as wrong.
 */
export function categoriesOf(record: MemoryRecord): Category[] {
  return [...new Set([record.actual.category, record.predicted.category])];
}

/** Applies one memory to one category's licence. Pure: returns a new status. */
export function step(
  status: LicenceStatus,
  record: MemoryRecord,
  policy: LicencePolicy = DEFAULT_LICENCE_POLICY,
): { status: LicenceStatus; event?: LicenceEvent } {
  const correct = record.correct;
  const next: LicenceStatus = {
    ...status,
    memories: status.memories + 1,
    recent: [...status.recent, correct].slice(-policy.window),
    streak: correct ? status.streak + 1 : 0,
  };

  let reason: string;
  if (status.state === 'LICENSED' && !correct) {
    next.state = 'SHADOWING';
    next.revocations += 1;
    next.onProbation = true;
    reason = `revoked: wrong call (${record.misses.join(', ')}) while licensed`;
  } else {
    if (next.onProbation && next.streak >= policy.probation) next.onProbation = false;
    const accuracy = accuracyOf(next);
    const percent = `${Math.round(accuracy * 100)}% over last ${next.recent.length}`;
    if (next.memories < policy.minMemories) {
      next.state = 'LOCKED';
      reason = `${next.memories}/${policy.minMemories} memories`;
    } else if (accuracy >= policy.minAccuracy && !next.onProbation) {
      next.state = 'LICENSED';
      reason = `licensed: ${percent}`;
    } else {
      next.state = 'SHADOWING';
      reason = next.onProbation ? `probation: ${next.streak}/${policy.probation} correct in a row` : `shadowing: ${percent}`;
    }
  }

  if (next.state === status.state) return { status: next };
  return {
    status: next,
    event: {
      category: status.category,
      from: status.state,
      to: next.state,
      digest: record.digest,
      timestampMs: record.timestampMs,
      reason,
    },
  };
}

export type LicenceBoard = Record<Category, LicenceStatus>;

export function emptyBoard(): LicenceBoard {
  return Object.fromEntries(CATEGORIES.map((category) => [category, initialStatus(category)])) as LicenceBoard;
}

/** Applies one memory to every category it concerns. */
export function applyRecord(
  board: LicenceBoard,
  record: MemoryRecord,
  policy: LicencePolicy = DEFAULT_LICENCE_POLICY,
): { board: LicenceBoard; events: LicenceEvent[] } {
  const next = { ...board };
  const events: LicenceEvent[] = [];
  for (const category of categoriesOf(record)) {
    const result = step(next[category], record, policy);
    next[category] = result.status;
    if (result.event) events.push(result.event);
  }
  return { board: next, events };
}

/** Rebuilds the whole board from memories, replaying them in chronological order. */
export function computeBoard(
  records: MemoryRecord[],
  policy: LicencePolicy = DEFAULT_LICENCE_POLICY,
): { board: LicenceBoard; events: LicenceEvent[] } {
  let board = emptyBoard();
  const events: LicenceEvent[] = [];
  for (const record of [...records].sort((a, b) => a.timestampMs - b.timestampMs)) {
    const result = applyRecord(board, record, policy);
    board = result.board;
    events.push(...result.events);
  }
  return { board, events };
}

export function mayActAlone(board: LicenceBoard, category: Category): boolean {
  return board[category].state === 'LICENSED';
}
