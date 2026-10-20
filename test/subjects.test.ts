import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemWalMock } from '@mysten-incubation/memwal';
import { ShadowMemory } from '../src/memory.ts';
import {
  ENV_SUBJECT,
  listSubjects,
  maskAddress,
  maskNamespace,
  maskRecipients,
  namespaceFor,
  normaliseAddress,
  resolveSubject,
  shortAddress,
  subjectPaths,
  withSubject,
  type SubjectSources,
} from '../src/subjects.ts';
import { record } from './helpers.ts';

const ALICE = `0x${'a1'.repeat(32)}`;
const BOB = `0x${'b2'.repeat(32)}`;
const CAROL = `0x${'c3'.repeat(32)}`;

function sources(overrides: Partial<SubjectSources> = {}): SubjectSources {
  return {
    file: { default: 'alice', subjects: [{ name: 'alice', address: ALICE }, { name: 'bob', address: BOB }] },
    namespaceBase: 'shadowright-v1',
    ...overrides,
  };
}

describe('subject namespaces', () => {
  it('derives one namespace per wallet from the short address', () => {
    assert.equal(shortAddress(ALICE), '0xa1a1a1a1');
    assert.equal(namespaceFor('shadowright-v1', ALICE), 'shadowright-v1:0xa1a1a1a1');
    assert.notEqual(namespaceFor('shadowright-v1', ALICE), namespaceFor('shadowright-v1', BOB));
  });

  it('treats short, padded and upper-case forms of an address as the same wallet', () => {
    assert.equal(normaliseAddress('0xABC'), `0x${'0'.repeat(61)}abc`);
    assert.equal(namespaceFor('ns', '0xABC'), namespaceFor('ns', `0x000${'0'.repeat(58)}abc`));
  });

  it('resolves subjects by name, by address and by default', () => {
    assert.equal(resolveSubject('bob', sources()).address, BOB);
    assert.equal(resolveSubject(BOB.toUpperCase().replace('0X', '0x'), sources()).name, 'bob');
    assert.equal(resolveSubject(undefined, sources()).name, 'alice');
  });

  it('accepts an ad-hoc address with its own derived namespace', () => {
    const subject = resolveSubject(CAROL, sources());
    assert.equal(subject.name, '0xc3c3c3c3');
    assert.equal(subject.namespace, 'shadowright-v1:0xc3c3c3c3');
  });

  it('keeps the milestone 1 environment wallet on its original namespace', () => {
    const subject = resolveSubject(ENV_SUBJECT, sources({ envWallet: CAROL }));
    assert.equal(subject.namespace, 'shadowright-v1');
    const pinned = resolveSubject(ENV_SUBJECT, sources({ envWallet: CAROL, envNamespace: 'custom' }));
    assert.equal(pinned.namespace, 'custom');
  });

  it('does not list the environment wallet twice when it is also a named subject', () => {
    const subjects = listSubjects(sources({ envWallet: ALICE }));
    assert.deepEqual(
      subjects.map((s) => s.name),
      ['alice', 'bob'],
    );
  });

  it('honours an explicit namespace in the subjects file', () => {
    const file = withSubject({ subjects: [] }, { name: 'legacy', address: ALICE, namespace: 'shadowright-v1' });
    assert.equal(resolveSubject('legacy', sources({ file })).namespace, 'shadowright-v1');
  });

  it('asks for a choice when several subjects exist and none is the default', () => {
    assert.throws(() => resolveSubject(undefined, sources({ file: { subjects: sources().file.subjects } })), /pick one with --wallet/);
    assert.throws(() => resolveSubject('nobody', sources()), /Unknown subject/);
  });

  it('validates names and addresses when adding subjects', () => {
    assert.throws(() => withSubject({ subjects: [] }, { name: 'bad name!', address: ALICE }), /Subject names/);
    assert.throws(() => withSubject({ subjects: [] }, { name: 'x', address: 'not-an-address' }), /Not a Sui address/);
    const replaced = withSubject(sources().file, { name: 'bob', address: CAROL });
    assert.equal(replaced.subjects.find((s) => s.name === 'bob')?.address, CAROL);
    assert.equal(replaced.subjects.length, 2);
  });

  it('keeps local files of each subject apart', () => {
    const alice = subjectPaths('data', resolveSubject('alice', sources()));
    const bob = subjectPaths('data', resolveSubject('bob', sources()));
    assert.notEqual(alice.journal, bob.journal);
    assert.match(alice.history, /subjects[/\\]alice[/\\]history\.json$/);
  });

  it('keeps memories of different subjects apart in Walrus Memory', async () => {
    const backend = MemWalMock.create();
    const alice = new ShadowMemory(backend, namespaceFor('shadowright-v1', ALICE));
    const bob = new ShadowMemory(backend, namespaceFor('shadowright-v1', BOB));
    await alice.remember(record({ digest: 'alice-tx' }));
    await bob.remember(record({ digest: 'bob-tx' }));
    assert.deepEqual(
      (await alice.recallAll()).map((r) => r.digest),
      ['alice-tx'],
    );
    assert.deepEqual(
      (await bob.recallAll()).map((r) => r.digest),
      ['bob-tx'],
    );
  });
});

describe('address masking', () => {
  it('keeps only the first 4 hex digits of the subject and its namespace', () => {
    assert.equal(maskAddress(ALICE), '0xa1a1');
    assert.equal(maskNamespace(namespaceFor('shadowright-v1', ALICE)), 'shadowright-v1:0xa1a1…');
    assert.equal(maskNamespace('shadowright-v1'), 'shadowright-v1');
  });

  it('masks transfer recipients but leaves packages and coins alone', () => {
    assert.equal(maskRecipients('send 1-10 SUI to 0x12ab…cd34'), 'send 1-10 SUI to 0x12ab…');
    assert.equal(maskRecipients('stake 1-10 vSUI via 0x68d2…ae20::stake_pool'), 'stake 1-10 vSUI via 0x68d2…ae20::stake_pool');
    assert.equal(
      maskRecipients('after send SUI to 0x12ab…cd34, I expected send SUI to 0x99ff…0011'),
      'after send SUI to 0x12ab…, I expected send SUI to 0x99ff…',
    );
  });
});
