# Account and Market Aggregates (D2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give data-api-new everything the explorer's AccountAnalytics and Markets boards read (sub-project D2, phase 1): precomputed daily native rates, hourly pair stats, markets sets and heavy-account rollups; four `GET /v2/accounts/{address}/analytics/*` routes; `interval` on `stats/{family}` and `reports`; and `GET /v2/network/markets`, with no AMM field.

**Architecture:** Migration `003` adds nine `ReplacingMergeTree(version)` aggregate tables. Their set functions live in `packages/shared/src/aggregate/` (one file per job). Four self-contained runners in `apps/syncer/src/aggregator/*.job-runner.ts` schedule those functions, and a small registration diff of `aggregator.service.ts` adds the runners to the tick and to the `agg_dirty` hooks. The API reads account aggregates through shared *day groups*: the same rows come from an account's raw key ranges or from its rollups. It values them with a shared `DailyRates` reader, which uses `native_rates_daily` for valid days and `RatesService.dailyNativeRates` for the rest. `network/markets` reads one `markets_live` set.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 via `@clickhouse/client`, bignumber.js, Jest/ts-jest, testcontainers ClickHouse for the e2e suites, a pnpm workspace (`packages/shared`, `apps/api`, `apps/syncer`).

**Spec:** `docs/superpowers/specs/2026-10-19-account-market-aggregates-design.md`. The plan argues from the spec; executors read both. Sections 1–17 and "Owner decisions to confirm" are in scope, and the owner approved them. **Not in this plan: the section "D2b — AMM data additions".** D2b is its own sub-project, planned later, after the owner merges `feat/amm-data` into `main`. Section 17's merge recipe is a deliverable of this plan (Task 16).

**Branch:** `feat/explorer-data` of data-api-new, in the worktree `/Users/golobitch/github.com/GateHubNet/data-api-new/.worktrees/explorer-data`. D1 is built first on this branch (plan `docs/superpowers/plans/2026-10-19-validators-amendments.md`). It takes migration `002_validators_amendments.sql` and ADR-0012. D2 uses nothing of D1 except those two numbers. Nothing of `feat/amm-data` is merged or used.

## Global Constraints

- Never touch the main checkout `/Users/golobitch/github.com/GateHubNet/data-api-new` or the branch `feat/amm-data`. Read them only with `git -C /Users/golobitch/github.com/GateHubNet/data-api-new show feat/amm-data:<path>`. Delete no file, and remove code only where a task says so.
- **Stay out of the AMM branch's files.** Edit no file that `feat/amm-data` changes, except the meeting files of spec §17 and the files a task names. Never edit:
  - `packages/shared/src/aggregate/volume.job.ts`, `packages/shared/src/query/asset.ts`;
  - `apps/api/src/common/params.ts`, `apps/api/src/common/pagination.ts`, `apps/api/src/app.module.ts`;
  - `apps/api/src/exchanges/exchanges.service.ts`, `apps/api/src/network/volume.controller.ts`, `apps/api/src/network/volume-object.ts`;
  - `apps/api/src/accounts/account-exchanges.*`, `apps/api/src/accounts/account-exchange-object.ts`;
  - `apps/syncer/test/aggregator-fakes.ts`, which is new on the AMM side. D2's fakes go in `apps/syncer/test/aggregate-job-fakes.ts`.
- **Storage.** The new tables are `ReplacingMergeTree(version)` and only the aggregator writes them. No ingest change and no `PARSER_VERSION` bump.
  - A recompute writes a complete **set** in one insert under a new version: max(ClickHouse `now64(3)` in ms, newest version of the set + 1). This is `nextSetVersion`, Task 2.
  - Readers keep the newest version of a set and never use `FINAL`. A row written twice is read once (`LIMIT 1 BY` its key).
- **Migration and ADR.**
  - The migration file is `packages/shared/schema/003_account_market_aggregates.sql`. It holds nine `CREATE TABLE IF NOT EXISTS` statements and nothing else. Each statement's semicolon ends its last line, and no comment line ends with `;`.
  - The ADR is `docs/adr/0013-account-and-market-aggregates.md`.
  - If `main` gets another migration or ADR first, D1 and D2 take the next free numbers, D1 before D2.
- **Windows and finality.** Only committed ledgers count: every window becomes a range of `ledgers` first.
  - A day is **final** when the newest committed ledger closed at least `VOLUME_DAY_SETTLE_MS` (1 h) after the day's end.
  - An hour is final when the newest ledger closed at or after the hour's end.
- **Constants** (in shared unless noted):
  - versions: `RATES_DAILY_CONFIG_VERSION = 1`, `PAIR_HOURLY_CONFIG_VERSION = 1`, `ACCOUNT_ROLLUP_CONFIG_VERSION = 1`;
  - sizes: `PAIR_HOURLY_DAYS = 31` (the table's TTL is 45 days), `ACCOUNT_ROLLUP_SLICE_ROWS = 2_000_000`, `ACCOUNT_PARTITION_ROWS_FLOOR = 10_000`, `QUOTIENT_DIGITS = 17`;
  - in the syncer: `MARKETS_LONG_EVERY_TICKS = 5`, and the budgets `AGGREGATOR_PAIR_HOURLY_BUDGET_MS = 3000`, `AGGREGATOR_MARKETS_LIVE_BUDGET_MS = 3000`, `AGGREGATOR_RATES_DAILY_BUDGET_MS = 8000`, `AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS = 8000`.
  - Budgets and cadences are constants, not environment variables. The one new variable is `GH_ACCOUNT_ROLLUP_MIN_ROWS` (syncer, default `1000000`, plain digits; `0` turns `account_rollups` off).
- **Job failures.** A failing set is logged and counted (`syncer_aggregator_errors_total{job}`) and never stops the loop.
  - A set that keeps failing waits 5 min, doubling up to 1 h. The wait is kept in memory.
  - A job gives up after 3 failed sets in a tick.
  - A shutdown aborts the set in flight before it writes (`AggregateSetAborted`). That abort is neither logged as an error nor counted.
- **Amounts** are exact decimal text, summed as `Decimal256(30)` with Float64 shadows and the `sumOf` fallback of `packages/shared/src/query/decimal.ts`.
- **Valuation.**
  - The native currency is worth itself.
  - An issued amount is worth amount ÷ the rate of its asset on its UTC day. The quotient is cut to 17 significant digits per (group, day). It is 0 without a rate or with a rate of 0.
  - Sums of values are exact.
  - A balance change's asset is `(currency, counterparty)`, or `(currency, account)` when its `final_balance` is negative.
- **No AMM field is ever served** (spec §8): no `amm` key, no `amm_share`, `amm_pool` or `totals.amm_share`. `amm` is not a parameter: it is ignored like any unknown one. D2 writes `pair_hourly.source = 'book'` and `markets_live.amm = 'include'`, and NULL in `amm_share`, `amm_pool` and `total_amm_share`.
- **Answers.**
  - Amounts and values are exact decimal strings (BigNumber `toString()`), counts are numbers, and times are `YYYY-MM-DDTHH:mm:ssZ`. A bucket date is the bucket's start.
  - A key without a value is left out; `null` is never served.
  - Object key orders are exactly as the tasks list them, pinned by `Object.keys` tests.
  - Errors are `{result:"error", message}` through `badRequest` / `@RippleRoute`.
  - `Cache-Control` is the global `GH_CACHE_CONTROL` (`private, max-age=60`); no route sets its own.
- **Analytics windows** are whole UTC days, from the day of `start` to the day of `end`, with `end` included. The defaults are `2013-01-01` and now. `interval` is `day`, `week` (from Monday, as `toMonday`) or `month` (calendar), all UTC: the buckets of `apps/api/src/network/volume-buckets.ts`.
- **Exact messages:**
  - parameters: `invalid start date format`, `invalid end date format`, `invalid interval - use: day, week, month`, `choose a date range of at most 1000 buckets`, `invalid sort - use: value, count`;
  - lines: `counterparty cannot be specified for XRP` (`XAH` on Xahau);
  - markets: `invalid period - use: day, 7day, 30day`, `invalid min_trades`, `exchange currency must have an issuer`, `XRP cannot have an issuer` (`XAH`), `invalid exchange issuer address`;
  - reports: `choose a date range less than 200 days`, `choose a date range less than 200 weeks`, `choose a date range less than 200 months`, `payments can only be listed with interval day`;
  - 500s: `unable to retrieve balance history`, `unable to retrieve balance changes`, `unable to retrieve counterparties`, `unable to retrieve exchanges`, `unable to retrieve markets`.
- **Repo rules.**
  - Bound parameters only (`{name:Type}`), and table names from the `Table` enum.
  - Export what the apps use from `packages/shared/src/index.ts`.
  - Run Prettier (`pnpm format`) before each commit.
  - The apps import the compiled shared package, so run `pnpm --filter @gatehub/data-api-shared build` after changing it and before the app tests.
  - `pnpm build` (the typecheck) and the unit suites of every package touched must pass before each commit.
- **Commits** use Conventional Commits with the repo's scopes (`feat(shared)`, `feat(api)`, `feat(syncer)`, `test(api)`, `docs`, …). Every message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A heavy account whose rollup covers only part of the window** (a promotion under way, or days after `rolled_through`): every route answers byte for byte as with no rollup. Pinned by Task 6 `account-day-groups.e2e-spec.ts` "rolled-up groups equal raw groups: complete, partial before, partial after", and by the "same answer rolled up" tests of Tasks 11, 13 and 14.
- **A client that sends no `interval`**: `stats/{family}` and `reports` answer exactly as before, whether a day's rate comes from `native_rates_daily` or is computed on read. Pinned by Task 11 Step 1 (`apps/api/test/account-parity.e2e-spec.ts`, snapshots taken before any route changes), rerun in Task 12.
- **An issuer (lines it owes, negative balances)**: its owed changes are valued as its own IOU, its owed balances are served negative and ranked by |balance|, and they are worth 0 in `stats/value`. Pinned by Task 3 `valuation.spec.ts` and the issuer tests of Tasks 11 and 13.
- **Bucket edges**: weeks from Monday, calendar months, the current bucket "so far", `end` included, an `end` before `start`, the 1000- and 200-bucket limits, and the error order. Pinned by Task 13 `analytics-window.spec.ts`, Task 12 `account-report-window.spec.ts` and Task 11 `account-stats-interval.e2e-spec.ts`.
- **Markets when data is missing**:
  - a `pair_hourly` gap leaves the previous set in place;
  - a fresh database answers `{result, period, count: 0, markets: []}`;
  - a pair without a native side gets its native volume through its base's (else its counter's) native pair in the same window;
  - no AMM key ever appears.

  Pinned by Task 5 `markets-live-job.e2e-spec.ts`, Task 8 `markets-live.job-runner.spec.ts` and Task 15 `network-markets.e2e-spec.ts`.

---

### Task 1: Migration 003 and the nine tables

**Files:**
- Create: `packages/shared/schema/003_account_market_aggregates.sql`
- Modify: `packages/shared/src/clickhouse/tables.ts` (nine entries after `VolumeLive`, in "Written by the aggregator")
- Modify: `packages/shared/src/clickhouse/rows.ts` (nine row interfaces in "Aggregates")
- Modify: `packages/shared/test/sample-rows.ts` (`TableRows` and `SAMPLE_ROWS`)
- Modify: `packages/shared/test/migrate.e2e-spec.ts` (`SHAPES`, three tests)
- Test: `packages/shared/src/clickhouse/schema.spec.ts` (as D1 left it; it now also checks 003, which holds only `CREATE` statements), `packages/shared/test/migrate.e2e-spec.ts`

**Interfaces:**
- Consumes, from the D1 plan: only that `002_validators_amendments.sql` exists and sorts before 003.
- Produces:
  - `Table` entries: `NativeRatesDaily = 'native_rates_daily'`, `PairHourly = 'pair_hourly'`, `MarketsLive = 'markets_live'`, `AccountRollupState = 'account_rollup_state'`, `AccountPartitionRows = 'account_partition_rows'`, `AccountRollupDays = 'account_rollup_days'`, `AccountLinesDaily = 'account_lines_daily'`, `AccountTxDaily = 'account_tx_daily'`, `AccountTradesDaily = 'account_trades_daily'`.
  - Row types `<Enum key>Row`: `NativeRatesDailyRow`, `PairHourlyRow`, `MarketsLiveRow`, `AccountRollupStateRow`, `AccountPartitionRowsRow`, `AccountRollupDaysRow`, `AccountLinesDailyRow`, `AccountTxDailyRow`, `AccountTradesDailyRow`.
  - The row fields are the columns below, in order, with the type mapping of the `rows.ts` header. An `Enum8` is its label union, and `Array(Nullable(String))` is `(string | null)[]`.

