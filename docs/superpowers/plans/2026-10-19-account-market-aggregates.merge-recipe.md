# Merge recipe: the account and market aggregates (D2) on `main`, then `feat/amm-data`

For the owner. Spec: `docs/superpowers/specs/2026-10-19-account-market-aggregates-design.md`, section 17; the decision is
[ADR-0013](../../adr/0013-account-and-market-aggregates.md). D2 merges to `main` on its own, after D1, and does not wait for the AMM work; this
document is for the merge of `feat/amm-data` into that `main`. The two branches meet in registration files, the shared exports, the table lists of
some tests and the docs, **never in a migration**: the AMM work changes `001_baseline.sql` in place and adds no file, D1 adds `002` and D2 adds `003`.

**Every resolution keeps both sides.** Nothing of D2 is dropped, and nothing of the AMM work. Should `feat/amm-data` reach `main` before D2 instead,
D2's branch is rebased onto it with the same resolutions. D2b (the AMM additions of the aggregates) follows D2 in either case.

## What was checked, and how to find the files

- **D2's files** are `git diff --name-only e26bc0c HEAD` of the D2 branch. `e26bc0c` is the commit the branch was cut from (the plan's "parent of Task 1
  Step 0's commit" does not exist: that step was skipped). The files that **both** branches change are:

  ```bash
  comm -12 <(git diff --name-only e26bc0c HEAD | sort) <(git diff --name-only main...feat/amm-data | sort)
  ```

  It lists 27 files, and **every one is in the table below** (the last section of this document checks that with a one-line script). Of them 18 conflict as text and
  9 merge by themselves; the 9 are listed too, with what to look at.
- **The text conflicts were found, not guessed**: `git merge-tree --write-tree --name-only HEAD feat/amm-data` of the D2 branch (at `f6dde45`) and `feat/amm-data`
  at `c3e2302`, which writes the merge result without touching a working tree. It also showed conflicts in
  files D2 did not change (`docs/architecture.md`, `packages/shared/scripts/record-fixtures*.ts`, `packages/shared/jest.config.js`,
  `packages/shared/test/fixtures/README.md`, `packages/shared/test/ledger-writer.e2e-spec.ts`, and the `AmendmentFeaturesRow` imports of `sample-rows.ts`): those are
  between D1 and the AMM work, and are D1's recipe, not this one's. When D1 is on `main` before the merge, `git merge feat/amm-data` on `main` shows D1's and D2's
  conflicts together.
- **Check the AMM branch's head before you start.** The table is for `feat/amm-data` at `c3e2302`; a later commit that touches one of these files can add a hunk.
  Run `git merge-tree --write-tree --name-only main feat/amm-data` (git 2.38 or later) for the list of what conflicts today.

## The files

### 1. `apps/syncer/src/aggregator/job-context.ts` (new on the AMM side)

Not a D2 file, so no conflict. Take it as it is, and add D2's four names to its `AggregatorJobName`, **in tick order**:

```ts
export type AggregatorJobName =
  | 'volume_live' | 'volume_daily' | 'amm_pools' | 'pair_hourly' | 'markets_live' | 'stats_live' | 'stats_dirty'
  | 'amm_daily' | 'rates_daily' | 'account_rollups' | 'volume_backfill';
```

(`AggregatorJobContext.budgets` is a `Record<AggregatorJobName, number>`, so the budgets record of the service needs the four new keys; item 2.)

### 2. `apps/syncer/src/aggregator/aggregator.service.ts` (conflict, 14 hunks)

Take the AMM side's shape and **re-apply D2's registration diff** to it. Hunk by hunk, in file order (the numbers below are steps, not hunks: items 5 and 6 are three hunks of the class comment):

1. **The shared-package import list**: keep all three abort errors, `AggregateSetAborted` (D2) and `AmmDailyRecomputeAborted`, `AmmPoolsRecomputeAborted` (AMM).
2. **The runner imports**: keep D2's (`AccountRollupsJobRunner` above the conflict, then `AggregateFunctions`, `AggregateJobDeps`, `AggregatorAggregates` from `./aggregate-job-deps`,
   and the three other runners) and the AMM side's (the two AMM runners, the block from `./job-context`, and the `export { ... } from` lines). The AMM side's `export type { AggregatorJobName, AggregatorTick } from './job-context'`
   is what D2's runners import `AggregatorTick` through (`import type { AggregatorJob, AggregatorTick } from './aggregator.service'`), so they compile unchanged. `AggregatorJob` stays declared in this file on both sides.
