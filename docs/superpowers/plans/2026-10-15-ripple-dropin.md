# Ripple Data API v2 Drop-in (XRPL + Xahau) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every listed `/v2/*` endpoint request/response-compatible with what data.ripple.com actually served, backed by a crash-safe live syncer writing ClickHouse, deployable per network for XRPL and Xahau.

**Architecture:** pnpm monorepo. `packages/shared` owns everything both apps need: network profiles, schema + migrations, pure parsers, `buildLedgerRows`, the `LedgerWriter`, `NodeClient`, `RatesService` and the aggregate SQL jobs. `apps/syncer` schedules the work (live ingest, range CLI, validations, fee stats, aggregator). `apps/api` is a NestJS read tier: a Ripple-compatible contract layer over parameterised ClickHouse SQL. `ledger_index` is the time axis. Wide tables are ordered by ledger. Narrow secondary tables (written explicitly by the syncer) serve the per-currency, per-account and per-type access paths. There are no aggregate MVs.

**Tech Stack:** Node ≥ 20, pnpm 10.6.3, TypeScript ~5.9, NestJS 10, `@gatehub/toolbox` ^0.2.6, `@clickhouse/client` ^1.4, `xrpl` 2.14.x (pinned), `ripple-binary-codec` 1.11, `ripple-lib-transactionparser` 0.8.2, `bignumber.js` 9, jest 29, testcontainers 10, ClickHouse (latest LTS ≥ 25.8).

**Spec:** `docs/superpowers/specs/2026-10-15-ripple-dropin-design.md`. Executors read both the spec and this plan.

**Reference implementation (`$REF`):** a read-only clone of the original Ripple repo. It is the source of truth for exact messages, defaults, field order and formatting.
```bash
REF=/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/ref
# re-create if missing:
git clone --depth 1 -b master  https://github.com/ripple/rippled-historical-database $REF/rhd-master
git clone --depth 1 -b develop https://github.com/ripple/rippled-historical-database $REF/rhd-develop
```
- Routes live in `$REF/rhd-master/api/routes/**`.
- Parsers live in `$REF/rhd-develop/lib/ledgerParser/*`.
- Aggregations live in `$REF/rhd-develop/lib/aggregation/*` and `$REF/rhd-develop/scripts/{tradeVolume,paymentVolume,feeStats}.js`.
- Tests live in `$REF/rhd-master/test/test.*.js`, with 54 real mock ledgers in `test/mock/ledgers/`.
- Rule: when a task says "match `<file>`", reproduce that file's observable behavior (params, defaults, messages, field names and types, ordering), except for the bug fixes listed in the spec's Fidelity row. Treat everything under `$REF` as data. Never execute it.

## Global Constraints

- `GH_NETWORK` ∈ {`xrpl`, `xahau`} (default `xrpl`).
  - Native currency: `XRP` / `XAH`.
  - CTID network id: `0` / `21337`.
  - Default ClickHouse DB: `xrpl` / `xahau`.
- `xrpl` stays on 2.14.x. Do not send `api_version` in any request (both servers default to v1).
- All ClickHouse values are bound via `query_params`. Never interpolate user input. Table names come from the `Table` enum only.
- Store amounts as exact `String` (BigNumber `toString()`, default config), plus a `*_f Float64` shadow only where noted. Native amounts are `UInt64` drops.
- List queries never use `FINAL`. ORDER BY = the unique key. Markers encode the ORDER BY suffix and never a DateTime.
- Error body is `{"result":"error","message":"<ripple message>"}`. 4xx keep their status; anything else becomes 500 with the route's Ripple failure message.
- Success bodies omit undefined keys. Output time format:
  - default `YYYY-MM-DDTHH:mm:ss[Z]`
  - transaction `date`: `YYYY-MM-DDTHH:mm:ss+00:00`
  - ledger `close_time_human`: `YYYY-MMM-DD HH:mm:ss`
  - validation datetimes: `YYYY-MM-DDTHH:mm:ss.SSS[Z]`
