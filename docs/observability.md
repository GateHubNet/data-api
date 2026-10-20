# Observability

How to monitor the Data API in production: metrics, health checks and logs. This page describes what the code exposes today, plus
recommended PromQL and alerts built on it. Day-2 procedures are in [operations](operations.md).

## 1. Overview

Two long-running services per network, the **API** (`apps/api`) and the **syncer** (`apps/syncer`), backed by ClickHouse. Both run
two HTTP listeners:

| Surface | API | Syncer |
| --- | --- | --- |
| Health: `GET /liveliness/healthz` (main port, `GH_HTTP_API_PORT`) | `3001` | `3002` |
| Metrics: `GET /metricz` (second app, `GH_METRICZ_PORT`) | `3000` | `3000` |
| Logs | stdout | stdout |

The metrics ports are reachable **inside the compose network only** (never publish them; the dev compose maps them to 127.0.0.1:
api-xrpl 3003, syncer-xrpl 3004, api-xahau 3013, syncer-xahau 3014). In production scrape `api-xrpl:3000`, `syncer-xrpl:3000`, ... from a
Prometheus on the same network (use Docker DNS service discovery for scaled api replicas). There is no distributed tracing or
request correlation id yet ([gaps](#8-gaps-and-backlog)).

## 2. Health checks

Implemented with `@nestjs/terminus`; no API key and no rate limit.

### API

`GET /liveliness/healthz` pings ClickHouse (`ClickHouseService.ping()`; any error counts as "not ok"). It answers one question: can
this replica reach ClickHouse?

```json
{ "status": "ok", "info": { "clickhouse": { "status": "up" } }, "error": {}, "details": { "clickhouse": { "status": "up" } } }
```

ClickHouse unreachable: **503** with the same body shape, `"status": "error"` and the failed indicator under `error`:

```json
{ "status": "error", "info": {}, "error": { "clickhouse": { "status": "down" } }, "details": { "clickhouse": { "status": "down" } } }
```

### Syncer

The same ClickHouse check, plus an **`ingest`** indicator when the `ingest` worker is enabled:

```json
{ "status": "ok",
  "info": { "clickhouse": { "status": "up" },
            "ingest": { "status": "up", "state": "live", "lag": 0, "last_commit_age": 3 } } }
```

It answers **503** when ClickHouse is down, when the ingest `state` is `halted` (a chain break, a ledger the parser rejects, or a lost lease), or when `lag` (validated
head minus committed checkpoint, in ledgers) has stayed above `GH_MAX_LAG_HEALTHY` (default 10) on every probe for more than **60 s**.
`state` is `starting`, `catching_up`, `live` or `halted`; `last_commit_age` is seconds since the last commit; `recovering: true` and
`error` appear while a failed write or the boot cleanup is being recovered. A lag the runner has not measured yet counts as healthy,
and a spike that is gone by the next probe resets the window. During a large catch-up or a backfill the probe therefore turns 503: that
is informational and nothing restarts on it.

A 503 carries the same detail as a 200, so the body says why: the failed indicator moves from `info` to `error` with
`"status": "down"`, a `message`, and the same `state`, `lag`, `last_commit_age` and `error` fields; `details` holds every
indicator, up or down. For example a runner halted on a chain break (the body of the syncer e2e test, hashes shortened):

```json
{ "status": "error",
  "info": { "clickhouse": { "status": "up" } },
  "error": { "ingest": { "status": "down", "state": "halted", "lag": 10, "last_commit_age": 0,
                         "error": "Ledger 83000011 has parent_hash 32DD4CF3...2C24, but ledger 83000010 has hash 3AE10F12...C0E",
                         "message": "halted" } },
  "details": { "clickhouse": { "status": "up" },
               "ingest": { "status": "down", "state": "halted", "lag": 10, "last_commit_age": 0,
                           "error": "Ledger 83000011 has parent_hash 32DD4CF3...2C24, but ledger 83000010 has hash 3AE10F12...C0E",
                           "message": "halted" } } }
```

A syncer whose workers read from the node (`ingest`, `fee_stats`, `validators`) opens its probe port only after its node connection is up and
the boot network check has passed (it is retried until it does), so an unreachable node shows as a failing healthcheck
(`start_period` 60 s in compose). A syncer without such a worker (`GH_WORKERS=aggregator`) makes no node connection at all.

### Container healthchecks and orchestrators

The base image has no `wget`/`curl`, so the compose healthchecks use Node's `fetch` against `127.0.0.1` (every 15 s, 5 s timeout, 5
retries):

```yaml
test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3001/liveliness/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]   # api; 3002 for the syncer
```

The check is cheap, so it suits both liveness (be lenient: a ClickHouse blip must not cause a restart loop) and readiness (a replica
that cannot reach ClickHouse serves nothing useful; it should leave rotation). For the syncer, prefer to alert on the metrics below
rather than to restart on the probe. The shipped nginx lets `/liveliness/` through to trusted proxies only.

## 3. Metrics: API

Prefix `api_`; one `prom-client` registry per process.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `api_http_requests_total` | Counter | `method, route, status` | Requests handled |
| `api_http_request_duration_seconds` | Histogram | `method, route, status` | Duration; buckets 0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5 s |
| `api_node_rate_limited_total` | Counter | `endpoint` | Pauses a node asked for with a rate-limit answer; while every endpoint is paused `/balances` and `/orders` fail at once (500) |
| `api_tx_encode_fallback_total` | Counter | `mode` (`json` / `binary`) | Transactions served as their stored JSON because the binary codec could not serialize them (a type or field missing from the definitions). Should be 0 |
| `api_rates_on_read_total` | Counter | | Asset-days valued with `dailyNativeRates` because `native_rates_daily` had no valid set for the day (today, yesterday until it is final, and every day of a deployment still back-filling the rates). Each valuation call adds the number of asset-days it computed; a rate kept in the 60 s cache is not computed, nor counted, again. It falls to a few a minute once `syncer_rates_daily_missing_days` is 0 |
| `api_account_day_groups_total` | Counter | `source` (`raw` / `rollup`) | Day-group reads of the account aggregates by the source they used: one count per source per read, so a read that serves the days a heavy account's rollups cover and the days after them counts both. `rollup` should follow the heavy accounts' traffic; a heavy account that only ever counts `raw` has no coverage yet (`syncer_account_rollups_pending_accounts`) |
| `api_process_*`, `api_nodejs_*` | | | Default process metrics (CPU, memory, event-loop lag, GC, handles) |

The `route` label is the Express route **pattern** (`/v2/accounts/:address/transactions`), never the concrete URL, so the series count
stays bounded; without a pattern it falls back to the path, then `unknown`. The request counter and histogram are recorded by a global
interceptor, i.e. for requests that reach a handler: a 401 or 429 raised by a guard never reaches it and is not counted in these
series.

```promql
sum by (route) (rate(api_http_requests_total[5m]))                                       # request rate per route
sum(rate(api_http_requests_total{status=~"5.."}[5m])) / sum(rate(api_http_requests_total[5m]))   # error ratio
histogram_quantile(0.95, sum by (le, route) (rate(api_http_request_duration_seconds_bucket[5m])))   # p95 per route
rate(api_tx_encode_fallback_total[15m]) > 0                                              # codec definitions need attention
```

## 4. Metrics: Syncer

Prefix `syncer_`.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `syncer_checkpoint_ledger` | Gauge | | Highest ledger index committed to ClickHouse |
| `syncer_head_ledger` | Gauge | | Latest validated ledger index known from the node |
| **`syncer_lag_ledgers`** | Gauge | | Validated head minus the committed checkpoint, in ledgers |
| `syncer_last_commit_timestamp_seconds` | Gauge | | Unix time of the last commit |
| **`syncer_last_commit_age_seconds`** | Gauge | | Seconds since the last commit, computed at scrape time; `NaN` before the first commit |
| `syncer_node_rate_limited_total` | Counter | `endpoint` | Pauses a node asked for with a rate-limit answer (host only, no credentials); nothing goes to that node while one lasts |
| `syncer_ingest_halts_total` | Counter | `reason` | Times the live ingest halted until an operator intervenes (`chain_break`, `parse_error`, `lease_lost`) |
| `syncer_validations_flushed_total` | Counter | | Validation rows flushed to ClickHouse |
| `syncer_validations_errors_total` | Counter | `stage` | Collector failures (`flush`, `reporter`, `manifest_rpc`, ...) |
| `syncer_validations_dropped_total` | Counter | `reason` | Validations not kept (`buffer_full`, `no_reporter`, `manifest_no_reporter`, `invalid`, `shutdown`) |
| `syncer_fee_stats_samples_total` | Counter | | Fee snapshots written |
| `syncer_fee_stats_errors_total` | Counter | | Snapshots that failed (node silent, ClickHouse refused) |
| `syncer_aggregator_runs_total` | Counter | `job` | Aggregator job runs (`volume_live`, `volume_daily`, `pair_hourly`, `markets_live`, `stats_live`, `stats_dirty`, `rates_daily`, `account_rollups`, `volume_backfill`) |
| `syncer_aggregator_errors_total` | Counter | `job` | Jobs (or slices) that failed; each is retried on the next tick. The four account and market jobs count under their own names; a failing `agg_dirty` hook counts as `rates_daily_dirty`, `pair_hourly_dirty` or `account_rollups_dirty` and fails its `stats_dirty` slice |
| **`syncer_aggregator_stats_lag_seconds`** | Gauge | | Seconds of ledger history the stats catch-up still has to cover; 0 when the stats are up to the last two hours |
| **`syncer_rates_daily_missing_days`** | Gauge | | Closed final days without a valid rates set, from the first native trade to the newest final day. 0 once the back-fill is done, and normally 0 after it: the day that has just become final (an hour after its end) is the first the next run computes |
| **`syncer_pair_hourly_missing_hours`** | Gauge | | Hours of the last 31 days without a set of the current config version. 0 once the back-fill is done |
| **`syncer_markets_live_age_seconds`** | Gauge | `period` (`day`, `7day`, `30day`) | Now minus the `end_time` of the newest `include` set of the period, set after every run of the job. The `day` set is rewritten every minute (under about 120 s), the others every five minutes (`MARKETS_LONG_EVERY_TICKS`), so theirs climbs to about 240-300 s before each rewrite (360 s if a tick was skipped); a long set that failed waits 5 minutes and so usually misses its next turn, which takes its age to about 900 s once. A period that never had a set has no series |
| `syncer_account_rollups_heavy_accounts` | Gauge | | Heavy accounts (those with `GH_ACCOUNT_ROLLUP_MIN_ROWS` balance changes or more) |
| **`syncer_account_rollups_pending_accounts`** | Gauge | | Heavy accounts whose coverage does not yet reach from `first_day` to the newest final day. 0 once the promotion is done |
| `syncer_validators_unl_fetches_total` | Counter | `publisher, outcome` | Validator list fetches: `ok`, `unchanged`, or the reason code of the failure |
| **`syncer_validators_unl_expiry_seconds`** | Gauge | `publisher` | Seconds until the current list of a publisher expires (negative when it expired) |
| `syncer_validators_unl_size` | Gauge | `publisher` | Validators on the current list of a publisher |
| `syncer_validators_domain_checks_total` | Counter | `outcome` | Domain checks: `verified`, or the reason code of the failure |
| `syncer_validators_node_polls_total` | Counter | `request, outcome` | Node polls of the validators worker: `request` is `amendments`, `negative_unl`, `fee_settings`, `server_info` or `feature`; `outcome` is `ok` or `error` |
| **`syncer_validators_jobs_total`** | Counter | `job, outcome` | Runs of the `rounds` and `agreement` jobs, `ok` or `error` |
| **`syncer_validators_agreement_lag_seconds`** | Gauge | | Now minus the end of the newest final hour of validator agreement |
| **`syncer_validators_rounds_lag_ledgers`** | Gauge | | Newest committed voting ledger minus the newest stored amendment voting round |
| **`syncer_amendments_without_metadata`** | Gauge | | Amendments seen (node, ledger, votes) without an entry in the amendment metadata file |
| `syncer_validator_validations_flushed_total` | Counter | `table` | Rows written to `validator_validations` and `validator_seen` |
| `syncer_process_*`, `syncer_nodejs_*` | | | Default process metrics |

The `syncer_validators_*` and `syncer_amendments_*` metrics are set by the `validators` worker, `syncer_validator_validations_flushed_total`
by the validations collector. A labelled metric has no series until its first observation: a publisher that was never fetched has no
`syncer_validators_unl_*` series. The three unlabelled gauges (`syncer_validators_agreement_lag_seconds`,
`syncer_validators_rounds_lag_ledgers`, `syncer_amendments_without_metadata`) read 0 until the `validators` worker first sets them,
so alert on them only once the worker runs.

```promql
syncer_lag_ledgers                                                  # the number to alert on
syncer_last_commit_age_seconds > 120 and syncer_lag_ledgers < 2     # a live chain commits every few seconds
rate(syncer_head_ledger[5m])                                        # ledgers/s closing; compare with the checkpoint's rate
rate(syncer_checkpoint_ledger[5m])                                  # ingest throughput while catching up
rate(syncer_aggregator_errors_total[15m]) > 0
syncer_aggregator_stats_lag_seconds > 3600
syncer_markets_live_age_seconds{period="day"} > 600                 # the Markets table is stale
syncer_markets_live_age_seconds{period=~"7day|30day"} > 600         # a long Markets period is stale (rewritten every 5 minutes)
syncer_pair_hourly_missing_hours > 0                                # an hour of the last 31 days has no set
syncer_rates_daily_missing_days > 2                                 # the daily rates are not being written (after the back-fill)
syncer_account_rollups_pending_accounts > 0                         # a heavy account is not covered yet
sum by (source) (rate(api_account_day_groups_total[5m]))            # raw vs rollup reads of the account aggregates
rate(api_rates_on_read_total[5m])                                   # rates worked out on read: high while rates_daily back-fills
rate(syncer_validations_flushed_total[5m]) == 0                     # XRPL: validators validate every ledger
syncer_validators_unl_expiry_seconds < 7 * 86400                    # a validator list expires within a week
rate(syncer_validators_jobs_total{outcome="error"}[15m]) > 0        # a rounds or agreement run failed
```

The gauges describe what *this process* has done since boot: scrape each network's syncer separately.

## 5. Logging

Both services log through the NestJS `Logger` via the toolbox logger (stdout/stderr; capture it with your container log pipeline).
There are **no `GH_LOGGER_*` variables**: the toolbox logger decides the format (colour is switched off outside dev/test). Contexts to
grep for: `Syncer` (boot line with network, workers and node hosts), `NodeClient` (connects, reconnects, silence), `LiveRunner`
(state changes, recovery, halts), `RangeIngest`, `ValidationsCollector`, `FeeStatsPoller`, `AggregatorService` (also the log of the four account and market jobs: `Rates back-fill ...`, `Pair-hourly back-fill ...`, `Account-rollups back-fill ...`, `Markets set of period ... not written`, and the shared `reached its budget` warning), `Api` (boot line with
network and native currency), `RippleRoute` / `RippleError` (the cause of every 5xx, with the stack; the response body never carries
it), `ApiKeyGuard`.

Node endpoints may carry credentials: logs show only `scheme://host:port`. API keys are never logged.

There are no request correlation ids yet.

## 6. Suggested dashboards and alerts

Build an API **RED** dashboard (rate, errors, duration) from the `api_http_*` series, a syncer **ingest** dashboard from
`syncer_checkpoint_ledger`, `syncer_head_ledger`, `syncer_lag_ledgers`, `syncer_last_commit_age_seconds`, and a **USE** resource dashboard
from the default process metrics.

### Monitoring ClickHouse itself

The probe only tells you the app can *reach* ClickHouse. Scrape ClickHouse directly (its built-in Prometheus endpoint via
`<prometheus>` in `config.d`, or a `clickhouse-exporter` over `system.*`): memory, disk free, parts per partition, merges, mutations
(stuck lightweight deletes), replication queue. Wiring this is backlog.

### Recommended alerts

| Alert | Condition (sketch) | Why |
| --- | --- | --- |
| API 5xx rate high | `sum(rate(api_http_requests_total{status=~"5.."}[5m])) / sum(rate(api_http_requests_total[5m])) > 0.05` for 5m | The read tier is failing requests |
| API p95 high | `histogram_quantile(0.95, sum by (le)(rate(api_http_request_duration_seconds_bucket[5m]))) > 1` for 10m | Slow queries or DB pressure |
| API down | probe failing or `up{job="api"} == 0` | |
| **Syncer behind** | `syncer_lag_ledgers > 10` for 5m (outside a planned catch-up) | Live sync lagging; the probe fails at the same threshold after 60 s |
| **Syncer not committing** | `syncer_last_commit_age_seconds > 120` | Ingest wedged, node silent, or ClickHouse refusing writes |
| **Syncer halted / down** | probe 503 with `state=halted`, `increase(syncer_ingest_halts_total[5m]) > 0`, or `up{job="syncer"} == 0` | Chain break, a ledger the parser rejects, lost lease, or process down |
| Aggregator failing | `rate(syncer_aggregator_errors_total[15m]) > 0` for 30m | Stats or volumes not refreshing |
| Aggregator far behind | `syncer_aggregator_stats_lag_seconds > 3600` for 1h | Sweep slower than the data |
| **Markets stale** | `syncer_markets_live_age_seconds{period="day"} > 600` for 10m | The `markets_live` job has not written the `day` set for over ten minutes (it writes one a minute): `/v2/network/markets` serves an old set, and the explorer's Markets page with it. Look for `Markets set of period day not written` (a gap in `pair_hourly`) and for errors of the `markets_live` and `pair_hourly` jobs |
| **Long Markets periods stale** | `syncer_markets_live_age_seconds{period=~"7day\|30day"} > 600` for 10m (one alert per period) | The `7day` or `30day` set has not been rewritten for over 20 minutes. They are rewritten every fifth run (about every 5 minutes), so their age climbs to about 300 s between rewrites, and one failure of a set (a 5-minute wait that misses its next turn) takes it to about 900 s for a few minutes: the 10 minutes above 600 s let that pass. 600 s is also what the explorer's `MARKETS` switch needs of all three periods ([operations](operations.md#rolling-it-out)): while this fires, `/v2/network/markets?period=7day` or `30day` serves an old set. Look for `markets_live` errors and `Markets set of period <p> not written` (a gap in `pair_hourly`); if the `day` set alone uses the job's 3 s budget every run, the long sets never start (the budget warning of `markets_live` says so) |
| **Hours of pair statistics missing** | `syncer_pair_hourly_missing_hours > 0` for 30m | An hour of the last 31 days has no set of the current config version, so a Markets set that needs it is not written. The live hours are recomputed every tick; a gap that stays is a failing hour (see the `pair_hourly` errors, which wait 5 minutes and then more) |
| **Daily rates not written** | `syncer_rates_daily_missing_days > 2` for 6h, **once the back-fill has finished** | The `rates_daily` job is not writing the daily sets (normally the gauge is 0: the day that has just become final is computed by the next run, so more than two days pending for hours are days that cannot be computed). Alert only after the first back-fill: on a fresh deployment the gauge is the size of the history and falls over about a day. Until the sets exist the API values on read: right, and slow |
| **Validator list expiring** | `syncer_validators_unl_expiry_seconds < 7 * 86400` | A publisher's list expires within a week (it already has when the value is negative; an expired list is still used, flagged `expired`): check the publisher |
| Validator agreement behind | `syncer_validators_agreement_lag_seconds > 7200` for 30m | The agreement job has not finalised an hour for over two hours |
| Voting rounds behind | `syncer_validators_rounds_lag_ledgers > 1024` for 30m | The rounds job is more than four flag intervals behind the committed ledgers |
| Validators jobs failing | `rate(syncer_validators_jobs_total{outcome="error"}[15m]) > 0` for 30m | Rounds or agreement not refreshing |
| Amendment without metadata | `syncer_amendments_without_metadata > 0` for 1d | The node, the ledger or the votes name an amendment that the metadata file lacks: add its entry (`pnpm --filter @gatehub/data-api-shared amendments:check --network xrpl\|xahau` lists them) |
| Validations flowing | `rate(syncer_validations_flushed_total[10m]) == 0` for 10m on XRPL | Collector or its nodes down |
| Fee stats flowing | `rate(syncer_fee_stats_samples_total[10m]) == 0` | Node unreachable |
| Codec fallback | `increase(api_tx_encode_fallback_total[1h]) > 0` | Definitions out of date for a new transaction type |
| ClickHouse memory / disk / parts | from the exporter | OOM (compose limits CH to 8g), disk full stops ingest, merges behind |

Threshold numbers are starting points: tune to your traffic and SLOs.

## 7. What to watch during a backfill

A range ingest bulk-loads ClickHouse hard ([backfill](backfill.md)). Watch both sides:

- **CLI:** its log (`Range [...] ingested: N chunks complete ... M ledgers written`), and in SQL `SELECT count(), max(ledger_index) FROM
  <db>.ledgers`. The CLI is a separate process and has no metrics endpoint; the live syncer's gauges describe the live runner only.
- **Aggregator:** `SELECT count() FROM <db>.agg_dirty` shrinks as the aggregator digests the new hours;
  `syncer_aggregator_stats_lag_seconds`.
- **Account and market aggregates:** `syncer_pair_hourly_missing_hours`, `syncer_rates_daily_missing_days` and `syncer_account_rollups_pending_accounts` show the
  back-fills of a fresh deployment (and what a re-ingest re-marks: rate days and heavy accounts' days are recomputed as `agg_dirty` drains, its hours of the last 31 days at once); see
  [operations](operations.md#account-and-market-aggregates).
- **ClickHouse:** parts per partition and merge activity (`system.merges`): if parts pile up faster than merges drain them you risk
  `too many parts`; lower `--concurrency`. Memory and disk: bulk loads are the likeliest time to hit the memory limit or fill the volume.

## 8. Gaps and backlog

1. **Distributed tracing:** no OpenTelemetry or trace-context propagation.
2. **Log correlation ids:** requests are not stamped with an id.
3. **Dashboards as code:** ship Grafana JSON instead of hand-built boards.
4. **ClickHouse exporter wiring:** the database is not scraped yet.
5. **A metric for the volume back-fill and for guard rejections** (401/429 are not in `api_http_requests_total`).
