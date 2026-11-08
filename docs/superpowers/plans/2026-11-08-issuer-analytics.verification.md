# Issuer analytics: verification

The record of what was measured and checked for the plan `2026-11-08-issuer-analytics.md`. Each section says what was run, on
what, and what it does not cover.

## Build measurement

Measured on 2026-11-08 by running `token-history-build --threads 4` (the command of PR 1, from `apps/syncer/dist`) against a
ClickHouse 26.8.14.3 of its own in Docker (`127.0.0.1:18123`; 16 CPUs and 16 GB for the VM, a laptop shared with other work, the
tables warm in the cache). The figures are `system.query_log` of the statements the build tags `log_comment = 'token-history-build'`
(every query and command it sends; the few rows it inserts as values, such as checkpoint heads, are not in them), sorted into the
phases by the tables they touch, and `system.parts` of the tables afterwards. A fake lease row stood in for the `token_history`
worker, which comes in PR 2: no live window ran beside the build, so `h1 = h0`.

**Synthetic means that the shape is made up**, as for D6's measurement (`docs/operations.md`, "Measured on synthetic data"):

- `trust_line_states` is D6's shape and insert, with one change. 1,000,000 lines in 50,000 accounts, 5 state rows each
  (5,000,000 rows, 390 MiB, 3 partitions); one issuer has 200,000 of the lines in 3 currencies. The 8x table is 8 copies (40,000,000
  rows, 3.05 GiB, 400,000 accounts), the accounts moved by 100,000 and the holders by 400,000 for each copy.
- **The change:** D6's insert writes its amounts as `toString(x / 100)` of a Float64, which gives texts such as `954321.3700000001`
  (17 significant digits). No ledger balance has more than 16, and the build refuses them: its first run stopped with
  `amount has more than 16 significant digits`, as spec 3.4 says a write must. The amounts are `toString(toDecimal128(x, 2) / 100)`
  here, at most 8 significant digits.
- `ledgers` has every ledger from 70,000,000 to 98,000,999 (28,001,000 rows), so the head's unbroken run starts at 70,000,000 and
  the coverage is the whole table. The state rows sit in 5 clusters of 1,000 ledgers, so they fall in few hours.
- `mpt_holder_states`: 100,000 rows (20,000 holders of 10 issuances, 5 states each).
- `exchanges`: 2,000,000 rows, a third of them against the native currency, spread over the same clusters. The 8x database has
  the same `ledgers`, `mpt_holder_states` and `exchanges` as the 1x one: only the trust lines are 8 times as many.

The levels phase was first measured as Task 12 wrote it, one token at a time. It spent about 50 ms of round trips on each token, 20
tokens a second, so the 1x shape's 50,002 tokens would have taken some 40 minutes, and a mainnet token count hours. The run was stopped,
and commit `perf(shared): build the levels of small tokens many at a time` writes the hour rows of the small tokens of a batch (fewer
changes than the checkpoint floor, so no checkpoint is possible, and every amount fits the decimal) in one statement. The figures below
are after it.

### 1x

The whole build took **18 s** of wall time: `changes` 6 s (100 batches), `mpt_changes` 1 s (40 batches), `levels` 7 s (51 batches),
`dex` 3 s (3 partitions).

| Phase | Statements | Statement time | Rows read | Rows written | Peak memory |
| --- | --- | --- | --- | --- | --- |
| `changes` | 201 | 4.0 s | 27,543,283 | 3,000,000 | 665 MiB |
| `mpt_changes` | 121 | 0.5 s | 3,384,576 | 100,000 | 17 MiB |
| `levels` | 205 | 4.2 s | 29,245,752 | 1,204,130 | 87 MiB |
| `dex` | 14 | 1.2 s | 114,060,550 | (values) | 552 MiB |
| other (state, leases, coverage) | 705 | 1.0 s | 784,226,426 | 201 | 6 MiB |

- `changes` read 5,000,000 state rows into 3,000,000 change rows: about **1.25 million state rows a second** of statement time, 750,000
  written. A batch of 500 accounts ran at 340,000 to 1,300,000 change rows a second (median 410,000) of wall time. The peak, 665 MiB,
  is the batch that holds the issuer of 200,000 lines.
- `levels` wrote 257,130 hour rows and 15 checkpoints of 947,000 rows: the three currencies of the big issuer, with more changes
  than the floor, are the only tokens built one at a time.
- `dex` scanned the 2,000,000 exchanges and wrote 1,711,123 rows of `token_hourly_dex`, the sentinels of every hour from 2017 to 2021
  among them (an hour with ledgers and no trade has one).
- **"Other" read 784 million rows in about a second.** Nearly all of it is `unbrokenRunStart`'s binary search: some 27 counts over
  ranges of a 28-million-row `ledgers`. On XRPL (about 100 million ledgers) that is some 2.7 billion rows of one `UInt32` column, a few
  seconds. The build runs it once; the worker of PR 2 is to run it every 10 minutes for its `coverage` reason, which should then be
  measured and, if it shows, searched from the head down instead.

