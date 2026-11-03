-- =============================================================================
-- GateHub Data API: the shared database (ADR-0014), migration 001: account names. The shared database (`shared`, or
-- GH_CLICKHOUSE_SHARED_DATABASE) sits on the ClickHouse server that holds the network databases and is read by the apis
-- of every network. It has its own migration set (this directory) and its own schema_migrations, so its numbering starts
-- at 001. It is migrated before an api that reads it (`migrate.js shared`).
--
-- account_names: the account name the operator gives an address ("GateHub"), the same on every network. The operator
-- writes it with plain SQL inserts (the template is in docs/operations.md). The table is append-only and its history is
-- the audit trail: the newest row of an address (largest added_at) wins, and a row with removed = 1 removes the name.
-- Nothing is ever updated or deleted. A plain MergeTree keeps every row, and readers take the newest row of each address
-- (`LIMIT 1 BY address`), never FINAL.
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_names
(
  address  String,
  name     String,
  removed  UInt8 DEFAULT 0,
  added_by String,
  added_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (address, added_at);
