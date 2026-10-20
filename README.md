# Shadowright

**A learner's permit for your wallet agent.**

Shadowright is a wallet agent that has to *earn* autonomy on Sui, one decision category at a time.
Before each of your on-chain decisions it privately predicts what you will do. Then it reads what
you actually did, and stores the episode (context, prediction, truth, verdict, lesson) as a memory
in Walrus Memory. Accuracy recalled from those memories decides, per category, whether the agent
is allowed to act alone:

| State | Meaning |
| --- | --- |
| 🔒 `LOCKED` | Fewer than 5 memories in this category. The agent only watches. |
| 👀 `SHADOWING` | The agent predicts privately, but is not accurate enough yet (or is on probation). |
| ✅ `LICENSED` | At least 80% correct over the last 10 memories. The agent may act alone (dry-run first). |

One wrong call in a licensed category revokes the licence. Getting it back takes 3 correct calls
in a row, even if the 10-memory accuracy is still high. A wrong prediction counts against both the
category the user acted in and the category the agent predicted, because acting on a false
prediction would be just as harmful. A prediction is correct only if the kind of action, the venue
(or recipient) and the coin all match; the amount is reported but not required.

Categories: swap, send / transfer, stake / unstake, claim / reward, nft, defi deposit / withdraw,
contract call / other.

![Licence Board](docs/screenshots/board.png)
<!-- Screenshot placeholder: capture http://localhost:8787 after `npm run web`. -->

## Features

- **Several subjects.** Learn from any number of wallets (`--wallet <name|address>`). Each has its
  own Walrus Memory namespace, `shadowright-v1:<first 8 hex digits of the address>`, so memories
  never mix, and its own local files under `data/subjects/<name>/`.
- **Scout.** `scout` finds ordinary, diverse mainnet wallets to learn from, using public data only.
- **Replay.** Walks a wallet's history in order: recall, predict, compare, remember, license.
- **Live mode.** `watch` shadows new transactions as they happen. The prediction is stored, with its
  timestamp, *before* the transaction is read. When the predicted category is licensed, the agent
  builds the equivalent transaction from the user's latest matching one and dry-runs it ("would
  have done X"). It never signs or sends. Builders exist for SUI and coin transfers and native
  staking; for other actions (DEX routes, protocol-specific calls) the agent reports that it would
  ask the user to sign instead.
- **Licence Board.** `npm run web`: per-category cards, learning curve, licence events and the
  memory timeline with links to Suiscan and Walruscan, all rebuilt from Walrus Memory recall.
