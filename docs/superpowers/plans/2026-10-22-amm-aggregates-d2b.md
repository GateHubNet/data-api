# AMM Data Additions to the Aggregates (D2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill D2's absent-field contract with the AMM work's data (sub-project D2b): the `book`/`amm` source split of `pair_hourly`, the three `amm` filter sets of `markets_live` with `amm_share`, `amm_pool` and `total_amm_share` behind the parser gate, the `amm` parameter of `/v2/network/markets` and its gauge, the proof that every D2 aggregate counts swaps, `fees_est` on the live `day` row of `/v2/network/amm_volume`, and `computed_start` / `computed_end` on `/v2/amm/pools/{pool}/history?interval=day`.

**Architecture:** No new table. `pair_hourly` groups each pair by `source` (config version 2, so the catch-up recomputes the 31 days). `computeMarketsSet` reads the hour sets once and writes the three filter sets of a period in one call, from the same hour versions, so `amm_share` is the same in each. `fees_est` is computed by the live `amm_volume`/`day` set from the window's swaps with `amm_daily`'s fee rule (`swapTotals`), stored in a new nullable column of `volume_live` (migration `004`). The computed range of AMM days is one read of `amm_daily`'s sentinels next to the page read.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 via `@clickhouse/client`, bignumber.js, Jest/ts-jest, testcontainers ClickHouse for the e2e suites, a pnpm workspace (`packages/shared`, `apps/api`, `apps/syncer`).

**Spec:** `docs/superpowers/specs/2026-10-19-account-market-aggregates-design.md`, section "D2b — AMM data additions" (D2b.1–D2b.6), with sections 2, 3.2, 3.3, 7, 8, 9, 12 and 16 as context. The spec is binding; this plan argues from it and executors read both. D2 itself is built (plan `2026-10-19-account-market-aggregates.md`, merge recipe beside it); `feat/amm-data` is merged into `main` (abc0271), so its files are ordinary files of this branch now.

**Branch:** this session's worktree branch, cut from local `main` at abc0271.

## Decisions this plan makes (the spec leaves them open; each is a "Ruling:" line in the run's ledger)

- **D1, `amm` is echoed** (open item 1 of the hand-back): every answer of `network/markets` has `amm` after `period`, `"include"` when the request has none, the no-set answer too (`{result, period, amm, count, markets}`). As `period`, which the answer echoes when it was defaulted.
- **D2, `amm_share` is a share of the stored base** (open item 2): it does not change when a consumer shows the pair inverted. The reference says so; the owner decides whether a counter-side share is wanted (hand-back).
- **D3, `total_amm_share`** = (Σ over the `include` pairs with a native volume of `native_volume × amm_base ÷ base_volume`) ÷ Σ `native_volume`, from exact quotients (BigNumber, 20 decimal places) rounded once to 4 decimals; `"0.0000"` when no pair has a native volume. The same value on the sentinel of all three filter sets.
- **D4, the parser gate** is the same on both networks: the minimum `parser_version` of the ledgers that closed in `[start_time, end_time]` is at least `AMM_PARSER_VERSION`; a window without a ledger passes. Xahau gets `"0.0000"` and `false` from its data (no swaps, no pools), not from a network test.
- **D5, `amm_share` of a pair** is absent (NULL) when its `include` base volume is not above 0 (a kept trade cannot have that); a pair without swaps has `"0.0000"`.
- **D6, one call, three sets:** a run of a period computes its three filter sets from one read of the hour sets and writes them as three inserts, `exclude`, `only`, then `include` (the set the explorer reads first is the last to change), each under its own version. A missing hour skips all three.
- **D7, the `amm` check** comes after the display currency (its place in the parameter table of spec 7): `period`, `min_trades`, the display currency, `amm`.
- **D8, `fees_est` counts every swap** of the window, as `amm_daily` does (no dust filter), and converts with the component's own volumes (the dust-filtered sums of `ammComponents`). A side whose fee sum is above 0 while that side's volume is not makes the component's estimate unknown.
- **D9, the row's `fees_est`** is there only when the row lists at least one component and every listed component has one.
- **D10, the computed range** is that of the request's window (`start`, `end`), never narrowed by the marker, and counts a day only when its newest sentinel has the current `AMM_DAILY_CONFIG_VERSION`.

## Global Constraints

