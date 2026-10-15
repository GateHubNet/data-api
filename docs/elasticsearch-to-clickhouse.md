# Elasticsearch → ClickHouse

## Why we moved

The Data API's workload is **append-only, time-ordered ledger data** served through two query
shapes: analytics (OHLC/VWAP candles, payment & exchange volume, top currencies, daily
histograms) and selective point lookups (tx by hash, ledger by index, account history). There
is essentially **no relevance-ranked full-text search** — the old ES queries were exact-match
`term`/`match_phrase` filters plus aggregations. That is columnar-OLAP territory, which is
exactly what ClickHouse is built for and what Elasticsearch is weakest at.

| Dimension | Elasticsearch (old) | ClickHouse (new) |
| --- | --- | --- |
| Aggregations (volume, OHLC, top-N) | per-request Painless scripts, memory-heavy | incremental **materialized views**, read pre-aggregated state |
| Storage footprint | inverted index + `_source`, bulky | columnar + codecs, ~5–10× smaller on this data |
| Idempotency | app-managed `_id` (was missing → duplicates) | `ReplacingMergeTree` on CTID, native |
| Query language | JSON DSL + Painless | SQL (testable, analyst-friendly) |
| Ops | JVM heap, shards | single binary, simpler |
| Full-text search | best-in-class (unused here) | limited (not needed) |

If relevance-ranked free-text search over memos/domains/token names ever becomes a product
requirement, add a small dedicated search index for *that* alone — don't put the analytical
core back on ES.

## Mapping: ES index → ClickHouse object

| Old ES index | New ClickHouse object |
| --- | --- |
| `ledgers` | table `ledgers` |
| `transactions` | table `transactions` (`tx_json`/`meta_json` keep full fidelity) |
| `payments` | table `payments` + view `payment_volume_daily` |
| `exchanges` | table `exchanges` + views `exchange_candles_1m`, `exchange_volume_daily` |
| `balance-changes-YYYY-MM-DD` (daily indices) | one table `balance_changes`, `PARTITION BY toYYYYMM(date)` |
| `affected-accounts` | table `affected_accounts` |
| `accounts-created` | table `accounts_created` |
| `offers` | table `offers` |
| `issuers` | table `issuers` (latest snapshot via ReplacingMergeTree) |
| `escrows` / `paychans` | tables `escrows` / `paychannels` |
| `_index`-based stats aggregation | view `stats_daily` |

## Query translation patterns

- **`search_after` cursor** → keyset pagination on `(date, ledger_index, tx_index)` with an
  opaque base64 marker (`common/pagination.ts`). O(1) deep pagination, no `OFFSET`.
- **`terms` agg with `sum`** → `GROUP BY ... sum(...)` or a `SummingMergeTree` MV.
- **`date_histogram`** → `toStartOfInterval(date, INTERVAL n UNIT)` (see `INTERVAL_TO_CH`).
- **OHLC Painless** → `argMinMerge(open)/argMaxMerge(close)/max(high)/min(low)` over the
  candle MV.
- **`cardinality` (distinct counterparties)** → `uniqExact(counterparty)`.
- **injection safety** → all user input is bound via ClickHouse `query_params`
  (`{name:Type}`), never string-interpolated.

## Migration strategy (if running both during cutover)

The cleanest path keeps risk low and is reversible:

1. **Dual-write**: have the syncer write to both ES and ClickHouse for a window (add a second
   adapter alongside `ClickHouseDataProcessorService`). This repo ships only the ClickHouse
   path; the parser layer is storage-agnostic, so a parallel ES writer is a thin add-on.
2. **Backfill ClickHouse** from the node (see [backfill.md](backfill.md)) or by replaying ES
   `_source` documents through the data processor.
3. **Shadow-read**: point a copy of API traffic at the ClickHouse-backed service and diff
   responses against the ES-backed one until parity is acceptable.
4. **Cut over** reads to ClickHouse, keep ES warm briefly, then decommission ES.

Because the API is a separate service reading only ClickHouse, the cutover is a deploy, not a
rewrite.
