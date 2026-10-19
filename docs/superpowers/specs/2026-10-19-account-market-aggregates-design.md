# Account and market aggregates: design

Date: 2026-10-19. Status: proposed. Sub-project D2 of the data work for the public explorer (`GateHubNet/x-explorer`; its foundation spec
is `docs/superpowers/specs/2026-10-17-explorer-foundation-design.md` there; of its sub-projects E2 to E6, E3, Markets and DEX, and E4,
Account analytics, read what this adds). Builds on the drop-in (`2026-10-15-ripple-dropin-design.md`, rulings in
`../plans/2026-10-15-ripple-dropin.rulings.md`), and is built after D1 (`2026-10-19-validators-amendments-design.md`). It does not
depend on, copy or edit the AMM work of `feat/amm-data` (`2026-10-17-amm-data-design.md` on that branch): its jobs are runner files of
their own on `main` (section 3), and it serves no AMM field (section 8). The AMM additions are a sub-project of
their own, **D2b** (its own section, after section 17), built on `main` after the owner merges `feat/amm-data`; section 17 is the
recipe for that merge.

## Context

The explorer's approved mock boards (x-explorer `docs/superpowers/specs/2026-10-17-explorer-mock/`; their sample data is placeholder) need
two things this API cannot serve today.

- **`AccountAnalytics.dc.html`**: a period selector 30 D / 90 D / 1 Y / All (per day for 30 D and 90 D, per week for 1 Y, per month for
  All); four tiles (account value now, transactions sent, fees paid, counterparties); the account value; transactions sent per bucket by
  type; balance history per currency; money in and out per bucket; where balance changes come from; top counterparties by value; DEX
  trading per pair.
- **`Markets.dc.html`**: one table of every pair with at least 10 trades in the period (24 h, 7 days, 30 days): pair, last price, change,
  low–high, volume in the native currency, trades, AMM share, a 7-day sparkline; filters Quote, Trades (All / Order book / AMM, XRPL only)
  and text; four tiles. `MarketPair.dc.html` reads existing routes (candles, trades, active accounts) and the node; nothing here changes
  for it.

What exists, and why it is not enough:

| Board need | Today | Gap |
| --- | --- | --- |
| Account value per bucket | `stats/value`: a row per active UTC day | no week or month buckets; All is up to ~4,900 rows (5 pages of 1,000); an inactive day has no row although rates move; every page reads the account's whole balance history (`AccountStatsService.balances`) and computes rates on read |
| Transactions sent by type | `stats/transactions`, a row per active day | no buckets; All needs paging |
| Balance per line per bucket | `balance_changes`, a list of changes | the client would page through every change of the history |
| Sums by change type | nothing | |
| Counterparties with values | `reports`: per day, counts or lists | no value per counterparty; at most 200 days |
| DEX per pair | `accounts/{a}/exchanges`, a list of trades | per trade |
| Money in and out | `reports`: payments only, per day | at most 200 days; the board's footnote counts DEX trades, escrow and channels too |
| Markets table | `exchanges/{base}/{counter}?reduce=true` per pair; `network/exchange_volume` | one call per pair; `exchange_volume` lists only the markets config (5 XRPL markets, 1 on Xahau) |

**Facts that decide where the work is done** (`packages/shared/schema/001_baseline.sql`, `docs/clickhouse.md`, the verification report
`../plans/2026-10-15-ripple-dropin.verification.md`):

- The account tables are ordered by account first: `balance_changes` `(account, ledger_index, tx_index, node_index)`, `account_payments`
  `(account, ledger_index, tx_index, direction)`, `account_exchanges` `(account, ledger_index, tx_index, node_index)`,
  `account_transactions` `(account, ledger_index, tx_index)`, all P7 (`intDiv(ledger_index, 10000000)`, about 15 months). A window of
  one account is one key range per part: its cost is the rows it holds. A window of time across all accounts is no key range: every part
  that holds a ledger of it is read whole, and merged parts span days to months.
- Sizes, from the XRPL verification run (a sample, not a full history): 30,441 transactions in 204 ledgers, about 149 per ledger or
  3.3 million a day; about three balance changes per transaction, so some 10 million `balance_changes` rows a day and 4 to 5 billion in
  a P7 partition at that rate. `exchanges` is small: 878 trades in the first 20 minutes, about 64,000 a day, ordered by pair
  `(base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index)`.
- **Rates on read do not scale with the window.** `RatesService.dailyNativeRates` (`packages/shared/src/query/rates.service.ts`) costs,
  per asset, one grouped read of the pair's trades plus one "last 50 trades" read per day whose 15-day window differs (every day, for an
  asset that trades daily). All for an account holding 10 assets over 10 years is some 36,500 reads; one call takes at most 3,660 days.
- **What "All" is for a busy 10-year-old account.** An exchange hot wallet with 10,000 payments a day has about 36 million payments and
  70 million balance changes. A market maker with 50,000 fills a day has 180 million `account_exchanges` rows. An issuer gets two
  `intermediary` rows for every payment that ripples through its lines. Reading such a window takes tens of seconds and gigabytes of
  memory: past the 30 s `max_execution_time` and the 2 GiB `API_CLICKHOUSE_MAX_QUERY_MEMORY` of the apis, and far past the explorer's
  5 s loader timeout. A typical account (fewer than 10,000 transactions and 30,000 balance changes in its life) reads in tens of
  milliseconds.

## Decisions (from the owner)

- Extend data-api-new so that the account analytics work for every period: 30 D, 90 D, 1 Y and All.
- One call for the Markets table.
- The mock boards are approved.

## Owner decisions to confirm

The choices this spec makes that the owner should know, each with its reason.

- **Heavy accounts from 1,000,000 balance changes** (`GH_ACCOUNT_ROLLUP_MIN_ROWS`) get daily rollups; every other account is read on
  request. Below that a key range reads in well under 500 ms; above it an All window is tens of millions of rows (sections 1, 13).
- **No rollups for every account, and none of payments by counterparty.** They would store over a billion rows and save little, and
  counterparties compress badly (Non-goals, section 1).
- **Counterparties are read on request for every account**, so a busy exchange's 1 Y or All takes 2–10 s; the explorer gives that one
  call a 15 s timeout (sections 9, 13).
- **Markets windows start on the hour**: 24 h is 24 to 25 hours, from `pair_hourly`. Exact rolling windows across every pair at every
  request do not scale (sections 3.3, 7.1).
- **Markets lists every traded pair**, not the markets config, with `min_trades` 10 by default, prices in the canonical stored
  orientation, and native volume through the window's rate of any native pair (section 7).
- **`network/exchange_volume` is unchanged**: its components stay the markets config, for Ripple compatibility, so it and the Markets
  table can differ for a configured market (section 7.1).
- **LP tokens and assets without a DEX rate are worth 0**, as in `stats/value` and `reports` today (Non-goals, section 4).
- **`interval` on `stats/{family}` and `reports` changes answers for clients that already send one**: it was ignored before, so they now
  get buckets (section 14).
- **With `interval`, `stats/value` has a row for every bucket**, active or not, and **`reports` allows 200 buckets** of the interval
  (200 months is all of the history); `payments=true` stays per day (section 6).
- **Analytics windows are whole UTC days, `end` included** (as `reports`), unlike the exclusive `end` of `stats/{family}` (section 5).
- **A change on a line the account owes on is valued as the account's own IOU** (section 4); unclassified changes are a group without
  `change_type` (section 5.2).
- **Rates are precomputed per closed day**; today and yesterday are valued on read, cached 60 s, so they may be a minute old (sections
  3.1, 4).
- **`rates_daily` and `account_rollups` run every tick**, not on a cadence of N ticks as the roadmap asks of daily-stats jobs: their
  back-fills are long and their budgets bound them (section 3).
- **The board-text changes of section 9** (the `src` captions, the "Other" row, the money and Markets footnotes) are for the owner to
  confirm; E3 and E4 carry the same list.
- **Migration `003_account_market_aggregates.sql` and ADR-0013**, after D1's `002` and ADR-0012; if `main` gets a migration or an ADR
  first, the next free numbers, D1 before D2 (sections 2, 16).
- **D2 is merged to `main` without the AMM work**, and the owner merges `feat/amm-data` with the recipe of section 17: the two branches
  meet only in a few registration files.
- **The AMM fields wait for D2b** (section D2b): the AMM share, the `amm` filter, the swaps' completeness on the analytics routes, the
  24 h fee estimates of `amm_volume` and the range of computed AMM days. D2 serves none of them and keeps only the absent-field contract
  (section 8).

## Goals

- Every element of `AccountAnalytics` and `Markets` reads one documented field of one call (section 9).
- An account aggregate answers in under 500 ms for a typical account in every period, All included; a heavy account (section 1) answers
  from rollups in comparable time, with the exceptions listed in section 13.
- The Markets table is one call that reads one precomputed set (tens of milliseconds), refreshed every minute.
- `stats/value`, `stats/transactions` and `reports` keep their answers (closed days to the digit; today's rates may be up to a minute
  old, the age their `Cache-Control` already allows), and gain buckets for long windows.
- Nothing here depends on the AMM work: the AMM fields are absent until D2b serves them, and then present only when they are known
  (section 8).
- Everything precomputed is recomputable, survives re-ingest (`agg_dirty`) and fills its history by itself.

## Non-goals

