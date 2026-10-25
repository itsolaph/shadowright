import type {
  BalanceChange,
  CoinMetadata,
  CoinObject,
  DryRunResponse,
  EventFilter,
  ObjectChange,
  Owner,
  Page,
  PtbCommand,
  PtbInput,
  SuiEvent,
  SuiEventEnvelope,
  SuiTransactionBlock,
  TransactionFilter,
  TransactionKind,
} from './sui.ts';

/**
 * Sui GraphQL queries and the mapping from their results into the JSON-RPC response shapes
 * of `sui.ts`, so the rest of Shadowright reads transactions exactly as before.
 *
 * Transaction data and effects are read as `transactionJson` / `effectsJson` /
 * `balanceChangesJson` (the gRPC proto JSON): one field each instead of hundreds of typed
 * nodes, which keeps queries under the service's query-node and payload limits. Typed fields
 * are used where the JSON lacks something: pure input types and values, events, timestamps.
 */

/** Largest page the service accepts for transactions, events and nested connections. */
export const MAX_PAGE = 50;

const TX_FIELDS = `digest transactionJson
kind { ... on ProgrammableTransaction { inputs(first: 50) { nodes { ... on MoveValue { type { repr } json } } } } }
effects {
  status timestamp checkpoint { sequenceNumber } executionError { message }
  effectsJson balanceChangesJson
  events(first: 50) { nodes { ${eventFields(false)} } }
}`;

function eventFields(envelope: boolean): string {
  const extra = envelope ? 'timestamp transaction { digest } ' : '';
  return `sequenceNumber ${extra}sender { address } transactionModule { name package { address } } contents { type { repr } json }`;
}

const PAGE_INFO = 'pageInfo { hasNextPage hasPreviousPage startCursor endCursor }';
const PAGE_ARGS = 'first: $first, after: $after, last: $last, before: $before';
const PAGE_VARS = '$first: Int, $after: String, $last: Int, $before: String';

export const QUERIES = {
  transactions: `query Transactions($filter: TransactionFilter, ${PAGE_VARS}) {
  transactions(filter: $filter, ${PAGE_ARGS}) { ${PAGE_INFO} nodes { ${TX_FIELDS} } }
}`,
  transactionDigests: `query TransactionDigests($filter: TransactionFilter, ${PAGE_VARS}) {
  transactions(filter: $filter, ${PAGE_ARGS}) { ${PAGE_INFO} nodes { digest } }
}`,
  multiGetTransactions: `query MultiGetTransactions($keys: [String!]!) {
  multiGetTransactions(keys: $keys) { ${TX_FIELDS} }
}`,
  events: `query Events($filter: EventFilter, ${PAGE_VARS}) {
  events(filter: $filter, ${PAGE_ARGS}) { ${PAGE_INFO} nodes { ${eventFields(true)} } }
}`,
  coinMetadata: `query CoinMetadata($coinType: String!) {
  coinMetadata(coinType: $coinType) { decimals symbol name }
}`,
  coins: `query Coins($owner: SuiAddress!, $type: String!, $first: Int) {
  address(address: $owner) { objects(first: $first, filter: { type: $type }) { ${PAGE_INFO} nodes { address version digest contents { json } } } }
}`,
  referenceGasPrice: 'query ReferenceGasPrice { epoch { referenceGasPrice } }',
  latestCheckpoint: 'query LatestCheckpoint { checkpoint { sequenceNumber } }',
  simulate: `query Simulate($tx: JSON!) {
  simulateTransaction(transaction: $tx) {
    effects { status executionError { message } balanceChanges(first: 50) { nodes { owner { address } coinType { repr } amount } } }
  }
}`,
} as const;

// ---- GraphQL result shapes (only the fields selected above) ----

interface GqlPageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface GqlConnection<T> {
  pageInfo: GqlPageInfo;
  nodes: T[];
}

export interface GqlEvent {
  sequenceNumber: number;
  timestamp?: string | null;
  transaction?: { digest: string } | null;
  sender?: { address: string } | null;
  transactionModule?: { name: string; package?: { address: string } | null } | null;
  contents?: { type?: { repr: string } | null; json?: unknown } | null;
}

export interface GqlTransaction {
  digest: string;
  transactionJson?: ProtoTransaction | null;
  kind?: { inputs?: { nodes: Array<{ type?: { repr: string }; json?: unknown }> } } | null;
  effects?: {
    status?: 'SUCCESS' | 'FAILURE' | null;
    timestamp?: string | null;
    checkpoint?: { sequenceNumber: number } | null;
    executionError?: { message: string } | null;
    effectsJson?: ProtoEffects | null;
    balanceChangesJson?: ProtoBalanceChange[] | null;
    events?: { nodes: GqlEvent[] } | null;
  } | null;
}

