# Final fix round: report

Branch `feat/ripple-dropin`, base `990195e`, head `190cbfc` (15 commits, 78 files, +2810 / −710).
Dispatch: `scratchpad/final-fix-dispatch.md` (C1/R106, I1/R107, I2/R108, I3, M1–M15, R109, R110).

**Status: DONE_WITH_CONCERNS.** Every finding is fixed and tested. Final verification is green and the output is clean.
The concerns (below) are about how far a few fixes reach, not about anything broken.

## Final verification

| Command | Result |
| --- | --- |
| `pnpm build` | exit 0 |
| `pnpm -r --no-bail test` | exit 0: shared 594, syncer 354, api 1000 = **1948 passed** (80 suites) |
| `pnpm -r --no-bail test:e2e` | exit 0: shared 350, syncer 167, api 1632 = **2149 passed** (40 suites) |

The logs are in `scratchpad/final-fix/final-{build,unit,e2e}.log`. They contain no console output, warnings, `FAIL` or `✕`.
The baseline before this round was unit 1919 and e2e 2096.

## C1 before/after numbers (my own throwaway ClickHouse 26.8.14.3)

I re-ran the reviewer's `limitby-experiment.sh` idea against the new query shape: `scratchpad/final-fix/limitby-experiment-v2.sh` (log: `limitby-experiment-v2.log`).
- Table: 256,000,000 rows, 64 partitions, 64 parts (after OPTIMIZE FINAL), shaped like `transactions`.
- One page is 201 rows (`ledger_index, tx_index, hash`).
- "Old" is `ORDER BY key LIMIT 1 BY key LIMIT 201` with a tuple-only marker.
- "New" is `readDistinctPage`: an inner `ORDER BY key LIMIT 402`, then outside it `LIMIT 1 BY key LIMIT 201`, with `keysetClause`'s leading-column bound.

| Page | Old read_rows / memory | New read_rows / memory | Under `max_memory_usage=100MB` |
| --- | --- | --- | --- |
| ASC first | 55,298,304 / 1251.8 MiB | **598,016 / 22.7 MiB** | old: Code 241 memory limit exceeded; new: 201 rows |
| ASC deep (marker in the middle) | 156,639,232 / 708.6 MiB | **335,872 / 4.5 MiB** | old fails; new 201 |
| DESC first | 49,520,640 / 875.1 MiB | **215,296 / 3.1 MiB** | old fails; new 201 |
| DESC deep | 150,675,456 / 589.5 MiB | **157,952 / 2.6 MiB** | old fails; new 201 |

The new first page (598k rows / 22.7 MiB) matches the reviewer's plain-inner-LIMIT figure (590k / 20 MiB). The "deep" rows show the second unbounded read I found (see C1 below): a deep page read the range from its start up to the marker.

I1 numbers (`scratchpad/final-fix/exchanges-all-experiment.sh`, log `exchanges-all-experiment.log`):
- Table: a synthetic `exchanges` table ordered by the pair first. 20M rows, 5,000 pairs of skewed size, 10 partitions over 100M ledgers.
- First page of 200, old: 20,000,000 rows / 1140.8 MiB.
- First page of 200, new: an edge read of `ledgers` (8,192 rows / 3.9 MiB) plus one window of exchanges (2,892,928 rows / 1.4 MiB).
- Deep page, old: 20,000,000 rows / 621.7 MiB.
- Deep page, new: 8,192 + 2,892,928 rows, 1.6 MiB.

## Per finding

### C1 (R106): paged reads use a plain inner LIMIT, with the dedupe outside it. Commit `f263ffe`

**Change.**
- New shared helper `packages/shared/src/query/distinct-page.ts` (exported):
  - `distinctPageSql` and `readDistinctPage` build `SELECT *, count() OVER () AS distinct_page_read FROM (SELECT <cols> FROM <table> WHERE … ORDER BY <whole key> LIMIT {distinct_page_cap}) ORDER BY <unique> LIMIT 1 BY <unique> LIMIT {distinct_page_limit}`.
  - `readGrowingCap` is the bounded loop. The room for duplicates starts at the page size (at least 16) and grows ×4 while a capped inner read comes out short. It stops at an uncapped read, or when the cap reaches the UInt32 maximum.
