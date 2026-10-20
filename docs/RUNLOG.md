# Run log

Outputs of real runs against Sui mainnet (via Tatum) and Walrus Memory. No secrets, no wallet
address, no local paths: only counts, accuracy and Walrus Memory job / blob ids.

## Milestone 1: backfill and first memories

Status: **done** (first mainnet run).

Commands, in order:

```sh
npm install --registry=https://registry.npmjs.org
npm test && npm run typecheck
npm run cli -- health --tatum
npm run cli -- backfill
npm run cli -- replay --limit 12 --write
npm run cli -- board
```

- Tests: 60 pass, typecheck clean.
- Health: Walrus Memory relayer 0.1.0 ok, Tatum Sui RPC ok.
- Backfill: 1001 transactions (capped at 20 pages per direction), 2026-08-29 to 2026-08-31.
  Own / incoming per category: swap 1/0, send 0/1, defi deposit/withdraw 16/0,
  contract call/other 983/0. The test wallet is mostly a bot working one perps clearing house,
  so `other` dominates.
- Replay (12 decisions, written to mainnet): accuracy 7/12 (58%), climbing from 1/6 to 7/12 as
  memories accumulated. Licence event: `other` LOCKED -> SHADOWING.
- Dry replay of 40 decisions (in-process store, no writes): 32/40 (80%), `other` became LICENSED.
- Walrus Memory: 12 memories in namespace `shadowright-v1`; `board` recalls all 12 back.
- Tatum usage: ~84 credits (42 network calls) for health + backfill; replays read the cache.

| # | job | blob |
|---|-----|------|
| 1 | 7c57ad14-8828-46f7-8890-000bd6aa647d | G0G3fqkAHOkLfJxXaTFiTWn1pupp6r-p6PE8_1r08wk |
| 2 | 2de701f7-62ac-47d1-9c26-5158ba43f5e8 | xZHD3oWvLpNj69ypEXQRm4pdojrTlLnmMoSs7E_ybmk |
| 3 | 9083af83-59fc-42b1-b578-7bcd4fa67798 | jlT0m7qyK50glHFCKc7TsJdFFa0C5U8FI2-WFeuVV1s |
| 4 | 60b9d2cf-9d45-4103-9129-53177c9ce0cc | dwoxqgIZGt2c6CXuCBMx71EUOpVcGzJqlpSGzEH_Dds |
| 5 | a7d5daaf-c47d-4ee7-afa2-d3ae69278e60 | k5KbR-Txq794C5bekUQoR1CmYrVj1nPXw_AoaVAHLD4 |
| 6 | 4d4fdb12-e63e-4797-91aa-c8205ff84ab5 | og1WUjXUdQd6nJJpYUoaRARR8tV3msXNJtXw9zIz1yg |
| 7 | 698dd992-89f2-4dbb-b209-da352a68fa95 | Ikr6c1y2g9tjauJkfjMmh-NgxG7gK3_0SeOvPw-GrII |
| 8 | f68b62b8-686d-45f3-b93c-2cc11168dc25 | lclLzKKtCFt1vTrfq-RKi8QVHSg39Iu5WYyIsmEGhTQ |
| 9 | 2d73b60f-69b3-4ab4-a8f5-45b8b486628f | 9-pxQiw32FVB0QE8lgSv6JqRBBSpsnYI8SstjWu2Uf0 |
| 10 | b542ebcc-5126-4ae1-a023-87f8d1c26449 | SwgRqqAixmdHH_JWIr4-rFw7-31jEXTF394ALrRV1-k |
| 11 | 5e83e7ff-1166-4eb7-9954-03f778ca7849 | nVehDDcSQrXj-q8BIjvsuynwyJ2PE3Y96tcHensx97U |
| 12 | 35dc969c-fca1-4a52-b424-61b27db88b7a | A0W3mNTsYYxahJfbL3GMLEzD-ylBzjLv7nju-GMGW_U |
