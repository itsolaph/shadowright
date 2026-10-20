import { describeAction } from './action.ts';
import { accuracyOf, computeBoard, type LicenceEvent, type LicencePolicy, type LicenceState, type LicenceStatus } from './licence.ts';
import { lessonOf, type StoredRecord } from './memory.ts';
import { CATEGORIES, CATEGORY_LABELS, type Category } from './types.ts';

/** Everything the Licence Board page shows for one subject, computed from memories only. */
export interface BoardView {
  memories: number;
  correct: number;
  categories: CategoryCard[];
  timeline: TimelineEntry[];
  curve: CurvePoint[];
  events: LicenceEvent[];
}

export interface CategoryCard {
  category: Category;
  label: string;
  state: LicenceState;
  memories: number;
  /** Outcomes over the licence window, oldest first. */
  recent: boolean[];
  accuracy: number | undefined;
  streak: number;
  revocations: number;
  onProbation: boolean;
  /** 0..1 progress toward a licence, and what is still needed in words. */
  progress: number;
  needed: string;
  lastRevokeReason: string | undefined;
}

export interface TimelineEntry {
  digest: string;
  timestampMs: number;
  category: Category;
  predicted: string;
  actual: string;
  correct: boolean;
  misses: string[];
  lesson: string;
  blobId: string;
  /** Set for live-mode memories: when the prediction was stored, before the transaction was read. */
  predictedAtMs: number | undefined;
}

export interface CurvePoint {
  /** 1-based position of the memory, oldest first. */
  index: number;
  timestampMs: number;
  correct: boolean;
  /** Share of correct predictions so far. */
  cumulative: number;
  /** Share of correct predictions over the last `window` memories. */
  rolling: number;
}

export function buildBoardView(records: StoredRecord[], policy: LicencePolicy): BoardView {
  const ordered = [...records].sort((a, b) => a.timestampMs - b.timestampMs);
  const { board, events } = computeBoard(ordered, policy);
  return {
    memories: ordered.length,
    correct: ordered.filter((r) => r.correct).length,
    categories: CATEGORIES.map((category) => categoryCard(board[category], events, policy)),
    timeline: ordered.map(timelineEntry).reverse(),
    curve: learningCurve(ordered, policy.window),
    events,
  };
}

function categoryCard(status: LicenceStatus, events: LicenceEvent[], policy: LicencePolicy): CategoryCard {
  const revokes = events.filter((e) => e.category === status.category && e.from === 'LICENSED' && e.to !== 'LICENSED');
  const { progress, needed } = licenceProgress(status, policy);
  return {
    category: status.category,
    label: CATEGORY_LABELS[status.category],
    state: status.state,
    memories: status.memories,
    recent: status.recent,
    accuracy: status.recent.length ? accuracyOf(status) : undefined,
    streak: status.streak,
    revocations: status.revocations,
    onProbation: status.onProbation,
    progress,
    needed,
    lastRevokeReason: revokes.at(-1)?.reason,
  };
}

/** How far a category is from a licence, as a ratio and as the next concrete step. */
export function licenceProgress(status: LicenceStatus, policy: LicencePolicy): { progress: number; needed: string } {
  if (status.state === 'LICENSED') return { progress: 1, needed: 'licensed: may act alone (dry-run first)' };
  if (status.memories < policy.minMemories) {
    const missing = policy.minMemories - status.memories;
    return { progress: status.memories / policy.minMemories, needed: `${missing} more ${missing === 1 ? 'memory' : 'memories'} to start judging` };
  }
  const calls = correctCallsToLicence(status, policy);
  const progress = Math.min(1, (accuracyOf(status) / policy.minAccuracy) * (status.onProbation ? Math.min(1, status.streak / policy.probation) : 1));
  return { progress, needed: `${calls} correct ${calls === 1 ? 'call' : 'calls'} in a row to licence` };
}

/** Consecutive correct calls that would earn the licence, given the window and any probation. */
export function correctCallsToLicence(status: LicenceStatus, policy: LicencePolicy): number {
  let recent = [...status.recent];
  let streak = status.streak;
  for (let calls = 1; calls <= policy.window + policy.probation; calls++) {
    recent = [...recent, true].slice(-policy.window);
    streak += 1;
    const accurate = recent.filter(Boolean).length / recent.length >= policy.minAccuracy;
    const probationDone = !status.onProbation || streak >= policy.probation;
    if (accurate && probationDone && status.memories + calls >= policy.minMemories) return calls;
  }
  return policy.window;
}

function timelineEntry(record: StoredRecord): TimelineEntry {
  return {
    digest: record.digest,
    timestampMs: record.timestampMs,
    category: record.actual.category,
    predicted: describeAction(record.predicted),
    actual: describeAction(record.actual),
    correct: record.correct,
    misses: record.misses,
    lesson: lessonOf(record),
    blobId: record.blobId,
    predictedAtMs: record.predictedAtMs,
  };
}

export function learningCurve(records: StoredRecord[], window: number): CurvePoint[] {
  let correct = 0;
  return records.map((record, i) => {
    if (record.correct) correct += 1;
    const recent = records.slice(Math.max(0, i + 1 - window), i + 1);
    return {
      index: i + 1,
      timestampMs: record.timestampMs,
      correct: record.correct,
      cumulative: correct / (i + 1),
      rolling: recent.filter((r) => r.correct).length / recent.length,
    };
  });
}