- Every paged read now goes through the helper (or the same shape):
  - transactions, with the **full `tx_by_type` key** (`tx_type, ledger_index, tx_index`, M11)
  - payments. The by-currency case now reads the keys from `payments_by_currency`, cuts the page from those keys, then reads the wide rows with `paymentsByKeys`. The old `IN` subquery hid whether the inner read was capped.
  - exchanges of a pair, accounts, account transactions (time and sequence modes), account payments (keys, then `paymentsByKeys`), account exchanges, balance changes, fees per ledger, raw fee_stats
  - the last-50 trades of a rate (`rates.service.ts`: `distinctPageSql` wrapped in the volume aggregate, plus `readGrowingCap`)
  - the candle bucket probe. Its `LIMIT 1 BY bucket` was the same problem. It now uses an inner LIMIT and `GROUP BY bucket` outside it, with a growing cap from 2,048 rows.
- **Additional finding, fixed here:** ClickHouse 26.8 does not narrow granules by a tuple comparison. A marker `(a, b) > (x, y)` made a page far into a list read the range from its start up to the marker. On the bulk test, the new shape alone still read 330k–530k rows.
  - `keysetClause` now emits `a >= x AND (a, b) > (x, y)` (or `<=` when descending) for keys of more than one column.
  - Callers that put the fixed prefix (account, pair, type, currency) into the tuple now pass only the varying key. The prefix in the tuple did not help the primary key (I measured it).
  - ADR-0004 is amended: its "O(1) deep pagination" was not true before this.