- Never touch the main checkout `/Users/golobitch/github.com/GateHubNet/data-api-new` or the branch `feat/amm-data`; never push, merge, amend, `git clean`, `reset --hard` or bare `git stash`. Delete no file, and remove code only where a task says so.
- **Storage.** One migration, `packages/shared/schema/004_amm_fee_estimates.sql`, one statement: `ALTER TABLE volume_live ADD COLUMN IF NOT EXISTS fees_est_f Nullable(Float64);` (its semicolon ends its last line; no comment line ends with `;`). No other schema change, no ingest change, no `PARSER_VERSION` bump. The markets columns exist from `003`.
- **Sets.** A recompute writes a complete set in one insert under a new version (`nextSetVersion` / `nextVersion`); readers keep the newest version and never use `FINAL`; a row written twice is read once (`LIMIT 1 BY` its key).
- **Constants:** `PAIR_HOURLY_CONFIG_VERSION = 2` (was 1); `AMM_PARSER_VERSION = 2` (shared, beside `PARSER_VERSION`); `AMM_DAILY_CONFIG_VERSION` stays 1.
- **Present only when known** (spec 8): a field that is not known is left out of the answer, never `0`, `false` or `null`. `amm_share` and `total_amm_share` are text with exactly 4 decimals, rounded half up (`"0.3400"`); `amm_pool` is served as `true`/`false`.
- **Exact messages:** `invalid amm filter - use: include, exclude, only` (the existing `ammFilter` of `apps/api/src/common/params.ts`); every message of D2's routes unchanged.
- **Key orders** (pinned by `Object.keys` tests):
  - markets answer `result, period, amm, start_time, end_time, exchange?, exchange_rate?, totals, count, markets`; no-set answer `result, period, amm, count, markets`; totals `pairs, pairs_traded, count, native_volume, converted_volume?, amm_share?`; market `base_currency, base_issuer?, counter_currency, counter_issuer?, count, base_volume, counter_volume, native_volume?, converted_volume?, open, high, low, last, change?, open_time, last_time, amm_share?, amm_pool?, sparkline`.
  - `amm_volume` component `amm_account, base, counter, count, amount, rate, converted_amount, fees_est?`; row `components, count, exchange, total, exchange_rate, start_time, end_time?, fees_est?`.
  - pool history with `interval=day` (JSON) `result, computed_start?, computed_end?, count, marker?, days`.
- **Analytics routes carry no AMM field** (spec 8, D2b.2).
- **Repo rules.** Bound parameters only, table names from `Table`. Export what the apps use from `packages/shared/src/index.ts`. Format with `pnpm exec prettier --write <each touched file>` (never repo-wide `pnpm format`) and stage explicit paths. After changing `packages/shared`, run `pnpm --filter @gatehub/data-api-shared build` before app tests. `pnpm build` and the unit suites of every touched package pass before each commit. Package filters: shared `@gatehub/data-api-shared`, api `@gatehub/data-api-service`, syncer `@gatehub/data-syncer`.
- **Tests.** e2e suites use testcontainers ClickHouse (`<pkg> test:e2e -- <pattern>`). `pair_hourly` has `TTL hour + INTERVAL 45 DAY` with `ttl_only_drop_parts = 1`: a test that writes hours more than 45 days before the real clock first runs `SYSTEM STOP TTL MERGES <db>.pair_hourly`, as D2's suites do.
- **Commits** use Conventional Commits with the repo's scopes and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A window partly written by parser 1** (a `--reprocess` under way): no `amm_share`, `amm_pool` or `total_amm_share` in any of the three sets, `exclude` exact, the gauge 0; once every ledger of the window is parser 2 they appear. Pinned by Task 2 "the parser gate" and Task 3 "the gauge follows the include set".
- **A pair traded only through a pool, and one with both sources in one hour**: the first is in `include` and `only` with `amm_share` `"1.0000"` and absent from `exclude`; for the second the open, last, high and low of `include` come from whichever source has them by key and rate. Pinned by Task 2 "a pair of swaps only" and "both sources in one hour".
- **`pair_hourly` hours of config version 1 left by D2**: the markets sets are skipped until those hours are recomputed, and the runner recomputes them, final ones included. Pinned by Task 3 "an hour of config version 1 is due".
- **A fee the window cannot know** (a swap with no known fee on one side, a fee vote and an auction slot inside the window, a slot that expires inside it, a fee state carried from before the window): that component has no `fees_est` and the row has none. Pinned by Task 7 "fees_est against swapTotals" and Task 8 "a component without fees_est".
- **The computed range on a paged answer with a hole**: every page has the same `computed_start` / `computed_end`; a hole ends the range; a sentinel of another config version is not computed. Pinned by Task 9.

---

### Task 1: `pair_hourly` splits each pair by source

**Files:**
- Modify: `packages/shared/src/aggregate/pair-hourly.job.ts`
- Test: `packages/shared/test/pair-hourly-job.e2e-spec.ts`

**Interfaces:**
- Produces: `PAIR_HOURLY_CONFIG_VERSION = 2`; a set has a row per (pair, source) with a kept trade, `source = 'amm'` for the rows of `exchanges` with `amm_account != ''`, else `'book'`; the sentinel stays the empty pair with source `'book'`. `computePairHourSets` and `pairHourSets` keep their signatures.

