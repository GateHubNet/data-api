# GateHub Data API: documentation

Documentation for the GateHub Data API: a **drop-in replacement for the Ripple Data API v2** (`data.ripple.com`) for the **XRP Ledger**
and **Xahau** (and the testnet of each), backed by ClickHouse. The *syncer* indexes a network's validated ledgers; the *api* serves the Ripple v2 endpoints, one
deployment per network.

## Start here

- **New to the project?** Read [Architecture](architecture.md), then [Development](development.md) to run it locally.
- **Integrating against the API?** Read the [API reference](api-reference.md) (and the live OpenAPI at `/internal/docs`). Coming from
  `data.ripple.com`: the differences are in [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md). The AMM endpoints and why swaps are exchanges:
  [ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md). The NFT endpoints and the `coverage` field: [ADR-0016](adr/0016-nft-and-uritoken-data.md). The display names and tomls endpoints: [ADR-0017](adr/0017-display-names.md). The escrow, check, payment channel and delegation endpoints: [ADR-0018](adr/0018-ledger-object-history.md). The issued token endpoints: [ADR-0019](adr/0019-issued-tokens-from-state-history.md). The supply endpoints: [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md), Amendment 9. The MPT endpoints: [ADR-0020](adr/0020-mpt-data.md).
- **Deploying / operating it?** Read [Deployment](deployment.md), [Configuration](configuration.md) and [Operations](operations.md).
- **Filling history?** Read [Backfilling](backfill.md).

## Index

