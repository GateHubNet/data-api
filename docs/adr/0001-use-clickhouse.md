# ADR-0001: Use ClickHouse as the analytical store

**Status:** Accepted. Amended: the materialized views proposed below were replaced by query-time aggregates and aggregator-written tables ([ADR-0008](0008-no-aggregate-materialized-views.md)); one database per network ([ADR-0009](0009-one-deployment-per-network.md)).

## Context
The Data API serves an append-only, time-ordered ledger through two query shapes:
analytics (OHLC/VWAP candles, payment/exchange volume, top currencies, daily histograms) and
selective point lookups (tx by hash, ledger by index, account history). The previous
implementation used Elasticsearch, which:
- ran heavy per-request Painless aggregations (slow, memory-hungry),
- stored data in bulky inverted indexes,
- had no idempotency (auto-generated `_id`s → duplicates on replay),
- and was being used almost entirely without its one real strength — relevance-ranked
  full-text search (queries were exact-match filters + aggregations).

That is a columnar-OLAP workload, which Elasticsearch is weakest at.

## Decision
Use **ClickHouse** as the analytical store. Model the data as `MergeTree`-family tables (originally with
**materialized views** maintaining pre-aggregated analytics; see the amendment above). Express the API's reads as
parameterised SQL.

## Consequences
**Positive**
- Vectorized columnar scans and precomputed rollups replace per-request scripts → far faster,
  cheaper analytics.
- ~5–10× better compression on this numeric/time data.
- SQL is testable and analyst-friendly; integrates with BI tools.
- Idempotent, crash-safe ingest through the commit-marker design (see [ADR-0007](0007-ledger-index-axis-and-secondary-tables.md); the earlier CTID design of [ADR-0002](0002-ctid-idempotent-ingest.md) is superseded).
- Simpler ops than a JVM/shard cluster; mature managed option (ClickHouse Cloud).

**Negative / trade-offs**
- No best-in-class full-text search. If relevance-ranked free-text search over
  memos/domains/token names becomes a product requirement, add a small dedicated search index
  for *that alone* — do not move the analytical core back to ES.
- `FINAL`-based dedup is expensive on scans, which constrains query patterns
  (see [ADR-0003](0003-no-final-on-list-queries.md)).
- HA/replication is a deliberate deployment step (Keeper + `Replicated*MergeTree`), not free.

The Elasticsearch-era design this replaced is obsolete and its migration notes were removed; this ADR keeps the reasoning.