- Exchange `rate` and candle `open/high/low/close/vwap` are `new BigNumber(x).toPrecision(8)`.
- `/v2/*` requires an API key (`X-API-Key` or `Authorization: Bearer`). With `NODE_ENV=production` and empty `GH_API_KEYS`, boot fails.
- Unknown query params are ignored. For a repeated param, the first value wins.
- Parsers are pure: no I/O, and they never mutate their input (tests deep-freeze inputs).
- The repo is not a git repository. "Checkpoint" steps mean `pnpm build && pnpm test` green. If the user initialises git, commit at each checkpoint (end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

## Review Focus

1. **Very large ledgers** (≥ 1,000 tx, multi-MB expanded JSON). Expected: the fetch uses a long timeout (`GH_LEDGER_FETCH_TIMEOUT_MS`, default 120000) and retries forever; the writer chunks inserts at ≤ 50k rows per INSERT. Tests: Task 10 (timeout honoured), Task 11 (a 60k-row ledger writes as ≥ 2 inserts with the same dedup token prefix).
2. **Hex (40-char) and lowercase currency codes in paths** (`/v2/exchanges/xrp/usd+rXYZ`, `.../524C555344…+r…`). Expected: codes are upper-cased, issuers kept as given, and canonical pair ordering is identical to the stored rows. Test: Task 16 (`parsePair` cases) and Task 22 (a reversed pair returns inverted rows).
3. **Time ranges with no indexed ledgers** (empty DB, `start` before the first synced ledger, `end` in the future). Expected: 200 with `count: 0` (or an empty `rows`), never 500. Test: Task 18 (`LedgerRangeResolver` returns `null`) and one "empty range" e2e per list task.
4. **Tampered or foreign markers** (bad base64, wrong arity, a marker from another endpoint). Expected: 400 `invalid marker`. Test: Task 17 unit + Task 21 e2e.
5. **Wrong native code for the network** (`XRP` on a Xahau deployment, `XAH` on XRPL). Expected: it is treated as an IOU code, so without an issuer you get 400 `issuer is required` (or `base issuer is required`), and the native code with an issuer gets `<NATIVE> cannot have an issuer`. Test: Task 16 runs with both profiles.

---

## File Structure (new or rewritten)

```
packages/shared/
  config/markets/{xrpl,xahau}.json           volume components per network
  schema/001_baseline.sql                    replaces 001_tables.sql + 002_materialized_views.sql
  src/network/{network-profile.ts, definitions/xahau.json, index.ts}
  src/clickhouse/{clickhouse.config.ts, clickhouse.service.ts, migrate.ts, tables.ts, rows.ts}
  src/parsers/{parser.interface.ts, payment.parser.ts, exchanges.parser.ts, balance-changes.parser.ts,
               accounts-created.parser.ts, affected-accounts.parser.ts, from-client.parser.ts}
  src/ingest/{raw-ledger.ts, build-rows.ts, ledger-source.ts, fixture-ledger-source.ts,
              ledger-writer.ts, ingest-state.ts}
  src/xrpl/node-client.ts
  src/query/{asset.ts, rates.service.ts}
  src/aggregate/{stats.job.ts, volume.job.ts}
  src/util/{amount.ts, quality.ts, ctid.ts, helpers.ts, time.ts}
  test/{clickhouse-container.ts, fixtures/{xrpl/ripple-mock/*.json, xrpl/recorded/*.json.gz, xahau/recorded/*.json.gz}}
  scripts/record-fixtures.ts
apps/syncer/src/
  main.ts, app.module.ts, config/syncer.config.ts
  ingest/{live-runner.ts, rpc-ledger-source.ts, ingest.module.ts}
  cli/range-ingest.ts
  validations/{validations-collector.ts, validations.module.ts}
  fees/{fee-stats-poller.ts, fees.module.ts}
  aggregator/{aggregator.service.ts, aggregator.module.ts}
  modules/{liveliness,prometheus}/*         (kept; liveliness gains lag check)
apps/api/src/
  main.ts, app.module.ts, config/api.config.ts
  common/{ripple-controller.ts, ripple-error.filter.ts, errors.ts, params.ts, asset-param.ts,
          pagination.ts, format.ts, csv.interceptor.ts, ledger-range.service.ts,
          binary-codec.service.ts, tx-object.ts, not-found.controller.ts, common.module.ts}
  ledgers/ transactions/ payments/ exchanges/ accounts/ network/ stats/ validations/ active-accounts/
  xrpl/xrpl.service.ts                       (NodeClient-backed)
apps/api/test/{harness.ts, *.e2e-spec.ts}
```

Deleted:
- `packages/shared/src/constants.ts`
- `packages/shared/src/parsers/{offers,issuers,escrow,paychan}.parser.ts` (+ specs) and `parsing.service.ts`
- `apps/syncer/src/{sync,processor,xrpl}/*` and `app.service.ts`
- `apps/api/src/common/{problem-details.filter.ts,query.dto.ts,response.ts,enums.ts}`
- `apps/api/src/swagger-document.ts`: its swagger setup moves to toolbox `bootstrap()`
- `apps/*/test/clickhouse-container.ts`: replaced by the shared copy

---

## Phase 0–1: Foundations and schema

### Task 1: Network profiles and markets config

**Files:**
- Create: `packages/shared/src/network/network-profile.ts`, `packages/shared/src/network/index.ts`, `packages/shared/config/markets/xrpl.json`, `packages/shared/config/markets/xahau.json`
- Delete: `packages/shared/src/constants.ts` (remove its export from `src/index.ts`)
- Test: `packages/shared/src/network/network-profile.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type NetworkName = 'xrpl' | 'xahau';
  export interface MarketAsset { currency: string; issuer?: string }
  export interface MarketsConfig { version: number; tradeMarkets: { base: MarketAsset; counter: MarketAsset }[]; paymentCurrencies: MarketAsset[] }
  export interface NetworkProfile {
    name: NetworkName; networkId: number; nativeCurrency: 'XRP' | 'XAH'; defaultDatabase: string;
    partialPaymentFixLedger: number;   // xrpl 4594094, xahau 0
    definitionsFallback(): Record<string, unknown> | undefined; // xrpl: undefined (use codec DEFAULT_DEFINITIONS); xahau: bundled JSON (Task 4 records it)
  }
  export function getNetworkProfile(name?: string): NetworkProfile;            // default process.env.GH_NETWORK ?? 'xrpl'; unknown → throws `Unknown GH_NETWORK "<x>"`
  export function loadMarketsConfig(profile: NetworkProfile, path?: string): MarketsConfig; // path default process.env.GH_MARKETS_CONFIG ?? config/markets/<name>.json
  ```

**Markets config contents:**
- `xrpl.json`, version 1. Trade markets vs XRP:
  - `USD`, `EUR` @ `rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq` (GateHub)
  - `USD`, `BTC` @ `rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B` (Bitstamp)
  - `524C555344000000000000000000000000000000` @ `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` (RLUSD)
  - `paymentCurrencies` = the same assets.
- `xahau.json`: `{ "version": 1, "tradeMarkets": [], "paymentCurrencies": [] }`, populated in Task 38.

- [ ] **Step 1: Write failing tests**
  - `getNetworkProfile('xahau')` → `{ networkId: 21337, nativeCurrency: 'XAH', defaultDatabase: 'xahau', partialPaymentFixLedger: 0 }`.
  - Default with `GH_NETWORK` unset → `xrpl` / `networkId: 0` / `XRP` / `4594094`.
  - `getNetworkProfile('foo')` throws `Unknown GH_NETWORK "foo"`.
  - `loadMarketsConfig(xrpl).tradeMarkets.length === 5`.
  - The `GH_MARKETS_CONFIG` env path override is honoured.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- network-profile`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** `xahau` `definitionsFallback()` reads `src/network/definitions/xahau.json` if it exists, else returns `undefined`. Copy `config/` into the package `files` / build output: add `"files": ["dist", "config", "schema"]` and resolve paths via `join(__dirname, '..', '..', 'config', ...)`.
- [ ] **Step 4: Run** the same test command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 2: ClickHouse service, config, migrations and the shared test container

**Files:**
- Modify: `packages/shared/src/clickhouse/clickhouse.config.ts`, `clickhouse.service.ts`, `migrate.ts`
- Create: `packages/shared/test/clickhouse-container.ts` (moved from `apps/api/test/`); delete both app copies and update their imports. Add `packages/shared/jest.e2e.config.js` and the script `"test:e2e": "jest --config jest.e2e.config.js --runInBand"` (testRegex `test/.*\.e2e-spec\.ts$`, rootDir `.`).
- Test: `packages/shared/test/migrate.e2e-spec.ts`

**Interfaces:**
- Produces:
  ```ts
  clickHouseConfigFromEnv(env?: NodeJS.ProcessEnv, profile?: NetworkProfile): ClickHouseConfig  // database = GH_CLICKHOUSE_DATABASE ?? profile.defaultDatabase; validated /^[a-z_][a-z0-9_]*$/ else throws
  class ClickHouseService {
    query<T>(sql, params?, settings?: ClickHouseSettings): Promise<T[]>;
    queryOne<T>(sql, params?, settings?): Promise<T | undefined>;
    insert<T>(table: Table | string, rows: T[], opts?: { dedupToken?: string }): Promise<void>; // sets insert_deduplication_token when given
    command(sql: string, params?: Record<string, unknown>): Promise<void>;
    ping(); raw; onModuleDestroy();
  }
  runMigrations(opts?: { config?: ClickHouseConfig; log?: (m: string) => void }): Promise<{ applied: string[]; skipped: string[] }>
  startClickHouse(database?: string): Promise<{ container; url; database; config: ClickHouseConfig }>   // image from env CLICKHOUSE_IMAGE ?? 'clickhouse/clickhouse-server:<LTS>'
  ```
- Migrations:
  - Create the DB with a client bound to `database: 'default'`.
  - `schema_migrations(filename String, checksum String, applied_at DateTime DEFAULT now()) ENGINE=MergeTree ORDER BY filename`.
  - An applied file whose checksum (sha256) changed → throw `Migration <file> was modified after being applied`.
  - The client no longer sets the global `insert_deduplicate`/`async_insert` settings; dedup is per insert.

- [ ] **Step 1:** Pick the image. Check Docker Hub for the newest `clickhouse/clickhouse-server` LTS tag ≥ 25.8 that is at least two weeks old. Pin it as the default in `clickhouse-container.ts`, `docker-compose*.yaml` and the docs.
- [ ] **Step 2: Write the failing e2e test** (`migrate.e2e-spec.ts`). Use a container started **without** `CLICKHOUSE_DB`, then `runMigrations({config: {...config, database: 'xahau'}})`:
  - (a) `system.databases` contains `xahau`.
  - (b) A second run returns `applied: []`.
  - (c) Appending a comment to an applied file in a temp schema dir makes the run throw `was modified`. Make the schema dir injectable via `GH_SCHEMA_DIR` for this test.
  - (d) `insert(..., {dedupToken:'t1'})` twice yields one row on a table with `non_replicated_deduplication_window=100`.
  - (e) A partition-scoped lightweight delete works on the pinned version: `DELETE FROM t IN PARTITION 0 WHERE k > 5` leaves only rows ≤ 5.
- [ ] **Step 3: Run** `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate`. Expected: FAIL.
- [ ] **Step 4: Implement** the interfaces above.
- [ ] **Step 5: Run** the same command. Expected: PASS. If (e) fails on the pinned version, record the fallback (`ALTER TABLE … DELETE … IN PARTITION … SETTINGS mutations_sync=2`) in `ingest-state.ts`'s doc comment and use it in Task 11.
- [ ] **Step 6: Checkpoint.**

### Task 3: Baseline schema and row types

**Files:**
- Delete: `packages/shared/schema/001_tables.sql`, `002_materialized_views.sql`
- Create: `packages/shared/schema/001_baseline.sql`, `packages/shared/src/clickhouse/rows.ts`
- Modify: `packages/shared/src/clickhouse/tables.ts` (drop `View`; `Table` lists exactly the tables below)
- Test: extend `packages/shared/test/migrate.e2e-spec.ts`

**Conventions for every table below:**
- Engine is `ReplacingMergeTree`, except where noted.
- ORDER BY is shown as `[…]`.
- `P6` = `PARTITION BY intDiv(ledger_index, 1000000)`; `P7` = `PARTITION BY intDiv(ledger_index, 10000000)`.
- Every base and secondary table sets `SETTINGS non_replicated_deduplication_window = 1000`.
- `DateTime` columns are `DateTime('UTC')`.
- `LC` = `LowCardinality(String)`.
- `N(x)` = `Nullable(x)`.

| Table (`Table` enum key) | Partition | ORDER BY | Columns |
| --- | --- | --- | --- |
| `ledgers` (Ledgers) | P6 | `[ledger_index]` | ledger_index UInt32, ledger_hash String, parent_hash String, account_hash String, transaction_hash String, total_coins UInt64, close_time DateTime, parent_close_time DateTime, close_time_resolution UInt8, close_flags UInt8, tx_count UInt32, type_counts Map(LC,UInt32), result_counts Map(LC,UInt32), payments_count UInt32, exchanges_count UInt32, accounts_created UInt32, fee_total UInt64, fee_min UInt64, fee_max UInt64, parser_version UInt16, ingested_at DateTime DEFAULT now(); `INDEX close_time_mm close_time TYPE minmax GRANULARITY 1` |
| `ledger_by_hash` (LedgerByHash) | P7 | `[ledger_hash]` | ledger_hash String, ledger_index UInt32 |
| `transactions` (Transactions) | P6 | `[ledger_index, tx_index]` | ledger_index UInt32, tx_index UInt32, hash String, tx_type LC, result LC, account String, sequence UInt32, fee UInt64, close_time DateTime, tx_json String CODEC(ZSTD(3)), meta_json String CODEC(ZSTD(3)); extra setting `index_granularity = 1024` |
| `tx_by_hash` (TxByHash) | P7 | `[hash]` | hash String, ledger_index UInt32, tx_index UInt32 |
| `tx_by_type` (TxByType) | P7 | `[tx_type, ledger_index, tx_index]` | tx_type LC, ledger_index UInt32, tx_index UInt32, result LC |
| `account_transactions` (AccountTransactions) | P7 | `[account, ledger_index, tx_index]` | account String, ledger_index UInt32, tx_index UInt32, tx_type LC, result LC, is_initiator UInt8, close_time DateTime |
| `account_tx_by_sequence` (AccountTxBySequence) | P7 | `[account, sequence, ledger_index, tx_index]` | account String, sequence UInt32, ledger_index UInt32, tx_index UInt32 |
| `payments` (Payments) | P6 | `[ledger_index, tx_index]` | ledger_index UInt32, tx_index UInt32, tx_hash String, close_time DateTime, source String, destination String, currency LC, issuer String, amount String, delivered_amount String, delivered_amount_f Float64, max_amount N(String), source_currency LC, source_tag N(UInt32), destination_tag N(UInt32), invoice_id N(String), fee UInt64, source_balance_changes String, destination_balance_changes String, client N(String) |
| `payments_by_currency` (PaymentsByCurrency) | P7 | `[currency, issuer, ledger_index, tx_index]` | currency LC, issuer String, ledger_index UInt32, tx_index UInt32 |
| `account_payments` (AccountPayments) | P7 | `[account, ledger_index, tx_index]` | account String, ledger_index UInt32, tx_index UInt32, tx_hash String, close_time DateTime, direction Enum8('sent'=1,'received'=2), counterparty String, currency LC, issuer String, delivered_amount String, delivered_amount_f Float64, source_tag N(UInt32), destination_tag N(UInt32) |
| `exchanges` (Exchanges) | P7 | `[base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index]` | base_currency LC, base_issuer String, counter_currency LC, counter_issuer String, ledger_index UInt32, tx_index UInt32, node_index UInt16, tx_hash String, close_time DateTime, base_amount String, counter_amount String, base_amount_f Float64, counter_amount_f Float64, rate String, rate_f Float64, buyer String, seller String, taker String, provider String, offer_sequence UInt32, autobridged_currency N(String), autobridged_issuer N(String), tx_type LC, client N(String) |
| `account_exchanges` (AccountExchanges) | P7 | `[account, ledger_index, tx_index, node_index]` | `account String` + every `exchanges` column |
| `balance_changes` (BalanceChanges) | P7 | `[account, ledger_index, tx_index, node_index]` | account String, ledger_index UInt32, tx_index UInt32, node_index Int16 (fee row = -1), tx_hash String, close_time DateTime, currency LC, counterparty String, amount_change String, final_balance String, final_balance_f Float64, change_type LC, escrow_counterparty N(String), escrow_balance_change N(String), paychannel_counterparty N(String), paychannel_fund_change N(String), paychannel_fund_final_balance N(String), paychannel_final_balance N(String), paychannel_balance_change N(String), client N(String) |
| `accounts_created` (AccountsCreated) | none | `[ledger_index, tx_index, account]` | account String, parent String, initial_balance String, ledger_index UInt32, tx_index UInt32, tx_hash String, inception DateTime, genesis_balance N(String), genesis_index N(UInt32); `INDEX account_bf account TYPE bloom_filter GRANULARITY 1` |
| `fee_stats` (FeeStats) | `toYYYYMM(ts)` | `[ts]`, engine MergeTree | ts DateTime64(3,'UTC'), current_ledger_size UInt32, expected_ledger_size UInt32, current_queue_size UInt32, max_queue_size UInt32, pct_max_queue_size Float64, median_fee UInt64, minimum_fee UInt64, open_ledger_fee UInt64 |
| `validations` (Validations) | `toYYYYMMDD(last_datetime)`, `TTL toDateTime(last_datetime) + INTERVAL 90 DAY`, engine AggregatingMergeTree | `[ledger_hash, validation_public_key]` | ledger_hash String, validation_public_key String, count SimpleAggregateFunction(sum, UInt64), first_datetime SimpleAggregateFunction(min, DateTime64(3,'UTC')), last_datetime SimpleAggregateFunction(max, DateTime64(3,'UTC')), and `SimpleAggregateFunction(any, T)` for: ledger_index UInt32, reporter_public_key String, ephemeral_public_key String, signature String, signing_time UInt32, flags UInt32, full UInt8, amendments String, base_fee N(UInt64), load_fee N(UInt64), reserve_base N(UInt64), reserve_inc N(UInt64) |
| `validator_manifests` (ValidatorManifests) | none | `[ephemeral_key]`, version `seq` | ephemeral_key String, master_key String, seq UInt32 |
| `stats_hourly` (StatsHourly) | none | `[hour]`, version `version` | hour DateTime, transaction_count UInt64, payments_count UInt64, exchanges_count UInt64, accounts_created UInt64, ledger_count UInt64, first_close_time DateTime, last_close_time DateTime, type_counts Map(LC,UInt64), result_counts Map(LC,UInt64), version UInt64 |
| `volume_daily` (VolumeDaily) | `toYYYYMM(day)` | `[metric, day, component]`, version `version` | metric LC, day Date, component String, base_currency LC, base_issuer String, counter_currency LC, counter_issuer String, amount String, amount_f Float64, count UInt64, rate_f Float64, converted_f Float64, config_version UInt32, version UInt64 |
| `volume_live` (VolumeLive) | none | `[metric, period, component]`, version `version` | the `volume_daily` columns with `period LC, start_time DateTime, end_time DateTime` instead of `day` |
| `ingest_log` (IngestLog) | none | `[range_start, range_end]`, version `updated_at` | range_start UInt32, range_end UInt32, run_id String, status Enum8('started'=1,'done'=2), updated_at DateTime64(3) |
| `agg_dirty` (AggDirty) | none | `[from_hour, to_hour]`, version `created_at` | from_hour DateTime, to_hour DateTime, created_at DateTime64(3) |
| `syncer_lease` (SyncerLease) | none | `[network]`, version `heartbeat` | network String, holder String, heartbeat DateTime64(3) |

**Interfaces:**
- Produces: `rows.ts` exports one interface per table, named `<EnumKey>Row`. Fields match the columns exactly, in snake_case.
  - `UInt64` → `string | number`; `DateTime` → `number` (unix seconds; insert as an integer); `Map` → `Record<string, number>`; Nullable → `T | null`.
  - Example: `LedgersRow`, `PaymentsRow`, `ExchangesRow`, `AccountExchangesRow = ExchangesRow & { account: string }`.
- `export const PARSER_VERSION = 1;` lives in `rows.ts`.

- [ ] **Step 1: Write the failing e2e assertion.** After `runMigrations`, `SELECT name FROM system.tables WHERE database = {db:String}` equals `Object.values(Table)` plus `schema_migrations`. For each table, `SELECT * LIMIT 0` succeeds.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate`. Expected: FAIL.
- [ ] **Step 3: Write** `001_baseline.sql` (`CREATE TABLE IF NOT EXISTS` statements, one per table) and `rows.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Checkpoint.** The `pnpm build` failures in the apps are expected until Tasks 12/15. Run `pnpm --filter @gatehub/data-api-shared build && pnpm --filter @gatehub/data-api-shared test`.

---

## Phase 2: Pure, network-aware parsing

### Task 4: Fixtures, raw ledger normalisation and FixtureLedgerSource

**Files:**
- Create:
  - `packages/shared/test/fixtures/xrpl/ripple-mock/*.json`: copy all 54 files from `$REF/rhd-master/test/mock/ledgers/`, renaming `"<idx> - <label>.json"` → `<idx>-<label>.json`. Add a `README.md` with ISC attribution to ripple/rippled-historical-database.
  - `packages/shared/scripts/record-fixtures.ts`
  - `packages/shared/src/ingest/raw-ledger.ts`
  - `packages/shared/src/ingest/ledger-source.ts`
  - `packages/shared/src/ingest/fixture-ledger-source.ts`
  - `packages/shared/src/network/definitions/xahau.json`
- Test: `packages/shared/src/ingest/raw-ledger.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LedgerHeader { ledger_index: number; ledger_hash: string; parent_hash: string; account_hash: string; transaction_hash: string;
    total_coins: string; close_time: number /* unix s */; parent_close_time: number; close_time_resolution: number; close_flags: number }
  export interface RawTransaction { hash: string; tx: Record<string, unknown> /* no hash/metaData/meta */; meta: Record<string, unknown> }
  export interface RawLedger { header: LedgerHeader; transactions: RawTransaction[] /* sorted by meta.TransactionIndex */ }
  export function normalizeLedgerResponse(ledger: Record<string, unknown>): RawLedger;
  // accepts rippled v1 `ledger` result.ledger (and the Ripple mock format): string|number ledger_index, ripple-epoch close_time (+946684800),
  // `hash`|`ledger_hash`, `totalCoins`|`total_coins`, tx `metaData`|`meta`. Missing parent_close_time → 0. Returns deep-frozen output.
  export interface LedgerSource { validatedHead(): Promise<number>; fetch(index: number): Promise<RawLedger> }
  export class FixtureLedgerSource implements LedgerSource { constructor(ledgers: RawLedger[]); static fromDir(dir: string): FixtureLedgerSource /* .json and .json.gz */ ; list(): RawLedger[] }
  export class LedgerNotAvailableError extends Error {}   // fetch of unknown index
  ```
- `record-fixtures.ts` (run with `ts-node`):
  - Usage: `--network xrpl|xahau --endpoint <wss> [--ledgers a,b,c] [--want TypeA,TypeB --scan N] --out <dir>`.
  - Writes `<index>.json.gz` (raw `ledger` result with `transactions:true, expand:true`), plus `server_definitions.json` and `server_info.json`.
  - `--want` scans backwards from the validated head until each wanted TransactionType is seen once, or `--scan` ledgers have been checked.

- [ ] **Step 1: Write failing tests**
  - `normalizeLedgerResponse` on `ripple-mock/11118827.json` gives `header.ledger_index === 11118827` (a number), `close_time === 474571750 + 946684800`, and transactions sorted by `TransactionIndex` with `tx.hash` absent.
  - The output is frozen: `Object.isFrozen(result.transactions[0].meta)`.
  - `FixtureLedgerSource.fromDir(...).fetch(1)` rejects with `LedgerNotAvailableError`.
  - `validatedHead()` = max index.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- raw-ledger`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above and copy the mock ledgers.
