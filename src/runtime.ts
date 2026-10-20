import { join } from 'node:path';
import { MemWal } from '@mysten-incubation/memwal';
import { required, type Config } from './config.ts';
import { readJson, writeJson } from './files.ts';
import { ShadowMemory, type ShadowMemoryOptions } from './memory.ts';
import {
  readSubjectsFile,
  resolveSubject,
  subjectPaths,
  type Subject,
  type SubjectPaths,
  type SubjectSources,
} from './subjects.ts';
import { CREDITS_PER_CALL, TatumSuiClient } from './tatum.ts';

/** Wiring shared by the CLI and the web server: local paths, subjects and network clients. */

export interface SharedPaths {
  cache: string;
  usage: string;
  subjects: string;
  /** Latest scouting result, with full addresses (git-ignored like the rest of `data/`). */
  scout: string;
}

export function sharedPaths(config: Config): SharedPaths {
  return {
    cache: join(config.dataDir, 'cache'),
    usage: join(config.dataDir, 'tatum-usage.json'),
    subjects: join(config.dataDir, 'subjects.json'),
    scout: join(config.dataDir, 'scout.json'),
  };
}

export async function subjectSources(config: Config): Promise<SubjectSources> {
  return {
    file: await readSubjectsFile(sharedPaths(config).subjects),
    envWallet: config.wallet,
    envNamespace: config.walletNamespace,
    namespaceBase: config.namespaceBase,
  };
}

export async function pickSubject(config: Config, selector: string | undefined): Promise<{ subject: Subject; paths: SubjectPaths }> {
  const subject = resolveSubject(selector, await subjectSources(config));
  return { subject, paths: subjectPaths(config.dataDir, subject) };
}

/** Calls already added to the running total, per client created by this process. */
const recordedCalls = new Map<TatumSuiClient, number>();

export function tatumClient(config: Config): TatumSuiClient {
  const client = new TatumSuiClient({
    url: config.tatumRpcUrl,
    apiKey: required(config.tatumApiKey, 'TATUM_API_KEY'),
    cacheDir: sharedPaths(config).cache,
  });
  recordedCalls.set(client, 0);
  return client;
}

/** A fresh Walrus Memory client: nothing is shared between instances but the namespace on Walrus. */
export function walrusMemory(config: Config, namespace: string, options: ShadowMemoryOptions = {}): ShadowMemory {
  const client = MemWal.create({
    key: required(config.memwalKey, 'MEMWAL_PRIVATE_KEY'),
    accountId: required(config.memwalAccountId, 'MEMWAL_ACCOUNT_ID'),
    serverUrl: config.memwalServerUrl,
    namespace,
  });
  return new ShadowMemory(client, namespace, options);
}

/** For long CLI runs (replay, watch): wait out relayer rate limits instead of stopping. */
export const PATIENT: ShadowMemoryOptions = {
  rateLimitRetries: 3,
  onRateLimit: (waitMs) => console.log(`   Walrus Memory rate limit reached: waiting ${Math.round(waitMs / 1000)}s before retrying.`),
};

/**
 * Adds the not yet recorded calls of every Tatum client of this process to the running total
 * kept in `data/`, and returns a summary line (undefined when no client was used). Safe to
 * call more than once, e.g. at the end of a command and again from a signal handler.
 */
export async function flushUsage(config: Config): Promise<string | undefined> {
  if (recordedCalls.size === 0) return undefined;
  let calls = 0;
  let cacheHits = 0;
  let retries = 0;
  let unrecorded = 0;
  for (const [client, recorded] of recordedCalls) {
    calls += client.stats.networkCalls;
    cacheHits += client.stats.cacheHits;
    retries += client.stats.retries;
    unrecorded += client.stats.networkCalls - recorded;
    recordedCalls.set(client, client.stats.networkCalls);
  }
  const path = sharedPaths(config).usage;
  const previous = (await readJson<{ networkCalls: number }>(path)) ?? { networkCalls: 0 };
  const total = previous.networkCalls + unrecorded;
  await writeJson(path, { networkCalls: total, credits: total * CREDITS_PER_CALL });
  return (
    `Tatum: ${calls} network calls (~${calls * CREDITS_PER_CALL} credits), ` +
    `${cacheHits} cache hits, ${retries} retries. All runs: ~${total * CREDITS_PER_CALL} credits.`
  );
}
