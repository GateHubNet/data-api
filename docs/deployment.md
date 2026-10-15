# Deployment

How the GateHub Data API is packaged and deployed. For day-2 operations (scaling,
backfill, incidents) see [operations.md](operations.md).

## Topology

Both services run **behind the GateHub reverse proxy**, which terminates TLS and routes
traffic. The services speak plain HTTP internally and trust the proxy's `X-Forwarded-For`
for client identification (rate limiting, logging).

```
                         ┌─────────────────────────────┐
   Internet ──HTTPS────▶ │  GateHub reverse proxy      │   (TLS termination, edge routing)
                         └──────────────┬──────────────┘
                                        │ HTTP, X-Forwarded-For
                          ┌─────────────┴─────────────┐
                          ▼                           ▼
                ┌───────────────────┐       (internal only, no public route)
                │  api (N replicas) │       ┌───────────────────┐
                │  stateless, :3001 │──────▶│   ClickHouse      │◀──────┐
                └───────────────────┘  SQL  │  (+ Keeper for HA)│       │ bulk insert
                                             └───────────────────┘       │
                                                                ┌────────┴────────┐
                                        XRPL node ◀────WS───────│  syncer (1..N)  │
                                                                │  internal only  │
                                                                └─────────────────┘
```

Key points:

- **api** is **stateless and horizontally scalable** — run as many replicas as you need;
  the proxy / orchestrator load-balances across them.