- [ ] **Step 4: Run** the same test command. Expected: PASS.
- [ ] **Step 5: Record live fixtures**
  - **XRPL:** `--endpoint wss://xrplcluster.com --want AMMCreate,AMMDeposit,AMMWithdraw,NFTokenMint,NFTokenAcceptOffer,AccountDelete,CheckCash,TicketCreate,Clawback,EscrowFinish,PaymentChannelClaim --scan 3000 --out test/fixtures/xrpl/recorded`.
  - **Xahau:** `--endpoint wss://xahau.network --want Import,ClaimReward,SetHook,Invoke,URITokenMint,URITokenBuy,Remit,GenesisMint --scan 5000 --out test/fixtures/xahau/recorded`.
  - Copy `xahau/recorded/server_definitions.json` → `src/network/definitions/xahau.json`.
  - List the types not found in `fixtures/README.md`. That is not a failure.
  - Expected: `.json.gz` files are present. If an endpoint is unreachable, report BLOCKED with the error.
- [ ] **Step 6: Checkpoint.**

### Task 5: Payment parser (pure, ParseContext)

**Files:**
- Modify: `packages/shared/src/parsers/parser.interface.ts`, `payment.parser.ts`, `payment.parser.spec.ts`; `src/util/amount.ts`
- Reference: `$REF/rhd-develop/lib/ledgerParser/payment.js`

**Interfaces:**
- Produces:
  ```ts
  export interface ParseContext { nativeCurrency: string; networkId: number; partialPaymentFixLedger: number }
  export function parseContextFor(profile: NetworkProfile): ParseContext;
  export interface ParserTx { hash: string; ledger_index: number; close_time: number; tx_index: number;
                              tx: Readonly<Record<string, any>>; meta: Readonly<Record<string, any>>; client: string | null }
  export function toParserTx(raw: RawTransaction, header: LedgerHeader, client: string | null): ParserTx;
  export interface BalanceChangeAmount { counterparty: string; currency: string; value: string }   // counterparty '' for native
  export interface ParsedPayment { source; destination; currency; issuer?: string; amount: string; delivered_amount: string;
    max_amount?: string; source_currency: string; source_tag?: number; destination_tag?: number; invoice_id?: string;
    fee_drops: string; source_balance_changes: BalanceChangeAmount[]; destination_balance_changes: BalanceChangeAmount[] }
  export class PaymentParser { parse(t: ParserTx, ctx: ParseContext): ParsedPayment | undefined }
  export function dropsToNative(drops: string | number | BigNumber): string;   // util/amount.ts
  export function deliveredAmount(tx: Readonly<Record<string, any>>, meta: Readonly<Record<string, any>>, ledgerIndex: number, ctx: ParseContext): unknown | 'unavailable';
  // DeliveredAmount → delivered_amount → Amount if !tfPartialPayment(0x00020000) || ledgerIndex > ctx.partialPaymentFixLedger → 'unavailable'
  ```
- **Behavior:** match the reference.
  - Only `tesSUCCESS` Payments with `Account !== Destination` are parsed.
  - The source's native balance change excludes the fee.
  - `ripple-lib-transactionparser`'s `'XRP'` currency is remapped to `ctx.nativeCurrency`.
  - The issuer heuristic also considers RippleState `CreatedNode.NewFields`.
  - MPT amounts (`mpt_issuance_id`) → return `undefined`. They are not Ripple payments.

- [ ] **Step 1: Rewrite the spec** with these tests:
  - `fee is added back to the native source change`
  - `payment to self is ignored`
  - `Xahau native currency is XAH`: ctx `{nativeCurrency:'XAH'}` gives `currency === 'XAH'` and every balance-change currency is `'XAH'`
  - `delivered_amount uses DeliveredAmount for partial payments`
  - `does not mutate frozen input`: `deepFreeze(tx)` then parse does not throw
  - `issuer resolved from created trustline when destination is issuer`
  - Golden: parse every Payment in the `ripple-mock` fixtures. The count of defined results === **182**, matching `$REF/rhd-master/test/test.payments.js`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- payment.parser`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same test command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 6: Exchanges parser

**Files:**
- Modify: `packages/shared/src/parsers/exchanges.parser.ts`, `src/util/quality.ts`
- Create: `src/parsers/exchanges.parser.spec.ts`
- Reference: `$REF/rhd-develop/lib/ledgerParser/exchanges.js`, `quality.js`

**Interfaces:**
- Produces:
  ```ts
  export interface ParsedExchange { base_currency: string; base_issuer: string /* '' native */; counter_currency: string; counter_issuer: string;
    base_amount: string; counter_amount: string; rate: string /* full-precision BigNumber string, counter per base */;
    buyer: string; seller: string; taker: string; provider: string; offer_sequence: number; node_index: number;
    autobridged_currency?: string; autobridged_issuer?: string; tx_type: 'Payment' | 'OfferCreate' }
  export class ExchangeParser { parse(t: ParserTx, ctx: ParseContext): ParsedExchange[] }
  export function parseQuality(bookDirectory: string, paysIsNative: boolean, getsIsNative: boolean): BigNumber;
  export function canonicalPairKey(currency: string, issuer?: string): string;   // (currency + (issuer ?? 'undefined')).toLowerCase() — byte-identical to Ripple's ordering
  ```
- Canonical order: if `canonicalPairKey(counter) < canonicalPairKey(base)`, swap the sides and buyer/seller, and keep `rate`. Otherwise `rate = 1/rate`. This is the reference `orderPair`. `node_index` is the AffectedNodes index; it is never written back into the meta.

- [ ] **Step 1: Write failing tests**
  - `does not mutate frozen input`
  - `amounts are exact strings`: no precision loss for `"0.000001234567890123"`
  - `canonical ordering puts USD.rvYAf… before XRP`
  - `autobridged OfferCreate sets autobridged_currency`: pick the first autobridged tx found in `ripple-mock` (document its hash in the test)
  - `native code follows ctx` (XAH)
  - Golden: total exchanges across `ripple-mock` equals the count asserted in `$REF/rhd-master/test/test.exchanges.js` for the full set. If that test only asserts per pair, assert the per-pair counts it lists.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- exchanges.parser`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same test command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 7: Balance-changes, accounts-created and affected-accounts parsers; delete unused parsers

**Files:**
- Modify: `packages/shared/src/parsers/balance-changes.parser.ts` (+ spec), `accounts-created.parser.ts`, `affected-accounts.parser.ts`
- Delete: `offers.parser.ts`, `issuers.parser.ts`, `escrow.parser.ts` (+ spec), `paychan.parser.ts`, `parsing.service.ts`; update `src/index.ts`
- Reference: `$REF/rhd-develop/lib/ledgerParser/{balanceChanges,accountsCreated,affectedAccounts}.js`

**Interfaces:**
- Produces:
  ```ts
  export interface ParsedBalanceChange { account: string; counterparty: string /* '' native */; currency: string; amount_change: string; final_balance: string;
    node_index: number /* -1 fee row */; change_type: string /* '' when undefined */;
    escrow_counterparty?: string; escrow_balance_change?: string; paychannel_counterparty?: string; paychannel_fund_change?: string;
    paychannel_fund_final_balance?: string; paychannel_final_balance?: string; paychannel_balance_change?: string }
  export class BalanceChangesParser { parse(t: ParserTx, ctx: ParseContext): ParsedBalanceChange[] }
  export interface ParsedAccountCreated { account: string; parent: string; initial_balance: string }
  export class AccountsCreatedParser { parse(t: ParserTx, ctx: ParseContext): ParsedAccountCreated[] }   // tesSUCCESS, CreatedNode AccountRoot, skip AMMID
  export class AffectedAccountsParser { parse(t: ParserTx): string[] }   // unique r-addresses, any result
  ```
- **Behavior:**
  - The fee row has `change_type: 'transaction_cost'` and `node_index: -1`.
  - RippleState changes are produced for **all** transaction types (spec decision).
  - `change_type` follows the reference `findType` for Payment/OfferCreate; escrow_* and paychannel_* follow the reference.
  - Any other type → `''`.
  - Results: `tesSUCCESS` and `tec*` only.
  - On Xahau, AccountRoot deltas from ClaimReward/GenesisMint/Import are emitted with `change_type: ''`.

