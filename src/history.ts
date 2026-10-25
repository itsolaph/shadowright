import { classifyFeatures, extractFeatures, gasFee, walletCoinDeltas } from './classify.ts';
import {
  addressOwner,
  sameAddress,
  SUI_COIN_TYPE,
  type Page,
  type SuiTransactionBlock,
  type TransactionFilter,
} from './sui.ts';
import { RpcError, type QueryOptions, type TatumSuiClient } from './tatum.ts';
import type { CoinFlow, Decision } from './types.ts';

const PAGE_SIZE = 50;

export interface CoinInfo {
  symbol: string;
  decimals: number;
}

export type CoinLookup = (coinType: string) => CoinInfo;

const KNOWN_COINS: Record<string, CoinInfo> = {
  [SUI_COIN_TYPE]: { symbol: 'SUI', decimals: 9 },
};

export interface BackfillOptions {
  /** Upper bound on pages per direction (50 transactions each), to protect API credits. */
  maxPages?: number;
  /**
   * Fetch only the wallet's newest `latest` own transactions instead of its whole history
   * from the start. Incoming transactions are skipped: only own decisions are shadowed.
   */
  latest?: number;
  onPage?: (filter: string, page: number, size: number) => void;
}

export interface History {
  wallet: string;
  fetchedAt: string;
  decisions: Decision[];
}

/**
 * Fetches every transaction sent by or to the wallet, oldest first, and normalises them.
 * Full pages are cached forever; only the still-growing last page is refetched on later runs.
 */
export async function backfill(
  client: TatumSuiClient,
  wallet: string,
  options: BackfillOptions = {},
): Promise<{ history: History; transactions: SuiTransactionBlock[] }> {
  const byDigest = new Map<string, SuiTransactionBlock>();
  if (options.latest !== undefined) {
    await fetchLatest(client, wallet, options.latest, byDigest, options.onPage);
  } else {
    for (const filter of [{ FromAddress: wallet }, { ToAddress: wallet }] satisfies TransactionFilter[]) {
      await fetchFromStart(client, filter, options.maxPages ?? 20, byDigest, options.onPage);
    }
  }

  const txs = [...byDigest.values()].sort((a, b) => Number(a.timestampMs ?? 0) - Number(b.timestampMs ?? 0));
  const coins = await coinLookupFor(client, txs, wallet);
  const history = {
    wallet,
    fetchedAt: new Date().toISOString(),
    decisions: txs.map((tx) => toDecision(tx, wallet, coins)),
  };
  return { history, transactions: txs };
}

async function fetchFromStart(
  client: TatumSuiClient,
  filter: TransactionFilter,
  maxPages: number,
  into: Map<string, SuiTransactionBlock>,
  onPage: BackfillOptions['onPage'],
): Promise<void> {
  const label = Object.keys(filter)[0] ?? 'filter';
  let cursor: string | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const result = await readablePage(client, filter, cursor, { cacheIf: isFullPage });
    for (const tx of result.data) into.set(tx.digest, tx);
    onPage?.(label, page, result.data.length);
    if (!result.hasNextPage || !result.nextCursor) break;
    cursor = result.nextCursor;
  }
}

/** Newest first. The first page moves with every new transaction, so it is never read from cache. */
async function fetchLatest(
  client: TatumSuiClient,
  wallet: string,
  count: number,
  into: Map<string, SuiTransactionBlock>,
  onPage: BackfillOptions['onPage'],
): Promise<void> {
  let cursor: string | null = null;
  for (let page = 1; into.size < count; page++) {
    const result = await readablePage(client, { FromAddress: wallet }, cursor, { descending: true, noCache: cursor === null });
    for (const tx of result.data.slice(0, count - into.size)) into.set(tx.digest, tx);
    onPage?.('FromAddress (newest first)', page, result.data.length);
    // An empty page can still claim a next page (seen after unreadable transactions): stop there.
    if (!result.hasNextPage || !result.nextCursor || result.data.length === 0) break;
    cursor = result.nextCursor;
  }
}

/** Newest-first pages (50 digests each) scanned for the last processed transaction. */
const WATCH_SCAN_PAGES = 4;

/**
 * Digests of the wallet's own transactions newer than `afterDigest`, oldest first (live mode).
 * GraphQL cursors are opaque, so the watch state keeps the last processed digest and the
 * newest transactions are read backwards until it shows up: one call per poll, usually.
 */
export async function ownDigestsAfter(client: TatumSuiClient, wallet: string, afterDigest: string | null): Promise<string[]> {
  const digests: string[] = [];
  let cursor: string | null = null;
  for (let page = 1; page <= WATCH_SCAN_PAGES; page++) {
    const result = await client.queryTransactionBlocks({ FromAddress: wallet }, cursor, PAGE_SIZE, {
      descending: true,
      digestsOnly: true,
      noCache: true,
    });
    for (const tx of result.data) {
      if (tx.digest === afterDigest) return digests.reverse();
      digests.push(tx.digest);
    }
    // The whole indexed history was read: all of it is newer than the last processed transaction.
    if (!result.hasNextPage || !result.nextCursor) return digests.reverse();
    cursor = result.nextCursor;
  }
  if (afterDigest === null) return digests.reverse();
  throw new Error(
    `The last processed transaction is not among the newest ${digests.length}. Remove the subject's watch.json to start watching from now.`,
  );
}

/** Extra calls one page may spend recovering readable transactions (2 credits each). */
const RECOVERY_CALLS_PER_PAGE = 8;

/**
 * One page of transactions with details. Some transactions cannot be rendered by the service
 * (a GraphQL error for one of them fails the whole page); then the page is read as digests and
 * fetched in halves, dropping the unreadable transactions. Recovery is capped per page: when
 * many transactions are unreadable, the parts it cannot afford to split are dropped too.
 */