- [ ] **Step 0: Commit this plan** — `git add docs/superpowers/plans/2026-10-19-account-market-aggregates.md`, message `docs: account and market aggregates (D2) implementation plan`.
- [ ] **Step 1: Write the failing tests** in `migrate.e2e-spec.ts`.
  - `SHAPES` gains the nine tables, each with engine `ReplacingMergeTree` and version `version`:

    | Table | Partition | Order |
    | --- | --- | --- |
    | `native_rates_daily` | `toYear(day)` | `currency, issuer, day` |
    | `pair_hourly` | `toDate(hour)` | `hour, base_currency, base_issuer, counter_currency, counter_issuer, source` |
    | `markets_live` | `''` | `period, amm, base_currency, base_issuer, counter_currency, counter_issuer` |
    | `account_rollup_state` | `''` | `account` |
    | `account_partition_rows` | `''` | `partition, account` |
    | `account_rollup_days` | `toYear(day)` | `account, day` |
    | `account_lines_daily` | `toYear(day)` | `account, day, currency, counterparty, change_type, owes` |
    | `account_tx_daily` | `toYear(day)` | `account, day, tx_type, result` |
    | `account_trades_daily` | `toYear(day)` | `account, day, base_currency, base_issuer, counter_currency, counter_issuer` |

    The existing tests "exactly the tables of the Table enum", "is queryable", the round trip and "DateTime(UTC)" then cover them.
  - `it('expires pair_hourly 45 days after its hour, dropping whole parts only')`: `create_table_query` matches `/TTL hour \+ toIntervalDay\(45\)/` and `engine_full` contains `ttl_only_drop_parts = 1`.
  - `it('applies 003 to a database migrated before it, and then nothing')`:
    1. Put every real schema file except `003_account_market_aggregates.sql` in a temp `GH_SCHEMA_DIR` and run the migrations.
    2. Add 003 and run again: `applied` equals `['003_account_market_aggregates.sql']` and `skipped` holds the others.
    3. A third run applies nothing.
  - `it('needs no table of 002: 001 and 003 alone apply')`: a temp dir with only `001_baseline.sql` and 003 applies both, and the nine tables exist.
  - `sample-rows.ts` gets a row per new table, with one distinct non-default value per column. `amm_share`, `amm_pool` and `total_amm_share` are `null`, and `closes` has seven entries, the first one `null`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate`. Expected: FAIL (a compile error in `sample-rows.ts` for the missing `Table` keys).
- [ ] **Step 3: Implement** the file (the DDL below), the enum entries and the row interfaces. The file's header comment says it holds D2's aggregates and repeats the runner's split rule. `pair_hourly` calls the spec's `final` column `is_final`, because `FINAL` is a ClickHouse keyword.

```sql
CREATE TABLE IF NOT EXISTS native_rates_daily
( currency LowCardinality(String), issuer String, day Date, rate String, rate_f Float64, daily_count UInt32,
  latest_count UInt32, config_version UInt32, stale UInt8, version UInt64 )
ENGINE = ReplacingMergeTree(version) PARTITION BY toYear(day) ORDER BY (currency, issuer, day);

CREATE TABLE IF NOT EXISTS pair_hourly
( hour DateTime('UTC'), base_currency LowCardinality(String), base_issuer String, counter_currency LowCardinality(String),
  counter_issuer String, source Enum8('book' = 1, 'amm' = 2), count UInt64, base_sum String, counter_sum String,
  unfit UInt32, base_sum_f Float64, counter_sum_f Float64,
  open_rate String, open_ledger UInt32, open_tx UInt32, open_node UInt16, open_time DateTime('UTC'),
  close_rate String, close_ledger UInt32, close_tx UInt32, close_node UInt16, close_time DateTime('UTC'),
  high_rate String, high_rate_f Float64, high_ledger UInt32, high_tx UInt32, high_node UInt16,
  low_rate String, low_rate_f Float64, low_ledger UInt32, low_tx UInt32, low_node UInt16,
  is_final UInt8, config_version UInt32, through_time DateTime('UTC'), version UInt64 )
ENGINE = ReplacingMergeTree(version) PARTITION BY toDate(hour)
ORDER BY (hour, base_currency, base_issuer, counter_currency, counter_issuer, source)
TTL hour + INTERVAL 45 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE TABLE IF NOT EXISTS markets_live
( period LowCardinality(String), amm Enum8('include' = 1, 'exclude' = 2, 'only' = 3),
  base_currency LowCardinality(String), base_issuer String, counter_currency LowCardinality(String), counter_issuer String,
  count UInt64, base_volume String, counter_volume String, native_volume Nullable(String),
  open String, high String, low String, last String, open_time DateTime('UTC'), last_time DateTime('UTC'),
  closes Array(Nullable(String)), amm_share Nullable(String), amm_pool Nullable(UInt8),
  start_time DateTime('UTC'), end_time DateTime('UTC'), pairs_traded UInt32, total_count UInt64,
  total_native_volume String, total_amm_share Nullable(String), version UInt64 )
ENGINE = ReplacingMergeTree(version) ORDER BY (period, amm, base_currency, base_issuer, counter_currency, counter_issuer);

CREATE TABLE IF NOT EXISTS account_rollup_state
( account String, rows UInt64, first_day Date, rolled_from Nullable(Date), rolled_through Nullable(Date),
  config_version UInt32, version UInt64 )
ENGINE = ReplacingMergeTree(version) ORDER BY account;

CREATE TABLE IF NOT EXISTS account_partition_rows
( partition UInt16, account String, rows UInt64, version UInt64 )
ENGINE = ReplacingMergeTree(version) ORDER BY (partition, account);

CREATE TABLE IF NOT EXISTS account_rollup_days
( account String, day Date, version UInt64 )
ENGINE = ReplacingMergeTree(version) PARTITION BY toYear(day) ORDER BY (account, day);

CREATE TABLE IF NOT EXISTS account_lines_daily
( account String, day Date, currency LowCardinality(String), counterparty String, change_type LowCardinality(String),
  owes UInt8, count UInt64, in_sum String, out_sum String, unfit UInt32, in_sum_f Float64, out_sum_f Float64,
  end_balance String, version UInt64 )
ENGINE = ReplacingMergeTree(version) PARTITION BY toYear(day)
ORDER BY (account, day, currency, counterparty, change_type, owes);

CREATE TABLE IF NOT EXISTS account_tx_daily
( account String, day Date, tx_type LowCardinality(String), result LowCardinality(String), count UInt64, version UInt64 )
ENGINE = ReplacingMergeTree(version) PARTITION BY toYear(day) ORDER BY (account, day, tx_type, result);

CREATE TABLE IF NOT EXISTS account_trades_daily
( account String, day Date, base_currency LowCardinality(String), base_issuer String,
  counter_currency LowCardinality(String), counter_issuer String, count UInt64, base_sum String, counter_sum String,
  bought_sum String, sold_sum String, bought_counter_sum String, sold_counter_sum String, unfit UInt32,
  base_sum_f Float64, counter_sum_f Float64, bought_sum_f Float64, sold_sum_f Float64,
  bought_counter_sum_f Float64, sold_counter_sum_f Float64, version UInt64 )
ENGINE = ReplacingMergeTree(version) PARTITION BY toYear(day)
ORDER BY (account, day, base_currency, base_issuer, counter_currency, counter_issuer);
```

  Lay the columns out one per line, as `001_baseline.sql` does. The schema spec only constrains the semicolons. `account_trades_daily` has six `_f` shadows rather than the spec's "four": `bought_counter_sum` and `sold_counter_sum` need theirs for the `sumOf` fallback.
- [ ] **Step 4: Run the tests to verify they pass** — `pnpm --filter @gatehub/data-api-shared test -- schema` and `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate`. Expected: PASS. Then `pnpm --filter @gatehub/data-api-shared build`.
- [ ] **Step 5: Commit** — `git add packages/shared/schema/003_account_market_aggregates.sql packages/shared/src/clickhouse/tables.ts packages/shared/src/clickhouse/rows.ts packages/shared/test/sample-rows.ts packages/shared/test/migrate.e2e-spec.ts`, message `feat(schema,shared): migration 003, the nine aggregate tables of D2`.

### Task 2: Set plumbing, `dailyNativeRatesOfDay` and the `rates_daily` sets

**Files:**
- Create: `packages/shared/src/aggregate/aggregate-sets.ts`, `packages/shared/src/aggregate/aggregate-sets.spec.ts`
- Create: `packages/shared/src/aggregate/rates-daily.job.ts`
- Modify: `packages/shared/src/query/rates.service.ts` (export `KEEP_ANY_PAIR`; add `DayNativeRate` and `dailyNativeRatesOfDay`)
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/rates-daily-job.e2e-spec.ts`

**Interfaces:**
- Consumes: `Table.NativeRatesDaily`, `NativeRatesDailyRow` (Task 1).
- Produces:
  - `aggregate-sets.ts`:
    - `class AggregateSetAborted extends Error` (name `'AggregateSetAborted'`);
    - `interface AggregateSetOptions { signal?: AbortSignal }`;
    - `throwIfSetAborted(signal?: AbortSignal): void`;
    - `nextSetVersion(ch: ClickHouseService, table: Table, where: string, params: Record<string, unknown>): Promise<number>`, the same SQL as the private `nextVersion` of `volume.job.ts`, which stays untouched;
    - `newestLedgerClose(ch): Promise<number | undefined>`, the unix seconds of the highest ledger.
  - In `rates.service.ts`:
    - `export const KEEP_ANY_PAIR` (unchanged text);
    - `interface DayNativeRate { asset: Asset; rate: BigNumber; dailyCount: number; latestCount: number }`;
    - `RatesService.dailyNativeRatesOfDay(day: Date): Promise<Map<string, DayNativeRate>>`, keyed by `assetKey`, with only the rates above 0.
  - `rates-daily.job.ts`:
    - `RATES_DAILY_CONFIG_VERSION = 1`;
    - `computeRatesDailySet(ch, rates: RatesService, day: Date, options?: AggregateSetOptions): Promise<number>`, which returns the number of assets written;
    - `markRatesStale(ch, days: string[], options?: AggregateSetOptions): Promise<number>`, which returns the number of days marked;
    - `validRateDays(ch, fromDay: string, throughDay: string): Promise<Map<string, number>>`, which maps each valid day to its set's version;
    - `firstNativeTradeDay(ch, nativeCurrency: string): Promise<string | undefined>`.

- [ ] **Step 1: Write the failing tests.**
  - `aggregate-sets.spec.ts` (a fake `query`):
    - `nextSetVersion` returns `5001` for `{newest: 5000, now_ms: 4000}` and `9` for `{newest: 0, now_ms: 9}`;
    - its SQL is `SELECT toUInt64(max(version)) AS newest, toUnixTimestamp64Milli(now64(3)) AS now_ms FROM <table> WHERE <where>`, with the params passed through;
    - `throwIfSetAborted` of an aborted signal throws `AggregateSetAborted`.
  - `rates-daily-job.e2e-spec.ts` seeds synthetic `ledgers` and `exchanges` rows the way part 2 of `packages/shared/test/rates.e2e-spec.ts` does, plus the ripple-mock ledgers through `LedgerWriter`:
    - `'dailyNativeRatesOfDay(D) equals dailyNativeRates([asset], D, D + 1) for every asset'`, for every seeded day D. Equal means `toFixed()` equality for every asset with a rate above 0, and an asset is absent from the map exactly when its rate is 0. The markets cover:
      - a busy pair (more than 50 kept trades in 15 days);
      - a quiet pair (fewer than 10 kept among the newest 50, so 0 and absent);
      - native legs of 0.0005 and less (`0.0005` itself is left out);
      - trades only in D−14..D−1;
      - native as the stored base (`ZZZ`/XRP) and as the stored counter (`USD`/XRP);
      - a day whose first ledger closes at 00:00:00;
      - and the same on Xahau (`XAH`).
    - `'dailyCount and latestCount are the kept trades of the day and among the newest 50'`.
    - `'a set is the assets with a rate above 0 and the sentinel, one insert, one version'`. The sentinel has `currency = ''`, `issuer = ''`, `config_version` 1 and `stale` 0. The set is one part of `system.parts`, as in `volume-job.e2e-spec.ts`.
    - `'a recompute is a newer version, and validRateDays reports it'`.
    - `'markRatesStale writes a sentinel-only stale mark on a valid day, and nothing on a day without a set'`. After the mark the day is not valid, and the count returned is the number of days marked.
    - `'validRateDays ignores a set of another config version, and counts a set written twice once'` (`SYSTEM STOP MERGES`, then an insert with `insert_deduplicate: 0`).
    - `'firstNativeTradeDay is the UTC day of the first trade against the native currency'`.
    - `'an aborted set writes nothing'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-shared test -- aggregate-sets` and `… test:e2e -- rates-daily-job`. Expected: FAIL (the modules are missing).
- [ ] **Step 3: Implement.**
  - `dailyNativeRatesOfDay(day)` is two reads (spec §3.1):
    1. Take the ledger range of `[D − 14 days, D + 1 day)` (`ledgerRange`). Find the native pairs that traded in it: the pair columns of `exchanges` in that range with `base_issuer = '' OR counter_issuer = ''`, `GROUP BY` the pair.
    2. Read those pairs (the four-array tuple list of `pairSums`) in that range. Deduplicate the rows in a subquery ordered by the whole key with `LIMIT 1 BY` the whole key. Over those rows, number each pair's rows by key descending (`row_number()`). Then aggregate `volumeColumns(KEEP_ANY_PAIR)` twice per pair, for example with an `ARRAY JOIN` of two part labels:
       - the rows numbered at most `LATEST_TRADES`, which give "latest" (its `n` is `latestCount`);
       - the rows with `ledger_index >= {day_min:UInt32}`, the first ledger of D, which give "daily" (its `n` is `dailyCount`).

    The rate is `combineRates(daily vwap, latest n >= LATEST_MIN_TRADES ? latest vwap : 0)`, oriented native → asset with `orient(row, canonicalPair(native, asset).inverted)`.
  - `computeRatesDailySet` writes one insert:
    - an asset row per rate above 0, with `rate` as `rate.toString()`, `rate_f` as `toNumber()`, and the two counts;
    - the sentinel, with `rate '0'`, `config_version` 1 and `stale` 0.

    Its version is `nextSetVersion(ch, Table.NativeRatesDaily, "currency = '' AND issuer = '' AND day = {day:Date}", …)`. Call `throwIfSetAborted` before the work and again just before the insert.
  - `validRateDays` reads the newest sentinel per day. It reads over the sentinel key prefix and orders `currency, issuer, day, version DESC LIMIT 1 BY day`. It keeps the days with `stale = 0` and `config_version = 1`.
  - `markRatesStale` writes one insert of stale sentinels: `stale` 1, the current config version, and each day's `nextSetVersion`, for the given days that are valid.
  - `firstNativeTradeDay` is one read: `toString(toDate(min(close_time), 'UTC'))` of `exchanges` with the native filter of read (1). The runner reads it once per process.
