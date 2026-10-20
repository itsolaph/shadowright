import { join } from 'node:path';
import { readJson, writeJson } from './files.ts';

/** A wallet the agent learns from. Each subject has its own memories and local files. */
export interface Subject {
  /** Label used on the command line, in the UI and as the local data folder name. */
  name: string;
  address: string;
  /** Walrus Memory namespace, so memories of different subjects never mix. */
  namespace: string;
}

/** On-disk shape of `data/subjects.json` (git-ignored: it holds wallet addresses). */
export interface SubjectsFile {
  default?: string;
  subjects: Array<{ name: string; address: string; namespace?: string }>;
}

export interface SubjectSources {
  file: SubjectsFile;
  /** `SHADOWRIGHT_WALLET`, the single subject of milestone 1. */
  envWallet?: string;
  /** `SHADOWRIGHT_NAMESPACE`, overrides the namespace of the environment wallet. */
  envNamespace?: string;
  namespaceBase: string;
}

/** Name of the subject given by `SHADOWRIGHT_WALLET`. */
export const ENV_SUBJECT = 'wallet';
const ADDRESS = /^0x[0-9a-f]{1,64}$/i;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export function isAddress(value: string): boolean {
  return ADDRESS.test(value);
}

/** Canonical 64-hex lower-case form, so `0x0abc` and `0xABC` are the same subject. */
export function normaliseAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

/** First 8 hex digits: short enough for labels, long enough to keep namespaces apart. */
export function shortAddress(address: string): string {
  return normaliseAddress(address).slice(0, 10);
}

/**
 * Display forms for screenshots and recordings of someone else's wallet
 * (`SHADOWRIGHT_MASK_ADDRESSES=1`): only the first 4 hex digits of an address stay visible.
 */
export function maskAddress(address: string): string {
  return normaliseAddress(address).slice(0, 6);
}

/** `shadowright-v1:0x12ab34cd` becomes `shadowright-v1:0x12ab…`. */
export function maskNamespace(namespace: string): string {
  return namespace.replace(/:(0x[0-9a-f]{4})[0-9a-f]+$/i, ':$1…');
}

/** Drops the tail of shortened recipients ("to 0x12ab…cd34" becomes "to 0x12ab…"); packages (`::`) stay. */
export function maskRecipients(text: string): string {
  return text.replace(/\bto (0x[0-9a-f]{4})…[0-9a-f]{4}(?!::)/gi, 'to $1…');
}

export function namespaceFor(namespaceBase: string, address: string): string {
  return `${namespaceBase}:${shortAddress(address)}`;
}

export function listSubjects(sources: SubjectSources): Subject[] {
  const subjects = sources.file.subjects.map((entry) => ({
    name: entry.name,
    address: normaliseAddress(entry.address),
    namespace: entry.namespace ?? namespaceFor(sources.namespaceBase, entry.address),
  }));
  const env = sources.envWallet;
  if (env && !subjects.some((s) => s.address === normaliseAddress(env))) {
    // Milestone 1 stored this wallet's memories under the bare base namespace; keep reading them.
    subjects.push({ name: ENV_SUBJECT, address: normaliseAddress(env), namespace: sources.envNamespace ?? sources.namespaceBase });
  }
  return subjects;
}

/**
 * Picks the subject for a command: by name, by address (known or ad hoc), or, without a
 * selector, the configured default, else the only subject there is.
 */
export function resolveSubject(selector: string | undefined, sources: SubjectSources): Subject {
  const subjects = listSubjects(sources);
  if (selector === undefined) {
    const fallback = sources.file.default ?? (subjects.length === 1 ? subjects[0]?.name : undefined);
    const found = subjects.find((s) => s.name === fallback);
    if (found) return found;
    throw new Error(
      subjects.length === 0
        ? 'No subject configured. Pass --wallet <address>, add one with `subjects add`, or set SHADOWRIGHT_WALLET.'
        : `Several subjects configured; pick one with --wallet <name>: ${subjects.map((s) => s.name).join(', ')}`,
    );
  }

  const byName = subjects.find((s) => s.name === selector);
  if (byName) return byName;
  if (!isAddress(selector)) throw new Error(`Unknown subject "${selector}". Known: ${subjects.map((s) => s.name).join(', ') || 'none'}`);
  const address = normaliseAddress(selector);
  return (
    subjects.find((s) => s.address === address) ?? {
      name: shortAddress(address),
      address,
      namespace: namespaceFor(sources.namespaceBase, address),
    }
  );
}

/** Adds or replaces a subject entry by name. Pure: returns the new file contents. */
export function withSubject(file: SubjectsFile, entry: { name: string; address: string; namespace?: string }): SubjectsFile {
  if (!NAME.test(entry.name)) throw new Error(`Subject names use letters, digits, - and _ (max 32): "${entry.name}"`);
  if (!isAddress(entry.address)) throw new Error('Not a Sui address.');
  const subjects = file.subjects.filter((s) => s.name !== entry.name);
  subjects.push({ ...entry, address: normaliseAddress(entry.address) });
  return { ...file, subjects };
}

export async function readSubjectsFile(path: string): Promise<SubjectsFile> {
  return (await readJson<SubjectsFile>(path)) ?? { subjects: [] };
}

export function writeSubjectsFile(path: string, file: SubjectsFile): Promise<void> {
  return writeJson(path, file);
}

/** Local files of one subject. Everything here can be rebuilt from Tatum and Walrus Memory. */
export interface SubjectPaths {
  dir: string;
  history: string;
  transactions: string;
  journal: string;
  watch: string;
}

export function subjectPaths(dataDir: string, subject: Subject): SubjectPaths {
  const dir = join(dataDir, 'subjects', subject.name);
  return {
    dir,
    history: join(dir, 'history.json'),
    transactions: join(dir, 'transactions.json'),
    journal: join(dir, 'journal.json'),
    watch: join(dir, 'watch.json'),
  };
}
