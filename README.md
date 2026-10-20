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
prediction would be just as harmful.

Categories: swap, send / transfer, stake / unstake, claim / reward, nft, defi deposit / withdraw,
contract call / other.

## How it learns

The predictor never scans your raw history. Before each decision it **recalls** memories of
similar moments from Walrus Memory (same part of the day, same weekday, same previous action)
and lets each memory vote for what you actually did, weighted by similarity and recency. A memory
in which the agent was wrong also votes *against* what it predicted back then, and the prediction
says so (illustrative output, ids shortened):

```
#07/12  2026-03-09 14:05 UTC Mon afternoon  after swap
   recall : 6 relevant memories
   predict: swap 10-100 SUI>USDC via 0x1eab…0f3a::router  (confidence 71%)
            · lesson applied: avoided swap 10-100 SUI>USDT via 0x91bf…77c2::pool because memory 4kQ2xa: I wrongly predicted ...
            · memory Hn3Wq1: user did swap 10-100 SUI>USDC via 0x1eab…0f3a::router (Mon afternoon; same afternoon, same Mon, also after swap)
```

Because everything the agent knows lives in Walrus Memory, `restore` on a fresh machine brings the
licences back with it: the learner's permit is portable.

The predictor sits behind a small `Predictor` interface (`src/predictor.ts`). The current one is a
transparent heuristic; an LLM-backed predictor can be dropped in later without touching the replay
loop or the licence logic.

## How it uses Tatum and Walrus

- **Tatum** (Sui mainnet JSON-RPC gateway) is the agent's eyes. `suix_queryTransactionBlocks`
  (both `FromAddress` and `ToAddress`, with input, effects, events, balance and object changes)
  backfills the wallet's history; `suix_getCoinMetadata` resolves symbols and decimals;
  `sui_dryRunTransactionBlock` is the safety check a licensed agent runs before acting. The client
  (`src/tatum.ts`) is throttled with a token bucket (2.5 requests/s), retries 429/5xx with
  exponential backoff, and caches every stable response on disk, so re-runs cost no credits.
- **Walrus Memory** (`@mysten-incubation/memwal`) is the agent's memory. Each episode is stored
  with `remember` (and awaited until it is on Walrus), recalled with semantic `recall` before every
  prediction, and the licence board is rebuilt from recalled memories. `restore` re-indexes the
  memories from Walrus into a fresh instance. Memory text is plain prose for good recall plus a
  one-line machine-readable trailer, for example (illustrative):

  ```
  Shadowright memory [swap]. Context: Mon afternoon (2026-03-09 14:05 UTC), after a swap. I predicted: swap 10-100 SUI>USDC via 0x1eab…0f3a::router. The user did: swap 10-100 SUI>USDC via 0x1eab…0f3a::router. Verdict: correct. Lesson: on Mon afternoons the user does swap 10-100 SUI>USDC via 0x1eab…0f3a::router; keep predicting it.
  #sr1 tx=... ts=... after=swap by=heuristic-v1 ok=1 miss= pc=swap pt=... pk=SUI%3EUSDC pa=10-100 ac=swap ...
  ```

## Run it

Requires Node.js 24 or newer (TypeScript runs natively through type stripping, no build step).

```sh
npm install --registry=https://registry.npmjs.org
cp .env.example .env    # then fill in the values
npm run cli -- health --tatum
npm run cli -- backfill                 # fetch and cache history, counts per category
npm run cli -- replay --limit 50        # dry run: memories stay in-process
npm run cli -- replay --limit 12 --write  # store each episode in Walrus Memory (mainnet)
npm run cli -- board                    # licence board recalled from Walrus Memory
npm run cli -- restore                  # portability: re-index memories from Walrus, show the board
npm test
npm run typecheck
```

Configuration (environment or `.env`): `TATUM_API_KEY`, `MEMWAL_PRIVATE_KEY`, `MEMWAL_ACCOUNT_ID`,
`SHADOWRIGHT_WALLET` (the address to learn from), and optionally `SHADOWRIGHT_NAMESPACE`
(default `shadowright-v1`), `SHADOWRIGHT_DATA_DIR` (default `data/`), `TATUM_RPC_URL`,
`MEMWAL_SERVER_URL`. Local caches live in `data/`, which is git-ignored.

`replay --write` keeps a local journal of stored decisions, so running it again continues where
the previous run stopped instead of writing duplicates.

## Layout

| File | Role |
| --- | --- |
| `src/tatum.ts` | Throttled, cached, retrying Sui JSON-RPC client for Tatum |
| `src/history.ts` | Backfill and normalise transactions into `Decision`s |
| `src/classify.ts` | Rule-based category classifier (rules in priority order, each explains itself) |
| `src/action.ts` | The comparable action (category, target, coin, amount bucket) and time features |
| `src/predictor.ts` | `Predictor` interface and the memory-driven heuristic predictor |
| `src/memory.ts` | Memory text format and the Walrus Memory wrapper |
| `src/licence.ts` | Per-category licence state machine |
| `src/replay.ts` | The shadowing loop: recall, predict, compare, remember, license |
| `src/cli.ts` | Command-line interface |

## Credits

| Dependency | Use | License |
| --- | --- | --- |
| [`@mysten-incubation/memwal`](https://github.com/MystenLabs/MemWal) | Walrus Memory SDK | Apache-2.0 |
| [`@mysten/sui`](https://github.com/MystenLabs/ts-sdks) | Sui TypeScript SDK (Walrus Memory peer dependency) | Apache-2.0 |
| [`@mysten/seal`](https://github.com/MystenLabs/ts-sdks) | Seal encryption (Walrus Memory peer dependency) | Apache-2.0 |
| [`typescript`](https://github.com/microsoft/TypeScript) | Type checking (dev) | Apache-2.0 |
| [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) | Node.js type definitions (dev) | MIT |

Data and infrastructure: [Tatum](https://tatum.io) Sui RPC gateway, [Walrus](https://walrus.xyz)
and Walrus Memory, [Sui](https://sui.io) mainnet.

## License

MIT, see [LICENSE](LICENSE).
