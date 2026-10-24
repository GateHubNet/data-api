-- =============================================================================
-- GateHub Data API: account state history (spec #4, ticket #9; ADR-0015). Additive to 001_baseline.sql, one database
-- per network.
--
-- account_states holds the state of an account root after each transaction that changed it: one row per created,
-- modified or deleted AccountRoot node of the transaction's metadata, with the node's final fields (NewFields for a
-- created node). A modified node that was only threaded (no PreviousFields) changed nothing and has no row. The state of
-- an account at ledger L is its newest row at or before L; deleted = 1 marks an AccountDelete (the account did not
-- exist after it). It is a ledger-derived table, written by the ingest with the ledger's other rows (parser version 3 on).
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- balance is the native balance in whole units (exact decimal text), flags the AccountRoot Flags, fields the JSON of
-- every field of the node as it was after the transaction (Domain, RegularKey, TransferRate, the hook fields of Xahau ...).
CREATE TABLE IF NOT EXISTS account_states
(
  account      String,
  ledger_index UInt32,
  tx_index     UInt32,
  node_index   UInt16,
  tx_hash      String,
  close_time   DateTime('UTC'),
  balance      String,
  flags        UInt32,
  sequence     UInt32,
  owner_count  UInt32,
  fields       String,
  deleted      UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;
