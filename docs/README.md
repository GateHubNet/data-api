# GateHub Data API — Documentation

Comprehensive documentation for the GateHub XRPL Data API: a ClickHouse-backed system
that **indexes** the XRP Ledger (the *syncer*) and **serves** it over REST (the *api*).

## Start here

- **New to the project?** Read [Architecture](architecture.md), then
  [Development](development.md) to run it locally.
- **Integrating against the API?** Read the [API Reference](api-reference.md) (and the
  live OpenAPI at `/internal/docs`).
- **Deploying / operating it?** Read [Deployment](deployment.md) and
  [Operations](operations.md).

## Index

| Doc | What it covers |
| --- | --- |
| [Architecture](architecture.md) | System overview, components, data flow, design decisions |
| [Data model](data-model.md) | Every ClickHouse table & materialized view, column by column; CTID idempotency model |
| [API reference](api-reference.md) | Every endpoint: params, responses, auth, pagination, errors, curl examples |
| [Configuration](configuration.md) | Every environment variable for both services |
| [Syncer](syncer.md) | Ingestion pipeline deep-dive: fetch → parse → batch-insert; backfill; sharding; resilience |
| [ClickHouse](clickhouse.md) | The store: `FINAL` tradeoff, memory, replication/HA, backups, TTL, tuning |
| [Backfilling](backfill.md) | How to backfill ~2 years; whether to run your own rippled |
| [Deployment](deployment.md) | Production topology behind the GateHub reverse proxy; compose; scaling; secrets; k8s notes |
| [Operations / runbook](operations.md) | Health, metrics, scaling, migrations, backfill ops, incident playbooks |
| [Security](security.md) | Auth, rate limiting, TLS/proxy, injection, secrets, threat model |
| [Observability](observability.md) | Metrics (`/metricz`), health (`/liveliness/healthz`), logs, dashboards, alerts |
| [Troubleshooting](troubleshooting.md) | Concrete failures we hit and how they were fixed |
| [Elasticsearch → ClickHouse](elasticsearch-to-clickhouse.md) | Why we moved off ES; query translation; migration strategy |
| [ADRs](adr/) | Architecture Decision Records — the *why* behind the big choices |
| [OpenAPI spec](openapi.yaml) | Hand-maintained spec (the service also generates one at build time) |

## The system in one paragraph

The **syncer** (`@gatehub/data-syncer`) connects to an XRPL node, fetches ledgers,
parses every transaction into domain rows (payments, exchanges, balance changes, offers,
issuer trustlines, …), and bulk-inserts them into **ClickHouse** in idempotent batches
(keyed on the XRPL CTID via `ReplacingMergeTree`). Materialized views maintain
pre-aggregated analytics (OHLC candles, daily volumes, network stats). The **api**
(`@gatehub/data-api-service`) is a horizontally-scalable NestJS REST service that reads
ClickHouse with parameterised SQL and serves it under `/v2`, behind the GateHub reverse
proxy (which terminates TLS). Both services expose `/liveliness/healthz` and `/metricz`.

## Conventions used in these docs

- File references link to the actual source so docs stay verifiable.
- "Future work" / "backlog" callouts are honest about what is **not** yet implemented.
- Commands assume the repo root unless stated; `$NPM_TOKEN` is required for any build that
  installs the private `@gatehub/toolbox` (see [Development](development.md)).
