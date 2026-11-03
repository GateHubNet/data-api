-- =============================================================================
-- GateHub Data API: the shared database (ADR-0014), migration 002: account labels. Additive to 001.
--
-- account_labels: the labels the operator puts on an address (scam, spam, advisory), each with a description and
-- optionally who says so (source) and a link to where (url). A label belongs to the address, so it holds on every
-- network. The label is an Enum8, so a misspelt label fails the insert instead of creating a label nobody knows; a new
-- label is a new migration (ALTER TABLE ... MODIFY COLUMN label Enum8(...) with the old values kept).
--
-- The operator writes it with plain SQL inserts (the template is in docs/operations.md). The table is append-only and
-- its history is the audit trail: the newest row of an (address, label) (largest added_at) wins, and a row with
-- removed = 1 removes that label from the address. Nothing is ever updated or deleted. A plain MergeTree keeps every
-- row, and readers take the newest row of each key (`LIMIT 1 BY address, label`), never FINAL.
--
-- The statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS account_labels
(
  address     String,
  label       Enum8('scam' = 1, 'spam' = 2, 'advisory' = 3),
  description String,
  source      String DEFAULT '',
  url         String DEFAULT '',
  removed     UInt8 DEFAULT 0,
  added_by    String,
  added_at    DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (address, label, added_at);
