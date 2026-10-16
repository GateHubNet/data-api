# ADR-0008: No aggregate materialized views

**Status:** Accepted. Amends [ADR-0001](0001-use-clickhouse.md) (which proposed materialized views for pre-aggregation).

## Context
The first design maintained analytics (candles, daily volumes, stats) with insert-triggered ClickHouse materialized views into
`SummingMergeTree` / `AggregatingMergeTree` targets. An insert-triggered view aggregates **what is inserted, once**:

- Re-ingesting a ledger (recovery, `--reprocess`, overlapping ranges) inserts its rows again, and the view **double-counts** them. The
  `ReplacingMergeTree` of the source table cannot help: the view has already fired.
- A `DELETE` of a source row does not reach the view's target.
- The views only see data inserted after they exist, and a change to an aggregate needs a backfill of the target.
- The required aggregates are not all additive: candle alignment (n-day buckets from 2013-01-01, weeks from Monday), exchange rates (average of a
  daily vwap and the last 50 trades), volumes converted through rates of the day, and active accounts or reports for a window all need the rows
  themselves.

## Decision
- **No aggregate materialized views.** The schema has none.
- **Query-time aggregates** (candles, `reduce`, rates, normalize, active accounts, reports, account stats) are `GROUP BY` queries over a bounded,
  key-ordered range of the already deduplicated rows (`LIMIT 1 BY <key>`), guarded by `max_execution_time` and `max_memory_usage`. Sums are exact decimals (`Decimal256(30)` on the stored text, a float fallback only for amounts outside its range),
  so they are deterministic and independent of merge state.
- **Precomputed aggregates are tables written by the syncer's aggregator** (`stats_hourly`, `volume_daily`, `volume_live`), recomputed idempotently
  from `ledgers` / `exchanges` / `payments`: a `ReplacingMergeTree(version)` where a recompute writes a complete set (an hour, a day's components)
  under a new version and readers keep the highest version. A rewrite of ledgers marks the affected hours in `agg_dirty` and the aggregator
  recomputes them. Week/month volumes are sums of daily rows.

## Consequences
**Positive**
- Aggregates are correct under replay, reprocessing and deletes, because they are recomputed from the source rather than accumulated.
- No hidden write amplification at insert time; the ingest path is only the 14 ledger-derived tables.
- Aggregation logic is ordinary tested TypeScript/SQL (`packages/shared/src/aggregate`, `query`), shared by the API and the aggregator.

**Negative / trade-offs**
- Aggregates are **eventually fresh**: the aggregator runs once a minute with budgets, and after a long outage or on a database with years of history
  the current hour lags until its catch-up is done (`syncer_aggregator_stats_lag_seconds`).
- Query-time aggregates cost what their window costs; very large windows (all pairs, very active accounts) are bounded by guards, not magic.
- The aggregator is one more moving part to operate and monitor ([operations](../operations.md)).