export async function readablePage(
  client: TatumSuiClient,
  filter: TransactionFilter,
  cursor: string | null,
  options: QueryOptions = {},
): Promise<Page<SuiTransactionBlock>> {
  try {
    return await client.queryTransactionBlocks(filter, cursor, PAGE_SIZE, options);
  } catch (error) {
    if (!isNodeRejection(error)) throw error;
    const page = await client.queryTransactionBlocks(filter, cursor, PAGE_SIZE, { ...options, digestsOnly: true });
    const budget = { calls: RECOVERY_CALLS_PER_PAGE };
    return { ...page, data: await fetchReadable(client, page.data.map((tx) => tx.digest), budget) };
  }
}

async function fetchReadable(client: TatumSuiClient, digests: string[], budget: { calls: number }): Promise<SuiTransactionBlock[]> {
  if (digests.length === 0 || budget.calls <= 0) return [];
  budget.calls -= 1;
  try {
    return await client.multiGetTransactionBlocks(digests);
  } catch (error) {
    if (!isNodeRejection(error)) throw error;
    if (digests.length === 1) return [];
    const half = Math.ceil(digests.length / 2);
    const first = await fetchReadable(client, digests.slice(0, half), budget);
    return [...first, ...(await fetchReadable(client, digests.slice(half), budget))];
  }
}

/** An error reported by the service itself (negative code), as opposed to HTTP or network failures. */
function isNodeRejection(error: unknown): boolean {
  return error instanceof RpcError && error.code !== undefined && error.code < 0;
}

function isFullPage(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { hasNextPage?: boolean }).hasNextPage === true;
}

/** Resolves symbol and decimals for every coin type the wallet touched. */
export async function coinLookupFor(client: TatumSuiClient, txs: SuiTransactionBlock[], wallet: string): Promise<CoinLookup> {
  const info = new Map<string, CoinInfo>(Object.entries(KNOWN_COINS));
  const coinTypes = new Set(txs.flatMap((tx) => [...walletCoinDeltas(tx, wallet).keys()]));
  for (const coinType of coinTypes) {
    if (info.has(coinType)) continue;
    const metadata = await client.getCoinMetadata(coinType).catch(() => null);
    if (metadata) info.set(coinType, { symbol: metadata.symbol, decimals: metadata.decimals });
  }
  return (coinType) => info.get(coinType) ?? fallbackCoinInfo(coinType);
}

export function fallbackCoinInfo(coinType: string): CoinInfo {
  return { symbol: coinType.split('::').at(-1) ?? coinType, decimals: 0 };
}

/** Normalises one raw transaction into a Decision from the wallet's point of view. */
export function toDecision(tx: SuiTransactionBlock, wallet: string, coins: CoinLookup = knownOrFallbackCoinInfo): Decision {
  const sender = tx.transaction?.data.sender ?? '';
  const features = extractFeatures(tx, wallet);
  const { category, rule, venue } = classifyFeatures(features);
  const calls = features.calls;

  const coinsOut: CoinFlow[] = [];
  const coinsIn: CoinFlow[] = [];
  for (const [coinType, delta] of walletCoinDeltas(tx, wallet)) {
    const flow = toCoinFlow(coinType, delta < 0n ? -delta : delta, coins(coinType));
    (delta < 0n ? coinsOut : coinsIn).push(flow);
  }
  // Largest movement first, so `coinsOut[0]` is the main coin of the decision.
  coinsOut.sort((a, b) => b.amount - a.amount);
  coinsIn.sort((a, b) => b.amount - a.amount);

  return {
    digest: tx.digest,
    timestampMs: Number(tx.timestampMs ?? 0),
    sender,
    initiatedByUser: sameAddress(sender, wallet),
    success: tx.effects?.status.status !== 'failure',
    category,
    rule,
    ...(venue ? { venue } : {}),
    counterparties: counterpartiesOf(tx, wallet),
    coinsOut,
    coinsIn,
    calls,
    packages: unique(calls.map((call) => call.split('::')[0] ?? '')),
    modules: unique(calls.map((call) => call.split('::').slice(0, 2).join('::'))),
    gasMist: gasFee(tx).toString(),
  };
}

function knownOrFallbackCoinInfo(coinType: string): CoinInfo {
  return KNOWN_COINS[coinType] ?? fallbackCoinInfo(coinType);
}

function toCoinFlow(coinType: string, raw: bigint, info: CoinInfo): CoinFlow {
  return { coinType, symbol: info.symbol, raw: raw.toString(), amount: Number(raw) / 10 ** info.decimals };
}

/**
 * Addresses on the other side of the decision: owners whose balances moved,
 * object recipients, and the sender of an incoming transaction. Ordered by first appearance.
 */
function counterpartiesOf(tx: SuiTransactionBlock, wallet: string): string[] {
  const found: string[] = [];
  const add = (address: string | undefined) => {
    if (address && !sameAddress(address, wallet) && !found.some((a) => sameAddress(a, address))) found.push(address);
  };

  const sender = tx.transaction?.data.sender;
  if (!sameAddress(sender, wallet)) add(sender);
  // Recipients first (positive balance changes), so a transfer's recipient is counterparty #1.
  const changes = tx.balanceChanges ?? [];
  const recipients = changes.filter((change) => BigInt(change.amount) > 0n);
  const payers = changes.filter((change) => BigInt(change.amount) < 0n);
  for (const change of [...recipients, ...payers]) add(addressOwner(change.owner));
  for (const change of tx.objectChanges ?? []) add(addressOwner(change.recipient));
  return found;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