// ---- gRPC proto JSON shapes (the parts that are read) ----

interface ProtoTransaction {
  sender?: string;
  gasPayment?: { owner?: string };
  kind?: { kind?: string; programmableTransaction?: { inputs?: ProtoInput[]; commands?: ProtoCommand[] } };
}

interface ProtoInput {
  kind?: string;
  objectId?: string;
  version?: string | number;
  digest?: string;
  mutable?: boolean;
}

type ProtoArgument = { kind?: string; input?: number; result?: number; subresult?: number };
type ProtoCommand = Record<string, Record<string, unknown> | undefined>;

interface ProtoOwner {
  kind?: string;
  address?: string;
  version?: string | number;
}

interface ProtoChangedObject {
  objectId: string;
  inputState?: string;
  inputOwner?: ProtoOwner;
  outputState?: string;
  outputOwner?: ProtoOwner;
  idOperation?: string;
  objectType?: string;
}

interface ProtoEffects {
  gasUsed?: { computationCost?: string; storageCost?: string; storageRebate?: string; nonRefundableStorageFee?: string };
  changedObjects?: ProtoChangedObject[];
}

interface ProtoBalanceChange {
  address: string;
  coinType: string;
  amount: string;
}

// ---- Filters and pagination ----

export function transactionFilter(filter: TransactionFilter): Record<string, string> {
  // JSON-RPC's ToAddress (received objects or coins) has no exact GraphQL counterpart;
  // affectedAddress is a superset (it also matches the address's own transactions).
  return 'FromAddress' in filter ? { sentAddress: filter.FromAddress } : { affectedAddress: filter.ToAddress };
}

export function eventFilter(filter: EventFilter): Record<string, string> {
  return 'MoveEventType' in filter
    ? { type: filter.MoveEventType }
    : { module: `${filter.MoveModule.package}::${filter.MoveModule.module}` };
}

/** Oldest first pages forward (`first`/`after`), newest first pages backward (`last`/`before`). */
export function pageVariables(cursor: string | null, limit: number, descending: boolean): Record<string, unknown> {
  const size = Math.max(1, Math.min(limit, MAX_PAGE));
  const page: Record<string, unknown> = descending ? { last: size } : { first: size };
  if (cursor !== null) page[descending ? 'before' : 'after'] = cursor;
  return page;
}

/** A GraphQL connection as a JSON-RPC page. Backward pages arrive oldest first and are reversed. */
export function toPage<N, T>(connection: GqlConnection<N>, descending: boolean, map: (node: N) => T): Page<T> {
  const { pageInfo } = connection;
  const nodes = descending ? [...connection.nodes].reverse() : connection.nodes;
  const nextCursor = (descending ? pageInfo.startCursor : pageInfo.endCursor) ?? null;
  const more = descending ? pageInfo.hasPreviousPage : pageInfo.hasNextPage;
  return { data: nodes.map(map), nextCursor, hasNextPage: more && nextCursor !== null };
}

// ---- Transactions ----

export function toTransactionBlock(node: GqlTransaction): SuiTransactionBlock {
  const tx: SuiTransactionBlock = { digest: node.digest };
  const effects = node.effects;
  if (effects?.timestamp) tx.timestampMs = String(Date.parse(effects.timestamp));
  if (effects?.checkpoint) tx.checkpoint = String(effects.checkpoint.sequenceNumber);

  const data = node.transactionJson;
  if (data?.sender) {
    const typedInputs = node.kind?.inputs?.nodes ?? [];
    tx.transaction = {
      data: {
        sender: data.sender,
        gasData: { owner: data.gasPayment?.owner ?? data.sender },
        transaction: toKind(data.kind, typedInputs),
      },
    };
  }

  if (effects) {
    const gas = effects.effectsJson?.gasUsed ?? {};
    const status = effects.status === 'FAILURE' ? 'failure' : 'success';
    tx.effects = {
      status: status === 'failure' ? { status, error: effects.executionError?.message ?? 'unknown error' } : { status },
      gasUsed: {
        computationCost: gas.computationCost ?? '0',
        storageCost: gas.storageCost ?? '0',
        storageRebate: gas.storageRebate ?? '0',
        nonRefundableStorageFee: gas.nonRefundableStorageFee ?? '0',
      },
    };
    tx.events = (effects.events?.nodes ?? []).map(toEvent);
    tx.balanceChanges = (effects.balanceChangesJson ?? []).map(toBalanceChange);
    tx.objectChanges = toObjectChanges(effects.effectsJson?.changedObjects ?? [], data?.sender);
  }
  return tx;
}

