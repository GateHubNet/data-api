# Operations runbook

Day-2 operations of the GateHub Data API: routine tasks, what to watch, what to do after an outage, backfill and repair, scaling
and incident playbooks. How it is deployed: [deployment](deployment.md). Metrics and health in detail:
[observability](observability.md). How the syncer works: [syncer](syncer.md).

Commands use the production compose file through a small shell function (works in bash and zsh; the env file holds secrets, do not paste
it into tickets). Define it once per shell, in the repo root:

```bash
dc() { docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod "$@"; }
```

## At a glance

| Thing | Where |
| --- | --- |
| API health | `GET /liveliness/healthz` on the api (3001): 200, or 503 when ClickHouse does not answer. The shipped nginx lets only trusted proxies reach it. |
| Syncer health | `GET /liveliness/healthz` on the syncer (3002): 503 when ClickHouse is down, the ingest is `halted`, or the lag stays above `GH_MAX_LAG_HEALTHY` for more than 60 s. The body shows `state`, `lag`, `last_commit_age`. |
| Metrics | `GET /metricz` on port 3000 of every api and syncer, inside the compose network only |
| Swagger | `GET /internal/docs` (not exposed by nginx; reach the api container directly) |
| Apply the schema | `dc run --rm migrate-xrpl` / `migrate-xahau` (idempotent) |
| Ingest progress | `syncer_checkpoint_ledger`, `syncer_head_ledger`, **`syncer_lag_ledgers`**, `syncer_last_commit_age_seconds` |
| Aggregator progress | `syncer_aggregator_stats_lag_seconds`, `rate(syncer_aggregator_runs_total[5m])`, `syncer_aggregator_errors_total{job}` (jobs `volume_live`, `volume_daily`, `amm_pools`, `stats_live`, `stats_dirty`, `amm_daily`, `volume_backfill`, and the dirty hooks `volume_dirty`, `amm_pools_dirty`, `amm_daily_dirty`) |
| AMM data | `syncer_amm_unclassified_total`, the `amm_pools` / `amm_daily` error labels, [the AMM jobs](#the-amm-jobs) |

Two services per network, never more than **one syncer**: `syncer-xrpl`, `syncer-xahau` are singletons (a fixed
`container_name`, so compose refuses to scale them, and an application-level lease in ClickHouse that refuses a second writer).
The apis (`api-xrpl`, `api-xahau`) scale freely.

## Routine tasks

### Deploy a new version

```bash
git pull                                              # or check out the release tag
export NPM_TOKEN=...                                  # the private @gatehub/toolbox; BuildKit secret, never baked in
dc build                                              # builds gatehub/data-api and gatehub/data-syncer from this checkout
dc up -d --scale api-xrpl=<n> --scale api-xahau=<m>   # migrate jobs run first (idempotent), then recreates what changed
```

**Repeat your `--scale` flags on every `up`**: a plain `dc up -d` converges every service to its configured count and scales the apis back to 1.

**There is no rolling update and no zero-downtime deploy with compose.** `up -d` recreates every container of a changed service **together**: while the new
api containers start (a few seconds to the end of their healthcheck `start_period`) that network's host answers 502 from nginx, and the other network is not
affected. A changed **syncer** is stopped (SIGTERM, 30 s grace: it finishes its write and releases the lease) before the new one starts, so the two never
overlap; the new one catches up from its checkpoint, and the api keeps serving what is committed meanwhile. Order does not matter for the schema: the migrate
jobs run before the apps start. If a brief outage per release is not acceptable, put an orchestrator with rolling updates (Kubernetes, see
[deployment](deployment.md#option-3-kubernetes)) in front of the same images, or run a second compose project next to the first and switch the nginx
upstream between them; neither is shipped or tested here.

### Apply a schema migration

Migrations are the `*.sql` files in `packages/shared/schema/`, applied in file-name order, each once, and recorded with a SHA-256
checksum in `<database>.schema_migrations`. To change the schema add a new `NNN_*.sql` and run the migrate job
(`dc run --rm migrate-xrpl && dc run --rm migrate-xahau`, or `dc up -d --scale api-xrpl=N --scale api-xahau=M` with your own scale
flags: a plain `dc up -d` scales the apis back to 1). **Never edit an applied file**: its changed
checksum is a hard error (`Migration ... was modified after being applied`). All DDL is `CREATE ... IF NOT EXISTS`, so a file that
failed halfway can simply be run again. Run migrations as a one-shot step, not from every replica. Details:
[data-model](data-model.md#5-migrations).

### Rotate an API key

`GH_API_KEYS` is comma separated and read at boot, so a change needs a restart of the apis. Rotate in two steps so that no client has to switch at the
same instant: add the new key beside the old one in `deploy/.env.prod` (`old,new`) and `dc up -d` (repeat your `--scale` flags), move the clients,
then remove the old key and `dc up -d` again (with the same `--scale` flags). Each `up` recreates the apis of both networks together, i.e. a brief 502 from nginx (see
[Deploy a new version](#deploy-a-new-version)). The API refuses to start with an empty list, or a key that is `dev-api-key` or starts with `change-me`.

### Rotate the ClickHouse password

`data_api` is not a SQL-created user: the clickhouse-server entrypoint writes `users.d/default-user.xml` (a user defined in XML, with `default` removed) from
`CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` on **every container start**, and ClickHouse refuses to change an XML-defined user (`ALTER USER data_api ...` fails with
`ACCESS_STORAGE_READONLY`; checked on 26.8.14.3). In `docker-compose.prod.yaml` the server's `CLICKHOUSE_PASSWORD` and the `GH_CLICKHOUSE_PASSWORD` of the
migrate jobs, syncers and apis are all the same `GH_CLICKHOUSE_PASSWORD` of `deploy/.env.prod`. So:

```bash
# 1. set the new GH_CLICKHOUSE_PASSWORD in deploy/.env.prod (from your secrets manager)
dc up -d --scale api-xrpl=<n> --scale api-xahau=<m>
```

Compose sees the changed environment and **recreates the clickhouse container and every client** (migrate jobs, syncers, apis; nginx is unchanged). The data volume is
kept, the new container regenerates the XML user with the new password, and the clients start with it; the syncers catch up from their checkpoints. Expect a short
outage of the whole stack (ClickHouse restarts). Any other client of the database (backups, a Prometheus exporter, your own `clickhouse-client` sessions) needs the new
password too.

### Reclaim space after a big load

`ReplacingMergeTree` collapses duplicates only on background merges, and list queries never rely on that. To compact after a large
backfill or `--reprocess`:

```sql
OPTIMIZE TABLE xrpl.transactions FINAL;   -- per table, off-peak; expensive on big tables
```

### Retention

Only `validations` expires on its own (90-day TTL). Raw ledger data is deleted by dropping whole partitions, **but a ledger exists only if all its tables agree**:

- `ledgers` is the commit marker; `range-ingest` **skips every ledger that has a `ledgers` row** (it believes it is complete), and the live syncer never looks
  behind its checkpoint.
- A ledger that has a `ledgers` row but fewer stored transactions than its `tx_count` is answered with **500** by `/v2/ledgers/{id}` (and its hash list); lists of
  payments, exchanges and balance changes silently lose the rows whose tables were dropped.

So never drop the partitions of one table alone. Drop **the same ledger range from all 19 ledger-derived tables**, in blocks aligned to the **10,000,000-ledger
partitions of the P7 tables** (the P6 tables `ledgers`, `transactions`, `payments`, `amm_pool_touches` have ten 1,000,000-ledger partitions per block; `accounts_created` has no partition and
is cleaned with a `DELETE`). `ledgers` goes first (the commit marker: the ledgers vanish from every list at once), then the children. For the block 80,000,000-89,999,999
(P7 partition 8, P6 partitions 80-89) of the XRPL database:

```bash
# run from the repo root; clickhouse-client authenticates with the container's own environment (the secret never touches the host command line)
ch() { dc exec -T clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -q "$0"' "$1"; }
for p in 80 81 82 83 84 85 86 87 88 89; do ch "ALTER TABLE xrpl.ledgers DROP PARTITION $p"; done      # the commit marker first
for p in 80 81 82 83 84 85 86 87 88 89; do for t in transactions payments amm_pool_touches; do ch "ALTER TABLE xrpl.$t DROP PARTITION $p"; done; done
for t in ledger_by_hash tx_by_hash tx_by_type account_transactions account_tx_by_sequence payments_by_currency account_payments exchanges account_exchanges balance_changes \
         amm_pool_states amm_liquidity account_amm_liquidity amm_governance; do
  ch "ALTER TABLE xrpl.$t DROP PARTITION 8"
done
ch "DELETE FROM xrpl.accounts_created WHERE ledger_index BETWEEN 80000000 AND 89999999"
```

The rollups (`stats_hourly`, `volume_*`, `amm_pools`, `amm_daily`) are not touched: old hours keep their numbers (that is usually what you want); `fee_stats` and `validations` are independent. A block dropped from the AMM tables and
brought back by `range-ingest` marks `agg_dirty`, and the aggregator rebuilds the pools and days it covers.

To **bring a dropped block back**, run `range-ingest` over the same range: with no `ledgers` rows left it ingests everything. To repair a **partial** loss (some tables
dropped, or a ledger answering 500) without caring about partition alignment, use `--reprocess` over exactly the damaged range
(`range-ingest --from A --to B --reprocess`: it fetches and parses first, then deletes and rewrites those ledgers in every table, from any sub-range).

## What to watch

| Signal | Healthy | Act when |
| --- | --- | --- |
| `syncer_lag_ledgers` | 0-2 live; large and falling during catch-up | Does not fall, or is above 10 for more than a minute (the probe fails at `GH_MAX_LAG_HEALTHY`) |
| `syncer_last_commit_age_seconds` | under ~10 s live (a ledger closes every 3-4 s on XRPL) | Above 60 s with a lag of 0 means the chain is not closing ledgers or the head hint is stuck |
| syncer probe `state` | `live` (`catching_up` while behind) | `halted` (chain break, a ledger the parser rejects, or lost lease) |
| `syncer_aggregator_stats_lag_seconds` | 0 | Positive for hours: the sweep is slower than the data, see [syncer](syncer.md#7-the-aggregator) |
| `syncer_aggregator_errors_total{job}` | flat | Rising: look for the job's log lines. For `amm_pools` / `amm_daily` see [the AMM jobs](#the-amm-jobs) |
| `syncer_amm_unclassified_total` | a trickle at most | A burst: the parser met a pool shape it cannot place (a new kind of AMM transaction, an MPT asset); see [backfill](backfill.md#amm-data-re-ingest) |
| `rate(syncer_fee_stats_samples_total[5m])` | about 0.2/s | 0 (node unreachable) |
| `rate(syncer_validations_flushed_total[5m])` | positive on XRPL (validators validate every ledger) | 0 for minutes; `syncer_validations_dropped_total{reason}` rising |
| `api_http_requests_total{status=~"5.."}` | none | Spike |
| `api_http_request_duration_seconds` | p95 under 500 ms | Rising with idle api CPU: ClickHouse is the bottleneck |
| `api_tx_encode_fallback_total` | 0 | Rising: the binary-codec definitions lack a transaction type, see [troubleshooting](troubleshooting.md) |

### SQL health checks

Run them in `clickhouse-client` inside the container, which authenticates with the container's own environment (the password stays off the host command
line; `data_api` is the only user, `default` is removed):

```bash
dc exec clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"'
```

and paste:

```sql
-- no gaps and no duplicate ledgers (span = count = distinct)
SELECT max(ledger_index) - min(ledger_index) + 1 AS span, count() AS ledgers, uniqExact(ledger_index) AS distinct
FROM xrpl.ledgers;

-- no duplicate transactions
SELECT count() AS rows, uniqExact(ledger_index, tx_index) AS distinct FROM xrpl.transactions;

-- where are the gaps?
SELECT prev + 1 AS missing_from, ledger_index - 1 AS missing_to
FROM (
  SELECT ledger_index, lagInFrame(ledger_index, 1, 0) OVER (ORDER BY ledger_index ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS prev
  FROM (SELECT DISTINCT ledger_index FROM xrpl.ledgers)
)
WHERE prev > 0 AND ledger_index - prev > 1;

-- unfinished range-ingest chunks, and who holds the syncer lease
SELECT * FROM xrpl.ingest_log FINAL WHERE status = 'started' AND range_end > 0;
SELECT network, holder, heartbeat FROM xrpl.syncer_lease FINAL;

-- stats the aggregator still has to recompute
SELECT count() FROM xrpl.agg_dirty;
```

`count()` can exceed `uniqExact(...)` for a moment on freshly rewritten ledgers (merges have not run); that is expected and is not
visible to the API.

## After an outage

**Nothing needs to be repaired by hand in the usual case.** The syncer is crash-safe by construction (see
[syncer](syncer.md#checkpoint-boot-and-recovery)):

1. Start the syncer (`dc up -d syncer-xrpl`, or let `restart: unless-stopped` do it). If it refuses to boot because the lease is
   held, a previous syncer is still running or died less than 30 s ago: stop it (`docker ps` for stray `syncer`/`data-syncer-*`
   containers of an older stack) and wait 30 s.
2. It reads the checkpoint, confirms the checkpoint's hash with the node, deletes the uncommitted tail, and catches up from
   checkpoint + 1. Watch `syncer_lag_ledgers` fall to 0.
3. The aggregator's watermark sweeps the hours that were missed by itself; `syncer_aggregator_stats_lag_seconds` shows the
   remaining work. The stats of the current hour are stale until the sweep is over.
4. **If the node no longer has the missing ledgers** (a non-full-history node: `complete_ledgers` of `server_info`), the syncer retries
   forever and the lag never falls. Point `GH_NODE_ENDPOINTS` at a full-history node (your own, or `wss://s2.ripple.com` for
   XRPL), `dc up -d syncer-xrpl` (only that service: a plain `dc up -d` would also scale the apis back to 1; repeat your `--scale`
   flags if you run a whole-stack `up`), and it carries on.
5. A ClickHouse outage is handled the same way: writes fail, the runner recovers (waits for the failed queries, deletes the
   tail, writes again) and no ledger is lost or duplicated.

Gaps **below** the checkpoint are not detected by the live syncer (it only moves forward); find them with the SQL above and fill
them with `range-ingest` (see [Backfill and repair](#backfill-and-repair)).

### Syncer halted

`state=halted` in the probe and a 503:

- `parent_hash` break or a checkpoint hash the node does not confirm: the stored chain and the node disagree about history. Find
  out which is wrong (ask a second node: `ledger` at the stored index, compare `ledger_hash`). If the **node** is on another
  chain (wrong network, a reset test net) fix `GH_NODE_ENDPOINTS`. If the **stored** ledgers are wrong, re-ingest from the last
  good ledger: `range-ingest --reprocess --from <last good> --to <checkpoint>` from a stopped live syncer, then start it.
- `Cannot parse ledger <index>: <reason>`: the parser rejects that ledger (a transaction type or field it does not handle). It
  fails the same way every time, so the runner committed the ledgers before it and stopped instead of retrying. Look at the
  ledger (`ledger` with `transactions` and `expand` on the node), fix the parser, deploy, restart: the runner carries on at that
  ledger. `range-ingest` fails the chunk with the same message and leaves its intent open; rerun it after the fix.
- `lease lost to <holder>`: another syncer took the lease. Find and stop it; restart this one.

### Syncer falling behind

`syncer_lag_ledgers` grows while `syncer_last_commit_age_seconds` grows: check, in order, the node (`GH_NODE_ENDPOINTS`
reachable? `[NodeClient]` reconnect warnings), ClickHouse (writes failing? `recovering` in the probe body, `[LiveRunner]` errors,
stuck mutations in `system.mutations`), and disk. Live load is about one ledger per 3-4 s on XRPL; falling behind in live mode is
a downstream problem, not throughput. In catch-up, throughput is bound by the node first: raise `GH_CATCHUP_CONCURRENCY` with
your own node.

## The AMM jobs

The aggregator keeps two AMM tables up to date, `amm_pools` (the current state of every pool) and `amm_daily` (a row per pool and UTC
day), and a third volume metric, `amm_volume`, in the volume sets. How they work is in [syncer](syncer.md#the-amm-jobs); what an
operator needs:

| Job | Budget and cadence | Healthy | Watch |
| --- | --- | --- | --- |
| `amm_pools` | 3 s, every tick, third in the tick (after `volume_daily`) | A new pool is in `GET /v2/amm/pools/{pool}` within about a minute of its first ledger | `syncer_aggregator_errors_total{job="amm_pools"}` and `{job="amm_pools_dirty"}`; log lines `Aggregator job amm_pools ...` |
| `amm_daily` | 4 s, at the first tick and then every 5th tick (about five minutes), sixth in the tick (after `stats_dirty`) | Today's row follows the pool within five minutes; the back-fill says `AMM daily back-fill: N days to compute` and then `is done` | `{job="amm_daily"}` and `{job="amm_daily_dirty"}` |
| `amm_volume` | inside `volume_live` (5 s), `volume_daily` (4 s) and `volume_backfill` (10 s) | `GET /v2/network/amm_volume` has components | the volume jobs' errors, `volume_live` and `volume_daily` |

- **The tick shares its budget.** `volume_live` (twelve live sets) and `volume_daily` (six daily sets of today and yesterday) go first,
  then `amm_pools`, so the pool list is as fresh as the volumes; `amm_daily` goes after `stats_dirty` and only gets what is left.
  Each job has its own budget, so a long `amm_daily` back-fill cannot starve the live jobs. If a job logs `reached its budget`, it goes
  on at the next tick or run (said once until a run finishes in time).
- **What a recompute costs.** A pool's state is the newest non-null value of each column over its state rows (a swap carries no fee, LP
  supply or slot). The aggregators read a window of `AMM_FILL_WINDOW_LEDGERS` (160,000 ledgers, about a week) of each pool first, and walk
  further back in doubling steps only for the pools whose window leaves a column null, so a pool pays for the distance back to its
  oldest needed value (the whole history only for a column that is null for ever). A back-fill of many days costs that for each day, so
  the first sweep of a deployment with years of AMM history takes many ticks: watch `AMM daily back-fill: N days to compute` in the log.
- **The dirty-slice hooks.** `stats_dirty` (after a `range-ingest`) recomputes, for each slice of an `agg_dirty` range, the stats, the
  daily volume sets of its days, the `amm_pools` rows of the pools with a touch in its ledgers (error label `amm_pools_dirty`) and the
  `amm_daily` sets of its days (`amm_daily_dirty`). A slice is started whole, so a slice with thousands of pools runs past the
  `amm_pools` budget of 3 s. The budget of `stats_dirty` (10 s) is checked between slices, so a tick can run as long as one slice
  longer; the rest of the range is done at the next tick.
- **A pool that fails is set aside, not stuck.** `amm_pools` halves a failing batch of up to 200 pools to find the pools that fail on
  their own (at most three per batch), counts each as an error, and retries each after 5 minutes, doubling up to an hour. The log names
  the pool: `Aggregator job amm_pools failed for pool r..., set aside to be tried again`. The pool is stale in `amm_pools` until its
  retry works. The set is in memory: a restart recomputes it from the tables and finds the pool again.
- **`failed as a whole, but its halves were rebuilt`.** A warning `Aggregator job amm_pools: a batch of N pool(s) failed as a whole, but
  its halves were rebuilt: <cause>` is counted as one error. Nothing is lost; the batch failed for its size (a timeout, a memory limit
  of ClickHouse). If it keeps appearing, look at the cause and at `system.query_log` for the fill-forward query.
- **`amm_daily`: a day that fails** is counted once and tried again at the next run; a closed day waits 5 minutes, doubling up to an
  hour. A day that fails on the dirty path (after a re-ingest) is owed to the job and does not hold up `agg_dirty`.
- **After a re-ingest** (`range-ingest --reprocess` over AMM ledgers, see [backfill](backfill.md#amm-data-re-ingest)) the written
  ledgers mark `agg_dirty`, and the aggregator rebuilds the pools and the days they cover with the stats: `SELECT count() FROM
  xrpl.agg_dirty` shrinks as it works. The pools of the live ledgers are found by the stale-pool cursor.
- **When the computation of `amm_daily` changes** (a fix to the fee estimate, say), bump `AMM_DAILY_CONFIG_VERSION` in
  `packages/shared/src/aggregate/amm-daily.job.ts` and deploy: every closed day is computed again by the back-fill, newest first.
- **A pool that is missing.** `GET /v2/amm/pools/{pool}` answers 404 for a brand-new pool until the first tick of `amm_pools` after
  its ledger is committed (up to about a minute); its history, swaps, liquidity and governance are served as soon as the ledger is.
  A 404 that lasts: no ledger of the pool was ingested (the history starts at the ledger the syncer started at, or at the ledger of a
  `--reprocess`), or `amm_pools` is failing for it (the log names the pool).
- **Is the AMM data complete?** `SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 86795265 GROUP BY parser_version`:
  ledgers written by version 1 have no AMM rows. A pool whose creation was not ingested has no `created_ledger` / `created_by`.

## Backfill and repair

The live syncer never fills history. History, gaps and parser changes go through the range-ingest CLI, which runs next to the live
syncer in the same image. Full guidance on sizing and nodes: [backfill](backfill.md).

```bash
# a range of one network (the syncer keeps running; the CLI checks its lease itself)
dc run --rm --no-deps syncer-xrpl node dist/cli/range-ingest.js --from 90000000 --to 90100000
# Xahau's public node throttles even one fetch at a time: 1 in flight (more only meets its pauses sooner; see backfill)
dc run --rm --no-deps syncer-xahau node dist/cli/range-ingest.js --from 1 --to 100000 --concurrency 1 --chunk 100

# after a parser change: rewrite committed ledgers (below the live checkpoint)
dc run --rm --no-deps syncer-xrpl node dist/cli/range-ingest.js --from 90000000 --to 90100000 --reprocess
```

- **Resume:** rerun the same command. Finished chunks are skipped, an unfinished one is redone. Exit status 1 means failed, 2 a
  wrong command line.
- **Speed:** `--concurrency` (ledgers of a chunk fetched at once) is bound by the node; `--chunk` (default 1000, must divide
  1,000,000) is the memory a run needs.
- **Above the checkpoint:** refused while the live syncer's lease is fresh. Backfill is history. A range that **starts** above the
  checkpoint + 1 is refused on a database a live syncer has run on, fresh lease or not, unless `--allow-gap` (Ruling R110): the live
  syncer resumes after the highest committed ledger, so the ledgers in between would never be fetched (and a live syncer that boots
  while the range is written deletes everything above its checkpoint). Pass `--allow-gap` only for a gap you fill yourself next.
- **Unfinished intents:** a rerun redoes the unfinished chunk of a run that died over its whole recorded range (also beyond the range
  of the rerun), and marks the hours of all its committed ledgers in `agg_dirty` (Ruling R110).
- **Aggregates follow by themselves:** every chunk marks `agg_dirty`, the aggregator recomputes the affected hours and days within
  its per-tick budgets. Watch `SELECT count() FROM xrpl.agg_dirty`.
- **Do not** run two range ingests over overlapping ranges at once.

## Scaling

| Tier | How |
| --- | --- |
| API (read) | `dc up -d --scale api-xrpl=4 --scale api-xahau=2` (repeat the flags on every `up`; compose has no rolling update; nginx resolves the replicas per request through Docker DNS and uses all of them). The api is stateless apart from small in-memory caches. The rate limit is per replica (in memory), so the effective limit grows with the replica count. |
| Syncer | **Never.** One per network. It is network- and ClickHouse-bound, not CPU-bound. |
| ClickHouse | One server with one database per network. Scale it up first (RAM, disk); replication needs Keeper-backed `Replicated*` engines, see [clickhouse](clickhouse.md#high-availability-and-replication). |

The compose file keeps the ClickHouse memory limit at 8 GB: size it to your data (full XRPL history is roughly 1-1.5 TB
compressed, mostly `transactions`).

## Incident playbooks

### Probe returns 503 on the api

ClickHouse does not answer a ping. Is it up and reachable from the api's network (`dc exec api-xrpl node -e "fetch('http://clickhouse:8123/ping').then(r=>console.log(r.status))"`)? Memory or disk? The api itself is fine; it is the dependency.

### API 5xx spike

The body only says `unable to retrieve ...`; the cause is in the api log (`[RippleRoute]`/`[RippleError]` lines with the stack).
Most likely ClickHouse: a heavy query, memory pressure (`Memory limit exceeded`), timeouts (`GH_CLICKHOUSE_MAX_EXECUTION_TIME`).
Inspect `system.query_log` for slow and failed queries and `system.processes` for what runs now.

### API slow while the replicas are idle

The replicas wait for ClickHouse. Look at `system.processes`, `system.query_log` (`read_rows`, `memory_usage`), and `max_execution_time`
kills. Typical causes: a very active account on `/reports` or `/stats/value`, a `/v2/stats` over the full history before the rollup
caught up, `FINAL` added to a list query by a code change ([ADR-0003](adr/0003-no-final-on-list-queries.md)), or a list query that
reads its page with `LIMIT 1 BY` in the same SELECT as the table, which reads most of the range
([clickhouse](clickhouse.md#reading-a-page-what-stops-the-read)): one page should read about a granule per part.

### Many 401s after a deploy

`GH_API_KEYS` changed or the env file did not reach the container. The api refuses to boot without keys in production, so a running
api has keys; compare the key clients send with `dc exec api-xrpl printenv GH_API_KEYS` only on a trusted terminal.

### Every client gets 429

The rate limiter sees one client address: the proxy chain is misconfigured. `TRUSTED_PROXIES` must contain your front proxy so nginx
recovers the real client; `GH_TRUST_PROXY_HOPS` stays 1. See [troubleshooting](troubleshooting.md#every-client-shares-one-rate-limit-bucket).

### ClickHouse "too many parts"

Something inserts too often in small batches. The syncer batches (300 ledgers / 100,000 transactions / 5 s in catch-up, one commit
per ledger live), so look for an external writer. Let merges catch up; `OPTIMIZE` if needed.

### Schema migration failed

The migrate job is idempotent: fix the cause and rerun it. A statement that genuinely failed (bad DDL in a new file): fix the file
*before* it was ever applied successfully; applied files are never re-run, and an edited applied file is rejected by checksum.
`Migration ... was modified after being applied` means someone edited history: restore the file and add a new migration.

### Old local ClickHouse volume

A volume created by the previous stack (the one before the per-network rewrite) carries the replaced baseline schema and old `schema_migrations` rows.
For local development recreate it: `docker compose down -v`, then migrate again. Do not do this on a database you care about.

## Backup and restore

See [clickhouse](clickhouse.md#backups). Two layers: real backups (`clickhouse-backup` or snapshots) for a fast restore, and the
ledger itself as the ultimate source (re-ingest with `range-ingest`). **Test restores regularly.**

## Known gotchas

Collected in [troubleshooting](troubleshooting.md): slim-image healthchecks need `node fetch` (no wget), the syncer's port opens only
after its node connects, mounting ClickHouse `config.d` shadows `listen_host`, Keeper healthcheck flags, `pnpm deploy --legacy`.