- [ ] **Step 1: Write the failing tests** in `pair-hourly-job.e2e-spec.ts` (add swaps to its synthetic world: rows of an existing pair and of a pair of its own with `amm_account` set to a pool address, some in an hour that also has order-book trades of that pair, one a native-dust swap):
  - `it('the constants are 2 and 31')` replaces `'the constants are 1 and 31'`.
  - `it('a swap is source amm and an order-book trade source book: a pair with both in an hour has a row of each, each the candle of its own trades')`: the two rows equal the oracle candle over the trades of their source alone (the oracle filtered by `amm_account`).
  - `it('a native-dust swap is left out like a dust trade')`.
  - `"every row is source book, …"` becomes `it("the sentinel is source book, and every row carries the set's is_final, config_version (2) and through_time")`.
  - The "rows written twice" test writes swaps twice too, and they count once.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test:e2e -- pair-hourly`. Expected: FAIL (one row per pair; constant 1).
- [ ] **Step 3: Implement.** The subquery selects `if(amm_account != '', 'amm', 'book') AS source`; the read groups and orders by `hour_start, <pair>, source`; `PairHourGroup` gains `source: 'book' | 'amm'`, which `pairRowOf` writes; `PAIR_HOURLY_CONFIG_VERSION = 2`, its comment saying that 2 is the source split. Update the file's header comment.
- [ ] **Step 4: Run** the pair-hourly e2e, then `pnpm --filter @gatehub/data-api-shared test:e2e -- markets-live` (its sets come from `computePairHourSets`), `pnpm --filter @gatehub/data-api-shared test`, the shared build, and `pnpm --filter @gatehub/data-syncer test -- pair-hourly markets-live`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): pair_hourly splits each pair by source (book, amm); config version 2`.

### Task 2: `markets_live`: the three filters, the AMM share and pool, the parser gate

**Files:**
- Modify: `packages/shared/src/aggregate/markets-live.job.ts`, `packages/shared/src/clickhouse/rows.ts` (`AMM_PARSER_VERSION`), `packages/shared/src/index.ts`
- Create: `packages/shared/src/aggregate/markets-live.job.spec.ts`
- Test: `packages/shared/test/markets-live-job.e2e-spec.ts`, `packages/shared/test/markets-oracle.ts`

**Interfaces:**
- Consumes: Task 1's `source` rows.
- Produces (all exported from the shared index):
  - `export const AMM_PARSER_VERSION = 2;` in `rows.ts`, beside `PARSER_VERSION` ("the first parser version that writes swaps and the AMM tables").
  - `export const MARKETS_AMM_FILTERS = ['include', 'exclude', 'only'] as const; export type MarketsAmmFilter = (typeof MARKETS_AMM_FILTERS)[number];`
  - `computeMarketsSet(ch, nativeCurrency, period, now, options?)`: same signature; writes the three sets of the period (D6). `MarketsSetOutcome`'s written variant gains `ammShareKnown: boolean`.
  - `export async function marketsAmmShareKnown(ch: ClickHouseService): Promise<Map<MarketsPeriod, boolean>>`: per period, whether the newest `include` sentinel has a `total_amm_share`; a period without a set is not in the map.
  - `export function ammShareText(part: BigNumber, whole: BigNumber): string | null`: `part ÷ whole` with exactly 4 decimals, `ROUND_HALF_UP`; `null` when `whole` is not above 0.

- [ ] **Step 1: Write the failing unit test** `markets-live.job.spec.ts`: `ammShareText(34, 100) === '0.3400'`, `(1, 3) === '0.3333'`, `(2, 3) === '0.6667'`, `(0.00005, 1) === '0.0001'` (half up), `(0.000049, 1) === '0.0000'`, `(5, 5) === '1.0000'`, `(0, 7) === '0.0000'`, `(1, 0) === null`.
- [ ] **Step 2: Write the failing e2e tests** in `markets-live-job.e2e-spec.ts`. Add swaps to the 32-day world (rows with `amm_account` set; a pair of swaps only; a pair with swaps and order-book trades in the same hours, where the open, last, high or low of the window comes from a swap; a native-only pair untouched) and `amm_pools` rows (one live pool for the pair of swaps only, one deleted pool for another pair, the newest row of a pool deciding). Extend `markets-oracle.ts` with the filter (`include`: every trade, `exclude`: `amm_account = ''`, `only`: `amm_account != ''`), the share and the pool.
  - `it('writes the three filter sets of a period, each equal to the oracle of its filter')`: per filter the pairs, counts, volumes, prices, closes and the native volume (rates from the `include` pairs whatever the filter).
  - `it('a pair of swaps only is in include and only, with amm_share 1.0000, and not in exclude')`.
  - `it('both sources in one hour: include combines them, open and last by key, high and low by rate with the key as tie-break')`.
  - `it('amm_share is the AMM part of the base volume over the base volume, the same in every filter; a pair without swaps has 0.0000')`.
  - `it('amm_pool says whether the newest row of a pool of the pair is not deleted')`.
  - `it('total_amm_share weights each share by the native volume, rounded once, the same on the three sentinels; 0.0000 without any native volume')`.
  - `it('the parser gate: one ledger of the window written by parser 1 leaves amm_share, amm_pool and total_amm_share NULL in all three sets; ammShareKnown says so')` (write a `ledgers` row with `parser_version: 1` inside the window; a parser-1 ledger before `start_time` changes nothing).
  - `it('the three sets are written exclude, only, include, each under its own version, from the same hour versions')`.
  - `it('marketsAmmShareKnown reads the newest include sentinel of each period')`.
  - `'D2 writes only amm = include, with …NULL'` is removed (replaced by the tests above); the read-count test becomes `it('reads pair_hourly in seven reads (the sets, then the window and the day closes of each filter), each row once, no FINAL, every value bound')`.
  - A new `describe('the AMM recordings')`: the ledgers of `packages/shared/test/fixtures/xrpl/amm` written by `LedgerWriter` (as `amm-volume-job.e2e-spec.ts` does), the AMM pools recomputed, the hour sets of the days of the `day` set computed, at a `now` just after the newest recorded ledger: the `include`, `exclude` and `only` sets equal the oracle over the stored `exchanges` rows, and the recorded pools give `amm_pool`.
  - Xahau: `it('on Xahau the sets carry amm_share 0.0000, amm_pool false (0) and total_amm_share 0.0000')` on the world's order-book trades with `XAH` as the native currency.
