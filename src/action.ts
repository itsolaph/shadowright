import type { Action, Decision } from './types.ts';

const FRAMEWORK_PACKAGES = new Set(['0x1', '0x2']);
const NONE = '-';

/** Reduces a decision to the comparable action the agent tries to predict. */
export function actionOf(decision: Decision): Action {
  const out = decision.coinsOut[0];
  const into = decision.coinsIn[0];
  const coin = decision.category === 'swap' && out && into ? `${out.symbol}>${into.symbol}` : (out ?? into)?.symbol;
  return {
    category: decision.category,
    target: targetOf(decision),
    coin: coin ?? NONE,
    amountBucket: amountBucket((out ?? into)?.amount),
  };
}

/** Recipient for transfers, otherwise the first non-framework `package::module` called. */
function targetOf(decision: Decision): string {
  if (decision.category === 'transfer' || decision.calls.length === 0) {
    return decision.counterparties[0] ?? NONE;
  }
  const venue = decision.modules.find((module) => !FRAMEWORK_PACKAGES.has(module.split('::')[0] ?? ''));
  return venue ?? decision.modules[0] ?? NONE;
}

const BUCKETS: Array<[limit: number, label: string]> = [
  [0.1, '<0.1'],
  [1, '0.1-1'],
  [10, '1-10'],
  [100, '10-100'],
  [1000, '100-1k'],
];

export function amountBucket(amount: number | undefined): string {
  if (amount === undefined || amount === 0) return NONE;
  for (const [limit, label] of BUCKETS) if (amount < limit) return label;
  return '1k+';
}

/**
 * The parts that must match for a prediction to count as correct. Amount is reported but
 * not required: a licensed agent still confirms the amount, but must never pick the wrong
 * kind of action, venue/recipient, or coin.
 */
export function compareActions(predicted: Action, actual: Action): { correct: boolean; misses: string[] } {
  const misses: string[] = [];
  if (predicted.category !== actual.category) misses.push('category');
  if (predicted.target.toLowerCase() !== actual.target.toLowerCase()) misses.push('target');
  if (predicted.coin !== actual.coin) misses.push('coin');
  return { correct: misses.length === 0, misses };
}

export function actionKey(action: Action): string {
  return `${action.category}|${action.target.toLowerCase()}|${action.coin}`;
}

export function describeAction(action: Action): string {
  const amount = action.amountBucket === NONE ? '' : ` ${action.amountBucket}`;
  const coin = action.coin === NONE ? '' : `${amount} ${action.coin}`;
  const preposition = action.category === 'transfer' ? 'to' : 'via';
  const target = action.target === NONE ? '' : ` ${preposition} ${shortId(action.target)}`;
  return `${action.category}${coin}${target}`;
}

/** `0x1234…abcd::module` style shortening for display. Never used for comparisons. */
export function shortId(id: string): string {
  return id.replace(/0x([0-9a-f]{10,})/gi, (_, hex: string) => `0x${hex.slice(0, 4)}…${hex.slice(-4)}`);
}

export type Daypart = 'night' | 'morning' | 'afternoon' | 'evening';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Coarse UTC time features that habits tend to follow. */
export function timeContext(timestampMs: number): { weekday: string; daypart: Daypart; iso: string } {
  const date = new Date(timestampMs);
  const hour = date.getUTCHours();
  const daypart: Daypart = hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  return {
    weekday: WEEKDAYS[date.getUTCDay()] ?? 'Sun',
    daypart,
    iso: date.toISOString().slice(0, 16).replace('T', ' '),
  };
}