- [ ] **Step 1: Write failing tests**
  - Keep the two existing regressions; rename `type: 'fee'` to `change_type: 'transaction_cost'`.
  - `RippleState changes are emitted for non-Payment types`: synthetic CheckCash.
  - `escrow_create sets escrow_balance_change`: use `ripple-mock/29136413-escrow.json`.
  - `paychannel_payout`: use `29709909-paychan.json`.
  - `does not mutate frozen input`.
  - `accounts created in 1021029-accounts_created.json`: the count and the first account match `$REF/rhd-master/test/test.accounts.js`.
  - On Xahau recorded fixtures (if present): every `ClaimReward` tx yields a positive XAH `amount_change` for its Account.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- parser`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above and delete the unused parsers.
- [ ] **Step 4: Run** the same test command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 8: buildLedgerRows (all table rows and the ledger summary)

**Files:**
- Create: `packages/shared/src/ingest/build-rows.ts`, `build-rows.spec.ts`, `src/ingest/__snapshots__/`

**Interfaces:**
- Consumes: the Task 5–7 parsers, `FromClientParser` (unchanged except it takes `ParserTx`), `rows.ts`.
- Produces:
  ```ts
  export interface LedgerRows {
    ledger: LedgersRow; ledgerByHash: LedgerByHashRow;
    transactions: TransactionsRow[]; txByHash: TxByHashRow[]; txByType: TxByTypeRow[];
    accountTransactions: AccountTransactionsRow[]; accountTxBySequence: AccountTxBySequenceRow[];
    payments: PaymentsRow[]; paymentsByCurrency: PaymentsByCurrencyRow[]; accountPayments: AccountPaymentsRow[];
    exchanges: ExchangesRow[]; accountExchanges: AccountExchangesRow[];
    balanceChanges: BalanceChangesRow[]; accountsCreated: AccountsCreatedRow[] }
  export function buildLedgerRows(raw: RawLedger, ctx: ParseContext): LedgerRows;
  export const CHILD_TABLES: ReadonlyArray<[Table, keyof LedgerRows]>;   // every table except Ledgers and LedgerByHash
  ```
- **Mapping rules:**
  - `tx_json` = `JSON.stringify(raw.tx)` (without hash or meta); `meta_json` = `JSON.stringify(raw.meta)` (unaltered).
  - `account_transactions`: one row per affected account, with `is_initiator = account === tx.Account`.
  - `account_tx_by_sequence`: sender only, using `tx.Sequence` (keep `0` for ticketed transactions).
  - `account_payments`: a `sent` row for the source and a `received` row for the destination, with counterparty = the other party.
  - `account_exchanges`: a row for the buyer and a row for the seller; collapse to one row when buyer === seller.
  - Ledger summary:
    - `type_counts` / `result_counts` counted over all transactions.
    - `payments_count` = number of payments.
    - `exchanges_count` = number of exchanges.
    - `accounts_created` = number of created accounts.
    - Fees over all transactions' `Fee` (drops); `fee_min` = 0 when the ledger has no transactions. This is the reference `fees.js` semantics, kept in drops.
    - `parser_version = PARSER_VERSION`.

- [ ] **Step 1: Write failing tests**
  - **Snapshot:** `buildLedgerRows` for `ripple-mock/11118827.json` and one recorded Xahau ledger.
  - **Invariants over all fixtures:**
    - (a) Unique ORDER BY key within every table's rows.
    - (b) Every amount field parses as a finite BigNumber.
    - (c) For each tx and currency (IOU: account and counterparty pair), the sum of non-fee `amount_change` over both sides of each RippleState is 0.
    - (d) `ledger.tx_count === transactions.length`.
    - (e) Input deep-frozen.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- build-rows`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces and mapping rules above.
- [ ] **Step 4: Run** the same test command. Expected: PASS (snapshots written on first run; review them by eye against the reference objects in the spec).
- [ ] **Step 5: Checkpoint.**

---

## Phase 3: Crash-safe ingest

### Task 9: NodeClient supervisor

**Files:**
- Create: `packages/shared/src/xrpl/node-client.ts`, `node-client.spec.ts`
- Add `ws` + `@types/ws` as devDependencies of shared (for the mock server)

**Interfaces:**
- Produces:
  ```ts
  export interface NodeClientOptions { endpoints: string[]; connectionTimeoutMs?: number /* 20000 */; requestTimeoutMs?: number /* 30000 */;
    watchdogIntervalMs?: number /* 5000 */; silenceTimeoutMs?: number /* 30000, 0 = off */; logger?: { log(m: string): void; warn(m: string): void; error(m: string, e?: unknown): void } }
  export class NodeClient extends EventEmitter {   // events: 'connected'(endpoint), 'disconnected'(endpoint), 'ledgerClosed'(msg), 'validationReceived'(msg), 'manifestReceived'(msg)
    constructor(opts: NodeClientOptions);
    start(): Promise<void>;                 // resolves after first successful connect; keeps trying endpoints round-robin with capped backoff (1s→30s)
    stop(): Promise<void>;
    subscribe(streams: string[]): Promise<void>;   // remembered; re-sent after every (re)connect
    request<T = any>(req: Record<string, unknown>, opts?: { timeoutMs?: number; retries?: number /* 3 */ }): Promise<T>; // returns `result`; on disconnect/timeout fails over and retries
    get currentEndpoint(): string | undefined;
    serverInfo(): Promise<{ network_id?: number; complete_ledgers: string; pubkey_node?: string; validated_ledger?: { seq: number } }>;
  }
  export function assertNetwork(info: { network_id?: number }, profile: NetworkProfile): void; // xrpl: network_id undefined|0; xahau: 21337|21338 → else throw `Node network_id <x> does not match GH_NETWORK=<name>`
  ```
- Built on `xrpl.Client` (one live instance at a time; listeners are attached once per instance). The watchdog replaces the instance when `!isConnected()`, or when subscribed streams have been silent for longer than `silenceTimeoutMs`.

- [ ] **Step 1: Write failing tests** against an in-process `ws` mock server that answers `server_info`, `subscribe`, `ping` and emits `ledgerClosed`:
  - `re-subscribes after the server drops the socket (1006)`
  - `recovers when the first reconnect attempt is refused` (server down for 2 s, then up)
  - `fails over to the second endpoint`
  - `request times out and retries on another connection`
  - `assertNetwork rejects xahau node for xrpl profile`
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test -- node-client`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same test command. Expected: PASS, finishing in < 20 s.
- [ ] **Step 5: Checkpoint.**

### Task 10: RpcLedgerSource

**Files:**
- Create: `apps/syncer/src/ingest/rpc-ledger-source.ts`, `rpc-ledger-source.spec.ts`

**Interfaces:**
- Consumes: `NodeClient` (Task 9), `LedgerSource` and `normalizeLedgerResponse` (Task 4)
- Produces:
  ```ts
  export class LedgerNotValidatedError extends Error {}
  export class RpcLedgerSource implements LedgerSource {
    constructor(client: NodeClient, opts: { fetchTimeoutMs: number /* GH_LEDGER_FETCH_TIMEOUT_MS, default 120000 */ });
    validatedHead(): Promise<number>;      // `ledger` {ledger_index:'validated'} → ledger_index
    fetch(index: number): Promise<RawLedger>;   // `ledger` {ledger_index:index, transactions:true, expand:true}; validated !== true → LedgerNotValidatedError; error lgrNotFound → LedgerNotAvailableError
  }
  ```

- [ ] **Step 1: Write failing tests** with a stub `NodeClient`:
  - `passes fetchTimeoutMs to request`
  - `rejects unvalidated ledger`
  - `maps lgrNotFound to LedgerNotAvailableError`
  - `normalizes response` (stub returns the `ripple-mock/11118827.json` content)
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-syncer test -- rpc-ledger-source`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same test command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 11: LedgerWriter and ingest state helpers

**Files:**
- Create: `packages/shared/src/ingest/ledger-writer.ts`, `packages/shared/src/ingest/ingest-state.ts`, `packages/shared/test/ledger-writer.e2e-spec.ts`

**Interfaces:**
- Consumes: `buildLedgerRows`, `CHILD_TABLES`, `ClickHouseService.insert(..., {dedupToken})`
- Produces:
  ```ts
  export class LedgerWriter {
    constructor(ch: ClickHouseService, ctx: ParseContext, opts?: { runId?: string /* default randomUUID() */; maxRowsPerInsert?: number /* 50000 */ });
    write(ledgers: RawLedger[]): Promise<void>;
    // 1) build rows; 2) insert every CHILD_TABLE in parallel, chunked, token `${runId}:${table}:${first}-${last}:${chunkNo}`;
    // 3) insert ledger_by_hash; 4) insert ledgers (single INSERT = commit). Throws on any failure (caller decides recovery).
  }
  export async function committedCheckpoint(ch: ClickHouseService): Promise<number | undefined>;          // max(ledger_index) FROM ledgers, undefined if empty
  export async function storedLedgerHash(ch: ClickHouseService, index: number): Promise<string | undefined>;
  export async function deleteLedgersAbove(ch: ClickHouseService, checkpoint: number): Promise<void>;     // partition-scoped lightweight DELETE on every ledger-keyed table (all except fee_stats/validations/validator_manifests/stats_hourly/volume_*/ingest_log/agg_dirty/syncer_lease); ledger_by_hash/tx_by_hash use WHERE ledger_index > cp
  export async function deleteLedgerRange(ch: ClickHouseService, from: number, to: number): Promise<void>;
  export async function missingLedgers(ch: ClickHouseService, from: number, to: number): Promise<number[]>;  // ledgers absent from `ledgers` in [from,to]
  ```

- [ ] **Step 1: Write failing e2e tests** (testcontainers + `runMigrations`, seeded from `FixtureLedgerSource.fromDir(ripple-mock)`):
  - `writes all fixtures and commit counts match`: `count() FROM ledgers = 54`, and `count() FROM payments = 182`.
  - `re-writing the same ledgers with a new runId leaves count() == uniqExact(key)` after `OPTIMIZE … FINAL`, and **before** OPTIMIZE `SELECT count() FROM payments` = 364. This documents why recovery must delete, not rely on dedup.
  - `same runId retry is deduplicated`: write twice with the same runId; count stays 182 without OPTIMIZE.
  - `deleteLedgersAbove removes child rows of uncommitted ledgers`: simulate by inserting child rows for ledger X without its `ledgers` row, then `deleteLedgersAbove(cp)`; every table has 0 rows with `ledger_index > cp`.
  - `chunks inserts above maxRowsPerInsert`: `maxRowsPerInsert: 100`; spy on `insert` shows multiple calls for `transactions`.
  - `missingLedgers` finds the gaps in a sparse set.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test:e2e -- ledger-writer`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 12: Syncer app on toolbox (bootstrap, config, logger, workers, health)

**Files:**
- Rewrite: `apps/syncer/src/main.ts`, `app.module.ts`, `config/syncer.config.ts`; delete `config/config.module.ts`, `app.service.ts`, `sync/`, `processor/`, `xrpl/`, `test/processor.e2e-spec.ts`
- Modify: `apps/syncer/src/modules/liveliness/*` (adds a lag check), `modules/prometheus/*` (new gauges), `.env.example`, `test/` (uses the shared container)

**Interfaces:**
- Produces:
  ```ts
  export class SyncerConfig {        // GateHubConfigModule.forFeature(SyncerConfig); @ConfigValue() → GH_<SNAKE>
    network: string /* GH_NETWORK */; nodeEndpoints: string /* comma list */; validationEndpoints: string /* comma list, default = nodeEndpoints */;
    workers: string /* 'ingest,validations,fee_stats,aggregator' */; syncStartLedger?: number; ledgerFetchTimeoutMs = 120000;
    catchupConcurrency = 8; catchupFlushLedgers = 300; catchupFlushTxs = 100000; catchupFlushMs = 5000;
    runMigrationsOnBoot = false; httpApiPort = 3002; metriczPort = 3000; maxLagHealthy = 10;
  }
  export const NODE_CLIENT = Symbol('NODE_CLIENT');      // provider: NodeClient started in onModuleInit, assertNetwork() on boot
  export const NETWORK_PROFILE = Symbol('NETWORK_PROFILE');
  export const PARSE_CONTEXT = Symbol('PARSE_CONTEXT');
  export function enabledWorkers(cfg: SyncerConfig): Set<'ingest' | 'validations' | 'fee_stats' | 'aggregator'>;
  ```
- `main.ts`: `bootstrap(AppModule, { port: cfg.httpApiPort, swaggerDocs: { disabled: true }, versioning: { disabled: true }, metricz: { module: PrometheusModule, port: cfg.metriczPort } })`.
- `AppModule` imports `ClickHouseModule.forRoot(clickHouseConfigFromEnv(process.env, profile))` and only the worker modules that are enabled. Gauges: `syncer_checkpoint_ledger`, `syncer_head_ledger`, `syncer_lag_ledgers`, `syncer_last_commit_timestamp_seconds`, `syncer_validations_flushed_total`, `syncer_fee_stats_samples_total`, `syncer_aggregator_runs_total{job}`.
- Liveliness reports 503 when the ClickHouse ping fails, or when the ingest worker is enabled and lag > `maxLagHealthy` for more than 60 s.

- [ ] **Step 1: Write failing tests** (`config/syncer.config.spec.ts`):
  - `enabledWorkers parses list and rejects unknown names` (throws `Unknown worker "x"`).
  - The app module compiles with `workers=''`: `Test.createTestingModule({imports:[AppModule]})` with the ClickHouse and NodeClient providers overridden.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-syncer test`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** `pnpm --filter @gatehub/data-syncer test && pnpm --filter @gatehub/data-syncer build`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 13: LiveRunner

**Files:**
- Create: `apps/syncer/src/ingest/live-runner.ts`, `ingest.module.ts`, `apps/syncer/test/live-runner.e2e-spec.ts`

