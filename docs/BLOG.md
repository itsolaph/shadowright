# Shadowright: a learner's permit for your wallet agent

Wallet agents ask for the same thing on day one: full access. Sign any transaction, spend any
coin, no limits. The alternative is approving every action by hand, which defeats the point of an
agent. We would not give a new hire that deal, let alone software that has never seen us use our
wallet.

People don't get a driving licence on day one either. They get a learner's permit: drive with
someone watching, prove you can handle it, and the restrictions come off one at a time. We built
Shadowright for the Walrus x Tatum "Total Recall" hackathon to try that idea on a Sui wallet.

## The idea

Shadowright has to earn autonomy one decision category at a time: swaps, sends, staking, claims,
NFTs, DeFi, other contract calls. It starts with no permissions. Before each of your on-chain
decisions it privately predicts what you are about to do, then looks at what you actually did and
writes the episode down: context, prediction, truth, verdict and a lesson.

Each category has a licence. **Locked** until there are 5 memories to judge. **Shadowing** while
the agent is not good enough yet. **Licensed** once it gets at least 8 of the last 10 calls right.
A licensed agent may act alone in that category, after a dry run, and never signs anything itself.

The licence is fragile on purpose. One wrong call revokes it, and getting it back takes 3 correct
calls in a row. A wrong prediction also counts against the category the agent *predicted*,
because acting on a false prediction would hurt just as much.

## Tatum is the agent's eyes

Everything the agent sees on chain comes through Tatum's Sui mainnet GraphQL RPC. Backfilling a
wallet's history is a paginated `transactions(filter: { sentAddress })` query with inputs,
effects, events and balance changes, mapped into the transaction shape the rest of the code reads:

```ts
queryTransactionBlocks(filter, cursor, limit = 50, options = {}) {
  const descending = options.descending ?? false;
  const variables = { filter: transactionFilter(filter), ...pageVariables(cursor, limit, descending) };
  return this.query('transactions', QUERIES.transactions, variables,
    (data) => toPage(data.transactions, descending, toTransactionBlock), options);
}
```

In live mode we ask for digests only, which is cheap, and read the new transaction with
`multiGetTransactions` only *after* the prediction for it has been stored. Events
(`events(filter: { type })`) help us find wallets to learn from, and `simulateTransaction`
simulates what a licensed agent would have done.

Each call costs 2 credits, so the client throttles itself, retries with backoff, caches stable
responses on disk and keeps a running credit total. All our runs so far cost about 4,590 credits
out of 100,000. One live poll costs 2.

## Walrus Memory is the only thing it knows about you

This is the part we cared about most. The predictor never scans your raw history. Everything it
knows comes from memories it recalls from Walrus Memory, each one written by the agent itself
after being right or wrong. Each wallet gets its own namespace.

A memory is plain prose, so semantic recall can match on meaning, plus one machine-readable line
so we can parse it back exactly:

```
Shadowright memory [stake]. Context: Tue afternoon (2026-10-06 14:58 UTC), 1 minute after claim
1-10 vSUI via 0x13e1…8ff5::navi_vault. I predicted: stake 1-10 vSUI via 0x68d2…ae20::stake_pool.
The user did: stake 1-10 vSUI via 0x68d2…ae20::stake_pool. Verdict: correct. Lesson: after claim
1-10 vSUI via 0x13e1…8ff5::navi_vault, the user does stake 1-10 vSUI via 0x68d2…ae20::stake_pool;
keep predicting it.
```

Storing it is a `remember` call that we wait on until the blob is on Walrus:

```ts
const accepted = await backend.remember(formatMemory(record), namespace, { idempotencyKey: key });
const done = await backend.waitForRememberJob(accepted.job_id, { timeoutMs: 180_000 });
```

Before every prediction the agent recalls twice with the same question, written in the memories'
own words: once for the most similar memories, once for the most recent similar ones. The second
query is there so that a habit the user changed last week is not outvoted by months of older
memories. The `habit-v2` predictor then lets each recalled memory vote. Memories that followed the same
previous action count most, newer ones outweigh older ones, and memories of past misses vote
*against* the action that was wrongly predicted.