- Judged and left as they are:
  - aggregation reads whose `LIMIT 1 BY` has no `LIMIT` after it. They read their window by design: `aggregationSource`, `bucketVwaps`, `dayRows`, `pairSums`, active accounts, account reports and stats, `stats_hourly` and `volume_*` readers, `stats.job`, `volume.job`, the fees bucket windows.
  - the validations list (`GROUP BY` of one ledger hash, bounded by its validators)
  - `ledgers.service` (one ledger's transactions)
  - the syncer's `watermarkHour` (an unpartitioned table of about 100k hours) and `agg_dirty`
- Docs corrected: ADR-0003, ADR-0004, ADR-0007 (§Consequences), `docs/clickhouse.md` (new section "Reading a page: what stops the read", plus the guard text), `data-model.md`, `development.md` (the example now uses `readDistinctPage`), `troubleshooting.md`, `operations.md`. The code comments that claimed "stops after the page" are rewritten (`fees.service.ts`, `accounts.service.ts`, `payments.service.ts`, `exchanges.service.ts`, `fee-stats.service.ts`, `rates.service.ts`).

**Tests.**
- `apps/api/test/paged-reads.e2e-spec.ts` (new): read_rows regressions for every paged family.
  - Bulk: four separate inserts of 200,000 copies of a real row per table, merges stopped. That makes four parts, in four 1M-ledger partitions. `ledgers` gets a matching bulk with close times that grow with the index.
  - Each family asks for a page of 5 that starts inside the bulk, ascending and descending: transactions, tx_by_type, payments, payments_by_currency, exchanges pair, exchanges all, accounts_created, account_transactions, account_tx_by_sequence, account_payments, account_exchanges, balance_changes, ledgers (fees), fee_stats, candles, and the rate's last 50.
  - It asserts that every SELECT of the request on that table read at most 40,000 rows, taken from `system.query_log` and matched on the harness database plus `query_start_time_microseconds`.
- **RED** (old code, `red-paged-reads.log`): 30 of 32 failed. Reads were 100k–800k rows, for example transactions DESC 725,157, exchanges all 800,158, accounts 546,061, fee_stats 429,376.
- **GREEN** (`green3-paged-reads.log`): 34/34. Typical reads were about one granule per part, 16k–33k rows.
- Duplicates beyond the first read's room (same file): ledger 11616399 is written ten times into transactions, tx_by_type and account_transactions.
  - A page of 2 reads twice, caps 19 then 67.
  - Walking the pages gives every transaction once. The account walk does too.
- Plan tests: a new `test/support/plans.ts`.
  - `expectBoundedInOrderRead` checks the inner read's pipeline (`ReadPoolInOrder`, the read direction, no `PartialSortingTransform`).
  - It also checks that `EXPLAIN actions = 1` shows the `Limit` on the sort right above `ReadFromMergeTree`, which the old shape did not have.
  - It replaced the ReadPoolInOrder-only plan tests in accounts, account-transactions, account-payments, account-exchanges, balance-changes, payments, exchanges (pair and candles), and fees/fee_stats. Transactions gets a new one (with M11).
- SQL-shape and limit tests are updated to `distinct_page_limit` and `distinct_page_cap`.
- Shared unit tests: `distinct-page.spec.ts` (12). `rates.service.spec.ts` has a new test for the re-read.
- Shared e2e: the rates plan test asserts the inner read and its `Limit`.

### I1 (R107): /v2/exchanges of every pair, plus an API memory cap. Commits `f263ffe`, `6b508b9`, `190cbfc`, docs `7ee9fc6`

**Change.**
- `ExchangesService.all()` no longer uses `LIMIT 1 BY`. It reads windows of ledgers from the marker on and dedupes in code: adjacent equal keys, since a written-twice row sorts next to its copy.
- My first version (`f263ffe`) used doubling windows of 256 ledgers, like `collectBuckets`. The experiment showed that a 256-ledger window already reads most of its partition: the primary key can skip only the granules of large pairs. So doubling re-read the partition once per window.
- `190cbfc` sizes each window by `ledgers.exchanges_count` instead (`windowEdge`):
  - one in-order read of `ledgers` with a plain `LIMIT {count}` and a running sum finds the ledger by which the exchanges from the marker on reach the page
  - then one window of exchanges is read, as a top-N with room for duplicates
  - a window that holds fewer than counted (a marker inside its first ledger, `autobridged`, a duplicated ledger row) is followed by one sized for twice as many, up to 1M exchanges
  - usually that is one read of each table, however long the gap before the next exchange
- Results are identical: every existing all-pairs test passes.
- Memory cap:
  - `deploy/.env.prod.example` adds `API_CLICKHOUSE_MAX_QUERY_MEMORY=2147483648` (2 GiB).
  - In `docker-compose.prod.yaml`, the api env maps it to `GH_CLICKHOUSE_MAX_QUERY_MEMORY: ${API_CLICKHOUSE_MAX_QUERY_MEMORY:-${GH_CLICKHOUSE_MAX_QUERY_MEMORY:-0}}`. The syncers keep the shared value.
  - `docker compose config` with the example renders 2147483648 for both apis and "0" for both syncers.
  - Documented in `configuration.md`, `clickhouse.md` and `troubleshooting.md`.

**Tests** (exchanges e2e).
- The window starts at the marker and ends where `exchanges_count` reaches the page. One read of each table.
- Descending runs back from the marker.
- The first page of the default window costs one read of `ledgers` and one of `exchanges`.
- The cap is the page plus its room.
- A window that holds fewer than counted is followed by one sized ×2 (counts `[4, 8]`, the second window starts after the first).
- The SQL has no `LIMIT 1 BY`.
- autobridged walks are complete (xrpl-recorded, limits 1 and 2).
- The Xahau synthetic-rows test now also sets the `exchanges_count` that the LedgerWriter would have written.
- **RED** before `190cbfc`: 4 failed of 207. **GREEN**: 208/208. The bulk read test covers "every pair" as well.

### I2 (R108): live Cache-Control and the limit=all deadline. Commit `e0ae44d`

**Change.**
- `account-ledger.ts` gains three helpers:
  - `liveCacheControl(ttl)`: `private, max-age=⌊ttl/1000⌋`, or `no-store` at 0
  - `LiveDeadline`: a 30 s overall deadline for `limit=all`, checked before every page and raced against every node request
  - `pagedLedger` (see M3)
- The `/balances` and `/orders` controllers set the header on success through `@Res({passthrough:true})` (type-only Express import). The global header stays for every other route, and errors stay `no-store`.
- Past the deadline the read throws, and the route answers its 500 (`unable to retrieve balances` or `orders`).

**Tests.**
- Unit: 22/22 in `account-ledger.spec.ts`, which covers the header for 10000, 1500, 999 and 0, the deadline check and race, and that a numeric limit has no deadline.
- e2e for balances and orders:
  - `private, max-age=10` for JSON and CSV with the default TTL, and `no-store` on an error
  - `no-store` when the live cache is off
  - `limit=all` with a stub whose pages each take 11 s of a mocked `Date.now`: 500 after 3 pages
- **RED**: I stashed the implementation and ran the suites. 10 failed of 154. The first RED attempt ran out of memory, because the old code paged an endless stub forever (which is what R108 fixes); I bounded the stub to 10 pages. **GREEN**: 154/154.

### I3: validations e2e for a refused node. Commit `2b8c7bd`

My call: I trimmed the test to what a real connection can show, and did not try to drive the gate from e2e.
- The gate of a refused feed (`feed.rejected` / reporter undefined) is covered by unit tests in `validations-collector.spec.ts`: "refuses a node of another network: it is stopped and none of its messages is recorded", and "is not believed … which was refused".
- I tried to drive it from e2e: the fake node streamed a validation and a manifest right after it answered `server_info`, with spies on the stream handlers. In 3 runs the messages arrived either before the refusal (the feed was not yet rejected) or not at all. No test can reliably hit the window between the refusal and the close.
- So the e2e now asserts the refusal itself: `server_info` asked once, no reporter, the connection closed and not reopened within 1.5 s (the first reconnect would come after 1 s). The test comment explains why. Passed 3/3 runs, and in the full suite.

### M1 (R54): a sub-second start is truncated. Commit `aead1b4`

- `LedgerRangeResolver.resolve` now uses `Math.floor` for `start` (the end still rounds up).
- Unit test: `12:00:10.001` and `.999` resolve to ledger 11 (RED 1 failed, GREEN 24/24).
- e2e in transactions: `start=…18:27:10.750Z` includes the ledgers that closed at :10 (RED 1 failed of 163, GREEN 177/177).

### M2 (R55): a malformed percent-escape is a Ripple 400. Commit `e5d16c8`

- New `apps/api/src/common/path-decode-errors.ts`, an Express error middleware. `AppModule.onModuleInit` adds it, and Nest calls that hook between registering the routes and registering its own exception handler (checked in `@nestjs/core` `init()`).
- For a `URIError` with status 400 on a `/v2` path (case-insensitive) it answers `400 {"result":"error","message":"Failed to decode param '<segment>'"}` with `no-store`. Anything else passes on.
- The message: the reference server had no error handler, so Express's finalhandler answered with Express's own text, `Failed to decode param '%zz'`. I keep that text and name the segment that could not be decoded. Here the first layer to fail is the `*` middleware, whose parameter is the whole path, so passing on Express's own message would have read `'v2/accounts/%zz/payments'`.
- Documented in `api-reference.md` and ADR-0010.
- Tests in errors e2e: `%zz`, `%E0%A4%A` and `/V2/ledgers/%/validations` give the Ripple body; `%41%42` decodes and gives 404 `transaction not found`; `%4G` gives 400. main.e2e checks the real toolbox bootstrap. RED 2 failed, GREEN 35/35 (main 12/12).

### M3: a ledger_hash given by the client is kept for later pages. Commit `e0ae44d`

- `pagedLedger` keeps a hash, or a number the client gave, for the pages after the first. Only a word (`validated`, `closed`, `current`) becomes the answered index. Used by `account_lines` (balances) and `account_offers` (orders).
- Tests: in balances, `ledger_hash` is forwarded to `account_lines` and limit=all pages on the hash; in orders, every page is asked of the hash. The old orders test asserted the replacement and is rewritten. They were in the 10 RED failures.

### M4: orders `freshAccount`. Commit `e0ae44d`

Six accounts now (one spare), and the function throws when they run out instead of returning `undefined`. Balances had five accounts for five tests; it gets a spare too.

### M5: linear counterparties. Commit `b03f423`

`toReports` now pushes onto the list instead of copying it. The unit test uses 100,000 counterparties in one day: RED took 8,219 ms against a 1,000 ms bound, GREEN 21/21.

### M6: operations and security docs. Commit `2fa5040`

- `operations.md`: the migrate step (:55) uses `--scale` and says why. The node-endpoint fix (:191) uses `dc up -d syncer-xrpl`. Key rotation repeats the `--scale` flags.
- `security.md`: the zero-downtime claim is reworded (a brief 502 per network on each key change).

### M7 + M13 (R110): range-ingest. Commits `6c5cfbe`, `2fa5040`

**(a) Whole-range redo.**
- The redo of an unfinished intent writes every uncommitted ledger of its recorded range (`redoTargets`), also outside `[from, to]`.
- Exception: inside its own range, an index-list run (API only) keeps to its listed indexes.
- It marks `agg_dirty` for the close-time window of all committed ledgers of the group: the ones that were there and the ones it wrote. Those are added to `redone` so the chunk loop does not mark them twice.
- `docs/backfill.md` (the resume bullet) and `syncer.md` are updated.

**(b) Gap refusal.**
- `assertNoGap`: if the database has any `syncer_lease` row for the network (a live syncer has run on it, fresh or released) and `from > checkpoint + 1`, the run is refused unless `--allow-gap` / `allowGap`.
- The message names the gap and the flag.
- Documented in backfill, syncer and operations. The CLI USAGE text is updated.

**Tests** (range-ingest e2e).
- The merged-intents test now expects L(5)..L(8) written (the old test encoded the bug).
- New: a narrower rerun (`[L12, L14]` over an intent `[L1, L14]`) fetches L4..L14 and marks `[T0, T0+14h]`.
- Refused with the lease released; allowed with allowGap and from checkpoint + 1; not refused with no lease row.
- CLI parse `--allow-gap`.
- RED: 4 failed (plus the parse unit test). GREEN: 84/84 and 23/23.

### M8: R105 test margin. Commit `6c5cfbe`

`maxTransientWaitMs` is now 400 (160 ms of margin; the whole run is still longer than the budget).

### M9: the --max-wait log text and the fetchAll doc. Commit `6c5cfbe`

- When a rate-limit pause would end after the remaining budget, the log now says: `the node asked for a pause of 929.6 s, longer than --max-wait (60 s) without a ledger allows: failed at once`.
- The budget-exhausted text is unchanged. An `lgrNotFound` backoff step past the deadline keeps it too.
- The stale `fetchAll` doc is rewritten (fetches that are waiting are woken and abandoned).
- Test: the "longer than the budget" case asserts the new message and that "no ledger fetched" is absent.

### M10: Xahau `--concurrency`. Commit `2fa5040`

`docs/operations.md`, the `docker-compose.prod.yaml` comment and `backfill.md` (its example and bullet) now use `--concurrency 1 --chunk 100`, and say why: `wss://xahau.network` throttles even one fetch at a time. `syncer.md` gives 1 for Xahau and 2 for XRPL's public nodes.

### M11: the tx_by_type key

Fixed with C1. `TX_BY_TYPE_ORDER` is now `tx_type, ledger_index, tx_index`. The transactions e2e plan test asserts the ORDER BY and the bounded in-order read for both tables.

### M12: CSV Content-Disposition. Commits `10418d4`, `6c7b1aa`

- `csvContentDisposition(name)` writes `attachment; filename="<ascii>"; filename*=UTF-8''<RFC 5987>`:
  - the quoted name escapes `"` and `\`, and turns anything but printable ASCII into `_`
  - control characters and lone surrogates become `_` in both forms
  - `'()*` are percent-encoded
- The visible name (`filename*`) is the reference's name, unchanged.
- Unit tests cover `;`, `"`, a backslash, spaces, non-ASCII, `'()*`, a lone surrogate and the old hostile name: 33/33, RED 10 failed. The test against `res.csv` of the original now compares the other headers and the parsed name.
- 47 e2e expectations use `support/csv.ts` `csvDisposition`.
- Documented in `api-reference.md`.

### M14 (R109): private by default. Commits `e0ae44d`, `344e077`, `f3ca28c`

- The `GH_CACHE_CONTROL` default is now `private, max-age=60`.
- `deploy/.env.prod.example` set `public, max-age=60` explicitly, which would have overridden the new default. It is now `private` too, with the reason given in the file.
- Tests: the config spec default and the errors e2e header.
- Docs: `configuration.md`, `api-reference.md` and `security.md`.

### M15: ADR-0010 §5, spec errata, api-reference. Commit `e5d16c8`

- ADR-0010 §5 becomes "Closed in the final review (were known gaps)". Items 37–39 state what is served now (R54, R55, R108/R109).
- The spec's "As built" bullet names the fixes and adds a C1/R106 paged-reads bullet.
- `api-reference.md`:
  - the error section's exception note is replaced by the R55 behaviour
  - `start` truncation is documented
  - the balances and orders caching text (formerly lines 737–738) now describes the live `Cache-Control`, the 30 s deadline and the hash paging

## Self-review

- **Helper contract.** `unique` must give the order of `orderBy` once the columns the query fixes are left out (or a monotonic function of it: `ms` against `ts` for fee_stats). Every caller fixes its prefix with `=`. The helper strips `distinct_page_read` from the rows.
- **Params.** The read's own names (`distinct_page_cap`, `distinct_page_limit`) do not collide with the callers' (`k*`, `min`, `max`, `fetch` in candles).
- **Keyset bound.** It applies to every multi-column list, including validations' single-column clause, which is unchanged. The `k0` parameter is used twice; ClickHouse accepts that.
- **paymentsByKeys.** The page is now cut from the keys. A key whose wide row is missing can no longer end the list early, as it could before.
- **Order of the wide fetch.** The wide rows come back in key order through a map. Duplicates of the wide row collapse in the map.
- **Lazy materialization.** It sits under the inner top-N, and the plan parser ignores `LazilyReadFromMergeTree`. The `Filter` steps that ClickHouse sometimes puts between the sort and the read are skipped.
- **Formatting.** Prettier was run on every changed file. It reorders `packages/shared/src/index.ts`'s exports (organize-imports); I kept that file's change to the one export line.
- **Process honesty.**
  - `readGrowingCap`'s own unit tests and the M11 plan test were written after the code: their behaviour was already covered by RED tests of `readDistinctPage` and the paged-reads suite.
  - The duplicates-beyond-room e2e would pass on the old code too (its `LIMIT 1 BY` was correct, only expensive), except for its two-reads assertion.
  - The 40,000-row bound of the paged-reads suite is a constant of its layout (about a granule of each part the rest of the range spans). With many small parts the bound would need to grow with the part count.

## Concerns

1. **I1 window cost depends on the pair layout.**
   - A page now costs one bounded read of `ledgers` plus one window. On the synthetic long-tail table, that window still read 2.9M rows (about one partition's worth of the small pairs' granules) against 20M before. Memory dropped from 1.1 GiB to 1.4 MiB.
   - With the real XRPL distribution, a busy year's partition can hold tens of millions of rows, so a page may read millions of narrow rows. That is far below the whole history, but not page-sized.
   - A page-sized read needs a ledger-ordered access path for exchange keys (an `exchanges_by_ledger` table or a projection `ORDER BY ledger_index`). That is a schema and syncer change, which I left as a follow-up.
2. **all() trusts `ledgers.exchanges_count`.**
   - The LedgerWriter writes it from the same rows, and the lists serve committed ledgers only.
   - But exchange rows of a ledger whose row counts 0 (hand-inserted test data, a bug elsewhere) are not listed by `/v2/exchanges`; they are still listed by the pair route. The Xahau test had to set the count.
3. **R110 gap rule.**
   - "A live syncer has run" means any `syncer_lease` row for the network. A database where a live syncer ran once and that is now filled only by range ingests needs `--allow-gap` for an out-of-order backfill.
   - The redo of an index-list intent writes every ledger of its recorded range outside the run's `[from, to]`. An importer whose source lacks those ledgers fails there, and the intent stays open.
4. **Ordering of checks.** A malformed-escape request without a key gets 400, not 401: the decode fails before any guard runs. It reveals nothing.
5. **Plan parsing is version-specific.** The plan tests parse the `EXPLAIN actions = 1` text of 26.8.14.3 (`Prefix sort description`, the `Limit` attribute). A ClickHouse upgrade may need the parser in `test/support/plans.ts` adjusted; the read_rows tests are the version-independent check.
6. **Downstream caching.** Deployments that relied on a CDN caching `/v2` answers publicly lose that with R109 unless they set `GH_CACHE_CONTROL` back to `public`, and only behind a cache that keys on the API key.

## Housekeeping

- My throwaway container `final-fix-ch-30114` was removed after the experiments. I touched no other container, and testcontainers cleaned up their own.
- I created files only in `scratchpad/final-fix/` and the repo. No env file was read or edited.
- No public node was contacted.
