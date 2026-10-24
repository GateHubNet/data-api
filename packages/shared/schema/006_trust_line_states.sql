-- =============================================================================
-- GateHub Data API: trust line state history (spec #4, ticket #10; ADR-0015). Additive to 001_baseline.sql, one
-- database per network.
--
-- trust_line_states holds the state of a trust line after each transaction that changed it: for every created,
-- modified or deleted RippleState node of the transaction's metadata, one row per side of the line, each from that
-- account's side (the node's final fields; NewFields for a created node). A modified node without PreviousFields changed
-- nothing and has no rows. The state of an account's line with a counterparty in a currency at ledger L is its newest
-- row at or before L; deleted = 1 marks the node's removal (the line did not exist after it). An issuer's holders are
-- its own rows. It is a ledger-derived table, written by the ingest with the ledger's other rows (parser version 3 on,
-- the state gate it shares with account_states).
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- balance is the line's balance from the account's side (positive: the counterparty owes it) and limit the account's
-- own limit, both exact decimal text; the _peer columns are the counterparty's settings, the others the account's own.
-- quality_in and quality_out are 0 when the line has none. flags is the RippleState Flags as stored (both sides).
CREATE TABLE IF NOT EXISTS trust_line_states
(
  account         String,
  counterparty    String,
  currency        LowCardinality(String),
  ledger_index    UInt32,
  tx_index        UInt32,
  node_index      UInt16,
  tx_hash         String,
  close_time      DateTime('UTC'),
  balance         String,
  limit           String,
  limit_peer      String,
  no_ripple       UInt8,
  no_ripple_peer  UInt8,
  authorized      UInt8,
  peer_authorized UInt8,
  freeze          UInt8,
  peer_freeze     UInt8,
  quality_in      UInt32,
  quality_out     UInt32,
  flags           UInt32,
  deleted         UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, counterparty, currency, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;
