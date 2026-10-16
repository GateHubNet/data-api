# ADR-0002: Idempotent ingest via CTID-keyed ReplacingMergeTree + batched writes

**Status:** **Superseded** by [ADR-0007](0007-ledger-index-axis-and-secondary-tables.md).

> Kept for history. The CTID-keyed tables and `ReplacingMergeTree(ledger_index)` dedup described here were replaced by a ledger-keyed schema where the
> `ledgers` row is the commit marker, inserts are synchronous with deduplication tokens, and recovery deletes the uncommitted tail with partition-scoped
> lightweight `DELETE`s. The batched writes (one `INSERT` per table per flush, children first and the marker last) survive.

## Context
Ingestion must survive crashes, restarts, overlapping live+backfill windows, and manual
re-runs **without double-counting** — counts and volumes must be exact. The old pipeline used
random document ids, so any replay produced duplicates (review finding C4). Separately, the
old pipeline did ~11 inserts per ledger; in ClickHouse that creates one storage *part* per
insert and quickly hits "too many parts".

## Decision
1. Key every per-transaction row on its **natural XRPL identity** — the **CTID**
   (`ledger_index, tx_index, network_id`) for one-per-tx tables, or `tx_hash + node_index` for
   multi-row tables — and store rows in `ReplacingMergeTree(ledger_index)`. Re-processing a
   ledger produces identical keys; merges collapse them.
2. **Batch writes**: buffer N ledgers in the syncer and do **one `INSERT` per table per
   flush**, inserting child rows first and the `ledgers` "commit marker" last.

## Consequences
**Positive**
- Replay/restart/overlap are no-ops — exact counts.
- ~100× fewer round-trips and far fewer parts than per-ledger inserts; no "too many parts".
- Crash-safe: a mid-batch crash may write child rows without the ledger marker; the next run
  re-ingests those ledgers and dedup makes it idempotent.
- `CTID` already exists in XRPL (XLS-37d) and is meaningful/decodable.

**Negative / trade-offs**
- Dedup is only *eventual* (after a background merge), which forces the read-side `FINAL`
  policy in [ADR-0003](0003-no-final-on-list-queries.md).
- Batching adds a small latency between fetch and visibility (flush interval) — irrelevant
  for backfill, negligible for live.
- The backfill cursor is derived from the `ledgers` table (a windowed query), not a separate
  durable cursor — simple and correct, but it relies on the ledger marker being written last.

See [syncer.md](../syncer.md) and [data-model.md](../data-model.md#idempotency-and-the-commit-marker) for the current design.
