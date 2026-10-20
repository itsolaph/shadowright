import {
  addressOwner,
  isCoinObjectType,
  isMoveCall,
  sameAddress,
  shortPackageId,
  SUI_COIN_TYPE,
  type SuiTransactionBlock,
} from './sui.ts';
import type { Category } from './types.ts';

/** The facts about a transaction that the classifier looks at. */
export interface TxFeatures {
  /** `package::module::function`, package ids shortened (`0x3::sui_system::request_add_stake`). */
  calls: string[];
  /** PTB command kinds in order: `MoveCall`, `SplitCoins`, `TransferObjects`, ... */
  commands: string[];
  eventTypes: string[];
  /** Coin types whose wallet balance went down / up, gas excluded. */
  coinTypesOut: string[];
  coinTypesIn: string[];
  /** Non-coin object types the wallet sent away / received. */
  objectsOut: string[];
  objectsIn: string[];
}

export interface Classification {
  category: Category;
  rule: string;
  /**
   * `package::module` of the call or event that decided the category: the protocol the user
   * actually used, rather than helper calls around it (price-oracle updates, fee modules).
   */
  venue: string | undefined;
}

interface Rule {
  category: Category;
  name: string;
  test: (f: TxFeatures) => string | undefined;
}

const STAKE_CALL = /(^0x3::sui_system::)|stak/i;
const CLAIM_CALL = /claim|harvest|reward|airdrop|collect_fee|redeem_reward/i;
const SWAP_CALL = /swap|router|aggregat|::trade|flash_swap|exchange/i;
const SWAP_EVENT = /swap/i;
const NFT_CALL = /(^0x2::kiosk)|kiosk|nft|transfer_policy|collectible|marketplace|launchpad|tradeport|bidding/i;
const DEFI_CALL = /deposit|withdraw|supply|borrow|repay|lend|liquidity|mint_position|position|vault|farm|pool/i;
const TRANSFER_COMMANDS = new Set(['SplitCoins', 'MergeCoins', 'TransferObjects']);
const TRANSFER_CALL = /^0x2::(pay|transfer|coin)::/;

function firstMatch(values: string[], pattern: RegExp): string | undefined {
  return values.find((value) => pattern.test(value));
}

/**
 * Rules in priority order. The first rule that returns a reason wins, so more specific
 * intents (staking, claiming, NFT markets) are checked before broader ones (swap, DeFi, transfer).
 */
const RULES: Rule[] = [
  { category: 'stake', name: 'stake call', test: (f) => firstMatch(f.calls, STAKE_CALL) },
  { category: 'claim', name: 'claim call', test: (f) => firstMatch(f.calls, CLAIM_CALL) },
  { category: 'nft', name: 'nft call', test: (f) => firstMatch(f.calls, NFT_CALL) },
  {
    category: 'swap',
    name: 'swap call',
    test: (f) => firstMatch(f.calls, SWAP_CALL) ?? firstMatch(f.eventTypes, SWAP_EVENT),
  },
  { category: 'defi', name: 'defi call', test: (f) => firstMatch(f.calls, DEFI_CALL) },
  {
    category: 'swap',
    name: 'coin exchange',
    test: (f) => {
      const out = f.coinTypesOut.find((type) => !f.coinTypesIn.includes(type));
      const into = f.coinTypesIn.find((type) => !f.coinTypesOut.includes(type));
      return out && into && f.calls.length > 0 ? `${shortCoin(out)} -> ${shortCoin(into)}` : undefined;
    },
  },
  {
    category: 'nft',
    name: 'object transfer',
    test: (f) => (f.calls.length === 0 ? (f.objectsOut[0] ?? f.objectsIn[0]) : undefined),
  },
  {
    category: 'transfer',
    name: 'plain transfer',
    test: (f) => {
      const plain = f.commands.length > 0 && f.commands.every((c) => TRANSFER_COMMANDS.has(c) || c === 'MoveCall');
      const calls = f.calls.every((call) => TRANSFER_CALL.test(call));
      return plain && calls ? f.commands.join('+') : undefined;
    },
  },
];

