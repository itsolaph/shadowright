import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { classify, extractFeatures, gasFee } from '../src/classify.ts';
import { stakeValidatorOf } from '../src/dryrun.ts';
import {
  eventFilter,
  pageVariables,
  shortTypes,
  toDryRun,
  toObjectChanges,
  toPage,
  toTransactionBlock,
  transactionFilter,
  type GqlTransaction,
} from '../src/graphql.ts';
import { toDecision } from '../src/history.ts';
import { fixture } from './helpers.ts';

const { node, wallet } = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'graphql', 'stake.json'), 'utf8')) as {
  node: GqlTransaction;
  wallet: string;
};

describe('GraphQL to JSON-RPC mapping', () => {
  const tx = toTransactionBlock(node);

  it('reads the same features and decision as the JSON-RPC version of the transaction', () => {
    const rpc = fixture('synthetic-stake');
    assert.deepEqual(extractFeatures(tx, wallet), extractFeatures(rpc.tx, rpc.wallet));
    assert.deepEqual(classify(tx, wallet), classify(rpc.tx, rpc.wallet));
    const { digest, timestampMs, ...decision } = toDecision(tx, wallet);
    const { digest: rpcDigest, timestampMs: rpcTimestamp, ...rpcDecision } = toDecision(rpc.tx, rpc.wallet);
    assert.deepEqual(decision, rpcDecision);
    assert.equal(digest, rpcDigest);
    assert.equal(timestampMs, Date.UTC(2025, 9, 21, 10));
  });

  it('maps transaction data, effects, events and balance changes', () => {
    assert.equal(tx.checkpoint, '200000000');
    assert.equal(tx.transaction?.data.sender, wallet);
    assert.equal(tx.transaction?.data.gasData?.owner, wallet);
    assert.equal(tx.transaction?.data.transaction.kind, 'ProgrammableTransaction');
    assert.deepEqual(tx.transaction?.data.transaction.transactions?.[0], { SplitCoins: ['GasCoin', [{ Input: 1 }]] });
    assert.deepEqual(tx.transaction?.data.transaction.transactions?.[1], {
      MoveCall: {
        package: '0x0000000000000000000000000000000000000000000000000000000000000003',
        module: 'sui_system',
        function: 'request_add_stake',
        arguments: [{ Input: 0 }, { NestedResult: [0, 0] }, { Input: 2 }],
      },
    });
    assert.deepEqual(tx.effects?.status, { status: 'success' });
    assert.equal(gasFee(tx), 3_000_000n);
    assert.deepEqual(tx.events?.[0], {
      type: '0x3::validator::StakingRequestEvent',
      sender: wallet,
      packageId: '0x0000000000000000000000000000000000000000000000000000000000000003',
      transactionModule: 'sui_system',
      parsedJson: { amount: '1000000000', validator_address: `0x${'9'.repeat(64)}` },
    });
    assert.deepEqual(tx.balanceChanges, [{ owner: { AddressOwner: wallet }, coinType: '0x2::sui::SUI', amount: '-1003000000' }]);
  });

  it('types pure inputs from the typed inputs, so the stake validator is found', () => {
    const inputs = tx.transaction?.data.transaction.inputs;
    assert.deepEqual(inputs?.[0], {
      type: 'object',
      objectType: 'sharedObject',
      objectId: '0x0000000000000000000000000000000000000000000000000000000000000005',
      initialSharedVersion: '1',
      mutable: true,
    });
    assert.deepEqual(inputs?.[1], { type: 'pure', valueType: 'u64', value: '1000000000' });
    assert.equal(stakeValidatorOf(tx), `0x${'9'.repeat(64)}`);
  });

  it('reports failures with the execution error', () => {
    const failed = toTransactionBlock({ ...node, effects: { ...node.effects, status: 'FAILURE', executionError: { message: 'MoveAbort in command 1' } } });
    assert.deepEqual(failed.effects?.status, { status: 'failure', error: 'MoveAbort in command 1' });
    assert.equal(toDecision(failed, wallet).success, false);
  });

  it('keeps only the digest when transaction details were not selected', () => {
    assert.deepEqual(toTransactionBlock({ digest: 'abc' }), { digest: 'abc' });
  });

  it('lists object changes like JSON-RPC did', () => {
    const owner = { kind: 'ADDRESS', address: '0xbb' };
    const changes = toObjectChanges(
      [
        { objectId: '0x1', inputState: 'INPUT_OBJECT_STATE_EXISTS', inputOwner: owner, outputState: 'OUTPUT_OBJECT_STATE_OBJECT_WRITE', outputOwner: owner, idOperation: 'NONE', objectType: '0x00002::coin::Coin<0x0002::sui::SUI>' },
        { objectId: '0x2', inputState: 'INPUT_OBJECT_STATE_EXISTS', outputState: 'OUTPUT_OBJECT_STATE_DOES_NOT_EXIST', idOperation: 'DELETED', objectType: '0xc::nft::Nft' },
        { objectId: '0x3', inputState: 'INPUT_OBJECT_STATE_EXISTS', outputState: 'OUTPUT_OBJECT_STATE_DOES_NOT_EXIST', idOperation: 'NONE', objectType: '0xc::nft::Nft' },
        { objectId: '0x4', inputState: 'INPUT_OBJECT_STATE_DOES_NOT_EXIST', outputState: 'OUTPUT_OBJECT_STATE_PACKAGE_WRITE', idOperation: 'CREATED' },
        { objectId: '0x5', inputState: 'INPUT_OBJECT_STATE_DOES_NOT_EXIST', outputState: 'OUTPUT_OBJECT_STATE_OBJECT_WRITE', outputOwner: owner, idOperation: 'NONE', objectType: '0xc::nft::Nft' },
      ],
      '0xaa',
    );
    assert.deepEqual(
      changes.map((c) => [c.type, c.objectId ?? c.packageId]),
      [['mutated', '0x1'], ['deleted', '0x2'], ['wrapped', '0x3'], ['published', '0x4']],
    );
    assert.equal(changes[0]?.objectType, '0x2::coin::Coin<0x2::sui::SUI>');
    assert.deepEqual(changes[0]?.owner, { AddressOwner: '0xbb' });
  });

  it('prints type strings the JSON-RPC way', () => {
    assert.equal(shortTypes(`0x${'0'.repeat(63)}2::sui::SUI`), '0x2::sui::SUI');
    assert.equal(shortTypes('0x2::dynamic_field::Field<u64,0x03::a::B>'), '0x2::dynamic_field::Field<u64, 0x3::a::B>');
    assert.equal(shortTypes(`0x${'0'.repeat(64)}::m::T`), '0x0::m::T');
  });

  it('maps simulation results to dry-run responses', () => {
    const ok = toDryRun({
      effects: { status: 'SUCCESS', balanceChanges: { nodes: [{ owner: { address: '0xaa' }, coinType: { repr: `0x${'0'.repeat(63)}2::sui::SUI` }, amount: '-5' }] } },
    });
    assert.deepEqual(ok, { effects: { status: { status: 'success' } }, balanceChanges: [{ owner: { AddressOwner: '0xaa' }, coinType: '0x2::sui::SUI', amount: '-5' }] });
    const failed = toDryRun({ effects: { status: 'FAILURE', executionError: { message: 'InsufficientGas' } } });
    assert.deepEqual(failed.effects?.status, { status: 'failure', error: 'InsufficientGas' });
  });
});

