# ClickHouse — the storage layer

This document covers how the Data API uses ClickHouse, the performance characteristics
that matter, and the path to a highly-available, backed-up production deployment. For the
table/column schema see [data-model.md](data-model.md); for the ingest write path see
[syncer.md](syncer.md).

## Why ClickHouse

The workload is **append-only, time-ordered ledger data** queried two ways: heavy
analytics (OHLC/VWAP candles, volumes, top currencies, daily histograms) and selective
point lookups (tx by hash, ledger by index, account history). That is columnar-OLAP
territory — ClickHouse's home turf — and it is what the old Elasticsearch setup was
weakest at. See [elasticsearch-to-clickhouse.md](elasticsearch-to-clickhouse.md) and
[ADR-0001](adr/0001-use-clickhouse.md).

## The `FINAL` rule — the single most important performance lesson

The tables are `ReplacingMergeTree`, which deduplicates rows **only after a background
merge**. `... FINAL` forces that merge **at query time**, across every part. That is:

- cheap on a **selective single-row** query (`WHERE hash = …  LIMIT 1`), and
- **ruinous on a list/scan** query — it merge-sorts the whole table per request and
  allocates a lot of memory.

We learned this under load: 80 concurrent `FROM payments FINAL ORDER BY date LIMIT 200`
queries drove ClickHouse to **`Memory limit (total) exceeded`** and the API replicas sat
idle waiting on it (p95 ≈ 30 s, ~30 % errors). The *same query without `FINAL`* ran at
**127 QPS, p50 0.44 s, zero errors**.

**Rules, encoded in the code:**

| Query shape | Use `FINAL`? | How dedup is handled instead |
| --- | --- | --- |
| List / range scans (payments, transactions, exchanges, ledgers, account history) | **No** | Background merges collapse transient duplicates; brief duplication on the newest rows is accepted |
| Selective single-row lookup (by hash / index / account, `LIMIT 1`) | **Yes** | Bounded cost; correctness matters immediately |
| Aggregations needing latest-per-key (top currencies / trustlines) | **No** | `argMax(balance, ledger_index)` in a subquery |
| Materialized-view reads (candles, volumes, stats) | **No** | The view's own engine aggregates; use `*Merge` / `sum()` |

> If you ever add a new list endpoint, **do not** write `FINAL` on the scan. See
> [ADR-0003](adr/0003-no-final-on-list-queries.md).

## Memory & safety guards

A single heavy query must never be able to OOM the node. Two layers:

1. **Per-query guards from the app** (`ClickHouseService`): every `SELECT` is sent with
   `max_execution_time` (`GH_CLICKHOUSE_MAX_EXECUTION_TIME`, default 30 s) and, if set,
   `max_memory_usage` (`GH_CLICKHOUSE_MAX_QUERY_MEMORY`, bytes). A runaway query is killed
   rather than taking the node down.
2. **Server-level limits** (set in the ClickHouse config / profile): cap
   `max_server_memory_usage` (or the RAM ratio) and `max_concurrent_queries` so the server
   protects itself regardless of client behavior.

The production compose caps the ClickHouse container at 8 GiB; size this to the box and set
the per-query caps below it. After the `FINAL` removal, normal traffic stays well under it.

## Parts & merges (why batching matters on write)

