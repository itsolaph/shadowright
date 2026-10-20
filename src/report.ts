import { describeAction, timeContext } from './action.ts';
import { accuracyOf, type LicenceBoard, type LicenceEvent } from './licence.ts';
import type { ReplayStep } from './replay.ts';
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

export function renderEvent(event: LicenceEvent): string {
  return `licence ${event.category}: ${event.from} -> ${event.to} (${event.reason})`;
}

export function renderCounts(counts: Map<Category, { own: number; incoming: number }>): string {
  return CATEGORIES.map((category) => {
    const c = counts.get(category) ?? { own: 0, incoming: 0 };
    return `${CATEGORY_LABELS[category].padEnd(24)}${String(c.own).padStart(6)} own${String(c.incoming).padStart(6)} incoming`;
  }).join('\n');
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