export function classifyFeatures(features: TxFeatures): Classification {
  for (const rule of RULES) {
    const evidence = rule.test(features);
    if (evidence) return { category: rule.category, rule: `${rule.name}: ${evidence}`, venue: venueOf(evidence) };
  }
  const evidence = features.calls[0] ?? features.commands.join('+');
  return { category: 'other', rule: `fallback: ${evidence || 'no commands'}`, venue: undefined };
}

/** `package::module` of a Move call or event type (`0xabc::pool::swap` -> `0xabc::pool`), if it is one. */
function venueOf(evidence: string): string | undefined {
  const [pkg, module] = evidence.split('<')[0]?.split('::') ?? [];
  return pkg?.startsWith('0x') && module ? `${shortPackageId(pkg)}::${module}` : undefined;
}

export function classify(tx: SuiTransactionBlock, wallet: string): Classification {
  return classifyFeatures(extractFeatures(tx, wallet));
}

export function extractFeatures(tx: SuiTransactionBlock, wallet: string): TxFeatures {
  const commands = tx.transaction?.data.transaction.transactions ?? [];
  const calls = commands
    .filter(isMoveCall)
    .map(({ MoveCall: c }) => `${shortPackageId(c.package)}::${c.module}::${c.function}`);

  const coinTypesOut: string[] = [];
  const coinTypesIn: string[] = [];
  for (const [coinType, delta] of walletCoinDeltas(tx, wallet)) {
    if (delta < 0n) coinTypesOut.push(coinType);
    if (delta > 0n) coinTypesIn.push(coinType);
  }

  const objectsOut: string[] = [];
  const objectsIn: string[] = [];
  for (const change of tx.objectChanges ?? []) {
    if (!change.objectType || isCoinObjectType(change.objectType)) continue;
    if (change.type === 'published') continue;
    const owner = addressOwner(change.recipient ?? change.owner);
    if (change.type === 'transferred' && sameAddress(change.sender, wallet) && !sameAddress(owner, wallet)) {
      objectsOut.push(change.objectType);
    } else if ((change.type === 'transferred' || change.type === 'created') && sameAddress(owner, wallet)) {
      objectsIn.push(change.objectType);
    }
  }

  return {
    calls,
    commands: commands.map((command) => Object.keys(command)[0] ?? 'Unknown'),
    eventTypes: (tx.events ?? []).map((event) => event.type),
    coinTypesOut,
    coinTypesIn,
    objectsOut,
    objectsIn,
  };
}

/**
 * Net balance change per coin type for `wallet`, with the gas fee added back to SUI
 * when the wallet paid for gas (otherwise every transaction would look like a SUI spend).
 */
export function walletCoinDeltas(tx: SuiTransactionBlock, wallet: string): Map<string, bigint> {
  const deltas = new Map<string, bigint>();
  for (const change of tx.balanceChanges ?? []) {
    if (!sameAddress(addressOwner(change.owner), wallet)) continue;
    const coinType = normaliseCoinType(change.coinType);
    deltas.set(coinType, (deltas.get(coinType) ?? 0n) + BigInt(change.amount));
  }

  const gasOwner = tx.transaction?.data.gasData?.owner ?? tx.transaction?.data.sender;
  if (sameAddress(gasOwner, wallet)) {
    const gas = gasFee(tx);
    if (gas !== 0n) deltas.set(SUI_COIN_TYPE, (deltas.get(SUI_COIN_TYPE) ?? 0n) + gas);
  }

  for (const [coinType, delta] of deltas) if (delta === 0n) deltas.delete(coinType);
  return deltas;
}

export function gasFee(tx: SuiTransactionBlock): bigint {
  const gas = tx.effects?.gasUsed;
  if (!gas) return 0n;
  return BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
}

/** Canonicalise the package part of a coin type so `0x000…2::sui::SUI` equals `0x2::sui::SUI`. */
export function normaliseCoinType(coinType: string): string {
  const [pkg, ...rest] = coinType.split('::');
  return [shortPackageId(pkg ?? ''), ...rest].join('::');
}

function shortCoin(coinType: string): string {
  return coinType.split('::').at(-1) ?? coinType;
}
