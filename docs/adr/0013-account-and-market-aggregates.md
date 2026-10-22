# ADR-0013: Account and market aggregates: precomputed daily rates, heavy-account rollups, markets from hourly pair stats

**Status:** Accepted. Extends [ADR-0008](0008-no-aggregate-materialized-views.md) (precomputed aggregates are tables the aggregator writes) and
adds routes and parameters to the contract of [ADR-0010](0010-ripple-v2-wire-compatibility.md) (section 2, items 10a to 10g). The last section, [D2b](#d2b-the-amm-data-additions), adds the AMM data
to these aggregates once the AMM work ([ADR-0011](0011-amm-data-and-swaps-as-exchanges.md)) is merged.

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
`markets_live.amm`, `amm_share`, `amm_pool`, `total_amm_share`) and are written `book`, `include` and NULL, so the AMM additions need no migration for them. When they come, they are present **only when known**, and an absent field means "not known", never 0 or `false`. [D2b](#d2b-the-amm-data-additions) is that.

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

Where it is documented: [api-reference](../api-reference.md#account-analytics-get-v2accountsaddressanalytics) (the five routes, `interval`, the markets rules, the AMM keys), [data-model](../data-model.md#account-and-market-aggregates-migration-003) (the nine tables),
[clickhouse](../clickhouse.md#the-aggregate-families-and-their-reads), [syncer](../syncer.md#7-the-aggregator) (the jobs, the runners, the hooks, the back-fills), [configuration](../configuration.md#5-syncer-appssyncer) (`GH_ACCOUNT_ROLLUP_MIN_ROWS`),
[observability](../observability.md#4-metrics-syncer) and [operations](../operations.md#account-and-market-aggregates) (D2b: [the AMM data additions](../operations.md#the-amm-data-additions)).

## D2b: the AMM data additions

**Status:** Accepted. Fills the absent-field contract of "The AMM boundary" above, after the owner merged the AMM work. Design: `docs/superpowers/specs/2026-10-19-account-market-aggregates-design.md`, section "D2b"
(D2b.1 to D2b.6); the plan is `docs/superpowers/plans/2026-10-22-amm-aggregates-d2b.md`. The AMM work stores a swap against a pool as an `exchanges` row (and an `account_exchanges` row for each side) with `amm_account` set to the pool,
written by parser version 2, and the pools' state in `amm_pools` and `amm_daily` ([ADR-0011](0011-amm-data-and-swaps-as-exchanges.md)). D2b reads that data; it changes no ingest and no parser version, and has one
migration, `004_amm_fee_estimates.sql`.

**1. The source split.** `pair_hourly` splits each pair by `source = if(amm_account != '', 'amm', 'book')` (the column exists since 003), so a pair with both kinds of trade in an hour has two rows, each the candle of its own trades;
the hour's sentinel stays the empty pair with source `book`. `PAIR_HOURLY_CONFIG_VERSION` becomes 2, and the runner treats an hour whose newest set has another version as due, so the first run of the new syncer computes the 31 days
again, newest first, in minutes. Until the hours a Markets window needs are done, its sets are skipped and the previous ones stay and age. The other aggregates need nothing: `analytics/exchanges` and the heavy accounts' `account_trades_daily`
read `account_exchanges`, `rates_daily` and `pair_hourly` read `exchanges`, and the values follow the rates, which now count swaps. The tests prove it (swaps in the rollups and the raw reads agree byte for byte, `dailyNativeRatesOfDay`
still equals `dailyNativeRates`, a `--reprocess` corrects rates, hours and heavy-account days); the answers carry no AMM-completeness field.

**2. Three filter sets from one read.** A run of a period writes the sets `include` (the hour rows of both sources), `exclude` (`book`) and `only` (`amm`) from one read of the hour rows, as three inserts in the order
`exclude`, `only`, `include` (the set the explorer reads first is the last to change), each under its own version; a missing hour skips all three (D6). The rate of an asset, which a pair's `native_volume` goes through, comes
from the `include` rows in all three sets: a filter changes which trades are counted, not what an asset is worth. The API's parameter `amm` (`include`, `exclude`, `only`; the AMM work's message `invalid amm filter - use: include, exclude, only`)
reads the set of its filter, is checked after the display currency (D7), and is **echoed** in every answer after `period`, the answer of no set too (D1), as `period` is echoed when it was defaulted.

**3. The AMM fields, and the parser gate.** `amm_share` of a pair is the base volume of its swaps over the base volume of all its trades, text with 4 decimals, rounded half up, the same in every filter's set because it describes
the pair; it is the share of the base **as stored** and does not change when a consumer shows the pair inverted (D2: whether a counter-side share is wanted is the owner's call). It is absent when the pair's base volume is not above 0, which
a kept trade cannot make, and `"0.0000"` for a pair without swaps (D5). `amm_pool` is whether a pool of the pair has a newest `amm_pools` row that is not deleted. `total_amm_share` is the sum of each pair's `native_volume × amm_share`
over the sum of the native volumes of the pairs that have one (each share exact, not the rounded text), from exact quotients (20 places) rounded once, `"0.0000"` without a native volume, the same on the three sentinels (D3). The three exist **only when known**: when every ledger
that closed in a set's window was written by a parser that knows AMM, the lowest `parser_version` of those ledgers being at least `AMM_PARSER_VERSION` (2, beside `PARSER_VERSION`), and a window without a ledger passing; otherwise they are NULL and the API
leaves them out. The gate is one rule on both networks (D4): Xahau has no swaps and no pools, so its data gives `"0.0000"` and `false`. While a window is incomplete, `exclude` is exact (an unparsed swap is no exchange) and `only` is partial.
The gauge `syncer_markets_live_amm_share_known{period}` is 1 when the newest `include` set has `total_amm_share`; it gates the explorer's `AMM_DATA` switch with the gauges of the AMM rollout, and has no alert.

**4. `fees_est` on the live day row of `amm_volume`.** The component rows of the rolling 24 h set get the estimated fees their pool charged on the swaps of the window, in the native currency, in `volume_live.fees_est_f Nullable(Float64)`
(migration 004), written in the set's one insert; the API converts them like `converted_amount` (a display currency with its rate) and sums them on the row. The longer periods and the historical rows have none: reading up to 30 days of swaps at
every tick is not affordable, and a pool's fees per day are `amm_daily`'s. The estimate counts **every swap** of the window, with the fee in force for it as `amm_daily` resolves it (`swapTotals`: the trading fee, or the auction
slot's discounted fee for its holder and authorised accounts while the slot is in force), with the fee state carried in from before the window as `amm_daily` carries it into a day, and without the dust rule of `amount` (D8). The two
sides' fees are put in the unit of the component's `amount` at the pool's own average price in the window and converted with the component's volumes. A side with a swap whose fee is not known makes the estimate unknown (the AMM work's
Ruling R-A26: part of the fees is never shown as all of them), as does fees above 0 on a side with no volume; the component then has no `fees_est`, and the row has one only when it lists a component and every listed component has one (D9).
**A known cost:** the window's carry walks a pool that never had an auction slot back through its state history to its first ledger on every tick, as `amm_daily` does for today's set at each of its runs (every fifth tick), because the slot columns are
required in the carry. Narrowing the required carry to the trading fee (a slot lasts 24 hours, far less than the fill-forward window) would change `amm_daily`'s own rule, so it is parked as a follow-up for both jobs.

**5. The range of computed AMM days.** `amm/pools/{pool}/history?interval=day` says which days of the request's window `amm_daily` has computed: `computed_end` is the newest day with a set of the current
`AMM_DAILY_CONFIG_VERSION` (its newest sentinel, final or not), `computed_start` the oldest day from which every day up to it has one. The window is the request's, never narrowed by the marker, so every page of an answer has the same
range (D10); a day inside it without a row is a quiet day, one outside it is not computed yet. Both keys are absent when no day of the window has a set, and are not in the CSV.

**The decisions the build made where the design left a choice** (each is a ruling of the run):

| | Decision |
| --- | --- |
| D1 | `amm` is echoed after `period` in every `network/markets` answer, `"include"` when the request has none, the no-set answer too |
| D2 | `amm_share` is a share of the stored base volume and does not change when a consumer inverts the pair |
| D3 | `total_amm_share` from exact quotients (20 places) rounded once to 4 decimals; `"0.0000"` without a native volume; the same on the three sentinels |
| D4 | The parser gate is the same on both networks: the lowest `parser_version` of the window's ledgers is at least `AMM_PARSER_VERSION`; no ledger passes |
| D5 | A pair's `amm_share` is absent when its base volume is not above 0, and `"0.0000"` without swaps |
| D6 | One run, three sets: `exclude`, `only`, then `include`, each its own version; a missing hour skips all three |
| D7 | The `amm` check comes after the display currency: `period`, `min_trades`, the display currency, `amm` |
| D8 | `fees_est` counts every swap of the window and converts with the component's own volumes; fees above 0 on a side without volume make it unknown |
| D9 | The row's `fees_est` exists only when the row lists a component and every listed component has one |
| D10 | The computed range is that of the request's window and counts a day only when its newest sentinel has the current config version |

**Consequences and trade-offs.**
- **The gate is not the whole answer.** The parser gate opens as soon as every ledger of the window is parser 2, which after a `--reprocess` can be a tick before the reprocessed hours are recomputed (`markets_live` runs before `stats_dirty`,
  whose hook recomputes them). The share is then understated for minutes. The design accepts this (aggregates are eventual after a re-ingest), and the docs ask that `AMM_DATA` is turned on only once `agg_dirty` has drained
  ([operations](../operations.md#the-amm-data-additions)); no gauge shows that backlog.
- **A deploy waits for the catch-up.** The first run of the syncer after D2b computes the 31 days again, and the Markets sets are skipped until the hours they need are done; the previous `include` sets stay and age for those minutes, and the filters
  `exclude` and `only` answer the no-set answer until their first run. A database whose history is not ingested again has the AMM fields on its `30day` set only 30 days after parser 2 started writing.
- **The order of the rollout is binding**: the API reads `fees_est_f` in every live volume read, so `migrate` (004), then the syncer, then the API; an API before 004 fails the live volume routes.
- **No counter-side share.** `amm_share` is of the stored base; a consumer that shows a pair inverted shows the same number.
- **A heavier live set.** The `amm_volume` day set reads the 24 h of swaps of its listed pools every tick (one day-read of `amm_daily`), on top of the walk-back cost above.

