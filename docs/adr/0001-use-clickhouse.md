# ADR-0001: Use ClickHouse as the analytical store

**Status:** Accepted

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
Use **ClickHouse** as the analytical store. Model the data as `MergeTree`-family tables with
**materialized views** maintaining pre-aggregated analytics. Express the API's reads as
parameterised SQL.

## Consequences
**Positive**
- Vectorized columnar scans + materialized views replace per-request scripts → far faster,
  cheaper analytics.
- ~5–10× better compression on this numeric/time data.
- SQL is testable and analyst-friendly; integrates with BI tools.
- Native idempotency via `ReplacingMergeTree` (see [ADR-0002](0002-ctid-idempotent-ingest.md)).
- Simpler ops than a JVM/shard cluster; mature managed option (ClickHouse Cloud).

**Negative / trade-offs**
- No best-in-class full-text search. If relevance-ranked free-text search over
  memos/domains/token names becomes a product requirement, add a small dedicated search index
  for *that alone* — do not move the analytical core back to ES.
- `FINAL`-based dedup is expensive on scans, which constrains query patterns
  (see [ADR-0003](0003-no-final-on-list-queries.md)).
- HA/replication is a deliberate deployment step (Keeper + `Replicated*MergeTree`), not free.

See [elasticsearch-to-clickhouse.md](../elasticsearch-to-clickhouse.md) for the full
rationale and query-translation mapping.
