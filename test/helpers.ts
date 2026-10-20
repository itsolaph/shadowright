import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryRecord } from '../src/memory.ts';
import type { SuiTransactionBlock } from '../src/sui.ts';
import type { Action, Category, Decision } from '../src/types.ts';

export interface Fixture {
  file: string;
  source: 'synthetic' | 'mainnet';
  expectedCategory: Category;
  wallet: string;
  tx: SuiTransactionBlock;
}

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures');

export function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file, ...JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) }) as Fixture);
}

export function fixture(name: string): Fixture {
  const found = loadFixtures().find((f) => f.file === `${name}.json`);
  if (!found) throw new Error(`missing fixture ${name}`);
  return found;
}

export const MON_AFTERNOON = Date.UTC(2026, 9, 19, 14, 0);
export const DAY = 24 * 60 * 60 * 1000;

export function action(overrides: Partial<Action> = {}): Action {
  return { category: 'swap', target: '0xdex::router', coin: 'SUI>USDC', amountBucket: '1-10', ...overrides };
}

export function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const predicted = overrides.predicted ?? action();
  const actual = overrides.actual ?? predicted;
  return {
    digest: `tx${Math.random().toString(36).slice(2, 10)}`,
    timestampMs: MON_AFTERNOON,
    after: 'none',
    predicted,
    actual,
    correct: true,
    misses: [],
    predictor: 'test',
    ...overrides,
  };
}

export function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    digest: `tx${Math.random().toString(36).slice(2, 10)}`,
    timestampMs: MON_AFTERNOON,
    sender: '0xuser',
    initiatedByUser: true,
    success: true,
    category: 'swap',
    rule: 'test',
    counterparties: [],
    coinsOut: [{ coinType: '0x2::sui::SUI', symbol: 'SUI', raw: '5000000000', amount: 5 }],
    coinsIn: [{ coinType: '0xusdc::usdc::USDC', symbol: 'USDC', raw: '17000000', amount: 17 }],
    calls: ['0xdex::router::swap'],
    packages: ['0xdex'],
    modules: ['0xdex::router'],
    gasMist: '1000000',
    ...overrides,
  };
}
