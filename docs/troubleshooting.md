# Troubleshooting

Concrete failures encountered building and running this system, each with the symptom, the root cause and the fix. Operational
playbooks are in [operations](operations.md); this page is the lookup table for error messages.

## Build and packaging

### `tsc` emits nothing / `Cannot find module '@gatehub/data-api-shared'`
**Symptom:** a clean Docker build fails the API type check with many `Cannot find module` errors although `pnpm build` works locally, or
a local rebuild produces a near-empty `dist/`.

**Root cause:** TypeScript writes a `*.tsbuildinfo`; a stale one next to a missing `dist` makes `tsc` believe the output is current and
emit nothing (nest's `deleteOutDir` is the trap). The shared package's `dist/index.d.ts` is then missing.

**Fix:** `**/*.tsbuildinfo` is in [`.dockerignore`](../.dockerignore) and git-ignored. Locally delete `*.tsbuildinfo` and `dist` and rebuild.

### Docker build: workspace package not found after `pnpm install`
**Root cause:** pnpm workspace symlinks do not survive across BuildKit layers. **Fix:** the Dockerfiles do install, build and deploy in one `RUN`.

### `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`
**Root cause:** pnpm 10 refuses `deploy` without injected workspaces. **Fix:** `pnpm ... --legacy deploy --prod /app/out` (the Dockerfiles do).

### Docker build: `secret npm_token: not found` / `the npm_token secret is empty`
**Symptom:** `docker compose build` (or `docker build`) stops at the install `RUN`.

**Root cause:** the npm token of the private `@gatehub/toolbox` is a **BuildKit secret**, read from the `NPM_TOKEN` environment variable
(compose: `secrets.npm_token.environment: NPM_TOKEN`). It is not a build argument, and not read from `~/.npmrc`.

**Fix:** `export NPM_TOKEN=...` in the shell that runs the build (`NPM_TOKEN=... docker compose build`), or
`docker build --secret id=npm_token,env=NPM_TOKEN ...`. Do not copy the token out of `~/.npmrc` or pass it as a build argument: the
secret is in no layer and `docker history` shows nothing. A `404`/`401` for `@gatehub/toolbox` during install means the token cannot read it.

### `pnpm install` fails with 404/401 for `@gatehub/toolbox`
**Root cause:** the package is private and pnpm has no token. **Fix:** [development](development.md#npm-access) (log in to npm, or reference
`${NPM_TOKEN}` from your user-level `~/.npmrc`). The committed `.npmrc` does not carry the token.

### `Env file not found: .env.production` (or `.env`)
**Symptom:** the service dies right at boot, before any log line of its own.

**Root cause:** the toolbox config loader reads `.env` (or `.env.$NODE_ENV`) from the working directory and refuses to start without it,
unless `GH_ENV` is set to any value. The images set `GH_ENV=container`; running `node dist/main.js` by hand with `NODE_ENV=production` and
no `GH_ENV` hits this.

**Fix:** from source copy `apps/<app>/.env.example` to `.env` and run from the package folder; in a container or CI set `GH_ENV=container`
and put the variables in the environment.

### `process exits: GH_DATABASE_...` when importing the toolbox
**Root cause:** the package root of `@gatehub/toolbox` registers its own database and queue configuration. **Fix:** import
`@gatehub/toolbox/lib/<module>` (as `api.config.ts` does), never the package root.

### `ERR_REQUIRE_ESM` / `require() of ES Module` at boot
**Root cause:** Node older than 20.19 (22.12 on the 22 line): `ripple-binary-codec` 2.x pulls ES-module-only dependencies with `require(esm)`.
**Fix:** Node >= 20.19 (the images pin `node:22.23.2-bookworm-slim`; do not go back to a floating `node:20` tag).

### A GH_* value rejected at boot
**Symptom:** `GH_CATCHUP_CONCURRENCY must be a positive integer`, `GH_NODE_ENDPOINTS must be a comma separated list of ws:// or wss:// URLs`,
`GH_NETWORK must be xrpl or xahau`, `Unknown worker "x"`. **Fix:** the message names the variable; see [configuration](configuration.md).
Integers are plain digits (`1.5`, `1e3` are rejected).

## Containers and compose

### `docker compose`: "variable is not set" / `required variable ... is missing a value`
**Root cause:** `${...}` interpolation in a compose file is resolved from your shell or `--env-file`, not from a service's environment.
`GH_CLICKHOUSE_PASSWORD` and `GH_API_KEYS` are required in the production compose.

**Fix:** pass `--env-file deploy/.env.prod` to **every** compose subcommand (`up`, `ps`, `logs`, `down`, `run`), and `export NPM_TOKEN` for builds.

### The API container exits: `GH_API_KEYS must be set in production` / `contains a placeholder key`
**Root cause:** the images run with `NODE_ENV=production`, where an empty key list, `dev-api-key`, or a key starting with `change-me` is refused.
**Fix:** real keys in `deploy/.env.prod`. The dev compose runs its API with `NODE_ENV=development` so `dev-api-key` works there.

### Containers show `(unhealthy)` but the service works
**Root cause 1:** an old healthcheck used `wget`, which the slim image does not have; the current ones use Node's `fetch`.
**Root cause 2 (syncer):** the syncer opens its probe port only once its node connection is up, and answers 503 while it is more than
`GH_MAX_LAG_HEALTHY` ledgers behind for over a minute (catch-up, backfill). `unhealthy` is informational; compose restarts nothing on it.
**Fix:** read the probe body, with Node (the slim images have no `curl`):
`docker compose exec syncer-xrpl node -e "fetch('http://127.0.0.1:3002/liveliness/healthz').then(r=>r.text()).then(console.log)"` and look at `state`, `lag`, `last_commit_age`.

### ClickHouse Keeper stuck "unhealthy" -> ClickHouse will not start
**Root cause:** the healthcheck `echo ruok | nc localhost 9181` hung; this image's `nc` has no `-q`. **Fix:**
`echo ruok | nc -w1 127.0.0.1 9181 | grep -q imok` (the compose file has it).

### ClickHouse healthy but peers get `ECONNREFUSED` on :8123
**Root cause:** mounting our `config.d` shadowed the image's `docker_related_config.xml`, which sets `listen_host = 0.0.0.0`.
**Fix:** `deploy/clickhouse/config.d/cluster.xml` sets `<listen_host>0.0.0.0</listen_host>`.

### The migrate job fails on an old ClickHouse volume
**Symptom:** `Missing columns: 'checksum'`, `Unknown identifier`/`no such column` in later queries, or the schema looks wrong.

**Root cause:** the volume was created by the previous stack (`001_tables.sql` / `002_materialized_views.sql`). The baseline replaced them;
`CREATE TABLE IF NOT EXISTS` skips old tables of the same name, and the old `schema_migrations` has no `checksum` column.

**Fix (local, throw-away data):** `docker compose down -v`, then `up` again so the migrate job creates a clean database. There is no
in-place migration; re-ingest with the syncer and `range-ingest` ([deployment](deployment.md#cutover-on-an-existing-host)).

### The new syncer refuses to boot (lease) or two syncers write
**Symptom:** the syncer exits with a message that the lease is held; or an old container is still ingesting.

**Root cause:** after moving to the per-network stack the old `migrate` / `syncer` / `api` containers are **orphans** that keep running; a
syncer's lease (30 s) is held by a live or recently dead holder.

**Fix:** `docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod up -d --remove-orphans`, or `docker rm -f` the old containers; wait 30 s.

### Dev compose: port already in use, or a second stack next to the first
**Root cause:** the dev stack publishes 8123/9000, 3001-3004, 3011-3014 on 127.0.0.1, and another stack or service holds one of them.
The dev compose fixes no container name (an older version named its ClickHouse `data-api-clickhouse`), so a project name is enough to
keep two stacks apart. **Fix:** run under your own project and move the ports with their variables, e.g.
`CLICKHOUSE_HTTP_PORT=18123 CLICKHOUSE_NATIVE_PORT=19000 docker compose -p my-check up -d clickhouse` (the list of variables is at the top
of `docker-compose.yaml`; point `GH_CLICKHOUSE_URL` at the new port). The prod compose keeps fixed names for the syncers and ClickHouse:
it is one stack per host.

### nginx exits at start / `unknown directive "${TRUSTED_PROXY_DIRECTIVES}"`
**Root cause:** `16-trusted-proxies.envsh` lost its executable bit (it must stay `chmod +x`; the image sources it before rendering the
template), or `TRUSTED_PROXIES` has an invalid entry or a zero prefix (`0.0.0.0/0`), which is refused on purpose. **Fix:** restore the mode;
use plain addresses/CIDRs of your front proxy.

### Host seeder cannot reach ClickHouse in the prod compose
**Root cause:** the prod compose does not publish ClickHouse. **Fix:** for load testing only add `-f docker-compose.prod.override.yaml`
(publishes 8123). Never in production. The dev compose already publishes it on 127.0.0.1.

## Runtime and performance

### ClickHouse `Memory limit (total) exceeded`; the API is slow with idle replicas
**Symptom:** under concurrency p95 balloons and requests fail while the API replicas sit at ~0 % CPU; ClickHouse logs `Memory limit (total)
exceeded`. **Root cause:** a list query with `FINAL` merge-sorts the whole table per request and the replicas wait on ClickHouse.
**Fix:** no `FINAL` on lists ([ADR-0003](adr/0003-no-final-on-list-queries.md), [clickhouse](clickhouse.md#the-final-rule)); the per-query guards
`GH_CLICKHOUSE_MAX_QUERY_MEMORY` (`API_CLICKHOUSE_MAX_QUERY_MEMORY` for the apis in production) / `_MAX_EXECUTION_TIME` bound a
regression. A list query must read its page with `readDistinctPage`: a `LIMIT 1 BY` in the SELECT that reads the table makes ClickHouse
read most of the range ([clickhouse](clickhouse.md#reading-a-page-what-stops-the-read)); `system.query_log.read_rows` of one page should
be about a granule per part, not the range.

### Every client shares one rate-limit bucket
**Symptom:** all clients get 429 together; a single-IP load test hits 429 almost at once; the logs show the proxy's address for everybody.

**Root cause:** the throttler keys on `req.ip`. If nginx does not recover the real client, or the API trusts the wrong number of hops, `req.ip`
is the proxy.

**Fix:** set `TRUSTED_PROXIES` (deploy/.env.prod) to the address(es) of your **front proxy**, so nginx believes its `X-Forwarded-For`; keep
`GH_TRUST_PROXY_HOPS=1` (nginx hands the API exactly one address). If clients can reach nginx from a *trusted* address they can pick their own
address instead: bind nginx (`NGINX_BIND`) to the front proxy's interface. See [deployment](deployment.md#the-edge-nginx). The limit is per replica
and in memory.

### 401 `Missing or invalid API key.`
The key goes in a header (`X-API-Key: <key>` or `Authorization: Bearer <key>`), never the query string; it must be one of `GH_API_KEYS`; an empty
`X-API-Key` falls through to `Authorization`.

### 404 `Cannot GET /v2/...`
The route does not exist on this API: `/v2/network/top\_currencies` and the old GateHub `/v2/ledgers` list are gone; check the path in
[api-reference](api-reference.md). Paths ignore case but not spelling (`/v2/exchange_rates`, `/v2/active_accounts`).

### `/v2/ledgers/...` or lists are empty on a fresh database
Nothing is committed yet, or the window is before the syncer's start ledger (`GH_SYNC_START_LEDGER`, default the validated head at the first
boot). Check `SELECT min(ledger_index), max(ledger_index) FROM xrpl.ledgers` and backfill history with `range-ingest` ([backfill](backfill.md)).
`/v2/last_validated` is `500 unavailable` on an empty database.

### Volumes are empty / stats are stale
`/v2/network/exchange_volume` and `payment_volume` need markets in the markets config (`GH_MARKETS_CONFIG` or `config/markets/<network>.json`); the Xahau
file ships empty. `/v2/network/amm_volume` does not depend on the markets for its components (every pool with swaps counts), but converts them with the rates of the
markets against the native currency and of the pools, and Xahau has no AMM, so it is empty there. `/v2/stats` and the volumes (all three metrics, twelve live sets) are
written by the aggregator once a minute; after an outage or on a database with years of history the current hour lags until it has caught up
(`syncer_aggregator_stats_lag_seconds`).

### `GET /v2/amm/pools/{pool}` is 404 `pool not found` for a pool that exists
Three causes, in the order to check. (1) The pool is new: the detail and the pair form are served from `amm_pools`, which the aggregator rebuilds once a minute, so a
pool is 404 there for up to about a minute after its ledger committed while its history, swaps, liquidity and governance are already served. (2) The pool's ledgers
are not ingested: the syncer started after them and the history was not re-ingested ([backfill](backfill.md#amm-data-re-ingest)); `SELECT count() FROM xrpl.amm_pool_states
WHERE amm_account = '<pool>'`. (3) `amm_pools` fails for this pool: the aggregator log names it (`Aggregator job amm_pools failed for pool ..., set aside to be tried
again`) and `syncer_aggregator_errors_total{job="amm_pools"}` rises ([operations](operations.md#the-amm-jobs)).

### AMM swaps, pools or days are missing before a date
The ledgers were written by parser version 1, which has no AMM rows (`SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 86795265 GROUP BY
parser_version`). Re-ingest them with `--reprocess` from the enablement ledger 86795265 ([backfill](backfill.md#amm-data-re-ingest)); the aggregator then rebuilds
`amm_pools`, `amm_daily` and the AMM volume from `agg_dirty`.

### `/balances` or `/orders` answer 400 `the date provided is too old`, 404 `account not found` or 500
They read the live node (`GH_NODE_ENDPOINTS` of the **api**): a date before the first stored ledger or a ledger the node no longer has is the
400; an address the node does not know is the 404; an unreachable node is the 500 `unable to retrieve balances|orders`. Check the node and the
api log (`XrplService`).

### Syncer: `Node network_id N does not match GH_NETWORK=...`
The endpoint belongs to another network (an XRPL node for a Xahau syncer, or the reverse). Fix `GH_NODE_ENDPOINTS` / `XRPL_NODE_ENDPOINTS` /
`XAHAU_NODE_ENDPOINTS`.

### `rate limit: units quota ... exhausted, retry in ~<N>ms` / `It rate limits this client`
A public node throttles this process. The node client pauses that endpoint for the time it named (logged once, counted in
`syncer_node_rate_limited_total` / `api_node_rate_limited_total`) and uses the next endpoint of `GH_NODE_ENDPOINTS` meanwhile;
nothing is lost, the syncer waits. If it happens all the time: lower `GH_CATCHUP_CONCURRENCY` (2 for `wss://xahau.network`), list
a second endpoint, or use a node of your own. For `range-ingest` see [backfill](backfill.md#public-nodes-and-rate-limits).

### Syncer: lag does not fall / halted
See [operations](operations.md#after-an-outage): a node without the history (`complete_ledgers`), ClickHouse refusing writes (`system.mutations`,
the probe's `recovering`/`error`), a chain break, a ledger the parser rejects (`error: Cannot parse ledger <index>: ...`) or a lost lease
(`state=halted`, see [operations](operations.md#syncer-halted)).

### `api_tx_encode_fallback_total` rises
A transaction type or field is missing from the binary-codec definitions in use, so those transactions are served as their stored JSON. The
definitions come from the node's `server_definitions` (at api boot) with the bundled `config/definitions/<network>.json` as fallback: restart
the api against an up-to-date node, or refresh the bundled file with `record:fixtures`.

### Validations are missing for recent ledgers
The collector subscribes to the `validations` stream of every node in `GH_VALIDATION_ENDPOINTS` and only sees what those nodes publish; use
several independent nodes. Check `syncer_validations_flushed_total`, `syncer_validations_dropped_total{reason}` and the `ValidationsCollector` log.

## Load testing reality check

A laptop running the whole stack plus the load generator is CPU-bound by the box, not the architecture. For meaningful numbers run the generator on
another machine against a real deployment, raise `GH_RATE_LIMIT`, and keep the syncer from competing. See [load/README.md](../load/README.md).

## Quick diagnostics

```bash
# is ClickHouse reachable from the app network?
docker compose exec api-xrpl node -e "fetch('http://clickhouse:8123/ping').then(r=>console.log(r.status))"

# what is slow in ClickHouse right now?
docker compose exec clickhouse clickhouse-client -q "SELECT query_id, formatReadableSize(memory_usage), elapsed, substring(query,1,80) FROM system.processes ORDER BY memory_usage DESC"

# health and metrics (inside the compose network)
docker compose exec api-xrpl node -e "fetch('http://127.0.0.1:3001/liveliness/healthz').then(r=>r.text()).then(console.log)"
docker compose exec syncer-xrpl node -e "fetch('http://127.0.0.1:3000/metricz').then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>l.startsWith('syncer_')&&!l.startsWith('#')).join('\n')))"
```
