import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { MemWalMock } from '@mysten-incubation/memwal';
import { loadConfig, type Config } from './config.ts';
import { dryRunAction, findTemplate } from './dryrun.ts';
import { readJson, writeJson } from './files.ts';
import { backfill, coinLookupFor, toDecision, type History } from './history.ts';
import { Journal } from './journal.ts';
import { computeBoard } from './licence.ts';
import { ShadowMemory } from './memory.ts';
import { createPredictor, DEFAULT_PREDICTOR } from './predictor.ts';
import { replay } from './replay.ts';
import {
  renderBoard,
  renderCounts,
  renderEvent,
  renderScoutCandidate,
  renderStanding,
  renderStep,
  renderWatchStep,
} from './report.ts';
import { flushUsage, PATIENT, pickSubject, sharedPaths, subjectSources, tatumClient, walrusMemory } from './runtime.ts';
import { DEFAULT_CRITERIA, scout, type ScoutResult } from './scout.ts';
import {
  listSubjects,
  maskAddress,
  maskNamespace,
  maskRecipients,
  readSubjectsFile,
  shortAddress,
  withSubject,
  writeSubjectsFile,
  type Subject,
  type SubjectPaths,
} from './subjects.ts';
import type { SuiTransactionBlock } from './sui.ts';
import type { TatumSuiClient } from './tatum.ts';
import { CATEGORIES, type Category, type Decision } from './types.ts';
import { Watcher, type WatchState } from './watch.ts';

const USAGE = `Shadowright: a learner's permit for your wallet agent.

Usage: npm run cli -- <command> [--wallet <name|address>] [options]

Every command works on one subject (a wallet the agent learns from), picked with --wallet by
subject name or address. Without --wallet the default subject is used. Each subject has its
own Walrus Memory namespace, so memories of different wallets never mix.

Commands:
  subjects                       List subjects (addresses shortened).
  subjects add <name> (<address> | --scout RANK) [--namespace NS] [--default]
                                 Add a subject to data/subjects.json (git-ignored), by address
                                 or by its rank in the latest scout result.
  scout [--budget N] [--save NAME]
                                 Find ordinary, diverse mainnet wallets via Tatum (read-only).
                                 --save stores the best one as a subject and makes it the default.
  backfill [--latest N | --max-pages N]
                                 Fetch and cache the subject's Sui history via Tatum; print counts per category.
                                 --latest N takes the newest N own transactions instead of the oldest.
  replay [--limit N] [--last N] [--write]
                                 Walk the history in order: recall, predict, compare, remember, update licences.
                                 --last N shadows only the newest N decisions (older ones are context).
                                 Without --write, memories stay in an in-process store (no network writes).
                                 With --write, every episode is stored in Walrus Memory on mainnet.
  watch [--interval S] [--once]  Live mode: poll new transactions, predict before reading each one,
                                 compare, remember, update the board; dry-run when licensed.
  board                          Licence board computed from the memories stored in Walrus Memory.
  restore [--limit N]            Rebuild this instance's memory index from Walrus, then show the board.
  health [--tatum]               Check Walrus Memory (and optionally Tatum) connectivity and configuration.
  fixtures [--per N]             Export real classified transactions from the backfill as test fixtures.

Web board: npm run web (http://localhost:8787).
`;

const WALLET_OPTION = { wallet: { type: 'string' } } as const;
/** Memories per recall query; each prediction runs two queries (most similar, most recent). */
const RECALL_LIMIT = '15';

function label(config: Config, subject: Subject): string {
  if (config.maskAddresses) return `${subject.name} (${maskAddress(subject.address)}…, namespace ${maskNamespace(subject.namespace)})`;
  return `${subject.name} (${shortAddress(subject.address)}…, namespace ${subject.namespace})`;
}

/** Output that may name a transfer recipient, masked when `SHADOWRIGHT_MASK_ADDRESSES` is set. */
function shown(config: Config, text: string): string {
  return config.maskAddresses ? maskRecipients(text) : text;
}

async function loadHistory(paths: SubjectPaths): Promise<History> {
  const history = await readJson<History>(paths.history);
  if (!history) throw new Error('No local history for this subject yet. Run `npm run cli -- backfill` first.');
  return history;
}