- [ ] **Step 4: Run the tests to verify they pass** — the same commands. Expected: PASS. Then rebuild the shared package.
- [ ] **Step 5: Commit** — `git add packages/shared/src/aggregate/aggregate-sets.ts packages/shared/src/aggregate/aggregate-sets.spec.ts packages/shared/src/aggregate/rates-daily.job.ts packages/shared/src/query/rates.service.ts packages/shared/src/index.ts packages/shared/test/rates-daily-job.e2e-spec.ts`, message `feat(shared): daily native rates of a day and the rates_daily sets`.

### Task 3: `DailyRates`, the valuation rule, and their API providers

**Files:**
- Create: `packages/shared/src/query/daily-rates.ts`, `packages/shared/src/query/daily-rates.spec.ts`
- Create: `packages/shared/src/query/valuation.ts`, `packages/shared/src/query/valuation.spec.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/api/src/accounts/account-report-object.ts` (`export { QUOTIENT_DIGITS } from '@gatehub/data-api-shared'` replaces its own constant)
- Modify: `apps/api/src/common/cache.service.ts` (`get`, `set`, `clear`); Create: `apps/api/src/common/cache.service.spec.ts`
- Modify: `apps/api/src/exchanges/rates.module.ts` (provide and export `DailyRates`)
- Modify: `apps/api/src/modules/prometheus/prometheus.service.ts`, `prometheus.service.spec.ts` (`ratesOnReadTotal`)
- Test: `packages/shared/test/daily-rates.e2e-spec.ts`

**Interfaces:**
- Consumes: `validRateDays`, `computeRatesDailySet`, `markRatesStale` (Task 2).
- Produces:
  - `type DayRates = Map<string, Map<string, BigNumber>>`, mapping assetKey → `YYYY-MM-DD` → units of the asset per native coin.
  - `interface RateCache { get(key: string): unknown; set(key: string, value: unknown, ttlMs: number): void }`.
  - `interface DailyRatesOptions { cache?: RateCache; onRead?: (assetDays: number) => void }`.
  - `ON_READ_CACHE_MS = 60_000` and `ON_READ_RUN_DAYS = 3000`.
  - `class DailyRates { constructor(ch: ClickHouseService, rates: RatesService, options?: DailyRatesOptions); readonly nativeCurrency: string; rates(assets: Asset[], days: string[]): Promise<DayRates> }`. The answer has an entry for every asset and every day asked for: 0 when there is no rate, and 1 for the native currency.
  - `newestValidRateDay(ch, throughDay: string): Promise<{ day: string; version: number } | undefined>`.
  - `valuation.ts`:
    - `QUOTIENT_DIGITS = 17`;
    - `nativeValue(amount: BigNumber, asset: Asset, day: string, rates: DayRates, nativeCurrency: string): BigNumber`;
    - `balanceChangeAsset(line: { currency: string; counterparty: string; owes: boolean }, account: string): Asset`.
  - In the API:
    - `CacheService.get<T>(key): T | undefined`, `CacheService.set<T>(key, value, ttlMs): void`, and `CacheService.clear(): void`, which only the e2e suites call;
    - `DailyRates`, injectable from `RatesModule` (a factory over `ClickHouseService`, `RatesService`, `CacheService` and `PrometheusService`);
    - `PrometheusService.ratesOnReadTotal`, the Counter `api_rates_on_read_total` ("Asset-days valued with dailyNativeRates because native_rates_daily had no valid set for the day.").

- [ ] **Step 1: Write the failing tests.**
  - `daily-rates.spec.ts` (a fake `ch` and a fake `RatesService.dailyNativeRates`):
    - `'the native currency is 1 on every day, with no read'`;
    - `'valid days come from one read of the table, rows of the sentinel version only; an asset absent on a valid day is 0'`;
    - `'a day whose newest sentinel is stale, or of config version 2, is computed on read'`;
    - `'on-read days go in runs of consecutive days of at most 3000'`: the days `2020-01-01..03` and `2020-01-10` give two calls, `(…, 2020-01-01, 2020-01-04)` and `(…, 2020-01-10, 2020-01-11)`; 3500 consecutive days give calls of 3000 and 500 days;
    - `'what it computes on read is cached for 60 s per asset and day'`: a second call within 60 s makes no `dailyNativeRates` call and no `onRead`, and a call after 60 s computes again. `onRead` receives the number of asset-days computed;
    - `'no assets, or no days, reads nothing'`.
  - `valuation.spec.ts`:
    - the native amount is itself, to the drop;
    - an issued amount without a rate, or with a rate of 0, is `0`;
    - `nativeValue(1, USD.rX, d, rate 3)` is `'0.33333333333333333'` (17 digits);
    - `balanceChangeAsset({currency:'USD', counterparty:'rB', owes:true}, 'rA')` is `{currency:'USD', issuer:'rA'}`;
    - the native line (`counterparty ''`) is `{currency}`.
  - `cache.service.spec.ts`: `set` then `get` within the ttl; `undefined` after it; `clear()` empties the cache; eviction at 10,000 entries as `wrap` does.
  - `prometheus.service.spec.ts`: `api_rates_on_read_total 3` after `inc(3)`.
  - `daily-rates.e2e-spec.ts` (synthetic trades): `rates(assets, days)` equals `dailyNativeRates(assets, first, last + 1)` for every asset and day `toFixed()`, in three cases: the table empty, the table full (`computeRatesDailySet` for every day), and part of it stale (`markRatesStale`). `newestValidRateDay` skips stale days and days of another config version.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-shared test -- daily-rates valuation`, `pnpm --filter @gatehub/data-api-service test -- cache.service prometheus`, and `pnpm --filter @gatehub/data-api-shared test:e2e -- daily-rates`. Expected: FAIL.
- [ ] **Step 3: Implement.** `rates()` works in this order:
  1. Deduplicate the issued assets by `assetKey`.
  2. Make one `validRateDays(min, max)` call.
  3. If any requested day is valid, make one read: `native_rates_daily` with `(currency, issuer) IN` (zipped arrays), `day BETWEEN …` and `(day, version) IN (SELECT arrayJoin(arrayZip({days:Array(Date)}, {versions:Array(UInt64)})))`, ordered by the key with `LIMIT 1 BY currency, issuer, day`. Read `rate` back with `new BigNumber`.
  4. For the other days, per asset, take the days that are not in the cache (key `daily-rate:<assetKey>:<day>`). Group them into runs of consecutive days of at most `ON_READ_RUN_DAYS`, and call `dailyNativeRates([asset], runStart, runEnd + 1 day)` once per run. Cache each asset-day for `ON_READ_CACHE_MS`, and call `onRead(n)` once with the asset-days computed.

  `newestValidRateDay` reads the sentinels at or before the day, takes the newest per day, keeps the valid ones and takes the newest: `LIMIT 1`. In `RatesModule`, `DailyRates` is built with `cache: CacheService` and `onRead: (n) => metrics.ratesOnReadTotal.inc(n)`. D1 also uses `CacheService`: if D1 already added a method with one of these names, reuse it rather than adding a second.
- [ ] **Step 4: Run the tests to verify they pass** — the same commands. Expected: PASS. The existing unit suites of the API still pass (`account-report-object.spec.ts` uses `QUOTIENT_DIGITS`).
- [ ] **Step 5: Commit** — `git add` the files listed above, message `feat(shared,api): DailyRates and the valuation rule; the API's rates-on-read metric`.

### Task 4: `pair_hourly` sets

**Files:**
- Create: `packages/shared/src/query/candle-columns.ts` (move `AGGREGATE_SOURCE_COLUMNS` and `AGGREGATE_COLUMNS` verbatim, with their comments, out of `apps/api/src/exchanges/exchange-aggregate.ts`)
- Modify: `apps/api/src/exchanges/exchange-aggregate.ts` (`export { AGGREGATE_COLUMNS, AGGREGATE_SOURCE_COLUMNS } from '@gatehub/data-api-shared'` replaces the definitions; `exchanges.service.ts` keeps importing them from `./exchange-aggregate`)
- Create: `packages/shared/src/aggregate/pair-hourly.job.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/pair-hourly-job.e2e-spec.ts`; `apps/api/src/exchanges/exchange-aggregate.spec.ts` and `apps/api/test/exchanges.e2e-spec.ts` pass unchanged

**Interfaces:**
- Consumes: Task 2's `nextSetVersion`, `throwIfSetAborted`, `AggregateSetOptions`, `newestLedgerClose` and `KEEP_ANY_PAIR`; `RatesService.ledgersClosedIn`.
- Produces:
  - `PAIR_HOURLY_CONFIG_VERSION = 1` and `PAIR_HOURLY_DAYS = 31`.
  - `computePairHourSets(ch, rates: RatesService, fromHour: number, toHour: number, options?: AggregateSetOptions): Promise<number>`. The times are unix seconds of whole hours, and the range is 1 to 24 hours inside one UTC day, else `RangeError`. It returns the number of hour sets written, which is one per hour of the range.
  - `interface HourSet { version: number; final: boolean; configVersion: number; throughTime: number }`.
  - `pairHourSets(ch, fromHour: number, toHour: number): Promise<Map<number, HourSet>>`, mapping an hour's start to its newest set, read from the sentinels.

- [ ] **Step 1: Write the failing tests** in `pair-hourly-job.e2e-spec.ts`. They seed synthetic `ledgers` and `exchanges` rows in three hours of a day: equal rates within one hour, a native dust leg, and an amount of 1e40.
  - `'every pair of an hour is its candle'`, checked against an oracle from the `exchanges` rows:
    - `open_rate` and `close_rate` are those of the first and last trade by key;
    - `high_rate` and `low_rate` go by `rate_f`, with the key as the tie-break;
    - `open_time` and `close_time`, and the `*_ledger/_tx/_node` keys, are those of the trades named;
    - `count` and the exact `base_sum` and `counter_sum`.
  - `'native dust (0.0005 or less) is left out'`.
  - `'an amount the exact sums cannot hold makes the hour unfit, with its Float64 sums'`.
  - `'a UTC day is one read of exchanges and 24 sets'`. Each set is one insert under its own version, and an hour without trades still gets its sentinel. Count the reads with a `query` spy.
  - `'is_final: once a ledger closed at or after the hour's end; through_time is the close time of the hour's newest ledger, or the hour's start when the hour has none'`.
  - `'every row is source book, and every row carries the set's is_final, config_version and through_time'`.
  - `'pairHourSets gives each hour's newest set, and a set written twice once'`.
  - `'rejects a range that is not whole hours of one UTC day'`.
  - `'an aborted set writes nothing'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-shared test:e2e -- pair-hourly-job`. Expected: FAIL (the module is missing).
- [ ] **Step 3: Implement.**
  - The work, in order:
    1. Read the newest ledger close first (`newestLedgerClose`): it decides `is_final`.
    2. Take the ledger range of `[fromHour, toHour)` (`rates.ledgersClosedIn`).
    3. Make one read of `exchanges` in that range: the pair columns and `AGGREGATE_SOURCE_COLUMNS`, `WHERE KEEP_ANY_PAIR`, deduplicated in a subquery ordered by the whole key with `LIMIT 1 BY` the whole key. Group it by `toUnixTimestamp(toStartOfHour(close_time))` and the pair, and select `AGGREGATE_COLUMNS` plus:
       - `min((ledger_index, tx_index, node_index))` as the open key and `max(...)` as the close key;
       - `argMax((ledger_index, tx_index, node_index), (rate_f, -toInt64(ledger_index), -toInt64(tx_index), -toInt32(node_index)))` as the high key and `max(rate_f)`;
       - `argMin((ledger_index, tx_index, node_index), (rate_f, ledger_index, tx_index, node_index))` as the low key and `min(rate_f)`.
    4. Make one read of `ledgers` in the range: `max(close_time)` per hour, which gives `through_time`.
  - Each hour gets a JSON insert of its rows plus a sentinel, under `nextSetVersion(ch, Table.PairHourly, "hour = toDateTime({hour:UInt32}, 'UTC')", …)`. Store the sums exactly as ClickHouse wrote them (`'0'` for none). The sentinel has the empty pair, `source 'book'`, zeros and `''` rates, and times equal to the hour. Every row carries `is_final`, `config_version` and `through_time`.
  - `pairHourSets` reads the sentinels of the range (`base_currency = ''` and the other three empty), newest version per hour.
  - In `apps/api`, only the re-export changes.
