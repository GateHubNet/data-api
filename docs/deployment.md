# Deployment

How the GateHub Data API is packaged and deployed: **one deployment per network** (XRP Ledger and Xahau), the same images for
both, on one ClickHouse server with one database per network. For day-2 work (scaling, backfill, incidents) see
[operations](operations.md); every variable is in [configuration](configuration.md).

## Topology

```
                      TLS terminates here
   Internet ──HTTPS──▶ front proxy / load balancer   (GateHub reverse proxy; its address = TRUSTED_PROXIES)
                              │ HTTP, X-Forwarded-For / -Proto
                              ▼
                       ┌─────────────┐   Host: xrpl.data.<domain>  ──▶ api-xrpl:3001   (N replicas)
                       │   nginx     │   Host: xahau.data.<domain> ──▶ api-xahau:3001  (N replicas)
                       └─────────────┘   other hosts: 404 JSON;  /healthz for the load balancer
                                          api-xrpl / api-xahau   (stateless)
                                                  │ SQL            │ live-state requests (balances, orders)
                                                  ▼                ▼
   ClickHouse Keeper ─▶ ClickHouse  ◀── syncer-xrpl  ──────▶ XRPL node(s)     databases:  xrpl
                        (one server) ◀── syncer-xahau ──────▶ Xahau node(s)                xahau
                              ▲
                        migrate-xrpl, migrate-xahau   (one-shot: create the database, apply the schema)
```

- **api-xrpl / api-xahau** are stateless and scale horizontally.
- **syncer-xrpl / syncer-xahau** are singletons: exactly one per network, enforced by a fixed `container_name` (compose refuses
  to scale it; keep the names, they are that mechanism) and by a lease in ClickHouse (a second syncer refuses to boot). The fixed
  names (`data-syncer-*`, `ch-keeper`, `ch-server`) also mean one prod stack per Docker host; the dev `docker-compose.yaml` fixes
  none and takes its host ports from variables, so it can run next to another stack. They expose only the probe and metrics.
