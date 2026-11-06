-- =============================================================================
-- GateHub Data API: transactions by destination tag (spec 2026-11-06-destination-tag-transactions-design.md section 4).
-- Additive to 001_baseline.sql, one database per network. Required before the syncer of this release (its writer inserts
-- into the table whenever a ledger has a tagged transaction, and an insert into a missing table fails the batch) and
-- before the api, whose list by destination tag reads it.
--
-- account_tx_by_destination_tag is ledger-derived, written by ingest with the ledger's other rows from parser version 11
-- on (DESTINATION_TAG_PARSER_VERSION): one row per transaction whose own Destination is a string and whose own
-- DestinationTag an integer from 0 to 4294967295, of any type and whatever its result, under its destination. Recovery
-- and --reprocess delete its rows by ledger_index with the other ledger tables, in the partitions that hold rows. A
-- ledger written by an older parser has no rows in it. It carries the dedup window of every ledger-derived table.
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- The transactions sent to an account under one destination tag, in ledger order: the sort key starts with the
-- destination and the tag, so a lookup reads only that tag's rows. Partitioned as account_tx_by_sequence.
CREATE TABLE IF NOT EXISTS account_tx_by_destination_tag
(
  account         String,
  destination_tag UInt32,
  ledger_index    UInt32,
  tx_index        UInt32,
  tx_type         LowCardinality(String),
  result          LowCardinality(String),
  close_time      DateTime('UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, destination_tag, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;