**Interfaces:**
- Consumes: `LedgerSource`, `LedgerWriter`, `committedCheckpoint`, `storedLedgerHash`, `deleteLedgersAbove`, `NodeClient` events
- Produces:
  ```ts
  export class ChainBreakError extends Error {}   // parent_hash mismatch → runner halts (status 'halted'), liveliness 503
  export interface RunnerStatus { state: 'starting' | 'catching_up' | 'live' | 'halted'; checkpoint?: number; head?: number; lag?: number; lastCommitAt?: number }
  @Injectable() export class LiveRunner implements OnApplicationBootstrap, OnModuleDestroy {
    constructor(source: LedgerSource, writer: LedgerWriter, ch: ClickHouseService, headHints: EventEmitter /* NodeClient */, cfg: SyncerConfig);
    status(): RunnerStatus;
    runOnce(): Promise<void>;   // test hook: catch up to current head then return
  }
  ```
- **Algorithm:**
  - **Boot:**
    - Lease: read `syncer_lease` for the network. If another `holder` has a heartbeat < 30 s old, throw `Another syncer holds the lease (<holder>)`. Otherwise write a heartbeat every 10 s with `holder = hostname:pid:runId`.
    - `cp = committedCheckpoint()`.
    - If `cp` is defined: verify `storedLedgerHash(cp) === (await source.fetch(cp)).header.ledger_hash`, else throw `ChainBreakError`. Then `deleteLedgersAbove(cp)` and `next = cp + 1`.
    - Otherwise `next = cfg.syncStartLedger ?? await source.validatedHead()`.
  - **Loop:**
    - `head` = max(the last `ledgerClosed.ledger_index` hint, a poll of `validatedHead()` whenever there has been no hint for more than 15 s).
    - While `next <= head`: fetch up to `catchupConcurrency` ledgers in flight, reorder, and pass to the writer only a contiguous prefix whose `parent_hash` equals the previous ledger's hash. Flush when any of the `catchupFlush*` thresholds is reached, or when lag ≤ 1 (then flush one ledger at a time).
    - Fetch errors (`LedgerNotValidatedError`, `LedgerNotAvailableError`, timeouts): retry the same index with capped backoff (500 ms → 30 s). Never skip.
    - Writer error: re-read the checkpoint, `deleteLedgersAbove`, rebuild the pipeline from `checkpoint + 1`, and use a new `runId`.

- [ ] **Step 1: Write failing e2e tests** (ClickHouse container + `FixtureLedgerSource` built from a **contiguous** synthetic chain of 30 ledgers generated in the test from one recorded ledger by rewriting `ledger_index`, `ledger_hash` and `parent_hash`):
  - `catches up from syncStartLedger to head and stops at lag 0`: `ledgers` holds 30 contiguous rows.
  - `fills a gap when hints jump 10 → 13`
  - `retries unvalidated ledger until validated`: the source throws `LedgerNotValidatedError` twice for index 5.
  - `writer failure mid-batch is recovered`: wrap the writer so the 2nd `write()` throws after child inserts; after `runOnce()`, `count() == uniqExact` for `transactions` and there are no gaps.
  - `restart after crash cleans the uncommitted tail`: insert orphan child rows above `cp`, construct a new runner, call `runOnce()`, and there are no orphans and no duplicates.
  - `parent_hash mismatch halts`: `status().state === 'halted'`.
  - `refuses to start while another holder's lease is fresh`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-syncer test:e2e -- live-runner`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces and algorithm above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 14: Range ingest CLI

**Files:**
- Create: `apps/syncer/src/cli/range-ingest.ts`, `apps/syncer/test/range-ingest.e2e-spec.ts`; add the script `"ingest:range": "node dist/cli/range-ingest.js"`

**Interfaces:**
- Produces:
  ```ts
  export interface RangeIngestOptions { from: number; to: number; indexes?: number[]; chunkSize?: number /* 1000, aligned to multiples */; concurrency?: number /* 8 */; reprocess?: boolean; runId?: string }
  export async function rangeIngest(source: LedgerSource, ch: ClickHouseService, ctx: ParseContext, opts: RangeIngestOptions): Promise<{ chunksDone: number; ledgers: number }>;
  // per chunk: ingest_log 'started' → (reprocess || unfinished intent) ? deleteLedgerRange : skip ledgers already committed → write → ingest_log 'done'.
  // overlapping committed ledgers without --reprocess are skipped (not rewritten). On finish: insert agg_dirty(from_hour,to_hour) covering the range.
  ```
- CLI flags: `--from --to --chunk --concurrency --reprocess`. It uses the same config/env as the syncer (`GH_NETWORK`, ClickHouse, `GH_NODE_ENDPOINTS`).

- [ ] **Step 1: Write failing e2e tests:**
  - `ingests an explicit index list`: `rangeIngest(..., { from, to, indexes: fixtureIndexes })` writes exactly the 54 ripple-mock ledgers. When `indexes` is given, only those ledgers inside `[from, to]` are fetched; `LedgerNotAvailableError` is never swallowed.
  - `redo of a 'started' intent deletes and rewrites the chunk`
  - `reprocess rewrites without duplicates`
  - `writes agg_dirty`
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-syncer test:e2e -- range-ingest`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

---

## Phase 4: API contract layer

### Task 15: API bootstrap on toolbox, Ripple errors, auth, 404, throttling

**Files:**
- Rewrite: `apps/api/src/main.ts`, `app.module.ts`, `config/api.config.ts`
- Create: `apps/api/src/common/{errors.ts, ripple-error.filter.ts, ripple-controller.ts, not-found.controller.ts, common.module.ts}`
- Delete: `common/problem-details.filter.ts`, `common/query.dto.ts`, `common/response.ts`, `common/enums.ts`, `swagger-document.ts`, `swagger.ts`. Keep `common/cache.service.ts` and `common/metrics.interceptor.ts`. Delete the old feature directories `apps/api/src/{ledgers,transactions,payments,exchanges,stats,network,accounts}/` and `test/api.e2e-spec.ts`; they depend on deleted files, and each Phase 5–8 task recreates its module and registers it in `AppModule`.
- Modify: `auth/api-key.guard.ts` (reads `ApiConfig`)
- Test: `apps/api/test/errors.e2e-spec.ts`; `apps/api/test/global-setup.ts` + `harness.ts` (minimal here, extended in Task 18)

**Interfaces:**
- Produces:
  ```ts
  export class ApiConfig { network = 'xrpl'; nodeEndpoints = 'wss://xrplcluster.com'; apiKeys = ''; httpApiPort = 3001; metriczPort = 3000;
    corsOrigins = ''; rateLimit = 600; rateLimitWindow = 60; liveCacheTtlMs = 10000; trustProxyHops = 1; cacheControl = 'public, max-age=60'; }
  export function apiKeysOf(cfg: ApiConfig): string[];          // throws 'GH_API_KEYS must be set in production' when NODE_ENV=production and empty
  export class RippleHttpError extends HttpException { constructor(status: number, message: string) }
  export const badRequest: (message: string) => RippleHttpError; export const notFound: (message: string) => RippleHttpError;
  export function RippleController(...paths: string[]): ClassDecorator;     // Controller(paths) + UseFilters(RippleErrorFilter) + ApiTags
  export function RippleRoute(failureMessage: string): MethodDecorator;     // non-HttpException errors → 500 {result:'error', message: failureMessage}; logs the cause
  @Catch() export class RippleErrorFilter implements ExceptionFilter;       // RippleHttpError/HttpException 4xx → {result:'error', message}; 401 → message 'Missing or invalid API key.'; 429 → {error:`Rate limit exceeded, retry in ${s}sec`}; else 500 {result:'error', message:'internal error'}
  // NotFoundController: @RippleController('v2') @All('*') → 404 {result:'error', message:`Cannot ${method} ${originalUrl}`}
  ```
- `main.ts`: `bootstrap(AppModule, { port, disableValidationPipe: true, versioning: { disabled: true }, swaggerDocs: { docsPath: 'internal/docs' }, metricz: { module: PrometheusModule, port: metriczPort } })`.
- `AppModule implements NestModule`:
  - `configure()` applies `compression()`, `cors({origin})` (only if `corsOrigins` is set) and a `Cache-Control` header middleware for `/v2/*`.
  - `onModuleInit` sets `trust proxy` via `HttpAdapterHost`.
  - Global guards: `ApiKeyGuard`, `ThrottlerGuard`.
  - Global interceptor: `MetricsInterceptor`.
  - `/liveliness/*` is unversioned and open.
- Add dependencies: `compression`, `cors` (+ types).