- [ ] **Step 4: Run the tests to verify they pass** — `pnpm --filter @gatehub/data-api-shared test:e2e -- pair-hourly-job`. Rebuild the shared package. Then run `pnpm --filter @gatehub/data-api-service test -- exchange-aggregate` and `… test:e2e -- exchanges`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add packages/shared/src/query/candle-columns.ts packages/shared/src/aggregate/pair-hourly.job.ts packages/shared/src/index.ts apps/api/src/exchanges/exchange-aggregate.ts packages/shared/test/pair-hourly-job.e2e-spec.ts`, message `feat(shared): pair_hourly sets, and the candle columns in the shared package`.

### Task 5: `markets_live` sets

**Files:**
- Create: `packages/shared/src/aggregate/markets-live.job.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `packages/shared/test/markets-oracle.ts` (the markets of a window, computed straight from `exchanges` rows)
- Test: `packages/shared/test/markets-live-job.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 4's `pairHourSets`, `computePairHourSets` and `PAIR_HOURLY_CONFIG_VERSION`; Task 2's plumbing; Task 3's `QUOTIENT_DIGITS`; `ratio`, `sumOf`, `EXACT_LIMIT`.
- Produces:
  - `MARKETS_PERIODS = ['day', '7day', '30day'] as const` and `type MarketsPeriod`.
  - `MARKETS_PERIOD_HOURS: Record<MarketsPeriod, number>`, which is 24, 168 and 720.
  - `SPARKLINE_DAYS = 7`.
  - `type MarketsSetOutcome = { written: true; pairs: number; startTime: number; endTime: number } | { written: false; missingHours: number[] }`.
  - `computeMarketsSet(ch, nativeCurrency: string, period: MarketsPeriod, now: Date, options?: AggregateSetOptions): Promise<MarketsSetOutcome>`.
  - `marketsSetEndTimes(ch): Promise<Map<MarketsPeriod, number>>`, the `end_time` of each period's newest `include` set.

- [ ] **Step 1: Write the failing tests** in `markets-live-job.e2e-spec.ts`. They seed synthetic trades over 32 days, write the hour sets with `computePairHourSets`, and then call `computeMarketsSet`.
  - `'the set equals an oracle computed straight from exchanges for the same hour-aligned window'`, for each of `day`, `7day` and `30day`. It compares every pair's `count`, `base_volume`, `counter_volume`, `open`, `high`, `low`, `last`, `open_time`, `last_time`, `native_volume` and `closes`, and the sentinel's `start_time`, `end_time`, `pairs_traded`, `total_count` and `total_native_volume`.
  - `'native volume'`:
    - for a pair with a native side, it is that side's volume;
    - otherwise it is the base volume over the base's rate, else the counter volume over the counter's rate. An asset's rate is its volume over the native volume of its native pair in the same window, and the quotient is cut to 17 significant digits;
    - with no rate on either side it is NULL.
  - `'closes are the last trade of each of the 7 UTC days ending with the day of t; a quiet day carries the close before it; a day with no close before it in the 7 days is null'`.
  - `'a missing hour, or a non-final one other than the last two, in the window or in the sparkline days skips the set and leaves the previous one'`. The outcome lists the missing hours.
  - `'window: start_time = floorHour(t) − P, end_time = t, where t is the through_time of the current hour's newest set'`.
  - `'D2 writes only amm = include, with amm_share, amm_pool and total_amm_share NULL'`.
  - `'a set is one insert under one version; marketsSetEndTimes reads the newest'`.
  - `'an hour row written twice counts once, and an older version of an hour is not read'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-shared test:e2e -- markets-live-job`. Expected: FAIL.
- [ ] **Step 3: Implement `computeMarketsSet`** (spec §3.3):
  1. t is the `throughTime` of the newest set of the hour `floorHour(now)`. Without a set, return `{ written: false, missingHours: [floorHour(now)] }`.
  2. The window's hours run from `floorHour(t) − P` to `floorHour(t)`, both included. The sparkline days are the 7 UTC days ending with t's day. Every hour of the window and of those days needs a newest set of config version 1, and the set must be final except for the hours `floorHour(t)` and `floorHour(t) − 1h`. Otherwise do not write, and return the hours that fail.
  3. Read `pair_hourly` once over those hours. Take only the rows of each hour's newest version (`(hour, version) IN` the sentinels' newest), each row once (ordered by the key, `LIMIT 1 BY hour, pair, source`), and no sentinels. The filter `include` takes both sources. Group the window's hours by pair:
     - `count` is the sum.
     - The exact volume is the sum of `toDecimal256OrNull(base_sum, 30)` over the hours with `unfit = 0 AND base_sum_f < 1e36`.
     - The merged `unfit` counts the hours with `unfit > 0` or a Float64 sum at or above 1e36. The floats are `sumKahan`. Read the volumes back with `sumOf`.
     - `open` is `argMin(open_rate, (open_ledger, open_tx, open_node))`, and `open_time` is taken the same way.
     - `last` is `argMax(close_rate, (close_ledger, close_tx, close_node))`, and `last_time` is taken the same way.
     - `high` is `argMax(high_rate, (high_rate_f, -toInt64(high_ledger), -toInt64(high_tx), -toInt32(high_node)))`.
     - `low` is `argMin(low_rate, (low_rate_f, low_ledger, low_tx, low_node))`.

     The day closes are a second grouping by (pair, `toDate(hour)`) over the sparkline hours: `argMax(close_rate, close key)`.
  4. Compute the native volume, the carried closes and the totals in TypeScript:
     - `pairs_traded` is the pairs with a kept trade;
     - `total_count` is the sum of their counts;
     - `total_native_volume` is the exact sum over the pairs that have a native volume, `'0'` when none has;
     - `total_amm_share` is NULL.
  5. Write one insert under `nextSetVersion(ch, Table.MarketsLive, "period = {period:String} AND amm = 'include'", …)`:
     - the rows, with the rates as their exact stored text and every row carrying `start_time` and `end_time`;
     - the sentinel (the empty pair) with the totals.
- [ ] **Step 4: Run the tests to verify they pass** — the same command. Expected: PASS. Rebuild the shared package.
- [ ] **Step 5: Commit** — `git add packages/shared/src/aggregate/markets-live.job.ts packages/shared/src/index.ts packages/shared/test/markets-oracle.ts packages/shared/test/markets-live-job.e2e-spec.ts`, message `feat(shared): markets_live sets from pair_hourly`.

### Task 6: Day groups and the rollup writer

**Files:**
- Modify: `packages/shared/src/query/decimal.ts`, `decimal.spec.ts` (`exactAmount('amount_change')`)
- Create: `packages/shared/src/query/account-day-groups.ts`, `account-day-groups.spec.ts`
- Create: `packages/shared/src/aggregate/account-rollups.job.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/account-day-groups.e2e-spec.ts`

**Interfaces:**
- Consumes: the Task 1 tables; Task 2's `nextSetVersion` and `AggregateSetOptions`; the `LedgerRange` type from `rates.service.ts`.
- Produces:
  - `exactAmount(column: 'base_amount' | 'counter_amount' | 'delivered_amount' | 'amount_change')`. For `amount_change`, the shadow is `toFloat64OrZero(amount_change)` and the limit test is `abs(toFloat64OrZero(amount_change)) < 1e36`. The other three columns give exactly today's text.
  - `type DayGroupFamily = 'lines' | 'txs' | 'trades'`. `DAY_GROUP_COLUMNS: Record<DayGroupFamily, readonly string[]>` lists the columns every day-group subquery selects, in order, from either source:

    | Family | Columns |
    | --- | --- |
    | `lines` | `day, currency, counterparty, change_type, owes, count, in_sum, out_sum, unfit, in_sum_f, out_sum_f, end_balance` |
    | `txs` | `day, tx_type, result, count` |
    | `trades` | `day, base_currency, base_issuer, counter_currency, counter_issuer, count, base_sum, counter_sum, bought_sum, sold_sum, bought_counter_sum, sold_counter_sum, unfit, base_sum_f, counter_sum_f, bought_sum_f, sold_sum_f, bought_counter_sum_f, sold_counter_sum_f` |

    `day` is a `Date`, and the exact sums are text (`'0'` when there is no exact term).
  - `DAY_GROUPS_EPOCH = '2000-01-01'`, the first day of a read of "everything up to".
  - `ACCOUNT_ROLLUP_CONFIG_VERSION = 1`.
  - `interface RollupCoverage { from: string; through: string }`, with both days included.
  - `rollupCoverage(ch, account): Promise<RollupCoverage | undefined>`. It uses the account's newest state row, and only one of the current config version with both days set.
  - `type LedgerRangeOf = (from: Date, toExclusive: Date) => Promise<LedgerRange | null>`.
  - `rawDayGroupsSql(family: DayGroupFamily, o: { accounts: 'one' | 'many'; ranges: 1 | 2 }): string`. Its params are `dg_account` (String, for `one`) or `dg_accounts` (Array(String), for `many`, with `account` first in the output), and `dg_min0`, `dg_max0`, `dg_min1`, `dg_max1` (UInt32).
  - `interface DayGroupsSource { sql: string; params: Record<string, unknown>; sources: Array<'raw' | 'rollup'> }`.
  - `class AccountDayGroups { constructor(ch: ClickHouseService, ranges: LedgerRangeOf, coverageOf?: (account: string) => Promise<RollupCoverage | undefined>); source(family: DayGroupFamily, account: string, fromDay: string, throughDay: string): Promise<DayGroupsSource | null> }`. It returns `null` when no day of the window has a source.
  - `mergedExactSum(column: string): string`, which is `ifNull(toString(sum(toDecimal256OrNull(<column>, 30))), '0')`. Routes use it to merge day groups.
  - `account-rollups.job.ts` (Task 7 extends it):
    - `interface RollupState { account: string; rows: number; firstDay: string; rolledFrom?: string; rolledThrough?: string; configVersion: number }`;
    - `rollupStates(ch): Promise<Map<string, RollupState>>`, the newest per account;
    - `writeRollupStates(ch, states: RollupState[], options?): Promise<void>`, one insert whose version is the table's `nextSetVersion` with `where` `'1'`;
    - `writeAccountRollups(ch, ranges: LedgerRangeOf, accounts: string[], fromDay: string, throughDay: string, options?): Promise<number>`, which returns the number of rows written.

- [ ] **Step 1: Write the failing tests.**
  - `decimal.spec.ts`:
    - `exactAmount('amount_change')` contains `abs(toFloat64OrZero(amount_change)) < 1e36` and `toDecimal256OrNull(amount_change, 30)`;
    - `exactAmount('base_amount')` equals a literal of its current output.
  - `account-day-groups.spec.ts` (a fake `ranges` and `coverageOf`):
    - With the window `2020-01-01..2020-12-31` and the coverage `2020-03-01..2020-06-30`, the source is the rollup days `03-01..06-30` plus two raw ranges, resolved from `[2020-01-01, 2020-03-01)` and `[2020-07-01, 2021-01-01)`. `sources` is `['raw', 'rollup']`, and the SQL has `ledger_index BETWEEN {dg_min0:UInt32} AND {dg_max0:UInt32} OR ledger_index BETWEEN {dg_min1:UInt32} AND {dg_max1:UInt32}`.
    - A coverage outside the window gives raw only.
    - A coverage holding the whole window gives rollup only, and no range is resolved.
    - A raw part without ledgers is dropped.
    - Nothing at all gives `null`.
  - `account-day-groups.e2e-spec.ts` uses the ripple-mock ledgers plus synthetic `balance_changes`, `account_transactions` and `account_exchanges` rows. These include an account whose line crosses zero within a day, fee rows, a change type of `''`, two changes in one ledger, a self-trade, and a row written twice. The tests:
    - `'raw line groups: one per day, line, change type and owes, with count, in and out exact; end_balance is the line's last final_balance of the day, the same on every row of the line and day'`, against an oracle from the rows.
    - `'raw tx groups: the transactions the account sent, per day, type and result'`.
    - `'raw trade groups: count, base, counter, bought, sold, bought_counter, sold_counter (a self-trade in both), their floats and unfit'`.
    - `'writeAccountRollups writes the three tables under one version, then a sentinel per (account, day) that has rows or had one; a day that lost its rows gets a sentinel with none'`.
    - **`'rolled-up groups equal raw groups: complete, partial before, partial after'`**. For three accounts, write the rollups and state rows with coverage: the whole window, starting after the window's start, and ending before its end. Then `SELECT * FROM (<source sql>) ORDER BY` all columns gives the same JSON as the raw-only source. Use amounts that fit `Decimal256(30)`, so that the floats agree too.
    - `'a rollup read takes the rows of each day's sentinel version, and a row written twice once'`.
    - `'the raw read is a key range of the account (EXPLAIN indexes = 1: Keys account), with no FINAL'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-shared test -- decimal account-day-groups` and `… test:e2e -- account-day-groups`. Expected: FAIL.
- [ ] **Step 3: Implement.** The raw `lines` SQL for one account and one range is below. `many` adds `account` to the inner SELECT, the GROUP BY, the PARTITION BY and the output, reads `account IN {dg_accounts:Array(String)}`, and dedupes with `LIMIT 1 BY account, ledger_index, tx_index, node_index`. Two ranges are `(… OR …)`.

```sql
SELECT day, currency, counterparty, change_type, owes, count, in_sum, out_sum, unfit, in_sum_f, out_sum_f,
       argMax(group_last, group_key) OVER (PARTITION BY day, currency, counterparty) AS end_balance
  FROM (SELECT day, currency, counterparty, change_type, owes, toUInt64(count()) AS count,
               ifNull(toString(sumIf(change_exact, change_f > 0)), '0') AS in_sum,
               ifNull(toString(sumIf(-change_exact, change_f < 0)), '0') AS out_sum,
               toUInt32(countIf(change_exact IS NULL)) AS unfit,
               sumKahanIf(change_f, change_f > 0) AS in_sum_f, sumKahanIf(-change_f, change_f < 0) AS out_sum_f,
               argMax(final_balance, (ledger_index, tx_index, node_index)) AS group_last,
               max((ledger_index, tx_index, node_index)) AS group_key
          FROM (SELECT toDate(close_time, 'UTC') AS day, currency, counterparty, change_type,
                       toUInt8(final_balance_f < 0) AS owes, ledger_index, tx_index, node_index, final_balance,
                       ${exactAmount('amount_change')} AS change_exact, toFloat64OrZero(amount_change) AS change_f
                  FROM balance_changes
                 WHERE account = {dg_account:String} AND (ledger_index BETWEEN {dg_min0:UInt32} AND {dg_max0:UInt32})
                 ORDER BY account, ledger_index, tx_index, node_index
                 LIMIT 1 BY ledger_index, tx_index, node_index)
         GROUP BY day, currency, counterparty, change_type, owes)
```

  - The `txs` and `trades` raw SQL follow the same pattern:
    - `txs` reads `account_transactions` with `is_initiator = 1`.
    - `trades` reads `account_exchanges` with `bought_* = sumIf(…, buyer = account)` and `sold_* = sumIf(…, seller = account)`, the counter sums over `counter_exact`, `unfit` as in `volumeColumns`, and no dust filter.
  - The rollup source reads the rows of `account_<family>_daily` of the account in `[from, through]` whose `(day, version)` is in `account_rollup_days`' newest version per day. They are ordered by the table key with `LIMIT 1 BY` the group key, and give the same columns. `source()` resolves the raw parts with `ranges`, then joins the parts with `UNION ALL` in a subquery.
  - `writeAccountRollups` writes:
    1. per table, one server-side `INSERT INTO account_<family>_daily SELECT …, {version:UInt64} FROM (<rawDayGroupsSql(family, {accounts:'many'})>)`, all three under one version, so a rollup holds exactly the raw text;
    2. then one insert into `account_rollup_days` of the (account, day) pairs that have rows of that version, or a sentinel before it, in the range.
