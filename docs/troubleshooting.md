# Troubleshooting

Concrete failures encountered building and running this system, each with the symptom, the
root cause, and the fix. These are real — not hypothetical — and several are now guarded
against in code/config.

## Build & packaging

### `tsc` emits nothing / `Cannot find module '@gatehub/data-api-shared'`
**Symptom:** a clean Docker build fails the API typecheck with 26 `Cannot find module`
errors, even though `pnpm build` works locally. Or locally, a rebuild produces a near-empty
`dist/`.

**Root cause:** TypeScript `incremental`/`composite` writes a `*.tsbuildinfo`. If a stale one
is present (it was being copied into the Docker context) while `dist` is absent/wiped, `tsc`
thinks outputs are current and **emits nothing**. The shared lib's `dist/index.d.ts` is then
missing, so the API can't resolve its types.

**Fix:** `**/*.tsbuildinfo` is in [`.dockerignore`](../.dockerignore); `incremental` was
removed from the base tsconfig. Locally, if you hit it: delete `*.tsbuildinfo` and `dist`,
rebuild. (nest's `deleteOutDir` + incremental is the underlying trap.)

### Docker build: workspace package not found after `pnpm install`
**Symptom:** `pnpm install` in one `RUN` layer, build in the next → the shared package's
symlink isn't resolvable.

**Root cause:** pnpm's workspace symlinks don't survive across separate BuildKit layers.

**Fix:** the Dockerfiles do `pnpm install && … build && … deploy` in **one `RUN`**.

### `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`
**Symptom:** `pnpm deploy` fails at the end of the build.

**Root cause:** pnpm v10 refuses `deploy` without injected workspaces by default.

**Fix:** the Dockerfiles use `pnpm … --legacy deploy --prod /app/out`.

### `.env` not loaded → service uses default config
**Symptom:** the service connects to `localhost` ClickHouse / has no API keys despite a
populated `.env`.

**Root cause:** nothing loaded the `.env` file.

**Fix:** both `main.ts` import `dotenv/config` as the first import. `node dist/main.js` must
run from the service dir (or use `pnpm --filter … start:prod`) so `dotenv` finds `.env`.

### Query params rejected / `limit must be an integer`
**Symptom:** `?limit=200` → 400 "must be an integer / not greater than 1000".

**Root cause:** query strings are strings; class-transformer didn't coerce.

**Fix:** numeric DTO fields use `@Type(() => Number)`.

## Containers & compose

### `docker compose` "variable is not set" / interpolation error
**Symptom:** `required variable GH_CLICKHOUSE_PASSWORD is missing a value`.

**Root cause:** service-level `env_file:` populates the *container's* env, but `${…}`
**interpolation in the compose file** is resolved only from your shell or `--env-file`.

**Fix:** pass `--env-file deploy/.env.prod` to the compose command, and `export NPM_TOKEN`.
All compose subcommands (`ps`, `stop`, `logs`, `down`) need `--env-file` too.

### Containers show `(unhealthy)` but the service works
**Symptom:** every api/syncer container is "unhealthy"; the app serves fine.

**Root cause:** the healthcheck used `wget`, which **isn't in `node:20-bookworm-slim`**.

**Fix:** the compose healthchecks use Node's global fetch:
`node -e "fetch('http://localhost:3001/liveliness/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`.

### ClickHouse Keeper stuck "unhealthy" → ClickHouse won't start
**Symptom:** `Container ch-keeper Error dependency ... failed to start`; Keeper logs show it's
actually "Ready for connections".

**Root cause:** the healthcheck `echo ruok | nc localhost 9181` **hung** — this image's `nc`
has no `-q` flag and no timeout, so it waited forever and timed out.

**Fix:** `echo ruok | nc -w1 127.0.0.1 9181 | grep -q imok`.

### ClickHouse healthy but peers get `ECONNREFUSED` on :8123
**Symptom:** ClickHouse passes its own `/ping` healthcheck (localhost) but the migrate/api
containers can't connect to `clickhouse:8123`.

**Root cause:** mounting our `config.d` directory **shadowed the image's
`docker_related_config.xml`**, which is what makes ClickHouse `listen_host = 0.0.0.0`. Without
it, ClickHouse binds to localhost only and rejects peer containers.

**Fix:** `deploy/clickhouse/config.d/cluster.xml` sets `<listen_host>0.0.0.0</listen_host>`.

### Host seeder can't reach ClickHouse in the prod compose
**Symptom:** `load/seed.js` gets connection refused against `localhost:8123`.

**Root cause:** the prod compose deliberately does **not** publish ClickHouse to the host.

**Fix:** for load testing only, add `-f docker-compose.prod.override.yaml` (publishes 8123).
Never in production.

## Runtime & performance

### ClickHouse `Memory limit (total) exceeded`; API slow with idle replicas
**Symptom:** under concurrency, p95 balloons to tens of seconds and ~30% of requests fail,
while the API replicas sit near 0% CPU. ClickHouse logs `Memory limit (total) exceeded`.

**Root cause:** list endpoints used `... FROM table FINAL`. `FINAL` merge-sorts the whole
table **per query**; under concurrency it exhausts ClickHouse memory. The API replicas were
idle because they were *blocked waiting* on ClickHouse.

**Fix:** **removed `FINAL` from all list/scan queries** (kept only on selective single-row
lookups; top-currencies uses `argMax`). Verified: ~30% errors / p95 30s → **0% errors / 178
req/s / p95 2.9s** at the same load. Plus per-query guards
(`GH_CLICKHOUSE_MAX_QUERY_MEMORY`, `_MAX_EXECUTION_TIME`). See
[clickhouse.md](clickhouse.md#the-final-rule).

### Rate limiter throttles everyone as one bucket
**Symptom:** behind the proxy, all clients share one rate-limit bucket; or a single-IP load
test gets 429s almost immediately.

**Root cause:** the throttler keyed on the connecting IP, which behind a proxy is the
**proxy's** IP for every request.

**Fix:** `app.set('trust proxy', GH_TRUST_PROXY_HOPS)` so `req.ip` resolves to the real
client from `X-Forwarded-For`. Note the limit is still **per-replica in-memory** — for a true
global limit use a shared store (Redis); see [security.md](security.md).

### `network` volume endpoints reject `start`/`end` with 400
**Symptom:** `?start=…&end=…` on `/v2/network/payment_volume` → 400.

**Root cause:** the global `forbidNonWhitelisted` validator rejects params not declared on the
DTO; `VolumeQueryDto` was missing `start`/`end`.

**Fix:** added `start`/`end` (`@IsDateString`) to `VolumeQueryDto`.

### `npm config get` returns empty for the auth token
**Symptom:** can't read the registry token to pass as `NPM_TOKEN`.

**Root cause:** npm 9+ **redacts** auth tokens from `npm config get`.

**Fix:** read it from the file:
`export NPM_TOKEN="$(grep '//registry.npmjs.org/:_authToken=' ~/.npmrc | tail -1 | sed 's/.*_authToken=//' | tr -d '"[:space:]')"`.

## Load testing reality check
A single laptop running the whole stack **plus** the load generator is CPU-bound by the box,
not the architecture (we saw 56 containers on 16 cores degrade everything). For meaningful
numbers: run the load generator on a separate machine against a real deployment, raise the
rate limit, and isolate reads from the syncer. See [operations.md](operations.md#load--capacity-testing).

## Quick diagnostics
```bash
# is ClickHouse reachable from the app network?
docker run --rm --network <compose-net> curlimages/curl -s -o /dev/null -w '%{http_code}\n' http://clickhouse:8123/ping

# what's slow in ClickHouse right now?
clickhouse-client -q "SELECT query_id, formatReadableSize(memory_usage), elapsed, substring(query,1,80) FROM system.processes ORDER BY memory_usage DESC"

# api/syncer health & metrics
curl -s localhost:3001/liveliness/healthz; curl -s localhost:3001/metricz | grep api_http_requests_total
```
