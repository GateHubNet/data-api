# ClickHouse: the storage layer

How the Data API uses ClickHouse, the performance rules that matter, and the path to a highly available, backed-up production
deployment. The tables and columns are in [data-model](data-model.md); the write path is in [syncer](syncer.md).

## Why ClickHouse

The workload is append-only, ledger-ordered data read two ways: selective lookups (transaction by hash, account history, a ledger)
and aggregates (candles, rates, volumes, stats). That is columnar-OLAP territory and what the previous design (a search engine
used for aggregations) was weakest at ([ADR-0001](adr/0001-use-clickhouse.md)).

One ClickHouse **server** holds one **database per network**, each with the same 55 tables
([ADR-0009](adr/0009-one-deployment-per-network.md)). The names are the profiles': `xrpl`, `xahau`, `xrpl_testnet` and `xahau_testnet`. Production's
server holds `xrpl` and `xahau`, the sandbox's own server `xrpl_testnet` and `xahau_testnet`, and both have the `shared` database (account names and labels).
The SQL on this page names `xrpl`; on a testnet write its database in its place. A testnet is never on the production server: the sandbox is a stack of
its own ([deployment](deployment.md#environments)). The image is pinned to `clickhouse/clickhouse-server:26.8.14.3` (the schema
and the syncer's recovery rely on partition-scoped lightweight `DELETE` and on `async_insert=0`, both verified on that version);
`clickhouse-keeper` is pinned to the same version.

## How tables are laid out, in one paragraph

`ledger_index` is the time axis: close times grow with it, so a request's `start`/`end` is resolved once to a ledger range
(a `minmax` index on `ledgers.close_time`, cached in the API) and every list is a range of the primary key. The big base tables
(`ledgers`, `transactions`, `payments`) are ordered by ledger; narrow **secondary tables** that the syncer writes explicitly
(`tx_by_hash`, `account_transactions`, `payments_by_currency`, `exchanges` by pair, ...) are ordered by what their endpoint filters on,
and a page is `WHERE (ledger_index, tx_index) IN (SELECT ... ORDER BY ... LIMIT n+1)`. There are no aggregate materialized
views ([ADR-0008](adr/0008-no-aggregate-materialized-views.md)) and no projections (they conflict with lightweight `DELETE`). Details:
[ADR-0007](adr/0007-ledger-index-axis-and-secondary-tables.md).

## The `FINAL` rule

The ledger tables are `ReplacingMergeTree` ordered by their natural unique key. That is only a **safety net**: duplicates collapse
on background merges, but readers never rely on that, and the syncer's recovery deletes a partition range before rewriting it
instead of relying on merges.

`... FINAL` merges at query time across all parts. Cheap for a single-row lookup, ruinous for a scan: under load, 80 concurrent
`FROM payments FINAL ORDER BY ... LIMIT 200` queries drove the old design to `Memory limit (total) exceeded` (p95 about 30 s, 30 %
errors), while the same query without `FINAL` ran at 127 QPS with zero errors.

| Query shape | `FINAL`? | How duplicates are handled instead |
| --- | --- | --- |
| Lists and range scans (`transactions`, `payments`, `exchanges`, `account_*`, `ledgers`, fees) | **No** | `LIMIT 1 BY <key>` OUTSIDE the ordered read: `readDistinctPage` reads `ORDER BY <whole key> LIMIT <page + room>` in a subquery and dedupes that (see below) |
| Single-row lookups (`tx_by_hash`, `ledger_by_hash`, ...) | not needed | the lookup table gives the key; the `ledgers` row is the commit marker |
| Aggregates (candles, rates, active accounts, reports) | **No** | the aggregation reads `LIMIT 1 BY` deduplicated rows, and sums are exact decimals so a row counted once is counted once |
| Rollups the aggregator writes (`stats_hourly`, `volume_*`) | **No** | readers keep the newest `version` of a row/set (`argMax` / `max(version)`), so a half-written newer version is never mixed with an older one |
| The account and market aggregates (`native_rates_daily`, `pair_hourly`, `markets_live`, the account rollups) | **No** | the newest version of a set, found from its sentinel or as `max(version)` of its key prefix; see [the aggregate families](#the-aggregate-families-and-their-reads) |
| `validations` (AggregatingMergeTree) | **No** | readers `GROUP BY (ledger_hash, validation_public_key)` and add the partial rows up |

> A new list endpoint must not use `FINAL` on its scan ([ADR-0003](adr/0003-no-final-on-list-queries.md)); the unit test
> `sql-tables.spec.ts` also keeps table names to the `Table` enum, and the e2e suites check query plans (`EXPLAIN PIPELINE` for the read
> in key order, `EXPLAIN actions = 1` for the `Limit` on that read) and what a page reads (`system.query_log.read_rows`,
> `apps/api/test/paged-reads.e2e-spec.ts`).

### Reading a page: what stops the read

ClickHouse stops reading a key-ordered range after a page only when the `LIMIT` reaches the read. Two things in the SQL break that
(both found in the final review, Ruling R106; ClickHouse 26.8.14.3):

- **`LIMIT 1 BY` in the same SELECT as the read.** `ORDER BY <key> LIMIT 1 BY <key> LIMIT n` reads in order, but the `LIMIT BY`
  between the read and the `LIMIT` keeps the limit out of the read: over a range of more than one part it read, and buffered, most of
  the range (one 201-row page of a 256M-row table: 143M rows and 1.16 GiB; with `max_memory_usage` = 100 MB it failed). With a plain
  inner `LIMIT` the same page read 590k rows and 20 MiB. So every list reads with `readDistinctPage` (`packages/shared/src/query/
  distinct-page.ts`): an inner `ORDER BY <whole key> LIMIT <page + room>` (room = as many rows as the page, at least 16) and, outside it,
  `LIMIT 1 BY <key> LIMIT <page>`. If duplicates fill the room (the inner read hit its cap and the page came out short), it reads again
  with four times the room. The pages of candles (`LIMIT 1 BY bucket`) and the last 50 trades of a rate use the same shape.
- **A tuple comparison for the marker.** `(ledger_index, tx_index) > (x, y)` does not narrow the granules ClickHouse reads, so a page far
  into a list read the range from its start up to the marker. `keysetClause` also bounds the first column on its own:
  `ledger_index >= x AND (ledger_index, tx_index) > (x, y)`.

What a page then reads is about one granule (8,192 rows; 1,024 for `transactions`) of each part the rest of the range spans, whatever
the length of the range. `/v2/exchanges` of every pair is not a key order of `exchanges` (it is ordered by the pair first, and the
primary key can skip only the granules of pairs large enough to have some to themselves), so it reads one window of ledgers per page,
sized by `ledgers.exchanges_count` (a read of `ledgers` in key order finds the ledger by which the exchanges from the marker on reach
the page) and sorted on its own to the page (a top-N); a window that holds fewer than counted (a marker inside its first ledger,
`autobridged`) is followed by one sized for twice as many (Ruling R107). Its cost is the granules of that window, which for the long
tail of small pairs can be most of the partition (10 million ledgers) it lies in, never the whole history.

## The aggregate families and their reads

Sub-project D2 ([ADR-0013](adr/0013-account-and-market-aggregates.md)) adds nine aggregate tables ([data-model](data-model.md#account-and-market-aggregates-migration-003)).
They are `ReplacingMergeTree(version)` tables whose unit is a **set**, written whole in one insert under a new version by the aggregator.
Every read follows three rules: it starts from a **key prefix** of the table (so it reads the granules of one account, day or period,
never the table), it keeps the **newest version** of the set (never `FINAL`: a merge may not have run, and `FINAL` would merge across
every part), and it reads a row that may be there twice **once** (`LIMIT 1 BY` the key). The reads, by family:

| Family | Who reads it | The read |
| --- | --- | --- |
| `native_rates_daily` | `DailyRates` (the API's valuation) | One query for the days of a request that have a valid set: the assets as tuples (`(currency, issuer) IN ...`), the key prefix, `day BETWEEN`, and `(day, version) IN` the newest not-stale sentinel of each day of the current config version, so only the rows of that version are read. The days without a valid set are computed on read (`RatesService.dailyNativeRates`, a call per run of at most 3,000 days) and cached 60 s in the API |
| `pair_hourly` | `markets_live` and the `pair_hourly` runner | The sentinels of an hour range (`hour` is the first key column), then the rows of the newest version of each hour, of the sources the filter takes (`book`, `amm`; `source` is the last key column); each hour's rows are summed or combined as a market window (open and last by the key of the trade, high and low by rate with the key as tie-break, sums with the `sumOf` fallback) |
| `markets_live` | `MarketsService` (`/v2/network/markets`) | The key prefix `(period, amm)` (the filter of the request: a period has an `include`, an `exclude` and an `only` set) with `version = (SELECT max(version) ... WHERE period AND amm)`, ordered by the key, `LIMIT 1 BY` the pair: one set, up to a few thousand rows, in tens of milliseconds |
| `account_rollup_state` | `AccountDayGroupsService`, the `account_rollups` runner | `account = ...`, `ORDER BY account, version DESC LIMIT 1`: the newest row is the state, and a state of another config version has no coverage. Cached 60 s per account in the API |
| `account_lines_daily`, `account_tx_daily`, `account_trades_daily` | the day-groups read of the API (the rollup source) | `account = ... AND day BETWEEN ...` and `(day, version) IN (SELECT day, max(version) FROM account_rollup_days WHERE account = ... GROUP BY day)`: the rows of the version of each day's sentinel, ordered by the key and `LIMIT 1 BY` the group. A set whose sentinel is not written is not read |
| The raw rows of an account | the day-groups read of the API (the raw source), and the rollup writer | The account's key range in `balance_changes`, `account_transactions` or `account_exchanges` (the primary key starts with `account`, so a window is one key range per part) for the ledger range of the days read (at most two ranges outside the rolled days), each row once: a subquery ordered by the whole key with `LIMIT 1 BY` the rest of it, as the other account reads do. The writer reads `account IN (...)` for the heavy accounts of a day |

**Where the cost is.** An account window costs the rows the account holds in it (a key range); a heavy account (1,000,000 balance
changes or more) is served from its daily rollups for the days they cover, so the same answer costs the groups (days x lines) instead of
millions of rows. A window of time across all accounts is no key range: every part that holds a ledger of it is read whole, which is why
nothing reads "all accounts of a day" except the aggregator, once, over the youngest parts (`pair_hourly`, one hour at a time) or by
the heavy accounts' own key ranges (`account_rollups`). `pair_hourly` expires by whole parts (`ttl_only_drop_parts = 1`, 45 days; a
part is one day), so a TTL merge never rewrites a part. The query plans are pinned by tests (`apps/api/test/support/plans.ts`: a
`ReadFromMergeTree` on a key range that starts with `account`, the set reads on their key prefixes, no `FINAL`), and a light account's
All window reads about its own rows (`system.query_log.read_rows`).

## Writes: parts, insert modes, deduplication

- ClickHouse makes one **part** per insert, so the syncer batches (300 ledgers / 100,000 transactions / 5 s in catch-up, one commit per
  ledger live) and writes each table once per batch, chunked at 50,000 rows. The order is the child tables, `ledger_by_hash`, then
  `ledgers`, the commit marker ([syncer](syncer.md#writing-a-ledger-buildledgerrows-and-ledgerwriter)).
- Every insert is **synchronous** (`async_insert=0`): ClickHouse 26.8 defaults to asynchronous inserts, whose deduplication is off by
  default and which would weaken the child-rows-then-commit ordering.
- Inserts carry an `insert_deduplication_token` (`<runId>:<table>:<first>-<last>:<chunk>`) and the same `query_id`. The ledger-derived
  tables have `non_replicated_deduplication_window = 1000`, so a retried batch is dropped by the server instead of duplicated. The
  window survives a `DELETE`, which is why the syncer always continues under a **new** `runId` after deleting.
- Deletes are partition-scoped lightweight `DELETE`s (`IN PARTITION ID`, `lightweight_deletes_sync = 2`).
- `DateTime64(3)` columns read JSON numbers as **seconds**: insert fractional seconds (`1700000000.123`), never `Date.now()` milliseconds.
- `ClickHouseService` is the only database client: it runs `SELECT`s with bound `query_params`, and `insert`/`command` for the syncer.

After a large backfill, parts merge in the background. To force compaction of a table:

```sql
OPTIMIZE TABLE xrpl.transactions FINAL;      -- expensive; off-peak
```

```sql
SELECT table, count() AS parts, formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts WHERE active AND database = 'xrpl' GROUP BY table ORDER BY parts DESC;
SELECT * FROM system.merges;
SELECT * FROM system.mutations WHERE NOT is_done;      -- stuck lightweight deletes show up here
```

## Memory and safety guards

A single heavy query must never take the node down. Two layers:

1. **Per-query guards from the app:** every `SELECT` is sent with `max_execution_time` (`GH_CLICKHOUSE_MAX_EXECUTION_TIME`,
   default 30 s) and, if set, `max_memory_usage` (`GH_CLICKHOUSE_MAX_QUERY_MEMORY`, bytes). A runaway query is killed.
2. **Server limits** (ClickHouse config/profile): `max_server_memory_usage` (or the RAM ratio) and `max_concurrent_queries`.

The production compose caps the container at 8 GiB; size it to the box and set the per-query caps below it. The apis get their own
cap, `API_CLICKHOUSE_MAX_QUERY_MEMORY` (2 GiB in `deploy/.env.prod.example`; Ruling R107): a page reads a few MiB, so only a
regression or an extreme aggregation window gets near it, and it then fails with the route's 500 instead of starving the syncers.
The expensive query families are the ones that read a lot by design: `/v2/stats` over years before the rollup caught up,
`/reports` and `/stats/value` of very active accounts (an account-stats page groups the account's whole window), long candle and
reduce windows, and filtered `balance_changes`. They are bounded by the guards above and by their own window parameters.
`/v2/exchanges` over all pairs reads windows of ledgers since Ruling R107 (see [reading a page](#reading-a-page-what-stops-the-read)).

The API and the syncer use the **same ClickHouse user** (`data_api`, a full-access user that the compose creates); a read-only
user for the API would be better and is a known hardening gap ([security](security.md#10-security-checklist)).

## High availability and replication

The shipped schema uses plain `ReplacingMergeTree` (single-node correct). Two production paths:

### Option A: ClickHouse Cloud / managed
Replication, backups, scaling and upgrades are handled for you. Point `GH_CLICKHOUSE_URL` at the managed endpoint. Make sure the
service supports partition-scoped lightweight `DELETE` with `lightweight_deletes_sync` and synchronous inserts with
`insert_deduplication_token`, which the syncer's recovery uses.

### Option B: self-hosted replicated cluster
The production compose already runs **ClickHouse Keeper** and wires the server to it (`deploy/clickhouse/config.d/cluster.xml`
defines `<zookeeper>`, `<macros>` and a one-shard cluster). To make it highly available:

1. Switch the engines to `ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/{database}/{table}', '{replica}'[, version])` in a **new
   migration**, and replace `non_replicated_deduplication_window` by `replicated_deduplication_window` on the 14 ledger-derived tables
   **and** on `validator_validations` and `validator_seen` (migration 002: the collector's retried inserts carry a deduplication token, and
   those two tables have a window of 100; the nine tables of migration 003 have none, a set of theirs is idempotent by its `version`).
   `{shard}` and `{replica}` come from the `<macros>`.
2. Run two or more replicas and an odd number (3) of Keeper nodes (the compose ships 1 for local use).
3. Run the syncer recovery tests (`apps/syncer/test`) against your topology before relying on it: the recovery depends on synchronous
   `DELETE`s, on insert deduplication and on the single-writer lease behaving the same on every replica.

This is a deployment decision; the row model and the queries are the same.

## Backups

Do not run production without a tested restore:

- **Managed:** the provider's automated backups and point-in-time restore.
- **Self-hosted:** [`clickhouse-backup`](https://github.com/Altinity/clickhouse-backup) to object storage: daily full and hourly
  incremental; restore regularly.
- **Reproducible from source:** the data is a deterministic function of the ledger, so a total loss can also be recovered by
  re-running `range-ingest` over the history (slower, a real safety net; [backfill](backfill.md)). Backups make recovery *fast*.
  `fee_stats` and `validations` are collected live and cannot be re-derived from ledgers: back those up. Some of the validators and
  amendments data (migration 002) is collected live too and is lost with the database: `validator_seen` (the first-seen history), the stored
  lists (`unl_lists`, `unl_publishers`), the domain results (`validator_domains`) and the polled ledger states (`network_state`, kept 100
  days). `validator_votes`, `amendment_tallies` and `validator_agreement_hourly` are recomputed from `validations`, `ledgers`, the stored
  lists and `network_state` within the 90 days `validations` keeps.
  The nine aggregate tables of migration 003 are recomputed by the aggregator from the ledger tables once those are back (the back-fills are in
  [operations](operations.md#account-and-market-aggregates)), so a restore does not need them.

## Retention and TTL

`transactions.tx_json` + `meta_json` are the bulk of the data and are already `ZSTD(3)`-compressed. Partitions make retention cheap, but **a ledger lives in 19
tables that must agree**, so retention is never per table:

- The `ledgers` row is the commit marker. `range-ingest` **skips every ledger that has one** (it believes the ledger is complete), and the live syncer does not look
  behind its checkpoint, so a half-dropped ledger is not repaired by re-ingesting its range.
- A ledger with a `ledgers` row but fewer stored transactions than its `tx_count` answers **500** on `/v2/ledgers/{id}`; payments, exchanges and balance changes
  whose tables were dropped just vanish from lists.
- Partition sizes differ: `ledgers`, `transactions`, `payments`, `amm_pool_touches` and `path_payments` are partitioned per **1,000,000** ledgers (P6), the other seventeen ledger-keyed tables per **10,000,000** (P7),
  and `accounts_created` is not partitioned.

The safe procedure drops **one 10,000,000-ledger block from all 23 ledger-derived tables**: the ten P6 partitions of `ledgers`, `transactions`, `payments`, `amm_pool_touches`, `path_payments`
(`ledgers` first, the commit marker), partition `k` of the seventeen P7 tables, and a `DELETE ... WHERE ledger_index BETWEEN ...` on `accounts_created`; the exact commands are in
[operations](operations.md#retention). To restore a block run `range-ingest` over the same range (no `ledgers` rows are left, so it ingests everything); to repair
a partial loss use `range-ingest --reprocess` over exactly the damaged range. Dropping a block makes lists in that window empty.

Five tables expire by TTL, none of them a ledger table, so no ledger retention touches them:

| Table | TTL |
| --- | --- |
| `validations` | 90 days (`toDateTime(last_datetime) + INTERVAL 90 DAY`) |
| `validator_validations` | 7 days (`toDateTime(last_datetime) + INTERVAL 7 DAY`; `ttl_only_drop_parts = 1`, whole parts are dropped) |
| `network_state` | 100 days (`toDateTime(polled_at) + INTERVAL 100 DAY`) |
| `validator_agreement_hourly` | 400 days (`hour + INTERVAL 400 DAY`) |
| `pair_hourly` | 45 days (`hour + INTERVAL 45 DAY`, migration 003; `ttl_only_drop_parts = 1`, whole parts are dropped, a part is one day) |

`fee_stats`, the rollups (`stats_hourly`, `volume_*`, `amm_pools`, `amm_daily`) and the other tables of migration 002 (`validator_seen`, `validator_votes`, `amendment_tallies`,
`unl_lists`, `unl_publishers`, `validator_domains`, `amendment_features`) are small, keep them. The aggregate tables of migration 003 are not ledger tables
either: apart from `pair_hourly` they are recomputable and kept (`native_rates_daily`, `markets_live` and the six account rollup tables), and the retention
procedure leaves all nine alone. A re-ingest of a range reaches them through `agg_dirty` ([syncer](syncer.md#76-the-agg_dirty-hooks)).

## Useful operational queries

```sql
-- table sizes
SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, sum(rows) AS rows
FROM system.parts WHERE active AND database = 'xrpl' GROUP BY table ORDER BY sum(bytes_on_disk) DESC;

-- slow / heavy queries
SELECT query_duration_ms, memory_usage, read_rows, substring(query, 1, 80) AS q
FROM system.query_log WHERE type = 'QueryFinish' AND event_time > now() - 3600 ORDER BY query_duration_ms DESC LIMIT 20;

-- what runs now (the syncer's inserts have query_id <runId>:<table>:<first>-<last>:<chunk>)
SELECT query_id, formatReadableSize(memory_usage) AS mem, elapsed FROM system.processes ORDER BY memory_usage DESC;

-- replication (Replicated engines only)
SELECT database, table, is_leader, total_replicas, active_replicas, queue_size FROM system.replicas;
```

## Connecting

The apps use the **HTTP interface (8123)** through `@clickhouse/client` with bound `query_params` (no string interpolation;
[security](security.md)). The native protocol (9000) is for `clickhouse-client` and `clickhouse-benchmark`. Neither port is
published in production; the dev compose binds them to 127.0.0.1.
