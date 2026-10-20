import { actionKey, describeAction, timeContext } from './action.ts';
import type { RecalledRecord } from './memory.ts';
import type { Action, Category } from './types.ts';

/** Everything the agent may look at before the user acts. Nothing about the decision itself. */
export interface PredictionContext {
  timestampMs: number;
  /** Category of the user's previous decision. */
  after: Category | 'none';
  /** The user's previous decision, observable on chain right now. */
  previous?: Action;
  /** Memories recalled from Walrus Memory for this context, written strictly before `timestampMs`. */
  recalled: RecalledRecord[];
}

export interface Prediction {
  action: Action;
  /** Share of the supporting evidence behind the chosen action, 0..1. */
  confidence: number;
  /** Human-readable explanation, most important first. */
  reasons: string[];
}

/**
 * A predictor guesses the user's next action. The heuristic below is transparent and
 * deterministic; an LLM-backed predictor can implement the same interface later and be
 * swapped in by name without touching the replay loop or the licence logic.
 */
export interface Predictor {
  readonly name: string;
  predict(context: PredictionContext): Promise<Prediction>;
}

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

interface Candidate {
  action: Action;
  score: number;
  support: Array<{ weight: number; note: string; bucket: string }>;
  penalties: Array<{ weight: number; note: string }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Fallback when there is nothing to learn from yet. */
const COLD_START: Action = { category: 'transfer', target: '-', coin: 'SUI', amountBucket: '-' };

/**
 * Scores every action seen in recalled memories. Each memory votes for what the user
 * actually did, weighted by semantic similarity, recency and matching context; a memory
 * where the agent was wrong also votes against what the agent predicted back then.
 */
export class HeuristicPredictor implements Predictor {
  readonly name = 'heuristic-v1';
  private readonly weights: HeuristicWeights;

  constructor(weights: Partial<HeuristicWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  async predict(context: PredictionContext): Promise<Prediction> {
    const candidates = new Map<string, Candidate>();
    const candidateFor = (action: Action): Candidate => {
      const key = actionKey(action);
      let candidate = candidates.get(key);
      if (!candidate) {
        candidate = { action, score: 0, support: [], penalties: [] };
        candidates.set(key, candidate);
      }
      return candidate;
    };

    const now = timeContext(context.timestampMs);
    for (const { record, distance } of context.recalled) {
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
      const tag = `memory ${record.digest.slice(0, 6)}`;

      const support = candidateFor(record.actual);
      support.score += weight;
      support.support.push({
        weight,
        bucket: record.actual.amountBucket,
        note: `${tag}: user did ${describeAction(record.actual)} (${when}${matches.length ? `; ${matches.join(', ')}` : ''})`,
      });

      if (!record.correct) {
        const penalty = weight * this.weights.mistakePenalty;
        const mistaken = candidateFor(record.predicted);
        mistaken.score -= penalty;
        mistaken.penalties.push({
          weight: penalty,
          note: `${tag}: I wrongly predicted ${describeAction(record.predicted)} there (${when})`,
        });
      }
    }

    if (context.previous) {
      const repeat = candidateFor(context.previous);
      repeat.score += this.weights.repeatPrevious;
      repeat.support.push({
        weight: this.weights.repeatPrevious,
        bucket: context.previous.amountBucket,
        note: `previous decision was ${describeAction(context.previous)}`,
      });
    }

    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score <= 0) {
      return {
        action: COLD_START,
        confidence: 0,
        reasons: ['cold start: no usable memories for this context yet'],
      };
    }

    const totalSupport = ranked.reduce((sum, c) => sum + Math.max(0, c.score), 0);
    return {
      action: { ...best.action, amountBucket: likeliestBucket(best) },
      confidence: totalSupport > 0 ? best.score / totalSupport : 0,
      reasons: [...lessonsApplied(ranked, best), ...topNotes(best)],
    };
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
  heuristic: () => new HeuristicPredictor(),
};

export function createPredictor(name = 'heuristic'): Predictor {
  const factory = PREDICTORS[name];
  if (!factory) throw new Error(`Unknown predictor "${name}". Available: ${Object.keys(PREDICTORS).join(', ')}`);
  return factory();
}
