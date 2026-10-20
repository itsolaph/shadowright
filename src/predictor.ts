import { actionKey, describeAction, describeGap, isNewSession, timeContext } from './action.ts';
import type { RecalledRecord } from './memory.ts';
import type { Action, Category } from './types.ts';

/** Everything the agent may look at before the user acts. Nothing about the decision itself. */
export interface PredictionContext {
  timestampMs: number;
  /** Category of the user's previous decision. */
  after: Category | 'none';
  /** The user's previous decision, observable on chain right now. */
  previous?: Action;
  /** Time since the previous decision. */
  sinceMs?: number;
  /** Memories recalled from Walrus Memory for this context, written strictly before `timestampMs`. */
  recalled: RecalledRecord[];
}

export interface Prediction {
  action: Action;
  /** Share of the supporting evidence behind the chosen action, 0..1 (low when evidence is thin). */
  confidence: number;
  /** Human-readable explanation, most important first. */
  reasons: string[];
}

/**
 * A predictor guesses the user's next action from recalled memories. Predictors are swapped
 * in by name without touching the replay loop or the licence logic; an LLM-backed predictor
 * can implement the same interface.
 */
export interface Predictor {
  readonly name: string;
  predict(context: PredictionContext): Promise<Prediction>;
}

interface Candidate {
  action: Action;
  score: number;
  support: Array<{ weight: number; note: string; bucket: string }>;
  penalties: Array<{ weight: number; note: string }>;
}

/** Weighted votes for actions: memories support what the user did and count against past mistakes. */
class Tally {
  private readonly candidates = new Map<string, Candidate>();

  support(action: Action, weight: number, note: string): void {
    const candidate = this.candidateFor(action);
    candidate.score += weight;
    candidate.support.push({ weight, note, bucket: action.amountBucket });
  }

  penalise(action: Action, weight: number, note: string): void {
    const candidate = this.candidateFor(action);
    candidate.score -= weight;
    candidate.penalties.push({ weight, note });
  }

  /** The best-supported action, or undefined when nothing has positive support. */
  verdict(): Prediction | undefined {
    const ranked = [...this.candidates.values()].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score <= 0) return undefined;
    // Share of the evidence, where less than one full memory's worth of evidence counts as one:
    // a lone weak hint (such as "repeat the previous decision") is not 100% certain.
    const totalSupport = ranked.reduce((sum, c) => sum + Math.max(0, c.score), 0);
    return {
      action: { ...best.action, amountBucket: likeliestBucket(best) },
      confidence: best.score / Math.max(totalSupport, 1),
      reasons: [...lessonsApplied(ranked, best), ...topNotes(best)],
    };
  }

  private candidateFor(action: Action): Candidate {
    const key = actionKey(action);
    let candidate = this.candidates.get(key);
    if (!candidate) {
      candidate = { action, score: 0, support: [], penalties: [] };
      this.candidates.set(key, candidate);
    }
    return candidate;
  }
}

/** Fallback when there is nothing to learn from yet. */
const COLD_START: Action = { category: 'transfer', target: '-', coin: 'SUI', amountBucket: '-' };
const DAY_MS = 24 * 60 * 60 * 1000;

function coldStart(): Prediction {
  return { action: COLD_START, confidence: 0, reasons: ['cold start: no usable memories for this context yet'] };
}

const tagOf = (recalled: RecalledRecord) => `memory ${recalled.record.digest.slice(0, 6)}`;

export interface HeuristicWeights {
  /** Multiplier bonus when a memory happened in the same part of the day. */
  sameDaypart: number;
  sameWeekday: number;
  /** Bonus when the memory followed the same kind of previous decision. */
  sameAfter: number;
  /** Share of a memory's weight subtracted from the action it wrongly predicted. */
  mistakePenalty: number;
  /** Evidence for simply repeating the previous decision. */
  repeatPrevious: number;
  recencyHalfLifeDays: number;
}

