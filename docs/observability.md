# Observability

How to monitor the GateHub XRPL Data API in production: metrics, health checks, and
logs. This document describes exactly what the code exposes today, plus recommended
PromQL, dashboards, and alerts built on top of it.

---

## 1. Overview — the three pillars

The platform ships two long-running services — the **API** (`apps/api`, the read tier)
and the **Syncer** (`apps/syncer`, the ingestion worker) — backed by **ClickHouse**.
Three of the observability pillars are wired up:

| Pillar | Surface | Where |
| --- | --- | --- |
| **Metrics** | Prometheus text exposition on `GET /metricz` | both services |
| **Health** | Terminus health check on `GET /liveliness/healthz` | both services |
| **Logs** | Structured/pretty stdout via env (`GH_LOGGER_FORMAT` / `GH_LOGGER_LEVEL`) | both services |

> **No distributed tracing yet.** There is no OpenTelemetry / trace-context propagation
> in the codebase today, and no request-scoped correlation IDs. Both are tracked as
> backlog (see [§8](#8-gaps--backlog)).

Both services run an HTTP server even though the syncer is "just" a worker — it boots an
HTTP listener purely so orchestrators can probe `/liveliness/healthz` and scrape
`/metricz` (`apps/syncer/src/main.ts`).

---

## 2. Health checks

Both services expose an identical health endpoint, implemented with `@nestjs/terminus`:

- **Endpoint:** `GET /liveliness/healthz`
- **API:** served on the main HTTP port — `GH_HTTP_API_PORT`, default **3001**
  (`apps/api/src/config/api.config.ts`).
- **Syncer:** served on `GH_HTTP_API_PORT`, default **3002** (`apps/syncer/src/main.ts`).

### What it checks

A single health indicator that **pings ClickHouse**
(`apps/{api,syncer}/src/modules/liveliness/liveliness.service.ts`). It calls
`ClickHouseService.ping()` (`packages/shared/src/clickhouse/clickhouse.service.ts`); any
thrown error is swallowed and treated as "not ok". So the endpoint answers one question:
**can this service reach ClickHouse?**

### Response shape

Terminus returns its standard envelope. Healthy → **HTTP 200**:

```json
{
  "status": "ok",
  "info":  { "clickhouse": { "status": "up" } },
  "error": {},
  "details": { "clickhouse": { "status": "up" } }
}
```

ClickHouse unreachable → **HTTP 503**:

```json
{
  "status": "error",
  "info":  {},
  "error": { "clickhouse": { "status": "down" } },
  "details": { "clickhouse": { "status": "down" } }
}
```

### How container healthchecks use it

`docker-compose.prod.yaml` defines a healthcheck on both the `api` and `syncer` services.
The base image (`node:slim`) ships without `wget`/`curl`, so the check uses Node's global
`fetch` and exits non-zero unless the response is `ok` (2xx):

```yaml
# syncer
test: ['CMD', 'node', '-e', "fetch('http://localhost:3002/liveliness/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# api
test: ['CMD', 'node', '-e', "fetch('http://localhost:3001/liveliness/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# interval: 15s, timeout: 5s, retries: 5
```

### How k8s / orchestrators should use it

Because the check is shallow (a ClickHouse ping) and cheap, it is suitable for both
probe types:

- **Liveness probe** — restart the pod if the process is wedged. Be slightly lenient
  (a few retries) so a transient ClickHouse blip doesn't trigger a restart loop.
- **Readiness probe** — pull the pod out of the load-balancer rotation while it can't
  reach ClickHouse. For the API this is the important one: a replica that can't reach
  ClickHouse can serve nothing useful, so it should leave rotation until the DB is back.

```yaml
livenessProbe:
  httpGet: { path: /liveliness/healthz, port: 3001 }   # 3002 for the syncer
  periodSeconds: 15
  timeoutSeconds: 5
  failureThreshold: 5
readinessProbe:
  httpGet: { path: /liveliness/healthz, port: 3001 }
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 3
```

> The syncer has no separate "ingestion is healthy" probe — `/liveliness/healthz` only
> reports ClickHouse reachability, not ingest progress. Use the syncer **metrics**
> ([§4](#4-metrics--syncer)) and alerts ([§6](#6-suggested-dashboards--alerts)) to detect
> a stalled or lagging syncer.

---

## 3. Metrics — API

- **Endpoint:** `GET /metricz` on the API's HTTP port (default **3001**).
- **Content type:** `text/plain; version=0.0.4; charset=utf-8` (Prometheus exposition).
- Backed by a single `prom-client` `Registry`
  (`apps/api/src/modules/prometheus/prometheus.service.ts`), exposed via the controller
  (`prometheus.controller.ts`) and a `@Global()` module (`prometheus.module.ts`).

### Metrics exposed

**1. Default process metrics**, registered with the prefix `api_`
(`collectDefaultMetrics({ prefix: 'api_' })`). These are the standard `prom-client`
Node.js process metrics, e.g. CPU, resident/heap memory, the Node event-loop lag,
GC stats, open file descriptors, and active handles/requests:

```
api_process_cpu_user_seconds_total
api_process_resident_memory_bytes
api_nodejs_eventloop_lag_seconds
api_nodejs_gc_duration_seconds
api_nodejs_active_handles
...  (full set provided by prom-client)
```

**2. `api_http_requests_total`** — a **Counter** of HTTP requests handled, labelled
`{method, route, status}`.

**3. `api_http_request_duration_seconds`** — a **Histogram** of request duration in
seconds, labelled `{method, route, status}`, with buckets:

```
0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5
```

Both are populated by a **global interceptor**, `MetricsInterceptor`
(`apps/api/src/common/metrics.interceptor.ts`), wired in `app.module.ts` as an
`APP_INTERCEPTOR`. On every HTTP request it times the handler with
`process.hrtime.bigint()` and, on completion, increments the counter and observes the
histogram.

### Labels use the route *pattern*, not the raw URL

The `route` label is `req.route?.path` — the Express route **pattern**
(e.g. `/v1/accounts/:address/transactions`), **not** the concrete URL. This is a
deliberate cardinality-safety choice: labelling by raw path would explode the metric
series count (one per account address, ledger index, etc.). If no route pattern is
available it falls back to `req.path`, then `'unknown'`. `status` is the numeric HTTP
status code as a string.

### Example PromQL

Request rate per route:

```promql
sum by (route) (rate(api_http_requests_total[5m]))
```

Error rate (server errors as a fraction of all requests):

```promql
sum(rate(api_http_requests_total{status=~"5.."}[5m]))
  /
sum(rate(api_http_requests_total[5m]))
```

p95 request latency (across all routes) from the histogram:

```promql
histogram_quantile(
  0.95,
  sum by (le) (rate(api_http_request_duration_seconds_bucket[5m]))
)
```

p95 latency **per route** (add `route` to the grouping):

```promql
histogram_quantile(
  0.95,
  sum by (le, route) (rate(api_http_request_duration_seconds_bucket[5m]))
)
```

Rate-limit (HTTP 429) rate:

```promql
sum(rate(api_http_requests_total{status="429"}[5m]))
```

---

## 4. Metrics — Syncer

- **Endpoint:** `GET /metricz` on the syncer's HTTP port (`GH_HTTP_API_PORT`, default
  **3002**).
- **Content type:** `text/plain; version=0.0.4; charset=utf-8`.
- Backed by its own `prom-client` `Registry`
  (`apps/syncer/src/modules/prometheus/prometheus.service.ts`).

### Metrics exposed

**1. Default process metrics**, prefix `syncer_`
(`collectDefaultMetrics({ prefix: 'syncer_' })`) — same Node.js process metrics as the
API but under the `syncer_` namespace (`syncer_process_resident_memory_bytes`,
`syncer_nodejs_eventloop_lag_seconds`, etc.).

**2. `syncer_latest_synced_ledger`** — a **Gauge**: the highest ledger index written to
ClickHouse.

**3. `syncer_ledgers_processed_total`** — a **Counter**: total ledgers processed since
process start (the `_total` suffix follows the Prometheus counter convention).

### Where these are updated

In `apps/syncer/src/sync/sync-processor.service.ts`:

- **Backfill** (`backfill()`): after each ledger is enqueued/flushed, the counter is
  incremented (`ledgersProcessed.inc()`) and, when a ledger index exceeds the running
  max, the gauge is set (`latestSyncedLedger.set(index)`). Because backfill runs a worker
  pool over a `[from, to]` range, the gauge tracks the **max index seen this run**, not
  necessarily live head.
- **Live sync** (`subscribeLive()`): for every ledger consumed off the `ledger$` stream,
  the gauge is set to that ledger index and the counter is incremented.

> Note: the gauge reflects what *this process* has advanced to since boot. With sharded
> or multiple syncer instances, scrape each instance separately (per-`instance` series)
> rather than assuming one global value.

### Example PromQL

Ingest rate (ledgers/sec):

```promql
rate(syncer_ledgers_processed_total[5m])
```

How far behind XRPL head the syncer is — requires an externally-scraped "current XRPL
ledger" series (e.g. exported from your rippled / a sidecar). Given a metric
`xrpl_validated_ledger_index`:

```promql
xrpl_validated_ledger_index - syncer_latest_synced_ledger
```

Detect a stalled syncer (no progress for 10 minutes):

```promql
rate(syncer_ledgers_processed_total[10m]) == 0
```

---

## 5. Logging

Both services log through the NestJS `Logger` (`@nestjs/common`) — see the `Logger`
instances in `apps/{api,syncer}/src/main.ts` and throughout the services. Output is
plain stdout/stderr; in production capture it with your container/log pipeline.

Two environment variables (toolbox conventions, documented in
[docs/configuration.md](./configuration.md)) control output:

| Variable | Values | Dev default | Prod default | Purpose |
| --- | --- | --- | --- | --- |
| `GH_LOGGER_FORMAT` | `pretty` \| `structured` | `pretty` | `structured` | Output format. |
| `GH_LOGGER_LEVEL` | `debug` \| `info` \| `warn` \| `error` … | `debug` | `info` | Minimum level. |

**Recommendation for production:** `GH_LOGGER_FORMAT=structured` and
`GH_LOGGER_LEVEL=info`. Structured (JSON) logs are parseable by Loki/Elasticsearch/etc.;
`info` keeps volume sane while preserving operational events (backfill progress, live
ledger failures, health/metric errors).

What you get in the logs today, by way of example:

- API bootstrap line (`Data API listening on …`).
- Syncer backfill progress (`Backfilled N ledgers (X/s), cursor …`), completion summary,
  and any permanently-failed ledger indices.
- Live-sync per-ledger failures (`Live ledger N failed: …`).
- `/metricz` failures (logged before returning 500).

> **No correlation IDs yet.** Logs are not stamped with a per-request trace/correlation
> ID, so you cannot currently stitch a single client request across log lines (or across
> services). This is backlog (see [§8](#8-gaps--backlog)).

---

## 6. Suggested dashboards & alerts

Build an API **RED** dashboard (Rate / Errors / Duration) from
`api_http_requests_total` and `api_http_request_duration_seconds`, a syncer **ingest**
dashboard from `syncer_ledgers_processed_total` / `syncer_latest_synced_ledger`, and a
**USE**-style resource dashboard from the `*_process_*` / `*_nodejs_*` default metrics.

### Monitoring ClickHouse itself

The `/liveliness/healthz` check only tells you the app can *reach* ClickHouse — it says
nothing about the DB's internal health (memory, disk, merges, replication). Scrape
ClickHouse directly via either:

- ClickHouse's **built-in Prometheus endpoint** (configure `<prometheus>` in
  `config.d`, exposed on its own port), or
- a **`clickhouse-exporter`** sidecar that queries `system.*` tables.

Either way you get series like memory usage, disk free, parts counts, merge activity,
and (for the replicated setup with Keeper) replication queue depth. Wiring this is
backlog ([§8](#8-gaps--backlog)).

### Recommended alerts

| Alert | Condition (sketch) | Why |
| --- | --- | --- |
| **API 5xx rate high** | `sum(rate(api_http_requests_total{status=~"5.."}[5m])) / sum(rate(api_http_requests_total[5m])) > 0.05` for 5m | Read tier failing requests. |
| **API p95 latency high** | `histogram_quantile(0.95, sum by (le)(rate(api_http_request_duration_seconds_bucket[5m]))) > 1` for 10m | Slow queries / DB pressure. |
| **API 429 spike** | `sum(rate(api_http_requests_total{status="429"}[5m]))` above baseline | Rate-limit storms / abusive client / misconfigured limits. |
| **Liveliness down (API)** | `/liveliness/healthz` probe failing or `up{job="api"} == 0` | API can't reach ClickHouse / is down. |
| **Liveliness down (syncer)** | syncer probe failing or `up{job="syncer"} == 0` | Syncer down. |
| **Syncer ingest stalled** | `rate(syncer_ledgers_processed_total[10m]) == 0` for N min (while not idle/finished) | Ingestion wedged. |
| **Syncer falling behind head** | `xrpl_validated_ledger_index - syncer_latest_synced_ledger > 50` for 10m | Live sync lagging XRPL. |
| **ClickHouse memory high** | from CH exporter, e.g. memory tracked / limit > 0.9 | OOM risk (compose limits CH to 8g). |
| **ClickHouse disk low** | from CH exporter, free bytes below threshold | Ingestion will fail when disk fills. |
| **ClickHouse too many parts** | from CH exporter, parts-per-partition above threshold | Merges falling behind (see §7). |

(Threshold numbers above are starting points — tune to your traffic and SLOs.)

---

## 7. What to watch during a backfill

A backfill replays a large `[from, to]` ledger range through a worker pool and bulk-loads
ClickHouse hard (see [docs/backfill.md](./backfill.md)). Watch both sides:

**Syncer side (from `/metricz`):**

- **`rate(syncer_ledgers_processed_total[5m])`** — the live ingest throughput. Compare
  against the `Backfilled N ledgers (X/s)` log lines. A sustained drop signals XRPL-node
  rate-limiting, ClickHouse back-pressure, or retries.
- **`syncer_latest_synced_ledger`** — should climb monotonically toward `to`. During
  backfill it tracks the max index seen this run.
- **`syncer_process_*` / `syncer_nodejs_eventloop_lag_seconds`** — memory growth and
  event-loop lag indicate the worker pool / batch size is too aggressive.

**ClickHouse side (from CH's own metrics / `system` tables):**

- **Parts & merges** — heavy inserts create many parts; watch the active **parts count**
  per partition and **background merge** activity (`system.merges`,
  `system.metrics`/`system.asynchronous_metrics`). If parts pile up faster than merges
  drain them you risk a "too many parts" error and stalled inserts — throttle the
  backfill (workers / batch size) if so.
- **Memory & disk** — bulk loads are the most likely time to hit the 8 GB container
  memory limit or fill the data volume. Alert on both before they hard-fail.

---

## 8. Gaps / backlog

Known observability gaps, roughly in priority order:

1. **Distributed tracing** — no OpenTelemetry / trace-context propagation. Adding OTel
   (HTTP + ClickHouse client spans) would give per-request, cross-service traces.
2. **Log correlation IDs** — requests are not stamped with a request/trace ID, so log
   lines can't be tied to a single request or followed across services. Add a
   request-scoped ID (ideally the same trace ID once OTel lands).
3. **Dashboards as code** — ship the RED (API) / USE (resource) / ingest (syncer)
   dashboards as versioned Grafana JSON / provisioning rather than hand-built.
4. **ClickHouse exporter wiring** — the DB is not yet scraped. Wire ClickHouse's built-in
   Prometheus endpoint or a `clickhouse-exporter` so memory/disk/parts/merges/replication
   feed the alerts in [§6](#6-suggested-dashboards--alerts).