- [ ] **Step 3: Run** `pnpm --filter @gatehub/data-api-shared test -- markets-live` and `pnpm --filter @gatehub/data-api-shared test:e2e -- markets-live`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - `HOUR_ROWS` takes `AND source IN {sources:Array(String)}`; the window read and the closes read run once per filter (`include` both sources, `exclude` `['book']`, `only` `['amm']`).
  - The rates of the native volume come from the `include` groups for all three sets; everything else of a set (threshold data, prices, volumes, closes, `pairs_traded`, `total_count`, `total_native_volume`) from its own filter's groups.
  - `amm_share` of a pair: `ammShareText(only base volume, include base volume)` (D5), written on that pair's row in each set it is in. `total_amm_share` by D3. `amm_pool`: 1 when a pool of the pair has a newest `amm_pools` row (`ORDER BY amm_account, version DESC LIMIT 1 BY amm_account`) with `deleted = 0`, else 0; one read of `amm_pools` per call.
  - The gate (D4): one read of `ledgers` whose `ledger_index` range starts at the first ledger that closed at or after `start_time` (found as `RatesService.ledgerRange` finds it: `ORDER BY ledger_index LIMIT 1`, never a scan of `close_time` over the table) and whose `close_time` is at most `end_time`: `minOrNull(parser_version)`, known when NULL or `>= AMM_PARSER_VERSION`. Not known: the three AMM columns are NULL on every row of the three sets.
  - Each set's version is `nextSetVersion` with `period = {period:String} AND amm = {amm:String}`; inserts in the order of D6, `throwIfSetAborted` before each. Update the header comment (D2b writes the three filters and the AMM fields).
- [ ] **Step 5: Run** the tests of Step 3, the shared unit suite and build, and `pnpm --filter @gatehub/data-syncer test -- markets-live`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(shared): markets_live writes the include, exclude and only sets with amm_share, amm_pool and total_amm_share behind the parser gate`.

### Task 3: The runners: config version 1 hours are due, and the AMM-share gauge

**Files:**
- Modify: `apps/syncer/src/aggregator/markets-live.job-runner.ts`, `apps/syncer/src/aggregator/aggregate-job-deps.ts` (`AggregateFunctions`, `defaultAggregateFunctions`), `apps/syncer/test/aggregate-job-fakes.ts`, `apps/syncer/src/modules/prometheus/prometheus.service.ts`
- Test: `apps/syncer/src/aggregator/markets-live.job-runner.spec.ts`, `apps/syncer/src/aggregator/pair-hourly.job-runner.spec.ts`, `apps/syncer/src/modules/prometheus/prometheus.service.spec.ts`

**Interfaces:**
- Consumes: `marketsAmmShareKnown` (Task 2), `PAIR_HOURLY_CONFIG_VERSION = 2` (Task 1).
- Produces: gauge `syncer_markets_live_amm_share_known{period}` (property `marketsLiveAmmShareKnown`, help text "1 when the newest include markets set of the period has total_amm_share (every ledger of its window parsed with AMM), else 0"); `AggregateFunctions.marketsAmmShareKnown`.

- [ ] **Step 1: Write the failing tests.**
  - `markets-live.job-runner.spec.ts`: `it('sets syncer_markets_live_amm_share_known per period after its sets: 1 when the newest include set has total_amm_share, 0 when not or when the period has no set')`; `it('a failing read of the gauge is counted as markets_live and the run goes on')`.
  - `pair-hourly.job-runner.spec.ts`: `it('an hour of the last 31 days whose newest set has config version 1 is due, final or not, newest first')`.
  - `prometheus.service.spec.ts`: the gauge is registered with label `period`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-syncer test -- markets-live pair-hourly prometheus`. Expected: FAIL.
