import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  eventFilter,
  pageVariables,
  QUERIES,
  toCoinMetadata,
  toCoinObject,
  toDryRun,
  toEventEnvelope,
  toPage,
  toTransactionBlock,
  transactionFilter,
  type GqlCoin,
  type GqlCoinMetadata,
  type GqlConnection,
  type GqlEvent,
  type GqlSimulation,
  type GqlTransaction,
} from './graphql.ts';
import type {
  CoinMetadata,
  CoinObject,
  DryRunResponse,
  EventFilter,
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

/**
 * Code given to errors the GraphQL service reports in a successful HTTP reply (a query it
 * cannot answer), so callers can tell them from HTTP and network failures, as with the
 * negative codes of JSON-RPC errors.
 */
export const GRAPHQL_ERROR_CODE = -32000;

export class RpcError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export interface TatumClientOptions {
  /** Tatum's Sui GraphQL endpoint; `/graphql` is appended to a bare gateway URL. */
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
  /** Decide from the (mapped) result whether it is safe to cache (default: always). */
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

export interface UsageStats {
  networkCalls: number;
  cacheHits: number;
  retries: number;
}

/**
 * Credits per Tatum request on the free plan. Tatum documents no separate price for GraphQL
 * requests, so the JSON-RPC price is kept: one GraphQL query is one request.
 */
export const CREDITS_PER_CALL = 2;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Prefix of every cache key. GraphQL results are cached raw, under keys that can never
 * collide with the JSON-RPC responses cached in the same directory before.
 */
const CACHE_PREFIX = 'gql:';

/** `https://sui-mainnet.gateway.tatum.io` -> `https://sui-mainnet.gateway.tatum.io/graphql`. */
export function graphqlUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/graphql') ? trimmed : `${trimmed}/graphql`;
}

/**
 * Throttled, cached, retrying client for Tatum's Sui GraphQL gateway. Its methods keep the
 * names and the JSON-RPC result shapes of the methods they replace (see `graphql.ts`).
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

  constructor(options: TatumClientOptions) {
    this.url = graphqlUrl(options.url);
    this.apiKey = options.apiKey;
    this.cache = options.cacheDir ? new DiskCache(options.cacheDir) : undefined;
    this.bucket = options.bucket ?? new TokenBucket(options.ratePerSecond ?? 2.5);
    this.maxAttempts = options.maxAttempts ?? 5;
    this.backoffMs = options.backoffMs ?? 500;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? delay;
  }

  /**
   * Runs one GraphQL query. The raw `data` is cached; `map` turns it into the result, and
   * `cacheIf` sees the mapped result. `name` labels errors and the cache key.
   */
  async query<D, R>(
    name: string,
    query: string,
    variables: Record<string, unknown>,
    map: (data: D) => R,
    options: CallOptions = {},
  ): Promise<R> {
    const key = DiskCache.keyOf(`${CACHE_PREFIX}${name}`, { query, variables });
    if (this.cache && !options.noCache) {
      const cached = await this.cache.get<D>(key);
      if (cached !== undefined) {
        this.stats.cacheHits += 1;
        return map(cached);
      }
    }

    const data = await this.send<D>(name, query, variables);
    const result = map(data);
    if (this.cache && !options.noCache && (options.cacheIf?.(result) ?? true)) {
      await this.cache.set(key, data);
    }
    return result;
  }

  /**
   * Oldest first by default: every full page is then stable, so only the open last page is
   * ever refetched. `descending` reads the newest transactions first (used to sample recent
   * activity); `digestsOnly` returns digests without details (used to detect new activity).
   * `cursor` is an opaque GraphQL cursor taken from a previous page's `nextCursor`.
   */
  queryTransactionBlocks(
    filter: TransactionFilter,
    cursor: string | null,
    limit = 50,
    options: QueryOptions = {},
  ): Promise<Page<SuiTransactionBlock>> {
    const descending = options.descending ?? false;
    const variables = { filter: transactionFilter(filter), ...pageVariables(cursor, limit, descending) };
    if (options.digestsOnly) {
      return this.query(
        'transactionDigests',
        QUERIES.transactionDigests,
        variables,
        (data: { transactions: GqlConnection<{ digest: string }> }) =>
          toPage(data.transactions, descending, (node): SuiTransactionBlock => ({ digest: node.digest })),
        options,
      );
    }
    return this.query(
      'transactions',
      QUERIES.transactions,
      variables,
      (data: { transactions: GqlConnection<GqlTransaction> }) => toPage(data.transactions, descending, toTransactionBlock),
      options,
    );
  }

  /** Transactions by digest, in the order given. Digests the service does not know are left out. */
  multiGetTransactionBlocks(digests: string[], options: CallOptions = {}): Promise<SuiTransactionBlock[]> {
    return this.query(
      'multiGetTransactions',
      QUERIES.multiGetTransactions,
      { keys: digests },
      (data: { multiGetTransactions: Array<GqlTransaction | null> }) =>
        data.multiGetTransactions.filter((tx): tx is GqlTransaction => tx !== null).map(toTransactionBlock),
      options,
    );
  }

  queryEvents(filter: EventFilter, cursor: string | null, limit = 50, options: QueryOptions = {}): Promise<Page<SuiEventEnvelope>> {
    const descending = options.descending ?? false;
    return this.query(
      'events',
      QUERIES.events,
      { filter: eventFilter(filter), ...pageVariables(cursor, limit, descending) },
      (data: { events: GqlConnection<GqlEvent> }) => toPage(data.events, descending, toEventEnvelope),
      options,
    );
  }

  getCoinMetadata(coinType: string): Promise<CoinMetadata | null> {
    return this.query('coinMetadata', QUERIES.coinMetadata, { coinType }, (data: { coinMetadata: GqlCoinMetadata | null }) =>
      toCoinMetadata(data.coinMetadata),
    );
  }

  /** Coin objects of one type owned by `owner` (balances held at the address itself are not coins). */
  getCoins(owner: string, coinType: string, limit = 10): Promise<Page<CoinObject>> {
    return this.query(
      'coins',
      QUERIES.coins,
      { owner, type: `0x2::coin::Coin<${coinType}>`, first: Math.min(limit, 50) },
      (data: { address: { objects: GqlConnection<GqlCoin> | null } | null }) => {
        const objects = data.address?.objects;
        return objects ? toPage(objects, false, toCoinObject(coinType)) : { data: [], nextCursor: null, hasNextPage: false };
      },
      { noCache: true },
    );
  }

  getReferenceGasPrice(): Promise<string> {
    const map = (data: { epoch: { referenceGasPrice: string } }) => String(data.epoch.referenceGasPrice);
    return this.query('referenceGasPrice', QUERIES.referenceGasPrice, {}, map, { noCache: true });
  }

  getLatestCheckpoint(): Promise<string> {
    const map = (data: { checkpoint: { sequenceNumber: number } }) => String(data.checkpoint.sequenceNumber);
    return this.query('latestCheckpoint', QUERIES.latestCheckpoint, {}, map, { noCache: true });
  }

  /** Credits spent by this client instance so far (cache hits are free). */
  get creditsUsed(): number {
    return this.stats.networkCalls * CREDITS_PER_CALL;
  }

  /**
   * Simulates a transaction (BCS bytes, base64) without executing it, with GraphQL's
   * `simulateTransaction`. Used before a licensed agent acts. Nothing is signed.
   */
  dryRunTransactionBlock(txBytesBase64: string): Promise<DryRunResponse> {
    return this.query(
      'simulateTransaction',
      QUERIES.simulate,
      { tx: { bcs: { value: txBytesBase64 } } },
      (data: { simulateTransaction: GqlSimulation }) => toDryRun(data.simulateTransaction),
      { noCache: true },
    );
  }

  private async send<D>(name: string, query: string, variables: Record<string, unknown>): Promise<D> {
    const body = JSON.stringify({ query, variables });
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
        lastError = new RpcError(`${name}: network error (${(error as Error).message})`);
        await this.sleep(this.backoff(attempt));
        continue;
      }

      if (RETRYABLE_STATUS.has(response.status)) {
        lastError = new RpcError(`${name}: HTTP ${response.status}`, response.status);
        await this.sleep(retryAfterMs(response) ?? this.backoff(attempt));
        continue;
      }
      if (!response.ok) {
        throw new RpcError(`${name}: HTTP ${response.status}`, response.status);
      }

      const payload = (await response.json()) as { data?: D | null; errors?: Array<{ message?: string }> };
      // Partial data next to errors is not trusted: it would be cached as if complete.
      if (payload.errors?.length) {
        const messages = payload.errors.map((error) => error.message ?? 'unknown error').slice(0, 3).join('; ');
        throw new RpcError(`${name}: ${messages}`, GRAPHQL_ERROR_CODE);
      }
      if (payload.data === undefined || payload.data === null) throw new RpcError(`${name}: empty response`, GRAPHQL_ERROR_CODE);
      return payload.data;
    }

    throw lastError ?? new RpcError(`${name}: failed`);
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