- Rollups for every account: only heavy accounts get them (section 1).
- Rollups of payments by counterparty: they compress badly (an exchange's counterparties rarely repeat within a day); counterparties are
  read on read for every account (section 13).
- Exact rolling windows for the markets: their windows start on an hour (section 7.1).
- Changing `network/exchange_volume`: its components stay the markets config (Ripple compatibility).
- Markets of a past date, order books, token names and logos.
- An issuer's total obligations as one series: a balance history is per trust line.
- Values of LP tokens and of other assets without a DEX rate: they count as 0, as in `stats/value` and `reports`.

## 1. Where the work is done

| Aggregate | Computed | Why |
| --- | --- | --- |
| Daily native rates of every asset traded against the native currency | **precomputed**, `native_rates_daily` (job `rates_daily`) | on read they cost a read per asset and day; every valued aggregate needs them |
| Account aggregates of a typical account | **on read** from the account's key ranges, valued with the precomputed rates | a key range of at most `GH_ACCOUNT_ROLLUP_MIN_ROWS` rows (1,000,000) reads in well under 500 ms |
| Account aggregates of a heavy account (at least 1,000,000 balance changes) | **precomputed** daily rollups for closed days (job `account_rollups`), raw rows for the days after them | the raw window of a heavy account is tens of millions of rows |
| Per-pair hourly trade stats of the last 31 days | **precomputed**, `pair_hourly` (job `pair_hourly`) | one hour across all pairs is in the youngest parts and cheap; 30 days across all pairs at every request is not |
| The Markets table per period | **precomputed**, `markets_live` (job `markets_live`) from `pair_hourly` | the response reads one set |

A precomputed rollup for every account is rejected: finding the accounts a day touched means scanning the parts that hold the day in
tables ordered by account, every day and four times; it would store more than a billion rows (about 200,000 active accounts a day, a few
groups each) and save nothing for the many accounts that have one change per day and line. Heavy accounts are found once a day from the
`account` column of `balance_changes` (cheap: sorted and compressed), and their days are read through their own key ranges with
`account IN (...)`.

**Correctness never depends on a rollup.** A rollup is an exact pre-aggregation of the same rows by the same rules; the API uses it only
for the days it says it covers and reads raw rows for every other day. Before a rollup exists, or when it lags, an answer is the same,
only slower.

## 2. Storage

All new tables are aggregates written by the aggregator: `ReplacingMergeTree(version)`, no ledger table, no ingest change, no parser
version bump, no re-ingest needed. Amounts are exact decimal `String`s with `Float64` shadows where SQL ranks or falls back (the
`exactAmount` / `sumOf` rule of `packages/shared/src/query/decimal.ts`). A recompute writes a complete **set** under a new version (the
ClickHouse clock in milliseconds, at least one more than the newest version of the set, as `nextVersion` in
`packages/shared/src/aggregate/volume.job.ts`); readers keep the newest version and never use `FINAL`.

**Migration.** One new file, `packages/shared/schema/003_account_market_aggregates.sql`, with nine `CREATE TABLE IF NOT EXISTS`
statements and nothing else (the runner's splitting rules and `schema.spec.ts`: one semicolon per statement, at the end of its last
line). D1 is built first and takes `002_validators_amendments.sql`. If `main` gets another migration first, D1 and D2 take the next free
numbers, D1 before D2 (each file is renamed before it merges; its tables depend on no other migration, neither D1's nor the AMM work's,
and a rename is safe while the file has been applied to no deployed database). The file cannot collide with the AMM work, which changes
`001_baseline.sql` in place and adds no file; an existing database applies it on the next `migrate` run and keeps its data. That
in-place change has a database consequence: the migration runner refuses an applied file whose checksum changed
(`packages/shared/src/clickhouse/migrate.ts`), so a database created before the owner merges `feat/amm-data` is recreated at that merge.
D2's tables are all recomputable aggregates, so for D2 this only means its back-fills run again (section 16); the deploy-order
constraint it causes is D1's (D1's Rollout). The `Table` enum (`packages/shared/src/clickhouse/tables.ts`) and `rows.ts` get the nine
tables; the table list of the migrate e2e suite gets their physical design.

| Table | `ORDER BY` | Partition | Holds |
| --- | --- | --- | --- |
| `native_rates_daily` | `(currency, issuer, day)` | `toYear(day)` | Per closed UTC day, the rate of every issued asset whose rate that day is above 0: `rate` (exact text of the BigNumber), `rate_f`, `daily_count` and `latest_count` (diagnostics: the kept trades of the day and among the newest 50). A day is a set; its **sentinel** is the row with `currency = ''`, `issuer = ''`, carrying `config_version` and `stale`. |
| `pair_hourly` | `(hour, base_currency, base_issuer, counter_currency, counter_issuer, source)` | `toDate(hour)`, TTL `hour + 45 days`, `ttl_only_drop_parts = 1` | Per UTC hour, pair (canonical order) and `source Enum8('book' = 1, 'amm' = 2)` (`book` only until D2b): `count`, `base_sum`, `counter_sum`, `unfit`, `base_sum_f`, `counter_sum_f`; `open_rate` with its key `open_ledger, open_tx, open_node` and `open_time`; `close_rate`, its key and `close_time`; `high_rate`, `high_rate_f` and its key; `low_rate`, `low_rate_f` and its key. An hour is a set; its sentinel (empty pair, source `book`) carries `final`, `config_version` and `through_time` (the close time of the newest ledger the read covered). |
| `markets_live` | `(period, amm, base_currency, base_issuer, counter_currency, counter_issuer)` | none | Per period (`day`, `7day`, `30day`), filter `amm Enum8('include' = 1, 'exclude' = 2, 'only' = 3)` and pair: `count`, `base_volume`, `counter_volume`, `native_volume Nullable(String)`, `open`, `high`, `low`, `last` (exact rate text), `open_time`, `last_time`, `closes Array(Nullable(String))` (7 daily closes, oldest first), `amm_share Nullable(String)`, `amm_pool Nullable(UInt8)` (both NULL until D2b). A (period, filter) is a set, written in one insert; its sentinel (empty pair) carries `start_time`, `end_time`, `pairs_traded`, `total_count`, `total_native_volume`, `total_amm_share Nullable(String)` (NULL until D2b). D2 writes only the `include` sets. |
| `account_rollup_state` | `account` | none | One row per heavy account: `rows` (its balance changes when counted), `first_day`, `rolled_from Nullable(Date)`, `rolled_through Nullable(Date)` (the contiguous days its rollups cover), `config_version`. |
| `account_partition_rows` | `(partition, account)` | none | Per P7 partition of `balance_changes` (`partition UInt16` = `intDiv(ledger_index, 10000000)`), the accounts with at least 10,000 (`ACCOUNT_PARTITION_ROWS_FLOOR`) balance changes in it and their count; a partition is a set, its sentinel has `account = ''`. |
| `account_rollup_days` | `(account, day)` | `toYear(day)` | The sentinel of an (account, day) rollup set: `version` only. Written after the rows of the set. |
| `account_lines_daily` | `(account, day, currency, counterparty, change_type, owes)` | `toYear(day)` | From `balance_changes`: `count`, `in_sum`, `out_sum` (Σ positive and Σ minus negative `amount_change`, exact), `unfit`, `in_sum_f`, `out_sum_f`, and `end_balance` (the line's last `final_balance` of the day by `(ledger_index, tx_index, node_index)`, the same on every row of the line and day). `owes` is `final_balance < 0`. |
| `account_tx_daily` | `(account, day, tx_type, result)` | `toYear(day)` | From `account_transactions`, the transactions the account sent (`is_initiator = 1`): `count`. |
| `account_trades_daily` | `(account, day, base_currency, base_issuer, counter_currency, counter_issuer)` | `toYear(day)` | From `account_exchanges`: `count`, `base_sum`, `counter_sum`, `bought_sum` (base where the account is the buyer), `sold_sum` (base where it is the seller; a self-trade is in both), `bought_counter_sum` and `sold_counter_sum` (the counter of those same trades), `unfit` and the four `_f` sums. |

`balance_changes.amount_change` has no float shadow. `exactAmount` gets a form for such a column that uses `toFloat64OrZero(<column>)` as
the shadow (for the 1e36 limit and the Float64 fallback); `final_balance` sorts by its existing `final_balance_f`.

## 3. Aggregator jobs

Four jobs join the aggregator of `main` (`apps/syncer/src/aggregator/aggregator.service.ts`). Budgets and cadences are constants, not
environment variables, like the existing ones.

**Self-contained runners.** Each job is a runner in a file of its own in `apps/syncer/src/aggregator/`: `rates-daily.job-runner.ts`,
`pair-hourly.job-runner.ts`, `markets-live.job-runner.ts`, `account-rollups.job-runner.ts`. A runner keeps its own state (cursors,
back-offs, back-fill announcements, the run counter of `markets_live`'s cadence) and gets what it needs of the service through a small
interface of D2's own, `AggregateJobDeps` (`aggregate-job-deps.ts`): the `ClickHouseService`, the logger, the metrics, the clock,
`closing()`, `failed(job, err, where?)` and the job's budget. It imports only the shared package and `main`'s exported types of
`aggregator.service.ts` (`AggregatorTick`, `AggregatorJob`, type-only). It uses nothing of `feat/amm-data`: no `job-context.ts`, no
`AggregatorJobContext`, no `everyTicks` (the one cadence of N ticks is counted by its runner).

**The registration diff** is all that changes in existing aggregator files:

- `aggregator.service.ts`: the four names join `AggregatorJobName`; four budget constants (`AGGREGATOR_PAIR_HOURLY_BUDGET_MS`,
  `AGGREGATOR_MARKETS_LIVE_BUDGET_MS`, `AGGREGATOR_RATES_DAILY_BUDGET_MS`, `AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS`) and their entries
  in the budgets record; one option, `aggregates?: AggregatorAggregates` (the `RatesService` and `GH_ACCOUNT_ROLLUP_MIN_ROWS`), from
  which the constructor makes the four runners; four entries in the jobs list, at the places of the table below; in `recomputeDirty`,
  after the slice's volume sets, one call per runner with a hook (`ofSlice(start, end, tick)`: `rates_daily`, `pair_hourly`,
  `account_rollups`), whose failure is `failed('<job>_dirty', …)` and fails the slice, as the volume sets' does; the runners' abort
  error joins the shutdown test of `failed`.
- `aggregator.module.ts`: `aggregatorOptions` also returns `aggregates`, with the `RatesService` the volume jobs get; its factory
  injects `SyncerConfig` for the variable.
- `apps/syncer/src/modules/prometheus/prometheus.service.ts`: the metrics of section 11.

The runners' tests are spec files of their own, and so is the scheduling test (`aggregator.schedule.spec.ts`: the order, and that the
live volume jobs are not starved with every job registered); `aggregator.service.spec.ts` changes only where a test lists every job.

