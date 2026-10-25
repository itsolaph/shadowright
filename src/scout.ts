import { readablePage, toDecision } from './history.ts';
import { normaliseAddress, shortAddress } from './subjects.ts';
import type { EventFilter, Page, SuiEventEnvelope, SuiTransactionBlock } from './sui.ts';
import type { TatumSuiClient } from './tatum.ts';
import { CATEGORIES, type Category, type Decision } from './types.ts';

/**
 * Finds ordinary, diverse Sui users to learn from, using public mainnet data via Tatum.
 * Seeds are the senders of recent staking and DEX swap events; each seed's latest own
 * transactions are classified, and bots (bursty or single-protocol) and one-trick wallets
 * are filtered out. Read-only: nothing is signed or sent.
 */

export interface SeedSource {
  label: string;
  filter: EventFilter;
}

/** Event types where ordinary users show up: native staking and the largest DEXes. */
export const DEFAULT_SEED_SOURCES: SeedSource[] = [
  { label: 'stake', filter: { MoveEventType: '0x3::validator::StakingRequestEvent' } },
  { label: 'unstake', filter: { MoveEventType: '0x3::validator::UnstakingRequestEvent' } },
  {
    label: 'cetus swap',
    filter: { MoveEventType: '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent' },
  },
  {
    label: 'deepbook fill',
    filter: { MoveEventType: '0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809::order_info::OrderFilled' },
  },
];

export interface ScoutCriteria {
  /** Own transactions to sample per wallet, newest first. */
  sampleSize: number;
  /** Above this many transactions per day (sustained or on a single day) the wallet is a bot. */
  maxDailyRate: number;
  /** Above this share of transactions through one package the wallet is a single-protocol bot. */
  maxTopPackageShare: number;
  /** Each group must be represented by at least one of its categories. */
  requiredGroups: Category[][];
  minSpanDays: number;
}

export const DEFAULT_CRITERIA: ScoutCriteria = {
  sampleSize: 300,
  maxDailyRate: 2000,
  maxTopPackageShare: 0.8,
  requiredGroups: [['swap'], ['transfer'], ['stake'], ['claim', 'defi']],
  minSpanDays: 21,
};

export interface WalletProfile {
  address: string;
  transactions: number;
  counts: Record<Category, number>;
  firstMs: number;
  lastMs: number;
  spanDays: number;
  /** Most own transactions on a single UTC day. */
  peakPerDay: number;
  /** Transactions per day over the sampled span (a short span with many calls means a bot). */
  dailyRate: number;
  topPackage: string | undefined;
  topPackageShare: number;
  /** Length of a scripted loop of categories (e.g. claim, swap, stake, repeat), if there is one. */
  loopPeriod: number | undefined;
}

/**
 * Detects scripted loops such as claim, swap, stake, claim, swap, stake: some period of 2-4
 * steps predicts the next category almost always, while consecutive categories mostly differ
 * (so a person who simply swaps many times in a row is not mistaken for a loop).
 */
