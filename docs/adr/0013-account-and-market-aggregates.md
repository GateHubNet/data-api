# ADR-0013: Account and market aggregates: precomputed daily rates, heavy-account rollups, markets from hourly pair stats

**Status:** Accepted. Extends [ADR-0008](0008-no-aggregate-materialized-views.md) (precomputed aggregates are tables the aggregator writes) and
adds routes and parameters to the contract of [ADR-0010](0010-ripple-v2-wire-compatibility.md) (section 2, items 10a to 10f).

## Context
The public explorer needs two things this API could not serve. An **account's analytics** for a period (30 days, 90 days, a year, all of it):
its value over time, the transactions it sent by type, the balance of each line, the sums of its balance changes by type, its counterparties and
its DEX trades. And **one table of every traded pair** (last price, change, range, volume in the native currency, trades, a 7-day sparkline).
What existed was a row per active day (`stats/{family}`), lists of changes, trades and payments, and `exchange_volume` for the markets config.

The facts that decide where the work is done (`docs/superpowers/specs/2026-10-19-account-market-aggregates-design.md`, from the sizes of the XRPL verification run):

- The account tables are ordered by account first, so a window of one account is one key range per part: its cost is the rows it holds. A window of
  time across all accounts is no key range: every part that holds a ledger of it is read whole.
- **Rates on read do not scale with the window.** `RatesService.dailyNativeRates` costs, per asset, one grouped read of the pair's trades and one read of the newest 50
  trades for each day whose window differs: all of an account's 10 assets over 10 years is tens of thousands of reads, and every valued aggregate needs them.
- An ordinary account (fewer than 10,000 transactions and 30,000 balance changes in its life) is read in tens of milliseconds. A busy exchange wallet
  has tens of millions of balance changes: its All window takes tens of seconds and gigabytes, past the 30 s `max_execution_time`, the 2 GiB query memory of the apis, and the
  explorer's 5 s timeout. One hour of trades across all pairs is in the youngest parts and cheap; 30 days across all pairs at every request is not.

## Decision
Four decisions, one storage convention, and one boundary with the AMM work.

**1. Daily native rates are precomputed** (`native_rates_daily`, job `rates_daily`). For each closed, final UTC day the aggregator writes the rate of every issued asset that has one,
exactly what `dailyNativeRates` gives for that day (`RatesService.dailyNativeRatesOfDay`; the e2e suite proves the two agree). `DailyRates` reads the valid days from the table in one query and
computes the others on read, keeping those for 60 seconds: today, and yesterday until the ingest has passed it, are always on read; a re-ingest marks the days it can change stale (a day's rate reads 14
days back) and the back-fill computes them again. Every value the API serves (`stats/value`, `reports`, `analytics/*`) goes through `DailyRates`, and the answers are the same as with `dailyNativeRates` alone.

**2. Heavy accounts get daily rollups; every other account is read on request.** An account with `GH_ACCOUNT_ROLLUP_MIN_ROWS` balance changes (default 1,000,000) gets its day groups
(`account_lines_daily`, `account_tx_daily`, `account_trades_daily`) kept by the `account_rollups` job, which finds heavy accounts once a day from the `account` column of `balance_changes` and reads their days through their own
key ranges (`account IN (...)`). The API serves the days a state row says are covered from the rollups and every other day from the raw rows, through one **day-groups** read that gives the same groups from either source, so a rollup is invisible
in an answer (the e2e suites compare them byte for byte). A rollup for every account is rejected: finding the accounts a day touched means scanning the parts that hold the day in tables ordered by account, every day; it would store more than
a billion rows and save nothing for the many accounts that have one change per day and line. Payments by counterparty are not rolled up either (they compress badly): `analytics/counterparties` reads the payments on request for every account.

**3. The Markets table is made from hourly pair statistics** (`pair_hourly`, job `pair_hourly`; `markets_live`, job `markets_live`). The candle of every pair in each UTC hour of the last 31 days is a set, written from
the youngest parts, and the Markets set of each period (`day`, `7day`, `30day`) is made from those hours: the route reads one set, in milliseconds. The price of this is that **the periods start on the hour** (24 hours are 24 to 25), which
exact rolling windows across every pair at every request would not give up. `network/markets` lists every traded pair, with prices in the canonical stored orientation and native volume through the window's rate of any native pair, so it can differ from
`exchange_volume` for a configured market; `exchange_volume` keeps its components from the markets config, for Ripple compatibility.

