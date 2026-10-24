# ADR-0015: Historical account state comes from ClickHouse state tables, never from a node

**Status:** Accepted. Changes the historical reads of `GET /v2/accounts/{address}/balances`, which went to the node (see the
[API reference](../api-reference.md#get-v2accountsaddressbalances)).

## Context
Readers need an account's native balance, its trust lines with their settings, and its account flags as of a datetime. Today
`/balances?date=` finds the ledger in ClickHouse and then asks the node for the balances at it, which only works on a full-history node.
GateHub will not run one. ClickHouse will hold the full history, from ledger 32570.

## Decision
- **The ingest records the full state of every account root and trust line after each change**, taken from the transaction metadata, in
  new ledger-derived tables. The state at ledger L is the newest row at or before L.
- **Every historical read uses those tables**: `/balances` with `date`, a numeric `ledger_index` or `ledger_hash`;
  `/accounts/{address}?flags=true` with a `date`; the paged `/v2/accounts/{address}/trustlines`. The last always reads ClickHouse, at the
  newest indexed ledger when no ledger is named, so its pages have one kind of marker. The `flags_changed` of the account-transactions
  summary is derived from the same tables.
- **The node is read only for current state**: `/balances` with no ledger named, or with `validated`, `closed` or `current`, and the current
  flags on `/accounts/{address}`.

## Consequences
- Rejected: rebuilding balances from `balance_changes`. That table has no limits or flags, and it misses trust lines that were created and
  never moved. Rejected: a full-history node, which GateHub will not run.
- An answer is only as complete as the indexed history. Until the state tables are filled back to ledger 32570 (with that ledger's state,
  the work of the history spec), a date before their first ledger answers 400 `the date provided is too old`.
- The tables hold a row for every change of every account and trust line, so they are among the largest, and the parser version moves.