export function scriptedLoop(categories: Category[], minLength = 30, minShare = 0.9): number | undefined {
  if (categories.length < minLength) return undefined;
  const repeatShare = (period: number) => {
    let same = 0;
    for (let i = period; i < categories.length; i++) if (categories[i] === categories[i - period]) same += 1;
    return same / (categories.length - period);
  };
  if (repeatShare(1) >= 0.5) return undefined;
  return [2, 3, 4].find((period) => repeatShare(period) >= minShare);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Floor for the span used in rates, so two transactions a second apart do not read as infinite. */
const MIN_RATE_SPAN_MS = 60 * 1000;
const FRAMEWORK_PACKAGES = new Set(['0x1', '0x2']);

export function profileWallet(address: string, decisions: Decision[]): WalletProfile {
  const own = decisions.filter((d) => d.initiatedByUser).sort((a, b) => a.timestampMs - b.timestampMs);
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  const perDay = new Map<string, number>();
  const perPackage = new Map<string, number>();
  for (const decision of own) {
    counts[decision.category] += 1;
    const day = new Date(decision.timestampMs).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    for (const pkg of new Set(decision.packages.filter((p) => !FRAMEWORK_PACKAGES.has(p)))) {
      perPackage.set(pkg, (perPackage.get(pkg) ?? 0) + 1);
    }
  }

  const times = own.map((d) => d.timestampMs);
  const firstMs = times.length ? Math.min(...times) : 0;
  const lastMs = times.length ? Math.max(...times) : 0;
  const [topPackage, topCount] = [...perPackage.entries()].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
  return {
    address,
    transactions: own.length,
    counts,
    firstMs,
    lastMs,
    spanDays: (lastMs - firstMs) / DAY_MS,
    peakPerDay: Math.max(0, ...perDay.values()),
    dailyRate: own.length < 2 ? 0 : own.length / (Math.max(lastMs - firstMs, MIN_RATE_SPAN_MS) / DAY_MS),
    topPackage,
    topPackageShare: own.length ? topCount / own.length : 0,
    loopPeriod: scriptedLoop(own.map((d) => d.category)),
  };
}

/** Why a wallet is not a good subject, or undefined if it is one. Bot checks come first. */
export function rejectReason(profile: WalletProfile, criteria: ScoutCriteria = DEFAULT_CRITERIA): string | undefined {
  if (profile.transactions === 0) return 'no own transactions';
  if (profile.peakPerDay > criteria.maxDailyRate || profile.dailyRate > criteria.maxDailyRate) {
    return `bot: bursts of ~${Math.round(Math.max(profile.peakPerDay, profile.dailyRate))} tx/day`;
  }
  if (profile.transactions >= 10 && profile.topPackageShare > criteria.maxTopPackageShare) {
    return `bot: ${Math.round(profile.topPackageShare * 100)}% of transactions through one package`;
  }
  if (profile.loopPeriod !== undefined) return `bot: scripted ${profile.loopPeriod}-step loop`;
  const missing = missingGroups(profile, criteria);
  if (missing.length > 0) return `not diverse: no ${missing.map((g) => g.join('/')).join(', ')}`;
  if (profile.spanDays < criteria.minSpanDays) return `short history: ${profile.spanDays.toFixed(1)} days`;
  return undefined;
}

export function missingGroups(profile: WalletProfile, criteria: ScoutCriteria = DEFAULT_CRITERIA): Category[][] {
  return criteria.requiredGroups.filter((group) => !group.some((category) => profile.counts[category] > 0));
}

/**
 * Prefers wallets with several well-populated categories over one big category: each
 * category counts up to 15 transactions, about what a licence needs to be judged.
 */
export function diversityScore(profile: WalletProfile): number {
  return CATEGORIES.reduce((sum, category) => sum + Math.min(profile.counts[category], 15), 0);
}

export interface ScoutCandidate {
  profile: WalletProfile;
  score: number;
  reason: string | undefined;
  sources: string[];
}

export interface ScoutOptions {
  sources?: SeedSource[];
  criteria?: ScoutCriteria;
  /** Event pages (50 events each) read per seed source. */
  eventPages?: number;
  /** Stop spending once this many Tatum credits were used by this run. */
  budgetCredits?: number;
  onProgress?: (message: string) => void;
}

export interface ScoutResult {
  candidates: ScoutCandidate[];
  seeds: number;
  sampled: number;
  creditsUsed: number;
}

const PAGE_SIZE = 50;

export async function scout(client: TatumSuiClient, options: ScoutOptions = {}): Promise<ScoutResult> {
  const criteria = options.criteria ?? DEFAULT_CRITERIA;
  const budget = options.budgetCredits ?? 3000;
  const log = options.onProgress ?? (() => undefined);
  const startCredits = client.creditsUsed;
  const spent = () => client.creditsUsed - startCredits;

  const seeds = await collectSeeds(client, options.sources ?? DEFAULT_SEED_SOURCES, options.eventPages ?? 6, log);
  // Addresses seen in several kinds of activity first: those are most likely diverse humans.
  const ordered = [...seeds.entries()].sort((a, b) => b[1].size - a[1].size);
  log(`${seeds.size} seed addresses, ${spent()} credits so far`);

  // Quick look: one page of recent own transactions per seed.
  const quick: ScoutCandidate[] = [];
  for (const [address, sources] of ordered) {
    if (spent() >= budget * 0.6) break;
    // A wallet whose newest page the node cannot render is skipped here: recovering it costs
    // a dozen calls, which only the deep look below spends.
    const decisions = await sampleOrSkip(client, address, PAGE_SIZE, false, log);
    if (!decisions) continue;
    const profile = profileWallet(address, decisions);
    quick.push({ profile, score: diversityScore(profile), reason: rejectReason(profile, criteria), sources: [...sources] });
  }
  log(`quick look at ${quick.length} wallets, ${spent()} credits so far`);

  // Deep look: the full sample for wallets that are not bots and already look diverse.
  const promising = quick
    .filter((c) => !c.reason?.startsWith('bot') && c.profile.transactions > 0)
    .filter((c) => missingGroups(c.profile, criteria).length <= 2)
    .sort((a, b) => b.score - a.score);
  const deep: ScoutCandidate[] = [];
  for (const candidate of promising) {
    if (spent() >= budget) break;
    const decisions = await sampleOrSkip(client, candidate.profile.address, criteria.sampleSize, true, log);
    if (!decisions) continue;
    const profile = profileWallet(candidate.profile.address, decisions);
    deep.push({ ...candidate, profile, score: diversityScore(profile), reason: rejectReason(profile, criteria) });
  }
  log(`deep look at ${deep.length} wallets, ${spent()} credits so far`);

  const deepAddresses = new Set(deep.map((c) => c.profile.address));
  const candidates = [...deep, ...quick.filter((c) => !deepAddresses.has(c.profile.address))].sort(
    (a, b) => Number(a.reason !== undefined) - Number(b.reason !== undefined) || b.score - a.score,
  );
  return { candidates, seeds: seeds.size, sampled: quick.length, creditsUsed: spent() };
}

async function collectSeeds(
  client: TatumSuiClient,
  sources: SeedSource[],
  pages: number,
  log: (message: string) => void,
): Promise<Map<string, Set<string>>> {
  const seeds = new Map<string, Set<string>>();
  for (const source of sources) {
    let cursor: string | null = null;
    let found = 0;
    try {
      for (let page = 0; page < pages; page++) {
        const result: Page<SuiEventEnvelope> = await client.queryEvents(source.filter, cursor, PAGE_SIZE, { descending: true });
        for (const event of result.data) {
          if (!event.sender) continue;
          const address = normaliseAddress(event.sender);
          seeds.set(address, (seeds.get(address) ?? new Set()).add(source.label));
          found += 1;
        }
        if (!result.hasNextPage || !result.nextCursor) break;
        cursor = result.nextCursor;
      }
    } catch (error) {
      log(`seed source ${source.label} skipped: ${(error as Error).message}`);
    }
    log(`seed source ${source.label}: ${found} events`);
  }
  return seeds;
}

async function sampleOrSkip(
  client: TatumSuiClient,
  address: string,
  size: number,
  resilient: boolean,
  log: (message: string) => void,
): Promise<Decision[] | undefined> {
  try {
    return (await sampleWallet(client, address, size, resilient)).decisions;
  } catch (error) {
    log(`skipped ${shortAddress(address)}…: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * The wallet's latest own transactions, newest first, classified from the wallet's point of
 * view. `resilient` recovers pages that contain transactions the node can no longer render.
 */
export async function sampleWallet(
  client: TatumSuiClient,
  address: string,
  size: number,
  resilient = true,
): Promise<{ transactions: SuiTransactionBlock[]; decisions: Decision[] }> {
  const transactions: SuiTransactionBlock[] = [];
  let cursor: string | null = null;
  while (transactions.length < size) {
    const filter = { FromAddress: address };
    const page: Page<SuiTransactionBlock> = resilient
      ? await readablePage(client, filter, cursor, { descending: true })
      : await client.queryTransactionBlocks(filter, cursor, PAGE_SIZE, { descending: true });
    transactions.push(...page.data);
    if (!page.hasNextPage || !page.nextCursor || page.data.length === 0) break;
    cursor = page.nextCursor;
  }
  const sample = transactions.slice(0, size);
  return { transactions: sample, decisions: sample.map((tx) => toDecision(tx, address)) };
}