- [ ] **Step 3: Implement.** After `reportAges`, the runner reads `marketsAmmShareKnown` once and sets the gauge for every period of `MARKETS_PERIODS` (0 for one missing from the map); a failure is `deps.failed('markets_live', err, ' reading whether the AMM share is known')`. The pair-hourly runner needs no code change if the test passes once the constant is 2; if it fails, fix the due rule so that a set of another config version is always due.
- [ ] **Step 4: Run** the syncer unit suite and `pnpm build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(syncer): the syncer_markets_live_amm_share_known gauge; version-1 pair_hourly hours are recomputed`.

### Task 4: `GET /v2/network/markets`: `amm` and the AMM fields

**Files:**
- Modify: `apps/api/src/network/markets.controller.ts`, `apps/api/src/network/markets.service.ts`, `apps/api/src/network/markets-object.ts`, `apps/api/test/support/markets-world.ts`, `docs/api-reference.md` (only the `d2-example` blocks of `network/markets`, so `api-reference-examples.e2e-spec.ts` keeps passing)
- Test: `apps/api/src/network/markets-object.spec.ts`, `apps/api/test/network-markets.e2e-spec.ts`, `apps/api/test/api-reference-examples.e2e-spec.ts` (run, unchanged)

**Interfaces:**
- Consumes: Task 2's sets; `ammFilter` / `AmmFilter` of `apps/api/src/common/params.ts`.
- Produces: `MarketsQuery.amm: AmmFilter`; `StoredMarket.amm_share: string | null`, `StoredMarket.amm_pool: number | null`; `StoredMarketsSet.total_amm_share: string | null`; `marketsAnswer(input)` with `input.amm`; `noMarketsAnswer(period, amm)`; `seedMarketsWorld(h, now, { amm?: boolean })` (default false: the world's existing trades and numbers; true adds a pool, its swaps and its `amm_pools` row).

- [ ] **Step 1: Write the failing unit tests** in `markets-object.spec.ts`: the key orders of Global Constraints with and without every optional key; `amm` echoed (`include` default); `amm_share` and `amm_pool: true|false` on a market only when stored non-NULL; `totals.amm_share` only when `total_amm_share` is non-NULL; the no-set answer `{result, period, amm, count: 0, markets: []}`; CSV flattening of a market has `amm_share` and `amm_pool`.
- [ ] **Step 2: Write the failing e2e tests** in `network-markets.e2e-spec.ts`:
  - The decoys become: an older version of each filter's set, and nothing else (the job writes real `exclude` and `only` sets now).
  - `it('amm=exclude and amm=only serve their sets; the answer echoes amm, include by default')`.
  - `it('an unknown amm is 400 invalid amm filter - use: include, exclude, only, after the display currency checks')` (`?exchange_currency=USD&amm=x` gives the exchange error first).
  - `it('amm_share, amm_pool and totals.amm_share are served when the set has them, and left out when the parser gate kept them out')`.
  - With `seedMarketsWorld(h, MARKETS_NOW, { amm: true })`: `it('a pool pair: amm_share and amm_pool true; only lists the swaps; exclude leaves out a pair of swaps only')`.
  - Xahau suite: `amm_share` `"0.0000"`, `amm_pool` false, `totals.amm_share` `"0.0000"`.
  - The existing "no AMM key is ever served" / "amm is ignored" tests are replaced by the above.
- [ ] **Step 3: Run** `pnpm --filter @gatehub/data-api-service test -- markets-object` and `pnpm --filter @gatehub/data-api-service test:e2e -- network-markets`. Expected: FAIL.
- [ ] **Step 4: Implement.** The controller checks `amm = ammFilter(query)` after the display currency (D7) and documents `amm` with `@ApiQuery` (enum of the three, "From the AMM data: `exclude` the order-book trades only, `only` the swaps; the AMM fields are there only when every ledger of the window was parsed with AMM"). The service reads the set of `amm = {amm:String}` with `amm_share`, `amm_pool`, `total_amm_share`. The object builds the keys of Global Constraints. Rewrite the class comments that say no AMM field is served. Update the markets `d2-example` blocks in `docs/api-reference.md` to what the route now serves.
- [ ] **Step 5: Run** the tests of Step 3, `pnpm --filter @gatehub/data-api-service test:e2e -- api-reference-examples`, the api unit suite and `pnpm build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(api): network/markets takes amm (include, exclude, only) and serves amm_share, amm_pool and totals.amm_share when known`.

### Task 5: Swaps in the analytics routes, the rollups and the daily rates (proof, shared and API)

**Files:**
- Modify: `apps/api/test/support/analytics-world.ts` (`TradeSpec` gains an optional ninth element `amm_account`, default `''`)
- Test: `packages/shared/test/rates-daily-job.e2e-spec.ts`, `packages/shared/test/account-day-groups.e2e-spec.ts`, `apps/api/test/account-analytics-payments-trades.e2e-spec.ts`

**Interfaces:**
- Consumes: the AMM work's storage (a swap is an `exchanges` row and an `account_exchanges` row per side, `amm_account` set). No production code is expected to change (D2b.2); if a proof fails, the fix is part of this task and names the rule it restores.

- [ ] **Step 1: Write the tests.**
  - `rates-daily-job.e2e-spec.ts`: `it('with swaps among the trades, dailyNativeRatesOfDay still equals dailyNativeRates for every asset')`: swaps against native pairs on day D and in the 14 days before it, some above and some at the dust limit.
  - `account-day-groups.e2e-spec.ts`: `it('swaps in the window: rolled-up groups equal raw groups, complete, partial before and partial after')`, the account trading against a pool on both sides.
  - `account-analytics-payments-trades.e2e-spec.ts`: `it('analytics/exchanges counts a swap as a trade of its pair, bought and sold by side, and carries no AMM field')` and, inside "the same answer rolled up", the swaps in the window so that the byte-for-byte comparison covers them.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test:e2e -- rates-daily account-day-groups` and `pnpm --filter @gatehub/data-api-service test:e2e -- account-analytics-payments-trades`. Expected: PASS. A failure is a D2b.2 defect: find its cause (systematic debugging), fix it with a test, and say so in the report.
- [ ] **Step 3: Commit** `test(shared,api): every D2 aggregate counts swaps; raw and rolled-up answers still agree`.

### Task 6: A `--reprocess` corrects rates, hours and heavy-account days (syncer e2e)

**Files:**
- Create: `apps/syncer/test/aggregator-aggregates-amm.e2e-spec.ts`

**Interfaces:**
- Consumes: `syntheticChain(first, count, { template: ammTemplate(), closeTime })` of `apps/syncer/test/synthetic-chain.ts`, `rangeIngest` (as `range-ingest.e2e-spec.ts` calls it), `AggregatorService` with the `aggregates` option (as `aggregator-aggregates.e2e-spec.ts` builds it, its generous budgets), `readDirtyRanges`.

- [ ] **Step 1: Write the test** `it('a reprocess from parser 1 to parser 2 marks the rates of its days stale and computes them with the swaps, recomputes the hours with amm rows and rolls the heavy account again')`:
  1. Range-ingest a chain of AMM ledgers spread over two UTC days (one ledger every few minutes), then make it what parser 1 wrote: delete the rows of the AMM tables and the swaps from `exchanges` and `account_exchanges`, as `range-ingest.e2e-spec.ts` "reprocess gives ledgers written without AMM rows…" does, and set those ledgers' `parser_version` to 1. Add a heavy account (a taker of the template's swaps) with `ACCOUNT_PARTITION_ROWS_FLOOR` balance changes on a ledger of the first day, as the aggregates e2e does.
  2. Tick at a `now` after the chain: rates of the first day, the hours, the heavy account's day and the markets `day` set are written; the markets sets have no `total_amm_share` (the gate).
  3. `rangeIngest(..., { reprocess: true })` over the chain; tick again until `readDirtyRanges` is empty.
  4. Expect: the first day's rates have a stale sentinel and then a newer valid set equal to `dailyNativeRatesOfDay` now (with the swaps); the hours of the chain have `source = 'amm'` rows at newer versions; the heavy account's day has a newer sentinel and its `account_trades_daily` rows count the swaps; the newest `include` markets set of `day` has `total_amm_share`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-syncer test:e2e -- aggregator-aggregates-amm`. Expected: PASS. A failure is a D2b.2 defect, fixed in this task with its own test.
- [ ] **Step 3: Commit** `test(syncer): a reprocess with the AMM parser corrects the rates, hours and heavy-account days`.

### Task 7: `fees_est`: migration 004 and the live `amm_volume`/`day` set

**Files:**
- Create: `packages/shared/schema/004_amm_fee_estimates.sql`
- Modify: `packages/shared/src/clickhouse/rows.ts` (`VolumeLiveRow.fees_est_f: number | null`), `packages/shared/src/aggregate/amm-daily.job.ts`, `packages/shared/src/aggregate/volume.job.ts`, `packages/shared/src/index.ts`, `packages/shared/test/sample-rows.ts`
- Test: `packages/shared/src/clickhouse/schema.spec.ts` (run), `packages/shared/test/migrate.e2e-spec.ts`, `packages/shared/src/aggregate/volume.job.spec.ts`, `packages/shared/test/amm-volume-job.e2e-spec.ts`

**Interfaces:**
- Produces:
  - `export async function ammWindowSwapTotals(ch: ClickHouseService, pools: readonly { account: string; pair: PairColumns }[], ledgers: { first: number; last: number }): Promise<Map<string, SwapTotals>>` in `amm-daily.job.ts`: the swaps of the pools in the ledgers (`AMM_DAILY_SWAPS_SQL`), the fee state carried into `first` (`readFill` + `deepenFill` with `dailyQuery(first, CARRY_REQUIRED)`) and the fee events and bids in the range (`feeEventsOf`), through `swapTotals`. It reuses the file's private helpers; it does not change `poolDays`.
  - `export function componentFeesEst(component: { base: Asset; amount: BigNumber; converted: BigNumber }, pool: { base: Asset; counter: Asset; baseVolume: BigNumber; counterVolume: BigNumber }, totals: SwapTotals): BigNumber | null` in `volume.job.ts`: with S the component's `base` (the side of `amount`) and O the pool's other asset, `fees_S × converted ÷ amount + fees_O × converted ÷ volume_O` (D8), `null` when a side's fee is `null`, or above 0 with its volume not above 0.
  - `volume_live.fees_est_f`: on the component rows of the `amm_volume`/`day` live set, the native estimate as Float64, NULL when not known; NULL on every other row of `volume_live`.

- [ ] **Step 1: Write the failing tests.**
  - `migrate.e2e-spec.ts`: `volume_live` has `fees_est_f Nullable(Float64)`; `it('applies 004 to a database migrated before it, and then nothing')` (as D2's test for 003); the test that applies the real schema dir to a database of `001` lists `004_amm_fee_estimates.sql` among the applied. `sample-rows.ts` gives `volume_live` a `fees_est_f`.
  - `volume.job.spec.ts`, `describe('componentFeesEst')`: a pool against the native currency (fees of both sides, the native side worth itself); a pool converted through its counter (sides swapped); a `null` side; a side with fees and no volume; zero fees.
  - `amm-volume-job.e2e-spec.ts`: `it('fees_est against swapTotals: the live day set carries, per pool, the fees of the window converted like converted_amount')` on a hand-made world with a fee vote and an auction slot inside the window, a slot that expires inside it, a fee state carried from before the window and a pool whose fee is not known (that component's `fees_est_f` is NULL); `it('only the day live set has fees_est_f; the other periods, the daily sets and the other metrics have NULL')`; on the AMM recordings, `fees_est_f` equals the oracle (`swapTotals` over the stored swaps, converted by `componentFeesEst`).
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- volume.job schema` and `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate amm-volume`. Expected: FAIL.
- [ ] **Step 3: Implement.** The migration file (a header comment naming D2b.3 and the split rule, then the one statement). `VolumeComponent` gains `feesEst?: BigNumber | null`; `ammComponents` takes `withFees: boolean` and, when true, sets it from `ammWindowSwapTotals` over the pools of its range and `componentFeesEst` (the pool's stored assets and volumes, before `poolLeg` turns it); `componentsOf` passes `withFees` for `amm_volume` only; `computeLiveVolumeSet` asks for it when `period === 'day'` and writes `fees_est_f` on each live row (`feesEst?.toNumber() ?? null`, NULL on the sentinel). Daily sets are unchanged.
- [ ] **Step 4: Run** the tests of Step 2, the shared unit suite and build, `pnpm --filter @gatehub/data-syncer test`, and `pnpm --filter @gatehub/data-syncer test:e2e -- aggregator-volumes`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(schema,shared): migration 004 and fees_est_f, the 24 h fee estimates of the AMM volume's live day set`.

### Task 8: `fees_est` on `GET /v2/network/amm_volume?live=day`

**Files:**
- Modify: `apps/api/src/network/volume.service.ts`, `apps/api/src/network/volume-object.ts`
- Test: `apps/api/src/network/volume-object.spec.ts`, `apps/api/test/volume.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 7's `volume_live.fees_est_f`.
- Produces: `StoredVolumeRow.fees_est_f?: number | string | null` (selected by the live read only); `VolumePart.feesEst?: number | null` (a part of several rows is `null` if any is); `toVolumeRow` serves component `fees_est = String(feesEst × X)` and row `fees_est = String(Σ feesEst × X)` (D9), with X the display rate as for `converted_amount` and `total`.

- [ ] **Step 1: Write the failing unit tests** in `volume-object.spec.ts`: the key orders of Global Constraints; a component with `feesEst` null has no `fees_est`, and then the row has none; the row's sum and its display conversion; no `fees_est` for trade and payment rows, nor for a part without `feesEst`.
- [ ] **Step 2: Write the failing e2e tests** in `volume.e2e-spec.ts`, `describe('GET /v2/network/amm_volume')`: `it('the live day row has fees_est per component and their sum, converted like converted_amount, also with exchange_currency')`; `it('live=3day, the historical rows and the other metrics have no fees_est')`; `it('a component without fees_est leaves the row without one')` (a hand-written `fees_est_f` NULL); `it('the CSV has the fees_est columns')`.
- [ ] **Step 3: Run** `pnpm --filter @gatehub/data-api-service test -- volume-object` and `pnpm --filter @gatehub/data-api-service test:e2e -- volume`. Expected: FAIL.
- [ ] **Step 4: Implement** as the Interfaces say; the `@ApiOperation` text of `amm_volume` names `fees_est`.
- [ ] **Step 5: Run** the tests of Step 3, the api unit suite and `pnpm build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(api): fees_est on the live day row of network/amm_volume`.

### Task 9: `computed_start` and `computed_end` on the pool history per day

**Files:**
- Modify: `apps/api/src/amm/amm-pools.service.ts`, `apps/api/src/amm/amm-pools.controller.ts`, `apps/api/src/amm/amm-objects.ts`
- Test: `apps/api/src/amm/amm-objects.spec.ts`, `apps/api/test/amm-pools.e2e-spec.ts`

**Interfaces:**
- Consumes: `AMM_DAILY_CONFIG_VERSION` (shared).
- Produces: `export function computedRange(days: readonly string[]): { start: string; end: string } | undefined` in `amm-objects.ts` (days `YYYY-MM-DD` in any order: `end` the newest, `start` the oldest day reached from it without a missing day); `DaysPage.computed?: { start: string; end: string }`.

- [ ] **Step 1: Write the failing unit test** in `amm-objects.spec.ts`: `computedRange([])` is `undefined`; one day; a contiguous run; a hole (`['2026-01-01','2026-01-02','2026-01-04','2026-01-05']` → `{start: '2026-01-04', end: '2026-01-05'}`); unsorted input; a month and a year boundary.
- [ ] **Step 2: Write the failing e2e tests** in `amm-pools.e2e-spec.ts`, in the suite of hand-made sets: `it('computed_start and computed_end: a fully computed window')`, `('a back-fill under way: only the newest days')`, `('a hole ends the range')`, `('no set in the window: both keys absent')`, `('a quiet day inside the range has no row and is inside it')`, `('a sentinel of another config version is not computed')`, `('every page of a paged answer has the same range')`, `('not in the CSV, and not on the history without interval')`, and the key order `result, computed_start, computed_end, count, marker, days`.
- [ ] **Step 3: Run** `pnpm --filter @gatehub/data-api-service test -- amm-objects` and `pnpm --filter @gatehub/data-api-service test:e2e -- amm-pools`. Expected: FAIL.
- [ ] **Step 4: Implement.** In `days()`, before the marker narrows the window, keep the request's `first` and `last` (D10) and read, in parallel with the page, `SELECT toString(day) AS day FROM (SELECT day, config_version FROM amm_daily WHERE amm_account = '' AND day BETWEEN {first:Date} AND {last:Date} ORDER BY day, version DESC LIMIT 1 BY day) WHERE config_version = {configVersion:UInt32}`; `computedRange` of those days. The controller puts `computed_start` and `computed_end` after `result` in the JSON body only. The route's description names them.
- [ ] **Step 5: Run** the tests of Step 3, the api unit suite and `pnpm build`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(api): computed_start and computed_end on the AMM pool history per day`.

### Task 10: Documentation, ADR-0013's D2b section, and the reference

**Files:**
- Modify: `docs/api-reference.md` (the AMM fields and `amm` of `network/markets` with D1, D2 and the parser gate; `fees_est`; `computed_start` / `computed_end`), `docs/data-model.md` (`volume_live.fees_est_f`, `pair_hourly.source` from D2b, the `markets_live` filters), `docs/syncer.md` (the source split and the catch-up at config version 2, the three filter sets, the fee estimate of the live day set), `docs/observability.md` (the gauge, and an alert-free note: it gates `AMM_DATA`), `docs/operations.md` (D2b's rollout: after the AMM rollout, `migrate`, the syncer, the API; what to watch), `docs/adr/0013-account-and-market-aggregates.md` (a "D2b" section: the source split, the filter sets and the gate, `fees_est`, the computed range, D1–D10), `docs/configuration.md` only if a constant is listed there, `README.md` and `docs/development.md` (their migration lists gain `004`), `docs/openapi.yaml` (regenerated as `docs/development.md` says)
- Test: `apps/api/test/api-reference-examples.e2e-spec.ts`

- [ ] **Step 1: Write** the documentation; every new answer example in `api-reference.md` that sits under a `d2-example` marker is what the API serves.
- [ ] **Step 2: Regenerate** `docs/openapi.yaml` and check its diff holds only D2b's parameters and descriptions.
- [ ] **Step 3: Run** `pnpm --filter @gatehub/data-api-service test:e2e -- api-reference-examples` and `pnpm build`. Expected: PASS.
- [ ] **Step 4: Commit** `docs: D2b, the AMM data additions to the aggregates (reference, data model, syncer, observability, operations, ADR-0013)`.