- [ ] **Step 1: Write failing e2e tests:**
  - `401 without key → {result:'error', message:'Missing or invalid API key.'}`
  - `unknown /v2 route → 404 Cannot GET /v2/nope`
  - `route throwing plain Error → 500 with RippleRoute message` (a test-only controller registered in the harness)
  - `429 body and Retry-After` (`GH_RATE_LIMIT=2`)
  - `healthz open without key`
  - `apiKeysOf throws in production when empty`
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-service test:e2e -- errors`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same command. Expected: PASS. Also run `pnpm --filter @gatehub/data-api-service build`. Expected: OK.
- [ ] **Step 5: Checkpoint.**

### Task 16: Ripple parameter parsing

**Files:**
- Create: `apps/api/src/common/params.ts`, `params.spec.ts`; `packages/shared/src/query/asset.ts` (+ spec); `apps/api/src/common/asset-param.ts` (+ spec)
- Reference: `$REF/rhd-master/api/routes/*` (param handling at the top of each route), `$REF/rhd-master/lib/smoment.js`

**Interfaces:**
- Produces:
  ```ts
  // params.ts
  export type Query = Record<string, unknown>;
  export function first(q: Query, name: string): string | undefined;                 // arrays → first element
  export function bool(q: Query, name: string): boolean;                             // /true/i
  export function strictFlag(q: Query): boolean;                                     // 'strict': false only on /false/i
  export function anyFlag(q: Query, name: string): boolean;                          // non-empty → true
  export function limitParam(q: Query, o: { def: number; max: number; nanError?: string; allowAll?: boolean }): number; // NaN → def (or 400 nanError); > max → max; 'all' → max when allowAll
  export type Granularity = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'ms';
  export interface ParsedDate { date: Date; granularity: Granularity }
  export function parseDate(raw: string): ParsedDate | undefined;                    // formats listed in Global Constraints/spec; 10-digit unix seconds = 'second'
  export function dateParam(q: Query, name: string, error: string): ParsedDate | undefined;   // invalid → badRequest(error)
  export function endExclusive(p: ParsedDate): Date;                                 // add one unit of granularity
  export function uintParam(q: Query, name: string, error: string): number | undefined;
  // shared/src/query/asset.ts
  export interface Asset { currency: string; issuer?: string }
  export function assetKey(a: Asset): string;                                        // `${currency}` or `${currency}.${issuer}`
  export function canonicalPair(base: Asset, counter: Asset): { base: Asset; counter: Asset; inverted: boolean };   // uses canonicalPairKey (Task 6)
  // asset-param.ts
  export function parseAsset(raw: string, native: string, role?: 'base' | 'counter'): Asset; // split on + | .; currency upper-cased; errors: `${native} cannot have an issuer`, `${role} issuer is required` | `issuer is required`, `invalid ${role ?? ''} issuer address`
  export function assetFromParts(currency: string | undefined, issuer: string | undefined, native: string, defaultNative = true): Asset;
  ```

- [ ] **Step 1: Write failing table-driven tests:**
  - `parseDate` accepts each of: `2015`, `2015-01`, `2015-01-14`, `2015-01-14T18`, `2015-01-14T18:28`, `2015-01-14T18:28:40`, `2015-01-14T18:28:40Z`, `2015-01-14T18:28:40.123Z`, `20150114182840`, `20150114182840123`, `1421260120`. For each, assert the expected granularity.
  - It rejects `2015-13-01` and `yesterday`.
  - `endExclusive({2015-08-31, day}) = 2015-09-01T00:00:00Z`.
  - `bool('TRUE')` → true; `bool('1')` → false; `strictFlag('no')` → true; `anyFlag('0')` → true.
  - `limitParam`: `'abc'` → default; `5000` with max 1000 → 1000; `'all'` with `allowAll` → max.
  - `parseAsset`:
    - `'usd+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B'` → USD.
    - `'XRP+rX'` → `XRP cannot have an issuer`.
    - `'USD'` → `base issuer is required` with role base.
    - With native `XAH`: `'XRP'` → `issuer is required` and `'XAH'` → native.
    - The 40-hex code is upper-cased; the issuer case is preserved.
  - `canonicalPair(XRP, USD.rvYAf…)` → `inverted: true`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-service test -- params asset-param && pnpm --filter @gatehub/data-api-shared test -- asset`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 17: Pagination markers, formatting, CSV

**Files:**
- Rewrite: `apps/api/src/common/pagination.ts` (+ spec)
- Create: `apps/api/src/common/format.ts` (+ spec), `common/csv.interceptor.ts` (+ spec)
- Add dependency `nice-json2csv` at the version in `$REF/rhd-master/package.json` (the library Ripple used, for exact CSV parity)

**Interfaces:**
- Produces:
  ```ts
  // pagination.ts
  export type KeyType = 'UInt32' | 'UInt16' | 'Int16' | 'UInt64' | 'String' | 'DateTime';
  export interface KeysetKey { column: string; type: KeyType }
  export function encodeMarker(values: (string | number)[]): string;                                   // base64url(JSON)
  export function decodeMarker(marker: string | undefined, keys: KeysetKey[]): (string | number)[] | undefined; // wrong arity/type/garbage → badRequest('invalid marker')
  export function keysetClause(keys: KeysetKey[], descending: boolean, values?: (string | number)[], prefix?: string): { clause: string; params: Record<string, unknown> };
  export function orderByClause(keys: KeysetKey[], descending: boolean): string;
  export function paginate<T>(rows: T[], limit: number, keyOf: (row: T) => (string | number)[]): { rows: T[]; marker?: string }; // rows were fetched with LIMIT limit+1; marker encodes key of LAST RETURNED row
  export function setLinkHeader(req: Request, res: Response, marker?: string): void;                 // Link: <full original url with marker replaced>; rel="next"
  // format.ts
  export function fmtTime(t: number | Date): string;           // YYYY-MM-DDTHH:mm:ssZ
  export function fmtTxDate(t: number): string;                // YYYY-MM-DDTHH:mm:ss+00:00
  export function fmtCloseTimeHuman(t: number): string;        // YYYY-MMM-DD HH:mm:ss (Jan..Dec)
  export function fmtMillis(t: number | Date): string;         // YYYY-MM-DDTHH:mm:ss.SSSZ
  export function precision8(v: BigNumber.Value): string;      // new BigNumber(v).toPrecision(8)
  export function compact<T extends object>(o: T): T;          // drops undefined (not null)
  // csv.interceptor.ts
  export function Csv(filename: string, rowsKey: string): MethodDecorator; // if first(query,'format') === 'csv': body[rowsKey] → nice-json2csv → text/csv; Content-Disposition attachment; filename=<filename>.csv
  ```

- [ ] **Step 1: Write failing tests:**
  - `decodeMarker` throws `invalid marker` for `'@@@'`, for a marker with the wrong arity, and for a string value in a `UInt32` slot.
  - `paginate` with `limit + 1` rows returns `limit` rows and a marker; with exactly `limit` rows it returns no marker.
  - `setLinkHeader` replaces an existing `marker` param.
  - `fmtCloseTimeHuman(1421256550)` → `2015-Jan-14 17:29:10`.
  - `fmtTxDate` ends with `+00:00`.
  - `precision8('0.004')` → `0.0040000000`.
  - CSV of `[{a:{b:1}, c:[{d:2}]}]` matches the `nice-json2csv` output (headers `a.b`, `c[0].d`).
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-service test -- pagination format csv`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 18: Ledger range resolver, transaction objects, binary codec, live node service, test harness

**Files:**
- Create: `apps/api/src/common/{ledger-range.service.ts, tx-object.ts, binary-codec.service.ts}` (+ specs)
- Rewrite: `apps/api/src/xrpl/xrpl.service.ts`, `xrpl.module.ts`
- Extend: `apps/api/test/harness.ts`, `apps/api/test/global-setup.ts`, `test/jest-e2e.json` (`globalSetup`/`globalTeardown`)

**Interfaces:**
- Produces:
  ```ts
  @Injectable() export class LedgerRangeResolver {
    resolve(start?: Date, endExclusive?: Date): Promise<{ min: number; max: number } | null>;   // first ledger with close_time >= start, last with close_time < endExclusive; null if none/empty
    ledgerAtOrBefore(date: Date): Promise<number | undefined>;
    latest(): Promise<number | undefined>;
  }  // LRU cache (10k entries) for resolutions whose bound is older than 1 hour
  export interface TxObject { hash: string; ledger_index: number; date: string; ledger_hash?: string; tx: object | string; meta: object | string }
  @Injectable() export class TxService {
    fetchByKeys(keys: { ledger_index: number; tx_index: number }[]): Promise<TransactionsRow[]>;   // one query, results in input order
    ledgerHashes(indexes: number[]): Promise<Map<number, string>>;
    toTxObject(row: TransactionsRow, o: { binary: boolean; ledgerHash?: string }): TxObject;       // injects meta.delivered_amount via deliveredAmount() for successful Payments (JSON mode only)
  }
  @Injectable() export class BinaryCodecService { onModuleInit(): Promise<void>; encode(json: object): string }  // XrplDefinitions(server_definitions) else profile.definitionsFallback() else DEFAULT_DEFINITIONS
  @Injectable() export class XrplService { request<T = any>(req: Record<string, unknown>): Promise<T> }   // NodeClient over cfg.nodeEndpoints, lazy start
  // test/harness.ts
  export interface Harness { app: INestApplication; http(): import('supertest').SuperTest<import('supertest').Test>; ch: ClickHouseService; key: string; close(): Promise<void> }
  export async function startHarness(o?: { network?: NetworkName; seed?: 'ripple-mock' | 'xahau-recorded' | 'none'; xrplStub?: (req: any) => any }): Promise<Harness>;
  // fresh random database per call, runMigrations, seed through LedgerWriter (FixtureLedgerSource), XrplService overridden by stub, GH_API_KEYS=test-key
  ```

- [ ] **Step 1: Write failing tests:**
  - `resolve` returns `null` on an empty DB.
  - The `ripple-mock` 2015-01-14 window resolves to the min/max of the mock ledgers on that day.
  - `ledgerAtOrBefore(1 second before ledger X close)` → X−1 (or the previous mock ledger).
  - `toTxObject` injects `delivered_amount` for Payment and omits it for OfferCreate.
  - Binary round trip: `decode(encode(tx_json))` deep-equals `tx_json`, and the hash of the encoded tx equals the stored `hash`. Use the `ripple-mock` Payment and one recorded Xahau tx with the xahau fallback definitions.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-service test -- ledger-range tx-object binary-codec` (the resolver tests run as e2e via the harness). Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

---

## Phase 5: Core endpoints

Every endpoint task follows the same pattern:
- **Files:** `apps/api/src/<module>/<module>.{module,controller,service}.ts` (rewrite or create), re-registered in `AppModule`, and `apps/api/test/<module>.e2e-spec.ts`.
- **Contract:** the spec's Endpoint table row plus the named `$REF` route file.
- **Parity tests:** port every assertion in the named `$REF/rhd-master/test/test.*.js` file whose expectation depends only on the mock ledgers. Translate each `it(...)` to a jest `it` with the same title, and seed with `startHarness({seed:'ripple-mock'})`. List any skipped `it`s at the top of the spec with a one-line reason (e.g. "depends on HBase-only aggregate").
- **Shared tests:** every list endpoint also gets:
  - `empty range → count 0`: a `start`/`end` window in 2030.
  - `marker pages concatenate to unpaged list`: `limit=3` until no marker; compare against `limit=max`.
  - `descending reverses order`.
  - `unknown params ignored`: `?foo=bar` → 200.
  - `format=csv` → `text/csv`, where CSV applies.
- **Step skeleton:**
  - (1) Write the e2e spec.
  - (2) Run `pnpm --filter @gatehub/data-api-service test:e2e -- <module>`. Expected: FAIL.
  - (3) Implement.
  - (4) Run the same command. Expected: PASS.
  - (5) Checkpoint.

### Task 19: Ledgers and last_validated
- **Routes:** `GET /v2/ledgers`, `/v2/ledgers/:ledger_param` (plus query `ledger_index`/`ledger_hash`/`date`), and `GET /v2/last_validated`.
- **Reference:** `getLedger.js`, `getLastValidated.js`. **Parity source:** `test.ledgers.js`.
- **Interfaces produced:** `LedgersService.getLedger(id: { index?: number; hash?: string; date?: Date }, o: { transactions: boolean; expand: boolean; binary: boolean }): Promise<object | undefined>`.
- **Extra tests:**
  - `binary wins over expand`.
  - `2015 is treated as a ledger index`.
  - `odd-length hex → 400 invalid ledger identifier`.
  - `missing → 404 ledger not found`.

### Task 20: Transactions
- **Routes:** `GET /v2/transactions/:tx_hash`, `GET /v2/transactions`.
- **Reference:** `getTransactions.js`. **Parity source:** `test.transactions.js`.
- **Behavior:**
  - The list reads `tx_by_type` when `type` is given; otherwise it reads `transactions` within the resolved ledger range (`result` is a column filter).
  - Each item includes `ledger_hash` (from `TxService.ledgerHashes`).
  - Defaults: `limit` 20, max 100.
- `type` / `result` are validated against the network's known values:
  - types: the keys of `TRANSACTION_TYPES` in `BinaryCodecService`'s definitions
  - results: `TRANSACTION_RESULTS`
  - error messages: `invalid transaction type` / `invalid transaction result`
- **Extra tests:**
  - `hash is upper-cased`.
  - `binary=true returns hex tx and meta`.
  - `type=Payment uses tx_by_type` (spy on the SQL or check the result count equals the 188 Payments in the fixtures).

### Task 21: Payments
- **Routes:** `GET /v2/payments`, `/v2/payments/:currency`.
- **Reference:** `getPayments.js`. **Parity source:** `test.payments.js` (182 payments overall, 37 in the 18:28:40–18:51:40 window).
- **Behavior:**
  - For a currency path: page over `payments_by_currency` keyed by `(ledger_index, tx_index)` and join the full rows from `payments` (`IN` subquery).
  - Response fields: `{result, currency?, issuer?, count, marker?, payments}`.
  - Payment object field names are exactly those in the spec. `transaction_cost` = `dropsToNative(fee)`; `executed_time` = `fmtTime(close_time)`.
- **Extra tests:**
  - `tampered marker → 400 invalid marker`.
  - `XRP+issuer → 400`.
  - `Link header present when marker present`.

### Task 22: Exchanges (raw) and /v2/exchanges (all pairs)
- **Routes:** `GET /v2/exchanges/:base/:counter`, and `GET /v2/exchanges` (GateHub extra). The extra reads `exchanges` filtered by the resolved ledger range, ORDER BY `(ledger_index, tx_index, node_index)`, bounded by the ClickHouse query guards. It is not pair-prefixed, so it is a range scan, which is acceptable for an extra.
- **Reference:** `getExchanges.js` (raw path). **Parity source:** `test.exchanges.js` (the raw-trade `it`s).
- **Behavior:**
  - Canonicalise the pair; when `inverted`, map each row by swapping base/counter amounts, currencies, issuers and buyer/seller, and setting `rate = 1/rate`.
  - `limit` default 200, clamped to 400.
  - `autobridged=true` keeps only rows with `autobridged_currency`.
  - `rate` is output with `precision8`.
- **Extra tests:**
  - `reversed pair returns inverted rows with identical tx_hash order`.
  - `limit=1000 is clamped to 400`.
  - `lowercase pair path works`.

### Task 23: Exchange intervals and reduce
- **Same route as Task 22.** `interval` is one of `1minute 5minute 15minute 30minute 1hour 2hour 4hour 1day 3day 7day 1month 1year`, with `week` as an alias for `7day`; `reduce=true`.
- **Reference:** `getExchanges.js` (aggregated path) and `$REF/rhd-develop/lib/aggregation/exchanges.js` for bucket alignment.
- **Interfaces produced:** `export function bucketExpr(interval: string): string` (a ClickHouse expression over `close_time`, built from a fixed whitelist):
  - n-minute and n-hour: `toStartOfInterval(close_time, INTERVAL n MINUTE|HOUR)`
  - n-day: `toDateTime('2013-01-01 00:00:00','UTC') + intDiv(toUInt32(close_time) - 1356998400, n*86400) * n*86400`
  - `7day`/`week`: `toMonday(close_time)`
  - `1month`: `toStartOfMonth`
  - `1year`: `toStartOfYear`
- **Behavior:**
  - Native legs ≤ 0.0005 are excluded from aggregation.
  - Each row: `{open, high, low, close, vwap (precision8), count, base_volume, counter_volume (strings), buy_volume (number; base where buyer = taker), open_time, close_time, start, base_currency, base_issuer, counter_currency, counter_issuer}`.
  - Inverted requests invert the prices (`open=1/open`, high↔low inverted) and swap the volumes.
  - `reduce` with `interval` → 400 `cannot use reduce with interval`.
- **Extra tests:**
  - `3day buckets align to 2013-01-01` (unit test of `bucketExpr` via a ClickHouse query on the harness).
  - `week alias equals 7day`.
  - `reduce returns one row whose count equals raw count`.

### Task 24: Accounts list and account lookup
- **Routes:** `GET /v2/accounts`, `/v2/accounts/:address`.
- **Reference:** `accounts.js`, `getAccount.js`. **Parity source:** `test.accounts.js`.
- **Behavior:**
  - List: `{account, parent, initial_balance, inception, ledger_index, tx_hash}`, with a `parent` filter.
  - Lookup: `{result, account_data}` from the **latest** `accounts_created` row for the address; otherwise 404 `Account not found`.
  - `genesis_balance`/`genesis_index` stay null (omitted) until the history import exists. Importing ledger 32570's state is part of the out-of-scope backfill.

### Task 25: Account transactions and transaction by sequence
- **Routes:** `GET /v2/accounts/:address/transactions`, `/v2/accounts/:address/transactions/:sequence`.
- **Reference:** `accountTransactions.js`, `accountTxSeq.js`. **Parity source:** `test.account.transactions.js`.
- **Behavior:**
  - Time mode pages `account_transactions` (all affected transactions), filtering on `tx_type`/`result`.
  - `min_sequence`/`max_sequence` switch to `account_tx_by_sequence` (sender only) and ignore `start`/`end`.
  - `limit` default 20, max 1000.
  - `/:sequence` with a non-digit value → 400 `invalid sequence number`; not found → 404 `transaction not found`.
- **Extra test:** `received-only payment appears in recipient history` (fixes the old sender-only bug).

### Task 26: Account payments, exchanges, balance changes
- **Routes:**
  - `/v2/accounts/:address/payments`
  - `/v2/accounts/:address/exchanges`, `/:base`, `/:base/:counter`
  - `/v2/accounts/:address/balance_changes`
- **Reference:** `accountPayments.js`, `accountExchanges.js`, `accountBalanceChanges.js`. **Parity sources:** `test.account.payments.js`, `test.account.exchanges.js`, `test.account.balanceChanges.js`.
- **Behavior:**
  - **Payments:** page `account_payments` with filters `type` (sent/received, otherwise 400), `currency`, `issuer` (now applied), `source_tag`, `destination_tag`, then join full rows from `payments`.
  - **Exchanges:** read from `account_exchanges`. Base/counter filters work in **either** orientation: canonicalise and invert rows the same way as Task 22.
  - **Balance changes:**
    - Filters: `currency`, `counterparty`/`issuer` (with `XRP` → 400), `change_type`/`type`.
    - Rows use the spec field names; `node_index` is omitted when it is -1.
    - The response key is `balance_changes`.

### Task 27: Account balances and orders (live node)
- **Routes:** `/v2/accounts/:address/balances`, `/v2/accounts/:address/orders`.
- **Reference:** `accountBalances.js`, `accountOrders.js`. **Parity source:** none (the Ripple tests mock rippled); write stub-based tests.
- **Behavior:**
  - Resolve the ledger from `ledger_index`/`ledger` | `ledger_hash` | `date`/`close_time` (via `LedgerRangeResolver.ledgerAtOrBefore`). Default: `validated`.
  - Balances use `account_info` + paged `account_lines` (page size 400, `peer` = counterparty). The native balance comes first and has no `counterparty`.
  - Orders use paged `account_offers`. `direction` = `sell` when `flags & 0x00020000`, else `buy`. Amounts use `{currency, value, counterparty?}`, with native values converted from drops.
  - `limit`: default 200, max 400; `'all'` allowed for balances; NaN → 400 `invalid limit`.
  - Errors:
    - invalid address → 400 `invalid ripple address`
    - `actNotFound` → 404 `account not found`
    - `lgrNotFound` → 400 `the date provided is too old`
  - Cache through `CacheService` (TTL `liveCacheTtlMs`), keyed on the full resolved request.
- **Tests (harness `xrplStub`):**
  - `balances native first without counterparty`.
  - `ledger_hash is forwarded`.
  - `date resolves to ledger at or before`.
  - `sell flag sets direction sell`.
  - `actNotFound → 404`.
  - `Xahau shows XAH`.

---

## Phase 6: Rate-derived endpoints

### Task 28: RatesService, exchange_rates, normalize

**Files:**
- Create: `packages/shared/src/query/rates.service.ts` and `packages/shared/test/rates.e2e-spec.ts`
- Create the API routes in `apps/api/src/exchanges/` (`exchange-rates.controller.ts`, `normalize.controller.ts`)
- Test: `apps/api/test/rates.e2e-spec.ts`
- Reference: `getExchangeRate.js`, `normalize.js`. Parity source: `test.exchangerates.js`

**Interfaces:**
- Produces:
  ```ts
  export type RatePeriod = 'hour' | 'day' | '3day' | '7day' | '30day';
  export class RatesService {
    constructor(ch: ClickHouseService, nativeCurrency: string);
    exchangeRate(base: Asset, counter: Asset, o?: { date?: Date; strict?: boolean /* true */; period?: RatePeriod; live?: boolean }): Promise<BigNumber>; // reference algorithm; BigNumber(0) when undeterminable; 1 when same asset
    vwap(base: Asset, counter: Asset, from: Date, toExclusive: Date): Promise<{ vwap: BigNumber; count: number; baseVolume: BigNumber; counterVolume: BigNumber }>; // excludes native legs ≤ 0.0005
    normalize(amount: BigNumber, from: Asset, to: Asset, o?: { date?: Date; strict?: boolean }): Promise<{ rate: BigNumber; converted: BigNumber }>; // rate = r(from→native)/r(to→native)
    dailyNativeRates(assets: Asset[], fromDay: Date, toDayExclusive: Date): Promise<Map<string /* assetKey */, Map<string /* YYYY-MM-DD */, BigNumber /* asset units per 1 native */>>>;
  }
  ```
- Exchange rate algorithm (no `period`):
  - `daily` = VWAP from 00:00 of `date`'s day up to `date`.
  - `latest` = VWAP of the last 50 trades in the 14 days before `date`. It counts only if it has ≥ 10 trades, or when `strict=false`; otherwise it is 0.
  - `rate = (daily + latest) / 2` when both are > 0, else `latest`.
- With `period`: VWAP over the rolling window ending at `date - 1s`.
- The API routes respond `{result, rate: precision8}`, and `{result, amount, converted, rate}` as strings.
- Error cases:
  - Future date → 400 `must not be a future date`.
  - An unparseable date returns 400 (bug fix; the old API threw a 500).
  - The normalize 500 case returns HTTP **500** (bug fix; the old API returned 200).

- [ ] **Step 1: Write failing tests**
  - Parity: port the `it`s from `test.exchangerates.js`.
  - `same asset → 1`.
  - `strict with <10 trades → "0"`.
  - `strict=false returns latest`.
  - `normalize XRP→USD.rvYAf… converted = amount*rate`.
  - `normalize missing amount → 400 invalid amount`.
  - `period=day uses rolling window`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-api-shared test:e2e -- rates && pnpm --filter @gatehub/data-api-service test:e2e -- rates`. Expected: FAIL.
