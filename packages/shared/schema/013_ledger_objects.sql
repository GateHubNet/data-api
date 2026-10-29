-- =============================================================================
-- GateHub Data API: ledger objects and delegation (D5, spec 2026-10-24-ledger-objects-delegation-design.md section 1).
-- Additive to 001_baseline.sql, one database per network. Required before the syncer of this release (its writer inserts
-- into the two ledger tables on every ledger) and before the api.
--
-- object_changes and account_object_changes are ledger-derived, written by ingest with the ledger's other rows from
-- parser version 7 on (OBJECT_PARSER_VERSION): object_changes has a row for each created, modified or deleted node of a
-- tracked type (Escrow, Check, PayChannel, Delegate) in a transaction's metadata, with the node's fields after the
-- transaction, the PreviousFields it changed and the event it was. The key is unique, because a transaction has one node
-- per object. A row is written whatever the transaction's result, result keeps it. A modified node without
-- PreviousFields was only threaded and has no row. account_object_changes is its narrow index by account: one row for
-- the owner and one for the counterparty of each object_changes row (two rows, one per role, when they are the same
-- account). role is in the key so that the delegations an account gave (owner) and holds (counterparty) are each a
-- prefix. Recovery and --reprocess delete both by ledger_index with the other ledger tables. A ledger written by an
-- older parser has no rows in them. Both carry the dedup window of every ledger-derived table.
--
-- escrows is an aggregate, written by the syncer's aggregator only (ReplacingMergeTree(version), no partition and no
-- dedup window, and never deleted by recovery): the current state of every escrow the index has seen, rebuilt from
-- object_changes, plus one sentinel row (escrow_id = empty) that holds the escrowed total: open_count and amount_drops
-- are the open native escrows and the sum of their drops, through_ledger is the ledger the job has processed up to.
-- Readers keep the newest version of each escrow_id without FINAL.
--
-- Every statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- fields is the JSON of the node's fields after the transaction (NewFields of a created node, else FinalFields), previous
-- the JSON of its PreviousFields (empty object when it has none), event_fields the facts the event takes from the
-- transaction (empty object when none): keys sorted, raw ledger values.
CREATE TABLE IF NOT EXISTS object_changes
(
  object_type   LowCardinality(String),
  object_id     String,
  ledger_index  UInt32,
  tx_index      UInt32,
  tx_hash       String,
  close_time    DateTime('UTC'),
  tx_type       LowCardinality(String),
  result        LowCardinality(String),
  sender        String,
  delegate      String,
  action        Enum8('created' = 1, 'modified' = 2, 'deleted' = 3),
  event         LowCardinality(String),
  owner         String,
  counterparty  String,
  fields        String CODEC(ZSTD(3)),
  previous      String CODEC(ZSTD(3)),
  event_fields  String
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (object_type, object_id, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS account_object_changes
(
  account       String,
  object_type   LowCardinality(String),
  role          Enum8('owner' = 1, 'counterparty' = 2),
  ledger_index  UInt32,
  tx_index      UInt32,
  object_id     String,
  action        Enum8('created' = 1, 'modified' = 2, 'deleted' = 3)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, object_type, role, ledger_index, tx_index, object_id)
SETTINGS non_replicated_deduplication_window = 1000;

-- currency is XRP or XAH with an empty issuer for the native currency, the 3-letter or 40-hex code for an issued token,
-- the 48-hex issuance ID for an MPT. amount is in whole units (an MPT's raw integer units), amount_drops the drops of a
-- native escrow and 0 for a token. last_ledger is the ledger of the escrow's newest object_changes row, deleted is 1
-- once it was finished, cancelled or removed. open_count and through_ledger are 0 in an escrow row. finish_after and
-- cancel_after are DateTime64(0), unix seconds: a ledger time can be as late as 2136 (Ripple seconds up to 2^32 - 1),
-- past the last second a DateTime holds (2106), at which an insert would silently saturate.
CREATE TABLE IF NOT EXISTS escrows
(
  escrow_id       String,
  owner           String,
  destination     String,
  sequence        Nullable(UInt32),
  currency        LowCardinality(String),
  issuer          String,
  amount          String,
  amount_drops    UInt64,
  finish_after    Nullable(DateTime64(0, 'UTC')),
  cancel_after    Nullable(DateTime64(0, 'UTC')),
  has_condition   UInt8,
  created_ledger  Nullable(UInt32),
  last_ledger     UInt32,
  deleted         UInt8,
  open_count      UInt64,
  through_ledger  UInt32,
  version         UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY escrow_id;
