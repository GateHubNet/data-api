# ClickHouse: the storage layer

How the Data API uses ClickHouse, the performance rules that matter, and the path to a highly available, backed-up production
deployment. The tables and columns are in [data-model](data-model.md); the write path is in [syncer](syncer.md).

## Why ClickHouse

The workload is append-only, ledger-ordered data read two ways: selective lookups (transaction by hash, account history, a ledger)
and aggregates (candles, rates, volumes, stats). That is columnar-OLAP territory and what the previous design (a search engine
used for aggregations) was weakest at ([ADR-0001](adr/0001-use-clickhouse.md)).

One ClickHouse **server** holds one **database per network** (`xrpl`, `xahau`), each with the same 23 tables
([ADR-0009](adr/0009-one-deployment-per-network.md)). The image is pinned to `clickhouse/clickhouse-server:26.8.14.3` (the schema
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
the length of the range. `/v2/exchanges` of every pair is not a key order of `exchanges` (it is ordered by the pair first), so it reads
windows of ledgers, starting at 256 ledgers and doubling up to about a million, each sorted on its own to the page (Ruling R107).

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
   migration**, and replace `non_replicated_deduplication_window` by `replicated_deduplication_window` on the ledger-derived tables.
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
  `fee_stats` and `validations` are collected live and cannot be re-derived from ledgers: back those up.

## Retention and TTL

`transactions.tx_json` + `meta_json` are the bulk of the data and are already `ZSTD(3)`-compressed. Partitions make retention cheap, but **a ledger lives in 14
tables that must agree**, so retention is never per table:

- The `ledgers` row is the commit marker. `range-ingest` **skips every ledger that has one** (it believes the ledger is complete), and the live syncer does not look
  behind its checkpoint, so a half-dropped ledger is not repaired by re-ingesting its range.
- A ledger with a `ledgers` row but fewer stored transactions than its `tx_count` answers **500** on `/v2/ledgers/{id}`; payments, exchanges and balance changes
  whose tables were dropped just vanish from lists.
- Partition sizes differ: `ledgers`, `transactions` and `payments` are partitioned per **1,000,000** ledgers (P6), the other ten ledger-keyed tables per **10,000,000** (P7),
  and `accounts_created` is not partitioned.

The safe procedure drops **one 10,000,000-ledger block from all 14 ledger-derived tables**: the ten P6 partitions of `ledgers`, `transactions`, `payments`
(`ledgers` first, the commit marker), partition `k` of the ten P7 tables, and a `DELETE ... WHERE ledger_index BETWEEN ...` on `accounts_created`; the exact commands are in
[operations](operations.md#retention). To restore a block run `range-ingest` over the same range (no `ledgers` rows are left, so it ingests everything); to repair
a partial loss use `range-ingest --reprocess` over exactly the damaged range. Dropping a block makes lists in that window empty.

`validations` has a 90-day TTL (`toDateTime(last_datetime) + INTERVAL 90 DAY`); `fee_stats` and the rollups (`stats_hourly`, `volume_*`) are small, keep them.

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