- **ClickHouse** and **Keeper** are internal: never publish them. **nginx** is the only service with a host port.
- The API answers the same `/v2/...` paths on both hosts; the **host name** selects the network
  ([api-reference](api-reference.md#hosts-one-per-network)). Native currency per network: `XRP` / `XAH`.

## Build

Both images build from the **repo root** (the context is the whole workspace) on the public `node:22.23.2-bookworm-slim` base
(Node >= 20.19 is required) and run as the non-root `node` user. The private `@gatehub/toolbox` needs your npm token at install
time. The token is passed as a **BuildKit secret** read from the `NPM_TOKEN` environment variable: it is mounted for one `RUN` only,
written to `~/.npmrc` inside it and removed before the layer is committed. It is never a build argument or environment variable and
is in no layer or `docker history`.

```bash
export NPM_TOKEN=...      # the npm token that can read @gatehub/toolbox; do not copy it from ~/.npmrc into files

# through compose (the build.secrets of the compose files read NPM_TOKEN)
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod build

# or one image by hand
docker build --secret id=npm_token,env=NPM_TOKEN -f apps/api/Dockerfile    -t gatehub/data-api    .
docker build --secret id=npm_token,env=NPM_TOKEN -f apps/syncer/Dockerfile -t gatehub/data-syncer .
```

Without the secret the build stops with `secret npm_token: not found` (an empty secret: `the npm_token secret is empty`).

Notes:
- The image names are always built from this checkout (`pull_policy: build`); they are not looked up in any registry. Tags:
  `IMAGE_TAG` (default `latest` in prod, `dev` in the dev compose).
- Install, build and `pnpm deploy` run in a **single `RUN`** (pnpm workspace symlinks do not survive across BuildKit layers); the
  build then checks that the deployed shared package contains `dist`, `schema/001_baseline.sql`, `config/markets/*.json` and
  `config/definitions/*.json`, and the syncer image `dist/cli/range-ingest.js`. `*.tsbuildinfo` is ignored by git and docker (a stale
  one makes `tsc` skip emit).
- The images set `NODE_ENV=production` and `GH_ENV=container` (no env file: the configuration is the environment).
- `EXPOSE`: api `3001` + `3000` (metrics), syncer `3002` + `3000`. Never publish the metrics port.
- Entry points of the syncer image (all relative to `/app`): `node dist/main.js` (default), the migration job below, and
  `node dist/cli/range-ingest.js --from <n> --to <m>`.

## Schema migrations

Migrations are **owned by one-shot jobs**, not run on every replica at boot:

- The compose files run `migrate-xrpl` and `migrate-xahau` — the syncer image running
  `node node_modules/@gatehub/data-api-shared/dist/clickhouse/migrate.js` with `GH_NETWORK` set. Each creates its database
  (`xrpl` / `xahau`, through a connection to `default`) and applies `schema/*.sql` that is not yet recorded in
  `schema_migrations`, then exits 0. The apis and syncers wait for their job (`depends_on: service_completed_successfully`).
- The path is `node_modules/@gatehub/data-api-shared/...`, not `packages/shared/...`: inside the image the shared package is a
  deployed dependency (`pnpm deploy --legacy`), and `packages/shared` does not exist.
- It is idempotent and checksummed. By hand: `docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm migrate-xrpl`.
- `GH_RUN_MIGRATIONS_ON_BOOT` is `false` in the compose files (convenient only for a single dev process). See
  [data-model](data-model.md#5-migrations).

## Configuration and secrets

All configuration is environment variables ([configuration](configuration.md)). In production inject them from a secrets manager;
never commit them. `.env*` files are git-ignored (only `.env.example` files are committed) and excluded from the Docker build
context. Secrets: `GH_API_KEYS`, `GH_CLICKHOUSE_PASSWORD`, node URLs that carry credentials, and the build-time `NPM_TOKEN`.

### `deploy/.env.prod`

`deploy/.env.prod` is only the `--env-file` of `docker compose` (interpolation): **no container gets it as a whole**. Each service
in `docker-compose.prod.yaml` lists the variables it needs ([which service gets what](configuration.md#which-service-gets-which-variables-production-compose)),
so `GH_API_KEYS` reaches only the apis. Start from the template:

```bash
cp deploy/.env.prod.example deploy/.env.prod       # then fill in the secrets; the file is git-ignored
```

The format changed with the per-network rewrite. If you have an `.env.prod` from the previous stack, **drop** what the template no longer has:
the variables of the single-network design (the XRPL network id, the single `GH_XRPL_NODE_ENDPOINT`, the `GH_BACKFILL` group of seven variables, the
live-subscription switch, the fetch throttle, the `GH_LOGGER` pair). Nothing reads them any more and a stray variable is simply ignored. **Add** the per-network
`XRPL_*` / `XAHAU_*` variables (`*_NODE_ENDPOINTS`, `*_VALIDATION_ENDPOINTS`, `*_SYNC_START_LEDGER`, `*_MARKETS_CONFIG`), plus `TRUSTED_PROXIES` / `NGINX_BIND`; the
template lists every variable with a comment, diff your file against it. `GH_API_KEYS` and `GH_CLICKHOUSE_PASSWORD` are required (the compose file stops without
them), and the API refuses placeholder keys (`dev-api-key`, `change-me...`).

## Option 1: Docker Compose (reference / single host)

```bash
cp deploy/.env.prod.example deploy/.env.prod
$EDITOR deploy/.env.prod                                    # GH_CLICKHOUSE_PASSWORD, GH_API_KEYS, TRUSTED_PROXIES, NGINX_BIND, node URLs
export NPM_TOKEN=...
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod up -d --build
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod ps
```

Start order: Keeper (healthy) -> ClickHouse (healthy) -> `migrate-xrpl` / `migrate-xahau` (complete) -> syncers and apis ->
nginx. The syncer opens its probe port only once its node connection is up, and answers 503 while it is more than
`GH_MAX_LAG_HEALTHY` ledgers behind for over a minute (catching up): `unhealthy` there is informational, compose restarts nothing
on it.

Scale the read tier of a network (compose has no rolling update; **repeat the `--scale` flags on every `up`**: a plain `up -d` scales the apis back to 1):

```bash
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod up -d --scale api-xrpl=3 --scale api-xahau=2
```

**Never scale a syncer** (`--scale syncer-xrpl=2` is refused, by design).

Backfill or repair a range while the stack runs (the live syncer keeps running; the CLI checks its lease):

```bash
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm --no-deps syncer-xrpl \
  node dist/cli/range-ingest.js --from 90000000 --to 90100000
```

### Cutover on an existing host

The previous stack had services named `migrate`, `syncer` and `api` (one network). Moving that host to the per-network stack:

```bash
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod up -d --build --remove-orphans
```

**`--remove-orphans` matters.** The old `migrate`, `syncer` and `api` containers belong to services that are no longer in the file;
without the flag compose leaves them running as orphans. An old syncer that keeps running would keep writing (to the replaced
schema, or — if it is already the new code — holding the single-writer lease, which makes the new syncer refuse to boot with a
`lease` message). After the cutover `docker ps` should show only `ch-keeper`, `ch-server`, `data-syncer-xrpl`, `data-syncer-xahau`
and the compose-named `api-xrpl-*`, `api-xahau-*`, `nginx` containers.

**Old ClickHouse volumes.** The schema baseline was replaced (`001_baseline.sql` took over from `001_tables.sql` and
`002_materialized_views.sql`, which were never deployed). A volume from the old stack carries old tables and old `schema_migrations`
rows, and the migrate job fails on it. For **local / throw-away** volumes recreate it: `docker compose down -v` (this deletes the
data), then `up` again. Nothing in the new schema can be migrated in place from the old one; re-ingest with the syncer and
`range-ingest`.

**Local `deploy/.env.prod`.** Update it to the new format (above) before the first `up`.

### The edge: nginx

`deploy/nginx/nginx.conf.template` is rendered at container start by the official image's entrypoint:

- **Host routing:** `xrpl.data.*` -> `api-xrpl:3001`, `xahau.data.*` -> `api-xahau:3001`; any other host gets
  `{"result":"error","message":"unknown host: ..."}` (404), and `/healthz` on the default server answers 200 for the load balancer.
  Upstreams are variables, resolved per request through Docker DNS, so scaled replicas are all used and nginx starts even while an
  api is down (that host then answers 502).
- **Client address.** TLS ends at the front proxy, which appends the client to `X-Forwarded-For`. nginx takes the real client from
  that header **only when the connection comes from a `TRUSTED_PROXIES` address** (comma separated addresses / CIDRs, default the
  private ranges), then **sets** (never appends) `X-Forwarded-For` to that one address, so the API sees exactly one address and
  `GH_TRUST_PROXY_HOPS=1` is right. `X-Forwarded-Proto` is passed through from a trusted peer only (`http`/`https`).
  **Set `TRUSTED_PROXIES` to your front proxy, and bind nginx (`NGINX_BIND`, `NGINX_PORT`) to an interface only that proxy can reach.**
  With the defaults, a client that reaches the published port from a private address (on Docker Desktop, every connection) can
  pick its own address and get a rate-limit bucket per request. `0.0.0.0/0` and any zero prefix length are refused at start.
- **Blocked paths** (case-insensitive, after URI normalisation): `/internal/` (Swagger) is 404 for everyone; `/liveliness/` answers
  only trusted proxies.
- TLS is not done here: terminate it in front, or add `listen 443 ssl` and certificates to the template
  ([ADR-0006](adr/0006-reverse-proxy-tls.md)).

`docker-compose.prod.override.yaml` publishes ClickHouse (8123) on the host for load-test seeding only; never use it in production.

## Option 2: local development stack

`docker-compose.yaml` is the development stack: one ClickHouse and, per network, a migrate job, a syncer and an api — the same images.

```bash
docker compose up -d clickhouse                              # only ClickHouse; run the apps from source (docs/development.md)
NPM_TOKEN=... docker compose --profile full up -d --build    # + the XRPL stack: migrate-xrpl, syncer-xrpl, api-xrpl
NPM_TOKEN=... docker compose --profile xahau up -d --build   # + the Xahau stack
NPM_TOKEN=... docker compose --profile full --profile xahau up -d --build    # both
docker compose run --rm migrate-xahau                        # the schema of one network on its own
```

- **Everything is published on 127.0.0.1** only: ClickHouse 8123/9000; api-xrpl 3001 (metrics 3003), syncer-xrpl 3002 (3004),
  api-xahau 3011 (3013), syncer-xahau 3012 (3014).
- The API key defaults to **`dev-api-key`** (override with `GH_API_KEYS`); the dev apis run with `NODE_ENV=development` so that this
  placeholder is allowed. Never use it anywhere reachable.
- The stack is configured from the environment of your shell (`GH_CLICKHOUSE_USER`, `GH_CLICKHOUSE_PASSWORD`, `GH_API_KEYS`,
  `XRPL_NODE_ENDPOINTS`, ...); `apps/*/.env` is not read.
- ClickHouse has no `CLICKHOUSE_DB`: the migrate jobs create the databases. An existing volume from the old stack must be recreated
  (`docker compose down -v`).

## Option 3: Kubernetes

Manifests are not shipped; the shape is:

- **api** per network: a `Deployment` (>= 2 replicas) + `Service`, behind the front proxy/ingress with host routing like the nginx
  above. Liveness and readiness -> `GET /liveliness/healthz` (it pings ClickHouse).
- **syncer** per network: a `Deployment` with **1 replica** and the `Recreate` strategy (never two at once; the lease is a second
  line of defence). Probe on `:3002`. Not behind the public proxy.
- **migrate** per network: a `Job` (or a Helm pre-install/pre-upgrade hook) run once per release before the apps roll.
- **ClickHouse**: a managed service or the Altinity operator with `Replicated*MergeTree` engines + Keeper
  ([clickhouse](clickhouse.md#high-availability-and-replication)); the shipped schema uses plain `ReplacingMergeTree`.
- **Config/secrets:** `ConfigMap` for non-secret env, `Secret` for `GH_API_KEYS` / `GH_CLICKHOUSE_PASSWORD`; do not give the syncer
  the api keys.
- **Metrics:** scrape `/metricz` (port 3000) of every pod ([observability](observability.md)).

## Scaling guidance

- **API throughput** ~ replicas x per-replica capacity; scale on CPU or request latency. ClickHouse had ample headroom once `FINAL`
  was removed from list queries ([ADR-0003](adr/0003-no-final-on-list-queries.md)).
- **Ingest** is node-bound, then ClickHouse-write-bound; one syncer per network cannot be sharded. Speed up history with
  `range-ingest --concurrency` against your own node ([backfill](backfill.md)).
- **ClickHouse** is the shared dependency: scale it (RAM, CPU, disk) before adding many api replicas. The compose file limits it to 8 GB.

## Rollout and health

- Run migrations before the code that needs them (compose does it for you in start order).
- **Compose has no rolling update and no zero-downtime deploy.** `up -d` recreates all containers of a changed service together, so a release means a brief outage
  of that service (nginx answers 502 for that network's host while the new api containers start; the other network is unaffected). Options without promises: an
  orchestrator with rolling updates for the same images (Kubernetes, above), or a second compose project next to the first with the nginx upstream switched
  between them. The healthcheck (`start_period` 30 s) tells you when an api is up.
- The syncer is safe to restart at any time: it re-derives its position from ClickHouse, cleans its uncommitted tail and resumes
  with no double counting ([syncer](syncer.md#checkpoint-boot-and-recovery)). It gets a 30 s grace period to finish its write.
