# Load & capacity testing

Two dimensions matter for this system: **API read throughput/latency** and **syncer
ingest throughput**. They're tested separately.

## 1. API read load (k6)

```bash
# a) build the workspace (the seeder uses the compiled shared client)
pnpm build

# b) start ClickHouse + apply schema
docker compose up -d clickhouse
pnpm ch:migrate

# c) seed realistic data (2M payments here; takes a few minutes)
GH_CLICKHOUSE_URL=http://localhost:8123 node load/seed.js 2000000

# d) run the API with a known key
GH_API_KEYS=test-key-123 pnpm start:api

# e) run the load test (install k6 first: `brew install k6`)
BASE_URL=http://localhost:3001 API_KEY=test-key-123 k6 run load/api-load.js
```

`api-load.js` ramps 0→500 virtual users across the list, stats, volume and candle
endpoints. Thresholds (the test **fails** if breached):

- `http_req_duration p95 < 500ms`, `p99 < 1500ms`
- error rate `< 1%`

Tune the `stages` and `thresholds` to your SLO. Watch the API's `/metricz`
(`api_http_request_duration_seconds`) and ClickHouse's own metrics during the run.

### What to look for
- **p95/p99 latency** vs concurrency — where does it knee?
- **ClickHouse CPU / memory** — candle and volume queries hit materialized views and
  should stay cheap; raw `payments`/`transactions` scans grow with the time window.
- If latency degrades: add ClickHouse replicas (scale reads), raise `GH_RATE_LIMIT`
  only after confirming the backend keeps up, and ensure hot endpoints are cached.

## 2. Syncer ingest throughput

The syncer is network-bound on the XRPL node, then ClickHouse-bound on writes. Measure
with the built-in Prometheus gauges rather than a synthetic tool:

```bash
# point at your node, pick a fixed range, then watch the rate
GH_BACKFILL_START_LEDGER=80000000 GH_BACKFILL_END_LEDGER=80100000 \
GH_BACKFILL_WORKERS=16 GH_BACKFILL_BATCH_LEDGERS=1000 GH_FETCH_THROTTLE_MS=0 \
pnpm start:syncer

# in another shell, scrape progress:
watch -n5 'curl -s localhost:3002/metricz | grep syncer_'
```

`syncer_ledgers_processed_total` over time gives ledgers/sec. To find the ceiling:
- raise `GH_BACKFILL_WORKERS` until ledgers/sec stops improving (node-bound), then
- shard across instances (`GH_BACKFILL_SHARD_TOTAL`) and/or add XRPL nodes.

Capacity-plan the backfill from the measured rate: `~57,000,000 / (ledgers_per_sec)`
seconds for two years (see ../docs/backfill.md).

## 3. ClickHouse query micro-benchmarks (optional)

For pure DB capacity, `clickhouse-benchmark` against the seeded data isolates the
storage layer from the API:

```bash
echo "SELECT currency, sum(total_amount) FROM payment_volume_daily GROUP BY currency" \
  | clickhouse-benchmark --host localhost --port 9000 -i 1000 -c 16
```