ClickHouse creates one **part** per insert. The syncer therefore **batches** — it buffers
N ledgers and does one `INSERT` per table per flush (`GH_BACKFILL_BATCH_LEDGERS`, default
500–1000) — instead of the old 11-inserts-per-ledger pattern, which would create hundreds
of tiny parts per second and hit `too many parts`. See [syncer.md](syncer.md#batched-writing).

After a large backfill, parts merge in the background. To force it for a table (e.g. to
collapse `ReplacingMergeTree` duplicates immediately, or reclaim space):

```sql
OPTIMIZE TABLE payments FINAL;          -- collapses duplicates, merges parts (expensive)
```

Check part counts and merge activity:

```sql
SELECT table, count() AS parts, formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts WHERE active AND database = 'xrpl' GROUP BY table ORDER BY parts DESC;

SELECT * FROM system.merges;            -- in-flight merges
SELECT * FROM system.part_log ORDER BY event_time DESC LIMIT 20;
```

## High availability & replication

The shipped schema uses plain `ReplacingMergeTree` (single-node correct). For HA you have
two production-grade paths:

### Option A — ClickHouse Cloud / managed
Simplest. Replication, backups, scaling and upgrades are handled for you. Point
`GH_CLICKHOUSE_URL` at the managed endpoint. Recommended unless you have a reason to self-host.

### Option B — self-hosted Replicated cluster
The production compose already runs **ClickHouse Keeper** and wires the server to it
(`deploy/clickhouse/config.d/cluster.xml` defines `<zookeeper>`, `<macros>` and a cluster).
To make it HA:

1. Switch the table engines from `ReplacingMergeTree` to `ReplicatedReplacingMergeTree`:
   ```sql
   ENGINE = ReplicatedReplacingMergeTree(
     '/clickhouse/tables/{shard}/payments', '{replica}', ledger_index)
   ```
   `{shard}` / `{replica}` come from the `<macros>` in the config. Do this in a new
   migration file so it's tracked.
2. Run **≥ 2 ClickHouse replicas** + an **odd number of Keeper nodes** (3 for real quorum;
   the compose ships 1 for local use).
3. Inserts to any replica propagate via Keeper; reads can hit any replica.

This is a deployment decision, not a code change — the row model and queries are identical.
See [ADR-0001](adr/0001-use-clickhouse.md) and [data-model.md](data-model.md).

## Backups

Pick one; do **not** run production without a tested restore:

- **Managed**: use the provider's automated backups + point-in-time restore.
- **Self-hosted**: [`clickhouse-backup`](https://github.com/Altinity/clickhouse-backup) for
  full/incremental backups to object storage (S3/GCS). Schedule daily full + hourly
  incremental; test restores regularly.
- **Always reproducible from source**: because the data is a deterministic function of the
  XRPL, a total loss can also be recovered by **re-running the backfill** (slower, but a
  real safety net — see [backfill.md](backfill.md)). Backups exist to make recovery *fast*.

## Retention / TTL

`transactions.tx_json` + `meta_json` are the bulk of the data. Month-partitioning makes
retention cheap:

```sql
-- Drop everything older than a cutoff, one partition at a time (O(1) per month):
ALTER TABLE transactions DROP PARTITION '202301';

-- Or a TTL policy (e.g. keep raw transactions 2 years; analytics MVs are tiny, keep forever):
ALTER TABLE transactions MODIFY TTL date + INTERVAL 2 YEAR;
```

Keep the materialized-view tables (candles, daily volumes, stats) effectively forever —
they're small and are the product's analytical value.

## Storage optimization (future)

- **Codecs**: add `CODEC(ZSTD(3))` to the large `String` columns (`tx_json`, `meta_json`)
  for a substantial size reduction. Apply via migration with `ALTER TABLE … MODIFY COLUMN`.
- **Projections / skip indexes**: the list endpoints sort by `date` while the tables are
  primary-keyed on the CTID (≈ ledger order, ≈ chronological). For very large ranges a
  `date`-ordered projection would avoid a full sort. Measure before adding.

## Useful operational queries

```sql
-- table sizes
SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, sum(rows) AS rows
FROM system.parts WHERE active AND database='xrpl' GROUP BY table ORDER BY sum(bytes_on_disk) DESC;

-- slow / heavy queries (needs query_log enabled, default on)
SELECT query_duration_ms, memory_usage, read_rows, substring(query,1,80) AS q
FROM system.query_log WHERE type='QueryFinish' AND event_time > now()-3600
ORDER BY query_duration_ms DESC LIMIT 20;

-- current memory by query
SELECT query_id, formatReadableSize(memory_usage) AS mem, elapsed FROM system.processes ORDER BY memory_usage DESC;

-- replication status (Replicated engines only)
SELECT database, table, is_leader, total_replicas, active_replicas, queue_size
FROM system.replicas;
```

## Connecting

The app connects over the **HTTP interface (8123)** via `@clickhouse/client` using bound
`query_params` (no string interpolation — see [security.md](security.md)). The native
protocol (9000) is used by `clickhouse-client` / `clickhouse-benchmark` for ops. Neither
port is exposed publicly in production — ClickHouse is internal-only.