**4. The new jobs are self-contained runners.** Each of the four jobs is a runner in a file of its own that keeps its own state (cursors, waits, announcements, the run counter of the `markets_live` cadence) and gets what it needs of the aggregator through one small
interface, `AggregateJobDeps` (the database, the log, the metrics, the clock, `closing()`, `failed()`, its budget). The registration in the existing files is a few lines (the names, the budgets, an option, the entries of the jobs list, and one private method that runs the
three `agg_dirty` hooks after a slice's volume sets). The runners depend on nothing of the AMM branch, so D2 merges on its own and the owner merges that branch afterwards.

**Storage convention.** Every table is `ReplacingMergeTree(version)` and only the aggregator writes it; a recompute writes a complete **set** (a day, an hour, a period, an (account, day)) in one insert under a new version, the larger of the ClickHouse clock in
milliseconds and the newest version of the set plus one; readers keep the newest version and never use `FINAL`, and read a row that was written twice once. A set with a **sentinel** row (the day's `currency = ''`, the hour's and period's empty pair,
a partition's `account = ''`, and for the rollups a row of `account_rollup_days` written after the rows) says which version is the set and what it holds. No ingest change and no parser version bump.
Two details of the rollups follow from it. The three rollup row tables have `version` as the **last column of their sorting key** (the design listed the keys without it; the build added it): a rollup set is rows and then a sentinel, and without `version` in the key a background merge could replace
the rows of the set a sentinel points to with a newer set that is still being written. And the **superseded versions are never pruned**: they accumulate only when a re-ingest corrects a covered day, they are not read, and no cleanup is shipped.

**The AMM boundary.** D2 serves no AMM field: `network/markets` has no `amm` key, no `totals.amm_share`, no `amm_share` or `amm_pool`, and `amm` is not a parameter (it is ignored). The columns that will hold them exist from migration 003 (`pair_hourly.source`,
`markets_live.amm`, `amm_share`, `amm_pool`, `total_amm_share`) and are written `book`, `include` and NULL, so the AMM additions need no migration for them. When they come, they are present **only when known**, and an absent field means "not known", never 0 or `false`.

## Consequences
**Positive**
- Every element of the explorer's account analytics and Markets boards reads one documented field of one call, in tens to a few hundred milliseconds for an ordinary account and for a heavy one from its rollups, and in milliseconds for the Markets table.
- Nothing computed depends on a rollup for correctness: before a rate set or a rollup exists, or while it lags, an answer is the same and only slower. A re-ingest corrects them through `agg_dirty` (rate days marked stale and computed again, the hours of the last 31 days recomputed,
  the covered days of heavy accounts rolled again), and a fresh deployment fills them by itself, newest first.
- The valuation rule is one: the native currency is worth itself, an issued amount is worth its amount over the rate of its asset on its UTC day (17 significant digits per group and day, 0 without a rate), sums of values exact. `stats/value` and `reports` keep their answers to the digit.

**Negative / trade-offs**
- **Freshness.** The `day` Markets set is a minute old, the others five; a window is 24 to 25 hours. Today and yesterday are valued on read from a cache of 60 seconds. Aggregates are eventual after a re-ingest.
- **Slow paths until the back-fills are done** (`rates_daily` takes about a day on XRPL, the first promotion of heavy accounts one to two days): answers are right and slower, a long window over years can reach the 30 s guard, and `analytics/counterparties` of
  a heavy account with very many paid asset-days can answer 500 while the rates are still being filled (the rates of unstored days travel in the request). `analytics/counterparties` on a busy exchange stays 2 to 10 seconds: it is read on request for every account.
- **`interval` changes the answers** of clients that already sent one to `stats/{family}` or `reports` (the original ignored it); without it the answers are unchanged.
- **Storage and moving parts.** Four more jobs to watch ([observability](../observability.md): five gauges and three alerts), nine more tables, and rollup rows that are never pruned.
- **The database consequence of merging the AMM work.** That branch changes `001_baseline.sql` in place, and the migration runner refuses an applied file whose checksum changed, so a database created before the owner merges it is recreated at that merge. D2's tables are all
  recomputable, so for D2 this only means the back-fills run again; the deploy-order constraint it causes is the validators work's.
- **Merging the AMM branch** needs a recipe: the two branches meet in a few registration files and the docs, never in a migration. Every resolution keeps both sides:
  [the merge recipe](../superpowers/plans/2026-10-19-account-market-aggregates.merge-recipe.md).

Where it is documented: [api-reference](../api-reference.md#account-analytics-get-v2accountsaddressanalytics) (the five routes, `interval`, the markets rules, the absent AMM keys), [data-model](../data-model.md#account-and-market-aggregates-migration-003) (the nine tables),
[clickhouse](../clickhouse.md#the-aggregate-families-and-their-reads), [syncer](../syncer.md#7-the-aggregator) (the jobs, the runners, the hooks, the back-fills), [configuration](../configuration.md#5-syncer-appssyncer) (`GH_ACCOUNT_ROLLUP_MIN_ROWS`),
[observability](../observability.md#4-metrics-syncer) and [operations](../operations.md#account-and-market-aggregates).