function toKind(kind: ProtoTransaction['kind'], typedInputs: Array<{ type?: { repr: string }; json?: unknown }>): TransactionKind {
  const ptb = kind?.programmableTransaction;
  const name = pascalCase(kind?.kind ?? 'UNKNOWN');
  if (!ptb) return { kind: name };
  return {
    kind: name,
    inputs: (ptb.inputs ?? []).map((input, i) => toInput(input, typedInputs[i])),
    transactions: (ptb.commands ?? []).map(toCommand),
  };
}

/** Pure inputs take their Move type and value from the typed `inputs` connection. */
function toInput(input: ProtoInput, typed: { type?: { repr: string }; json?: unknown } | undefined): PtbInput {
  const ref = { objectId: input.objectId, version: input.version === undefined ? undefined : String(input.version), digest: input.digest };
  switch (input.kind) {
    case 'PURE':
      return typed?.type ? { type: 'pure', valueType: shortTypes(typed.type.repr), value: typed.json } : { type: 'pure' };
    case 'IMMUTABLE_OR_OWNED':
      return { type: 'object', objectType: 'immOrOwnedObject', ...ref };
    case 'SHARED':
      return { type: 'object', objectType: 'sharedObject', objectId: input.objectId, initialSharedVersion: ref.version, mutable: input.mutable };
    case 'RECEIVING':
      return { type: 'object', objectType: 'receiving', ...ref };
    default:
      return { type: camelCase(input.kind ?? 'unknown') };
  }
}

/** Proto commands (`{ moveCall: {...} }`) as JSON-RPC commands (`{ MoveCall: {...} }`). */
function toCommand(command: ProtoCommand): PtbCommand {
  const [key, body = {}] = Object.entries(command)[0] ?? ['unknown', {}];
  const args = (value: unknown) => (Array.isArray(value) ? value.map((a) => toArgument(a as ProtoArgument)) : []);
  switch (key) {
    case 'moveCall': {
      // Like JSON-RPC, empty type argument and argument lists are left out.
      const typeArguments = ((body.typeArguments as string[] | undefined) ?? []).map(shortTypes);
      const callArguments = args(body.arguments);
      return {
        MoveCall: {
          package: String(body.package),
          module: String(body.module),
          function: String(body.function),
          ...(typeArguments.length > 0 ? { type_arguments: typeArguments } : {}),
          ...(callArguments.length > 0 ? { arguments: callArguments } : {}),
        },
      };
    }
    case 'splitCoins':
      return { SplitCoins: [toArgument(body.coin as ProtoArgument), args(body.amounts)] };
    case 'mergeCoins':
      return { MergeCoins: [toArgument(body.coin as ProtoArgument), args(body.coinsToMerge)] };
    case 'transferObjects':
      return { TransferObjects: [args(body.objects), toArgument(body.address as ProtoArgument)] };
    case 'makeMoveVector':
      return { MakeMoveVec: [typeof body.elementType === 'string' ? shortTypes(body.elementType) : null, args(body.elements)] };
    case 'publish':
      return { Publish: body.dependencies ?? [] };
    case 'upgrade':
      return { Upgrade: [body.dependencies ?? [], body.package, toArgument(body.ticket as ProtoArgument)] };
    default:
      return { [pascalCase(key)]: body };
  }
}

function toArgument(argument: ProtoArgument | undefined): unknown {
  switch (argument?.kind) {
    case 'GAS':
      return 'GasCoin';
    case 'INPUT':
      return { Input: argument.input ?? 0 };
    case 'RESULT':
      return argument.subresult === undefined ? { Result: argument.result ?? 0 } : { NestedResult: [argument.result ?? 0, argument.subresult] };
    default:
      return argument ?? null;
  }
}

function toEvent(event: GqlEvent): SuiEvent {
  return {
    type: shortTypes(event.contents?.type?.repr ?? ''),
    sender: event.sender?.address,
    packageId: event.transactionModule?.package?.address,
    transactionModule: event.transactionModule?.name,
    parsedJson: event.contents?.json,
  };
}

export function toEventEnvelope(event: GqlEvent): SuiEventEnvelope {
  return {
    ...toEvent(event),
    id: { txDigest: event.transaction?.digest ?? '', eventSeq: String(event.sequenceNumber) },
    ...(event.timestamp ? { timestampMs: String(Date.parse(event.timestamp)) } : {}),
  };
}

function toBalanceChange(change: ProtoBalanceChange): BalanceChange {
  return { owner: { AddressOwner: change.address }, coinType: shortTypes(change.coinType), amount: change.amount };
}

