# Run log

Outputs of real runs against Sui mainnet (via Tatum) and Walrus Memory. No secrets, no wallet
address, no local paths: only counts, accuracy and Walrus Memory job / blob ids. The milestone 2
demo subject is "a public mainnet wallet (address in demo config)": its address lives only in the
git-ignored `data/subjects.json`.

## Milestone 2: a diverse subject, a better learner, live mode and the board

Status: **done** (mainnet run, 80 new memories).

Commands, in order (subject names are local labels):

```sh
npm run cli -- scout --budget 2500 --event-pages 5 --top 12
npm run cli -- subjects add demo <address of scout candidate> --default
npm run cli -- backfill --wallet demo --latest 300
npm run cli -- replay --wallet demo --last 80 --predictor heuristic   # baseline, dry
npm run cli -- replay --wallet demo --last 80                         # habit-v2, dry
npm run cli -- replay --wallet demo --last 80 --write                 # mainnet
npm run cli -- watch --wallet demo --once
npm run web                                                           # board + restore
```

### Scout

- Seeds: 1,000 recent events (250 each of native stake requests, unstake requests, Cetus swaps,
  DeepBook fills), 253 distinct senders. Quick look (newest 50 own transactions) at 214 of them;
  39 others were skipped because their newest page holds a transaction the node can no longer
  render ("effect is empty"). Deep look (newest 300) at 8.
- Filters reject: bursts over 2,000 tx/day, more than 80% of transactions through one package,
  scripted loops (for example claim, swap, stake repeated by a compounder: the first trial run's
  top hit had exactly 94 of each), histories shorter than 3 weeks, and wallets missing swap, send,
  stake/unstake, or claim/defi.
- 12 wallets met every criterion. Four were backfilled and compared offline; the very busy ones
  (300 transactions in 4 months across perps, vaults and three aggregators) stay near 20-30%
  exact-action accuracy with any simple model. The demo subject is "a public mainnet wallet
  (address in demo config)" chosen for clear, *changing* human routines.

### Demo subject

91 own transactions over 267 days (2026-01-26 to 2026-10-20): claim/reward 27, send 28,
swap 12, stake/unstake 11, defi deposit/withdraw 13. Two routines: in spring, claim lending
rewards, swap them to SUI and send SUI to a deposit address; since September, every ~4 days,
claim vault rewards (vSUI), redeem the vSUI for SUI on a staking pool, send the SUI on. The newest
80 decisions were shadowed (the 11 before only serve as context).

### Learning: before and after

Same 80 decisions, same licence policy (5 memories to judge, 80% over the last 10 to license, one
miss revokes, 3 in a row to end probation):

| Predictor | Where | Correct | Licensed at the end |
| --- | --- | --- | --- |
| `heuristic-v1` (milestone 1: time of day, previous category) | dry, in-process | 21/80 (26%) | none |
| `habit-v2` (transitions, session gaps, recency, lessons) | dry, in-process | 32/80 (40%) | stake |
| `habit-v2` | **mainnet, Walrus Memory** | **31/80 (39%)** | **stake** |

Per category on mainnet, first 40 vs last 40 memories (a memory counts for the category the user
acted in and the one predicted), and the final board:

| Category | 1st half | 2nd half | Final state | Last 10 |
| --- | --- | --- | --- | --- |
| swap | 0/13 | 0/8 | 👀 SHADOWING | 0/10 |
| send / transfer | 3/17 | 5/12 | 👀 SHADOWING | 5/10 |
| stake / unstake | 1/4 | 8/9 | ✅ LICENSED | 8/10 |
| claim / reward | 4/15 | 7/16 | 👀 SHADOWING | 5/10 |
| nft | - | - | 🔒 LOCKED | - |
| defi deposit / withdraw | 2/11 | 1/8 | 👀 SHADOWING | 1/10 |
| contract call / other | - | - | 🔒 LOCKED | - |

Learning curve (accuracy so far / over the last 10 memories), recalled back from Walrus Memory:

| Memory # | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| All so far | 20% | 35% | 30% | 25% | 26% | 27% | 33% | 39% |
| Last 10 | 20% | 50% | 20% | 10% | 30% | 30% | 70% | 80% |

The dip in the middle is the routine changing (new protocols in September); the climb is the
agent picking up the new routine from its own memories: from decision 65 on it gets 14 of the
last 16 right, predicting claim, redeem and send in order with 57-97% confidence. Licence events: claim, transfer, swap, defi and
stake reach SHADOWING; **stake becomes LICENSED on 2026-10-16** (80% over the last 10), and the
next redeem shows "stake was LICENSED: the agent would have acted alone (dry-run first)".
The misses that remain are honest: the user alternates between two deposit addresses, and one
session opened with a vault top-up instead of a claim.

