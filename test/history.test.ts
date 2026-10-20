import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { actionOf, amountBucket, compareActions, describeAction, timeContext } from '../src/action.ts';
import { fallbackCoinInfo, toDecision } from '../src/history.ts';
import { action, fixture } from './helpers.ts';

const B = `0x${'b'.repeat(64)}`;
const USDC = `0x${'1'.repeat(64)}::usdc::USDC`;
const coins = (coinType: string) =>
  coinType === USDC ? { symbol: 'USDC', decimals: 6 } : coinType === '0x2::sui::SUI' ? { symbol: 'SUI', decimals: 9 } : fallbackCoinInfo(coinType);

describe('toDecision', () => {
  it('normalises an outgoing transfer', () => {
    const { tx, wallet } = fixture('synthetic-transfer-sui');
    const d = toDecision(tx, wallet, coins);
    assert.equal(d.initiatedByUser, true);
    assert.equal(d.category, 'transfer');
    assert.equal(d.counterparties[0], B);
    assert.deepEqual(d.coinsOut, [{ coinType: '0x2::sui::SUI', symbol: 'SUI', raw: '1000000000', amount: 1 }]);
    assert.deepEqual(d.coinsIn, []);
    assert.equal(d.gasMist, '1747880');
    assert.equal(d.timestampMs, 1760950800000);
  });

  it('marks incoming transfers as not initiated by the user', () => {
    const { tx, wallet } = fixture('synthetic-incoming-transfer');
    const d = toDecision(tx, wallet, coins);
    assert.equal(d.initiatedByUser, false);
    assert.equal(d.counterparties[0], B);
    assert.equal(d.coinsIn[0]?.amount, 2);
  });

  it('records both legs of a swap with decimals applied', () => {
    const { tx, wallet } = fixture('synthetic-swap');
    const d = toDecision(tx, wallet, coins);
    assert.equal(d.coinsOut[0]?.amount, 5);
    assert.equal(d.coinsIn[0]?.symbol, 'USDC');
    assert.equal(d.coinsIn[0]?.amount, 17);
    assert.deepEqual(d.modules, [`0x${'d'.repeat(64)}::router`]);
  });
});

describe('actionOf', () => {
  it('uses the recipient as target for transfers', () => {
    const { tx, wallet } = fixture('synthetic-transfer-sui');
    assert.deepEqual(actionOf(toDecision(tx, wallet, coins)), { category: 'transfer', target: B, coin: 'SUI', amountBucket: '1-10' });
  });

  it('uses the venue module and the coin pair for swaps', () => {
    const { tx, wallet } = fixture('synthetic-swap');
    assert.deepEqual(actionOf(toDecision(tx, wallet, coins)), {
      category: 'swap',
      target: `0x${'d'.repeat(64)}::router`,
      coin: 'SUI>USDC',
      amountBucket: '1-10',
    });
  });

  it('uses the system staking module as the venue for stakes', () => {
    const { tx, wallet } = fixture('synthetic-stake');
    assert.equal(actionOf(toDecision(tx, wallet, coins)).target, '0x3::sui_system');
  });
});

describe('action helpers', () => {
  it('buckets amounts by order of magnitude', () => {
    assert.equal(amountBucket(undefined), '-');
    assert.equal(amountBucket(0.05), '<0.1');
    assert.equal(amountBucket(1), '1-10');
    assert.equal(amountBucket(99.9), '10-100');
    assert.equal(amountBucket(25_000), '1k+');
  });

  it('requires category, target and coin to match, but not amount', () => {
    assert.deepEqual(compareActions(action(), action({ amountBucket: '100-1k' })), { correct: true, misses: [] });
    assert.deepEqual(compareActions(action(), action({ target: '0xother::pool', coin: 'SUI>USDT' })), {
      correct: false,
      misses: ['target', 'coin'],
    });
  });

  it('describes actions for humans with shortened ids', () => {
    assert.equal(describeAction(action({ target: `0x${'d'.repeat(64)}::router` })), 'swap 1-10 SUI>USDC via 0xdddd…dddd::router');
  });

  it('derives UTC weekday and daypart', () => {
    assert.deepEqual(timeContext(Date.UTC(2026, 9, 19, 14, 5)), { weekday: 'Mon', daypart: 'afternoon', iso: '2026-10-19 14:05' });
  });
});
