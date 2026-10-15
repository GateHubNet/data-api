# Architecture Decision Records

Short, dated records of significant decisions: the context, the choice, and its
consequences. They explain *why* the system is the way it is.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-use-clickhouse.md) | Use ClickHouse as the analytical store (replacing Elasticsearch) | Accepted |
| [0002](0002-ctid-idempotent-ingest.md) | Idempotent ingest via CTID-keyed ReplacingMergeTree + batched writes | Accepted |
| [0003](0003-no-final-on-list-queries.md) | Do not use `FINAL` on list/scan queries | Accepted |
| [0004](0004-keyset-pagination.md) | Keyset (cursor) pagination instead of offset | Accepted |
| [0005](0005-pnpm-monorepo.md) | pnpm workspace monorepo with a shared library | Accepted |
| [0006](0006-reverse-proxy-tls.md) | TLS terminated by the GateHub reverse proxy; app trusts X-Forwarded-For | Accepted |

## Format
Each ADR: **Context** (the forces), **Decision** (what we chose), **Consequences**
(positive and negative, including what we give up). Keep them short. New decisions get a new
file; superseding decisions reference the one they replace rather than editing history.
