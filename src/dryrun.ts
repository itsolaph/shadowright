import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { actionKey, actionOf, describeAction } from './action.ts';
import {
  addressOwner,
  isMoveCall,
  sameAddress,
  SUI_COIN_TYPE,
  type BalanceChange,
  type CoinObject,
  type SuiTransactionBlock,
} from './sui.ts';
import type { TatumSuiClient } from './tatum.ts';
import type { Action, Decision } from './types.ts';

/**
 * What a licensed agent would have done, simulated with `sui_dryRunTransactionBlock`.
 * Nothing is signed and nothing is executed: dry-runs need no signature.
 */
export interface DryRunOutcome {
  status: 'success' | 'failure' | 'unsupported';
  /** "would have done: transfer 1.2 SUI to 0x12…" */
  summary: string;
  detail: string;
}

/** A past decision of the same kind, used to size the simulated one (amount, validator). */
export interface Template {
  decision: Decision;
  tx: SuiTransactionBlock;
}

const GAS_BUDGET = 50_000_000n;
const SYSTEM_STATE = { objectId: '0x5', initialSharedVersion: 1, mutable: true };

export async function dryRunAction(
  client: TatumSuiClient,
  sender: string,
  action: Action,
  template: Template | undefined,
): Promise<DryRunOutcome> {
  const summary = `would have done: ${describeAction(action)}`;
  if (!template) return { status: 'unsupported', summary, detail: 'no past example of this action to size it from' };

  const tx = new Transaction();
  const built = await composeAction(tx, client, sender, action, template);
  if (built !== true) return { status: 'unsupported', summary, detail: built };

  const gasCoins = await client.getCoins(sender, SUI_COIN_TYPE, 5);
  tx.setSender(sender);
  tx.setGasPrice(BigInt(await client.getReferenceGasPrice()));
  tx.setGasBudget(GAS_BUDGET);
  tx.setGasPayment(gasCoins.data.map(objectRefOf));

  const result = (await client.dryRunTransactionBlock(toBase64(await tx.build()))) as DryRunResponse;
  const status = result.effects?.status;
  if (status?.status !== 'success') {
    return { status: 'failure', summary, detail: `dry-run failed: ${status?.error ?? 'unknown error'}` };
  }
  return { status: 'success', summary, detail: `dry-run ok: ${balanceSummary(result.balanceChanges ?? [], sender)}` };
}

/** Adds the commands for `action` to `tx`. Returns true, or why this action cannot be built. */
async function composeAction(
  tx: Transaction,
  client: TatumSuiClient,
  sender: string,
  action: Action,
  template: Template,
): Promise<true | string> {
  const spent = template.decision.coinsOut[0];
  if (!spent) return 'the past example moved no coins';

  if (action.category === 'transfer') {
    const coin =
      spent.coinType === SUI_COIN_TYPE
        ? tx.splitCoins(tx.gas, [BigInt(spent.raw)])
        : await splitOwnedCoin(tx, client, sender, spent.coinType, BigInt(spent.raw));
    if (!coin) return `no ${spent.symbol} coins left to send`;
    tx.transferObjects([coin], action.target);
    return true;
  }

  if (action.category === 'stake' && spent.coinType === SUI_COIN_TYPE) {
    const validator = stakeValidatorOf(template.tx);
    if (!validator) return 'the past example was not a native stake';
    const coin = tx.splitCoins(tx.gas, [BigInt(spent.raw)]);
    tx.moveCall({
      target: '0x3::sui_system::request_add_stake',
      arguments: [tx.sharedObjectRef(SYSTEM_STATE), coin, tx.pure.address(validator)],
    });
    return true;
  }

  return `no transaction builder for ${action.category} yet: the agent would ask the user to sign instead`;
}

async function splitOwnedCoin(tx: Transaction, client: TatumSuiClient, owner: string, coinType: string, amount: bigint) {
  const coins = (await client.getCoins(owner, coinType, 20)).data;
  const [first, ...rest] = coins.map((coin) => tx.objectRef(objectRefOf(coin)));
  if (!first) return undefined;
  if (rest.length > 0) tx.mergeCoins(first, rest);
  return tx.splitCoins(first, [amount]);
}

/** The user's most recent decision matching the action (same kind, venue or recipient, coin). */
export function findTemplate(action: Action, decisions: Decision[], txs: Map<string, SuiTransactionBlock>): Template | undefined {
  const key = actionKey(action);
  for (const decision of [...decisions].reverse()) {
    const tx = txs.get(decision.digest);
    if (tx && decision.initiatedByUser && actionKey(actionOf(decision)) === key) return { decision, tx };
  }
  return undefined;
}

/** The validator address passed to `request_add_stake` in a past staking transaction. */
export function stakeValidatorOf(tx: SuiTransactionBlock): string | undefined {
  const kind = tx.transaction?.data.transaction;
  const call = kind?.transactions?.filter(isMoveCall).find((c) => c.MoveCall.function === 'request_add_stake');
  if (!call) return undefined;
  const input = kind?.inputs?.find((i) => i.type === 'pure' && i.valueType === 'address');
  return typeof input?.value === 'string' ? input.value : undefined;
}

function objectRefOf(coin: CoinObject) {
  return { objectId: coin.coinObjectId, version: coin.version, digest: coin.digest };
}

interface DryRunResponse {
  effects?: { status: { status: 'success' | 'failure'; error?: string } };
  balanceChanges?: BalanceChange[];
}

function balanceSummary(changes: BalanceChange[], owner: string): string {
  const own = changes.filter((c) => sameAddress(addressOwner(c.owner), owner));
  if (own.length === 0) return 'no balance change for the wallet';
  return own.map((c) => `${c.coinType.split('::').at(-1)} ${c.amount}`).join(', ');
}