- [ ] **Step 4: Run the tests to verify they pass** — the same commands. Expected: PASS. Rebuild the shared package.
- [ ] **Step 5: Commit** — `git add packages/shared/src/query/decimal.ts packages/shared/src/query/decimal.spec.ts packages/shared/src/query/account-day-groups.ts packages/shared/src/query/account-day-groups.spec.ts packages/shared/src/aggregate/account-rollups.job.ts packages/shared/src/index.ts packages/shared/test/account-day-groups.e2e-spec.ts`, message `feat(shared): account day groups from raw rows or rollups, and the rollup writer`.

### Task 7: Heavy-account discovery and promotion slices

**Files:**
- Modify: `packages/shared/src/aggregate/account-rollups.job.ts`
- Create: `packages/shared/src/aggregate/account-rollups.job.spec.ts`
- Modify: `packages/shared/src/index.ts` (if new names need it)
- Test: `packages/shared/test/account-rollups-job.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 6's `writeAccountRollups`, `writeRollupStates` and `rollupStates`; Task 2's plumbing.
- Produces:
  - `ACCOUNT_PARTITION_ROWS_FLOOR = 10_000`, `ACCOUNT_ROLLUP_SLICE_ROWS = 2_000_000` and `BALANCE_PARTITION_LEDGERS = 10_000_000`.
  - `ADDRESS_SLICE_CHARS: readonly string[]`, the 58 characters of the base58 alphabet in code-point order: `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`.
  - `partitionOf(ledgerIndex: number): number`, which is `Math.floor(ledgerIndex / BALANCE_PARTITION_LEDGERS)`.
  - `recountPartition(ch, partition: number, options?: AggregateSetOptions): Promise<number>`. It writes the partition's set: the accounts with at least `ACCOUNT_PARTITION_ROWS_FLOOR` balance changes in it, plus the sentinel `account = ''`, in one insert. It returns the accounts kept.
  - `partitionSetVersions(ch): Promise<Map<number, number>>`, mapping each partition to its newest set's version (ms).
  - `heavyAccounts(ch, minRows: number): Promise<Map<string, number>>`. The rows of each account are summed over the newest set of every partition, and an account is kept when the sum is at least `minRows`.
  - `accountPartitionRows(ch, account: string): Promise<Map<number, number>>`.
  - `firstChangeDay(ch, account: string): Promise<string | undefined>`, a key-ordered read of one `balance_changes` row.
  - `partitionDays(ch, partition: number): Promise<number>`, the UTC days its ledgers span, at least 1.
  - `promotionSlice(o: { firstDay: string; throughDay: string; rowsPerDay: number }): { fromDay: string; throughDay: string }`.

- [ ] **Step 1: Write the failing tests.**
  - `account-rollups.job.spec.ts`, for the pure parts:
    - `promotionSlice({firstDay:'2020-01-01', throughDay:'2020-12-31', rowsPerDay: 100_000})` gives `{fromDay:'2020-12-12', throughDay:'2020-12-31'}`, which is 20 days;
    - `rowsPerDay` 5,000,000 gives one day;
    - a slice never starts before `firstDay`;
    - `ADDRESS_SLICE_CHARS` has 58 characters, sorted and distinct;
    - `partitionOf(19_999_999)` is 1.
  - `account-rollups-job.e2e-spec.ts` (synthetic `balance_changes`, with the merges stopped so that row counts are exact):
    - `'recountPartition reads the partition in 58 slices by the second character of the address, and keeps the accounts of 10,000 rows or more'` (count the reads with a spy; the first slice has no lower bound and the last none above);
    - `'heavyAccounts sums each account over the newest set of every partition'`;
    - `'a recount is a newer set; an account below the floor is gone from it'`;
    - `'firstChangeDay is the UTC day of the account's first balance change'`;
    - `'partitionDays spans the partition's ledgers'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-shared test -- account-rollups` and `… test:e2e -- account-rollups-job`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - A recount slice i reads `SELECT account, count() FROM balance_changes WHERE ledger_index BETWEEN {p_min} AND {p_max} AND account >= {lo} AND account < {hi} GROUP BY account HAVING count() >= 10000`, where:
    - `lo` is `'r' + ADDRESS_SLICE_CHARS[i]`, except for slice 0, which has no lower bound;
    - `hi` is `'r' + ADDRESS_SLICE_CHARS[i + 1]`, except for slice 57, which has no upper bound.

    All the slices' rows and the sentinel go into one insert under `nextSetVersion(ch, Table.AccountPartitionRows, 'partition = {p:UInt16}', …)`.
  - `promotionSlice` takes `days = max(1, floor(ACCOUNT_ROLLUP_SLICE_ROWS / rowsPerDay))` and returns `[max(firstDay, throughDay − days + 1), throughDay]`.
- [ ] **Step 4: Run the tests to verify they pass** — the same commands. Expected: PASS. Rebuild the shared package.
- [ ] **Step 5: Commit** — `git add packages/shared/src/aggregate/account-rollups.job.ts packages/shared/src/aggregate/account-rollups.job.spec.ts packages/shared/src/index.ts packages/shared/test/account-rollups-job.e2e-spec.ts`, message `feat(shared): heavy-account discovery and promotion slices`.

### Task 8: The runners of `pair_hourly` and `markets_live`

**Files:**
- Create: `apps/syncer/src/aggregator/aggregate-job-deps.ts`
- Create: `apps/syncer/src/aggregator/pair-hourly.job-runner.ts`, `pair-hourly.job-runner.spec.ts`
- Create: `apps/syncer/src/aggregator/markets-live.job-runner.ts`, `markets-live.job-runner.spec.ts`
- Create: `apps/syncer/test/aggregate-job-fakes.ts`
- Modify: `apps/syncer/src/modules/prometheus/prometheus.service.ts`, `prometheus.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5 (`computePairHourSets`, `pairHourSets`, `computeMarketsSet`, `marketsSetEndTimes`, `PAIR_HOURLY_DAYS`, `PAIR_HOURLY_CONFIG_VERSION`, `MARKETS_PERIODS`); `AggregatorJob` and `AggregatorTick` from `./aggregator.service`, as **type-only** imports. A runner imports only the shared package and those types: nothing of `feat/amm-data`.
- Produces:
  - `aggregate-job-deps.ts`:
    - `interface AggregateJobDeps { readonly ch: ClickHouseService; readonly logger: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>; readonly metrics?: PrometheusService; readonly budgetMs: number; clock(): number; closing(): boolean; failed(job: string, err: unknown, where?: string): void }`;
    - `interface AggregatorAggregates { rates: RatesService; accountRollupMinRows: number }`;
    - `interface AggregateFunctions` (the shared functions the runners call; Task 9 extends it) and `defaultAggregateFunctions(): AggregateFunctions`;
    - `AGGREGATE_RETRY_MS = 300_000`, `AGGREGATE_MAX_RETRY_MS = 3_600_000` and `MAX_FAILED_AGGREGATE_SETS_PER_TICK = 3`;
    - `class SetBackoff { waiting(key: string, now: number): boolean; failed(key: string, now: number): void; done(key: string): void; keepOnly(keys: ReadonlySet<string>): void }`.
  - `class PairHourlyJobRunner { constructor(deps: AggregateJobDeps, aggregates: AggregatorAggregates, fns?: Partial<AggregateFunctions>); job(): AggregatorJob; ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void> }`. The job is named `pair_hourly`, and its `budgetMs` is `deps.budgetMs`.
  - `class MarketsLiveJobRunner`, with the same constructor and `job()` (named `markets_live`); `MARKETS_LONG_EVERY_TICKS = 5`.
  - `PrometheusService.pairHourlyMissingHours`: Gauge `syncer_pair_hourly_missing_hours` ("Hours of the last 31 days without a set of the current config version.").
  - `PrometheusService.marketsLiveAgeSeconds`: Gauge `syncer_markets_live_age_seconds`, labels `['period']` ("Now minus the end_time of the newest include set.").
  - `aggregate-job-fakes.ts`: `fakeDeps(o?: { budgetMs?: number })`, which returns deps with `clock: Date.now` (under jest fake timers), a quiet logger, recorded `failed` calls, a `closing` flag the test can set, and metric fakes; plus `NOW`, `HOUR`, `DAY`, `unix(text)` and `iso(seconds)`.

- [ ] **Step 1: Write the failing specs** (jest fake timers; the shared functions replaced by fakes that record their calls and take fake time).
  - `pair-hourly.job-runner.spec.ts`:
    - `'refreshes the current hour, and the previous hour until it is final, the stalest first'`;
    - `'back-fills the hours of the last 31 days that have no final set of config version 1, newest first; a wholly missing UTC day is one call of 24 hours'`;
    - `'never computes an hour before the hour of the first ledger'`;
    - `'stops starting sets once its deadline has passed, and warns once until a run finishes in time'`;
    - `'a failing hour is passed to failed("pair_hourly", …), waits 5 min, then 10, up to an hour, while the others go on; it gives up after 3 failures in a tick'`;
    - `'sets syncer_pair_hourly_missing_hours'`;
    - `'says once that the back-fill is under way and once that it is done'`;
    - `'ofSlice recomputes the hours of the slice inside the last 31 days only, split at UTC midnight, and rejects when a set fails'`;
    - `'starts nothing once closing() is true'`.
  - `markets-live.job-runner.spec.ts`:
    - `'writes the day set every run, and the 7day and 30day sets on its 1st, 6th, 11th … run'`;
    - `'a skipped set (written: false) is logged once per gap, and nothing replaces the previous set'`;
    - `'sets syncer_markets_live_age_seconds{period} to now minus each period's newest end_time'`;
    - `'a failing period is counted as markets_live, and the other periods still run'`;
    - `'starts nothing once closing() is true'`.
  - `prometheus.service.spec.ts` gains the two gauges' lines.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-syncer test -- job-runner prometheus`. Expected: FAIL.
- [ ] **Step 3: Implement the two runners and `aggregate-job-deps.ts`.**
  - The runners keep their own state: the backoffs, the warned flags, the announcements, the cached first-ledger hour, and the markets run counter.
  - The job's deadline is the `tick.deadline` that `runJobs` already narrows to the budget. A set is started only while `deps.clock() < tick.deadline` and not `deps.closing()`.
  - `markets_live` reads `marketsSetEndTimes` after its sets.
  - `pair_hourly` sets the gauge from the sets it read and wrote.
- [ ] **Step 4: Run the tests to verify they pass** — the same command, and `pnpm --filter @gatehub/data-syncer build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add apps/syncer/src/aggregator/aggregate-job-deps.ts apps/syncer/src/aggregator/pair-hourly.job-runner.ts apps/syncer/src/aggregator/pair-hourly.job-runner.spec.ts apps/syncer/src/aggregator/markets-live.job-runner.ts apps/syncer/src/aggregator/markets-live.job-runner.spec.ts apps/syncer/test/aggregate-job-fakes.ts apps/syncer/src/modules/prometheus/prometheus.service.ts apps/syncer/src/modules/prometheus/prometheus.service.spec.ts`, message `feat(syncer): the pair_hourly and markets_live job runners`.

### Task 9: The runners of `rates_daily` and `account_rollups`

**Files:**
- Create: `apps/syncer/src/aggregator/rates-daily.job-runner.ts`, `rates-daily.job-runner.spec.ts`
- Create: `apps/syncer/src/aggregator/account-rollups.job-runner.ts`, `account-rollups.job-runner.spec.ts`
- Modify: `apps/syncer/src/aggregator/aggregate-job-deps.ts` (`AggregateFunctions` grows: `computeRatesDailySet`, `markRatesStale`, `validRateDays`, `firstNativeTradeDay`, `newestLedgerClose` and the Task 6/7 rollup functions)
- Modify: `apps/syncer/src/modules/prometheus/prometheus.service.ts`, `prometheus.service.spec.ts`

**Interfaces:**
- Consumes: the Task 8 `AggregateJobDeps`, `SetBackoff` and fakes; Tasks 2, 6 and 7.
- Produces:
  - `class RatesDailyJobRunner` and `class AccountRollupsJobRunner`, each with the constructor of Task 8, `job()` (named `rates_daily` and `account_rollups`) and `ofSlice(start, end, tick)`.
  - The gauges `syncer_rates_daily_missing_days` ("Closed final days without a valid rates set, from the first native trade to the newest final day."), `syncer_account_rollups_heavy_accounts` ("Heavy accounts.") and `syncer_account_rollups_pending_accounts` ("Heavy accounts whose coverage does not yet reach from first_day to the newest final day."). The fields are `ratesDailyMissingDays`, `accountRollupsHeavyAccounts` and `accountRollupsPendingAccounts`.