| Table | Rows | Disk | Bytes a row |
| --- | --- | --- | --- |
| `token_holder_changes` | 3,100,000 | 93.2 MiB | 31.5 |
| `token_checkpoints` | 947,000 | 22.0 MiB | 24.4 |
| `token_checkpoint_heads` | 15 | 3.1 KiB | — |
| `token_hourly` | 257,130 | 8.3 MiB | 34.0 |
| `token_hourly_dex` | 1,711,123 | 2.9 MiB | 1.8 |

### 8x

The whole build took **111 s** of wall time: `changes` 51 s (800 batches), `mpt_changes` 2 s, `levels` 54 s (400 batches of 1,000
tokens, 400,026 tokens), `dex` 3 s.

| Phase | Statements | Statement time | Rows read | Rows written | Peak memory |
| --- | --- | --- | --- | --- | --- |
| `changes` | 1,601 | 35.2 s | 244,174,751 | 24,000,000 | 667 MiB |
| `mpt_changes` | 121 | 0.6 s | 3,384,576 | 100,000 | 18 MiB |
| `levels` | 1,612 | 38.3 s | 474,526,366 | 9,632,340 | 87 MiB |
| `dex` | 14 | 1.2 s | 114,060,550 | (values) | 575 MiB |
| other (state, leases, coverage) | 4,226 | 5.8 s | 784,604,779 | 1,251 | 6 MiB |

- `changes` scaled with the rows: 40,000,000 state rows into 24,000,000 change rows, **1.14 million state rows a second** of statement time
  (0.78 million of wall time, the round trips and the state rows of the batches included), 680,000 written. A batch ran at 33,000 to
  1,320,000 change rows a second (median 390,000); the slowest statement took 0.8 s; the peak memory is the same 667 MiB, the batch of
  a 200,000-line issuer, so it grows with the largest account of a batch, not with the table.
- `levels`: 24 tokens (the 3 big currencies of 8 copies) were built one at a time with 120 checkpoints of 7,576,000 rows; the 400,002
  others in 425 statements of hour rows. About 630,000 changes a second of statement time, 440,000 of wall time.
- **`nextLevelTokens` reads more than it needs**: 402 calls read 358 million rows (some 890,000 each, where a batch has about 60,000),
  4 s of the phase's 38. The in-order `GROUP BY … LIMIT` is not stopped as early as `nextPassAccounts`'s is on `trust_line_states`;
  probably its parallel streams read ahead. It does not dominate here; a follow-up should measure it on real data before tuning it.

| Table | Rows | Disk | Bytes a row |
| --- | --- | --- | --- |
| `token_holder_changes` | 24,100,000 | 727.8 MiB | 31.7 |
| `token_checkpoints` | 7,576,000 | 175.2 MiB | 24.2 |
| `token_checkpoint_heads` | 120 | 3.4 KiB | — |
| `token_hourly` | 2,056,340 | 64.5 MiB | 32.9 |
| `token_hourly_dex` | 1,711,123 | 2.9 MiB | 1.8 |

### What it means for XRPL

The assumptions: the rates above (4 threads, warm tables, a laptop), XRPL's sizes of spec 2.6 and 9 (2 to 7 billion state rows read by
`changes`, 1 to 3.5 billion changes written and read again by `levels`), and rates that stay linear, as they did from 1x to 8x.

| Step | Spec 9 estimate | From the measured rates (warm) |
| --- | --- | --- |
| `changes` | 1 to 2 hours warm | 2 to 7 billion rows at 0.78 to 1.14 million a second: **30 minutes to 2.5 hours** |
| `levels` | hours | 1 to 3.5 billion changes at 0.44 to 0.63 million a second: **30 minutes to 2.2 hours** |
| `mpt_changes` | minutes | not measured at scale (100,000 rows); the rate is the same rule's, so minutes stands |
| `dex` | hours | **not measured at scale**: 2,000,000 synthetic exchanges, while the phase's reads were mostly `ledgers` |
| Total | half a day to two days | **1 to 5 hours warm**, before the DEX history and before a cold disk |

- **Cold disk.** The tables were in the page cache. On mainnet `trust_line_states` and the change log are hundreds of GB, read once each,
  so the disk's read rate bounds `changes` and `levels`: at 200 to 500 MB/s, 300 GB of state rows take 10 to 25 minutes of reading
  alone. That is the same order as the warm figures, so the spec's "half a day to two days" is pessimistic for these two phases; the
  DEX history is still unmeasured.
- **Disk.** The synthetic rows compress to 31.7 bytes a change, 24 a checkpoint row and 33 an hour row, because their addresses and
  amounts repeat. Real rows carry 34-character random addresses and amounts of up to 16 digits, so spec 2.6's 60 to 90 bytes a change
  stays the planning figure: **60 to 315 GB** for the change log. The synthetic figure, 32 to 110 GB, is a floor, not an estimate.
