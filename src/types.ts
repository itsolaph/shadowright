/** Decision categories the agent can earn a licence for, one at a time. */
export const CATEGORIES = ['swap', 'transfer', 'stake', 'claim', 'nft', 'defi', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  swap: 'swap',
  transfer: 'send / transfer',
  stake: 'stake / unstake',
  claim: 'claim / reward',
  nft: 'nft',
  defi: 'defi deposit / withdraw',
  other: 'contract call / other',
};

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Net movement of one coin type for the wallet in a single transaction (gas excluded). */
export interface CoinFlow {
  coinType: string;
  symbol: string;
  /** Raw integer amount in the coin's smallest unit, always positive. */
  raw: string;
  /** Human amount (raw / 10^decimals). Lossy, for display and bucketing only. */
  amount: number;
}

/** One on-chain transaction normalised from the wallet's point of view. */
export interface Decision {
  digest: string;
  timestampMs: number;
  sender: string;
  /** True when the wallet signed the transaction, i.e. it was the user's own decision. */
  initiatedByUser: boolean;
  success: boolean;
  category: Category;
  /** Which classifier rule fired, for explainability. */
  rule: string;
  /** `package::module` that decided the category (the protocol used), when a call decided it. */
  venue?: string;
  /** Other addresses whose balances moved, or that received objects. */
  counterparties: string[];
  coinsOut: CoinFlow[];
  coinsIn: CoinFlow[];
  /** Fully qualified Move calls, e.g. `0x3::sui_system::request_add_stake`. */
  calls: string[];
  packages: string[];
  /** `package::module` pairs, in call order and deduplicated. */
  modules: string[];
  gasMist: string;
}

/**
 * The comparable shape of a decision: what the agent predicts and what is checked.
 * `target` is the recipient address for transfers and the `package::module` venue otherwise.
 */
export interface Action {
  category: Category;
  target: string;
  coin: string;
  amountBucket: string;
}