export const DEFAULT_WEIGHTS: HeuristicWeights = {
  sameDaypart: 0.5,
  sameWeekday: 0.25,
  sameAfter: 0.5,
  mistakePenalty: 0.6,
  repeatPrevious: 0.3,
  recencyHalfLifeDays: 30,
};

/**
 * Milestone 1 predictor, kept as the baseline. Each memory votes for what the user actually
 * did, weighted by semantic similarity, age in days and matching time of day; a memory where
 * the agent was wrong also votes against what the agent predicted back then.
 */
export class HeuristicPredictor implements Predictor {
  readonly name = 'heuristic-v1';
  private readonly weights: HeuristicWeights;

  constructor(weights: Partial<HeuristicWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  async predict(context: PredictionContext): Promise<Prediction> {
    const tally = new Tally();
    const now = timeContext(context.timestampMs);
    for (const recalled of context.recalled) {
      const { record, distance } = recalled;
      const then = timeContext(record.timestampMs);
      const similarity = Math.min(1, Math.max(0.05, 1 - distance));
      const ageDays = Math.max(0, context.timestampMs - record.timestampMs) / DAY_MS;
      const recency = Math.max(0.1, 0.5 ** (ageDays / this.weights.recencyHalfLifeDays));
      const contextMatches: Array<[hit: boolean, bonus: number, label: string]> = [
        [then.daypart === now.daypart, this.weights.sameDaypart, `same ${now.daypart}`],
        [then.weekday === now.weekday, this.weights.sameWeekday, `same ${now.weekday}`],
        [record.after === context.after, this.weights.sameAfter, `also after ${context.after}`],
      ];
      const matched = contextMatches.filter(([hit]) => hit);
      const bonus = 1 + matched.reduce((sum, [, value]) => sum + value, 0);
      const matches = matched.map(([, , label]) => label);
      const weight = similarity * recency * bonus;
      const when = `${then.weekday} ${then.daypart}`;

      tally.support(record.actual, weight, `${tagOf(recalled)}: user did ${describeAction(record.actual)} (${when}${matches.length ? `; ${matches.join(', ')}` : ''})`);
      if (!record.correct) {
        tally.penalise(record.predicted, weight * this.weights.mistakePenalty, `${tagOf(recalled)}: I wrongly predicted ${describeAction(record.predicted)} there (${when})`);
      }
    }
    if (context.previous) {
      tally.support(context.previous, this.weights.repeatPrevious, `previous decision was ${describeAction(context.previous)}`);
    }
    return tally.verdict() ?? coldStart();
  }
}

export interface HabitWeights {
  /** Weight of a memory that followed exactly the same previous action (a habit: claim, then stake). */
  sameAction: number;
  /** ... that followed only the same kind of previous action. */
  sameCategory: number;
  /** ... that shares no previous-decision context (weak evidence of overall habits). */
  otherContext: number;
  /** Multiplier when the memory, like now, started a new session (or, like now, continued one). */
  sameSession: number;
  /** Within each of those groups, every newer memory halves an older one's weight per this many. */
  recencyHalfLife: number;
  /** Share of a memory's weight subtracted from the action it wrongly predicted. */
  mistakePenalty: number;
  /** Evidence for repeating the previous decision when no memory says anything better. */
  repeatPrevious: number;
}

export const HABIT_WEIGHTS: HabitWeights = {
  sameAction: 1,
  sameCategory: 0.35,
  otherContext: 0.05,
  sameSession: 1.5,
  recencyHalfLife: 2,
  mistakePenalty: 0.6,
  repeatPrevious: 0.02,
};

type Tier = 'sameAction' | 'sameCategory' | 'otherContext';

/**
 * Milestone 2 predictor. Learns sequences ("after claiming vSUI the user redeems it, then
 * sends SUI to the same address") from recalled memories, which store the previous action
 * and how long before it happened:
 * - memories that followed the same previous action count most, the same kind of action less;
 * - memories from the same session state (a new session after a break, or mid-session) count more;
 * - newer memories outweigh older ones of the same group, so changed habits take over quickly;
 * - memories of past mistakes vote against the action that was wrongly predicted.
 */
export class HabitPredictor implements Predictor {
  readonly name = 'habit-v2';
  private readonly weights: HabitWeights;