- **Peak memory** is set by the largest account of a `changes` batch (667 MiB for 200,000 lines of one issuer, the same at 1x and 8x)
  and by the DEX scan of one partition (575 MiB here). A mainnet issuer with millions of lines in one batch would need proportionally
  more; `--threads` and the batch size are the levers.
- **Not measured here:** real-shaped tables (the scratch sync's ClickHouse belongs to another session and was not touched), the
  DEX history at scale, a cold disk, the catch-up and promotion (PR 2), and the effect of a running build on the ingest and the api.

## Gates of PR 1

Run on 2026-11-08 in the worktree, every ClickHouse a testcontainer (`GH_CLICKHOUSE_URL` pointed at a closed port, so no process could
reach another server):

| Gate | Result |
| --- | --- |
| `pnpm build` | passed (at 2ee67c6; the later commits change tests and this file only) |
| `pnpm test` | passed: shared 3,098, exporter 12, syncer 1,944, api 2,708 |
| `pnpm --filter @gatehub/data-api-shared test:e2e` | 35 suites, 1,843 tests passed (at afdab7f) |
| `pnpm --filter @gatehub/data-syncer test:e2e` | 20 suites, 444 tests passed |
| `pnpm --filter @gatehub/data-api-service test:e2e` | 61 suites, 3,617 tests passed |

The first run of the shared e2e found two faults of this branch, fixed before the run above: `ClickHouseService.command` had been
made to resolve to a summary, which broke the types of five suites (now `commandSummary`, commit 2ee67c6), and the schema contract of
`ledger-writer.e2e-spec.ts` did not know the change log's dedup window (commit afdab7f).

## Gates of PR 2

Run on 2026-11-08 in the worktree at 0315449, every ClickHouse a testcontainer (`GH_CLICKHOUSE_URL` pointed at a closed port):

| Gate | Result |
| --- | --- |
| `pnpm build` | passed |
| `pnpm test` | passed: shared 3,098, exporter 12, syncer 1,964, api 2,708 |
| `pnpm --filter @gatehub/data-api-shared test:e2e` | 38 suites, 1,863 tests passed |
| `pnpm --filter @gatehub/data-syncer test:e2e` | 21 suites, 445 tests passed (`app.e2e-spec.ts` re-run at 5c8ab0c: 16 passed) |
| `pnpm --filter @gatehub/data-api-service test:e2e` | 61 suites, 3,617 tests passed |

The syncer e2e's first run failed one test of `app.e2e-spec.ts`: it let the aggregator boot on migrations 001, 014, 015 and 017,
and the aggregator now needs the token history's dirty ranges of 019 as well. The test applies 019 too (commit 5c8ab0c); the other
20 suites of that run passed, and the fix changes that test alone.

Run again at 0dfa8a2, after PR 1's review fixes were merged in (SIGTERM, the build lease read back, the exact coverage count):
build passed; unit shared 3,098, exporter 12, syncer 1,966, api 2,708; e2e shared 38 suites and 1,865 tests, syncer 21 and 445,
api 61 and 3,617, all passed.

## Gates of PR 3

Run on 2026-11-08 in the worktree at 3fcc730, every ClickHouse a testcontainer (`GH_CLICKHOUSE_URL` pointed at a closed port):

| Gate | Result |
| --- | --- |
| `pnpm build` | passed |
| `pnpm test` | passed: shared 3,101, exporter 12, syncer 1,968, api 2,743 |
| `pnpm --filter @gatehub/data-api-shared test:e2e` | 39 suites, 1,873 tests passed |
| `pnpm --filter @gatehub/data-syncer test:e2e` | 21 suites, 445 tests passed |
| `pnpm --filter @gatehub/data-api-service test:e2e` | 62 suites, 3,653 tests passed |

## Gates of PR 4, with the whole-branch review's fixes

Run on 2026-11-08 at ed0cbfb (the top of the stack, the fixes of every Part merged in), every ClickHouse a testcontainer:

| Gate | Result |
| --- | --- |
| `pnpm build` | passed |
| `pnpm test` | passed: shared 3,102, exporter 12, syncer 1,970, api 2,751 |
| `pnpm --filter @gatehub/data-api-shared test:e2e` | 39 suites, 1,880 tests passed |
| `pnpm --filter @gatehub/data-syncer test:e2e` | 21 suites, 445 tests passed |
| `pnpm --filter @gatehub/data-api-service test:e2e` | 62 suites, 3,653 tests passed |

The branches below hold subsets of this code: each fix ran its own suites there (the build, levels and state suites on
`-1-build`; the live, promote and repair suites and the worker's unit tests on `-2-worker`; the api's unit tests on `-3-routes`).
