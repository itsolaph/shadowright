import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classify, classifyFeatures, extractFeatures, normaliseCoinType, walletCoinDeltas } from '../src/classify.ts';
import { CATEGORIES } from '../src/types.ts';
import { fixture, loadFixtures } from './helpers.ts';

describe('classify', () => {
  for (const f of loadFixtures()) {
    it(`labels ${f.file} as ${f.expectedCategory}`, () => {
      assert.equal(classify(f.tx, f.wallet).category, f.expectedCategory);
    });
  }

  it('covers every category with at least one fixture', () => {
    const covered = new Set(loadFixtures().map((f) => f.expectedCategory));
    for (const category of CATEGORIES) assert.ok(covered.has(category), `no fixture for ${category}`);
  });

  it('explains which rule fired', () => {
    const { tx, wallet } = fixture('synthetic-stake');
    assert.match(classify(tx, wallet).rule, /^stake call: 0x3::sui_system::request_add_stake$/);
  });

  it('treats a coin-for-coin exchange through an unknown contract as a swap', () => {
    const result = classifyFeatures({
      calls: ['0x99::amm::execute'],
      commands: ['MoveCall'],
      eventTypes: [],
      coinTypesOut: ['0x2::sui::SUI'],
      coinTypesIn: ['0x11::usdc::USDC'],
      objectsOut: [],
      objectsIn: [],
    });
    assert.deepEqual(result, { category: 'swap', rule: 'coin exchange: SUI -> USDC' });
  });

  it('falls back to other for unrecognised calls', () => {
    const { tx, wallet } = fixture('synthetic-other');
    assert.equal(classifyFeatures(extractFeatures(tx, wallet)).rule, 'fallback: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff::game::play');
  });
});

describe('walletCoinDeltas', () => {
  it('adds the gas fee back so a transfer shows the amount actually sent', () => {
    const { tx, wallet } = fixture('synthetic-transfer-sui');
    assert.deepEqual([...walletCoinDeltas(tx, wallet)], [['0x2::sui::SUI', -1_000_000_000n]]);
  });

  it('drops coins whose only movement was gas', () => {
    const { tx, wallet } = fixture('synthetic-other');
    assert.equal(walletCoinDeltas(tx, wallet).size, 0);
  });

  it('does not add gas back when someone else paid it', () => {
    const { tx, wallet } = fixture('synthetic-incoming-transfer');
    assert.deepEqual([...walletCoinDeltas(tx, wallet)], [['0x2::sui::SUI', 2_000_000_000n]]);
  });
});

describe('normaliseCoinType', () => {
  it('shortens the package id of a coin type', () => {
    assert.equal(normaliseCoinType(`0x${'0'.repeat(63)}2::sui::SUI`), '0x2::sui::SUI');
  });
});