The Licence Board, our small web UI, is rebuilt purely from recall too. Its "Restore from Walrus"
button starts a fresh Walrus Memory client with no local files and rebuilds the board: same 80
memories, same 31 correct. The permit travels with its memories.

## How it learned

Our first milestone did not go well, and it taught us something. The test wallet we picked turned
out to be a bot hammering one perps clearing house: 983 of its 1,001 transactions were the same
kind of contract call. The agent got good at predicting it, but only one category ever moved.
A learner's permit for a bot is not very interesting.

So we wrote a scout. It samples senders of recent staking, swap and DeepBook events through Tatum
and throws out anything that looks scripted: thousands of transactions a day, one package almost
every time, or loops like claim, swap, stake repeated 94 times. Twelve wallets passed. We picked
one with human routines that *change* over time, because a changing habit is the real test of a
memory.

That wallet has 91 transactions over 267 days. In spring it claimed lending rewards, swapped them
to SUI and sent the SUI to a deposit address. Since September it claims vault rewards every few
days, redeems them on a staking pool and sends the SUI on. We shadowed the newest 80 decisions and
wrote all 80 episodes to Walrus Memory on mainnet.

The numbers:

- Our milestone 1 predictor (time of day, previous category) got **21 of 80 right, 26%**.
- `habit-v2`, learning only from its own memories on Walrus, got **31 of 80, 39%**.
- Over the last 10 memories it was right **8 times out of 10, 80%**.

The learning curve tells the story better than the averages. Accuracy climbs early, then dips in
the middle when the user switches protocols and the old memories stop being useful. Then it
climbs again as the new routine piles up in memory: from decision 65 on, the agent gets 14 of the
last 16 right, predicting claim, then redeem, then send, with 57 to 97% confidence. On 2026-10-16
**stake / unstake earned its licence**, and on the next redeem the log reads "stake was LICENSED:
the agent would have acted alone (dry-run first)".

Then we left it running. The `watch` job polls the wallet every 6 hours, stores a standing
prediction before it reads the next transaction, and writes the result to Walrus Memory. Ten more
real decisions came in, for 90 memories in total. On 2026-10-21 the agent, still licensed for
stake, expected another redeem on the staking pool. The user deposited USDC into a Navi vault
instead. Wrong category, wrong target, wrong coin, so the board logged **"revoked: wrong call (category,
target, coin) while licensed"** and stake dropped back to shadowing. No simulation, no staged miss: a real user
changed their routine and the permit was pulled on the spot.

The new routine also shows in the score. Only 1 of those 10 live calls was right, so the totals
are now **32 of 90, 36%**, and stake has to earn its licence again with 3 correct calls in a row.
That is the design working: when the agent stops understanding you, it loses its permission first
and its confidence second.

What did not work is just as visible. At the 80-memory mark, **swaps were still at 0 out of 10**, and DeFi deposits at
1 out of 10. Sends and claims sit at 5 out of 10, partly because the user alternates between two
deposit addresses. Those categories keep shadowing, and that is the point. An agent that cannot predict your swaps has no business
making them.

## Safety

Shadowright never holds a key for the wallet it learns from. It cannot sign and it cannot send.
The only thing it writes is its own memories. When a category is licensed, it rebuilds the
equivalent transaction and runs `simulateTransaction` through Tatum, which needs no
signature. On our demo wallet that dry run returned `InsufficientCoinBalance`, because the user
had already sent the SUI on. That is the check doing its job. For actions we have no builder for
yet, the agent says it would ask the user to sign.

## What's next

- An LLM-backed predictor behind the same `Predictor` interface, with the stored lessons as its
  context. The licence rules stay the same.
- More dry-run builders (DEX routes, liquid staking), so more licences turn into a concrete
  "would have done X".
- A bar the user sets per category: 80% may be fine for claiming rewards, not for sends to new
  addresses.
- Portable permits: the memories live on Walrus, so a new agent could start from what the old one
  learned.

The code is open source under MIT: https://github.com/itsolaph/shadowright

The demo video (2:46): https://youtu.be/kr0DQE7RSKQ