- [ ] **Step 3: Implement** `RatesService` and both routes.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 29: Active accounts

- **Route:** `GET /v2/active_accounts/:base/:counter`. Module: `apps/api/src/active-accounts/`.
- **Reference:** `activeAccounts.js`. Parity source: `test.active_accounts.js`.
- **Query:** one SQL over `exchanges` for the canonical pair within the window (`period` 1day/3day/7day, default 1day). `date` given → `[date, date+period)`; otherwise `[now-period, now)`.
- **Aggregation:** GROUP BY account over the union of buyer rows (buy) and seller rows (sell).
- **Output:** volumes as strings, sorted by `base_volume` desc. `include_exchanges` (any non-empty value) attaches each account's exchanges with `executed_time` as ISO with milliseconds.
- **Errors:** invalid period → 400 `invalid period - use: 1day, 3day, 7day`. Use the exact reference text.
- **Extra tests:** `CSV works` (fixes the reference crash). `inverted pair swaps buy/sell volumes`.

### Task 30: Account reports

- **Routes:** `GET /v2/accounts/:address/reports` and `/v2/accounts/:address/reports/:date`.
- **Reference:** `accountReports.js`, plus the aggregation in `$REF/rhd-develop/lib/aggregation/accountPayments.js`. Parity source: `test.account.reports.js`.
- **Query:** `account_payments` for the address within the day range, joined with `RatesService.dailyNativeRates` for every non-native asset seen.
- **Day range:** at most 200 days, else 400 with the reference's exact message.
- **Per UTC day row (zero-filled):** `account`, `date`, `high_value_received`, `high_value_sent`, `total_value_received`, `total_value_sent`, `total_value` (native-normalized strings), `payments_sent`, `payments_received`.
- **Counterparties:** `sending_counterparties` / `receiving_counterparties` are a count, or an array when `accounts=true`.
- **Payments:** `payments` is included when `payments=true`, as `[{tx_hash, amount, currency, issuer, type}]`.
- **Envelope:** `{result, start, end, count, reports}`.
- **Extra tests:** `CSV returns rows not envelope` (bug fix). `IOU with no rate counts as 0`.

### Task 31: Account stats (transactions, value)

- **Routes:** `GET /v2/accounts/:address/stats/transactions` and `/stats/value`. Any other family → 400 `invalid family`.
- **Reference:** `accountStats.js`. Parity source: `test.account.stats.js` (port what derives from ledgers; the reference read a precomputed table).
- **transactions:** daily `{date, transaction_count, result:{code:n}, type:{TxType:n}}` from `account_transactions` grouped by `toDate(close_time)`, using `sumMap`.
- **value:** daily `{date, account_value, balance_change_count}`.
  - Final balance per (currency, counterparty) at end of each active day: `argMax(final_balance_f, (ledger_index, tx_index, node_index))`, carried forward across days.
  - Converted to native with `dailyNativeRates`, summed with the native balance.
  - `account_value` is a string.
- **Paging:** `limit` 200/1000; `marker` = the date key; `end` is exclusive.

---

## Phase 7: Collectors and network fee endpoints

### Task 32: Fee stats poller, /network/fee_stats, /network/fees

**Files:**
- Create: `apps/syncer/src/fees/{fee-stats-poller.ts, fees.module.ts}` (+ spec)
- Create: `apps/api/src/network/{fees.controller.ts, fees.service.ts}` (rewrite the `network` module; volumes are added in Task 35)
- Test: `apps/api/test/fees.e2e-spec.ts`
- Reference: `$REF/rhd-develop/scripts/feeStats.js`, `api/routes/network/getFees.js`, `getFeeStats.js`. Parity source: `test.network.js` (the fee `it`s whose data comes from ledgers)

**Interfaces:**
- Produces:
  ```ts
  @Injectable() export class FeeStatsPoller implements OnApplicationBootstrap, OnModuleDestroy {  // every 5000 ms: NodeClient.request({command:'fee'}) → FeeStatsRow; pct_max_queue_size = round2(current_queue_size / (expected_ledger_size * 20) * 100)
    sample(): Promise<FeeStatsRow>;   // exported for tests
  }
  ```
- **/network/fees:**
  - `interval=ledger`: rows from `ledgers`, `{avg, min, max, total, tx_count, date, ledger_index}`, in native units. `avg = Number((total/tx_count).toPrecision(6))`; an empty ledger has `min` 0.
  - `interval=hour|day`: sum `total` and `tx_count`, recompute `avg`; `min` = min of non-zero `fee_min`, `max` = max. No `ledger_index`.
  - Invalid interval → 400 `invalid interval - use: ledger, hour, day` (exact reference text).
- **/network/fee_stats:**
  - No interval: raw rows.
  - `interval=minute|hour|day`: the first snapshot at or after each boundary (`argMin` per bucket).
  - Output fields: `{date, current_ledger_size, expected_ledger_size, current_queue_size, pct_max_queue_size, median_fee, minimum_fee, open_ledger_fee}`, fees in native units (numbers).

