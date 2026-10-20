import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diversityScore, missingGroups, profileWallet, rejectReason, scriptedLoop } from '../src/scout.ts';
import type { Category, Decision } from '../src/types.ts';
import { DAY, decision, MON_AFTERNOON } from './helpers.ts';

const MINUTE = 60 * 1000;

/** One own decision of `category` through `pkg` at `timestampMs`. */
function tx(category: Category, timestampMs: number, pkg = `0x${category}`): Decision {
  return decision({
    digest: `${category}-${timestampMs}`,
    timestampMs,
    category,
    packages: category === 'transfer' ? [] : [pkg],
    calls: category === 'transfer' ? [] : [`${pkg}::m::f`],
  });
}

/** A person: a mix of categories spread over `days`, a few a day. */
function person(days = 40): Decision[] {
  const pattern: Category[] = ['swap', 'swap', 'transfer', 'stake', 'claim', 'swap', 'defi', 'transfer', 'swap', 'claim', 'stake'];
  return Array.from({ length: days }, (_, i) => tx(pattern[(i * 7) % pattern.length]!, MON_AFTERNOON + i * DAY + (i % 5) * 3600_000));
}

describe('scout filters', () => {
  it('accepts a diverse person with a history of several weeks', () => {
    const profile = profileWallet('0xperson', person());
    assert.equal(rejectReason(profile), undefined);
    assert.ok(profile.spanDays >= 21);
    assert.deepEqual(missingGroups(profile), []);
  });

  it('rejects bursts of thousands of transactions a day as a bot', () => {
    const burst = Array.from({ length: 50 }, (_, i) => tx(i % 2 ? 'swap' : 'other', MON_AFTERNOON + i * 1000));
    const reason = rejectReason(profileWallet('0xbot', burst));
    assert.match(reason ?? '', /^bot: bursts/);
  });

  it('rejects a wallet that goes through one package almost every time', () => {
    const single = Array.from({ length: 40 }, (_, i) => tx(i % 4 === 0 ? 'claim' : 'defi', MON_AFTERNOON + i * DAY, '0xperps'));
    assert.match(rejectReason(profileWallet('0xperps-bot', single)) ?? '', /one package/);
  });

  it('rejects a scripted claim-swap-stake loop even though it covers several categories', () => {
    const loop: Category[] = ['claim', 'swap', 'stake'];
    const compounder = Array.from({ length: 60 }, (_, i) => tx(loop[i % 3]!, MON_AFTERNOON + i * 8 * 3600_000));
    assert.equal(scriptedLoop(compounder.map((d) => d.category)), 3);
    assert.match(rejectReason(profileWallet('0xcompounder', compounder)) ?? '', /scripted 3-step loop/);
  });

  it('does not mistake a person repeating the same action for a scripted loop', () => {
    const repeats: Category[] = [...Array<Category>(20).fill('swap'), ...Array<Category>(20).fill('stake')];
    assert.equal(scriptedLoop(repeats), undefined);
  });

  it('names the missing categories of a one-trick wallet', () => {
    const swapsOnly = Array.from({ length: 30 }, (_, i) => tx('swap', MON_AFTERNOON + i * DAY, `0xdex${i % 3}`));
    assert.match(rejectReason(profileWallet('0xswapper', swapsOnly)) ?? '', /not diverse: no transfer, stake, claim\/defi/);
  });

  it('rejects a diverse but too recent history', () => {
    const recent = person(40).map((d, i) => ({ ...d, timestampMs: MON_AFTERNOON + i * 10 * MINUTE }));
    assert.match(rejectReason(profileWallet('0xnew', recent)) ?? '', /short history/);
  });

  it('ignores incoming transactions when profiling', () => {
    const incoming = person().map((d) => ({ ...d, initiatedByUser: false }));
    assert.equal(rejectReason(profileWallet('0xreceiver', incoming)), 'no own transactions');
  });

  it('scores several well-populated categories above one huge category', () => {
    const balanced = profileWallet('0xbalanced', person(60));
    const lopsided = profileWallet('0xlopsided', [
      ...Array.from({ length: 200 }, (_, i) => tx('swap', MON_AFTERNOON + i * DAY, `0xdex${i % 5}`)),
      tx('stake', MON_AFTERNOON),
    ]);
    assert.ok(diversityScore(balanced) > diversityScore(lopsided));
  });
});