**The tick order** (a job gets what the jobs before it left of the tick's 30 s budget, `AGGREGATOR_TICK_BUDGET_MS`; a tick a minute).
Jobs 3 and 8 are the AMM work's and exist only once the owner has merged `feat/amm-data` (section 17); on `main` before that, the order
is the same without them.

| # | Job | Budget | Cadence |
| --- | --- | --- | --- |
| 1 | `volume_live` | 5 s | every tick (existing) |
| 2 | `volume_daily` | 4 s | every tick (existing) |
| 3 | `amm_pools` | 3 s | every tick (`feat/amm-data`, after the merge) |
| 4 | **`pair_hourly`** | 3 s (`AGGREGATOR_PAIR_HOURLY_BUDGET_MS`) | every tick |
| 5 | **`markets_live`** | 3 s (`AGGREGATOR_MARKETS_LIVE_BUDGET_MS`) | every tick; `7day` and `30day` sets every 5 ticks (`MARKETS_LONG_EVERY_TICKS`, counted by the runner) |
| 6 | `stats_live` | 20 s | every tick (existing) |
| 7 | `stats_dirty` | 10 s | every tick (existing); new hooks below |
| 8 | `amm_daily` | 4 s | every 5 ticks (`feat/amm-data`, after the merge) |
| 9 | **`rates_daily`** | 8 s (`AGGREGATOR_RATES_DAILY_BUDGET_MS`) | every tick |
| 10 | **`account_rollups`** | 8 s (`AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS`) | every tick |
| 11 | `volume_backfill` | 10 s | every tick (existing) |

Jobs 9 and 10 do real work once a day plus their back-fills; at every other tick a few small reads tell them there is nothing to do.
They run every tick, not on a cadence of N ticks as the roadmap asks of daily-stats jobs, because their back-fills are long and their
budgets already bound them; the plan's scheduling test shows the live volume jobs are not starved with every job registered.

All jobs follow the existing rules: only committed ledgers count (a window becomes a range of `ledgers` first); a set is idempotent and
retried at the next tick; a failure is logged and counted (`syncer_aggregator_errors_total{job}`) and never stops the loop; a set that
keeps failing waits 5 minutes, doubling up to an hour, while the others go on; a shutdown aborts the set in flight before it writes.
**Final** means what it means for the daily volumes (R86): the newest committed ledger closed at least `VOLUME_DAY_SETTLE_MS` (one hour)
after the end of the day; for an hour, at or after its end.

### 3.1 `rates_daily`

Writes `native_rates_daily`: for a closed, final UTC day D, the value `dailyNativeRates([asset], D, D + 1)` would give, for every asset.
Only final days are written; today, and yesterday until it is final, are always valued on read.

- **One day, two reads.** (1) The native pairs that traded in days D−14..D, from `exchanges` in the ledger range of those 15 days (the
  pair columns only, `GROUP BY` pair, the native side being the one with an empty issuer). (2) For those pairs as a tuple list (the
  pair prefix of the key, as `RatesService.pairSums` reads), the rows of that ledger range, each once (`LIMIT 1 BY` the whole key), then
  the newest 50 per pair (`ORDER BY` the key descending, `LIMIT 50 BY` pair), and over those the kept trades (a native leg above 0.0005)
  with `volumeColumns`: that is the "latest" window of `dailyRatesOf`. A second aggregation of the same deduplicated rows gives, per pair,
  the `volumeColumns` sums of the kept trades of day D: the "daily" part. `combineRates(daily, latest)`, with the strict minimum of 10
  kept trades in the latest part, is the rate; a pair is oriented native → asset as `orient` does. The code is a new shared method,
  `RatesService.dailyNativeRatesOfDay(day)`, next to `dailyNativeRates`, and the e2e suite proves they agree for every asset (section 15).
- **The set** is the assets with a rate above 0 (an absent asset is 0) and the sentinel, in one insert, with `config_version =
  RATES_DAILY_CONFIG_VERSION` (1) and `stale = 0`. A day is **valid** when its newest sentinel has `stale = 0` and the current config
  version.
- **Order of work per run**: yesterday once it is final and not valid; then the closed final days that are not valid, newest first, down
  to the day of the first trade against the native currency (`min(close_time)` of the native pairs, read once at start). At least one day
  per run, whatever is left of the budget.
- **Correction.** A `stats_dirty` slice whose hours fall in day X marks days X..X+14 stale: for each of them that has a valid set, a new
  sentinel with `stale = 1` and no rows (a day's rate reads trades back 14 days). The back-fill then computes them again, newest first.
  Until it has, readers value those days on read. The marking is a few inserts in the slice; a failure fails the slice, which keeps its
  range (a mark is never lost).

### 3.2 `pair_hourly`

Writes the hourly stats of every pair for the last 31 days (`PAIR_HOURLY_DAYS`); the TTL drops what is older than 45 days.

- **One set** is one hour: from `exchanges` in the ledger range of the hour, all pairs, each row once (`LIMIT 1 BY` the whole key), the
  kept trades only (`KEEP_ANY_PAIR`: native legs of 0.0005 or less are left out, as in candles and `reduce`), grouped by pair and source,
  with the candle expressions of `AGGREGATE_COLUMNS` (`apps/api/src/exchanges/exchange-aggregate.ts`; open and close by key, high and low
  by `rate_f` with the key as tie-break) and the keys of the trades they name. In D2 every row is `book`; D2b splits by source.
- **Order of work per run**: the current hour, and the previous hour until it is final, the stalest first; then the hours of the last 31
  days that have no final set of `PAIR_HOURLY_CONFIG_VERSION` (1; D2b makes it 2), newest first. A whole missing UTC day is one read
  grouped by hour and 24 inserts. At first start the 31 days take minutes.
- **Correction.** A `stats_dirty` slice recomputes the hours it covers that lie in the last 31 days.

### 3.3 `markets_live`

Writes the Markets sets from `pair_hourly`.

- **Window** of period P (24 h, 7 days or 30 days) at a run: the hours from `floorHour(t) − P` to `floorHour(t)`, where t is the
  `through_time` of the newest set of the current hour; `start_time = floorHour(t) − P`, `end_time = t`. The window is at least P and at
  most P plus 59 minutes 59 seconds long. A set is written only when every hour of its window and of its 7 sparkline days has a set of
  the current config version (final, except the last two hours); otherwise the set is skipped (logged once per gap;
  `syncer_pair_hourly_missing_hours` is what alerts) and the previous set stays.
- **Per pair**, over the window's hour rows of the sources the filter takes (`include`: both, `exclude`: `book`, `only`: `amm`), newest
  version of each hour: `count` and the two volumes are sums (exact; the Float64 sums when an hour is unfit or an exact hourly sum is at
  or above 1e36: the `sumOf` rule); `open` and `last` are the rates of the first and last trade by key, `high` and `low` by rate with the
  key as tie-break, `open_time` and `last_time` the close times of the first and last trade.
- **Native volume.** For a pair with a native side, that side's volume. Otherwise the base volume over the base's rate, else the counter
  volume over the counter's rate; an asset's rate is its volume over the native volume of its pair against the native currency in the
  same window, all trades (filter `include`), whichever filter the set is for. The quotient is cut to 17 significant digits
  (`QUOTIENT_DIGITS`). Without a rate on either side there is no native volume. This is the rule of `tradeComponents` with every native
  pair instead of the configured ones.
- **Closes**: the close of each of the 7 UTC days ending with the day of t (6 closed days and today so far), from the hour rows of the
  filter: the last trade's rate of the day; a day without a trade carries the close before it; a day with no close before it within the
  7 days has none (null in the array).
- **Totals** (on the sentinel): `pairs_traded` (pairs with at least one kept trade), `total_count`, `total_native_volume` (over the pairs
  that have one); `total_amm_share` is NULL in D2 (D2b fills it).
- D2 writes the `include` set of each period, with `amm_share` and `amm_pool` NULL on every row (section 8); D2b writes the three
  filters.

### 3.4 `account_rollups`

Off when `GH_ACCOUNT_ROLLUP_MIN_ROWS` is 0. Per run, in order:

1. **Discovery.** `account_partition_rows` for a partition is recounted when its newest set is older than 24 hours (the partition of the
   newest ledger) or 7 days (every other partition): `SELECT account, count()` of `balance_changes` in the partition's ledger range, in 58
   slices by the second character of the address (the base58 alphabet, a key range each), keeping accounts with at least
   `ACCOUNT_PARTITION_ROWS_FLOOR` rows.
   An account is **heavy** when its rows over the newest set of every partition reach `GH_ACCOUNT_ROLLUP_MIN_ROWS`. A new heavy account
   gets a state row with its `first_day` (the day of its first balance change: a key-ordered read of one row) and no coverage. An account
   that is no longer heavy (the setting was raised) gets a state row without coverage; its rollup rows stay unused.
2. **Daily increment.** For each final day d after a heavy account's `rolled_through`, oldest first, all the heavy accounts whose
   `rolled_through` is d − 1 are rolled together: three reads (`balance_changes`, `account_transactions` sent, `account_exchanges`) with
   `account IN (...)` and the ledger range of d, each row once (`LIMIT 1 BY` the key), grouped by account and the table's group columns;
   the rows are inserted under one version, then a sentinel per (account, day) that has rows or had a sentinel, then the state rows with
   `rolled_through = d`.
3. **Promotion.** A heavy account without coverage starts at its newest final day; one whose `rolled_from` is after its `first_day` gets
   its next slice backwards. A slice is as many whole days as hold about 2,000,000 rows (`ACCOUNT_ROLLUP_SLICE_ROWS`), estimated from the
   account's count in the partition, at least one day. After the slice, `rolled_from` is the slice's first day. Newest first, so 1 Y is
   covered before All.
4. **Correction.** A `stats_dirty` slice (at most a day) recomputes, for every heavy account whose coverage holds the day, that
   (account, day) set as in step 2, and the next discovery recounts the partition. A failure fails the slice, which keeps its range.

`ACCOUNT_ROLLUP_CONFIG_VERSION` (1) is on every state row; a state row of another version has no coverage for the API, and the job
promotes the account again. Rollups store amounts, never values: they do not depend on `native_rates_daily`, and a change of rates needs
no rollup recompute.

## 4. Shared read helpers

What both the API and the aggregator use lives in `packages/shared`: the candle expressions `AGGREGATE_COLUMNS` and
`AGGREGATE_SOURCE_COLUMNS` and `QUOTIENT_DIGITS` move there from `apps/api` (re-exported where the API imports them today), next to the
helpers below.

- **`DailyRates`** (`packages/shared/src/query/daily-rates.ts`): `rates(assets, days)` → `assetKey → day → rate`. The days with a valid
  `native_rates_daily` set are read from it in one read (the assets as tuples, a key prefix; per day the rows of its sentinel's version);
  every other day of the request is computed on read with `dailyNativeRates`, a call per contiguous run of at most 3,000 days (the cap of
  `rateSpans`). The API caches what it computes on read per asset and day for 60 s (`CacheService`), so the today and yesterday of a busy
  asset are computed once a minute, not once a request. `stats/value`, `reports` and every new account aggregate value through it. The
  answers are the same as with `dailyNativeRates` alone (section 15), to the digit wherever the amounts fit a `Decimal256(30)`; where one
  does not, both use Float64 sums, which may differ in their last bit (as two runs of today's code may: `decimal.ts`).
- **Valuation** (the rule of `reports`): the native currency is worth itself; an issued amount is worth amount ÷ rate of its asset on its
  UTC day, the quotient cut to 17 significant digits per (group, day), 0 without a rate or with a rate of 0; sums of values are exact. For
  a balance change the asset is `(currency, counterparty)`, or `(currency, account)` when the row's `final_balance` is negative: the
  account owes on that line, so it moves its own IOU (the test the parser uses to type `intermediary`).
- **Buckets**: `day` (UTC), `week` (Monday to Monday, UTC, as `toMonday`), `month` (calendar, UTC), the same as the historical volumes.
- **Day groups** (`packages/shared/src/query/account-day-groups.ts`): what an account aggregate reads, one group per UTC day and group
  key, from one of two sources that give identical groups. The **rollup** source serves the days in `[rolled_from, rolled_through]` of a
  state row of the current config version (rows of the version of each day's sentinel in `account_rollup_days`); the **raw** source the
  ledger ranges of the window outside those days (at most two ranges), reading the account's key range with each row once (`LIMIT 1 BY`
  the rest of the key, in a subquery ordered by the whole key, as `reports` reads). The state row is cached per account for 60 s in the
  API's `CacheService`.

## 5. Account aggregate endpoints

New routes under `GET /v2/accounts/{address}/analytics/`. They are additions (ADR-0010); they use the contract layer (`@RippleController`,
`@RippleRoute`, the API key, the rate limit, `GH_CACHE_CONTROL`, `format=csv` with flattening, errors `{result:"error", message}`), and
their object key orders are ours, pinned by tests.

**Common rules.**

| Topic | Rule |
| --- | --- |
| Address | Not validated, as on the other account routes: an address that is none has empty answers. |
| `start`, `end` | The house date formats. Defaults `2013-01-01` and now. The window is the UTC days from the day of `start` to the day of `end`, both whole. With an `interval` it is widened to whole buckets. An `end` before `start` gives an empty answer. The answer's `start` is the start of the first day or bucket, its `end` the start of the one after the last (exclusive). |
| `interval` | `day`, `week` or `month` where a route takes one. Else 400 `invalid interval - use: day, week, month`. |
| Bucket limit | At most 1,000 buckets, else 400 `choose a date range of at most 1000 buckets`. Routes without an `interval` have no limit. |
| Error order | `invalid start date format`, `invalid end date format`, then the `interval`, then the route's other parameter errors in the order of its parameter table, then the bucket limit. |
| Units | Amounts in whole units as exact decimal strings; values in the native currency as exact decimal strings (section 4); counts as numbers; times `YYYY-MM-DDTHH:mm:ssZ`; bucket dates are the bucket start. A key without a value is left out; `null` is never served. |
| Sorting | As each route says, with a final tie-break on the key text, so an answer is deterministic. No markers: the lists are whole answers or top lists. |
| Cost | Day groups (section 4) and one `DailyRates` call per request. |

### 5.1 `GET /v2/accounts/{address}/analytics/balances`: balance history per line

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end`, `interval` | `day` | As above. |
| `currency` | all | Only lines of this currency (upper-cased). |
| `counterparty` (alias `issuer`) | all | Only lines with this account. Together with `currency` set to the native currency: 400 `counterparty cannot be specified for XRP` (`XAH` on Xahau), the message of `balance_changes`. |
| `limit` | 10 (max 50) | How many lines (`limitParam`). |
| `format` | json | `csv`: file `<address> - balance history.csv`, the `rows`. |

A **line** is a currency and a counterparty (`''` for the native currency), as in `balance_changes`. A line's balance at the end of a
bucket is its last `final_balance` up to then (exact text); a bucket without a change carries the balance before it. A balance below 0 is
what the account owes on that line and is served negative. A line has rows from the bucket of its first change, or from the first bucket
of the window when it changed before the window; a line whose balance went back to 0 keeps rows of `"0"`.

**Which lines.** Those with a change up to the end of the window, after the filters, ranked: the native line first; then the lines with
a rate, by |balance| ÷ rate (the asset `(currency, counterparty)`, the rate of the newest valid day of `native_rates_daily` at or before
the window's end), largest first; then the lines without a rate by |balance|, largest first. The first `limit` are served.

```json
{ "result": "success", "start": "2026-09-20T00:00:00Z", "end": "2026-10-20T00:00:00Z", "interval": "day",
  "lines_total": 7,
  "lines": [ { "currency": "XRP", "balance": "12480.256114" },
             { "currency": "USD", "counterparty": "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", "balance": "3120.5" } ],
  "count": 60,
  "rows": [ { "date": "2026-09-20T00:00:00Z", "currency": "XRP", "balance": "12011.5" },
            { "date": "2026-09-20T00:00:00Z", "currency": "USD", "counterparty": "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", "balance": "3000" } ] }
```

Keys: answer `result, start, end, interval, lines_total, lines, count, rows`; line `currency, counterparty?, balance` (the balance at the
window's end); row `date, currency, counterparty?, balance`. Rows are ordered by date, then by the order of `lines`.

**Query plan.** (1) Each line's last balance up to the window's end: `argMax(final_balance, (ledger_index, tx_index, node_index))` by line
over the account's key range up to the last ledger of the window (raw), or the newest `end_balance` per line over the covered rollup days
merged with the raw ranges; the ranking is done in SQL, the Float64 shadows ranking and the rates of that one day joined from
`native_rates_daily`, so only the chosen lines leave the database. (2) For the chosen lines, the last balance per bucket and the last
balance before the window, in one grouped read (a bucket of `''` for "before"), as `AccountStatsService.balances` does per day; the
carry-forward is done in the service. Errors: 500 `unable to retrieve balance history`.

### 5.2 `GET /v2/accounts/{address}/analytics/balance_changes`: sums by change type and currency

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | | As above. |
| `interval` | none | None: `rows` are per change type and asset. With one: `rows` are per bucket and change type. |
| `format` | json | `csv`: file `<address> - balance change totals.csv`, the `rows`. |

Every balance change of the window counts once, the fee rows (`transaction_cost`) included. A change type is one of the ten of
`balance_changes`; the changes of transaction types the original never classified have none and are grouped without a `change_type` key
(the convention of the `balance_changes` objects). `in` is the sum of the positive `amount_change`s, `out` the sum of the negative ones as
a positive amount; `in_value` and `out_value` are their values (section 4), `net_value = in_value − out_value`; `count` is the number of
changes.

```json
{ "result": "success", "start": "2026-09-20T00:00:00Z", "end": "2026-10-20T00:00:00Z",
  "totals": [ { "change_type": "transaction_cost", "count": 63, "in_value": "0", "out_value": "0.000756", "net_value": "-0.000756" },
              { "change_type": "payment_destination", "count": 14, "in_value": "9840", "out_value": "0", "net_value": "9840" },
              { "count": 2, "in_value": "120", "out_value": "300", "net_value": "-180" } ],
  "count": 2,
  "rows": [ { "change_type": "transaction_cost", "currency": "XRP", "count": 63, "in": "0", "out": "0.000756", "in_value": "0", "out_value": "0.000756" },
            { "change_type": "payment_destination", "currency": "USD", "issuer": "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", "count": 3,
              "in": "1200", "out": "0", "in_value": "2918.8", "out_value": "0" } ] }
```

With `interval`, `interval` follows `end` and a row is `{ "date", "change_type"?, "count", "in_value", "out_value" }` for each bucket and
change type with at least one change.

Keys: answer `result, start, end, interval?, totals, count, rows`; total `change_type?, count, in_value, out_value, net_value`; row
without interval `change_type?, currency, issuer?, count, in, out, in_value, out_value` (the asset of section 4, no issuer for the native
currency); row with interval `date, change_type?, count, in_value, out_value`. Change types come in this order: `transaction_cost,
payment_destination, payment_source, exchange, intermediary, escrow_create, escrow_finish, escrow_cancel, paychannel_fund,
paychannel_payout`, then the unclassified; `totals` has a row for each type with a change; `rows` without interval are ordered by type, then
`in_value + out_value` descending; with interval by date, then type.

**Query plan.** One grouped read of day groups by `(day, change_type, currency, asset issuer, sign)` with `count` and the exact sums (raw:
the account's key range of the window; rollup: `account_lines_daily` grouped the same way, the issuer from `owes`). The groups are few (the
asset issuer folds an issuer's many lines into one asset), the values and buckets are made in the service. Errors: 500 `unable to
retrieve balance changes`.

### 5.3 `GET /v2/accounts/{address}/analytics/counterparties`

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | | As above. |
| `sort` | `value` | `value` (`total_value`) or `count` (`payments_sent + payments_received`), largest first, then the account. Else 400 `invalid sort - use: value, count`. |
| `limit` | 20 (max 1000) | |
| `format` | json | `csv`: file `<address> - counterparties.csv`. |

The payments of `account_payments` in the window, each once, with the side rule of `reports` (a payment to oneself would be one sent
payment whose counterparty is the account; the ingest stores none). Per counterparty: `sent_value`, what the account paid it, and
`received_value`, what it paid the account (the delivered amounts, valued as in section 4); `payments_sent` and `payments_received`, the
number of payments each way; `first` and `last`, the times of the first and last payment between them in the window.

```json
{ "result": "success", "start": "2026-09-20T00:00:00Z", "end": "2026-10-20T00:00:00Z", "sort": "value", "total": 14, "count": 6,
  "counterparties": [ { "account": "rNYbL8…", "sent_value": "4820", "received_value": "0", "total_value": "4820",
                        "payments_sent": 9, "payments_received": 0,
                        "first": "2026-09-21T10:11:12Z", "last": "2026-10-17T08:00:01Z" } ] }
```

Keys: `result, start, end, sort, total, count, counterparties`; counterparty `account, sent_value, received_value, total_value,
payments_sent, payments_received, first, last`. `total` is the number of distinct counterparties in the window.

**Query plan** (always on read, section 13). (1) The sums per (asset, day) over all counterparties, so the service knows which asset-days
to rate. (2) Per counterparty, in SQL, the counts, first and last time, `uniqExact` for `total`, and a Float64 value (`delivered_amount_f`
over `rate_f`, the rates of the valid days joined from `native_rates_daily` and those of the other days passed as array parameters);
the `limit + 10` best by the sort. (3) For those, the exact sums per (asset, day); the service values them exactly and orders them
exactly. Errors: 500 `unable to retrieve counterparties`.

### 5.4 `GET /v2/accounts/{address}/analytics/exchanges`: DEX summary per pair

| Parameter | Default | Meaning |
| --- | --- | --- |
| `start`, `end` | | As above. |
| `limit` | 20 (max 1000) | |
| `format` | json | `csv`: file `<address> - exchange pairs.csv`. |

The trades of `account_exchanges` in the window (the account is the buyer or the seller), each once, per pair in the canonical stored
order. `bought` is the base the account received (it was the buyer), `sold` the base it gave (it was the seller); a self-trade is in both.
`bought_counter` is the counter the account paid for what it `bought`, and `sold_counter` the counter it received for what it `sold`,
so a consumer that shows the pair the other way round (the explorer's natural orientation, E3) has both sides of each side exactly.
`native_volume` is, for a pair with a native side, that side's volume; otherwise per day the base volume over the base's rate, else the
counter volume over the counter's rate, summed (section 4); it is left out when no day of the pair had a rate. On `main` before the AMM
merge `account_exchanges` holds order-book trades only; after it, swaps against pools are trades like any other (no filter; section
D2b.2).

```json
{ "result": "success", "start": "2026-09-20T00:00:00Z", "end": "2026-10-20T00:00:00Z", "total": 4, "count": 4,
  "pairs": [ { "base_currency": "USD", "base_issuer": "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", "counter_currency": "XRP", "count": 9,
               "base_volume": "3500", "counter_volume": "8420", "bought": "1500", "sold": "2000",
               "bought_counter": "3610", "sold_counter": "4810", "native_volume": "8420" } ] }
```

Keys: `result, start, end, total, count, pairs`; pair `base_currency, base_issuer?, counter_currency, counter_issuer?, count, base_volume,
counter_volume, bought, sold, bought_counter, sold_counter, native_volume?`. Sorted by `native_volume` descending (pairs without one last, by `count`), then by the pair
key. **Query plan**: day groups by (day, pair) with `count` and the exact sums (raw: the account's key range; rollup:
`account_trades_daily`). Errors: 500 `unable to retrieve exchanges`.

## 6. Changes to existing routes

### 6.1 `GET /v2/accounts/{address}/stats/{family}`: `interval`

The routes keep their answers without `interval`. `interval` (`day`, `week` or `month`; 400 `invalid interval - use: day, week, month`,
checked after the family and before the marker) makes the rows buckets: a bucket is a row when its start is at or after `start` and before
`end` (the route's rule for days, applied to bucket starts; `end` stays exclusive). `date` is the bucket start; the marker is its day
(`YYYY-MM-DD`, the existing marker format).

- `transactions`: a row per bucket in which the account sent a transaction, with the counts of the bucket. As the days: a bucket without
  one has no row.
- `value`: a row for **every** bucket from the first bucket in which the account had a balance (the bucket of its first change, or the
  first bucket of the window when it changed before) to the last bucket before `end`, active or not: a level exists at every bucket end
  and moves with the rates. `account_value` is the value at the end of the bucket's last day (now, for the current bucket) at that day's
  rates; `balance_change_count` counts the bucket's changes, the fee not counted (0 for an inactive bucket).

Paging is unchanged (`limit` 200, max 1000); All per month is about 170 rows, one page. Both families read through day groups (heavy
accounts from rollups) and `value` through `DailyRates`. The query of `value` keeps only the lines that are above 0 at some point read
(the others are worth 0 at every bucket end), which also bounds what an issuer's many owed lines cost.

### 6.2 `GET /v2/accounts/{address}/reports[/{date}]`: `interval`, and the 200-day limit

`interval` (`day`, `week` or `month`, default `day`; 400 `invalid interval - use: day, week, month`, checked after the dates) gives a
report per bucket from the bucket of `start` to the bucket of `end`; `/{date}` gives the one bucket that holds the date. **The limit
becomes 200 buckets**: 200 days with `day` (unchanged, `choose a date range less than 200 days`), 200 weeks with `week` (about 3.8
years, `choose a date range less than 200 weeks`), 200 months with `month` (about 16.7 years, all of the history; `choose a date range
less than 200 months`). The window length for weeks and months is counted in buckets, from the bucket of `start` to that of `end`.

A bucket's report adds its days up: the totals are the sums of the days' values (each payment at its day's rate), the highs the largest
of the days', the payment counts sums; the counterparties are counted (or, with `accounts`, listed in the order of their first payment)
over the whole bucket, not added per day. `payments=true` with `week` or `month` is 400 `payments can only be listed with interval day`
(a list of every payment of up to 200 months has no bound). The checks come in this order: the dates, `interval`, the window length, then
`payments`. The payments are read on read for every account, as today (there is no payments rollup); the rates come from `DailyRates`.

## 7. `GET /v2/network/markets`

The trade statistics of every pair in a live period, from one `markets_live` set.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `period` | `day` | `day`, `7day` or `30day` (the live periods of `exchange_volume` that the board uses). Else 400 `invalid period - use: day, 7day, 30day`. |
| `min_trades` | 10 | List the pairs with at least this many trades. A whole number from 1 to 1,000,000, else 400 `invalid min_trades`. |
| `exchange_currency`, `exchange_issuer` | the native currency | Also show volumes in this currency, at the live rate (as the live volume rows): the errors of the volume routes, `exchange currency must have an issuer`, `XRP cannot have an issuer` (`XAH`), `invalid exchange issuer address`. |
| `amm` | `include` | From D2b only (section D2b.1). In D2, not a parameter (ignored, as unknown parameters are; section 8). |
| `limit` | 1000 (max 5000) | |
| `format` | json | `csv`: file `markets.csv`, the `markets`. |

```json
{ "result": "success", "period": "day", "start_time": "2026-10-18T11:00:00Z", "end_time": "2026-10-19T11:42:31Z",
  "totals": { "pairs": 214, "pairs_traded": 1840, "count": 61234, "native_volume": "123456789.12" },
  "count": 214,
  "markets": [ { "base_currency": "USD", "base_issuer": "rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq", "counter_currency": "XRP",
                 "count": 18420, "base_volume": "41200000", "counter_volume": "16888000", "native_volume": "16888000",
                 "open": "0.41990000", "high": "0.42500000", "low": "0.40100000", "last": "0.40990000", "change": "-2.38",
                 "open_time": "2026-10-18T11:00:03Z", "last_time": "2026-10-19T11:42:30Z",
                 "sparkline": [ { "date": "2026-10-13T00:00:00Z", "close": "0.41230000" }, { "date": "2026-10-14T00:00:00Z", "close": "0.41800000" },
                                { "date": "2026-10-15T00:00:00Z", "close": "0.41800000" }, { "date": "2026-10-16T00:00:00Z", "close": "0.42010000" },
                                { "date": "2026-10-17T00:00:00Z", "close": "0.41500000" }, { "date": "2026-10-18T00:00:00Z", "close": "0.41990000" },
                                { "date": "2026-10-19T00:00:00Z", "close": "0.40990000" } ] } ] }
```

- **Pairs**: every pair traded in the window, not the markets config, in the canonical stored order (as `/v2/exchanges` serves them);
  prices are counter per base. `count` counts kept trades (native legs above 0.0005, the rule of candles and `reduce`); the pairs with
  `count >= min_trades` are listed, sorted by `native_volume` descending (pairs without one last, by `count`), then by the pair key, at most
  `limit`.
- **Fields**: `open`, `high`, `low`, `last` with 8 significant digits (`precision8`, as candles); `change` = (last ÷ open − 1) × 100,
  exact, rounded half up to 2 decimals; volumes exact; `native_volume` as section 3.3; `sparkline` the 7 days of section 3.3 as
  `{date, close?}` (`close` left out for a day without one).
- **Display currency**: with `exchange_currency`, the answer adds `exchange {currency, issuer?}` and `exchange_rate` (units of it per
  native coin: `exchangeRate(native, it, { live: true })`, 8 significant digits) after `end_time`, and each market and the totals a
  `converted_volume` after `native_volume` (native volume × rate, 17 significant digits).
- **Totals**: `pairs` (listed or not, with `count >= min_trades`), `pairs_traded`, `count` and `native_volume` over all traded pairs.
- **Keys**: answer `result, period, amm?, start_time, end_time, exchange?, exchange_rate?, totals, count, markets`; totals `pairs,
  pairs_traded, count, native_volume, converted_volume?, amm_share?`; market `base_currency, base_issuer?, counter_currency,
  counter_issuer?, count, base_volume, counter_volume, native_volume?, converted_volume?, open, high, low, last, change, open_time,
  last_time, amm_share?, amm_pool?, sparkline`. `amm`, `amm_share` and `amm_pool` are never present in D2 (section 8).
- **No set yet** (a fresh database): `{ "result": "success", "period": "day", "count": 0, "markets": [] }`.
- **Query plan**: the newest version of the (period, filter) set, a prefix of the key (`version = (SELECT max(version) ...)`, as the live
  volumes read; a set is one insert); the filter, sort and limit in the service. Errors: 500 `unable to retrieve markets`.

### 7.1 The pair source and `exchange_volume`

`exchange_volume` keeps its components from the markets config, as the original's job did (wire compatibility). For a configured market
the two routes can differ: the markets window starts on the hour, the live volume window does not; and the markets rate of an asset comes
from its native pair whether configured or not, where `exchange_volume` takes only configured native markets. Both rules are documented
in `api-reference.md`. Making `exchange_volume` use every pair is out of scope.

## 8. AMM fields: the absent-field contract

D2 reads nothing of the AMM work and serves no AMM field. What it fixes now is the contract D2b fills in:

- **In D2 the AMM keys are never present.** `network/markets` has no `amm` key in the answer, no `totals.amm_share`, and no `amm_share`
  or `amm_pool` on a market; `amm` is not a parameter (ignored, as unknown parameters are). The columns that will hold them exist from
  `003` (`pair_hourly.source`, `markets_live.amm`, `amm_share`, `amm_pool`, `total_amm_share`; section 2) and are written `book`,
  `include` and NULL, so D2b needs no migration for them.
- **From D2b they are present only when known.** A markets set has `amm_share`, `amm_pool` and `total_amm_share` only when every
  ledger of its window was written by a parser that knows AMM (the parser gate of section D2b.1). An absent field means "not known",
  never 0 or `false`.
- **The explorer reads them only while its `AMM_DATA` switch is on** (the explorer program's one AMM-data signal; the owner turns it on
  per environment once that data API has merged `feat/amm-data`, re-ingested history with the AMM parser and back-filled; section 16,
  step 4). The parser gate stays the API's own: with `AMM_DATA` on, a field that is still absent is still not shown.
- **The analytics routes carry no AMM field** in D2 or D2b. Before the merge `analytics/exchanges` counts the order-book trades that
  `account_exchanges` holds; after it, swaps too (section D2b.2). The explorer's "includes swaps" wording follows `AMM_DATA`, not an
  API field.

## 9. Interface with the explorer

**Calls of the Analytics tab** (six, in parallel; each section loads deferred and keeps its "Couldn't load … Retry"):

| Period | `start` | `interval` |
| --- | --- | --- |
| 30 D | today − 29 days | `day` |
| 90 D | today − 89 days | `day` |
| 1 Y | the Monday 51 weeks before this week's Monday | `week` |
| All | the first day of the month of the account's `inception` (`/v2/accounts/{a}`), `2013-01-01` when unknown | `month` |

`end` is left out (now). The same `start` and `interval` go to every call.

| Board element | Call | Fields |
| --- | --- | --- |
| Tile "Account value now", change over the period | `stats/value?interval=` | last row `account_value`; change = last ÷ first − 1 |
| Tile "Transactions sent", "N failed" | `stats/transactions?interval=` | Σ `transaction_count`; failed = Σ of the `result` counts other than `tesSUCCESS` |
| Tile "Fees paid", drops | `analytics/balance_changes?interval=` | `totals` row `transaction_cost`: `out_value`; drops = × 1,000,000 |
| Tile "Counterparties" | `analytics/counterparties?limit=6` | `total` |
| Account value, chart and table | `stats/value?interval=` | `rows[].date`, `account_value` (one row per bucket) |
| Transactions sent per bucket, by type, failed marker | `stats/transactions?interval=` | `rows[].date`, `type` (grouped by the explorer into its legend with its shared `typeGroups`), `result`; a bucket without a row is 0 |
| Balance history, per currency | `analytics/balances?interval=&limit=4` | `lines` (panel order; the "now" reading is `lines[].balance`), `rows` per line |
| Money in and out per bucket | `analytics/balance_changes?interval=` | per `rows[].date`: received = Σ `in_value`, sent = Σ `out_value` over every change type except `transaction_cost` and `intermediary`; net = their difference; the header sums the buckets |
| Where balance changes come from | the same call | `totals`: Fees = `transaction_cost`; DEX trades = `exchange`; Payments in = `payment_destination`; Payments out = `payment_source`; Passed through = `intermediary`; Escrow = the three `escrow_*`; Payment channels = the two `paychannel_*`; **Other** = the total without `change_type` (a row the board adds); In = `in_value`, Out = `out_value`, Net = `net_value`, Changes = `count` |
| Top counterparties, by value | `analytics/counterparties?limit=6` | `account`, `sent_value`, `received_value`, `payments_sent + payments_received`; note "The 6 largest of `total`" |
| DEX trading, per pair | `analytics/exchanges` | pair and issuers, `native_volume`, `count`, `bought`, `sold` (in the base), `bought_counter`, `sold_counter` (in the counter, for a pair the explorer shows inverted) |

**Calls of the Markets page**: `network/markets?period=day|7day|30day&limit=5000`; from D2b, while the explorer's `AMM_DATA` switch is
on, also `&amm=exclude|only` for the Trades filter.

The rows whose field starts "AMM:" are D2b's fields: the explorer shows them only while `AMM_DATA` is on and the field is present
(section 8). In D2 they are never present, so those parts are hidden.

| Board element | Field |
| --- | --- |
| Period | `period` |
| Quote (All, XRP, USD, …) and the text filter | filtered in the explorer on `base_currency` / `counter_currency` and the issuers |
| Trades (All / Order book / AMM) | AMM: `amm`; shown on XRPL only when the `include` answer has `totals.amm_share` |
| Tiles DEX volume, Trades | Σ `native_volume`, Σ `count` of the rows shown |
| Tile Pairs shown | rows shown, "of `totals.pairs_traded` with trades" |
| Tile AMM share of volume | AMM: `totals.amm_share` |
| Pair, issuers | `base_*`, `counter_*` (the explorer may show the pair inverted: invert the prices, swap high and low and the volumes) |
| Last price, Change, Low – high | `last`, `change`, `low`, `high` |
| Volume (native) | `native_volume` ("—" without one) |
| Trades | `count` |
| AMM share | AMM: `amm_share` (meter); "no pool" when `amm_pool` is false; "—" on Xahau |
| 7 days | `sparkline[].close` |

**Board-text changes, for the owner to confirm** (the boards are approved; these follow from the data, and E3 and E4 list the same
changes for the owner to confirm): the `src` captions name the routes above (the board's captions were placeholders: several named
routes that cannot serve the element); "Where balance changes come from" gets the **Other** row; the money footnote ends "… escrow,
channels and other transactions"; the Markets footnote reads "Volume in XRP: the XRP side of pairs against XRP, other pairs at the
period's rate" (`XAH` on Xahau).

**Caching**: every new answer carries `Cache-Control: private, max-age=60` (the global `GH_CACHE_CONTROL`). The markets sets change every
minute (24 h) or five minutes (7 and 30 days); account windows end today. The explorer caches them at the edge for 60 s (its `minute`
class, E3's, next to the foundation's classes), keyed by URL. Its subrequest timeout stays 5 s, except 15 s for
`analytics/counterparties` (section 13).

**Fixtures**: the explorer's fixtures for these routes follow the built `docs/api-reference.md` of `feat/explorer-data` at a pinned
commit, not the examples of this spec.

## 10. Configuration

| Variable | Service | Default | Meaning |
| --- | --- | --- | --- |
| `GH_ACCOUNT_ROLLUP_MIN_ROWS` | syncer | `1000000` | Balance changes from which an account is heavy and gets rollups (section 3.4). `0` turns the `account_rollups` job off; existing coverage is still used by the API and simply stops growing. A whole number (plain digits), validated at boot like the other `GH_*`. |

It goes to `SyncerConfig`, `apps/syncer/.env.example`, `deploy/.env.prod.example` (as `XRPL_ACCOUNT_ROLLUP_MIN_ROWS` /
`XAHAU_ACCOUNT_ROLLUP_MIN_ROWS`, empty = the default) and the environment of `syncer-xrpl` / `syncer-xahau` in the compose files. The
API reads the state tables and needs no setting. Everything else is a constant in the shared package or the aggregator:
`RATES_DAILY_CONFIG_VERSION`, `PAIR_HOURLY_CONFIG_VERSION`, `PAIR_HOURLY_DAYS`, `ACCOUNT_ROLLUP_CONFIG_VERSION`,
`ACCOUNT_ROLLUP_SLICE_ROWS`, `ACCOUNT_PARTITION_ROWS_FLOOR`, the budgets and cadences of section 3, and the limits of sections 5 to 7
(and `AMM_PARSER_VERSION`, from D2b).

## 11. Observability

| Metric | Service | Type | Meaning |
| --- | --- | --- | --- |
| `syncer_aggregator_runs_total{job}`, `syncer_aggregator_errors_total{job}` | syncer | Counter | New `job` labels: `pair_hourly`, `markets_live`, `rates_daily`, `account_rollups`; a failing `agg_dirty` hook fails its `stats_dirty` slice. |
| `syncer_rates_daily_missing_days` | syncer | Gauge | Closed final days without a valid rates set, from the first native trade to the newest final day. 0 once the back-fill is done. |
| `syncer_pair_hourly_missing_hours` | syncer | Gauge | Hours of the last 31 days without a set of the current config version. |
| `syncer_markets_live_age_seconds{period}` | syncer | Gauge | Now minus the `end_time` of the newest `include` set. |
| `syncer_account_rollups_heavy_accounts` | syncer | Gauge | Heavy accounts. |
| `syncer_account_rollups_pending_accounts` | syncer | Gauge | Heavy accounts whose coverage does not yet reach from `first_day` to the newest final day. |
| `api_rates_on_read_total` | api | Counter | Asset-days valued with `dailyNativeRates` because `native_rates_daily` had no valid set for the day. |
| `api_account_day_groups_total{source}` | api | Counter | Day-group reads by source (`raw`, `rollup`). |

Alerts (added to `docs/observability.md`): `syncer_markets_live_age_seconds{period="day"} > 600` for 10 minutes (Markets stale);
`syncer_pair_hourly_missing_hours > 0` for 30 minutes; `syncer_rates_daily_missing_days > 2` for 6 hours once the back-fill has finished
(the daily set is not being written); the existing aggregator-error and API p95 alerts cover the rest. Logs: each back-fill says once that
it is under way and once that it is done, as the volume back-fill does.

## 12. Failure modes

| Case | What happens |
| --- | --- |
| Rates back-fill not done (fresh deployment) | Days without a valid set are valued on read: answers are right; long windows are slow and an All window over years can reach the 30 s guard (500 with the route's message). The rollout waits for the back-fill (section 16). |
| Re-ingest of history (`range-ingest`, `--reprocess`) | `agg_dirty` hooks: rate days X..X+14 marked stale (valued on read until recomputed); hours of the last 31 days recomputed; heavy accounts' days recomputed. Between the rewrite and the hook, aggregates show the old data (eventual, as `stats_hourly`). |
| Aggregator stopped | Markets sets age (`end_time` says so, the age gauge alerts); new days are valued on read; heavy accounts' raw part grows by a day per day (slower, right). |
| `pair_hourly` has a gap | The markets set of that period is not written; the previous set stays. |
| A heavy account's rollup lags or fails | Its days after `rolled_through` are read raw. |
| `GH_ACCOUNT_ROLLUP_MIN_ROWS` raised or lowered | Accounts are demoted (no coverage) or promoted at the next discovery. |
| A query over the per-query guards (memory, time) | The route's 500 (`unable to retrieve …`); the cause is in the log. |
| AMM data incomplete for the window (D2b) | No `amm_share`; `only` partial, `exclude` exact (section D2b.1). |
| Database recreated at the AMM merge (the runner refuses the changed `001_baseline.sql`) | D2's tables are recomputable: once the ledgers are ingested again they refill through the back-fills of section 16; until then answers are right and slow, as on a fresh deployment. |
| A set written twice | Readers keep the newest version and read each key once. |

## 13. Performance

Estimates from the sizes in Context; the plan measures them with the k6 load test of `load/` on a seeded heavy account and on a full
XRPL database where one is available.

| Request | Reads | Expected |
| --- | --- | --- |
| Any analytics route, typical account (≤ 30,000 balance changes), any period | its key ranges in the window, one `native_rates_daily` read, at most two days per asset rated on read (today, and yesterday until final; cached for 60 s) | 20–100 ms |
| The same, account just below the heavy threshold, All | up to 1,000,000 rows per table | 300–500 ms |
| Heavy account, 30 D to All, balances / balance_changes / exchanges / stats | rollup rows (days × groups: thousands to tens of thousands) and ≤ 2 raw days | 100–500 ms |
| Heavy issuer with tens of thousands of lines, `analytics/balances` | the newest `end_balance` of every line, ranked in SQL | about 1 s |
| `analytics/counterparties`, account with tens of millions of payments, 1 Y or All | `account_payments` on read, grouped per counterparty in SQL | 2–10 s (the explorer's 15 s timeout); every other account well under 500 ms |
| `network/markets` | one set: up to a few thousand rows | 10–30 ms |
| `stats/value` and `reports` | as today, with rates from the table instead of hundreds of on-read rate reads | faster; answers identical |

Aggregator load: `pair_hourly` about 0.1–0.3 s a tick (the current hour is in the youngest parts); `markets_live` 0.2–0.5 s per set
(`pair_hourly` of the window: up to 720 hours × the pairs active in each); `rates_daily` 0.5–3 s per day (15 days of native-pair trades),
its back-fill of about 5,000 XRPL days some hours of query time, so about a day within its budget; `account_rollups` a recount of the
active partition (58 slices of about 1 s) and three `account IN (...)` reads of one day each day, its first promotion of the heavy
accounts (a third to half of all balance changes) one to two days. Storage: `native_rates_daily` some million rows; `pair_hourly` about
45 days × 24 hours × the active pairs; `markets_live` one row per period, filter and pair ever seen; the rollups of a few thousand heavy
accounts some hundred million rows, mostly lines of issuers.

## 14. Differences from data.ripple.com conventions

To be listed in ADR-0010 (section 2, "kept, added"):

- **New routes** (additions): `/v2/accounts/{a}/analytics/{balances, balance_changes, counterparties, exchanges}` and
  `/v2/network/markets`. Their object shapes and key orders are ours.
- **New parameters on routes of the original**: `interval` on `stats/{family}` and on `reports`; without it the answers are the
  original's. Before this change an `interval` there was ignored like any unknown parameter, so a client that sent one gets buckets now.
  With `interval`, `stats/value` has a row for every bucket, not only for active ones, and `reports` allows 200 buckets of the interval.
- **Markets**: every traded pair rather than a configured list; windows that start on the hour (the live volumes' windows are exact);
  native volume through the window's rate of any native pair; prices in the canonical stored orientation.
- **Analytics windows** are whole UTC days, `end` included (as `reports`), unlike the exclusive `end` of `stats/{family}`.
- **Valuing balance changes**: a change on a line the account owes on is valued as the account's own IOU (section 4).
- Unclassified balance changes are a group without a `change_type` key, as the `balance_changes` objects leave it out.

## 15. Testing

**Unit (Jest, next to the code).**
- Buckets: day, week from Monday, calendar month; windows widened to buckets; the 1,000-bucket and 200-bucket limits with their messages;
  the error order of every route; `interval` validation.
- Valuation: 17-digit quotients per group and day, 0 without a rate, the owed-line asset, exact sums, the float fallback.
- Carry-forward of balances, lines that start inside the window, negative balances, the ranking of lines (native first, rated, unrated).
- The objects of every route: `Object.keys` order, absent keys, CSV columns and file names.
- Markets: combining hours (open/last by key, high/low by rate with the key tie-break, sums and the `sumOf` fallback), the native-volume
  rule, closes with carry and leading gaps, `change` rounding, `min_trades`, sort and limit, display currency; no AMM key is ever served
  and `amm` is ignored (section 8).
- `DailyRates`: the split between table and on-read days, runs of at most 3,000 days, the stale flag and the config version.
- The aggregator runners with fake timers, each in its own spec: budgets, cadences (`markets_live`'s own run counter), finality,
  back-fill order, `agg_dirty` hooks, failure backoff, shutdown. `aggregator.schedule.spec.ts`: the order of section 3, and with every
  job registered the live volume jobs are not starved.

**End to end, shared (`packages/shared/test`, testcontainers ClickHouse).**
- `dailyNativeRatesOfDay(D)` equals `dailyNativeRates([asset], D, D + 1)` for every asset of seeded trades: busy and quiet pairs, dust
  legs, fewer than 10 kept among the newest 50, trades only in the 14 days before D, native as base and as counter, a day at a ledger
  boundary.
- `rates_daily`, `pair_hourly`, `markets_live`, `account_rollups` write complete sets; a recompute is idempotent; readers ignore older
  versions, stale days and a set written twice (STOP MERGES, then an insert with `insert_deduplicate: 0`, as `volume-job.e2e-spec.ts` does).
- The markets set equals an oracle computed straight from `exchanges` for the same hour-aligned window.
- **Rollups are invisible**: for a seeded account and `GH_ACCOUNT_ROLLUP_MIN_ROWS` lowered so it is heavy, every analytics route, both
  stats families and `reports` answer byte for byte the same as with no rollup, with coverage partial (before `rolled_from`, after
  `rolled_through`) and complete.
- The migration: `003_account_market_aggregates.sql` applies after `001_baseline.sql` and D1's `002_validators_amendments.sql` on a
  fresh and on a migrated database, and needs no table of `002`; the tables match the `Table` enum and their physical design.

**End to end, API (`apps/api/test`, the harness seeded through `LedgerWriter`, both networks).**
- Each new route: an empty window, an unknown address, values on the ripple-mock seed, every interval, filters, limits, sorts, the errors
  and their order, CSV, unknown parameters ignored, `Cache-Control`.
- `stats/{family}` and `reports` without `interval` answer exactly as before this change (snapshots taken before it), with rates from the
  table and from on read; with `interval`, rows per bucket.
- Query plans (`apps/api/test/support/plans.ts`): the raw reads are `ReadFromMergeTree` on a key range starting with `account`, the rollup
  and set reads on their key prefixes, no `FINAL`; `system.query_log.read_rows` of a light account's All stays within its own rows
  (the pattern of `paged-reads.e2e-spec.ts`).
- Markets: the route against seeded sets; the empty answer before the first set; Xahau.

**End to end, syncer (`apps/syncer/test`).** The jobs against a real ClickHouse: the back-fills resume after a restart; an `agg_dirty`
range from a range ingest marks rates stale and recomputes hours and heavy-account days; the jobs run together within the tick.

The AMM tests are D2b's (section D2b.5).

## 16. Rollout and documentation

1. **Merge.** D2 merges to `main` on its own, after D1, and does not wait for `feat/amm-data`. The migration is
   `003_account_market_aggregates.sql` (section 2) and the ADR `docs/adr/0013-account-and-market-aggregates.md` (0011 is the AMM
   work's, 0012 D1's); if `main` gets another migration or ADR first, D1 and D2 take the next free numbers, D1 before D2. D2 changes no
   file of `feat/amm-data`; the owner merges that branch with the recipe of section 17, and D2b follows on `main`.
2. **Deploy the syncer first** (`migrate` applies `003`, then the syncer): `pair_hourly` fills its 31 days in minutes and the markets
   sets appear; `rates_daily` back-fills newest first (`syncer_rates_daily_missing_days` falls to 0 within about a day); `account_rollups`
   discovers and promotes the heavy accounts (`syncer_account_rollups_pending_accounts` falls to 0 within one to two days). A database
   recreated at the AMM merge (section 2) goes through this step again.
3. **Deploy the API.** The routes are right at once and fast where the tables already cover them: `network/markets` at once, typical
   accounts once the rates of their days exist, heavy accounts once promoted. `stats/value` and `reports` keep their answers.
4. **Switch the explorer**, one switch per sub-project. The switches are per-environment Worker variables of the explorer; the owner
   turns one on in an environment once the gauges below are at their mark on the data API that environment reads:

   | Explorer sub-project | Switch | Gauges that gate it |
   | --- | --- | --- |
   | E3, Markets | `MARKETS` | `syncer_pair_hourly_missing_hours` = 0, and `syncer_markets_live_age_seconds{period}` under 600 for `day`, `7day` and `30day` |
   | E4, Account analytics | `ACCOUNT_ANALYTICS` | `syncer_rates_daily_missing_days` = 0 and `syncer_account_rollups_pending_accounts` = 0 |
   | The AMM parts of E2 to E5 (AMM volume series, AMM share, Via column, "includes swaps", the pool card's share, the trades filter) | `AMM_DATA` | Only once that data API has merged `feat/amm-data`, re-ingested history with parser 2 (the AMM rollout's `range-ingest --reprocess`) and back-filled: `syncer_pair_hourly_missing_hours` = 0 and `syncer_rates_daily_missing_days` = 0 again after the reprocess (it marks hours and rate days for recompute; D2b's config version 2 recomputes the hours once more); and, once D2b is deployed (it brings the AMM share), `syncer_markets_live_amm_share_known{period}` = 1 for `day`, `7day` and `30day` (section D2b.1) |
   | E2, Network dashboard | none | no D2 gauge: E2 reads no D2 route |
   | E5, AMM pages | `AMM_PAGES` | no D2 gauge: the AMM work's routes and its `amm_daily` back-fill; D2b's `fees_est` and computed range are used when present |
   | E6, Validators and amendments | `VALIDATORS` | no D2 gauge: D1's (D1's Rollout) |

5. **Documentation**: `docs/api-reference.md` (the five routes, `interval` on stats and reports, the markets rules, the absent AMM
   keys), `docs/data-model.md` (the nine tables), `docs/clickhouse.md` (the new aggregate families and their reads), `docs/syncer.md`
   (the four jobs, their runners and registration, the hooks, the back-fills), `docs/configuration.md` (the variable and the compose
   rows), `docs/observability.md` (metrics and alerts), `docs/operations.md` (watching the back-fills; what a re-ingest does to them),
   ADR-0013 (precomputed daily rates, heavy-account rollups, markets from hourly pair stats, the self-contained runners), ADR-0010
   (section 14), and `docs/openapi.yaml` regenerated, which the explorer copies with `pnpm api:sync`.

## 17. Merge recipe: D2 on `main`, then `feat/amm-data` (for the owner)

D2 (after D1) is on `main` when the owner merges `feat/amm-data`. The two meet in a few registration files, never in a migration (the
AMM work changes `001_baseline.sql` in place; D1 and D2 add `002` and `003`). Every resolution keeps both sides. In
`git merge feat/amm-data` on `main`:

1. **`apps/syncer/src/aggregator/job-context.ts`** (new on the AMM side): take it, and add D2's four names to its `AggregatorJobName`,
   in tick order: `volume_live | volume_daily | amm_pools | pair_hourly | markets_live | stats_live | stats_dirty | amm_daily |
   rates_daily | account_rollups | volume_backfill`.
2. **`aggregator.service.ts`**: take the AMM side's shape (the types and helpers from `job-context.ts`, re-exported; `everyTicks`;
   `jobContext()`; the AMM runners and their hooks) and re-apply D2's registration diff of section 3 to it:
   - drop `main`'s own `AggregatorTick` and `AggregatorJobName` declarations: they now come from `job-context.ts`, and
     `aggregator.service.ts` still re-exports them, which is where D2's runners import `AggregatorTick` from, so they compile unchanged;
   - the budgets record has the AMM side's seven keys and D2's four; both sides' budget constants stay;
   - `AggregatorOptions` has the AMM side's options (`ammPools`, `ammDaily`, their function overrides, `ammDailyEveryTicks`) and
     `aggregates`;
   - the jobs list is the order of section 3, the AMM jobs where the AMM side puts them and D2's around them; D2's jobs have no
     `everyTicks`;
   - in `recomputeDirty`, after the volume sets: the AMM side's `amm_pools` and `amm_daily` hooks, then D2's three, each failure
     failing the slice;
   - `failed()` tests the AMM side's abort errors and D2's.

   D2's runners stay on `AggregateJobDeps`; the merge does not move them onto `AggregatorJobContext` (a later refactor may, with no
   change of behaviour).
3. **`aggregator.module.ts`**: one `RatesService` for the volume jobs, the AMM jobs and `aggregates` (the AMM side already shares one);
   the factory injects `SyncerConfig` (D2's side); both sides' log lines.
4. **`apps/syncer/src/modules/prometheus/prometheus.service.ts`**: both sides' metrics.
5. **`packages/shared/src/clickhouse/tables.ts`, `rows.ts`, `packages/shared/src/index.ts`**: both sides' entries (the `Table` enum holds
   the AMM tables and D2's nine). **`packages/shared/test/migrate.e2e-spec.ts`**: both sides' tables in its list.
6. **`packages/shared/src/query/rates.service.ts`**: the AMM side's `exchangeSumsSql` refactor of `pairSums`, and D2's
   `dailyNativeRatesOfDay`; where D2's method writes the same grouped read, it may call `exchangeSumsSql` instead (the same SQL).
7. **`apps/api/src/network/network.module.ts`, `apps/api/src/accounts/accounts.module.ts`**: both sides' controllers and providers.
8. **Tests**: `aggregator.service.spec.ts` and `apps/syncer/test/aggregator-fakes.ts` take both sides; D2's `aggregator.schedule.spec.ts`
   registers the two AMM jobs too (with the `ammPools` and `ammDaily` options), so its starving test covers every job.
9. **Docs** (`docs/api-reference.md`, `data-model.md`, `clickhouse.md`, `syncer.md`, `configuration.md`, `observability.md`,
   `operations.md`, `adr/0010-ripple-v2-wire-compatibility.md`, `adr/README.md`): both sides' sections. `docs/openapi.yaml` is
   regenerated after the merge, not merged by hand.
10. **Check**: build, lint, the unit and end-to-end suites. D2's suites pass on the new baseline: swaps are now `exchanges` rows, and
    `dailyNativeRatesOfDay` still equals `dailyNativeRates` (section 15), both counting them.

The database side of the merge (a database that applied the old `001_baseline.sql` is recreated) costs D2 only its back-fills (section
2); D1's data is what it would lose, hence D1's deploy-order constraint. Should `feat/amm-data` reach `main` before D2 instead, D2's
branch is rebased onto it with the same resolutions. D2b follows D2 in either case.

## D2b — AMM data additions (after the owner merges feat/amm-data)

A sub-project of its own, built on `main` after the owner has merged `feat/amm-data` there (section 17). It reads the AMM work's data as
that branch stores it: a swap against a pool is an `exchanges` row, and an `account_exchanges` row for each side, with `amm_account` set
to the pool (empty for an order-book trade), written by `PARSER_VERSION` 2; the pools' state is in `amm_pools`, a pool's days in
`amm_daily`, the network's AMM volume in the `amm_volume` sets of `volume_live` and `volume_daily` (`/v2/network/amm_volume`).
`balance_changes` is unchanged by the AMM work. D2b fills the fields of D2's absent-field contract (section 8) and takes the explorer's
two API items marked "after the AMM merge" (D2b.3, D2b.4).

### D2b.1 Markets: the source split and the AMM share

- `pair_hourly` splits each pair by `source = if(amm_account != '', 'amm', 'book')`; `PAIR_HOURLY_CONFIG_VERSION` becomes 2, so the
  hours of the last 31 days are computed again by the catch-up.
- `markets_live` writes the three filter sets per period and, per pair, `amm_share` = the AMM part of the pair's base volume over its
  base volume, all trades of the window (the same value in every filter's set: it describes the pair), as a string with exactly 4
  decimals, rounded half up (`"0.3400"`); `amm_pool` = whether `amm_pools` (newest row per pool) has a pool of the pair that is not
  deleted; `total_amm_share` = Σ native_volume × amm_share ÷ Σ native_volume over the pairs with a native volume, in the same format.
  Per pair, the hours of both sources are combined as in section 3.3 (open and last by key, high and low by rate with the key as
  tie-break, sums with the `sumOf` fallback).
- **Present only when known (the parser gate).** A set has `amm_share`, `amm_pool` and `total_amm_share` only when every ledger of its
  window was written by a parser that knows AMM: `min(parser_version)` over the window's ledgers in `ledgers` is at least 2
  (`AMM_PARSER_VERSION`). They appear once the window's ledgers are all ingested or re-ingested by the new parser (the AMM rollout's
  `--reprocess`, or 30 days of live ingest). On Xahau they are `"0.0000"` and `false`.
- **`amm`** becomes a parameter of `network/markets`: `include`, `exclude` or `only`, else 400 `invalid amm filter - use: include, exclude,
  only` (the AMM work's message), served in the answer after `period`. `exclude` reads the `book` rows, `only` the `amm` rows; the
  threshold, prices, volumes and closes are those of the filtered trades. While the AMM data of the window is incomplete, `exclude` is
  exact (unparsed swaps are no exchanges) and `only` is partial; the answer then has no `amm_share`, and the explorer, even with
  `AMM_DATA` on, does not show the filter.
- **Gauge** `syncer_markets_live_amm_share_known{period}`: 1 when the newest `include` set of the period has `total_amm_share`, else 0.
  It is what section 16, step 4 gates `AMM_DATA` on.

### D2b.2 Swaps in the analytics routes and the other aggregates

After the merge, D2's routes and jobs count swaps without a filter and with no change beyond D2b.1's source split, because they read
the tables the AMM work writes swaps into: `analytics/exchanges` and the heavy accounts' `account_trades_daily` read
`account_exchanges` (a swap is a trade of its pair, `bought` and `sold` by side); `rates_daily` and `pair_hourly` read `exchanges` (the
AMM work's rule for every aggregate built on exchanges). The rows of `balance_changes` and `account_payments` do not change; the values
of every route follow the rates, which now count swaps. The history is complete for swaps once the AMM rollout's `range-ingest --reprocess` from the AMM enablement ledger has rewritten it
with parser 2; its `agg_dirty` ranges run D2's hooks (rate days marked stale and computed again, the hours of the last 31 days
recomputed, the heavy accounts' days rolled again; section 12). D2b's part is the proof (D2b.5) and the gate of section 16, step 4. The
answers carry no AMM-completeness field: the explorer's "includes swaps" wording and its AMM parts follow `AMM_DATA` (section 8).

### D2b.3 24 h fee estimates on `amm_volume` (`fees_est`)

The live row of `/v2/network/amm_volume?live=day` (the rolling 24 h, with neither `start` nor `end`) gains fee estimates: each
component gets `fees_est`, the estimated trading fees its pool charged on the swaps of the window, converted like `converted_amount` (to
the native currency, or to the display currency with `exchange_currency`); the row gets `fees_est`, the sum over its listed components.
The other live periods and the historical rows (`start`, `end`) have none: a pool's fees per day are `amm_daily`'s `fees_base_est` and
`fees_counter_est` (`/v2/amm/pools/{pool}/history?interval=day`).

- **Per swap**: the fee in force for it, as `amm_daily` resolves it (`swapTotals` and `feeOf` in
  `packages/shared/src/aggregate/amm-daily.job.ts`: the pool's trading fee, or the auction slot's discounted fee for its holder and
  authorised accounts while the slot is in force), times the amount the swap put into the pool, on that side. The fee state is carried
  into the window from before its start, as `amm_daily` carries it into a day.
- **Per component**: the two sides' sums in the unit of the component's `amount` side (the other side's sum times `amount` ÷ that
  side's volume: the pool's own average price in the window), times `converted ÷ amount`, the conversion of the component's volume.
- **Known or absent**: as for `fees_*_est`, a side with a swap whose fee is not known has no estimate (the AMM work's Ruling R-A26: part
  of the fees is never shown as all of them). The component then has no `fees_est`, and the row has one only when every listed
  component has.
- **Storage**: `volume_live.fees_est_f Nullable(Float64)` (D2b.6) on the component rows of the `amm_volume` / `day` set, in the native
  currency, NULL when not known, written in the set's one insert. Computed by the AMM volume's live set (`ammComponents` in
  `volume.job.ts`), which reads the window's swaps one by one for it.
- **Keys**: component `amm_account, base, counter, count, amount, rate, converted_amount, fees_est?`; row as now, with `fees_est?` after
  `end_time`, so the keys the trade and payment rows share with the original stay in place. The CSV gets the column.
- **Cost**: the swaps of 24 hours, once a tick, as `amm_daily` reads a day. The longer periods would read up to 30 days of swaps at every
  tick, which is why they carry no estimate.

### D2b.4 The range of computed AMM days

`/v2/amm/pools/{pool}/history?interval=day` gains `computed_start` and `computed_end` (`YYYY-MM-DD`), after `result`: the days of the
request's window that `amm_daily` has computed. `computed_end` is the newest day of the window with a set of the current
`AMM_DAILY_CONFIG_VERSION` (its sentinel, final or not); `computed_start` is the oldest day d of the window such that every day from d to
`computed_end` has one. A day inside the range without a row for the pool is a quiet day; a day outside it is not computed yet. Both keys
are absent when no day of the window has a set. They are the same on every page of a paged answer and are not in the CSV. The read is
the sentinels of the window's days, a key prefix of `amm_daily` (`amm_account = ''` and the day range), next to the page's read.

### D2b.5 Testing

- The AMM fixtures of `packages/shared/test/fixtures/xrpl/amm` (the AMM work's recordings): the source split, `amm_share`, `amm_pool`,
  `total_amm_share`, the three filters and their combination of sources, the parser-version gate, the gauge; Xahau's `"0.0000"` and
  `false`.
- Swaps in `analytics/exchanges` and in the rollups: with `GH_ACCOUNT_ROLLUP_MIN_ROWS` lowered, raw and rollup answers still agree byte
  for byte with swaps in the window; `dailyNativeRatesOfDay` and `dailyNativeRates` still agree; a `--reprocess` range corrects rates,
  hours and heavy-account days.
- `fees_est`: per swap against `swapTotals` on the same swaps (a fee change and an auction slot inside the window, a carry from before
  it, a swap with no known fee), the conversion of both sides, the row sum and its absence; only the `day` live set has it; key order
  and CSV.
- `computed_start` / `computed_end`: a fully computed window, a back-fill under way, a hole, no set at all, a quiet day inside the range,
  paging.
- Every D2 test still passes.

### D2b.6 Storage, rollout and documentation

- **Migration**: `004_amm_fee_estimates.sql` (the next free number after D2's `003` when D2b is built), one statement:
  `ALTER TABLE volume_live ADD COLUMN IF NOT EXISTS fees_est_f Nullable(Float64)`. The markets columns exist from `003` (section 2).
- **Rollout**, after the AMM rollout (its databases recreated, the `--reprocess` from the AMM enablement ledger): `migrate`, then the
  syncer (`pair_hourly` recomputes 31 days at version 2; the reprocess's `agg_dirty` ranges correct rates and heavy accounts' days), then
  the API. The owner turns `AMM_DATA` on per environment by section 16, step 4.
- **Documentation**: `docs/api-reference.md` (the AMM fields and `amm` of `network/markets`, `fees_est`, `computed_start` /
  `computed_end`), `docs/data-model.md` (the column), `docs/syncer.md` (the source split, the fee estimate), `docs/observability.md`
  (the gauge), a D2b section in ADR-0013, and `docs/openapi.yaml` regenerated.

## Out of scope

- Rollups for every account, and rollups of payments by counterparty.
- Exact rolling markets windows, historical markets, order books.
- A ledger-ordered copy of `exchanges` or of the account tables (the follow-up of Ruling R111): not needed for these aggregates.
- Live node reads, token metadata, LP-position values.
- AMM network figures beyond D2b: pool, deleted-pool and over-value counts, total value locked, rankings of pools by volume or fee, a
  pool's `created_time`, a per-swap fee estimate, pools by currency alone or by issuer (dropped from the explorer for now).
