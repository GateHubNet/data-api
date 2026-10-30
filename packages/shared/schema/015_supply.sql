-- =============================================================================
-- GateHub Data API: the supply (D7, spec 2026-10-24-supply-design.md section 1). Additive to 001_baseline.sql, one
-- database per network. Required before the syncer of this release (on Xahau its writer inserts into the three ledger
-- tables whenever a ledger has mint rows, from a successful GenesisMint or Import or from any ClaimReward, and an insert
-- into a missing table fails the batch) and before the api.
--
-- genesis_mints, imports and reward_claims are ledger-derived, written by ingest with the ledger's other rows from
-- parser version 9 on (MINT_PARSER_VERSION). They record Xahau's sources of new native coins (the reward claims behind
-- reward mints, the genesis mints, the imports), and they stay empty on XRPL. genesis_mints has a row for each entry of
-- GenesisMints with a native Amount in a successful GenesisMint, imports a row for each successful Import and
-- reward_claims a row for each ClaimReward, whatever its result (the parent of a reward mint is a claim whether or not
-- the claim succeeded). Recovery and --reprocess delete the three by ledger_index with the other ledger tables. A ledger
-- written by an older parser has no rows in them. All three are partitioned by a million ledgers and carry the dedup
-- window of every ledger-derived table.
--
-- network_supply is an aggregate, written by the syncer's aggregator only (job supply, ReplacingMergeTree(version), no
-- partition, no TTL, no dedup window, and never deleted by recovery): one row per snapshot, written in one insert. Readers
-- take the newest snapshot without FINAL, in two reads of the end of the key: the newest ledger_index (ORDER BY ledger_index
-- DESC LIMIT 1), then every version of that ledger by its key, of which the highest version is the snapshot.
--
-- Every statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- One row for each entry of GenesisMints with a native Amount. mint_index is the entry's position in GenesisMints, amount
-- is in drops, parent_tx_hash is EmitDetails.EmitParentTxnID and emit_hook_hash is EmitDetails.EmitHookHash, each empty
-- when absent.
CREATE TABLE IF NOT EXISTS genesis_mints
(
  ledger_index   UInt32,
  tx_index       UInt32,
  mint_index     UInt16,
  tx_hash        String,
  close_time     DateTime('UTC'),
  destination    String,
  amount         UInt64,
  parent_tx_hash String,
  emit_hook_hash String
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, mint_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row for each successful Import, the columns the supply needs (a later migration adds the others with ALTER TABLE
-- and a reprocess of its own). minted is in drops: the balance after the Import, less the balance before it, plus its Fee.
-- account_created is 1 when the Import created the account.
CREATE TABLE IF NOT EXISTS imports
(
  ledger_index    UInt32,
  tx_index        UInt32,
  tx_hash         String,
  close_time      DateTime('UTC'),
  account         String,
  minted          UInt64,
  account_created UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row for each ClaimReward, whatever its result. opt_out is 1 when the claim opts the account out of the rewards.
CREATE TABLE IF NOT EXISTS reward_claims
(
  ledger_index UInt32,
  tx_index     UInt32,
  tx_hash      String,
  close_time   DateTime('UTC'),
  account      String,
  issuer       String,
  opt_out      UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per snapshot of the supply at ledger_index (the snapshot ledger). started_at is when the cycle began, which the
-- cadence reads, computed_at when the row was written. All amounts are drops. burned is 10^17 less total_coins on XRPL and
-- the sum of fee_total up to the ledger on Xahau. escrowed and escrow_count are the open native escrows. amm is the drops in
-- the pools, NULL on a network without AMM, and amm_pools the live pools with a native reserve above 0. reserve_base and
-- reserve_inc are NULL when no reserve value is known at the ledger. accounts are the existing accounts, AMM pool accounts
-- left out, and owner_count the sum of their OwnerCount. minted_rewards, minted_import and minted_genesis are every
-- indexed mint up to the ledger, NULL on XRPL. A cycle that is redone at the same ledger writes the same key under a newer
-- version.
CREATE TABLE IF NOT EXISTS network_supply
(
  ledger_index    UInt32,
  close_time      DateTime('UTC'),
  started_at      DateTime('UTC'),
  computed_at     DateTime('UTC'),
  total_coins     UInt64,
  burned          UInt64,
  escrowed        UInt64,
  escrow_count    UInt64,
  amm             Nullable(UInt64),
  amm_pools       UInt32,
  reserve_base    Nullable(UInt64),
  reserve_inc     Nullable(UInt64),
  accounts        UInt64,
  owner_count     UInt64,
  minted_rewards  Nullable(UInt64),
  minted_import   Nullable(UInt64),
  minted_genesis  Nullable(UInt64),
  version         UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY ledger_index;
