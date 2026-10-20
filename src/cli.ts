import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MemWal, MemWalMock } from '@mysten-incubation/memwal';
import { shortId } from './action.ts';
import { loadConfig, required, type Config } from './config.ts';
import { readJson, writeJson } from './files.ts';
import { backfill, type History } from './history.ts';
import { Journal } from './journal.ts';
import { computeBoard } from './licence.ts';
import { ShadowMemory } from './memory.ts';
import { createPredictor } from './predictor.ts';
import { replay } from './replay.ts';
import { renderBoard, renderCounts, renderEvent, renderStep } from './report.ts';
import type { SuiTransactionBlock } from './sui.ts';
import { CREDITS_PER_CALL, TatumSuiClient } from './tatum.ts';
import { CATEGORIES, type Category } from './types.ts';

const USAGE = `Shadowright: a learner's permit for your wallet agent.

Usage: npm run cli -- <command> [options]

Commands:
  backfill [--max-pages N]     Fetch and cache the wallet's Sui history via Tatum; print counts per category.
  replay [--limit N] [--write] Walk the history in order: recall, predict, compare, remember, update licences.
                               Without --write, memories stay in an in-process store (no network writes).
                               With --write, every episode is stored in Walrus Memory on mainnet.
  board                        Licence board computed from the memories stored in Walrus Memory.
  restore [--limit N]          Rebuild this instance's memory index from Walrus, then show the board.
  health [--tatum]             Check Walrus Memory (and optionally Tatum) connectivity and configuration.
  fixtures [--per N]           Export real classified transactions from the backfill as test fixtures.
`;

interface Paths {
  cache: string;
  history: string;
  transactions: string;
  usage: string;
  journal: string;
}

function pathsFor(config: Config): Paths {
  return {
    cache: join(config.dataDir, 'cache'),
    history: join(config.dataDir, 'history.json'),
    transactions: join(config.dataDir, 'transactions.json'),
    usage: join(config.dataDir, 'tatum-usage.json'),
    journal: join(config.dataDir, `journal-${config.namespace}.json`),
  };
}

function tatumClient(config: Config, paths: Paths): TatumSuiClient {
  return new TatumSuiClient({
    url: config.tatumRpcUrl,
    apiKey: required(config.tatumApiKey, 'TATUM_API_KEY'),
    cacheDir: paths.cache,
  });
}

function walrusMemory(config: Config): ShadowMemory {
  const client = MemWal.create({
    key: required(config.memwalKey, 'MEMWAL_PRIVATE_KEY'),
    accountId: required(config.memwalAccountId, 'MEMWAL_ACCOUNT_ID'),
    serverUrl: config.memwalServerUrl,
    namespace: config.namespace,
  });
  return new ShadowMemory(client, config.namespace);
}

/** Prints this run's Tatum usage and keeps a running total across runs. */
async function reportUsage(client: TatumSuiClient, paths: Paths): Promise<void> {
  const { networkCalls, cacheHits, retries } = client.stats;
  const previous = (await readJson<{ networkCalls: number }>(paths.usage)) ?? { networkCalls: 0 };
  const total = previous.networkCalls + networkCalls;
  await writeJson(paths.usage, { networkCalls: total, credits: total * CREDITS_PER_CALL });
  console.log(
    `\nTatum: ${networkCalls} network calls (~${networkCalls * CREDITS_PER_CALL} credits), ` +
      `${cacheHits} cache hits, ${retries} retries. All runs: ~${total * CREDITS_PER_CALL} credits.`,
  );
}

async function loadHistory(paths: Paths): Promise<History> {
  const history = await readJson<History>(paths.history);
  if (!history) throw new Error('No local history yet. Run `npm run cli -- backfill` first.');
  return history;
}

async function cmdBackfill(config: Config, paths: Paths, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { 'max-pages': { type: 'string', default: '20' } } });
  const wallet = required(config.wallet, 'SHADOWRIGHT_WALLET');
  const client = tatumClient(config, paths);
  console.log(`Backfilling ${shortId(wallet)} from Sui mainnet via Tatum...`);

  const { history, transactions } = await backfill(client, wallet, {
    maxPages: Number(values['max-pages']),
    onPage: (filter, page, size) => console.log(`  ${filter} page ${page}: ${size} transactions`),
  });
  await writeJson(paths.history, history);
  await writeJson(paths.transactions, transactions);

  const counts = new Map<Category, { own: number; incoming: number }>();
  for (const decision of history.decisions) {
    const entry = counts.get(decision.category) ?? { own: 0, incoming: 0 };
    if (decision.initiatedByUser) entry.own += 1;
    else entry.incoming += 1;
    counts.set(decision.category, entry);
  }
  const first = history.decisions[0];
  const last = history.decisions.at(-1);
  console.log(`\n${history.decisions.length} transactions` + (first && last ? ` from ${day(first.timestampMs)} to ${day(last.timestampMs)}` : ''));
  console.log(renderCounts(counts));
  await reportUsage(client, paths);
}

