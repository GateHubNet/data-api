# Operations runbook

Day-2 operations for the GateHub Data API: routine tasks, scaling, backfill operations,
monitoring, and incident playbooks. See [deployment.md](deployment.md) for how it's
deployed and [observability.md](observability.md) for the full metrics/health detail.

## At a glance

| Thing | Where |
| --- | --- |
| API health | `GET /liveliness/healthz` (200 ok / 503 down — pings ClickHouse) |
| API metrics | `GET /metricz` (Prometheus) |
| Syncer health/metrics | `GET /liveliness/healthz` and `/metricz` on `:3002` |
| API docs | `GET /internal/docs` (Swagger UI), `/internal/docs/json` |
| Apply schema | `pnpm ch:migrate` (or the one-shot `migrate` job) |
| Ingest progress | `syncer_latest_synced_ledger`, `rate(syncer_ledgers_processed_total[5m])` |

## Routine tasks

### Deploy a new version
1. Build images ([deployment.md](deployment.md#build)).
2. Run the `migrate` job (only matters if the release adds/changes schema).
3. Roll `api` replicas (readiness gates traffic). Roll `syncer` last.

### Apply a schema migration
Migrations are tracked `*.sql` files in `packages/shared/schema/`. Add a new
`NNN_*.sql` and run the migrate job / `pnpm ch:migrate`. It's idempotent (`IF NOT EXISTS`)
and records applied files in `schema_migrations`. Never edit an already-applied file —
add a new one. See [data-model.md](data-model.md#migrations).

### Rotate an API key
API keys are `GH_API_KEYS` (comma-separated). To rotate with zero downtime: add the new key
alongside the old (`old,new`), roll the api, switch clients, then remove the old key and
roll again. Keys are read at boot, so a roll is required to pick up changes.

### Rotate the ClickHouse password
Update `GH_CLICKHOUSE_PASSWORD` in the secret and the ClickHouse user, then roll api + syncer.

### Force-merge / reclaim space after a big backfill
```sql
OPTIMIZE TABLE payments FINAL;     -- per table; collapses ReplacingMergeTree duplicates
```
See [clickhouse.md](clickhouse.md#parts--merges-why-batching-matters-on-write).

### Retention
Drop old raw data a month at a time (analytics MVs are tiny — keep them):
```sql
ALTER TABLE transactions DROP PARTITION '202301';
```

## Backfill operations

Full guidance (node choice, sizing, the "run your own rippled?" question) is in
[backfill.md](backfill.md); the mechanics are in [syncer.md](syncer.md). Operational quick
reference:

### Start a backfill
Set on the syncer: `GH_BACKFILL_ENABLED=true`, `GH_BACKFILL_START_LEDGER` /
`GH_BACKFILL_END_LEDGER`, `GH_BACKFILL_WORKERS` (raise on your own node), `GH_FETCH_THROTTLE_MS=0`
(own node) and a healthy `GH_BACKFILL_BATCH_LEDGERS` (500–2000). Watch:
```promql
rate(syncer_ledgers_processed_total[5m])      # ledgers/sec
syncer_latest_synced_ledger                   # cursor
```

### Speed it up
Raise `GH_BACKFILL_WORKERS` until ledgers/sec plateaus (node-bound), then **shard**: run N
instances with `GH_BACKFILL_SHARD_INDEX=0..N-1`, `GH_BACKFILL_SHARD_TOTAL=N`, each on its own
node. Throughput scales ~linearly until ClickHouse-write-bound.

### Repair gaps
Errored ledgers are logged at the end of a run (`… ledgers failed and were not indexed: …`).
Re-run the syncer with `GH_BACKFILL_START_LEDGER`/`END_LEDGER` narrowed to those ranges —
re-ingestion is idempotent, so it only fills the gaps.

### Resume after a restart
Just restart it. The syncer re-derives what's already in ClickHouse (windowed `ledgers`
query) and skips it. No double counting.

## Scaling

| Symptom | Action |
| --- | --- |
| API latency/throughput limited, ClickHouse has headroom | Add api replicas (stateless) |
| ClickHouse CPU/memory saturated | Scale ClickHouse (RAM/CPU), add read replicas, check for a `FINAL` regression on a list query |
| Backfill too slow | More workers, bigger batch, throttle 0 on own node, then shard |
| 429s from clients | Raise `GH_RATE_LIMIT` only after confirming the backend keeps up; confirm the limit is per-real-client-IP (trust proxy) not per-proxy |

## Load & capacity testing

Tools live in [`load/`](../load/) (k6 script + ClickHouse seeder). See
[`load/README.md`](../load/README.md).

- Run k6 from a **separate machine** against a real (multi-host) deployment for meaningful
  numbers — co-locating the load generator with the stack on one box measures the box, not
  the service.
- Before testing, raise `GH_RATE_LIMIT` (the limiter otherwise dominates) and consider
  pausing the syncer to isolate read performance.
- The biggest perf lever is **not using `FINAL` on scans** — confirmed ~6× throughput / ~10×
  latency improvement. See [clickhouse.md](clickhouse.md#the-final-rule).

## Incident playbooks

### API returning 503 on /liveliness/healthz
ClickHouse ping is failing. Check: ClickHouse up and reachable from the api network?
(`curl http://clickhouse:8123/ping` from a pod on the same network). Check ClickHouse
memory/disk. The api itself is fine — it's the dependency.

### API 5xx spike (problem+json 500s)
Check api logs (5xx detail is logged server-side, not returned). Most likely ClickHouse:
a heavy/slow query, memory pressure, or a `FINAL` on a list path. Inspect
`system.query_log` for slow/aborted queries; check `system.processes` for memory hogs.

### API latency high but replicas idle (low CPU)
Classic "blocked on ClickHouse" signature (we hit this). The replicas wait on query
responses. Check ClickHouse memory (`Memory limit exceeded` in CH logs) and concurrency —
almost always a `FINAL`-on-scan regression or an unbounded query. Fix the query; set the
per-query guards (`GH_CLICKHOUSE_MAX_QUERY_MEMORY` / `_MAX_EXECUTION_TIME`).

### ClickHouse "too many parts"
The writer is inserting too frequently in small batches. For the syncer, raise
`GH_BACKFILL_BATCH_LEDGERS`. Let merges catch up; `OPTIMIZE` if needed.

### Syncer ingest stalled (rate == 0)
Check syncer logs and `/liveliness/healthz`. Causes: XRPL node down/unreachable (it
auto-reconnects — check the endpoint), ClickHouse down, or backfill finished (expected for a
bounded range). For live sync, confirm it re-subscribed after any reconnect.

### Syncer falling behind the chain head
`current XRPL ledger − syncer_latest_synced_ledger` growing. Live sync is single-consumer;
if a ledger is genuinely slow to process it queues. Check ClickHouse write latency and the
XRPL node. (Live load is ~1 ledger / 3–4 s — falling behind usually means a downstream
problem, not throughput.)

### Schema migration failed
The migrate job is idempotent — re-run it. If a statement genuinely failed (bad DDL in a new
file), fix the `*.sql` and re-run; already-applied files are skipped via `schema_migrations`.

## Backup & restore
See [clickhouse.md](clickhouse.md#backups). Two layers: real backups (`clickhouse-backup` or
managed snapshots) for fast restore, and the XRPL itself as the ultimate source (re-backfill).
**Test restores regularly.**

## Known operational gotchas
Collected in [troubleshooting.md](troubleshooting.md) — `FINAL` OOM, container healthcheck
needing `node fetch` (no wget in slim image), ClickHouse `listen_host` when mounting
`config.d`, Keeper healthcheck flags, pnpm `deploy --legacy`, `.tsbuildinfo` in Docker.
