# ADR-0007: `ledger_index` is the time axis; narrow secondary tables written by the syncer

**Status:** Accepted. Supersedes [ADR-0002](0002-ctid-idempotent-ingest.md) and [ADR-0004](0004-keyset-pagination.md).

## Context
The Ripple Data API v2 serves time-windowed lists (`start`/`end`, ascending or descending, paged with a `marker`) of transactions,
payments, exchanges, balance changes and more, plus point lookups (by hash, by account sequence) and per-account histories. The
first ClickHouse design keyed every row on a CTID and ordered lists by a `date` column; that has three problems:

- A DateTime marker is not unique (many transactions per second), so paging needed tie-breakers and was easy to get wrong.
- A list for one account, currency or pair cannot be served in order from a table ordered by time or CTID: it needs a different
  primary key per filter, and ClickHouse has no secondary ordering. Projections would give one, but they conflict with lightweight
  `DELETE`, which the syncer's recovery depends on.
- Insert-triggered materialized views double-count when a ledger is re-ingested ([ADR-0008](0008-no-aggregate-materialized-views.md)).

## Decision
1. **`ledger_index` is the time axis.** Close times grow monotonically with it. A request's `start`/`end` is resolved **once** to a
   `[L1, L2]` ledger range (a `minmax` index on `ledgers.close_time`, with an LRU cache in the API), and every list is a range of a primary
   key. Markers of lists of ledger rows encode `(ledger_index, tx_index[, node_index])`, a unique key, and **never a DateTime** (lists of aggregated buckets are the exception, see the consequences). A marker is the base64url of the
   JSON key of the last row; the next page is a tuple comparison `(cols) > (values)` (or `<` descending); a malformed marker is 400.
2. **Wide base tables are ordered by ledger** (`ledgers`, `transactions`, `payments`, ...). **Narrow secondary tables** the syncer writes
   explicitly serve the other access paths: `tx_by_hash`, `tx_by_type`, `account_transactions`, `account_tx_by_sequence`,
   `payments_by_currency`, `account_payments`, `exchanges` (ordered by the canonical pair), `account_exchanges`, `balance_changes`
   (by account), `ledger_by_hash`. A page is fetched as `WHERE (ledger_index, tx_index) IN (SELECT ... ORDER BY ... LIMIT n+1)`; fetching
   `limit + 1` rows decides whether a `marker` and a `Link` header are emitted.
3. **Engine and partitions.** `ReplacingMergeTree` with the natural unique key as `ORDER BY`, only as a safety net (list queries never use
   `FINAL`, [ADR-0003](0003-no-final-on-list-queries.md)). Ledger-prefixed tables are partitioned by `intDiv(ledger_index, 1000000)`,
   prefix-keyed tables by `intDiv(ledger_index, 10000000)`, so a commit and a recovery delete are partition-scoped. No projections.
4. **Atomic ledger writes.** The `ledgers` row is the **commit marker**, written last. A ledger is committed exactly when its row exists. Child
   tables are inserted first, synchronously, each insert with an `insert_deduplication_token` (`<runId>:<table>:<first>-<last>:<chunk>`) and the
   same `query_id`; `non_replicated_deduplication_window = 1000` on the 14 ledger-derived tables makes a retried insert a no-op. Recovery
   re-reads the checkpoint (`max(ledgers.ledger_index)`), waits for the failed run's queries, deletes everything above it with
   partition-scoped lightweight `DELETE`s and continues under a new `runId`.
5. **Amounts** are exact `String`s with a `Float64` shadow only where the server aggregates or sorts; native amounts are `UInt64` drops.

## Consequences
**Positive**
- Every list is a bounded, key-ordered range read that stops after `limit + 1` rows; deep pages cost the same as the first.
- Markers are stable under concurrent inserts and unique; a page walk concatenated equals the unpaged list.
- Replays, restarts and overlaps are exact without `FINAL` or eventual-consistency tricks; a crash leaves only invisible, deletable rows.

**Negative / trade-offs**
- Writes are amplified: one ledger is written to up to 14 tables, and a new access path means a new table, written by the parsers/`buildLedgerRows`.
- The invariant "a ledger is whole or absent" relies on the write order and on recovery; rows of an uncommitted ledger are visible to a query that
  reads a child table directly until recovery has removed them.
- Markers are not interchangeable with `data.ripple.com`'s HBase row keys, and work only for the endpoint and direction they came from.
- Lists of aggregated buckets use the bucket as their key and so carry a time in the marker: the bucket start (unix seconds) for candles, hourly/daily fees and fee
  samples, stats and historical volumes, the day (`YYYY-MM-DD`) for the account stats, and the snapshot time in milliseconds for raw `fee_stats`. Only lists of ledger rows are
  markered by ledger keys.

See [data-model](../data-model.md) and [syncer](../syncer.md).
