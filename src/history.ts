import { classifyFeatures, extractFeatures, gasFee, walletCoinDeltas } from './classify.ts';
import {
  addressOwner,
  sameAddress,
  SUI_COIN_TYPE,
  type Page,
  type SuiTransactionBlock,
  type TransactionFilter,
} from './sui.ts';
import type { TatumSuiClient } from './tatum.ts';
import type { CoinFlow, Decision } from './types.ts';

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
  const filters: TransactionFilter[] = [{ FromAddress: wallet }, { ToAddress: wallet }];
  const byDigest = new Map<string, SuiTransactionBlock>();

  for (const filter of filters) {
    const label = Object.keys(filter)[0] ?? 'filter';
    let cursor: string | null = null;
    for (let page = 1; page <= (options.maxPages ?? 20); page++) {
      const result: Page<SuiTransactionBlock> = await client.queryTransactionBlocks(filter, cursor, 50, {
        cacheIf: isFullPage,
      });
      for (const tx of result.data) byDigest.set(tx.digest, tx);
      options.onPage?.(label, page, result.data.length);
      if (!result.hasNextPage || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
  }

  const txs = [...byDigest.values()].sort((a, b) => Number(a.timestampMs ?? 0) - Number(b.timestampMs ?? 0));
  const coins = await loadCoinInfo(client, txs, wallet);
  const history = {
    wallet,
    fetchedAt: new Date().toISOString(),
    decisions: txs.map((tx) => toDecision(tx, wallet, coins)),
  };
  return { history, transactions: txs };
}

function isFullPage(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { hasNextPage?: boolean }).hasNextPage === true;
}

/** Resolves symbol and decimals for every coin type the wallet touched. */
async function loadCoinInfo(client: TatumSuiClient, txs: SuiTransactionBlock[], wallet: string): Promise<CoinLookup> {
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
  const { category, rule } = classifyFeatures(features);
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