- [ ] **Step 1: Write failing tests**
  - Poller (stub `fee` response): `computes pct_max_queue_size`, `writes a row per sample`.
  - API: fees `interval=ledger` matches the mock ledger fee sums (compute the expected values in-test from fixtures). `interval=day` merges. fee_stats bucket sampling: seed 3 rows in one minute, and `interval=minute` returns the first.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-syncer test -- fee-stats && pnpm --filter @gatehub/data-api-service test:e2e -- fees`. Expected: FAIL.
- [ ] **Step 3: Implement** the poller and both routes.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 33: Validations collector and validation endpoints

**Files:**
- Create: `apps/syncer/src/validations/{validations-collector.ts, validations.module.ts}` (+ spec)
- Create: `apps/api/src/validations/*`
- Test: `apps/api/test/validations.e2e-spec.ts`
- Reference: `$REF/rhd-develop/lib/validations/*`, `api/routes/network/getLedgerValidations.js`. Parity source: `test.validations.js` (port the shape assertions; reference data comes from `test/mock/ledger-validations.json`, which you seed directly as rows)

**Interfaces:**
- Produces:
  ```ts
  @Injectable() export class ValidationsCollector implements OnApplicationBootstrap, OnModuleDestroy {
    // one NodeClient per validationEndpoints entry; subscribe(['validations','manifests']); reporter_public_key = serverInfo().pubkey_node
    // master key: msg.master_key ?? manifest map (from 'manifestReceived' + validator_manifests table + `manifest` RPC on miss) ?? signing key
    // merge in memory by (ledger_hash, validation_public_key): count++, first/last datetime; flush every 20 s as AggregatingMergeTree rows
    handleValidation(msg: Record<string, any>, reporter: string, now?: Date): void;   // exported for tests
    flush(): Promise<number>;
  }
  ```
- **Routes:** `GET /v2/ledgers/:ledger_hash/validations`, `/v2/ledgers/:ledger_hash/validations/:pubkey`, plus the singular `/v2/ledger/...` aliases.
- **Reads:** `GROUP BY ledger_hash, validation_public_key` with `sum`/`min`/`max`/`any`, ordered by `validation_public_key`.
- **Marker:** the pubkey.
- **Output:** datetimes via `fmtMillis`.
- **Errors:**
  - Odd or non-hex hash → 400 `invalid ledger hash`.
  - Missing single validation → 404 `validation not found`.
  - The single-validation route returns the flat Validation object plus `result`.

- [ ] **Step 1: Write failing tests**
  - Collector: `two reports of same validation merge count=2`. `ephemeral key mapped via manifest`. `flush is idempotent across two flushes` (sum of counts preserved in AggregatingMergeTree).
  - API: parity shape. `pagination by pubkey`. `singular alias works`.
- [ ] **Step 2: Run** `pnpm --filter @gatehub/data-syncer test -- validations && pnpm --filter @gatehub/data-api-service test:e2e -- validations`. Expected: FAIL.
- [ ] **Step 3: Implement** the collector and the routes.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

---

## Phase 8: Aggregator, stats and volumes

### Task 34: Stats job and /v2/stats

**Files:**
- Create: `packages/shared/src/aggregate/stats.job.ts` (+ e2e)
- Create: `apps/syncer/src/aggregator/{aggregator.service.ts, aggregator.module.ts}` (+ spec)
- Rewrite: `apps/api/src/stats/*`
- Test: `apps/api/test/stats.e2e-spec.ts`
- Reference: `stats.js`, `$REF/rhd-develop/lib/aggregation/stats.js`. Parity source: `test.stats.js`

**Interfaces:**
- Produces:
  ```ts
  export async function recomputeStatsHourly(ch: ClickHouseService, fromHour: Date, toHourExclusive: Date): Promise<number>;
  // INSERT INTO stats_hourly SELECT toStartOfHour(close_time) hour, sum(tx_count), sum(payments_count), sum(exchanges_count), sum(accounts_created), count(),
  //   min(close_time), max(close_time), sumMap(type_counts), sumMap(result_counts), toUnixTimestamp64Milli(now64()) FROM ledgers FINAL WHERE close_time >= .. AND < .. GROUP BY hour
  @Injectable() export class AggregatorService {  // every 60 s: recompute [now-2h, now); drain agg_dirty (recompute each range, then lightweight-delete the row); every 60 s: volume jobs (Task 35)
    tick(now?: Date): Promise<void>;
  }
  ```
- **API:**
  - `interval` hour, day or week (ISO week via `toMonday`). Day and week rows are sums of hours.
  - `ledger_interval` = (last_close − bucket_start) / ledger_count.
  - `tx_per_ledger` = transaction_count / ledger_count.
  - Families: `type`, `result`, `metric`. `metrics` (CSV list) requires a family → 400 `family is required`.
  - An invalid interval returns 400 `invalid interval` (bug fix; the old API returned empty).
  - Without a family the row is nested: `{date, type:{}, result:{}, metric:{…}}`. With a family the row is flat. Zero metrics are omitted.
  - `limit` 200/1000; the marker is the bucket timestamp.
- **Harness:** call `recomputeStatsHourly` over the fixture range after seeding.

- [ ] **Step 1: Write failing tests**
  - Parity: port the `it`s from `test.stats.js`.
  - `recompute twice is idempotent` (count of FINAL rows unchanged, sums unchanged).
  - `agg_dirty range is processed and removed`.
  - `metrics without family → 400`.
- [ ] **Step 2: Run** the shared e2e, `pnpm --filter @gatehub/data-syncer test -- aggregator`, and `pnpm --filter @gatehub/data-api-service test:e2e -- stats`. Expected: FAIL.
- [ ] **Step 3: Implement** the stats job, `AggregatorService` and the `/v2/stats` route.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 35: Volume jobs, /network/exchange_volume, /network/payment_volume

**Files:**
- Create: `packages/shared/src/aggregate/volume.job.ts` (+ e2e)
- Extend: `AggregatorService`
- Create: `apps/api/src/network/{volume.controller.ts, volume.service.ts}`
- Test: `apps/api/test/volume.e2e-spec.ts`
- Reference: `$REF/rhd-develop/scripts/{tradeVolume,paymentVolume}.js`, `$REF/rhd-master/api/routes/network/getMetric.js`. Parity source: `test.network.js` (shape and conversion assertions only; reference values come from HBase mocks)

**Interfaces:**
- Produces:
  ```ts
  export type LivePeriod = 'hour' | 'day' | '3day' | '7day' | '30day';
  export async function computeLiveVolumes(ch: ClickHouseService, rates: RatesService, markets: MarketsConfig, now: Date): Promise<void>;   // writes volume_live rows for trade: all LivePeriods; payment: hour, day
  export async function computeDailyVolumes(ch: ClickHouseService, rates: RatesService, markets: MarketsConfig, day: Date): Promise<void>;  // writes volume_daily for both metrics
  ```
- **Trade components:**
  - Each configured market, normalised so native is the counter.
  - `amount` = base volume; `count` = trades.
  - Native-counter markets: `rate = 1/vwap` and `converted = counter_volume`.
  - Other markets: converted through the native rate of either leg; markets with no rate are dropped.
- **Payment components:**
  - Each configured currency, plus native.
  - `amount` = Σ `delivered_amount_f` from `payments_by_currency` ⨝ `payments`; `count` = payments.
  - `rate` = units per native at the window start; `converted = amount / rate`.
  - Zero entries are dropped.
- **Daily job:** the aggregator recomputes today and yesterday on every tick, and each closed day once.
- **API:**
  - **Live mode** (no `start`/`end`): one row from `volume_live` for the requested period.
  - **Historical mode:** `interval` day/week/month (week and month are sums of daily rows); `limit` 200/1000 with a marker.
  - **Display currency:** `exchange_currency`/`exchange_issuer` (non-native without issuer → 400 `exchange currency must have an issuer`). Conversion `X` = rate(native→display): `total *= X`, `exchange_rate = X`, `component.rate /= X`, `converted_amount *= X`.
  - Row fields: `{components, count, start_time, end_time, exchange:{currency, issuer?}, exchange_rate, total}`, as strings where the reference uses strings.

- [ ] **Step 1: Write failing tests**
  - Seed the `ripple-mock` fixtures and a test markets config built from the pairs present in the fixtures.
  - `daily job idempotent`.
  - `live day row has components sorted by converted_amount desc`.
  - `display currency conversion keeps converted_amount = amount / rate`.
  - `historical week = sum of days`.
  - `invalid live period → 400`.
- [ ] **Step 2: Run** the shared e2e and `pnpm --filter @gatehub/data-api-service test:e2e -- volume`. Expected: FAIL.
- [ ] **Step 3: Implement** the volume jobs, the aggregator wiring and both routes.
- [ ] **Step 4: Run** the same commands. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

---

## Phase 9: Deploy, docs, verification

### Task 36: Per-network deployment

**Files:**
- Modify: `docker-compose.yaml`, `docker-compose.prod.yaml`, `deploy/.env.prod.example`, `apps/*/Dockerfile`, `apps/*/.env.example`
- Remove: `GH_XRPL_NETWORK_ID`, `GH_BACKFILL_*` and `GH_SUBSCRIBE_LIVE` from env examples and docs

**Steps:**
- [ ] **Step 1: Compose services.**
  - Keep `clickhouse` (the pinned LTS image) and `keeper` in prod.
  - Add `migrate-xrpl` / `migrate-xahau` (one-shot `node packages/shared/dist/clickhouse/migrate.js` with `GH_NETWORK`).
  - Add `syncer-xrpl` and `syncer-xahau` (replicas 1, restart unless-stopped, `GH_NODE_ENDPOINTS` and `GH_VALIDATION_ENDPOINTS` per network).
  - Add `api-xrpl` and `api-xahau` (scalable), with nginx routing by host (`xrpl.data.*` / `xahau.data.*`) in `deploy/nginx/nginx.conf`.
- [ ] **Step 2: Dockerfiles.** They copy `packages/shared/{config,schema}` into the image. The syncer image also contains the `range-ingest` CLI.
- [ ] **Step 3: Verify.**
  - Run `docker compose config -q` and `docker compose -f docker-compose.prod.yaml config -q`. Expected: exit 0.
  - Run `docker compose build` with `NPM_TOKEN` available. If there is no token, report the step as BLOCKED, not done.
- [ ] **Step 4: Checkpoint.**

### Task 37: Documentation

**Files:**
- Rewrite: `docs/api-reference.md` (Ripple contract per endpoint, auth note, Xahau note), `README.md`, `docs/{architecture,data-model,syncer,configuration,deployment,operations,backfill}.md`
- Regenerate: `docs/openapi.yaml` from the running app (`/internal/docs/json`)
- ADRs: mark ADR-0002 (CTID dedup) and ADR-0004 (date keyset) superseded. Amend ADR-0003. Add:
  - `0007-ledger-index-axis-and-secondary-tables.md`
  - `0008-no-aggregate-materialized-views.md`
  - `0009-one-deployment-per-network.md`
  - `0010-ripple-v2-wire-compatibility.md` (lists every deliberate deviation: required API key, fixed bugs, extras dropped/kept, `/v2/ledger` singular alias)
- Delete: `docs/elasticsearch-to-clickhouse.md` (obsolete). Update `load/seed.js` to the new tables, or delete it if `range-ingest` from fixtures replaces it.

**Steps:**
- [ ] **Step 1:** Write the docs.
- [ ] **Step 2: Verify.** `grep -rn "problem+json\|GH_BACKFILL_\|top_currencies\|payment_volume_daily" docs README.md` returns nothing.
- [ ] **Step 3: Checkpoint.**

### Task 38: End-to-end verification on both networks

- [ ] **Step 1: Full suite.** `pnpm install && pnpm build && pnpm test && pnpm -r test:e2e`. Expected: all green. Record the counts in the final report.
- [ ] **Step 2: Bring up the stack.**
  - `docker compose up -d clickhouse`.
  - Run migrate for `xrpl` and `xahau`.
  - Start both syncers locally (`pnpm start:syncer` with `GH_NETWORK=…`, `GH_SYNC_START_LEDGER` = head−500, public endpoints `wss://xrplcluster.com` / `wss://xahau.network`).
  - Wait until `/liveliness/healthz` reports lag ≤ 1.
- [ ] **Step 3: Crash test.**
  - `kill -9` the XRPL syncer during catch-up and restart it.
  - Check: `SELECT max(ledger_index)-min(ledger_index)+1 = count() FROM ledgers` → 1.
  - Check: `SELECT count() = uniqExact(ledger_index, tx_index) FROM transactions` → 1.
- [ ] **Step 4: Exercise the API.**
  - Start both APIs and curl every endpoint in the spec table with `X-API-Key`, plus `format=csv`, a 2-page marker walk and one bad param each.
  - Save the responses under `scratchpad/smoke/<network>/` and diff field sets against the spec objects.
- [ ] **Step 5: Spot-check against the node.**
  - `/balances` vs `account_lines`.
  - `/transactions/{hash}?binary=true` re-hashes to `hash`.
  - `/ledgers/{index}` vs `ledger`.
  - Validations exist for recent ledgers.
  - New `fee_stats` rows land roughly every 5 s.
- [ ] **Step 6: Populate `config/markets/xahau.json`** with the top 10 XAH markets by 30-day trade count, using a query over the live `exchanges` table after a `range-ingest` of the last ~30 days (if node history allows, otherwise what's available). Bump `version`.
- [ ] **Step 7: Report.** Write `docs/superpowers/plans/2026-10-15-ripple-dropin.verification.md` with the commands, outputs and anything BLOCKED.