- **Portability.** `restore` (CLI or the board's button) rebuilds the board in a fresh Walrus
  Memory client from Walrus only. The learner's permit travels with its memories.

## How it learns

The predictor never scans your raw history: everything it knows comes from memories recalled from
Walrus Memory. Each memory records what came just before the decision (the previous action and
how long before it happened), what the agent predicted, what the user did, and a lesson (one of
the demo run's memories, trailer shortened):

```
Shadowright memory [stake]. Context: Tue afternoon (2026-10-06 14:58 UTC), 1 minute after claim
1-10 vSUI via 0x13e1…8ff5::navi_vault. I predicted: stake 1-10 vSUI via 0x68d2…ae20::stake_pool.
The user did: stake 1-10 vSUI via 0x68d2…ae20::stake_pool. Verdict: correct. Lesson: after claim
1-10 vSUI via 0x13e1…8ff5::navi_vault, the user does stake 1-10 vSUI via 0x68d2…ae20::stake_pool;
keep predicting it.
#sr1 tx=... ts=... after=claim by=habit-v2 ok=1 pc=stake pt=... bc=claim bt=... gap=... ...
```

Before each decision the agent recalls memories twice with the same query (the current moment
and the previous action, in the memories' own words): the most similar ones, and the most recent
similar ones, so a habit that changed lately is not outvoted by older ones. The `habit-v2`
predictor then lets each recalled memory vote for what the user did:

- memories that followed the **same previous action** count most, the same kind of action less;
- memories from the **same session state** count more (a new session after a break, or the middle
  of one: claim, then redeem, then send, a minute apart);
- **newer** memories outweigh older ones of the same kind, so a new routine takes over quickly;
- memories of **past misses** vote against the action that was wrongly predicted, and the
  prediction says so (`lesson applied: avoided ...`).

On the demo wallet (80 decisions, a public mainnet wallet with routines that change over time)
this lifts accuracy from 26% with the milestone 1 `heuristic-v1` (kept as a baseline:
`replay --predictor heuristic`) to 39% on mainnet, ending at 80% over the last 10 memories; the
category with a steady routine (stake / unstake) earns its licence while the others keep
shadowing. See [docs/RUNLOG.md](docs/RUNLOG.md) for the numbers and the learning curve. The
predictor sits behind a small `Predictor` interface (`src/predictor.ts`), so an LLM-backed
predictor can be dropped in without touching the replay loop or the licence logic.

## How it uses Tatum and Walrus

- **Tatum** (Sui mainnet JSON-RPC gateway) is the agent's eyes:
  - `suix_queryEvents` on staking and DEX events (`0x3::validator` stake and unstake requests,
    Cetus swaps, DeepBook fills) seeds the scout with active addresses;
  - `suix_queryTransactionBlocks` (newest first, with input, effects, events, balance and object
    changes) samples and backfills histories; with digests only, it detects new transactions in
    live mode;
  - `sui_multiGetTransactionBlocks` reads a new transaction once its prediction is stored, and
    recovers pages that contain transactions the node can no longer render;
  - `suix_getCoinMetadata` resolves symbols and decimals;
  - `suix_getCoins`, `suix_getReferenceGasPrice` and `sui_dryRunTransactionBlock` simulate what a
    licensed agent would have done. Dry-runs need no signature: nothing is ever signed or sent.

  The client (`src/tatum.ts`) is throttled to 2.5 requests/s with a token bucket, retries 429/5xx
  and stalled requests with exponential backoff, caches every stable response on disk (re-runs
  cost no credits), and keeps a running credit total in `data/tatum-usage.json`, even when a run
  is interrupted.
- **Walrus Memory** (`@mysten-incubation/memwal`) is the agent's memory. Each episode is stored
  with `remember` and awaited until it is on Walrus, recalled with semantic `recall` (by relevance
  and by recency) before every prediction, and the licence board is rebuilt from recalled
  memories. `restore` re-indexes a namespace from Walrus into a fresh instance.

## Run it

Requires Node.js 24 or newer (TypeScript runs natively through type stripping, no build step).

```sh
npm install --registry=https://registry.npmjs.org
cp .env.example .env              # then fill in the values
npm run cli -- health --tatum

# Find a subject (read-only, public mainnet data), then pick one by rank.
npm run cli -- scout --budget 3000
npm run cli -- subjects add demo --scout 1 --default

npm run cli -- backfill --latest 300             # newest 300 own transactions, counts per category
npm run cli -- replay --last 80                  # dry run: memories stay in-process
npm run cli -- replay --last 80 --write          # store each episode in Walrus Memory (mainnet)
npm run cli -- board                             # licence board recalled from Walrus Memory
npm run cli -- restore                           # portability: re-index from Walrus, show the board

npm run cli -- watch --interval 60               # live mode (2 Tatum credits per poll)
npm run web                                      # Licence Board on http://localhost:8787

npm test
npm run typecheck
```

Every command takes `--wallet <name|address>`; without it the default subject is used.
Configuration (environment or `.env`): `TATUM_API_KEY`, `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`,
and optionally `SHADOWRIGHT_WALLET` (a subject named `wallet`, kept on the milestone 1 namespace
`shadowright-v1` unless `SHADOWRIGHT_NAMESPACE` says otherwise), `SHADOWRIGHT_DATA_DIR` (default
`data/`), `TATUM_RPC_URL`, `MEMWAL_SERVER_URL`, `PORT` and `HOST` for the board (default
`127.0.0.1:8787`). Subjects with their addresses live in `data/subjects.json`; all of `data/` is
git-ignored.

`replay --write` and `watch` keep local journals, so running them again continues where they
stopped instead of writing duplicates.

## Layout

| File | Role |
| --- | --- |
| `src/tatum.ts` | Throttled, cached, retrying Sui JSON-RPC client for Tatum |
| `src/history.ts` | Backfill and normalise transactions into `Decision`s |
| `src/classify.ts` | Rule-based category classifier (rules in priority order, each explains itself) |
| `src/action.ts` | The comparable action (category, venue or recipient, coin, amount bucket) and time features |
| `src/subjects.ts` | Subjects, their namespaces and local files |
| `src/scout.ts` | Finds ordinary, diverse wallets; bot and loop filters |
| `src/predictor.ts` | `Predictor` interface, `habit-v2` and the `heuristic-v1` baseline |
| `src/memory.ts` | Memory text format and the Walrus Memory wrapper |
| `src/licence.ts` | Per-category licence state machine |
| `src/replay.ts` | The shadowing loop: recall, predict, compare, remember, license |
| `src/watch.ts` | Live mode: standing prediction stored before each new transaction is read |
| `src/dryrun.ts` | Builds the equivalent transaction and dry-runs it via Tatum |
| `src/boardview.ts` | Board aggregation: cards, licence progress, timeline, learning curve |
| `src/web.ts`, `web/` | Licence Board server (Node `http`) and page (plain HTML, CSS, JS) |
| `src/cli.ts`, `src/runtime.ts` | Command-line interface and shared wiring |

## Credits

| Dependency | Use | License |
| --- | --- | --- |
| [`@mysten-incubation/memwal`](https://github.com/MystenLabs/MemWal) | Walrus Memory SDK | Apache-2.0 |
| [`@mysten/sui`](https://github.com/MystenLabs/ts-sdks) | Sui TypeScript SDK: transaction building for dry-runs (also a Walrus Memory peer dependency) | Apache-2.0 |
| [`@mysten/seal`](https://github.com/MystenLabs/ts-sdks) | Seal encryption (Walrus Memory peer dependency) | Apache-2.0 |
| [`typescript`](https://github.com/microsoft/TypeScript) | Type checking (dev) | Apache-2.0 |
| [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) | Node.js type definitions (dev) | MIT |

Data and infrastructure: [Tatum](https://tatum.io) Sui RPC gateway, [Walrus](https://walrus.xyz)
and Walrus Memory, [Sui](https://sui.io) mainnet. Links from the board: [Suiscan](https://suiscan.xyz)
and [Walruscan](https://walruscan.com).

## License

MIT, see [LICENSE](LICENSE).
