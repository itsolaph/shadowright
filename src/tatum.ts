import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CoinMetadata,
  CoinObject,
  EventFilter,
  EventId,
  Page,
  SuiEventEnvelope,
  SuiTransactionBlock,
  TransactionFilter,
} from './sui.ts';

/**
 * Token bucket rate limiter. With `capacity: 1` it degenerates into a strict minimum
 * spacing of `1 / ratePerSecond` between requests, so no one-second window can exceed
 * `ceil(ratePerSecond)` calls. The Tatum free plan allows 3 rps; we default to 2.5.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private queue: Promise<void> = Promise.resolve();
  private readonly ratePerSecond: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    ratePerSecond: number,
    capacity = 1,
    clock: { now: () => number; sleep: (ms: number) => Promise<void> } = { now: Date.now, sleep: delay },
  ) {
    this.ratePerSecond = ratePerSecond;
    this.capacity = capacity;
    this.tokens = capacity;
    this.now = clock.now;
    this.sleep = clock.sleep;
    this.lastRefill = clock.now();
  }

  /** Resolves when the caller may send one request. Calls are served in FIFO order. */
  take(): Promise<void> {
    const turn = this.queue.then(() => this.waitForToken());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForToken(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) * 1000) / this.ratePerSecond));
    }
  }

  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) * this.ratePerSecond) / 1000);
    this.lastRefill = now;
  }
}

/** Content-addressed JSON cache on disk: one file per request. */
export class DiskCache {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  static keyOf(method: string, params: unknown): string {
    return createHash('sha256').update(JSON.stringify([method, params])).digest('hex');
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.pathOf(key), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.pathOf(key)}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, this.pathOf(key));
  }

  private pathOf(key: string): string {
    return join(this.dir, `${key}.json`);
  }
}

export class RpcError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export interface TatumClientOptions {
  url: string;
  apiKey: string;
  /** Directory for the response cache. Omit to disable caching. */
  cacheDir?: string;
  ratePerSecond?: number;
  maxAttempts?: number;
  /** Base delay of the exponential backoff, in milliseconds. */
  backoffMs?: number;
  /** Deadline for one HTTP request; a stalled request counts as a retryable network error. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  bucket?: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
}

export interface CallOptions {
  /** Decide from the result whether it is safe to cache (default: always). */
  cacheIf?: (result: unknown) => boolean;
  /** Skip the cache entirely for this call (for live values such as the latest checkpoint). */
  noCache?: boolean;
}

export interface QueryOptions extends CallOptions {
  /** Newest first instead of oldest first. */
  descending?: boolean;
  /** Return only digests, without transaction details. */
  digestsOnly?: boolean;
}

const FULL_TRANSACTION = {
  showInput: true,
  showEffects: true,
  showEvents: true,
  showBalanceChanges: true,
  showObjectChanges: true,
};

export interface UsageStats {
  networkCalls: number;
  cacheHits: number;
  retries: number;
}

/** Each Tatum RPC call costs 2 credits on the free plan. */
export const CREDITS_PER_CALL = 2;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Throttled, cached, retrying JSON-RPC client for the Tatum Sui gateway.
 * The API key is only ever placed in the request header; it never appears in errors or logs.
 */
export class TatumSuiClient {
  readonly stats: UsageStats = { networkCalls: 0, cacheHits: 0, retries: 0 };
  private readonly url: string;
  private readonly apiKey: string;
  private readonly cache: DiskCache | undefined;
  private readonly bucket: TokenBucket;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextId = 1;

  constructor(options: TatumClientOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.cache = options.cacheDir ? new DiskCache(options.cacheDir) : undefined;
    this.bucket = options.bucket ?? new TokenBucket(options.ratePerSecond ?? 2.5);
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? delay;
  }

  async call<T>(method: string, params: unknown[], options: CallOptions = {}): Promise<T> {
    const key = DiskCache.keyOf(method, params);
    if (this.cache && !options.noCache) {
      const cached = await this.cache.get<T>(key);
      if (cached !== undefined) {
        this.stats.cacheHits += 1;
        return cached;
      }
    }

    const result = await this.send<T>(method, params);
    if (this.cache && !options.noCache && (options.cacheIf?.(result) ?? true)) {
      await this.cache.set(key, result);
    }
    return result;
  }

  /**
   * Oldest first by default: every full page is then stable, so only the open last page is
   * ever refetched. `descending` reads the newest transactions first (used to sample recent
   * activity); `digestsOnly` returns digests without details (used to detect new activity).
   */
  queryTransactionBlocks(
    filter: TransactionFilter,
    cursor: string | null,
    limit = 50,
    options: QueryOptions = {},
  ): Promise<Page<SuiTransactionBlock>> {
    const responseOptions = options.digestsOnly ? {} : FULL_TRANSACTION;
    return this.call(
      'suix_queryTransactionBlocks',
      [{ filter, options: responseOptions }, cursor, limit, options.descending ?? false],
      options,
    );
  }

  multiGetTransactionBlocks(digests: string[], options: CallOptions = {}): Promise<SuiTransactionBlock[]> {
    return this.call('sui_multiGetTransactionBlocks', [digests, FULL_TRANSACTION], options);
  }

  queryEvents(filter: EventFilter, cursor: EventId | null, limit = 50, options: QueryOptions = {}): Promise<Page<SuiEventEnvelope, EventId>> {
    return this.call('suix_queryEvents', [filter, cursor, limit, options.descending ?? false], options);
  }

  getCoinMetadata(coinType: string): Promise<CoinMetadata | null> {
    return this.call('suix_getCoinMetadata', [coinType]);
  }

  getCoins(owner: string, coinType: string, limit = 10): Promise<Page<CoinObject>> {
    return this.call('suix_getCoins', [owner, coinType, null, limit], { noCache: true });
  }

  getReferenceGasPrice(): Promise<string> {
    return this.call('suix_getReferenceGasPrice', [], { noCache: true });
  }

  getLatestCheckpoint(): Promise<string> {
    return this.call('sui_getLatestCheckpointSequenceNumber', [], { noCache: true });
  }

  /** Credits spent by this client instance so far (cache hits are free). */
  get creditsUsed(): number {
    return this.stats.networkCalls * CREDITS_PER_CALL;
  }

  /** Simulates a transaction without executing it. Used before a licensed agent acts. */
  dryRunTransactionBlock(txBytesBase64: string): Promise<unknown> {
    return this.call('sui_dryRunTransactionBlock', [txBytesBase64], { noCache: true });
  }

  private async send<T>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) this.stats.retries += 1;
      await this.bucket.take();
      this.stats.networkCalls += 1;

      let response: Response;
      try {
        response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = new RpcError(`${method}: network error (${(error as Error).message})`);
        await this.sleep(this.backoff(attempt));
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status)) {
        lastError = new RpcError(`${method}: HTTP ${response.status}`, response.status);
        await this.sleep(retryAfterMs(response) ?? this.backoff(attempt));
        continue;
      }
      if (!response.ok) {
        throw new RpcError(`${method}: HTTP ${response.status}`, response.status);
      }

      const payload = (await response.json()) as { result?: T; error?: { code: number; message: string } };
      if (payload.error) throw new RpcError(`${method}: ${payload.error.message}`, payload.error.code);
      return payload.result as T;
    }

    throw lastError ?? new RpcError(`${method}: failed`);
  }

  private backoff(attempt: number): number {
    const exponential = this.backoffMs * 2 ** (attempt - 1);
    return exponential + Math.floor(Math.random() * this.backoffMs);
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