- [ ] **Step 1: Write the failing specs.**
  - `rates-daily.job-runner.spec.ts`:
    - `'computes yesterday once it is final and not valid, then the closed final days that are not valid, newest first, down to the first native trade day'`;
    - `'a day is final once the newest ledger closed an hour after its end; today never is'`;
    - `'computes at least one day per run, even past its deadline'`;
    - `'reads firstNativeTradeDay once, and again only while it is undefined'`;
    - `'sets syncer_rates_daily_missing_days'`;
    - `'a failing day backs off 5 min doubling to 1 h, counted as rates_daily; at most 3 failures a tick'`;
    - `'announces the back-fill once under way and once done'`;
    - `'ofSlice of a slice in day X marks the days X..X+14 stale; a slice across midnight marks from its first day to its last day + 14; a failure rejects'`.
  - `account-rollups.job-runner.spec.ts`:
    - `'does nothing at all when GH_ACCOUNT_ROLLUP_MIN_ROWS is 0'`;
    - `'recounts the partition of the newest ledger when its set is over 24 h old, every other partition over 7 days old, and one marked by ofSlice'`;
    - `'a new heavy account gets a state row with its first_day and no coverage; one that is no longer heavy loses its coverage; a state of another config version counts as uncovered'`;
    - `'daily increment: for each final day d after rolled_through, oldest first, rolls together the heavy accounts whose rolled_through is d − 1, then writes rolled_through = d'`;
    - `'promotion: an uncovered account starts at the newest final day; a covered one gets its next slice backwards (promotionSlice from its partition's rows per day) until rolled_from is first_day'`;
    - `'sets the heavy and pending gauges'`;
    - `'ofSlice recomputes (account, day) for the heavy accounts whose coverage holds the day, and marks the partition for the next discovery'`;
    - `'stops at its deadline and backs off a failing account'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-syncer test -- rates-daily account-rollups prometheus`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The work of an `account_rollups` run, in order (spec §3.4):
    1. Discovery: the partitions due, newest first; then `heavyAccounts`; then one `writeRollupStates` with the changes.
    2. The daily increment.
    3. The promotion, in rounds: the accounts with the newest `rolled_from` (uncovered ones first) get one slice each per round, while the deadline allows. The rows per day are `accountPartitionRows(account)[partition of the slice's end] / partitionDays(that partition)`.
    4. The gauges.
  - The newest final day is computed as in `rates_daily`. The ledger ranges come from `aggregates.rates.ledgersClosedIn`.
- [ ] **Step 4: Run the tests to verify they pass** — the same command, and `pnpm --filter @gatehub/data-syncer build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add` the files above, message `feat(syncer): the rates_daily and account_rollups job runners`.

### Task 10: Registration in the aggregator, configuration and the syncer e2e

**Files:**
- Modify: `apps/syncer/src/aggregator/aggregator.service.ts` (the registration diff of spec §3, below)
- Modify: `apps/syncer/src/aggregator/aggregator.module.ts`, `aggregator.module.spec.ts`
- Modify: `apps/syncer/src/config/syncer.config.ts`, `syncer.config.spec.ts`
- Modify: `apps/syncer/.env.example`, `deploy/.env.prod.example`, `docker-compose.prod.yaml`, `docker-compose.yaml` (the environment of `syncer-xrpl` and `syncer-xahau`)
- Create: `apps/syncer/src/aggregator/aggregator.schedule.spec.ts`
- Test: `apps/syncer/test/aggregator-aggregates.e2e-spec.ts`

**Interfaces:**
- Consumes: the four runners (Tasks 8 and 9) and `AggregateSetAborted` (Task 2).
- Produces:
  - `AggregatorJobName = 'volume_live' | 'volume_daily' | 'pair_hourly' | 'markets_live' | 'stats_live' | 'stats_dirty' | 'rates_daily' | 'account_rollups' | 'volume_backfill'`.
  - The four `AGGREGATOR_*_BUDGET_MS` constants, exported, with their entries in the budgets record.
  - `AggregatorOptions.aggregates?: AggregatorAggregates` and `AggregatorOptions.aggregateFunctions?: Partial<AggregateFunctions>` (for tests).
  - `aggregatorOptions(ch, profile, config: SyncerConfig, logger?)`, which returns `{ volumes, aggregates: { rates, accountRollupMinRows } }` with one shared `RatesService`.
  - `SyncerConfig.accountRollupMinRows: number`, `@ConfigValue() @IntValue({ min: 0 })`, default `1000000`, read from `GH_ACCOUNT_ROLLUP_MIN_ROWS`.

