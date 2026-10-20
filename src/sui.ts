/**
 * The subset of Sui JSON-RPC response shapes Shadowright reads.
 * Fields are optional where the node may omit them depending on request options.
 */

export const SUI_COIN_TYPE = '0x2::sui::SUI';

export type Owner =
  | { AddressOwner: string }
  | { ObjectOwner: string }
  | { Shared: { initial_shared_version: number | string } }
  | 'Immutable'
  | Record<string, unknown>;

export interface BalanceChange {
  owner: Owner;
  coinType: string;
  /** Signed integer string. */
  amount: string;
}

export interface SuiEvent {
  type: string;
  sender?: string;
  packageId?: string;
  transactionModule?: string;
  parsedJson?: unknown;
}

export interface MoveCallCommand {
  MoveCall: { package: string; module: string; function: string; type_arguments?: string[] };
}

/** One PTB command: `{ MoveCall: ... }`, `{ TransferObjects: ... }`, `{ SplitCoins: ... }`, etc. */
export type PtbCommand = MoveCallCommand | Record<string, unknown>;

export interface PtbInput {
  type: 'pure' | 'object';
  valueType?: string;
  value?: unknown;
  objectType?: string;
  objectId?: string;
}

export interface TransactionKind {
  kind: string;
  inputs?: PtbInput[];
  transactions?: PtbCommand[];
}

export interface ObjectChange {
  type: 'created' | 'mutated' | 'transferred' | 'deleted' | 'wrapped' | 'published' | string;
  sender?: string;
  owner?: Owner;
  recipient?: Owner;
  objectType?: string;
  objectId?: string;
}

export interface GasCostSummary {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
  nonRefundableStorageFee?: string;
}

export interface SuiTransactionBlock {
  digest: string;
  timestampMs?: string;
  checkpoint?: string;
  transaction?: {
    data: {
      sender: string;
      gasData?: { owner: string };
      transaction: TransactionKind;
    };
  };
  effects?: {
    status: { status: 'success' | 'failure'; error?: string };
    gasUsed: GasCostSummary;
  };
  events?: SuiEvent[];
  balanceChanges?: BalanceChange[];
  objectChanges?: ObjectChange[];
}

export interface Page<T, Cursor = string> {
  data: T[];
  nextCursor: Cursor | null;
  hasNextPage: boolean;
}

export interface CoinMetadata {
  decimals: number;
  symbol: string;
  name: string;
}

export type TransactionFilter = { FromAddress: string } | { ToAddress: string };

export type EventFilter = { MoveEventType: string } | { MoveModule: { package: string; module: string } };

export interface EventId {
  txDigest: string;
  eventSeq: string;
}

export interface SuiEventEnvelope extends SuiEvent {
  id: EventId;
  timestampMs?: string;
}

export interface CoinObject {
  coinType: string;
  coinObjectId: string;
  version: string;
  digest: string;
  balance: string;
}

export function isMoveCall(command: PtbCommand): command is MoveCallCommand {
  return typeof command === 'object' && command !== null && 'MoveCall' in command;
}

export function addressOwner(owner: Owner | undefined): string | undefined {
  if (owner && typeof owner === 'object' && 'AddressOwner' in owner && typeof owner.AddressOwner === 'string') {
    return owner.AddressOwner;
  }
  return undefined;
}

/** Sui addresses are case-insensitive hex; compare them in canonical lower case. */
export function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

/** `0x0000…0002` and `0x2` name the same package: strip leading zeros for comparisons. */
export function shortPackageId(id: string): string {
  const hex = id.toLowerCase().replace(/^0x/, '').replace(/^0+(?=.)/, '');
  return `0x${hex}`;
}

export function isCoinObjectType(objectType: string | undefined): boolean {
  return objectType !== undefined && shortPackageId(objectType.split('::')[0] ?? '') === '0x2' && objectType.includes('::coin::Coin<');
}
