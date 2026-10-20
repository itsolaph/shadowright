import { describeAction, shortId, timeContext } from './action.ts';
import { accuracyOf, type LicenceBoard, type LicenceEvent } from './licence.ts';
import type { ReplayStep } from './replay.ts';
import type { ScoutCandidate } from './scout.ts';
import { shortAddress } from './subjects.ts';
import type { StandingPrediction, WatchStep } from './watch.ts';
import { CATEGORIES, CATEGORY_LABELS, type Category } from './types.ts';

const STATE_ICON = { LOCKED: '🔒', SHADOWING: '👀', LICENSED: '✅' } as const;

export function renderBoard(board: LicenceBoard): string {
  const header = `${'category'.padEnd(24)}${'state'.padEnd(13)}${'mem'.padStart(4)}  ${'accuracy'.padEnd(14)}${'streak'.padStart(6)}${'revoked'.padStart(9)}`;
  const rows = CATEGORIES.map((category) => {
    const s = board[category];
    const hits = s.recent.filter(Boolean).length;
    const accuracy = s.recent.length ? `${pct(accuracyOf(s))} (${hits}/${s.recent.length})` : '-';
    return [
      CATEGORY_LABELS[category].padEnd(24),
      `${STATE_ICON[s.state]} ${s.state}`.padEnd(13),
      String(s.memories).padStart(4),
      `  ${accuracy.padEnd(14)}`,
      String(s.streak).padStart(6),
      String(s.revocations).padStart(9),
    ].join('');
  });
  return [header, '-'.repeat(header.length), ...rows].join('\n');
}

export function renderStep(step: ReplayStep, total: number): string {
  const { decision, prediction, record } = step;
  const { weekday, daypart, iso } = timeContext(decision.timestampMs);
  const verdict = record.correct ? '✓ correct' : `✗ wrong (${record.misses.join(', ')})`;
  const lines = [
    `#${String(step.index).padStart(2, '0')}/${total}  ${iso} UTC ${weekday} ${daypart}  after ${record.after}`,
    `   recall : ${step.recalled} relevant memories`,
    `   predict: ${describeAction(prediction.action)}  (confidence ${pct(prediction.confidence)})`,
    ...prediction.reasons.slice(0, 3).map((reason) => `            · ${reason}`),
    `   actual : ${describeAction(record.actual)}  [${decision.rule}]`,
    `   ${verdict}   running accuracy ${step.correctSoFar}/${step.index} (${pct(step.correctSoFar / step.index)})`,
  ];
  if (step.wouldActAlone) lines.push(`   ⚡ ${prediction.action.category} was LICENSED: the agent would have acted alone (dry-run first)`);
  for (const event of step.events) lines.push(`   ${renderEvent(event)}`);
  return lines.join('\n');
}

export function renderStanding(standing: StandingPrediction): string {
  const { prediction, predictedAtMs } = standing;
  return `⏳ ${timeContext(predictedAtMs).iso} UTC standing prediction: ${describeAction(prediction.action)} (confidence ${pct(prediction.confidence)}); no new transaction yet`;
}

export function renderWatchStep(step: WatchStep): string {
  const { decision, standing, record } = step;
  const verdict = record.correct ? '✓ correct' : `✗ wrong (${record.misses.join(', ')})`;
  const lines = [
    `● ${timeContext(decision.timestampMs).iso} UTC new transaction ${shortId(decision.digest)}`,
    `   predicted at ${timeContext(standing.predictedAtMs).iso} UTC, before reading it: ${describeAction(standing.prediction.action)}`,
    `   actual : ${describeAction(record.actual)}  [${decision.rule}]`,
    `   ${verdict}   stored on Walrus: blob ${step.stored.blobId}`,
    ...step.events.map((event) => `   ${renderEvent(event)}`),
  ];
  return lines.join('\n');
}

export function renderEvent(event: LicenceEvent): string {
  return `licence ${event.category}: ${event.from} -> ${event.to} (${event.reason})`;
}

export function renderCounts(counts: Map<Category, { own: number; incoming: number }>): string {
  return CATEGORIES.map((category) => {
    const c = counts.get(category) ?? { own: 0, incoming: 0 };
    return `${CATEGORY_LABELS[category].padEnd(24)}${String(c.own).padStart(6)} own${String(c.incoming).padStart(6)} incoming`;
  }).join('\n');
}

export function renderScoutCandidate(rank: number, candidate: ScoutCandidate): string {
  const { profile } = candidate;
  const counts = CATEGORIES.filter((c) => profile.counts[c] > 0)
    .map((c) => `${c} ${profile.counts[c]}`)
    .join(', ');
  const span = profile.transactions ? `${day(profile.firstMs)} to ${day(profile.lastMs)} (${profile.spanDays.toFixed(0)} days)` : '-';
  return [
    `${rank}. ${shortAddress(profile.address)}…  score ${candidate.score}  ${candidate.reason ? `✗ ${candidate.reason}` : '✓ meets every criterion'}`,
    `   ${profile.transactions} own tx, ${span}, peak ${profile.peakPerDay}/day, seen in: ${candidate.sources.join(', ')}`,
    `   ${counts || 'no categories'}`,
  ].join('\n');
}

function day(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
