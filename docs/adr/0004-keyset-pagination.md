# ADR-0004: Keyset (cursor) pagination instead of offset

**Status:** **Superseded** by [ADR-0007](0007-ledger-index-axis-and-secondary-tables.md) for the key of the marker; the keyset mechanism itself stands.

> The marker described here encoded a date-led tuple `(date, ledger_index, tx_index)`. Markers now encode the ledger-ordered key of the list
> (`ledger_index, tx_index[, node_index]`, or the key of the secondary table) and **never a DateTime**; `start`/`end` are resolved to a ledger range
> once per request. Everything else below (opaque base64url token, tuple comparison, `limit + 1` to decide whether there is a next page, a `Link` header) holds.

## Context
List endpoints return large, time-ordered result sets that clients page through. The old ES
API used `search_after`. Offset/`LIMIT … OFFSET` pagination degrades linearly with depth
(the engine still scans+skips all preceding rows) and can skip/duplicate rows when new data
arrives mid-pagination.

## Decision
Use **keyset (cursor) pagination**. The cursor (`marker`) is an opaque base64url token
encoding the sort-key tuple of the last row returned (e.g. `(date, ledger_index, tx_index)`).
The next page is everything strictly after that tuple in the requested direction, via a
ClickHouse tuple comparison `(cols) > (values)`. Implemented in
[`apps/api/src/common/pagination.ts`](../../apps/api/src/common/pagination.ts).

## Consequences
**Positive**
- O(1) deep pagination — no growing OFFSET scan.
- Stable under concurrent inserts (no skipped/duplicated rows across pages).
- The marker is opaque, so the internal sort key can evolve without breaking clients.

**Negative / trade-offs**
- No random "jump to page N" — only next-page traversal (acceptable and standard for this
  kind of API; matches the previous `search_after` behavior).
- Requires a stable, total sort key per endpoint (we include tie-breakers like
  `ledger_index, tx_index`).
- "No next marker" signals the end of results — clients must handle the absent-marker case.