- **syncer** is a worker. Run **one** instance for live sync; run **multiple sharded
  instances** for a fast backfill (see [syncer.md](syncer.md#sharding)). It exposes only
  health/metrics over HTTP.
- **ClickHouse** (and Keeper) are **internal-only** — never publicly exposed.

## Build

Both images build from the **repo root** (the build context is the whole workspace) on the
public `node:20-bookworm-slim` base and run as the non-root `node` user.

```bash
# NPM_TOKEN is needed only at BUILD time, to install the private @gatehub/toolbox.
export NPM_TOKEN="$(grep '//registry.npmjs.org/:_authToken=' ~/.npmrc | tail -1 | sed 's/.*_authToken=//' | tr -d '"[:space:]')"

docker build -f apps/api/Dockerfile    --build-arg NPM_TOKEN="$NPM_TOKEN" -t gatehub/data-api    .
docker build -f apps/syncer/Dockerfile --build-arg NPM_TOKEN="$NPM_TOKEN" -t gatehub/data-syncer .
```

Notes:
- The build does `pnpm install` + build + `pnpm deploy` in a **single RUN layer** (pnpm
  workspace symlinks don't survive across BuildKit layers), and `*.tsbuildinfo` is
  git/docker-ignored (a stale one makes `tsc` skip emit). See
  [troubleshooting.md](troubleshooting.md) for why.
- The api image also generates `dist/swagger.json` at build time.
- **Registry-pushed images:** the `NPM_TOKEN` build-arg lands in the *builder* layer's
  history. For images you push to a shared registry, switch the Dockerfiles to BuildKit
  secrets (`RUN --mount=type=secret,id=npm …`) so the token is never persisted.

## Schema migrations

Migrations are **owned by a one-shot job**, not run on every replica at boot:

- The production compose runs a `migrate` service that executes
  `node node_modules/@gatehub/data-api-shared/dist/clickhouse/migrate.js` once and exits;
  `api` and `syncer` wait for it (`depends_on: condition: service_completed_successfully`).
- It is idempotent and tracked (a `schema_migrations` table records applied files).
- In the syncer, `GH_RUN_MIGRATIONS_ON_BOOT` should be **`false`** in production (it's
  convenient for local dev). See [data-model.md](data-model.md#migrations).

## Configuration & secrets

All configuration is via environment variables ([configuration.md](configuration.md)).
In production, inject them from your **secrets manager** (Vault / AWS Secrets Manager /
k8s Secrets) — never commit them. `.env` files are git-ignored; `.env.example` /
`deploy/.env.prod.example` are templates.

Sensitive values: `GH_API_KEYS`, `GH_CLICKHOUSE_PASSWORD`, and the build-time `NPM_TOKEN`.

## Option 1 — Docker Compose (reference / staging)

`docker-compose.prod.yaml` is a production-shaped topology you can run on one host:
Keeper → ClickHouse → one-shot migrate → syncer + scalable api → a local nginx stand-in
for the reverse proxy.

```bash
cp deploy/.env.prod.example deploy/.env.prod      # fill in GH_CLICKHOUSE_PASSWORD + GH_API_KEYS
export NPM_TOKEN="…"                              # see Build
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod up -d --build --scale api=8
docker compose -f docker-compose.prod.yaml logs -f migrate   # wait for it to exit 0
```

- The `nginx` service is a **local stand-in for the GateHub reverse proxy** (it forwards
  `X-Forwarded-For`; it does **not** do TLS — that's the GateHub proxy's job in real prod).
  In a real GateHub deployment you drop nginx and put the API behind the GateHub proxy.
- ClickHouse is **not** published to the host. `docker-compose.prod.override.yaml` adds a
  host port for load-test seeding only — never use it in production.
- `--env-file` is required (the compose interpolates `${…}` from it); so is `NPM_TOKEN`.

Caveats observed on a single laptop: 8 api replicas + ClickHouse + Keeper + a load
generator oversubscribe CPU — fine as a functional/staging setup, not a capacity benchmark.
See [operations.md](operations.md#load--capacity-testing).

## Option 2 — Kubernetes (recommended for production)

The architecture maps cleanly to k8s; manifests are not shipped, but the shape is:

- **api**: a `Deployment` (≥ 2 replicas) + `Service` + `HorizontalPodAutoscaler` on CPU /
  request rate. Behind the GateHub proxy / ingress. Liveness probe → `GET /liveliness/healthz`;
  readiness probe → the same (it pings ClickHouse). Resource requests/limits per pod.
- **syncer**: a `Deployment` with **1** replica for live sync. For a backfill, a separate
  `Job`/`Deployment` per shard (`GH_BACKFILL_SHARD_INDEX`/`TOTAL`). Liveness/metrics on
  `:3002`. It is **not** behind the public proxy.
- **migrate**: a `Job` (or Helm pre-install/pre-upgrade hook) run once per release before
  rolling api/syncer.
- **ClickHouse**: a managed service, or the
  [Altinity ClickHouse Operator](https://github.com/Altinity/clickhouse-operator) with
  `ReplicatedReplacingMergeTree` engines + Keeper (see [clickhouse.md](clickhouse.md#high-availability--replication)).
- **Config/secrets**: `ConfigMap` for non-secret env, `Secret` for `GH_API_KEYS` /
  `GH_CLICKHOUSE_PASSWORD`, mounted as env.
- **Metrics**: scrape `/metricz` on both services (PodMonitor/ServiceMonitor); scrape
  ClickHouse via its Prometheus endpoint / exporter. See [observability.md](observability.md).

## Scaling guidance

- **API throughput** ≈ replicas × per-replica capacity (~100 req/s of heavy mixed queries
  per replica in our tests; lighter/cached endpoints far more). Scale on CPU or request
  latency. ClickHouse had ample headroom once `FINAL` was removed.
- **Ingest throughput** is XRPL-node-bound then ClickHouse-write-bound. Tune
  `GH_BACKFILL_WORKERS`, `GH_BACKFILL_BATCH_LEDGERS`, `GH_FETCH_THROTTLE_MS`; shard across
  instances and nodes for a big backfill. See [backfill.md](backfill.md) and
  [syncer.md](syncer.md).
- **ClickHouse** is the shared dependency — scale it (more RAM/CPU, replicas for read
  fan-out) before adding many api replicas.

## Rollout & health

- Roll api replicas one at a time; readiness gates traffic until ClickHouse is reachable.
- The syncer is safe to restart anytime — it re-derives progress from ClickHouse and resumes
  idempotently (no double counting). A backfill resumes from where it left off.
- Run migrations before rolling new code that depends on schema changes.