### Live mode and dry-run

- `watch --once`: the board seeded from Walrus Memory (80 memories), then a standing prediction
  stored at 2026-10-20 05:57 UTC before any new transaction: *claim 1-10 vSUI via the vault*
  (confidence 72%), the user's current routine. No new transaction yet; 2 credits per poll.
- Dry-run builder checked on mainnet through Tatum (`sui_dryRunTransactionBlock`, nothing
  signed): the user's latest SUI transfer, rebuilt with current gas coins and gas price, returns
  `InsufficientCoinBalance` because the wallet had already sent its SUI on. That is the safety
  check working. Builders exist for transfers and native staking; the licensed category here is
  a liquid-staking redeem built by an aggregator, for which the agent reports that it would ask
  the user to sign.

### Board and portability

- `npm run web`: 80 memories, 39% (31/80), 5 of 7 categories judged, 1 licensed; cards, curve,
  events and timeline as above, with Suiscan and Walruscan links.
- **Restore** (fresh Walrus Memory client, no local files): board rebuilt from recall alone, 80
  memories and 31 correct, identical. The relayer's restore call reported 21 blobs for the
  namespace, all already indexed (`truncated: false`); its candidate list is capped per owner, as
  the SDK documents, while recall returned all 80.

### Operations

- Walrus Memory: 80 new memories in namespace `shadowright-v1:<short address>` (milestone 1's 12
  stay in `shadowright-v1`). Two relayer incidents, both handled by resuming from the journal:
  one upload job failed ("durable upload exceeded step budget") and succeeded on resubmission,
  and the account hit the relayer's 1,000 weighted requests/hour limit (my board tests were
  recalling hundreds of memories at once). Since then `remember` resubmits failed jobs with a
  fresh idempotency key, CLI runs wait out 429s using the relayer's retry-after, 502-504s are
  retried briefly, and the board recalls one category at a time and caches for 5 minutes.
- Tatum: ~4,450 credits in milestone 2, ~4,530 in total (of 100,000). Scouting took ~3,990 of
  them, about 1,000 over the 3,000 planned: page recovery for unreadable transactions halved
  pages down to single transactions, and the budget was only checked between wallets. Recovery
  is now capped at 8 extra calls per page and empty pages stop pagination. Backfills ~450, live
  mode and dry-run checks 8.
- Tests: 109 pass, typecheck clean.