- [ ] **Step 1: Write the failing tests.**
  - `aggregator.schedule.spec.ts` (with `volumes`, `aggregates` and fake shared functions):
    - `'the jobs of a tick are volume_live, volume_daily, pair_hourly, markets_live, stats_live, stats_dirty, rates_daily, account_rollups, volume_backfill'` (from `aggregatorRunsTotal`);
    - `'with every job registered and every D2 job using its whole budget, volume_live and volume_daily run first and finish in every one of 10 ticks, and a tick ends within AGGREGATOR_TICK_BUDGET_MS plus one set'`;
    - `'a slice of agg_dirty runs the hooks of rates_daily, pair_hourly and account_rollups after its volume sets; a failing hook is failed("<job>_dirty", …), fails the slice and keeps the range'`;
    - `'a D2 set cut short at shutdown (AggregateSetAborted) is neither an error nor counted'`;
    - `'without aggregates no D2 job runs and no hook is called'`.
  - `aggregator.module.spec.ts`: the core stub also provides `SyncerConfig`, and the expected runs include the four D2 jobs with no error on the fake database.
  - `syncer.config.spec.ts`:
    - the default is `1000000`;
    - `GH_ACCOUNT_ROLLUP_MIN_ROWS=0` gives `0`;
    - `1.5` and `abc` are refused with `GH_ACCOUNT_ROLLUP_MIN_ROWS must be a non-negative integer`.
  - `aggregator-aggregates.e2e-spec.ts` seeds the ripple-mock ledgers through `LedgerWriter`, uses `aggregates.accountRollupMinRows` 5, and ticks with `now = 2015-01-15T12:00:00Z`:
    - `'the jobs run together within the tick'`: one tick writes `pair_hourly` hours, a `markets_live` day set, at least one `native_rates_daily` day and the `account_partition_rows` sets. Every job is counted in runs and none in errors.
    - `'the back-fills resume after a restart'`: an aggregator with tiny budgets ticks twice and stops. A new one goes on: fewer days are missing, and no done day gets a new version.
    - `'an agg_dirty range marks rates stale and recomputes hours and heavy-account days'`. Insert `agg_dirty (from_hour, to_hour, created_at)` for `2015-01-14T18:00..19:00`, as `range-ingest` does, then tick:
      - the valid rate days 2015-01-14..2015-01-28 get a stale sentinel and are computed again (a newer version);
      - the hours of the range inside the last 31 days get newer sets;
      - the (heavy account, 2015-01-14) sentinels are newer;
      - the range is deleted.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-syncer test -- aggregator syncer.config` and `pnpm --filter @gatehub/data-syncer test:e2e -- aggregator-aggregates`. Expected: FAIL.
- [ ] **Step 3: Implement the registration diff.** This is all that changes in the existing aggregator files.
  - In `aggregator.service.ts`:
    - the names join `AggregatorJobName`, and the budget constants join the budgets record;
    - with `options.aggregates`, the constructor builds the four runners. Each gets `deps` with `ch`, `logger`, `metrics`, `budgetMs: this.budgets.<job>`, `clock: () => this.clock()`, `closing: () => this.closing` and `failed: (job, err, where) => this.failed(job, err, where)`;
    - the jobs list puts `pair_hourly` and `markets_live` after `volume_daily`, and `rates_daily` and `account_rollups` after `stats_dirty`;
    - in `recomputeDirty`, after the `volumesOfSlice` try block, call `ofSlice(start, end, tick)` on the `rates_daily`, `pair_hourly` and `account_rollups` runners in that order. A rejection is `this.failed('<job>_dirty', err, \` in ${iso(start)} - ${iso(end)}\`)`, with `outcome = 'failed'` and the slice loop broken;
    - `failed()` also lets `AggregateSetAborted` pass quietly at shutdown;
    - update the class comment's list of jobs.
  - In `aggregator.module.ts`, the factory injects `SyncerConfig`.
  - The env and compose files:
    - `apps/syncer/.env.example` gets a commented `GH_ACCOUNT_ROLLUP_MIN_ROWS=1000000` with the spec §10 meaning;
    - `deploy/.env.prod.example` gets `XRPL_ACCOUNT_ROLLUP_MIN_ROWS=` and `XAHAU_ACCOUNT_ROLLUP_MIN_ROWS=` (empty means the default);
    - both compose files get `GH_ACCOUNT_ROLLUP_MIN_ROWS: ${XRPL_ACCOUNT_ROLLUP_MIN_ROWS:-}` (and the Xahau one) on the two syncers.
- [ ] **Step 4: Run the tests to verify they pass** — the same commands, plus all of `pnpm --filter @gatehub/data-syncer test`. `aggregator.service.spec.ts` passes unchanged: none of its tests sets `aggregates`. Run `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add` the files above, message `feat(syncer): register pair_hourly, markets_live, rates_daily and account_rollups; GH_ACCOUNT_ROLLUP_MIN_ROWS`.

### Task 11: `interval` on `stats/{family}`, and the API's day groups

**Files:**
- Create: `apps/api/test/account-parity.e2e-spec.ts`, which writes `apps/api/test/__snapshots__/account-parity.e2e-spec.ts.snap` (Step 1, before any route change)
- Create: `apps/api/src/accounts/account-day-groups.service.ts`; Modify: `apps/api/src/accounts/accounts.module.ts` (provider)
- Create: `apps/api/src/accounts/analytics-window.ts`, `analytics-window.spec.ts`
- Modify: `apps/api/src/accounts/account-stats.controller.ts`, `account-stats.service.ts`, `account-stats-object.ts`, `account-stats-object.spec.ts`
- Modify: `apps/api/src/modules/prometheus/prometheus.service.ts`, `prometheus.service.spec.ts` (`accountDayGroupsTotal`)
- Create: `apps/api/test/cache-controllers.ts`, `apps/api/test/support/analytics-world.ts`, `apps/api/test/support/rollups.ts`
- Test: `apps/api/test/account-stats-interval.e2e-spec.ts`; `apps/api/test/account-stats.e2e-spec.ts` passes unchanged

**Interfaces:**
- Consumes:
  - Task 3: `DailyRates`, `nativeValue`.
  - Task 6: `AccountDayGroups`, `rollupCoverage`, `DAY_GROUPS_EPOCH`, `writeAccountRollups`, `writeRollupStates`.
  - Task 7: `firstChangeDay`.
  - `bucketStart`, `nextBucket`, `VolumeInterval` from `apps/api/src/network/volume-buckets.ts`.
- Produces:
  - `analytics-window.ts`:
    - `ANALYTICS_INTERVALS: readonly VolumeInterval[] = ['day', 'week', 'month']`;
    - `intervalParam(query: Query): VolumeInterval | undefined`. A missing or empty value is `undefined`; anything else outside the list is 400 `invalid interval - use: day, week, month`;
    - `bucketOfDaySql(interval: VolumeInterval): string`, which gives `day`, `toMonday(day)` or `toStartOfMonth(day)` over a `Date` column named `day`.
  - `@Injectable() class AccountDayGroupsService { source(family: DayGroupFamily, account: string, fromDay: string, throughDay: string): Promise<DayGroupsSource | null> }`. It wraps `AccountDayGroups` with `LedgerRangeResolver.resolve` and a coverage cached 60 s in `CacheService` (key `rollup-coverage:<account>`, `ROLLUP_COVERAGE_CACHE_MS = 60_000`). It counts `api_account_day_groups_total{source}` once per source used.
  - `PrometheusService.accountDayGroupsTotal`: Counter `api_account_day_groups_total`, labels `['source']` ("Day-group reads by source (raw, rollup).").
  - Test helpers:
    - `cache-controllers.ts` has `CACHE_CONTROLLERS`, with `GET /v2/test-cache/clear` calling `CacheService.clear()`;
    - `support/rollups.ts` has `rollUp(h: Harness, api: ApiClient, account: string, coverage: RollupCoverage): Promise<void>`, which writes the rollups and the state row, then clears the app's cache through that route;
    - `support/analytics-world.ts` has `seedAnalyticsWorld(h: Harness): Promise<AnalyticsWorld>`, a hand-worked world of `ledgers` and the account tables over 2020-01..2020-06 that Tasks 13 and 14 extend. It includes a typical account, an issuer that owes lines, and native pairs with trades for rates.

- [ ] **Step 1: Take the snapshots before changing anything, and commit them.**
  - Write `account-parity.e2e-spec.ts` on the `ripple-mock` harness. For every account of the mock ledgers, take:
    - `stats/transactions` and `stats/value` with `?start=2013-01-01&end=2018-01-01&limit=1000`, and with no parameters;
    - `reports/<day>?accounts=true&payments=true` for every UTC day that holds a mock ledger;
    - `reports?start=2015-01-01&end=2015-03-01&accounts=true`.

    Each answer is `expect(body).toMatchSnapshot(label)`.
  - Then fill `native_rates_daily` with `computeRatesDailySet` for every UTC day that holds a mock ledger, and assert that every answer `toEqual`s its first-pass value.
  - Run `pnpm --filter @gatehub/data-api-service test:e2e -- account-parity`. It writes the snapshots and passes.
  - Commit with `git add apps/api/test/account-parity.e2e-spec.ts apps/api/test/__snapshots__/account-parity.e2e-spec.ts.snap`, message `test(api): stats and reports answers before D2, as snapshots`.
- [ ] **Step 2: Write the failing tests.**
  - `analytics-window.spec.ts`:
    - `intervalParam`: `day`, `week` and `month` are accepted; missing and `''` give `undefined`; `year` gives the 400 above;
    - `bucketOfDaySql` gives `day`, `toMonday(day)` and `toStartOfMonth(day)`.
  - `account-stats-object.spec.ts`: `toValueStats` with `days: [{ day: '2020-02-01', n: 0, valueDay: '2020-02-29' }]` values the balances and rates of 02-29 and dates the row `2020-02-01T00:00:00Z`. Remove the `rateSpans` cases.
  - `account-stats-interval.e2e-spec.ts` (`seedAnalyticsWorld`):
    - `'transactions?interval=week|month: a row per bucket in which the account sent a transaction, with the counts of the whole bucket; date is the bucket start'`;
    - `'a bucket is a row when its start is at or after start and before end'`;
    - `'value?interval=…: a row for every bucket from the first bucket with a balance to the last before end, active or not'`. An inactive bucket has `balance_change_count` 0 and the carried value. `account_value` is taken at the end of the bucket's last day, and the current bucket is valued now;
    - `'value?interval=day has a row for every day, unlike no interval'`;
    - `'the issuer: what it owes is worth 0'`;
    - `'paging with interval: limit, descending, and the marker is the bucket's day'`;
    - `'interval is checked after the family and before the marker'`: `stats/foo?interval=year` gives `invalid family`, and `?interval=year&marker=!!` gives `invalid interval - use: day, week, month`;
    - `'the same answer rolled up'`: `rollUp` with complete coverage, then with coverage from 2020-03-01, gives bodies equal to the raw ones, and a read of `account_lines_daily` / `account_tx_daily` happened;
    - `'with interval the reads are day groups, a key range of the account, with no FINAL'`.
- [ ] **Step 3: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-service test -- analytics-window account-stats-object prometheus` and `… test:e2e -- account-stats-interval`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - The controller checks, in order: `statsWindow`, the family, `intervalParam`, then the marker (in the service). Add an `@ApiQuery` for `interval`.
  - **Without `interval` the queries stay exactly as they are.** The existing e2e suite pins their shape. Only `value`'s rates change: `DailyRates.rates(ratedAssets(…), page days)` replaces `ratesOf`. Remove `rateSpans`, `VALUE_DAYS_PER_RATE_CALL` and their spec cases, which now have no user.
  - With `interval`, `transactions` groups the `txs` day groups of the days of the buckets whose start lies in `[window.from, window.to)` by `bucketOfDaySql`. It reads `sum(count)` and `sumMap`s of result and type, ordered by bucket, `LIMIT fetch` after the marker.
  - With `interval`, `value` works in four steps:
    1. List the buckets from `max(bucket of firstChangeDay, first bucket ≥ from)` to the last bucket before `to`. Page them by marker, `descending` and `limit`.
    2. A bucket's `valueDay` is `min(nextBucket − 1 day, today)`.
    3. One read over the `lines` day groups `[DAY_GROUPS_EPOCH, last valueDay]` gives `argMax(end_balance, day)` per line and bucket label, where the days before the page's first bucket get the label `''`. It keeps only the native line and the lines whose `end_balance` is above 0 on some day read. A second aggregation gives `sumIf(count, change_type != 'transaction_cost')` per bucket.
    4. Value the buckets with `toValueStats` (its `days` items gain an optional `valueDay`) and `DailyRates` for those days.
- [ ] **Step 5: Run the tests to verify they pass** — the commands above, plus `test:e2e -- account-stats account-parity`. Expected: PASS: the snapshots match.
- [ ] **Step 6: Commit** — `git add` the files of this task, message `feat(api): interval on stats/{family}, read through day groups`.

### Task 12: `interval` on `reports`, and the 200-bucket limit

**Files:**
- Modify: `apps/api/src/accounts/account-report-window.ts`, `account-report-window.spec.ts`
- Modify: `apps/api/src/accounts/account-reports.controller.ts`, `account-reports.service.ts`
- Modify: `apps/api/src/accounts/account-report-object.ts`, `account-report-object.spec.ts`
- Test: `apps/api/test/account-reports-interval.e2e-spec.ts`; `account-reports.e2e-spec.ts` and `account-parity.e2e-spec.ts` pass unchanged

**Interfaces:**
- Consumes: Task 11's `intervalParam` and `bucketOfDaySql`; Task 3's `DailyRates`.
- Produces:
  - `reportWindow(query: Query, date: string | undefined, now: number, interval: (query: Query) => VolumeInterval = () => 'day'): ReportWindow`. It calls `interval` after the dates are parsed and before the length check.
  - `ReportWindow` gains `interval: VolumeInterval` and `buckets: string[]`, the `YYYY-MM-DD` bucket starts. For `day`, `buckets` equals `days`. For `week` and `month`, `days` is every day of the buckets up to today.
  - `ReportInput` gains `buckets?: string[]` and `bucketOf?: (day: string) => string`.

- [ ] **Step 1: Write the failing tests.**
  - `account-report-window.spec.ts`:
    - `interval` week covers 2020-01-06..2023-11-06, which is 200 weeks between the bucket starts, and is accepted. One week more is 400 `choose a date range less than 200 weeks`;
    - months behave the same, with `… 200 months`;
    - `day` keeps `choose a date range less than 200 days` and its existing cases;
    - `/{date}` with `month` is the one bucket holding the date;
    - the order is the dates, then `interval`, then the length.
  - `account-report-object.spec.ts`: with buckets, a report sums its days' values (each at its day's rate), takes the largest of the days' highs, sums the counts, and takes the counterparties as given per bucket.
  - `account-reports-interval.e2e-spec.ts` (`seedAnalyticsWorld`):
    - `'week and month give a report per bucket from the bucket of start to that of end'`;
    - `'a counterparty paid on two days of a week counts once in it; with accounts they are listed in the order of their first payment in the bucket'`;
    - `'payments=true with week is 400 payments can only be listed with interval day, after the window check'`;
    - `'interval=day is the answer without interval'`;
    - `'an invalid interval is 400 after the dates'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-service test -- account-report` and `… test:e2e -- account-reports-interval`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The controller checks, in order: `reportWindow(query, date, now, (q) => intervalParam(q) ?? 'day')`, then `payments` with a non-`day` interval. Add an `@ApiQuery` for `interval`.
  - The service keeps the per-day `groups` query. In the two counterparty queries it uses the bucket expression `toString(<bucketOfDaySql> of toDate(close_time, 'UTC'))`. For `day` the SQL text stays exactly today's.
  - The rates come from `DailyRates.rates(assets, distinct days of the groups)`.
  - `toReports` rows are the buckets.
- [ ] **Step 4: Run the tests to verify they pass** — the commands above, plus `test:e2e -- account-reports account-parity`. Expected: PASS.
- [ ] **Step 5: Commit** — `git add` the files of this task, message `feat(api): interval on reports, with a limit of 200 buckets`.

### Task 13: `analytics/balances` and `analytics/balance_changes`

**Files:**
- Modify: `apps/api/src/accounts/analytics-window.ts`, `analytics-window.spec.ts` (the window)
- Create: `apps/api/src/accounts/account-analytics.controller.ts`, `account-analytics.service.ts`, `account-analytics-object.ts`, `account-analytics-object.spec.ts`
- Modify: `apps/api/src/accounts/accounts.module.ts` (controller and service)
- Modify: `apps/api/test/support/analytics-world.ts` (more lines, changes and an owed line)
- Test: `apps/api/test/account-analytics.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 11's `AccountDayGroupsService`, `intervalParam` and `bucketOfDaySql`; Tasks 3 and 6 (`DailyRates`, `newestValidRateDay`, `nativeValue`, `balanceChangeAsset`, `mergedExactSum`, `DAY_GROUPS_EPOCH`).
- Produces:
  - `analytics-window.ts`:
    - `interface AnalyticsWindow { empty: boolean; fromDay: string; throughDay: string; start: Date; end: Date; interval?: VolumeInterval; buckets: number[] }`;
    - `analyticsWindow(query: Query, now: number, interval: 'default-day' | 'optional' | 'none'): AnalyticsWindow`;
    - `checkBucketLimit(w: AnalyticsWindow): void` and `MAX_ANALYTICS_BUCKETS = 1000`.

    The window, in detail:
    - The days run from the day of `start` (default `2013-01-01`) to the day of `end` (default now), both whole. With an interval they widen to whole buckets.
    - `start` is the first day or bucket; `end` is the start of the one after the last.
    - An `end` before `start` is `empty`, with `start` and `end` both the start of the first day or bucket of `start`.
    - Without an interval, `buckets` is one per day, and the limit applies only with an interval.
  - `CHANGE_TYPE_ORDER = ['transaction_cost', 'payment_destination', 'payment_source', 'exchange', 'intermediary', 'escrow_create', 'escrow_finish', 'escrow_cancel', 'paychannel_fund', 'paychannel_payout']`, with the unclassified (`''`) after them.
  - `AccountAnalyticsController` (`@RippleController('v2/accounts')`) and `AccountAnalyticsService`. Task 14 extends both.

- [ ] **Step 1: Write the failing tests.**
  - `analytics-window.spec.ts`:
    - `start=2026-09-20&end=2026-10-19` gives days 09-20..10-19, `end` `2026-10-20T00:00:00Z`;
    - `interval=week` widens to Monday 09-14 .. Monday 10-26;
    - `month` widens to 09-01 .. 11-01;
    - an `end` before `start` is empty;
    - the order of the errors is start, end, interval;
    - 1001 day buckets give `choose a date range of at most 1000 buckets`, and 1000 do not;
    - `none` and `optional` without an interval have no limit.
  - `account-analytics-object.spec.ts`: the `Object.keys` orders.
    - Balances: the answer is `result, start, end, interval, lines_total, lines, count, rows`; a line is `currency, counterparty?, balance`; a row is `date, currency, counterparty?, balance`.
    - Balance changes: the answer is `result, start, end, interval?, totals, count, rows`; a total is `change_type?, count, in_value, out_value, net_value`; a row without interval is `change_type?, currency, issuer?, count, in, out, in_value, out_value`; a row with interval is `date, change_type?, count, in_value, out_value`.
  - `account-analytics.e2e-spec.ts` for `balances` (values by hand from the world):
    - `'lines: the native line first, then the lines with a rate by |balance| ÷ rate (the rate of the newest valid day at or before the window's end, asset (currency, counterparty)), then the others by |balance|, then the key; limit 10 by default, 50 at most; lines_total counts them all'`;
    - `'rows: per bucket the line's last balance up to then, carried; from the bucket of its first change, or the window's first; a line back at 0 keeps rows of "0"; an owed balance is negative'`;
    - `'rows are ordered by date, then the order of lines; count is the number of rows'`;
    - `'currency (upper-cased) and counterparty (alias issuer) filter the lines; counterparty with currency=XRP is 400 counterparty cannot be specified for XRP'` (and `XAH` on a Xahau harness);
    - `'the errors come in order: start, end, interval, counterparty, the bucket limit'`.
  - For `balance_changes`:
    - `'totals: one per change type with a change, in CHANGE_TYPE_ORDER, the unclassified without change_type last; count, in_value, out_value, net_value'`;
    - `'rows without interval: per change type and asset, by type then in_value + out_value descending then currency and issuer; in and out exact; the fees (transaction_cost) count'`;
    - `'rows with interval: per bucket and change type, by date then type'`;
    - `'an owed line's change is valued as the account's own IOU (issuer = the account)'`;
    - `'values are per (group, day) at the day's rate, 17 digits, 0 without a rate'`.
  - For both:
    - `'an empty window and an unknown address are empty answers'`;
    - `'unknown parameters are ignored, Cache-Control is private, max-age=60'`;
    - `'format=csv gives the rows as <address> - balance history.csv and <address> - balance change totals.csv'`;
    - `'a failing query is 500 unable to retrieve balance history / unable to retrieve balance changes'`;
    - `'the same answer rolled up'` (complete coverage, and coverage from 2020-03-01), as in Task 11;
    - `'a light account's All reads within its own rows'`, using `readsOf` of `apps/api/test/support/read-rows.ts` on `balance_changes`, as `paged-reads.e2e-spec.ts` does;
    - `'on the ripple-mock seed, for every account, the balance_changes totals' counts and in/out sums equal an oracle from its stored rows'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-service test -- analytics` and `… test:e2e -- account-analytics`. Expected: FAIL.
- [ ] **Step 3: Implement** (spec §5.1 and §5.2).
  - Balances:
    1. One ranking read over the `lines` day groups `[DAY_GROUPS_EPOCH, throughDay]`: the last balance per line (`argMax(end_balance, day)`), after the filters, LEFT JOINed to `native_rates_daily`'s rows of the version of `newestValidRateDay(throughDay)` on `(currency, issuer) = (currency, counterparty)`. It is ordered as listed, with `LIMIT {limit}` and `count() OVER ()` as `lines_total`.
    2. One read for the chosen lines: `argMax(end_balance, day)` and `min(day)` per line and bucket label (`''` before `fromDay`).
    3. The carry-forward is done in the service.
  - Balance changes: one read of the `lines` day groups of the window, grouped by `day, change_type, currency, if(owes = 1, {account}, counterparty)`. It selects `sum(count)`, `mergedExactSum('in_sum')`, `mergedExactSum('out_sum')`, `sum(unfit)` and the float sums, read back with `sumOf`. The values and buckets are made in the service, with `DailyRates` and `nativeValue`.
  - Both routes:
    - `@RippleRoute('unable to retrieve balance history')` and `@Csv((req) => \`${req.params.address} - balance history\`, 'rows')`;
    - `@RippleRoute('unable to retrieve balance changes')` and `@Csv(… ' - balance change totals', 'rows')`;
    - `limitParam(query, { def: 10, max: 50 })`;
    - the counterparty message as in `account-balance-changes.controller.ts`;
    - Swagger `@ApiOperation` / `@ApiQuery` for every parameter.
- [ ] **Step 4: Run the tests to verify they pass** — the same commands. Expected: PASS.
- [ ] **Step 5: Commit** — `git add` the files of this task, message `feat(api): analytics/balances and analytics/balance_changes`.

### Task 14: `analytics/counterparties` and `analytics/exchanges`

**Files:**
- Modify: `packages/shared/src/query/daily-rates.ts`, `daily-rates.spec.ts` (growth: `rateRowsSql`)
- Modify: `apps/api/src/accounts/account-analytics.controller.ts`, `account-analytics.service.ts`, `account-analytics-object.ts`, `account-analytics-object.spec.ts`
- Modify: `apps/api/test/support/analytics-world.ts` (payments and trades)
- Test: `apps/api/test/account-analytics.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 13's window, controller and service; Task 6's `trades` day groups; Task 3's `DailyRates`.
- Produces:
  - A growth step on the shared `DailyRates`: `rateRowsSql(assets: Asset[], days: string[]): Promise<{ rates: DayRates; sql: string; params: Record<string, unknown> }>`. Its subquery has the columns `(currency String, issuer String, day Date, rate_f Float64)`:
    - for valid days, the table's rows of the valid sentinel versions, selected in SQL from the sentinels of `[min day, max day]`;
    - `UNION ALL` the asset-days computed on read, as array params prefixed `dr_`.
  - The object key orders:
    - counterparties: the answer is `result, start, end, sort, total, count, counterparties`; an entry is `account, sent_value, received_value, total_value, payments_sent, payments_received, first, last`;
    - exchanges: the answer is `result, start, end, total, count, pairs`; a pair is `base_currency, base_issuer?, counter_currency, counter_issuer?, count, base_volume, counter_volume, bought, sold, bought_counter, sold_counter, native_volume?`.

- [ ] **Step 1: Write the failing tests.**
  - `daily-rates.spec.ts`: `rateRowsSql` passes only the on-read asset-days as arrays, and the valid days not at all.
  - `account-analytics-object.spec.ts`: the two key orders above.
  - `account-analytics.e2e-spec.ts` for counterparties:
    - `'per counterparty: sent_value and received_value of the delivered amounts at their day's rate, payments_sent and payments_received, first and last in the window'`;
    - `'the side rule of reports: a payment to oneself would be sent'`;
    - `'total is the distinct counterparties of the window'`;
    - `'sort=value (default) and sort=count, largest first, then the account; anything else is 400 invalid sort - use: value, count'`;
    - `'limit 20 by default, 1000 at most'`;
    - `'the exact order wins over the Float64 preselection'`: two counterparties whose Float64 values tie while their exact values differ.
  - For exchanges:
    - `'per pair in the canonical stored order: count, base_volume, counter_volume, bought (base it received as buyer), sold (base it gave as seller), bought_counter and sold_counter (the counter of those trades); a self-trade is in both'`;
    - `'native_volume: the native side's volume; else per day the base volume over the base's rate, else the counter volume over the counter's rate, summed; left out when no day of the pair had a rate'`;
    - `'sorted by native_volume descending, the pairs without one last by count, then the pair key; total and count; limit 20 by default, 1000 at most'`.
  - For both:
    - CSV `<address> - counterparties.csv` (rows `counterparties`) and `<address> - exchange pairs.csv` (rows `pairs`);
    - the errors in order (start, end, then `sort`);
    - an empty window;
    - 500 `unable to retrieve counterparties` / `unable to retrieve exchanges`;
    - `'interval is not a parameter of these routes: ignored, even interval=year'` (their window is `analyticsWindow(…, 'none')`);
    - `'on the ripple-mock seed, for every account, the pairs' counts and volumes equal an oracle from its account_exchanges rows'`;
    - `'the same answer rolled up'` for exchanges (counterparties are always read on read, spec §13).
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-shared test -- daily-rates`, `pnpm --filter @gatehub/data-api-service test -- analytics` and `… test:e2e -- account-analytics`. Expected: FAIL.
- [ ] **Step 3: Implement** (spec §5.3 and §5.4).
  - Counterparties is three reads of `account_payments` (the reports read: key-ordered, `LIMIT 1 BY ledger_index, tx_index`, the `SIDE` expression):
    1. The (asset, day) pairs.
    2. Per counterparty: the counts, `min`/`max(close_time)`, `uniqExact` for `total`, and a Float64 value `sum(if(issuer = '', delivered_amount_f, if(rate_f > 0, delivered_amount_f / rate_f, 0)))` per side, LEFT JOINed to `rateRowsSql`. It keeps the best `limit + 10` by the sort.
    3. For those, the exact sums per (counterparty, side, asset, day).

    The service then values exactly, orders exactly and serves `limit`.
  - Exchanges is one read of the `trades` day groups grouped by (day, pair) with `mergedExactSum`. The native volumes are computed with `DailyRates` and `nativeValue` per day.
  - `@RippleRoute('unable to retrieve counterparties')` and `@RippleRoute('unable to retrieve exchanges')`; `limitParam(query, { def: 20, max: 1000 })`; Swagger `@ApiOperation` / `@ApiQuery` for every parameter.
- [ ] **Step 4: Run the tests to verify they pass** — the same commands. Expected: PASS.
- [ ] **Step 5: Commit** — `git add` the files of this task, message `feat(api): analytics/counterparties and analytics/exchanges`.

### Task 15: `GET /v2/network/markets`

**Files:**
- Create: `apps/api/src/network/markets.controller.ts`, `markets.service.ts`, `markets-object.ts`, `markets-object.spec.ts`
- Modify: `apps/api/src/network/network.module.ts` (controller and service)
- Create: `apps/api/test/support/markets-world.ts` (`seedMarketsWorld(h, now)`: synthetic trades, then `computePairHourSets` and `computeMarketsSet` at a fixed `now`)
- Test: `apps/api/test/network-markets.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 5's `MARKETS_PERIODS` and table; `RatesService.exchangeRate`; `precision8` and `fmtTime` from `apps/api/src/common/format.ts`; `isValidClassicAddress` from `ripple-address-codec`.
- Produces: the route. The answer's keys are `result, period, start_time, end_time, exchange?, exchange_rate?, totals, count, markets`. The totals are `pairs, pairs_traded, count, native_volume, converted_volume?`. A market is `base_currency, base_issuer?, counter_currency, counter_issuer?, count, base_volume, counter_volume, native_volume?, converted_volume?, open, high, low, last, change, open_time, last_time, sparkline`. A sparkline entry is `{ date, close? }`.

- [ ] **Step 1: Write the failing tests.**
  - `markets-object.spec.ts`:
    - `change = (last ÷ open − 1) × 100`, exact, half up to 2 decimals: open `0.41990000`, last `0.40990000` gives `"-2.38"`;
    - the prices are `precision8`;
    - `converted_volume` is native × rate to 17 significant digits;
    - the sparkline leaves out `close` for a null close;
    - the key orders above, with no `amm`, `amm_share` or `amm_pool` key ever.
  - `network-markets.e2e-spec.ts` (`seedMarketsWorld`; one suite on XRPL, one on Xahau):
    - `'period day (default), 7day and 30day read the newest include set'`;
    - `'min_trades 10 by default lists the pairs with count >= min_trades; totals.pairs counts them, listed or not; pairs_traded, count and native_volume are over every traded pair'`;
    - `'invalid period is 400 invalid period - use: day, 7day, 30day; min_trades must be a whole number from 1 to 1000000, else 400 invalid min_trades'`;
    - `'sorted by native_volume descending, the pairs without one last by count, then the pair key; limit 1000 by default, 5000 at most'`;
    - `'exchange_currency adds exchange and exchange_rate after end_time, and converted_volume after native_volume; its errors are those of the volume routes'`;
    - `'a fresh database answers {result, period, count: 0, markets: []}'`;
    - `'amm=only is ignored: the same answer, with no amm key'`;
    - `'format=csv is markets.csv with the markets'`;
    - `'a failing read is 500 unable to retrieve markets'`;
    - `'the set read is a key prefix (period, amm) of markets_live, with no FINAL'`;
    - `'Xahau: native volume in XAH, and XAH cannot have an issuer'`.
- [ ] **Step 2: Run them to verify they fail** — `pnpm --filter @gatehub/data-api-service test -- markets-object` and `… test:e2e -- network-markets`. Expected: FAIL.
- [ ] **Step 3: Implement** (spec §7).
  - The checks come in order: `period` (default `day`), `min_trades`, then the display currency, with the three checks and messages of `volume.controller.ts` copied (that file is not edited).
  - The read is `WHERE period = {period:String} AND amm = 'include' AND version = (SELECT max(version) FROM markets_live WHERE period = {period:String} AND amm = 'include')`, ordered by the key with `LIMIT 1 BY` the pair. The sentinel gives the window and the totals.
  - `exchange_rate` is `precision8(rates.exchangeRate({currency: native}, display, { live: true }))`.
  - `@RippleRoute('unable to retrieve markets')`, `@Csv('markets', 'markets')`, `limitParam(query, { def: 1000, max: 5000 })`, and Swagger `@ApiOperation` / `@ApiQuery` for every parameter (no `amm`).
- [ ] **Step 4: Run the tests to verify they pass** — the same commands. Expected: PASS.
- [ ] **Step 5: Commit** — `git add` the files of this task, message `feat(api): GET /v2/network/markets`.

### Task 16: Documentation, the reference check, the merge recipe, and the load test

**Files:**
- Modify: `docs/api-reference.md`, `docs/data-model.md`, `docs/clickhouse.md`, `docs/syncer.md`, `docs/configuration.md`, `docs/observability.md`, `docs/operations.md`
- Modify: `docs/adr/0010-ripple-v2-wire-compatibility.md` (§2), `docs/adr/README.md`
- Create: `docs/adr/0013-account-and-market-aggregates.md`
- Modify: `docs/openapi.yaml` (regenerated)
- Create: `docs/superpowers/plans/2026-10-19-account-market-aggregates.merge-recipe.md`
- Modify: `load/api-load.js`, `load/README.md`
- Test: `apps/api/test/api-reference-examples.e2e-spec.ts`

**Interfaces:**
- Consumes: every route of Tasks 11–15, and the worlds `seedAnalyticsWorld` and `seedMarketsWorld`.
- Produces: the contract the explorer's fixtures are generated from (E3, E4). The reference documents `bought_counter` / `sold_counter` and every other key of the five new routes exactly as served.

- [ ] **Step 1: Write the failing test** `api-reference-examples.e2e-spec.ts`. In the D2 sections of `docs/api-reference.md`, every JSON example is preceded by a line `<!-- d2-example GET <path?query> -->`.
  - The test seeds both worlds, GETs each path, and expects `JSON.stringify(body)` to equal `JSON.stringify(JSON.parse(block))`, key order included.
  - The examples must include at least:
    - `stats/transactions?interval=week…` and `stats/value?interval=month…`;
    - `reports?interval=month…`;
    - `analytics/balances?interval=month…`;
    - `analytics/balance_changes`, both without and with `interval`;
    - `analytics/counterparties?limit=6…`;
    - `analytics/exchanges…` (with `bought_counter` and `sold_counter`);
    - `network/markets?period=day`.

  Every example passes an explicit `end`, so that it does not depend on today.
- [ ] **Step 2: Run it to verify it fails** — `pnpm --filter @gatehub/data-api-service test:e2e -- api-reference-examples`. Expected: FAIL (no examples).
- [ ] **Step 3: Write the docs** (spec §16.5).
  - `docs/api-reference.md`:
    - the four `analytics/*` routes after `stats/{family}`, with parameters, defaults, errors in order, keys, sorting, CSV and examples;
    - `interval` in `stats/{family}` and `reports`, with the 200-bucket rule and `payments`;
    - `network/markets` after the volumes, including the §7.1 differences from `exchange_volume`;
    - the absent AMM keys (§8).
  - `docs/data-model.md`: in §3 the nine tables, their sets and sentinels; in §5's migration list, `003_account_market_aggregates.sql` after D1's `002`.
  - `docs/clickhouse.md`: the aggregate families and their reads (key prefixes, newest version, no `FINAL`).
  - `docs/syncer.md` §7: the four jobs, their runners and `AggregateJobDeps`, the registration, the `agg_dirty` hooks, and the back-fills.
  - `docs/configuration.md` §5 and §7: `GH_ACCOUNT_ROLLUP_MIN_ROWS` and the compose rows.
  - `docs/observability.md`: the metrics of spec §11, and the three alerts with their thresholds:
    - `syncer_markets_live_age_seconds{period="day"} > 600` for 10 min;
    - `syncer_pair_hourly_missing_hours > 0` for 30 min;
    - `syncer_rates_daily_missing_days > 2` for 6 h after the back-fill.
  - `docs/operations.md`: watching the back-fills, what a re-ingest does to them, and the switch gauges of spec §16.4.
  - ADR-0013: precomputed daily rates, heavy-account rollups, markets from hourly pair stats, and the self-contained runners. Its Consequences link the merge recipe.
  - ADR-0010 §2: the additions of spec §14. `docs/adr/README.md`: the 0013 row.
  - Regenerate `docs/openapi.yaml` by the procedure of `docs/development.md` §8, keeping its header comment.
- [ ] **Step 4: Write the merge recipe and verify it against the branches.**
  - The recipe document follows spec §17's items 1–10, with every resolution keeping both sides, and adds every file D2 touched that the AMM branch changes too. Find those with:
    `comm -12 <(git diff --name-only <parent of Task 1 Step 0's commit> HEAD | sort) <(git diff --name-only main...feat/amm-data | sort)`.
    The expected extras beyond §17 are `apps/syncer/src/aggregator/aggregator.module.spec.ts`, `apps/syncer/src/modules/prometheus/prometheus.service.spec.ts`, `packages/shared/test/sample-rows.ts` and the docs (`docs/clickhouse.md`, `configuration.md`, `observability.md`, `operations.md`, `syncer.md`, `data-model.md`, `api-reference.md`, `adr/0010…`, `adr/README.md`). Each gets its resolution.
  - The document also states:
    - that D2's runners stay on `AggregateJobDeps`;
    - that `apps/syncer/test/aggregator-fakes.ts` is taken from the AMM side unchanged, D2's fakes being `aggregate-job-fakes.ts`;
    - that `docs/openapi.yaml` is regenerated after the merge;
    - the database consequence (§2, §12).
  - Every file the `comm` command lists must appear in the document.
  - `load/api-load.js` gets a group for the five new routes, using the seeder's `ACCOUNT`. `load/README.md` gets a note on rolling up a seeded heavy account (`GH_ACCOUNT_ROLLUP_MIN_ROWS` lowered) before a run.
- [ ] **Step 5: Run the tests to verify they pass** — `pnpm --filter @gatehub/data-api-service test:e2e -- api-reference-examples`; then the full `pnpm test`, the three `test:e2e` suites and `pnpm build`. Expected: PASS.
- [ ] **Step 6: Commit** — `git add docs load apps/api/test/api-reference-examples.e2e-spec.ts`, message `docs: account and market aggregates: reference, data model, syncer, ADR-0013, merge recipe`.
