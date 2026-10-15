# Architecture

The GateHub Data API indexes the XRP Ledger and serves it over REST. It is two services
sharing one library, backed by ClickHouse.

- **syncer** (`@gatehub/data-syncer`) — ingests ledgers from an XRPL node, parses them, and
  writes idempotent batches to ClickHouse.
- **api** (`@gatehub/data-api-service`) — a stateless, horizontally-scalable REST service
  reading ClickHouse, behind the GateHub reverse proxy.
- **shared** (`@gatehub/data-api-shared`) — parsers, ClickHouse client + schema, utilities.

## System diagram

```
                              ┌──────────────────────────────┐
   Internet ──────HTTPS──────▶│   GateHub reverse proxy       │  TLS termination, edge routing
                              └───────────────┬──────────────┘
                                              │ HTTP (+ X-Forwarded-For)
                                ┌─────────────┴─────────────┐
                                ▼                           ▼
                      ┌───────────────────┐      ┌────────────────────┐
                      │  api (N replicas) │─SQL─▶│     ClickHouse     │   tables + materialized views
                      │  stateless        │◀─────│  (+ Keeper for HA) │   (internal only)
                      └─────────┬─────────┘      └─────────▲──────────┘
                                │ live state                │ idempotent batch INSERTs
                                ▼ (balances/orders)         │
                          ┌───────────┐            ┌────────┴────────┐    fetch ledgers (WS)
                          │ XRPL node │◀───────────│  syncer (1..N)  │◀───────────────────────┐
                          └───────────┘            │  internal only  │                        │
                                                   └─────────────────┘                  ┌───────────┐
                                                          fetch → parse → batch ───────▶│ XRPL node │
                                                                                        └───────────┘
```

Both services also expose `GET /liveliness/healthz` (ClickHouse ping) and `GET /metricz`
(Prometheus). The api serves Swagger UI at `/internal/docs`.

## Components

### Shared library — `packages/shared`
The domain core, consumed by both services so logic exists once
([ADR-0005](adr/0005-pnpm-monorepo.md)):
- **Parsers** (`src/parsers/`): pure functions turning an XRPL transaction + metadata into
  domain rows — payments, exchanges (DEX trades), balance changes, offers, issuer trustlines,
  escrows, paychannels, accounts-created, affected-accounts, and the "client" memo. No I/O.
- **ClickHouse layer** (`src/clickhouse/`): a thin typed client (`ClickHouseService`), a Nest
  module, the table/view name enums, and the migration runner. All queries are parameterised.
- **Schema** (`schema/*.sql`): all DDL — 11 tables + 4 analytics views — applied by
  `ch:migrate`.
- **Utils**: CTID (deterministic id), order-book quality decoding, time conversion, retry.

### Syncer — `apps/syncer`
A NestJS worker. On boot it (optionally) runs migrations, probes the node's ledger range, and
starts backfill and/or live subscription. The core loop: **fetch a ledger (expanded) → parse
every transaction → buffer → flush one batched INSERT per table**. It runs an HTTP server only
for health/metrics. Deep dive: [syncer.md](syncer.md).

### API — `apps/api`
A NestJS REST service, one module per domain (payments, transactions, ledgers, exchanges,
network, stats, accounts). Each service builds **parameterised** ClickHouse SQL. Cross-cutting:
API-key auth, RFC-7807 errors, keyset pagination, per-client rate limiting, a short-TTL cache
for live-XRPL endpoints, request metrics, and OpenAPI generation. Reference:
[api-reference.md](api-reference.md).

### ClickHouse
The analytical store ([ADR-0001](adr/0001-use-clickhouse.md)). Append-only ledger data in
`ReplacingMergeTree` tables keyed on the XRPL CTID for idempotency, plus materialized views
that maintain pre-aggregated analytics (candles, daily volumes, network stats). Details:
[data-model.md](data-model.md), [clickhouse.md](clickhouse.md).

## Data flow