async function cmdSubjects(config: Config, args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { namespace: { type: 'string' }, default: { type: 'boolean', default: false }, scout: { type: 'string' } },
  });
  const path = sharedPaths(config).subjects;
  if (positionals[0] === 'add') {
    const [, name, given] = positionals;
    const address = values.scout === undefined ? given : await scoutedAddress(config, Number(values.scout));
    if (!name || !address) throw new Error('Usage: subjects add <name> (<address> | --scout <rank>) [--namespace NS] [--default]');
    let file = withSubject(await readSubjectsFile(path), { name, address, namespace: values.namespace });
    if (values.default) file = { ...file, default: name };
    await writeSubjectsFile(path, file);
    console.log(`Subject ${name} saved.`);
  }
  const sources = await subjectSources(config);
  for (const subject of listSubjects(sources)) {
    const isDefault = subject.name === sources.file.default ? '  (default)' : '';
    console.log(`${label(config, subject)}${isDefault}`);
  }
}

async function scoutedAddress(config: Config, rank: number): Promise<string> {
  const scouted = await readJson<ScoutResult>(sharedPaths(config).scout);
  const candidate = scouted?.candidates[rank - 1];
  if (!candidate) throw new Error(`No scout candidate #${rank}. Run \`npm run cli -- scout\` first.`);
  return candidate.profile.address;
}

async function cmdScout(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      budget: { type: 'string', default: '3000' },
      'event-pages': { type: 'string', default: '6' },
      top: { type: 'string', default: '5' },
      save: { type: 'string' },
    },
  });
  const client = tatumClient(config);
  console.log(`Scouting Sui mainnet via Tatum for ordinary, diverse wallets (budget ${values.budget} credits)...`);
  const result = await scout(client, {
    budgetCredits: Number(values.budget),
    eventPages: Number(values['event-pages']),
    onProgress: (message) => console.log(`  ${message}`),
  });

  // Kept locally (git-ignored) so a candidate can be picked later without scouting again.
  await writeJson(sharedPaths(config).scout, { scoutedAt: new Date().toISOString(), ...result });
  const top = result.candidates.slice(0, Number(values.top));
  console.log(`\nTop ${top.length} of ${result.candidates.length} sampled wallets (sample: newest ${DEFAULT_CRITERIA.sampleSize} own tx):\n`);
  for (const [i, candidate] of top.entries()) console.log(renderScoutCandidate(i + 1, candidate));
  console.log('\nPick one with: npm run cli -- subjects add <name> --scout <rank> --default');

  if (values.save) {
    const best = result.candidates.find((c) => c.reason === undefined);
    if (!best) throw new Error('No wallet met every criterion; nothing saved. Try a larger --budget or more --event-pages.');
    const path = sharedPaths(config).subjects;
    const file = withSubject(await readSubjectsFile(path), { name: values.save, address: best.profile.address });
    await writeSubjectsFile(path, { ...file, default: values.save });
    console.log(`\nSaved the best wallet as subject "${values.save}" (default) in ${path}.`);
  }
}

