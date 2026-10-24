# Architecture Decision Records

Short, dated records of significant decisions: the context, the choice, and its
consequences. They explain *why* the system is the way it is.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-use-clickhouse.md) | Use ClickHouse as the analytical store (replacing Elasticsearch) | Accepted (amended: no materialized views, see 0008) |
| [0002](0002-ctid-idempotent-ingest.md) | Idempotent ingest via CTID-keyed ReplacingMergeTree + batched writes | **Superseded** by 0007 |
| [0003](0003-no-final-on-list-queries.md) | Do not use `FINAL` on list/scan queries | Accepted (amended) |
| [0004](0004-keyset-pagination.md) | Keyset (cursor) pagination instead of offset | **Superseded** by 0007 for the marker key |
| [0005](0005-pnpm-monorepo.md) | pnpm workspace monorepo with a shared library | Accepted |
| [0006](0006-reverse-proxy-tls.md) | TLS terminated by the front proxy; trusted-proxy client address | Accepted (amended) |
| [0007](0007-ledger-index-axis-and-secondary-tables.md) | `ledger_index` is the time axis; narrow secondary tables; commit-marker writes | Accepted |
| [0008](0008-no-aggregate-materialized-views.md) | No aggregate materialized views | Accepted |
| [0009](0009-one-deployment-per-network.md) | One deployment per network (XRPL, Xahau) | Accepted |
| [0010](0010-ripple-v2-wire-compatibility.md) | Ripple Data API v2 wire compatibility, and every deliberate deviation | Accepted (amended by 0011: AMM swaps are exchanges; by 0012: the validators routes; by 0013: the account and market routes, `interval` and the AMM data additions of D2b; by spec #4: the account investigation routes, path payments among them) |
| [0011](0011-amm-data-and-swaps-as-exchanges.md) | AMM data, and swaps as exchanges: the user's decisions and the rulings of the build | Accepted |
| [0012](0012-validators-and-amendments-data.md) | Validators and amendments data: a worker of its own, agreement over the indexed chain, the safe fetcher, migration 002 and its deploy order | Accepted |
| [0013](0013-account-and-market-aggregates.md) | Account and market aggregates: precomputed daily rates, heavy-account rollups, markets from hourly pair stats, self-contained runners; D2b: the AMM data additions (source split, filter sets, `fees_est`, computed range) | Accepted |
| [0014](0014-address-names-and-labels-in-a-shared-database.md) | Address names and labels live in a shared database, written by hand; served on `/v2/accounts/{address}` | Accepted |
| [0015](0015-historical-account-state-from-clickhouse.md) | Historical account state (balances, trust lines, flags) comes from ClickHouse state tables, never from a node | Accepted |

## Format
Each ADR: **Context** (the forces), **Decision** (what we chose), **Consequences**
(positive and negative, including what we give up). Keep them short. New decisions get a new
file; superseding decisions reference the one they replace rather than editing history. An
amendment is appended to the ADR it amends and says so in its status line.