3. **`AggregatorJobName`**: take the AMM side (the declaration is gone from this file; it comes from `job-context.ts`) and drop D2's local copy; D2's names are in `job-context.ts` by item 1.
4. **`AggregatorOptions`**: both sides' options: D2's `aggregates?: AggregatorAggregates` and `aggregateFunctions?`, and the AMM side's `ammPools`, `ammPoolsFunctions`, `ammDaily`, `ammDailyFunctions`, `ammDailyEveryTicks`.
5. **The class comment's job list** (two hunks: the first jobs, then the text from `stats_dirty` on): renumber it to the tick order of section 3 of the spec (the same list as item 6), the AMM jobs 3 and 8 and D2's 4, 5, 9 and 10:
   `1 volume_live`, `2 volume_daily`, `3 amm_pools`, `4 pair_hourly`, `5 markets_live`, `6 stats_live`, `7 stats_dirty` (its text names the AMM hooks and D2's three), `8 amm_daily`, `9 rates_daily`, `10 account_rollups`, `11 volume_backfill`.
   D2 renumbered this list (a guaranteed hunk here), and its text for jobs 4, 5, 9 and 10 and for the hooks of 7 is the D2 side of each hunk.
6. **The paragraph "Every slice and every set is idempotent ..."**: both: the AMM side's paragraph on the AMM runners, then D2's wording ("a volume set or a set of the account and market jobs ... and so do the account and market jobs").
7. **The fields**: D2's `aggregateRunners?` and the AMM side's `ammPools`, `ammDaily`, `tickCount`. For `backfilling` take the AMM side's `Set<'volume' | 'amm_daily'>`; D2 did not change that field (it only added a line above it).
8. **The budgets record**: the AMM side's seven keys and D2's four (`pair_hourly`, `markets_live`, `rates_daily`, `account_rollups`). **Both sides' budget constants stay** (`AGGREGATOR_AMM_*_BUDGET_MS` and D2's four `AGGREGATOR_*_BUDGET_MS`).
9. **The constructor**: D2's `aggregates` block (the `depsOf` helper and the four runners) next to the AMM side's `jobContext()` and its two runners.
10. **The jobs list** is the order of section 3 of the spec. `pair_hourly` and `markets_live` come after `amm_pools` and before `stats_live`; `rates_daily` and `account_rollups` after `amm_daily` and before `volume_backfill`:
    `volume_live`, `volume_daily`, `amm_pools`, `pair_hourly`, `markets_live`, `stats_live`, `stats_dirty`, `amm_daily`, `rates_daily`, `account_rollups`, `volume_backfill`. **D2's jobs have no `everyTicks`**: they run at every tick
    (the one cadence of N ticks of D2, `markets_live`'s, is counted by its runner).
11. **`failed()`**: the test of the shutdown names `StatsRecomputeAborted`, `VolumeRecomputeAborted`, `AggregateSetAborted`, `AmmPoolsRecomputeAborted` and `AmmDailyRecomputeAborted`.
12. **`recomputeDirty`, after the slice's volume sets**: the AMM side's two hooks (the two `try` blocks for `amm_pools_dirty` and `amm_daily_dirty`), then D2's call. The conflict mixes them because the two sides end in the same lines:
    keep both `try` blocks and put D2's `if (!(await this.hooksOfSlice(start, end, tick))) { outcome = 'failed'; break; }` after them. **D2's three hooks are one private method, `hooksOfSlice`, called once** (order: `rates_daily`, `pair_hourly`,
    `account_rollups`; a failure is `failed('<job>_dirty', ...)` and fails the slice, as a volume set's does); there are no inline `try` blocks of D2's to merge.
13. **The doc comments of `hooksOfSlice` and `mayStartSet`**: keep both methods; `mayStartSet`'s comment is the AMM side's ("a job that works in sets or batches (the volume jobs, `amm_pools`)").
14. The rest of the file merges by itself.

**D2's runners stay on `AggregateJobDeps`** (`aggregate-job-deps.ts`): the merge does not move them onto `AggregatorJobContext` (a later refactor may, with no change of behaviour). They import only the shared package, `./aggregate-job-deps` and the types
of this file.

### 3. `apps/syncer/src/aggregator/aggregator.module.ts` (conflict, 2 hunks)

One `RatesService` for the volume jobs, the AMM jobs and `aggregates` (the AMM side already shares one between `volumes`, `ammPools` and `ammDaily`):

```ts
const rates = new RatesService(ch, profile.nativeCurrency);
// ... both sides' logger.log lines ...
return {
  volumes: { rates, markets },
  ammPools: { rates },
  ammDaily: { rates },
  aggregates: { rates, accountRollupMinRows: config.accountRollupMinRows },
};
```

`aggregatorOptions(ch, profile, config, logger)` takes D2's `config: SyncerConfig` parameter (the factory injects `SyncerConfig`, D2's side; check the AMM side's callers and tests for the signature). The doc comments of the function and of the module: both sides'
sentences (the markets config and the rates which the volume jobs, the value of a pool and the account and market jobs share; the size from which an account is rolled up; the jobs the worker keeps up to date).

### 4. `apps/syncer/src/aggregator/aggregator.module.spec.ts` (conflict, 1 hunk)

Both assertions: the runs of `amm_pools` and `amm_daily` (AMM) and `for (const job of ['pair_hourly', 'markets_live', 'rates_daily', 'account_rollups'])` (D2) over the empty database. Its factory now passes `SyncerConfig` (D2).

### 5. `apps/syncer/src/modules/prometheus/prometheus.service.ts` and `apps/syncer/src/modules/prometheus/prometheus.service.spec.ts` (merge by themselves)

Both sides' metrics: the AMM side's `syncer_amm_unclassified_total` and the changed help of the aggregator counters, and D2's five gauges (`syncer_pair_hourly_missing_hours`, `syncer_markets_live_age_seconds`, `syncer_rates_daily_missing_days`,
`syncer_account_rollups_heavy_accounts`, `syncer_account_rollups_pending_accounts`). Check that both sides' accessors (`readonly pairHourlyMissingHours = ...`) and both sides' tests are there.

### 6. `packages/shared/src/clickhouse/tables.ts`, `packages/shared/src/clickhouse/rows.ts`, `packages/shared/src/index.ts` (conflicts)

Both sides' entries. The `Table` enum holds the AMM tables and D2's nine (`NativeRatesDaily`, `PairHourly`, `MarketsLive`, `AccountRollupState`, `AccountPartitionRows`, `AccountRollupDays`, `AccountLinesDaily`, `AccountTxDaily`, `AccountTradesDaily`); `rows.ts` has both sides' row
interfaces (the conflict interleaves `AmmPoolsRow` with `NativeRatesDailyRow` and `PairHourlyRow`: keep every interface whole); `index.ts` keeps the AMM side's `export * from './parsers/amm.parser'` next to D2's lines.

### 7. `packages/shared/test/migrate.e2e-spec.ts` and `packages/shared/test/sample-rows.ts` (conflicts)

Both sides' tables in the lists: the physical design of the AMM tables and of D2's nine in the migrate suite (D2's `ORDER BY` keep `version` last in the three rollup row tables), and both sides' row samples and imports in `sample-rows.ts` (D1's `AmendmentFeaturesRow` imports are D1's). The migrate suite's test of the applied files
(`applied: [...]`: the schema of the real directory) lists `002` and `003`; the AMM work adds no migration file, so nothing of it changes there.

### 8. `packages/shared/src/query/rates.service.ts` (merges by itself)

The AMM side's `exchangeSumsSql` refactor of `pairSums` and D2's `dailyNativeRatesOfDay` (and its exports `KEEP_ANY_PAIR`, `NATIVE_PAIR_FILTER`, `DayNativeRate`) touch different places. D2's method writes its own reads (the native pairs of the 15 days, then the rows of those pairs with `row_number()` and an `ARRAY JOIN` over the
`latest` and `daily` parts), which are not the grouped read of `exchangeSumsSql`: **there is nothing to change**. (Where a later refactor wants one grouped read, `exchangeSumsSql` is the same SQL.) After the merge swaps are `exchanges` rows, so `dailyNativeRatesOfDay` and `dailyNativeRates` both count them: check
that they still agree (item 10).

### 9. `apps/api/src/accounts/accounts.module.ts` and `apps/api/src/network/network.module.ts`

- `accounts.module.ts` (conflict, 3 hunks): both sides' controllers and providers: `AccountAnalyticsController` and `AccountAmmController` in `controllers`; `AccountDayGroupsService`, `AccountAnalyticsService` and `AccountAmmService` in `providers`; both import pairs.
- `network.module.ts` (conflict in the doc comment only): the controllers and providers merge by themselves (`MarketsController`, `MarketsService` stay); in the comment keep both sentences (`amm_volume` and `network/markets`).

### 10. The API tests: `apps/api/test/account-stats.e2e-spec.ts`, `apps/api/test/account-reports.e2e-spec.ts` (merge by themselves)

These are AMM-list files that D2 edited (the stats and reports e2e suites changed for the new `interval`): the `controllers` option of `startHarness` (`CACHE_CONTROLLERS`, `cache-controllers.ts`) and a cache clear before each test, and `granularity=day` instead of `interval=day` in account-stats' "unknown params ignored" (`interval` is a parameter now).
The AMM side edits other places of the same files (the seeded trades gain `amm_account`). Both apply; **keep both**, and if a hunk ever conflicts keep both.

### 11. The syncer tests: `aggregator.service.spec.ts`, `apps/syncer/test/aggregator-fakes.ts`, D2's `aggregator.schedule.spec.ts`

- `apps/syncer/src/aggregator/aggregator.service.spec.ts`: D2 did not change it (its tests that list jobs build the service without `aggregates`), so it is the AMM side's version, unchanged.
- **`apps/syncer/test/aggregator-fakes.ts` is taken from the AMM side unchanged.** D2's fakes are in `apps/syncer/test/aggregate-job-fakes.ts`, a file of its own, so the two do not meet.
- **`aggregator.schedule.spec.ts`** (D2's; not a conflict, but it must change at the merge so that its starving test covers every job): `EVERY_JOB` becomes the eleven jobs of the order above, the service of the spec gets the AMM options (`ammPools: { rates }`, `ammDaily: { rates }`, their `...Functions` fakes from
  `aggregator-fakes.ts`, and `ammDailyEveryTicks: 1` so that `amm_daily` runs at every tick of a test), and the assertions about places gain `amm_pools` before `pair_hourly` and `amm_daily` before `rates_daily`. The test that D2's jobs run at every tick and the budgets of the four D2 jobs stay as they are.

### 12. The docs (the nine files of spec item 9, and three more)

Both sides' sections everywhere; D2's material is in blocks of its own, so most hunks are about counts, rows and lists.

| File | Conflict | Resolution |
| --- | --- | --- |
| `docs/api-reference.md` | none | Merges by itself: `network/markets` stays in the Network section before the AMM section; the analytics section, the `interval` blocks and the Compatibility paragraph are D2's. Check the order of the sections and the Compatibility paragraph. |
| `docs/data-model.md` | yes | The count of tables: **49** in all (23 baseline, 7 AMM, 10 of `002`, 9 of `003`), and the groups of the table (AMM's `Aggregates (5)` row with `amm_pools` and `amm_daily`, and D2's `Account and market aggregates (9, migration 003)` row); the dedup sentence (the AMM side's count of ledger-derived tables, D1's two collector tables); the relationships diagram (both sides' lines); the sizing bullets (D1's, the AMM side's `amm_*` rollups). D2's section "Account and market aggregates (migration 003)" and its `003` row of the migrations table are clean. |
| `docs/clickhouse.md` | yes | "the same **49** tables"; the retention paragraph: the AMM side's list of rollups with `amm_pools`, `amm_daily` and D2's sentences on the tables of migration 003. D2's section "The aggregate families and their reads" is clean. |
| `docs/syncer.md` | yes | The job table of section 7 has **eleven** rows in tick order (the AMM side's seven and D2's four, renumbered): `volume_live`, `volume_daily`, `amm_pools`, `pair_hourly`, `markets_live`, `stats_live`, `stats_dirty` (its text names both sides' hooks), `amm_daily`, `rates_daily`, `account_rollups`, `volume_backfill`; the sentence "runs eleven jobs". D2's subsections 7.1 to 7.7 and the AMM side's "The AMM jobs" section both stay: **do not renumber D2's headings** (`#74-account_rollups` and `#76-the-agg_dirty-hooks` are linked from other pages). |
| `docs/configuration.md` | none | Merges by itself (`GH_ACCOUNT_ROLLUP_MIN_ROWS` and the compose rows). |
| `docs/observability.md` | yes | The rows of `syncer_aggregator_runs_total` and `syncer_aggregator_errors_total`: the label lists of both sides (`volume_live`, `volume_daily`, `amm_pools`, `pair_hourly`, `markets_live`, `stats_live`, `stats_dirty`, `amm_daily`, `rates_daily`, `account_rollups`, `volume_backfill`, and the `_dirty` hooks of both), the AMM side's `syncer_amm_unclassified_total` row, D2's gauge rows; the logging paragraph (the contexts: D2's `Rates back-fill ...` lines and the AMM side's `amm_pools` lines both). The alerts and the PromQL block are D2's and clean. |
| `docs/operations.md` | yes | The at-a-glance rows (aggregator progress with the AMM side's label list, the AMM row, D2's row) and the what-to-watch rows (both sides'). D2's section "Account and market aggregates" and the AMM side's "The AMM jobs" are separate blocks. |
| `docs/adr/0010-ripple-v2-wire-compatibility.md` | yes (the status line) | `**Status:** Accepted (amended by [ADR-0011](0011-amm-data-and-swaps-as-exchanges.md): section 6, AMM swaps are exchanges; by [ADR-0013](0013-account-and-market-aggregates.md): section 2, items 10a to 10f, the routes and parameters of the account and market aggregates).` The AMM side's section 6 (items 40 to 44) and D2's items 10a to 10f are separate blocks. |
| `docs/adr/README.md` | yes | The rows in order: `0010` (status "Accepted (amended by 0011: AMM swaps are exchanges; by 0013: the account and market routes and `interval`)"), `0011` (AMM), `0012` (D1), `0013` (D2). |
| `docs/openapi.yaml` | yes | **Regenerated after the merge, not merged by hand**: take either side to clear the conflict (`git checkout --ours docs/openapi.yaml`), then regenerate by the procedure of `docs/development.md` section 8 (keep its header comment). |
| `README.md`, `docs/development.md` | none | Merge by themselves (D2 only adds `003_account_market_aggregates` to the migration lists next to `002`). |

## The database consequence

The AMM work changes `001_baseline.sql` **in place** (it adds columns and tables to the baseline instead of a new migration). The migration runner refuses an applied file whose checksum changed
(`packages/shared/src/clickhouse/migrate.ts`: `Migration ... was modified after being applied`), so **a database created before you merge `feat/amm-data` is recreated at that merge**. For D2 this costs only its back-fills: all nine tables are recomputable aggregates, so once the ledgers are ingested again `pair_hourly`
fills in minutes, `rates_daily` in about a day and the first promotion of the heavy accounts in one to two days (`syncer_rates_daily_missing_days` and `syncer_account_rollups_pending_accounts` fall to 0), and until then answers are right and slower ([operations](../../operations.md#account-and-market-aggregates)). The constraint that this puts on the order of the deploys is D1's: its data (validator
votes and agreement) is what a recreation would lose. After the AMM rollout (its databases recreated, the `range-ingest --reprocess` from the AMM enablement ledger) the `agg_dirty` ranges run D2's hooks: rate days marked stale and computed again, the hours of the last 31 days recomputed, the covered days of heavy accounts rolled again.

## After the merge

1. `pnpm install --frozen-lockfile`, then `pnpm build` (the typecheck: it catches a budgets record that lacks a key and a runner that imports a name the merge moved), `pnpm lint`.
2. **The unit suites and the end-to-end suites** of the three packages. D2's suites must pass on the new baseline: swaps are now `exchanges` rows, and `dailyNativeRatesOfDay` still equals `dailyNativeRates`, both counting them (`packages/shared/test/daily-rates.e2e-spec.ts`); the markets, rates and rollup job suites
   (`markets-live-job`, `rates-daily-job`, `pair-hourly-job`, `account-rollups-job`), `account-day-groups` (rollups are invisible), the migrate suite, the API suites of the analytics routes and of `network/markets`, `account-parity` (the answers of `stats` and `reports` before D2) and the syncer's `aggregator-aggregates` suite.
3. Regenerate `docs/openapi.yaml` (above) and run `pnpm --filter @gatehub/data-api-service test:e2e -- api-reference-examples`: the examples of the reference are proved against the seeded worlds.
4. Optional follow-ups, with no change of behaviour: (a) `packages/shared/src/aggregate/volume.job.ts` keeps its own private `nextVersion`, `newestLedgerClose` and `throwIfAborted`, which `packages/shared/src/aggregate/aggregate-sets.ts` (D2) repeats; point the first at the second (the SQL of `nextSetVersion` is the same as `nextVersion`'s).
   (b) The display-currency check of `volume.controller.ts` and of `markets.controller.ts` is the same text twice; one helper can serve both. (c) `docs/architecture.md` (not a D2 file) says "33 tables", and the AMM side's version says 30: it should say 49. (d) The endpoint table of the root `README.md` (an AMM-list file that D2 only touched for the migration list) does not list the new routes yet: add `.../analytics/{balances|balance_changes|counterparties|exchanges}` to its Accounts row and `/v2/network/markets` to its Network row (and `interval` where it names `reports` and `stats`).
5. **D2b** (the AMM additions of the aggregates) follows. One note for it: `pairHourSets` reads the hour sentinels **without a `source` filter** (only `book` sentinels exist in D2); D2b must add `source = 'book'`, or accept both, when it writes `amm` rows.

## Is every file in this document? (the check)

```bash
for f in $(comm -12 <(git diff --name-only e26bc0c HEAD | sort) <(git diff --name-only main...feat/amm-data | sort)); do grep -qF -- "\`$f\`" docs/superpowers/plans/2026-10-19-account-market-aggregates.merge-recipe.md || echo "MISSING: $f"; done
```

Prints nothing when it holds.