async function cmdBackfill(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { ...WALLET_OPTION, 'max-pages': { type: 'string', default: '20' }, latest: { type: 'string' } },
  });
  const { subject, paths } = await pickSubject(config, values.wallet);
  const client = tatumClient(config);
  console.log(`Backfilling ${label(config, subject)} from Sui mainnet via Tatum...`);

  const { history, transactions } = await backfill(client, subject.address, {
    maxPages: Number(values['max-pages']),
    latest: values.latest === undefined ? undefined : Number(values.latest),
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
}

async function cmdReplay(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      ...WALLET_OPTION,
      limit: { type: 'string' },
      last: { type: 'string' },
      write: { type: 'boolean', default: false },
      recall: { type: 'string', default: RECALL_LIMIT },
      predictor: { type: 'string', default: DEFAULT_PREDICTOR },
    },
  });
  const { subject, paths } = await pickSubject(config, values.wallet);
  const history = await loadHistory(paths);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  const write = values.write ?? false;

  const memory = write
    ? walrusMemory(config, subject.namespace, PATIENT)
    : new ShadowMemory(MemWalMock.create({ namespace: subject.namespace }), subject.namespace);
  const journal = write ? await Journal.open(paths.journal) : undefined;
  const existing = write ? await memory.recallAll() : [];
  // --last N shadows only the newest N decisions; older ones still serve as context.
  const own = history.decisions.filter((d) => d.initiatedByUser && d.success);
  const shadowed = new Set((values.last === undefined ? own : own.slice(-Number(values.last))).map((d) => d.digest));
  const skip = (d: Decision) => !shadowed.has(d.digest) || (journal?.has(d.digest) ?? false);
  const pending = own.filter((d) => !skip(d)).length;
  const total = Math.min(limit ?? pending, pending);

  console.log(
    write
      ? `Replay ${label(config, subject)} with Walrus Memory: ${existing.length} existing memories, ${total} decisions to shadow.`
      : `Dry replay of ${subject.name} with in-process memory (nothing leaves this machine): ${total} decisions to shadow.`,
  );
  console.log('');

  const result = await replay({
    decisions: history.decisions,
    memory,
    predictor: createPredictor(values.predictor),
    policy: config.licence,
    limit,
    skip,
    existing,
    recallLimit: Number(values.recall),
    onStep: async (step) => {
      console.log(shown(config, renderStep(step, total)));
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

async function cmdWatch(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      ...WALLET_OPTION,
      interval: { type: 'string', default: '60' },
      once: { type: 'boolean', default: false },
      'max-polls': { type: 'string' },
      recall: { type: 'string', default: RECALL_LIMIT },
    },
  });
  const { subject, paths } = await pickSubject(config, values.wallet);
  const client = tatumClient(config);
  const memory = walrusMemory(config, subject.namespace, PATIENT);
  // Shared with `replay --write`, so neither shadows a transaction the other already stored.
  const journal = await Journal.open(paths.journal);
  const history = await readJson<History>(paths.history);
  const decisions = history?.decisions ?? [];
  const txs = new Map((await readJson<SuiTransactionBlock[]>(paths.transactions) ?? []).map((tx) => [tx.digest, tx]));

  const state = (await readJson<WatchState>(paths.watch)) ?? (await initialWatchState(client, subject, decisions));
  const { board } = computeBoard(await memory.recallAll(), config.licence);
  console.log(`Watching ${label(config, subject)}: polling every ${values.interval}s via Tatum (2 credits per poll).`);
  console.log(`${renderBoard(board)}\n`);

  const watcher = new Watcher(state, board, {
    memory,
    predictor: createPredictor(),
    policy: config.licence,
    recallLimit: Number(values.recall),
    ports: {
      listNew: (cursor) => listNewDigests(client, subject.address, cursor),
      read: async (digest) => {
        const [tx] = await client.multiGetTransactionBlocks([digest]);
        if (!tx) throw new Error(`transaction ${digest} not found`);
        txs.set(digest, tx);
        const decision = toDecision(tx, subject.address, await coinLookupFor(client, [tx], subject.address));
        decisions.push(decision);
        return decision;
      },
      saveState: (next) => writeJson(paths.watch, next),
      now: Date.now,
    },
    onStep: async (step) => {
      await journal.add(step.decision.digest, step.stored);
      console.log(shown(config, renderWatchStep(step)));
      if (step.wouldAct) {
        const action = step.standing.prediction.action;
        const outcome = await dryRunAction(client, subject.address, action, findTemplate(action, decisions, txs));
        console.log(`   ⚡ ${outcome.summary} (${outcome.detail})`);
      }
      console.log('');
    },
  });

  const maxPolls = values.once ? 1 : values['max-polls'] === undefined ? Infinity : Number(values['max-polls']);
  for (let poll = 1; poll <= maxPolls; poll++) {
    const steps = await watcher.poll();
    const { standing } = watcher.current.state;
    if (steps.length === 0 && standing) console.log(shown(config, renderStanding(standing)));
    if (poll < maxPolls) await new Promise((resolve) => setTimeout(resolve, Number(values.interval) * 1000));
  }
  console.log(`\n${renderBoard(watcher.current.board)}`);
}

/** Starts after the newest known own decision, so only transactions from now on are shadowed. */
async function initialWatchState(client: TatumSuiClient, subject: Subject, decisions: Decision[]): Promise<WatchState> {
  const previous = decisions.filter((d) => d.initiatedByUser).at(-1);
  if (previous) return { cursor: previous.digest, previous, processed: 0 };
  const latest = await client.queryTransactionBlocks({ FromAddress: subject.address }, null, 1, { descending: true, digestsOnly: true, noCache: true });
  return { cursor: latest.data[0]?.digest ?? null, processed: 0 };
}

async function listNewDigests(client: TatumSuiClient, address: string, cursor: string | null): Promise<string[]> {
  const digests: string[] = [];
  let next = cursor;
  for (;;) {
    const page = await client.queryTransactionBlocks({ FromAddress: address }, next, 50, { digestsOnly: true, noCache: true });
    digests.push(...page.data.map((tx) => tx.digest));
    if (!page.hasNextPage || !page.nextCursor) return digests;
    next = page.nextCursor;
  }
}

