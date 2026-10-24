-- =============================================================================
-- GateHub Data API: account network names (ADR-0014, spec #4). Additive to 001_baseline.sql, one database per network.
--
-- account_network_names: the name the operator gives an account on this network ("USD Issuer" for GateHub's issuing
-- address on the XRP Ledger), served by this network's api only, beside the account name of the shared database. It
-- has the columns of shared.account_names and the same rules: the operator writes it with plain SQL inserts (the
-- template is in docs/operations.md), the table is append-only and its history is the audit trail, the newest row of
-- an address (largest added_at) wins, and a row with removed = 1 removes the name. Nothing is ever updated or deleted.
-- A plain MergeTree keeps every row, and readers take the newest row of each address (`LIMIT 1 BY address`), never
-- FINAL. It is not ledger-derived: no partitions and no insert dedup window.
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_network_names
(
  address  String,
  name     String,
  removed  UInt8 DEFAULT 0,
  added_by String,
  added_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (address, added_at);