  constructor(weights: Partial<HabitWeights> = {}) {
    this.weights = { ...HABIT_WEIGHTS, ...weights };
  }

  async predict(context: PredictionContext): Promise<Prediction> {
    const tally = new Tally();
    const newSession = isNewSession(context.sinceMs);
    const byTier = new Map<Tier, RecalledRecord[]>();
    for (const recalled of context.recalled) {
      const tier = this.tierOf(recalled, context);
      byTier.set(tier, [...(byTier.get(tier) ?? []), recalled]);
    }

    for (const [tier, group] of byTier) {
      const newestFirst = [...group].sort((a, b) => b.record.timestampMs - a.record.timestampMs);
      for (const [rank, recalled] of newestFirst.entries()) {
        const { record } = recalled;
        const sessionMatch = newSession !== undefined && isNewSession(record.sinceMs) === newSession;
        const weight = this.weights[tier] * 0.5 ** (rank / this.weights.recencyHalfLife) * (sessionMatch ? this.weights.sameSession : 1);
        const after = record.previous ? `after ${describeAction(record.previous)}` : `after a ${record.after}`;
        const gap = record.sinceMs === undefined ? '' : `, ${describeGap(record.sinceMs)} later`;
        tally.support(record.actual, weight, `${tagOf(recalled)}: ${after}${gap}, the user did ${describeAction(record.actual)}`);
        if (!record.correct) {
          tally.penalise(record.predicted, weight * this.weights.mistakePenalty, `${tagOf(recalled)}: ${after} I wrongly predicted ${describeAction(record.predicted)}`);
        }
      }
    }
    if (context.previous) {
      tally.support(context.previous, this.weights.repeatPrevious, `previous decision was ${describeAction(context.previous)}`);
    }
    return tally.verdict() ?? coldStart();
  }

  private tierOf({ record }: RecalledRecord, context: PredictionContext): Tier {
    if (record.previous && context.previous && actionKey(record.previous) === actionKey(context.previous)) return 'sameAction';
    if (context.after !== 'none' && record.after === context.after) return 'sameCategory';
    return 'otherContext';
  }
}

function likeliestBucket(candidate: Candidate): string {
  const votes = new Map<string, number>();
  for (const { bucket, weight } of candidate.support) votes.set(bucket, (votes.get(bucket) ?? 0) + weight);
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? candidate.action.amountBucket;
}

function topNotes(candidate: Candidate, count = 3): string[] {
  return [...candidate.support]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, count)
    .map(({ note }) => note);
}

/** Explains when a remembered mistake changed the outcome: without it, another action would have won. */
function lessonsApplied(ranked: Candidate[], best: Candidate): string[] {
  return ranked
    .filter((c) => c !== best && c.penalties.length > 0)
    .filter((c) => c.score + c.penalties.reduce((sum, p) => sum + p.weight, 0) > best.score)
    .map((c) => `lesson applied: avoided ${describeAction(c.action)} because ${c.penalties[0]?.note ?? 'of a past mistake'}`);
}

const PREDICTORS: Record<string, () => Predictor> = {
  habit: () => new HabitPredictor(),
  heuristic: () => new HeuristicPredictor(),
};

export const DEFAULT_PREDICTOR = 'habit';

export function createPredictor(name = DEFAULT_PREDICTOR): Predictor {
  const factory = PREDICTORS[name];
  if (!factory) throw new Error(`Unknown predictor "${name}". Available: ${Object.keys(PREDICTORS).join(', ')}`);
  return factory();
}