describe('GraphQL filters and pages', () => {
  it('translates JSON-RPC filters', () => {
    assert.deepEqual(transactionFilter({ FromAddress: '0xaa' }), { sentAddress: '0xaa' });
    assert.deepEqual(transactionFilter({ ToAddress: '0xaa' }), { affectedAddress: '0xaa' });
    assert.deepEqual(eventFilter({ MoveEventType: '0x3::validator::StakingRequestEvent' }), { type: '0x3::validator::StakingRequestEvent' });
    assert.deepEqual(eventFilter({ MoveModule: { package: '0x3', module: 'validator' } }), { module: '0x3::validator' });
  });

  it('pages forward with first/after and backward with last/before, capped at 50', () => {
    assert.deepEqual(pageVariables(null, 50, false), { first: 50 });
    assert.deepEqual(pageVariables('c1', 80, false), { first: 50, after: 'c1' });
    assert.deepEqual(pageVariables('c1', 1, true), { last: 1, before: 'c1' });
  });

  it('turns connections into JSON-RPC pages, newest first when descending', () => {
    const connection = {
      pageInfo: { hasNextPage: false, hasPreviousPage: true, startCursor: 'start', endCursor: 'end' },
      nodes: [{ digest: 'old' }, { digest: 'new' }],
    };
    const forward = toPage(connection, false, (n) => n.digest);
    assert.deepEqual(forward, { data: ['old', 'new'], nextCursor: 'end', hasNextPage: false });
    const backward = toPage(connection, true, (n) => n.digest);
    assert.deepEqual(backward, { data: ['new', 'old'], nextCursor: 'start', hasNextPage: true });
    const empty = toPage({ ...connection, pageInfo: { ...connection.pageInfo, startCursor: null } }, true, (n) => n);
    assert.equal(empty.hasNextPage, false);
  });
});
