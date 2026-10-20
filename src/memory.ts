import type { HealthResult, RecallParams, RecallResult, RestoreResult } from '@mysten-incubation/memwal';
import { describeAction, describeGap, isNewSession, timeContext } from './action.ts';
import { CATEGORIES, isCategory, type Action, type Category } from './types.ts';

/** One shadowing episode: what the agent predicted before a decision, and what the user did. */
export interface MemoryRecord {
  digest: string;
  timestampMs: number;
  /** Category of the user's previous decision, the short-term context of this one. */
  after: Category | 'none';
  /** The previous decision itself, and how long before this one it happened (absent in old memories). */
  previous?: Action;
  sinceMs?: number;
  predicted: Action;
  actual: Action;
  correct: boolean;
  /** Which parts of the prediction were wrong: `category`, `target`, `coin`. */
  misses: string[];
  /** Name of the predictor that made the call. */
  predictor: string;
  /** Live mode only: when the prediction was stored, before the transaction was read. */
  predictedAtMs?: number;
}

/** A record as found on Walrus Memory, with the blob that holds it. */
export interface StoredRecord extends MemoryRecord {
  blobId: string;
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
  const live = record.predictedAtMs === undefined ? '' : ` live at ${timeContext(record.predictedAtMs).iso} UTC, before reading the transaction`;
  const prose = [
    `Shadowright memory [${record.actual.category}].`,
    `Context: ${weekday} ${daypart} (${iso} UTC), ${afterPhrase(record)}.`,
    `I predicted${live}: ${describeAction(record.predicted)}.`,
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
    ...(record.previous ? actionFields('b', record.previous) : {}),
    ...(record.sinceMs === undefined ? {} : { gap: String(record.sinceMs) }),
    ...(record.predictedAtMs === undefined ? {} : { pts: String(record.predictedAtMs) }),
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
  const previous = parseAction('b', fields);
  const gap = fields.get('gap');
  const predictedAt = fields.get('pts');
  return {
    ...(predictedAt === undefined ? {} : { predictedAtMs: Number(predictedAt) }),
    digest: fields.get('tx') ?? '',
    timestampMs,
    after,
    ...(previous ? { previous } : {}),
    ...(gap === undefined ? {} : { sinceMs: Number(gap) }),
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

/** "2 minutes after claim 1-10 vSUI via 0x13e1…::navi_vault", or the category only for old memories. */
function afterPhrase(context: { after: Category | 'none'; previous?: Action; sinceMs?: number }): string {
  if (context.previous) {
    const gap = context.sinceMs === undefined ? '' : `${describeGap(context.sinceMs)} `;
    return `${gap}after ${describeAction(context.previous)}`;
  }
  return context.after === 'none' ? 'with no earlier decision' : `after a ${context.after}`;
}

/** The human-readable takeaway stored with each memory. */
export function lessonOf(record: MemoryRecord): string {
  const actual = describeAction(record.actual);
  if (record.previous) {
    const after = `after ${describeAction(record.previous)}${isNewSession(record.sinceMs) ? ' and a break' : ''}`;
    return record.correct
      ? `${after}, the user does ${actual}; keep predicting it.`
      : `${after}, I expected ${describeAction(record.predicted)} but the user did ${actual}; next time prefer ${actual}.`;
  }
  const { weekday, daypart } = timeContext(record.timestampMs);
  if (record.correct) {
    return `on ${weekday} ${daypart}s the user does ${actual}; keep predicting it.`;
  }
  return `I expected ${describeAction(record.predicted)} but the user did ${actual}; in a similar context prefer ${actual}.`;
}

/** The query used to recall memories relevant to a decision about to happen, in the memories' own words. */
export function contextQuery(
  timestampMs: number,
  context: { after: Category | 'none'; previous?: Action; sinceMs?: number },
): string {
  const { weekday, daypart } = timeContext(timestampMs);
  return `Shadowright memory. Context: ${weekday} ${daypart}, ${afterPhrase(context)}. What did the user do?`;
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

export interface ShadowMemoryOptions {
  /** How many times to wait out a relayer rate limit (HTTP 429), using its retry-after hint. */
  rateLimitRetries?: number;
  onRateLimit?: (waitMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Wait suggested by a relayer rate-limit error (capped at 15 minutes), or undefined for other errors. */
export function rateLimitWaitMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('(429)')) return undefined;
  const seconds = Number(/"retry_after_seconds":\s*(\d+)/.exec(message)?.[1] ?? 60);
  return Math.min(seconds, 900) * 1000;
}

/** Relayer gateway errors (502-504, e.g. a recall that timed out while decrypting) are worth one more try. */
function isTransient(error: unknown): boolean {
  return /\(50[234]\)/.test(error instanceof Error ? error.message : String(error));
}

const TRANSIENT_RETRIES = 2;
const TRANSIENT_WAIT_MS = 5_000;

export class ShadowMemory {
  readonly namespace: string;
  private readonly backend: MemoryBackend;
  private readonly options: ShadowMemoryOptions;

  constructor(backend: MemoryBackend, namespace: string, options: ShadowMemoryOptions = {}) {
    this.backend = backend;
    this.namespace = namespace;
    this.options = options;
  }

  /** Runs one relayer request, retrying gateway errors briefly and waiting out rate limits as configured. */
  private async request<T>(send: () => Promise<T>): Promise<T> {
    const sleep = this.options.sleep ?? delay;
    let rateLimited = 0;
    let transient = 0;
    for (;;) {
      try {
        return await send();
      } catch (error) {
        const waitMs = rateLimitWaitMs(error);
        if (waitMs !== undefined && rateLimited++ < (this.options.rateLimitRetries ?? 0)) {
          this.options.onRateLimit?.(waitMs);
          await sleep(waitMs);
        } else if (isTransient(error) && transient++ < TRANSIENT_RETRIES) {
          await sleep(TRANSIENT_WAIT_MS);
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Stores a record and waits until it is on Walrus and indexed for recall. A job the relayer
   * reports as failed is resubmitted under a fresh idempotency key (the old key would collapse
   * onto the failed job), up to `attempts` times.
   */
  async remember(record: MemoryRecord, attempts = 3): Promise<StoredMemory> {
    const key = `shadowright:${this.namespace}:${record.digest}`;
    for (let attempt = 1; ; attempt++) {
      const accepted = await this.request(() =>
        this.backend.remember(formatMemory(record), this.namespace, {
          idempotencyKey: attempt === 1 ? key : `${key}:retry-${attempt - 1}`,
        }),
      );
      try {
        const done = await this.request(() => this.backend.waitForRememberJob(accepted.job_id, { timeoutMs: 180_000 }));
        return { jobId: accepted.job_id, blobId: done.blob_id };
      } catch (error) {
        if (attempt >= attempts || rateLimitWaitMs(error) !== undefined) throw error;
      }
    }
  }

  /** Semantic recall; `recent` returns the newest among the similar memories instead of the closest. */
  async recall(query: string, limit = 10, sort: 'relevance' | 'recent' = 'relevance'): Promise<RecalledRecord[]> {
    const result = await this.request(() => this.backend.recall({ query, limit, namespace: this.namespace, sort }));
    return result.results.flatMap((hit) => {
      const record = parseMemory(hit.text);
      return record ? [{ record, distance: hit.distance, blobId: hit.blob_id }] : [];
    });
  }

  /**
   * Recalls the most recent memories of every category, deduplicated by transaction, oldest
   * first. Recall is similarity search, so this is a best-effort window of `perCategory` per
   * category: plenty for licences, which are judged over the last few decisions.
   */
  async recallAll(perCategory = 60): Promise<StoredRecord[]> {
    const byDigest = new Map<string, StoredRecord>();
    // One category at a time: the relayer decrypts every recalled blob, and large parallel
    // recalls time out.
    for (const category of CATEGORIES) {
      const result = await this.request(() =>
        this.backend.recall({ query: `Shadowright memory [${category}].`, limit: perCategory, namespace: this.namespace, sort: 'recent' }),
      );
      for (const hit of result.results) {
        const record = parseMemory(hit.text);
        if (record) byDigest.set(record.digest, { ...record, blobId: hit.blob_id });
      }
    }
    return [...byDigest.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  }

  restore(limit?: number): Promise<RestoreResult> {
    return this.request(() => this.backend.restore(this.namespace, limit));
  }

  health(): Promise<HealthResult> {
    return this.backend.health();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