async function cmdBoard(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: WALLET_OPTION });
  const { subject } = await pickSubject(config, values.wallet);
  await printBoard(config, subject);
}

async function printBoard(config: Config, subject: Subject): Promise<void> {
  const records = await walrusMemory(config, subject.namespace).recallAll();
  const { board, events } = computeBoard(records, config.licence);
  console.log(`${records.length} memories recalled from Walrus Memory for ${label(config, subject)}.\n`);
  console.log(renderBoard(board));
  if (events.length > 0) {
    console.log('\nRecent licence events:');
    for (const event of events.slice(-8)) console.log(`  ${day(event.timestampMs)}  ${renderEvent(event)}`);
  }
}

async function cmdRestore(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { ...WALLET_OPTION, limit: { type: 'string', default: '50' } } });
  const { subject } = await pickSubject(config, values.wallet);
  const result = await walrusMemory(config, subject.namespace).restore(Number(values.limit));
  console.log(
    `Restore ${config.maskAddresses ? maskNamespace(result.namespace) : result.namespace}: restored ${result.restored}, skipped ${result.skipped}, failed ${result.failed}, ` +
      `total on chain ${result.total}${result.truncated ? ' (truncated: run again)' : ''}.\n`,
  );
  await printBoard(config, subject);
}

async function cmdHealth(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { ...WALLET_OPTION, tatum: { type: 'boolean', default: false } } });
  const env: Array<[string, unknown]> = [
    ['TATUM_API_KEY', config.tatumApiKey],
    ['MEMWAL_PRIVATE_KEY', config.memwalKey],
    ['MEMWAL_ACCOUNT_ID', config.memwalAccountId],
    ['SHADOWRIGHT_WALLET', config.wallet],
  ];
  for (const [name, value] of env) console.log(`${name.padEnd(20)} ${value ? 'set' : 'MISSING'}`);
  const { subject } = await pickSubject(config, values.wallet);
  console.log(`subject              ${label(config, subject)}`);

  const health = await walrusMemory(config, subject.namespace).health();
  console.log(`Walrus Memory        ${health.status} (relayer ${health.version}${health.write_ready === false ? ', writes not ready' : ''})`);

  if (values.tatum) {
    const client = tatumClient(config);
    console.log(`Tatum Sui RPC        ok (latest checkpoint ${await client.getLatestCheckpoint()})`);
  }
}

/** Writes a few real transactions per category to test/fixtures, labelled by the current classifier. */
async function cmdFixtures(config: Config, args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { ...WALLET_OPTION, per: { type: 'string', default: '2' } } });
  const { subject, paths } = await pickSubject(config, values.wallet);
  const [history, transactions] = await Promise.all([loadHistory(paths), readJson<SuiTransactionBlock[]>(paths.transactions)]);
  const byDigest = new Map((transactions ?? []).map((tx) => [tx.digest, tx]));
  let written = 0;
  for (const category of CATEGORIES) {
    const picks = history.decisions.filter((d) => d.category === category && byDigest.has(d.digest)).slice(0, Number(values.per));
    for (const [i, decision] of picks.entries()) {
      const file = join('test', 'fixtures', `mainnet-${category}-${i + 1}.json`);
      await writeJson(file, { source: 'mainnet', expectedCategory: category, wallet: subject.address, tx: byDigest.get(decision.digest) });
      console.log(`${file}  ${decision.rule}`);
      written += 1;
    }
  }
  console.log(`\n${written} fixtures written. Review each label by hand before committing.`);
}

function day(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

const COMMANDS: Record<string, (config: Config, args: string[]) => Promise<void>> = {
  subjects: cmdSubjects,
  scout: cmdScout,
  backfill: cmdBackfill,
  replay: cmdReplay,
  watch: cmdWatch,
  board: cmdBoard,
  restore: cmdRestore,
  health: cmdHealth,
  fixtures: cmdFixtures,
};

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const run = command ? COMMANDS[command] : undefined;
  if (!run) {
    console.log(USAGE);
    if (command && command !== 'help') process.exitCode = 1;
    return;
  }
  const config = loadConfig();
  // Credits spent before an interruption (Ctrl+C, stopped watch) still reach the running total.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void flushUsage(config).finally(() => process.exit(130));
    });
  }
  try {
    await run(config, args);
  } finally {
    const usage = await flushUsage(config);
    if (usage) console.log(`\n${usage}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
