# ADR-0005: pnpm workspace monorepo with a shared library

**Status:** Accepted

## Context
The system is two services (ingest + serve) that share substantial domain logic: the XRPL
transaction parsers, the ClickHouse client + schema, and common types/utilities. The old
project duplicated configuration and logic across two NestJS apps and used Nx. We wanted the
parser/storage logic written once and consumed by both.

## Decision
A **pnpm workspace** monorepo:
- `apps/api` (`@gatehub/data-api-service`) — the REST service,
- `apps/syncer` (`@gatehub/data-syncer`) — the ingestion worker,
- `packages/shared` (`@gatehub/data-api-shared`) — parsers, ClickHouse client/module, schema
  SQL, CTID/time/quality utils, shared types.

The apps depend on the shared package via `workspace:*`. Each service follows the GateHub
`gh-bridge` NestJS template (config, logger, liveliness + prometheus modules, two-stage
Dockerfile).

## Consequences
**Positive**
- Parsers and storage logic exist **once**; both services stay consistent by construction.
- Clear boundaries; the shared lib is independently testable.
- Storage-agnostic parser layer makes a future backend swap or dual-write tractable.

**Negative / trade-offs**
- The shared lib must be built before the apps; root `pnpm build` handles topological order.
- pnpm-in-Docker has sharp edges (symlinks across layers, `deploy --legacy`, `.tsbuildinfo`)
  — documented in [troubleshooting.md](../troubleshooting.md) and handled in the Dockerfiles.
- Adds a small amount of monorepo tooling overhead vs. a single app.
