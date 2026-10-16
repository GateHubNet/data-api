# ADR-0003: Do not use `FINAL` on list/scan queries

**Status:** Accepted. Amended (see the end): the rule stands, its mechanics changed with the new schema.

## Context
`ReplacingMergeTree` deduplicates rows only after a background merge. `... FINAL` forces that
merge at query time across all parts. We initially put `FINAL` on every read for correctness.
Under load testing this was catastrophic: 80 concurrent `FROM payments FINAL ORDER BY date
LIMIT 200` queries drove ClickHouse to `Memory limit (total) exceeded`; the API replicas sat
idle (blocked on ClickHouse) with p95 ≈ 30 s and ~30 % errors. The identical query **without
`FINAL`** ran at 127 QPS, p50 0.44 s, zero errors.

## Decision
- **List / range / scan queries: never use `FINAL`.** Accept that a freshly-ingested row may
  momentarily appear twice until background merges run.
- **Selective single-row lookups (`WHERE key = … LIMIT 1`): keep `FINAL`** — bounded cost,
  immediate correctness.
- **Aggregations needing latest-per-key: use `argMax(value, ledger_index)`** in a subquery
  instead of `FINAL` (e.g. top-currencies / trustline balances).
- **Materialized-view reads:** the view engine already aggregates; use `*Merge` / `sum()`.

## Consequences
**Positive**
- ~6× throughput / ~10× latency improvement; eliminates the OOM failure mode.
- Predictable memory under concurrency.

**Negative / trade-offs**
- List endpoints can show a **transient duplicate** on the very newest rows until merges run.
  For list traffic this is the right trade (throughput over instantaneous exactness on the
  newest few rows). Point lookups and rollups remain exact.
- A new list endpoint that naively adds `FINAL` reintroduces the OOM. This is documented in
  [clickhouse.md](../clickhouse.md#the-final-rule), [development.md](../development.md), and
  [data-model.md](../data-model.md#read-side-rule-no-final-on-lists).
- Optional defense-in-depth: per-query `max_memory_usage` / `max_execution_time` guards so any
  future regression is killed rather than taking the node down.

## Amendment: how the rule is applied now
With the ledger-keyed schema ([ADR-0007](0007-ledger-index-axis-and-secondary-tables.md)) and no materialized views
([ADR-0008](0008-no-aggregate-materialized-views.md)) the list of exceptions above shrank:

- **List, range and aggregate queries never use `FINAL`.** Lists read a key-ordered range with a plain `LIMIT` of the page plus room for
  duplicates and dedupe outside that read with `LIMIT 1 BY <key>` (`readDistinctPage`; in the same SELECT the `LIMIT BY` keeps ClickHouse
  from stopping the read after the page, Ruling R106); aggregates read the same deduplicated rows and sum exact decimals.
- **Single-row lookups do not need `FINAL` either**: a lookup table (`tx_by_hash`, `ledger_by_hash`) gives the key, and the `ledgers` row is the commit marker.
- **Versioned rollups** (`stats_hourly`, `volume_*`) are read by their newest `version` (`argMax` / `max(version)`), never with `FINAL`.
- `validations` (AggregatingMergeTree) is read with `GROUP BY (ledger_hash, validation_public_key)`.
- Duplicates are also prevented on write (deduplication tokens, delete-before-rewrite recovery), so `ReplacingMergeTree` is a safety net and not what correctness rests on.