async function cmdReplay(config: Config, paths: Paths, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      limit: { type: 'string' },
      write: { type: 'boolean', default: false },
      recall: { type: 'string', default: '10' },
      predictor: { type: 'string', default: 'heuristic' },
    },
  });
  const history = await loadHistory(paths);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  const write = values.write ?? false;

  const memory = write
    ? walrusMemory(config)
    : new ShadowMemory(MemWalMock.create({ namespace: config.namespace }), config.namespace);
  const journal = write ? await Journal.open(paths.journal) : undefined;
  const existing = write ? await memory.recallAll() : [];
  const pending = history.decisions.filter((d) => d.initiatedByUser && d.success && !journal?.has(d.digest)).length;
  const total = Math.min(limit ?? pending, pending);

  console.log(
    write
      ? `Replay with Walrus Memory (namespace ${config.namespace}): ${existing.length} existing memories, ${total} decisions to shadow.`
      : `Dry replay with in-process memory (nothing leaves this machine): ${total} decisions to shadow.`,
  );
  console.log('');

  const result = await replay({
    decisions: history.decisions,
    memory,
    predictor: createPredictor(values.predictor),
    policy: config.licence,
    limit,
    skip: journal ? (decision) => journal.has(decision.digest) : undefined,
    existing,
    recallLimit: Number(values.recall),
    onStep: async (step) => {
      console.log(renderStep(step, total));
      if (journal) {
        await journal.add(step.decision.digest, step.stored);
        console.log(`   stored on Walrus: job ${step.stored.jobId}, blob ${step.stored.blobId}`);
      }
      console.log('');
    },
  });

  const steps = result.steps.length;
  console.log(`Accuracy this run: ${result.correct}/${steps}${steps ? ` (${Math.round((result.correct / steps) * 100)}%)` : ''}`);
  console.log(`\n${renderBoard(result.board)}`);
}

async function cmdBoard(config: Config): Promise<void> {
  const memory = walrusMemory(config);
  const records = await memory.recallAll();
  const { board, events } = computeBoard(records, config.licence);
  console.log(`${records.length} memories recalled from Walrus Memory (namespace ${config.namespace}).\n`);
  console.log(renderBoard(board));
  if (events.length > 0) {
    console.log('\nRecent licence events:');
    for (const event of events.slice(-8)) console.log(`  ${day(event.timestampMs)}  ${renderEvent(event)}`);
  }
}

async function cmdRestore(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { limit: { type: 'string', default: '50' } } });
  const memory = walrusMemory(config);
  const result = await memory.restore(Number(values.limit));
  console.log(
    `Restore ${result.namespace}: restored ${result.restored}, skipped ${result.skipped}, failed ${result.failed}, ` +
      `total on chain ${result.total}${result.truncated ? ' (truncated: run again)' : ''}.\n`,
  );
  await cmdBoard(config);
}

async function cmdHealth(config: Config, paths: Paths, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { tatum: { type: 'boolean', default: false } } });
  const env: Array<[string, unknown]> = [
    ['TATUM_API_KEY', config.tatumApiKey],
    ['MEMWAL_PRIVATE_KEY', config.memwalKey],
    ['MEMWAL_ACCOUNT_ID', config.memwalAccountId],
    ['SHADOWRIGHT_WALLET', config.wallet],
  ];
  for (const [name, value] of env) console.log(`${name.padEnd(20)} ${value ? 'set' : 'MISSING'}`);
  console.log(`namespace            ${config.namespace}`);

  const health = await walrusMemory(config).health();
  console.log(`Walrus Memory        ${health.status} (relayer ${health.version}${health.write_ready === false ? ', writes not ready' : ''})`);

  if (values.tatum) {
    const client = tatumClient(config, paths);
    console.log(`Tatum Sui RPC        ok (latest checkpoint ${await client.getLatestCheckpoint()})`);
    await reportUsage(client, paths);
  }
}

/** Writes a few real transactions per category to test/fixtures, labelled by the current classifier. */
async function cmdFixtures(config: Config, paths: Paths, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { per: { type: 'string', default: '2' } } });
  const wallet = required(config.wallet, 'SHADOWRIGHT_WALLET');
  const [history, transactions] = await Promise.all([
    loadHistory(paths),
    readJson<SuiTransactionBlock[]>(paths.transactions),
  ]);
  const byDigest = new Map((transactions ?? []).map((tx) => [tx.digest, tx]));
  let written = 0;
  for (const category of CATEGORIES) {
    const picks = history.decisions.filter((d) => d.category === category && byDigest.has(d.digest)).slice(0, Number(values.per));
    for (const [i, decision] of picks.entries()) {
      const file = join('test', 'fixtures', `mainnet-${category}-${i + 1}.json`);
      await writeJson(file, { source: 'mainnet', expectedCategory: category, wallet, tx: byDigest.get(decision.digest) });
      console.log(`${file}  ${decision.rule}`);
      written += 1;
    }
  }
  console.log(`\n${written} fixtures written. Review each label by hand before committing.`);
}

function day(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const config = loadConfig();
  const paths = pathsFor(config);
  switch (command) {
    case 'backfill':
      return cmdBackfill(config, paths, args);
    case 'replay':
      return cmdReplay(config, paths, args);
    case 'board':
      return cmdBoard(config);
    case 'restore':
      return cmdRestore(config, args);
    case 'health':
      return cmdHealth(config, paths, args);
    case 'fixtures':
      return cmdFixtures(config, paths, args);
    default:
      console.log(USAGE);
      if (command && command !== 'help') process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
