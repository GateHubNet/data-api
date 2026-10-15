# ADR-0003: Do not use `FINAL` on list/scan queries

**Status:** Accepted

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
  [data-model.md](../data-model.md#read-side-implication-the-api-does-not-use-final-on-list-endpoints).
- Optional defense-in-depth: per-query `max_memory_usage` / `max_execution_time` guards so any
  future regression is killed rather than taking the node down.