| # | job | blob |
|---|-----|------|
| 1 | b9c666ad-951d-4714-9c9d-87c3fae27dfe | H5cPmTrs-foqdf2Ky5dbOiqpcolIQyRm-46bBvDbah4 |
| 2 | 5138fc61-8b82-4ee7-85e3-2899808a1fde | cOyK7Z61FweCYS30I0QkQ4XyIpkjjo1jgR2OehqFMug |
| 3 | 1c9409c8-1b4c-467e-a144-1c44e8fc6d68 | PhW-kAdBNUQdO8_hJDnq56B0jlkFEeRvyyd4qrR6Kp8 |
| 4 | 47e5679b-d2fe-4d97-b79b-c2d38e520058 | XCOMtkcjuRc3vDtdH22YYr_xKPK8RpGttsdLMRES4XY |
| 5 | 3ce99924-6ce1-4a10-9c02-f82675de8bb4 | 2s3iXkb3uSs3CQNonutMLUDt0ohYPK6pV9Qn8kkf50c |
| 6 | 34ff50ce-0669-413e-a5ec-6fbffa605022 | tnB_JqEeLUndJSpNibqc1gVob8o_Mt8kBkrIpdfkgzY |
| 7 | 6d9265c9-0b29-456c-b155-110a40fc7195 | -3ocDj03hk-HuyU2c1qfZT3CsNPFcHICc1zFoCpHK0g |
| 8 | 0ec98d25-027f-459f-99f5-c7d0a80551d0 | HPAMrwkuY83sBdATnbk0oJing-1Mr6YmuOWX5ltq4pk |
| 9 | 71bf5624-fb75-48f3-bd84-587b74712be8 | o1MRlpSTGfUFtGzkwO79Pi38Wusai4RU84yeeaHRoYE |
| 10 | 3fb9b071-44c2-4319-a551-f31580606683 | 5tVZAtFm6CptcQy3azVq7-Ycfik7S8CuPV6jaOPv2Is |
| 11 | 88129de0-94de-48fa-b994-b49ac94b2414 | OY7UABh9aFa6PdlJn9jJBXQp-Zj843m0MEHwihVHUFw |
| 12 | 9a88cd4d-394f-4a38-be08-c67e9f097b3f | Hw8-dR-KLkTHsGNDTo-Cbz04uU35dy1TpjNtw19h6PI |
| 13 | 543d4e27-8a42-4c93-bd9f-1ded4a27c8fe | zGKJDe3hyy-uO2jYtaqrV6HmTRSLiB6k5tPMOaTud_0 |
| 14 | faf59189-9245-410c-b772-774753024a19 | SXs-Bh-YGFUe-67wojiE7E5pADLPjojzar45qf_xAq8 |
| 15 | c9dff831-7430-442e-b125-703a3e1ff651 | OwCVw78l5p6WGNTXl_1JSkTTALsRie8WlZuJhom7G74 |
| 16 | 306cf95e-cc0f-49dc-a2de-fe9666d6012f | 6Sc8jxT0UQQkew6z6goSgHGkJtrR6NoX9l0z-m-jBsQ |
| 17 | f741067c-c36b-4f8f-849f-883cc6ecfaf9 | 89BqncX8NBbK26BIeMlfrQWWNyWkJkbf4Cxs8D69fcM |
| 18 | fab2bc1a-0177-4b91-9861-be46ebe5915b | dlZDsSmOoawrBOO8NwjJuCp--IDBYNl11NZ7k9v1HbU |
| 19 | 4eaf61a6-4f31-4de9-931a-8acdd2f1a031 | opVp7qMzz_e_kU2FY7JrXp8k3Gqd4XSX8L0gud4mUiY |
| 20 | f515b695-307b-4007-bd52-3c5118452b20 | VuMogABFN4ppKpSXdVisuZm6vV3TENxOXVLcJKbnFxU |
| 21 | fb4e4637-6ecb-496d-99ac-58b1448496b2 | IkyuUMY8-Nl1-ItFhbK5V0GJCf3zNBPMrBVhu9dI8hw |
| 22 | a2d7b9f4-0e73-4dfa-ac5b-4db86a633bda | 3xMWajlGg_RlyCjI4xgHdKd2Oky9S0eSVV40hh_x-vU |
| 23 | 37eead71-b471-4113-b5fc-db81d6d4b6a3 | nSDiZXX-tADmsZM8dYTcPHI63juZYlrEEKzjaZ1LKYM |
| 24 | af389603-84bb-4a76-95f7-e0a3574a3b2b | r_nHVKaF95MoEhQlz3R6My8d8KSjDOv1snzcr0s-3ww |
| 25 | c9887165-d583-43db-b056-09bd99cf5591 | 2bVs_4vBuCYYCKSEAoUCIVC8TtRtLxaZcb37V2hpKUY |
| 26 | faef386c-7678-464f-a434-731b0fb38482 | 9hbsNK_4qKJlU2TB59EwZr-MubyVw8FJ3xrhTdzPRtc |
| 27 | 1af4c1c8-82fd-4e2f-af1d-bb1506a0e96e | POCBEYIrmXD0-r0V47RqXdrtD5mK0GLfWudzTM7nwWw |
| 28 | 46729534-7f81-452c-861a-3775aeac02e4 | ZyZHG29i__5IHAeIemlvFKAd0aR837fHeUQzmKGNM20 |
| 29 | d8d959f2-c186-4a82-a8d8-6330ccbf6477 | 9iK6Rpp6WHEahKRsoUWiwJSH0g5f7HKQK6OEUu2hi5E |
| 30 | 2a3e2957-3eaa-41fc-adef-cd8d7287739c | h5P82Tp0hEiAGmF9vjUuM_P5YO-DkNkotUQ_dkSytS0 |
| 31 | 3514b00f-7f39-40af-bebe-94c3c729f872 | XyaRhDwpkToddk1P8a1_-EmfQJxy9ag5xLdJ8YKR2zA |
| 32 | e11a54d6-128a-40d6-83d2-19784942c30f | wPT_J6otJfnd8oaZNwcwLWa8Ov072r-SLefcf0tgITY |
| 33 | 9f1288e8-998f-42a9-85d8-d85fdede099c | wIeVMTCYBxHinNJe2OdZcPEq4y_Wg3DsqCFkKuQxaSU |
| 34 | d6fbc3ca-8cde-40db-ada2-012cb38e23d3 | XR2sUTqW4plXG2EKhiOAZ4SMXfK6Yd-qGVRQAAfpMpo |
| 35 | a72ace8d-dde1-4fc8-8b73-b41ef7654ed3 | ByP-g9JGWS-k6qujcLxuFyP-AVMS7jTGTbOFFnnqh2E |
| 36 | a1558a32-6ac8-4262-9efe-5c89a4921d2c | skIL66Co_MpwS-RdaTiMGZjr56KeYPH8WJCVauSAm8g |
| 37 | 8ff80b64-a679-4386-a1c4-0634521e50fb | faIi7-WVRF7zqwH_BQDLBix2QbhvP_pKlnLlIozDk7I |
| 38 | 0f8cab5f-8fa8-4217-9c94-26a5107b2a6c | 7Ifnr1vbmGy16R71pJfqLF1gRAypRbIBCBgXg2DMxkM |
| 39 | b66ca301-c575-4b9d-9a3b-4e094b64eca6 | AxVDKpcqeMCFmQfohkvpky9Rea6xUQSAJ6bZgnn5bIU |
| 40 | 72fbf628-b57d-4848-8a32-5931ac9c50e1 | FpKt9aEejIA-SbLKnvR_OSvvGQx93m2gV0Ss4mwen40 |
| 41 | 34b46316-b746-4318-a4be-35849ebd3a27 | goURK_FbG12jcoAzqldO9xOXghz-Ai-MtybM0yubPvU |
| 42 | bbbd7e0e-71b9-4599-aaad-814dac422169 | c7hP5YBSr45Ad-95LL2EZFvYD7ORG75q11erTbJwQr4 |
| 43 | e6501421-0bea-403b-be3b-890bb788018d | WTi_f8oVN8labIgR8h85koF7e0BV62dHvacGu_YhX04 |
| 44 | c37d2b1b-f1d1-47d8-b9ed-3d73f61e374b | C7L5b0O6ss_rPvIxdmnJj2X8YmPsmBxFolhYg8oEC0M |
| 45 | 2f791d53-7d65-4c9c-8fa7-7837a1d8c4a3 | MyCQNRNGnq7bQ0yVF2R3yJRrvwpKiw8i68B0nyZt6Ck |
| 46 | d8fe4297-4cd6-41b1-ad96-674fea88b295 | IAZq9nSt_lAXdKDLI7jcf8c0qxox9issBIXZeYP0DSM |
| 47 | 4617e49f-9613-473b-a2ae-a5204e9342b8 | -EFvVTUDTFYK7hi1DlOWPl_vS6DD8pnMuEsALy1KdpY |
| 48 | c7821d04-5dec-4b46-9ee9-3bb9f55f61a2 | 8T-LqG5EXHI0V904BdaF972Bd6p4Y3G7wSu4SmgJGa0 |
| 49 | 35b96317-ba03-4128-91c2-1884dc86fc68 | daO64XNNIon4V7CUWwOkQL-CakvrJO2MVrPKlELoM-I |
| 50 | 0dfdeece-712a-4607-8f88-44a9fe00116d | 8-4kBJSPdopjBz7YqVDvvXwIXhCSsUFys6WruUUnzJc |
| 51 | fabd83f8-982d-408e-ac44-929f2908a94f | qi3pNokIgGAU6-vPqBaIChX27JZJDyysRKf098-PBX0 |
| 52 | 7d3941b2-c5a2-4c0c-ae14-4521273d67c6 | _bPv6vx2ZUmCfZKb9iTP8L5PffHxrh3pBxSCv798_ZI |
| 53 | 20ee3dd1-c9a2-4a0e-92bb-462043fa08c5 | 2EVNKoprTXmxMACwY2602g4RpZw5PP0oHroLPPZ9E2U |
| 54 | fbf40bd7-4978-463d-96ee-abbaa63e5f15 | eMWDxHUzG_EYo3Wp8xSY-kbGHBt4z_RpfiZmvzJI1q8 |
| 55 | 0f0ff3be-7045-49e4-b8c5-aa8c596a36aa | UepAmOFfJQ229fCIpVRgzTa6QpA3f68nygCvrToY4dQ |
| 56 | 7207c8fc-7a16-488f-a715-a5b74f3e2ce7 | o04Yr1LsTeA2EE4jwionIrk5t_o7VOiG2ju7O-w6TQk |
| 57 | 1f323cbf-18fb-4a53-b176-2faf64b90cb1 | w4m2GqXMpPQEwGyyjvqcQ1GtGj7NRTI0zSNFKVuX6v0 |
| 58 | 1c71e481-2037-41c4-a2a4-99736a27b5fc | UsD-MPKh_syc7R_cs66uNbM1LbmrkZFS-Rymgy27s9s |
| 59 | 056c47de-3871-41d7-a8cb-5ddedf74ff2f | z9UntHjr-Krblo-ZwVjhekKFBSETO5J697XPKoYmLtw |
| 60 | a3fdd7ff-cb2e-4f62-a823-fabbf5b3756c | k1is0ceU04j8Uw50s-up3eZ7S6UEaCzEWLeH_QzQpDw |
| 61 | 63b55e39-1b19-42af-a486-08cc7222748c | do1EyX6QJboXV3xzJHAbHiVXe1XlqQW8ZSDjPe0s_Gs |
| 62 | c8ae02ba-4a7c-456f-b0db-c65b75016047 | YEKbWH4P3f1tSGsDz-W4hxqhouXMOnusUEEBPIFb4pw |
| 63 | 927f488e-e04f-406f-b8e7-47004d8f1984 | mPNodXTA0CbvbO0944VH3-rlKLWBsDZ7E-OvzoqLG2M |
| 64 | 3a9d27b6-7fbd-4dbb-b14b-f8f12ac45fcb | 4E5ywZVuaaOOqjhAMkyI6dU3MVf3Hl7NpKudtSkQ4kI |
| 65 | 42221514-1fd7-4458-9746-03a99f1fbb5e | NNCAqnCmOjG-LM7JuxI7UnoSk0MfmdhK9dUL8Sv_Qpk |
| 66 | 0d97b0ca-a9da-4ead-ac48-7634ab5284af | 0-fED67o2JmUIW6RyoFgOYgPTqGaoJ3Dio8ZGqJQ9_8 |
| 67 | 8952e2e8-55ec-4829-81fa-e21bb128acaf | B5tI_et418PKr8BcjGkxcreK94iuB0dBovjRx4DkcTQ |
| 68 | 27cb7de6-d728-4117-9b6d-d3976a74750e | VI8l_zZHMfa_cgzTJhr8K-fJ3WksD2LQPIIRKTb5kWw |
| 69 | 1fc78c13-e21f-423c-845f-6c8477d5a2ce | GDGE2MNPJLkHWnq5qu9HjYWVmC1Y1HGwElPbiavQPd8 |
| 70 | 613cb87c-a996-44f8-bebf-51d8e82aaa1a | NJ05HnSQ7hiis2oKsHIy-fRSBb_yGVQkxS8fPf6ljeo |
| 71 | b9f7a465-fc01-4c99-af1f-732874685c09 | RziPJ63pbhsfsgAvNZ-N8Z9PhfcmJcMBRK3pwUeFwPU |
| 72 | dfef8b0d-931f-4587-8bd4-f285a977eb00 | DW_M6XQFP4Y9SommCcEZEovtz0WAQdQZPoq1kAryl_o |
| 73 | c39f1671-d396-44d2-a1a0-20fe9ad99522 | yXVr4T4GkX-MDOM6WX8NqDyUtGqk9uAOshRs9NZI0cg |
| 74 | d69d20a3-d61d-4027-b4bd-3cf7f588dbfa | UG9wmSode1PkBhV1sHTbmbG4v6UoOarmad_zVrfFMxk |
| 75 | 55240ab2-310e-4556-a1a4-f21253172967 | YDBj1h_BIDbR0i8EKiL_RwIZHDYA_cxi2CC1x2jt9Pc |
| 76 | 74a095a8-12de-404b-8acc-63df0111cf85 | EX1xlIO-TrFkegoMIlNQsxgSH1mBbCKUoYUJhof7VV0 |
| 77 | de3a3907-5092-4a18-a353-8610cedfc031 | gg_FoY9HB8c-eK_goFRAvj9Mzh0nJzwaCqwS1XqXOPk |
| 78 | c083d7ac-d0fb-4b55-8a54-6daf8541e962 | QHVe1z0I_ASEUg3NvLMwPE9MpSbfzldVjQFlfA03XjY |
| 79 | 9f48ae24-16fc-46a0-bb41-cc8489ef4f0a | Cbo7YSL9DXBTXQDlCp1RmA11kuXexLVX-wWbq-Yb1eg |
| 80 | b7ebd3bd-3eee-47bd-b651-37f1e72df8c0 | -AnIMhy8d046yLdlGLY8qdMzG7DwbJrvHLKDAzOupQc |

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
