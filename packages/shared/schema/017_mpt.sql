-- =============================================================================
-- GateHub Data API: MPTokens (D9, spec 2026-10-17-mpt-data-design.md section 3). Additive to 001_baseline.sql, one database
-- per network. Required before the syncer of this release (on XRPL and XRPL Testnet its writer inserts into each of the five
-- ledger tables whenever a ledger has rows for it, and an insert into a missing table fails the batch; Xahau and Xahau Testnet
-- have no MPT, so a ledger of theirs never has such a row) and before the api.
--
-- mpt_issuance_states, mpt_holder_states, mpt_touches, mpt_transfers and mpt_issuance_transfers are ledger-derived, written
-- by ingest with the ledger's other rows from parser version 10 on (MPT_PARSER_VERSION). A ledger without MPT rows inserts
-- nothing into them. The states and the touches are written whatever the transaction's result, the transfers only for a
-- tesSUCCESS. Recovery and --reprocess delete the five by ledger_index with the other ledger tables, in the partitions that
-- hold rows. A ledger written by an older parser has no rows in them. All five carry the dedup window of every
-- ledger-derived table.
--
-- mpt_issuances and mpt_holders are aggregates, written by the syncer's aggregator only (job mpt_state,
-- ReplacingMergeTree(version), no partition, no dedup window, and never deleted by recovery). A recompute writes a whole new
-- row under a newer version, and readers keep the newest version of each key without FINAL.
--
-- Amounts are the ledger's integer units, never scaled. An MPT's amounts can reach 2^63-1, so a reader selects every UInt64
-- column as text.
--
-- Every statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- The state of an issuance after each transaction that changed its MPTokenIssuance node (created, modified with
-- PreviousFields, deleted), whatever the result: the node's final fields (NewFields for a created node).
CREATE TABLE IF NOT EXISTS mpt_issuance_states
(
  mpt_issuance_id    String,                  -- 48 upper-case hex
  ledger_index       UInt32,
  tx_index           UInt32,
  node_index         UInt16,                  -- the node's position in AffectedNodes
  tx_hash            String,
  tx_type            LowCardinality(String),
  close_time         DateTime('UTC'),
  issuer             String,
  sequence           UInt32,
  flags              UInt32,
  asset_scale        UInt8,
  maximum_amount     Nullable(UInt64),        -- NULL: not set (2^63-1)
  outstanding_amount UInt64,
  escrowed_amount    UInt64,                  -- the node's LockedAmount
  transfer_fee       UInt16,
  metadata_hex       String,                  -- '' when none
  deleted            UInt8                    -- 1: MPTokenIssuanceDestroy removed it
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (mpt_issuance_id, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- The state of a holder's balance after each transaction that changed its MPToken node, by the same rules. Ordered by
-- holder: an account's holdings and the aggregator's per-pair rebuild are prefixes.
CREATE TABLE IF NOT EXISTS mpt_holder_states
(
  holder           String,
  mpt_issuance_id  String,
  ledger_index     UInt32,
  tx_index         UInt32,
  node_index       UInt16,
  tx_hash          String,
  tx_type          LowCardinality(String),
  close_time       DateTime('UTC'),
  amount           UInt64,                    -- MPTAmount
  escrowed_amount  UInt64,                    -- the MPToken's LockedAmount
  flags            UInt32,
  deleted          UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (holder, mpt_issuance_id, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- Which issuances and holders a transaction touched, in ledger order (holder '' for the issuance's own node): the
-- aggregator's watermark scan and the agg_dirty slices, as amm_pool_touches.
CREATE TABLE IF NOT EXISTS mpt_touches
(
  ledger_index    UInt32,
  tx_index        UInt32,
  mpt_issuance_id String,
  holder          String
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, mpt_issuance_id, holder)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per MPT a successful transaction moved, clawed back, locked or unlocked, in ledger order: what the 24 h counts of
-- the token list read.
CREATE TABLE IF NOT EXISTS mpt_transfers
(
  ledger_index    UInt32,
  tx_index        UInt32,
  mpt_issuance_id String,
  tx_hash         String,
  tx_type         LowCardinality(String),
  close_time      DateTime('UTC'),
  kind            Enum8('payment' = 1, 'clawback' = 2, 'lock' = 3, 'unlock' = 4, 'escrow_create' = 5, 'escrow_finish' = 6, 'escrow_cancel' = 7),
  source          String,                     -- '' when none (a lock of every balance)
  destination     String,                     -- '' likewise
  amount          UInt64,
  fee             UInt64                      -- the transfer fee burned; 0 when none
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, mpt_issuance_id)
SETTINGS non_replicated_deduplication_window = 1000;

-- The same rows ordered by issuance: what /v2/mpt/{issuanceId}/transfers reads.
CREATE TABLE IF NOT EXISTS mpt_issuance_transfers
(
  mpt_issuance_id String,
  ledger_index    UInt32,
  tx_index        UInt32,
  tx_hash         String,
  tx_type         LowCardinality(String),
  close_time      DateTime('UTC'),
  kind            Enum8('payment' = 1, 'clawback' = 2, 'lock' = 3, 'unlock' = 4, 'escrow_create' = 5, 'escrow_finish' = 6, 'escrow_cancel' = 7),
  source          String,
  destination     String,
  amount          UInt64,
  fee             UInt64
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (mpt_issuance_id, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- The current state of each issuance, rebuilt by the mpt_state job. A recompute writes a whole new row under a newer
-- version; readers keep the newest version of each issuance without FINAL.
CREATE TABLE IF NOT EXISTS mpt_issuances
(
  mpt_issuance_id    String,
  issuer             String,                  -- from the ID
  sequence           UInt32,                  -- from the ID
  state_known        UInt8,                   -- 0: no mpt_issuance_states row in the coverage
  flags              UInt32,
  asset_scale        UInt8,
  maximum_amount     Nullable(UInt64),
  outstanding_amount UInt64,
  escrowed_amount    UInt64,
  locked_amount      UInt64,                  -- outstanding_amount when lsfMPTLocked, else the sum of locked holders' amount
  locked_holders     UInt32,                  -- holders when lsfMPTLocked, else the holders with lsfMPTLocked
  holders            UInt32,                  -- holders with amount + escrowed_amount > 0
  transfer_fee       UInt16,
  metadata_hex       String,
  metadata           String,                  -- the decoded object as JSON; '' when the hex is not a JSON object
  metadata_conforms  UInt8,
  ticker             String,                  -- from the metadata, cut to 16 characters; '' when none
  name               String,                  -- likewise, cut to 128
  created_ledger     Nullable(UInt32),        -- the MPTokenIssuanceCreate row; NULL when it is outside the coverage
  created_time       Nullable(DateTime('UTC')),
  created_tx_hash    Nullable(String),
  last_ledger        UInt32,                  -- the newest touch (mpt_touches) this row has seen
  destroyed          UInt8,
  version            UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY mpt_issuance_id;

-- The current balance of each holder of each issuance, recomputed per touched (issuance, holder) pair.
CREATE TABLE IF NOT EXISTS mpt_holders
(
  mpt_issuance_id String,
  holder          String,
  amount          UInt64,
  escrowed_amount UInt64,
  flags           UInt32,
  last_ledger     UInt32,
  deleted         UInt8,                      -- the MPToken was deleted (the holder opted out)
  version         UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (mpt_issuance_id, holder);