export function toOwner(owner: ProtoOwner | undefined): Owner | undefined {
  switch (owner?.kind) {
    case 'ADDRESS':
      return { AddressOwner: owner.address ?? '' };
    case 'OBJECT':
      return { ObjectOwner: owner.address ?? '' };
    case 'SHARED':
      return { Shared: { initial_shared_version: Number(owner.version ?? 0) } };
    case 'IMMUTABLE':
      return 'Immutable';
    case 'CONSENSUS_ADDRESS':
      return { ConsensusAddressOwner: { start_version: String(owner.version ?? ''), owner: owner.address ?? '' } };
    default:
      return undefined;
  }
}

const OBJECT_WRITE = 'OUTPUT_OBJECT_STATE_OBJECT_WRITE';
const PACKAGE_WRITE = 'OUTPUT_OBJECT_STATE_PACKAGE_WRITE';
const DOES_NOT_EXIST = 'OUTPUT_OBJECT_STATE_DOES_NOT_EXIST';
const INPUT_EXISTS = 'INPUT_OBJECT_STATE_EXISTS';

/**
 * Object changes as the JSON-RPC fullnode reported them: created, mutated, deleted, wrapped,
 * published. Like JSON-RPC, unwrapped objects and accumulator writes are not listed.
 */
export function toObjectChanges(changed: ProtoChangedObject[], sender: string | undefined): ObjectChange[] {
  const changes: ObjectChange[] = [];
  for (const object of changed) {
    const base = { sender, objectId: object.objectId, objectType: object.objectType ? shortTypes(object.objectType) : undefined };
    const existed = object.inputState === INPUT_EXISTS;
    if (object.idOperation === 'CREATED') {
      if (object.outputState === PACKAGE_WRITE) changes.push({ type: 'published', packageId: object.objectId });
      else if (object.outputState === OBJECT_WRITE) changes.push({ type: 'created', ...base, owner: toOwner(object.outputOwner) });
    } else if (object.idOperation === 'DELETED') {
      changes.push({ type: 'deleted', ...base });
    } else if (existed && object.outputState === OBJECT_WRITE) {
      changes.push({ type: 'mutated', ...base, owner: toOwner(object.outputOwner) });
    } else if (existed && object.outputState === DOES_NOT_EXIST) {
      changes.push({ type: 'wrapped', ...base });
    }
  }
  return changes;
}

// ---- Coins, simulation ----

export interface GqlCoinMetadata {
  decimals?: number | null;
  symbol?: string | null;
  name?: string | null;
}

export function toCoinMetadata(metadata: GqlCoinMetadata | null): CoinMetadata | null {
  if (!metadata || metadata.decimals === null || metadata.decimals === undefined) return null;
  return { decimals: metadata.decimals, symbol: metadata.symbol ?? '', name: metadata.name ?? '' };
}

export interface GqlCoin {
  address: string;
  version: number;
  digest: string;
  contents?: { json?: { balance?: string } } | null;
}

export function toCoinObject(coinType: string): (coin: GqlCoin) => CoinObject {
  return (coin) => ({
    coinType,
    coinObjectId: coin.address,
    version: String(coin.version),
    digest: coin.digest,
    balance: coin.contents?.json?.balance ?? '0',
  });
}

export interface GqlSimulation {
  effects?: {
    status?: 'SUCCESS' | 'FAILURE' | null;
    executionError?: { message: string } | null;
    balanceChanges?: { nodes: Array<{ owner?: { address: string } | null; coinType?: { repr: string } | null; amount: string }> } | null;
  } | null;
}

export function toDryRun(result: GqlSimulation): DryRunResponse {
  const effects = result.effects;
  const status = effects?.status === 'SUCCESS' ? 'success' : 'failure';
  return {
    effects: { status: status === 'success' ? { status } : { status, error: effects?.executionError?.message ?? 'unknown error' } },
    balanceChanges: (effects?.balanceChanges?.nodes ?? []).map((change) => ({
      owner: { AddressOwner: change.owner?.address ?? '' },
      coinType: shortTypes(change.coinType?.repr ?? ''),
      amount: change.amount,
    })),
  };
}

// ---- Helpers ----

/**
 * Type strings as JSON-RPC printed them: leading zeros stripped from every address
 * (`0x2::sui::SUI`) and type parameters separated by `, `.
 */
export function shortTypes(type: string): string {
  return type.replace(/0x0*([0-9a-fA-F]+)/g, (_, hex: string) => `0x${hex.toLowerCase()}`).replace(/,\s*/g, ', ');
}

function pascalCase(name: string): string {
  if (!/^[A-Z0-9_]+$/.test(name)) return name.charAt(0).toUpperCase() + name.slice(1);
  return name
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
