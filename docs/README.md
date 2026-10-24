# GateHub Data API: documentation

Documentation for the GateHub Data API: a **drop-in replacement for the Ripple Data API v2** (`data.ripple.com`) for the **XRP Ledger**
and **Xahau**, backed by ClickHouse. The *syncer* indexes a network's validated ledgers; the *api* serves the Ripple v2 endpoints, one
deployment per network.

## Start here

- **New to the project?** Read [Architecture](architecture.md), then [Development](development.md) to run it locally.
- **Integrating against the API?** Read the [API reference](api-reference.md) (and the live OpenAPI at `/internal/docs`). Coming from
  `data.ripple.com`: the differences are in [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md). The AMM endpoints and why swaps are exchanges:
  [ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md).
- **Deploying / operating it?** Read [Deployment](deployment.md), [Configuration](configuration.md) and [Operations](operations.md).
- **Filling history?** Read [Backfilling](backfill.md).

## Index

| Doc | What it covers |
| --- | --- |
| [Architecture](architecture.md) | Components, data flow, per-network deployments, design decisions |
| [API reference](api-reference.md) | Every endpoint: params with defaults and maximums, response shape, exact errors, CSV, pagination, differences from data.ripple.com |
| [Data model](data-model.md) | The 51 ClickHouse tables per network (23 of the baseline, 7 AMM tables in it, 10 of the validators and amendments migration, 9 of the account and market aggregates migration, 1 of the account network names migration, the account state history of migration 005), the commit-marker model, migrations |
| [Configuration](configuration.md) | Every environment variable of both services, checked against the config classes |
| [Syncer](syncer.md) | The ingest, validations, fee_stats, aggregator (the AMM jobs included) and validators workers; recovery; the range-ingest CLI |
| [ClickHouse](clickhouse.md) | The store: no-`FINAL` rule, inserts and deduplication, memory guards, HA, backups, retention |
| [Backfilling](backfill.md) | Filling history, repairing gaps, reprocessing, the AMM re-ingest; which node to read from |
| [Deployment](deployment.md) | Topology, images and the BuildKit npm secret, CI and releases (GitHub Actions, ghcr.io images, changelog), compose stacks, nginx, cutover from the old stack |
| [Operations / runbook](operations.md) | Routine tasks, what to watch, after an outage, scaling, incident playbooks |
| [Security](security.md) | Auth, rate limiting, client address, injection, secrets, threat model |
| [Observability](observability.md) | Health (`/liveliness/healthz`), metrics (`/metricz`), logs, alerts |
| [Troubleshooting](troubleshooting.md) | Failures we hit and how they were fixed, by error message |
| [ADRs](adr/README.md) | Architecture Decision Records: the *why* behind the big choices ([ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md): AMM data and swaps as exchanges) |
| [OpenAPI spec](openapi.yaml) | Generated from the running app (also served at `/internal/docs-json`) |
| [Design spec](superpowers/specs/2026-10-15-ripple-dropin-design.md), [plan](superpowers/plans/2026-10-15-ripple-dropin.md) | The intent and the implementation plan of the Ripple drop-in work (the spec has an "As built" errata on top) |
| [AMM design spec](superpowers/specs/2026-10-17-amm-data-design.md), [plan](superpowers/plans/2026-10-17-amm-data.md), [rulings](superpowers/plans/2026-10-17-amm-data.rulings.md), [verification](superpowers/plans/2026-10-17-amm-data.verification.md), [roadmap](superpowers/specs/2026-10-17-amendments-roadmap.md) | The intent and the plan of the AMM data work, and the program of the post-2021 amendments it is the first family of |
| [Validators and amendments design](superpowers/specs/2026-10-19-validators-amendments-design.md), [plan](superpowers/plans/2026-10-19-validators-amendments.md) | The intent and the implementation plan of the validators and amendments data (D1), decided in [ADR-0012](adr/0012-validators-and-amendments-data.md) |
| [Account and market aggregates design](superpowers/specs/2026-10-19-account-market-aggregates-design.md), [plan](superpowers/plans/2026-10-19-account-market-aggregates.md) | The intent and the implementation plan of the account and market aggregates (D2), decided in [ADR-0013](adr/0013-account-and-market-aggregates.md); the plan of the AMM data additions (D2b) is [here](superpowers/plans/2026-10-22-amm-aggregates-d2b.md) |

## The system in one paragraph

The **syncer** (`@gatehub/data-syncer`) follows one network's validated ledgers through a resilient node client, parses every ledger into rows of
20 ledger-derived tables (payments, exchanges including swaps against AMM pools, balance changes, per-account indexes, AMM pool states, account states, ...) and writes them to **ClickHouse** atomically: child
tables first, the `ledgers` row last as the commit marker, with deduplication tokens so a crash recovers by deleting the uncommitted tail. Side workers
collect validations and fee snapshots, keep hourly stats, volumes and the AMM pool tables up to date, precompute the account and market aggregates (daily rates, hourly pair stats, the Markets
table, rollups of heavy accounts), and derive the validators and amendments data (validator lists, domain verification, voting rounds, agreement). The **api** (`@gatehub/data-api-service`) is a stateless NestJS
service that reads ClickHouse with parameterised, key-ordered queries and serves the Ripple v2 contract under `/v2` (API key required), behind a front
proxy that terminates TLS and an nginx that routes by host (`xrpl.data.*`, `xahau.data.*`). Both services expose `/liveliness/healthz` and `/metricz`.

## Conventions used in these docs

- File references link to the actual source so the docs stay verifiable; docs describe the code as built (the design spec's errata and the ADRs record where
  the build differs from the plan).
- "Backlog" and "known gaps" callouts are honest about what is **not** implemented.
- Commands assume the repo root. Docker builds need `NPM_TOKEN` in the environment as a BuildKit secret (see [Deployment](deployment.md#build)); installing
  the private `@gatehub/toolbox` needs npm access ([Development](development.md#npm-access)).
