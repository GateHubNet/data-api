-- =============================================================================
-- GateHub Data API: account path payments (spec #4, ticket #14). Additive to 001_baseline.sql, one database per network.
--
-- One ledger-derived table, account_path_payments: the index of path_payments (migration 007) by account. A path
-- payment has a row for its source and one for its destination; a payment to oneself has one row. The row is the key
-- of the path payment, whose columns are read from path_payments. Written by ingest from parser version 4 on (with
-- path_payments, PATH_PARSER_VERSION in rows.ts); a ledger written by an older parser has no rows here until it is
-- reprocessed.
--
-- Ordered and partitioned like account_payments (by account, a partition per ten million ledgers), with the dedup
-- window of every ledger-derived table, so a ledger written twice by the same writer run is deduplicated on insert.
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_path_payments
(
  account      String,
  ledger_index UInt32,
  tx_index     UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;