| Doc | What it covers |
| --- | --- |
| [Architecture](architecture.md) | Components, data flow, per-network deployments, design decisions |
| [API reference](api-reference.md) | Every endpoint: params with defaults and maximums, response shape, exact errors, CSV, pagination, differences from data.ripple.com |
| [Data model](data-model.md) | The 85 ClickHouse tables per network (30 of the baseline, 7 AMM tables in it, 10 of the validators and amendments migration, 9 of the account and market aggregates migration, 1 of the account network names migration, the account and trust line state history of migrations 005 and 006, the path payments of migration 007 and their index by account of migration 008, 1 of the export jobs, the 10 NFT and URIToken tables of migration 011: 5 ledger tables, 4 aggregates and `nft_dirty`, the 2 display-name tables of migration 012: `account_domains` and `domain_tomls`, the 3 ledger-object tables of migration 013: `object_changes`, `account_object_changes` and the `escrows` aggregate, the 4 issued-token tables of migration 014: `state_touches` and the `token_generations`, `token_lines` and `tokens` aggregates, the 4 supply tables of migration 015: the Xahau mint ledger tables `genesis_mints`, `imports` and `reward_claims` and the `network_supply` aggregate, and the 7 MPT tables of migration 017: the ledger tables `mpt_issuance_states`, `mpt_holder_states`, `mpt_touches`, `mpt_transfers` and `mpt_issuance_transfers` and the `mpt_issuances` and `mpt_holders` aggregates), the commit-marker model, migrations |
| [Configuration](configuration.md) | Every environment variable of both services, checked against the config classes |
| [Syncer](syncer.md) | The ingest, validations, fee_stats, aggregator (the AMM, NFT, escrows, tokens, MPT and supply jobs included), validators and tomls workers; recovery; the range-ingest CLI |
| [ClickHouse](clickhouse.md) | The store: no-`FINAL` rule, inserts and deduplication, memory guards, HA, backups, retention |
| [Backfilling](backfill.md) | Filling history, repairing gaps, reprocessing, the AMM, NFT, ledger object and issued token re-ingests, the supply's Xahau re-ingest, the MPT data re-ingest and the account domains seed; which node to read from |
| [Deployment](deployment.md) | Topology, images and the BuildKit npm secret, CI and releases (GitHub Actions, ghcr.io images, changelog), compose stacks, nginx, cutover from the old stack |
| [Operations / runbook](operations.md) | Routine tasks, what to watch, after an outage, scaling, incident playbooks |
| [Security](security.md) | Auth, rate limiting, client address, injection, secrets, threat model |
| [Observability](observability.md) | Health (`/liveliness/healthz`), metrics (`/metricz`), logs, alerts |
| [Troubleshooting](troubleshooting.md) | Failures we hit and how they were fixed, by error message |
| [ADRs](adr/README.md) | Architecture Decision Records: the *why* behind the big choices ([ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md): AMM data and swaps as exchanges; [ADR-0016](adr/0016-nft-and-uritoken-data.md): NFT and URIToken data and the coverage rule; [ADR-0017](adr/0017-display-names.md): display names and tomls; [ADR-0018](adr/0018-ledger-object-history.md): ledger object history and delegation; [ADR-0019](adr/0019-issued-tokens-from-state-history.md): issued tokens from the state history; [ADR-0020](adr/0020-mpt-data.md): MPT data) |
| [OpenAPI spec](openapi.yaml) | Generated from the running app (also served at `/internal/docs-json`) |
| [Design spec](superpowers/specs/2026-10-15-ripple-dropin-design.md), [plan](superpowers/plans/2026-10-15-ripple-dropin.md) | The intent and the implementation plan of the Ripple drop-in work (the spec has an "As built" errata on top) |
| [AMM design spec](superpowers/specs/2026-10-17-amm-data-design.md), [plan](superpowers/plans/2026-10-17-amm-data.md), [rulings](superpowers/plans/2026-10-17-amm-data.rulings.md), [verification](superpowers/plans/2026-10-17-amm-data.verification.md), [roadmap](superpowers/specs/2026-10-17-amendments-roadmap.md) | The intent and the plan of the AMM data work, and the program of the post-2021 amendments it is the first family of |
| [Validators and amendments design](superpowers/specs/2026-10-19-validators-amendments-design.md), [plan](superpowers/plans/2026-10-19-validators-amendments.md) | The intent and the implementation plan of the validators and amendments data (D1), decided in [ADR-0012](adr/0012-validators-and-amendments-data.md) |
| [Account and market aggregates design](superpowers/specs/2026-10-19-account-market-aggregates-design.md), [plan](superpowers/plans/2026-10-19-account-market-aggregates.md) | The intent and the implementation plan of the account and market aggregates (D2), decided in [ADR-0013](adr/0013-account-and-market-aggregates.md); the plan of the AMM data additions (D2b) is [here](superpowers/plans/2026-10-22-amm-aggregates-d2b.md) |
| [NFT data design](superpowers/specs/2026-10-17-nft-data-design.md), [plan](superpowers/plans/2026-10-17-nft-data.md) | The intent and the implementation plan of the NFT and URIToken data (D3), decided in [ADR-0016](adr/0016-nft-and-uritoken-data.md); the program's coverage rule is [here](api-reference.md#coverage) |
| [Display names design](superpowers/specs/2026-10-24-display-names-design.md), [plan](superpowers/plans/2026-10-24-display-names.md) | The intent and the implementation plan of the display names (D4): the account domains, the `tomls` worker and the toml store, `GET /v2/account_names` and `GET /v2/toml/{domain}`, decided in [ADR-0017](adr/0017-display-names.md) |
| [Ledger objects and delegation design](superpowers/specs/2026-10-24-ledger-objects-delegation-design.md), [plan](superpowers/plans/2026-10-24-ledger-objects-delegation.md) | The intent and the implementation plan of the escrows, checks, payment channels and delegations (D5): the object history, the `escrows` job, the fee of a delegated transaction and the nine routes, decided in [ADR-0018](adr/0018-ledger-object-history.md) |
| [Issued tokens design](superpowers/specs/2026-10-24-issued-tokens-design.md), [plan](superpowers/plans/2026-10-24-issued-tokens.md) | The intent and the implementation plan of the issued tokens (D6): the touch index, the `tokens` job and its generations, and the four `/v2/tokens` routes, decided in [ADR-0019](adr/0019-issued-tokens-from-state-history.md) |
| [Supply design](superpowers/specs/2026-10-24-supply-design.md), [plan](superpowers/plans/2026-10-24-supply.md) | The intent and the implementation plan of the native supply (D7): the mint tables, the `supply` job and its hourly snapshot, and the two `/v2/network/supply` routes (no ADR; the wire in [ADR-0010](adr/0010-ripple-v2-wire-compatibility.md), Amendment 9) |
| [Validator toml details design](superpowers/specs/2026-10-24-validator-toml-details-design.md), [plan](superpowers/plans/2026-10-24-validator-toml-details.md) | The intent and the implementation plan of the validator toml details (D8): `toml` on the validator routes, the `country` filter and the countries route. |
| [MPT data design](superpowers/specs/2026-10-17-mpt-data-design.md), [plan](superpowers/plans/2026-10-17-mpt-data.md), [verification](superpowers/plans/2026-10-17-mpt-data.verification.md) | The intent and the implementation plan of the MPT data (D9): the five ledger tables, the `mpt_state` job and its two aggregates, MPT payments and balance changes, and the MPT routes, decided in [ADR-0020](adr/0020-mpt-data.md) |
| [Testnet profiles design](superpowers/specs/2026-10-24-testnet-profiles-design.md), [plan](superpowers/plans/2026-10-24-testnet-profiles.md) | The intent and the implementation plan of XRPL Testnet and Xahau Testnet as networks of their own (D-env), decided in the amendments of [ADR-0009](adr/0009-one-deployment-per-network.md#amendment-2026-10-24-testnets) and [ADR-0012](adr/0012-validators-and-amendments-data.md#amendment-2026-10-24-the-testnets) |

## The system in one paragraph

The **syncer** (`@gatehub/data-syncer`) follows one network's validated ledgers through a resilient node client, parses every ledger into rows of
40 ledger-derived tables (payments, exchanges including swaps against AMM pools, balance changes, per-account indexes, AMM pool states, account and trust line states, path payments and their index by account, ...) and writes them to **ClickHouse** atomically: child
tables first, the `ledgers` row last as the commit marker, with deduplication tokens so a crash recovers by deleting the uncommitted tail. Side workers
collect validations and fee snapshots, keep hourly stats, volumes, the AMM pool tables, the NFT state and collections, the escrowed total, the issued tokens and the MPT issuances and holders up to date, write the hourly supply snapshot, precompute the account and market aggregates (daily rates, hourly pair stats, the Markets
table, rollups of heavy accounts), derive the validators and amendments data (validator lists, domain verification, voting rounds, agreement) and read the toml of every domain an account names (for display names). The **api** (`@gatehub/data-api-service`) is a stateless NestJS
service that reads ClickHouse with parameterised, key-ordered queries and serves the Ripple v2 contract under `/v2` (API key required), behind a front
proxy that terminates TLS and an nginx that routes by host (`xrpl.data.*`, `xahau.data.*`). Both services expose `/liveliness/healthz` and `/metricz`.

## Conventions used in these docs

- File references link to the actual source so the docs stay verifiable; docs describe the code as built (the design spec's errata and the ADRs record where
  the build differs from the plan).
- "Backlog" and "known gaps" callouts are honest about what is **not** implemented.
- Commands assume the repo root. Docker builds need `NPM_TOKEN` in the environment as a BuildKit secret (see [Deployment](deployment.md#build)); installing
  the private `@gatehub/toolbox` needs npm access ([Development](development.md#npm-access)).
