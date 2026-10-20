import type { HealthResult, RecallParams, RecallResult, RestoreResult } from '@mysten-incubation/memwal';
import { describeAction, timeContext } from './action.ts';
import { CATEGORIES, isCategory, type Action, type Category } from './types.ts';

/** One shadowing episode: what the agent predicted before a decision, and what the user did. */
export interface MemoryRecord {
  digest: string;
  timestampMs: number;
  /** Category of the user's previous decision, the short-term context of this one. */
  after: Category | 'none';
  predicted: Action;
  actual: Action;
  correct: boolean;
  /** Which parts of the prediction were wrong: `category`, `target`, `coin`. */
  misses: string[];
  /** Name of the predictor that made the call. */
  predictor: string;
}

export interface RecalledRecord {
  record: MemoryRecord;
  /** Cosine distance reported by Walrus Memory: 0 is identical, larger is less similar. */
  distance: number;
  blobId: string;
}

const TRAILER = '#sr1';

/**
 * Renders a record as a memory. The first part is plain prose, so semantic recall matches
 * on meaning ("Mon afternoon, after a transfer, user swapped SUI"); the trailer line keeps
 * exact values so the record can be parsed back losslessly.
 */
export function formatMemory(record: MemoryRecord): string {
  const { weekday, daypart, iso } = timeContext(record.timestampMs);
  const after = record.after === 'none' ? 'with no earlier decision' : `after a ${record.after}`;
  const prose = [
    `Shadowright memory [${record.actual.category}].`,
    `Context: ${weekday} ${daypart} (${iso} UTC), ${after}.`,
    `I predicted: ${describeAction(record.predicted)}.`,
    `The user did: ${describeAction(record.actual)}.`,
    `Verdict: ${record.correct ? 'correct' : `wrong ${record.misses.join(', ')}`}.`,
    `Lesson: ${lessonOf(record)}`,
  ].join(' ');

  const fields: Record<string, string> = {
    tx: record.digest,
    ts: String(record.timestampMs),
    after: record.after,
    by: record.predictor,
    ok: record.correct ? '1' : '0',
    miss: record.misses.join(','),
    ...actionFields('p', record.predicted),
    ...actionFields('a', record.actual),
  };
  const trailer = Object.entries(fields)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(' ');
  return `${prose}\n${TRAILER} ${trailer}`;
}

/** Parses a memory written by `formatMemory`. Returns undefined for any other text. */
export function parseMemory(text: string): MemoryRecord | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${TRAILER} `));
  if (!line) return undefined;
  const fields = new Map(
    line
      .slice(TRAILER.length + 1)
      .split(' ')
      .map((pair) => {
        const at = pair.indexOf('=');
        return [pair.slice(0, at), decodeURIComponent(pair.slice(at + 1))] as const;
      }),
  );

  const predicted = parseAction('p', fields);
  const actual = parseAction('a', fields);
  const afterField = fields.get('after') ?? 'none';
  const after = afterField === 'none' || isCategory(afterField) ? afterField : undefined;
  const timestampMs = Number(fields.get('ts'));
  if (!predicted || !actual || !after || !Number.isFinite(timestampMs)) return undefined;
  return {
    digest: fields.get('tx') ?? '',
    timestampMs,
    after,
    predicted,
    actual,
    correct: fields.get('ok') === '1',
    misses: (fields.get('miss') ?? '').split(',').filter(Boolean),
    predictor: fields.get('by') ?? 'unknown',
  };
}

function actionFields(prefix: string, action: Action): Record<string, string> {
  return {
    [`${prefix}c`]: action.category,
    [`${prefix}t`]: action.target,
    [`${prefix}k`]: action.coin,
    [`${prefix}a`]: action.amountBucket,
  };
}

function parseAction(prefix: string, fields: Map<string, string>): Action | undefined {
  const category = fields.get(`${prefix}c`);
  if (!category || !isCategory(category)) return undefined;
  return {
    category,
    target: fields.get(`${prefix}t`) ?? '-',
    coin: fields.get(`${prefix}k`) ?? '-',
    amountBucket: fields.get(`${prefix}a`) ?? '-',
  };
}

/** The human-readable takeaway stored with each memory. */
export function lessonOf(record: MemoryRecord): string {
  const { weekday, daypart } = timeContext(record.timestampMs);
  const actual = describeAction(record.actual);
  if (record.correct) {
    return `on ${weekday} ${daypart}s the user does ${actual}; keep predicting it.`;
  }
  return `I expected ${describeAction(record.predicted)} but the user did ${actual}; in a similar context prefer ${actual}.`;
}

/** The query used to recall memories relevant to a decision about to happen. */
export function contextQuery(timestampMs: number, after: Category | 'none'): string {
  const { weekday, daypart } = timeContext(timestampMs);
  const previous = after === 'none' ? 'with no earlier decision' : `after a ${after}`;
  return `Shadowright memory. Context: ${weekday} ${daypart}, ${previous}. What did the user do?`;
}

/**
 * The slice of the Walrus Memory client Shadowright uses. Both `MemWal` and the SDK's
 * in-process `MemWalMock` satisfy it, which keeps replays and tests off the network.
 */
export interface MemoryBackend {
  remember(text: string, namespace?: string, options?: { idempotencyKey?: string }): Promise<{ job_id: string }>;
  waitForRememberJob(jobId: string, opts?: { pollIntervalMs?: number; timeoutMs?: number }): Promise<{ blob_id: string }>;
  recall(params: RecallParams): Promise<RecallResult>;
  restore(namespace: string, limit?: number): Promise<RestoreResult>;
  health(): Promise<HealthResult>;
}

export interface StoredMemory {
  jobId: string;
  blobId: string;
}

export class ShadowMemory {
  readonly namespace: string;
  private readonly backend: MemoryBackend;

  constructor(backend: MemoryBackend, namespace: string) {
    this.backend = backend;
    this.namespace = namespace;
  }

  /** Stores a record and waits until it is on Walrus and indexed for recall. */
  async remember(record: MemoryRecord): Promise<StoredMemory> {
    const accepted = await this.backend.remember(formatMemory(record), this.namespace, {
      idempotencyKey: `shadowright:${this.namespace}:${record.digest}`,
    });
    const done = await this.backend.waitForRememberJob(accepted.job_id, { timeoutMs: 180_000 });
    return { jobId: accepted.job_id, blobId: done.blob_id };
  }

  async recall(query: string, limit = 10): Promise<RecalledRecord[]> {
    const result = await this.backend.recall({ query, limit, namespace: this.namespace });
    return result.results.flatMap((hit) => {
      const record = parseMemory(hit.text);
      return record ? [{ record, distance: hit.distance, blobId: hit.blob_id }] : [];
    });
  }

  /**
   * Recalls the most recent memories of every category, deduplicated by transaction.
   * Recall is similarity search, so this is a best-effort window of `perCategory` per
   * category, which is enough for licences judged over the last few decisions.
   */
  async recallAll(perCategory = 25): Promise<MemoryRecord[]> {
    const byDigest = new Map<string, MemoryRecord>();
    for (const category of CATEGORIES) {
      const result = await this.backend.recall({
        query: `Shadowright memory [${category}].`,
        limit: perCategory,
        namespace: this.namespace,
        sort: 'recent',
      });
      for (const hit of result.results) {
        const record = parseMemory(hit.text);
        if (record) byDigest.set(record.digest, record);
      }
    }
    return [...byDigest.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  }

  restore(limit?: number): Promise<RestoreResult> {
    return this.backend.restore(this.namespace, limit);
  }

  health(): Promise<HealthResult> {
    return this.backend.health();
  }
}
