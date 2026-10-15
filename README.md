# GateHub Data API (ClickHouse edition)

A rewrite of the GateHub XRPL Data API. It indexes the XRP Ledger and serves
historical data (payments, exchanges, ledgers, accounts, network analytics) over a
REST API. **Storage is ClickHouse**, not Elasticsearch — see
[docs/elasticsearch-to-clickhouse.md](docs/elasticsearch-to-clickhouse.md) for why.

This is a **pnpm workspace** with two services and one shared library. Each service
follows the GateHub `gh-bridge` NestJS template (config, logger, liveliness + Prometheus
modules, two-stage Dockerfile).

```
data-api-new/
├── apps/
│   ├── api/        @gatehub/data-api-service — REST API (reads ClickHouse)
│   └── syncer/     @gatehub/data-syncer      — ingests XRPL → ClickHouse
├── packages/
│   └── shared/     @gatehub/data-api-shared  — parsers, ClickHouse client, schema, utils
├── docs/           architecture, data model, backfill guide, migration notes, OpenAPI
└── docker-compose.yaml
```

## What changed vs. the old project

The original code review (see `GateHub-Data-API-Review.pdf` in the old repo) drove these fixes:

| Area | Old | New |
| --- | --- | --- |
| Store | Elasticsearch (per-request Painless aggregations) | ClickHouse (columnar, materialized views) |
| Idempotency | auto `_id` → duplicates on replay | `ReplacingMergeTree` keyed on CTID — replay-safe |
| Issuer trustlines | per-tx `account_lines` RPC at `validated` (slow + historically wrong) | derived from tx metadata (no RPC, correct as-of-ledger) |
| Parser bug | `data.account = tx.Account` (assignment) | fixed to comparison + regression test |
| Resilience | errored ledgers dropped silently | bounded retries; failures logged, re-runnable |
| Health/metrics | none | `/liveliness/healthz` + `/metricz` on both services |
| Secrets | `.env` committed | `.env` git-ignored; `.env.example` only |
| Pagination | ES `search_after` | ClickHouse keyset (cursor) pagination |
| Reports | swallowed errors as fake success, truncated totals | exact DB aggregation, real errors |
| Structure | Nx monorepo, two Nest apps duplicating ES config | pnpm workspace, shared library, gh-bridge template |

## Quickstart (local)

Prerequisites: Node ≥ 20, pnpm ≥ 10, Docker. `@gatehub/toolbox` is private — export an
`NPM_TOKEN` with access before installing.

```bash
# 1. install
pnpm install

# 2. start ClickHouse
docker compose up -d clickhouse

# 3. create the schema (tables + materialized views)
cp apps/syncer/.env.example apps/syncer/.env
cp apps/api/.env.example   apps/api/.env
pnpm ch:migrate            # runs packages/shared/schema/*.sql

# 4. run the syncer (backfill + live) and the API
pnpm start:syncer          # ingests XRPL → ClickHouse
pnpm start:api             # serves REST on :3001, docs on /internal/docs
```

Backfilling two years of history? Read [docs/backfill.md](docs/backfill.md) first — it
covers node choice (and whether to run your own rippled).

## Build & test

```bash
pnpm build                 # builds shared, then both apps
pnpm test                  # unit tests (parsers, ctid, pagination)
pnpm --filter @gatehub/data-api-service swagger   # writes apps/api/dist/swagger.json
```

## Docs

**Full documentation index: [docs/README.md](docs/README.md)** — architecture, data model,
API reference, configuration, deployment, operations runbook, syncer deep-dive, ClickHouse
tuning, security, observability, development guide, troubleshooting, and ADRs.

Quick links:
- [Architecture](docs/architecture.md) · [API reference](docs/api-reference.md) · [Configuration](docs/configuration.md)
- [Deployment](docs/deployment.md) · [Operations runbook](docs/operations.md) · [Troubleshooting](docs/troubleshooting.md)
- [Data model](docs/data-model.md) · [ClickHouse](docs/clickhouse.md) · [Syncer](docs/syncer.md) · [Backfilling](docs/backfill.md)
- [Security](docs/security.md) · [Observability](docs/observability.md) · [Development](docs/development.md) · [ADRs](docs/adr/)
- [Elasticsearch → ClickHouse](docs/elasticsearch-to-clickhouse.md) · [OpenAPI](docs/openapi.yaml) (also live at `/internal/docs`)

## Authentication

All `/v2/*` endpoints require an API key; operational paths (`/liveliness/healthz`,
`/metricz`, `/internal/docs`) are open. Send the key in a header:

```
X-API-Key: <key>            # or:  Authorization: Bearer <key>
```

Keys are configured via `GH_API_KEYS` (comma-separated). If empty, auth is disabled
(dev convenience) and logs a warning in production. Errors are returned as RFC 7807
`application/problem+json`.

## Production deployment

`docker-compose.prod.yaml` brings up the production-shaped topology: ClickHouse Keeper
→ ClickHouse → a one-shot **migrate** job → **syncer** + scalable **api** replicas behind
nginx. Config/secrets come from `deploy/.env.prod` (copy `deploy/.env.prod.example`;
inject from a secrets manager in real deployments).

```bash
cp deploy/.env.prod.example deploy/.env.prod   # then fill in secrets
NPM_TOKEN=... docker compose -f docker-compose.prod.yaml up -d --build
docker compose -f docker-compose.prod.yaml up -d --scale api=3   # scale the read tier
```

Migrations are owned by the one-shot `migrate` job (not run on boot in prod). See
[migrations](packages/shared/src/clickhouse/migrate.ts) — each `schema/*.sql` file is a
tracked migration recorded in a `schema_migrations` table and applied at most once.

## Load & capacity testing

See [load/README.md](load/README.md): a ClickHouse seeder + a k6 API load test (latency/
error thresholds) and a syncer-throughput recipe using the Prometheus gauges.

## Endpoints (v2)

`/v2/payments`, `/v2/transactions`, `/v2/ledgers`, `/v2/exchanges`,
`/v2/exchanges/:base/:counter`, `/v2/exchange_rates/:base/:counter`, `/v2/normalize`,
`/v2/network/{payment_volume,exchange_volume,top_currencies}`, `/v2/stats`,
`/v2/accounts` and `/v2/accounts/:address/*`. Operational: `/liveliness/healthz`, `/metricz`.

> Note on verification: this codebase depends on the private `@gatehub/toolbox` package
> and a private base image, so it was authored but not installed/compiled in the
> environment it was generated in. Run `pnpm install && pnpm build` with registry access
> to compile; see each service's `.env.example` for required configuration.
