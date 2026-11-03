-- =============================================================================
-- GateHub Data API: path payments (spec #4, ticket #13). Additive to 001_baseline.sql, one database per network.
--
-- One ledger-derived table, path_payments: one row per path payment (GLOSSARY.md), a successful Payment whose delivery
-- crossed an order-book offer, changed an AMM pool or rippled through an account other than the source, the destination
-- and the delivered currency's issuer. A payment to oneself (an arbitrage loop) is a row too, although the payments
-- tables leave such payments out. Written by ingest from parser version 4 on (PATH_PARSER_VERSION in rows.ts); a ledger
-- written by an older parser has no rows here until it is reprocessed.
--
-- Amounts are exact decimal Strings in whole units; issuer and source_issuer are '' for the native currency.
-- Ordered and partitioned like payments (by ledger, a partition per million ledgers), with the dedup window of every
-- ledger-derived table, so a ledger written twice by the same writer run is deduplicated on insert.
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS path_payments
(
  ledger_index     UInt32,
  tx_index         UInt32,
  tx_hash          String,
  close_time       DateTime('UTC'),
  source           String,
  destination      String,
  delivered_amount String,
  currency         LowCardinality(String),
  issuer           String,
  source_amount    String,
  source_currency  LowCardinality(String),
  source_issuer    String,
  offers_crossed   UInt32,
  amm_pools        Array(String),
  rippled_through  Array(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;