### Write path (ingestion)
```
XRPL `ledger` request (expand, transactions)
  → normalize close_time (ripple → unix seconds)
  → parse each tx through the parser suite  → domain rows + CTID
  → buffer rows across N ledgers
  → flush: one INSERT per child table, then the `ledgers` commit-marker row
  → ClickHouse merges collapse any duplicate keys (idempotent)
  → materialized views update incrementally (candles, volumes, stats)
```
Idempotent by construction ([ADR-0002](adr/0002-ctid-idempotent-ingest.md)); batched to keep
ClickHouse part counts sane.

### Read path (serving)
```
HTTPS → GateHub proxy (TLS) → api replica
  → ApiKeyGuard (X-API-Key / Bearer)  → ThrottlerGuard (per real client IP)
  → ValidationPipe (typed DTO, whitelist)
  → service builds parameterised SQL → ClickHouse (no FINAL on scans)
  → map rows → { result, marker, count, items } envelope
  → MetricsInterceptor records count + duration
```
Errors render as `application/problem+json`. Live account state (balances, open orders) is
fetched from the XRPL node and short-TTL cached.

## Key design decisions

| Decision | Why | ADR |
| --- | --- | --- |
| ClickHouse over Elasticsearch | Workload is columnar-OLAP; ES's full-text strength unused | [0001](adr/0001-use-clickhouse.md) |
| CTID-keyed `ReplacingMergeTree` + batched writes | Idempotent, replay-safe ingest; sane part counts | [0002](adr/0002-ctid-idempotent-ingest.md) |
| No `FINAL` on list queries | `FINAL` on scans OOMs ClickHouse under load | [0003](adr/0003-no-final-on-list-queries.md) |
| Keyset (cursor) pagination | O(1) deep pagination, stable under inserts | [0004](adr/0004-keyset-pagination.md) |
| pnpm monorepo + shared lib | Parser/storage logic written once | [0005](adr/0005-pnpm-monorepo.md) |
| TLS at the GateHub proxy + trust X-Forwarded-For | One owner for TLS; correct per-client rate limiting | [0006](adr/0006-reverse-proxy-tls.md) |

## Cross-cutting concerns
- **Security** — API keys, parameterised SQL (no injection), rate limiting, internal-only
  ClickHouse: [security.md](security.md).
- **Observability** — `/metricz`, `/liveliness/healthz`, structured logs:
  [observability.md](observability.md).
- **Configuration** — all via env, validated/fail-fast: [configuration.md](configuration.md).

## Scaling & resilience model
- **api**: stateless → scale horizontally; the proxy/orchestrator load-balances. ClickHouse is
  the shared dependency — scale it first.
- **syncer**: one instance for live; shard across instances+nodes for a fast backfill. Safe to
  restart anytime (re-derives progress, no double counting).
- **ClickHouse**: single-node correct; HA via Keeper + `Replicated*MergeTree` or a managed
  service ([clickhouse.md](clickhouse.md#high-availability--replication)).
- **Failure handling**: bounded retries on XRPL fetch and ClickHouse writes; failed ledgers
  logged and re-runnable; crash-safe idempotent batches. Honest list of what's *not* yet
  handled (reorgs, validated-ledger gating, dead-letter) in [syncer.md](syncer.md).

## Why two services
Ingestion is write-heavy and long-running (a multi-year backfill); serving is read-heavy and
latency-sensitive. Splitting them lets each scale and deploy independently, and a syncer crash
never takes the API down. They share only the ClickHouse database and the shared library.

## Technology summary
NestJS 10 (TypeScript, strict) · ClickHouse · `@clickhouse/client` · `xrpl` · pnpm workspace ·
`@gatehub/toolbox` (config/logger/bootstrap) · Prometheus (`prom-client`) · `@nestjs/terminus`
(health) · `@nestjs/swagger` (OpenAPI) · Docker (public `node:20-bookworm-slim`) · testcontainers
(integration tests) · k6 (load tests).
