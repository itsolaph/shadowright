import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actionOf } from '../src/action.ts';
import { dryRunAction, findTemplate, stakeValidatorOf } from '../src/dryrun.ts';
import { toDecision } from '../src/history.ts';
import { GRAPHQL_ERROR_CODE, RpcError, type TatumSuiClient } from '../src/tatum.ts';
import { decision, fixture } from './helpers.ts';

describe('dry-run helpers', () => {
  it('finds the validator of a past native stake', () => {
    const { tx } = fixture('synthetic-stake');
    assert.match(stakeValidatorOf(tx) ?? '', /^0x[0-9a-f]+$/);
    assert.equal(stakeValidatorOf(fixture('synthetic-swap').tx), undefined);
  });

  it('uses the most recent matching decision as the template', () => {
    const { tx, wallet } = fixture('synthetic-transfer-sui');
    const older = toDecision(tx, wallet);
    const newer = { ...older, digest: 'newer', timestampMs: older.timestampMs + 1 };
    const unrelated = decision({ digest: 'swap' });
    const txs = new Map([
      [older.digest, tx],
      ['newer', { ...tx, digest: 'newer' }],
      ['swap', tx],
    ]);
    const template = findTemplate(actionOf(older), [older, newer, unrelated], txs);
    assert.equal(template?.decision.digest, 'newer');
  });

  it('declines to simulate without a template or a builder, without calling the network', async () => {
    const offline = new Proxy({} as TatumSuiClient, {
      get: () => () => assert.fail('no network call expected'),
    });
    const swap = decision();
    const noTemplate = await dryRunAction(offline, '0xuser', actionOf(swap), undefined);
    assert.equal(noTemplate.status, 'unsupported');
    const noBuilder = await dryRunAction(offline, '0xuser', actionOf(swap), { decision: swap, tx: fixture('synthetic-swap').tx });
    assert.equal(noBuilder.status, 'unsupported');
    assert.match(noBuilder.detail, /no transaction builder for swap yet: the agent would ask the user to sign instead/);
    assert.match(noBuilder.summary, /^would have done: swap/);
  });

  it('simulates a transfer and reports a rejected simulation as a failed dry-run', async () => {
    const { tx, wallet } = fixture('synthetic-transfer-sui');
    const transfer = toDecision(tx, wallet);
    const coin = { coinType: '0x2::sui::SUI', coinObjectId: `0x${'c'.repeat(64)}`, version: '7', digest: '11111111111111111111111111111111', balance: '10' };
    const simulated: string[] = [];
    const client = {
      getCoins: async () => ({ data: [coin], nextCursor: null, hasNextPage: false }),
      getReferenceGasPrice: async () => '100',
      dryRunTransactionBlock: async (bytes: string) => {
        simulated.push(bytes);
        throw new RpcError('simulateTransaction: Balance of gas object 0 is lower than the needed amount', GRAPHQL_ERROR_CODE);
      },
    } as unknown as TatumSuiClient;
    const outcome = await dryRunAction(client, wallet, actionOf(transfer), { decision: transfer, tx });
    assert.equal(simulated.length, 1);
    assert.equal(outcome.status, 'failure');
    assert.match(outcome.detail, /^dry-run rejected: simulateTransaction: Balance of gas object 0/);
  });
});
