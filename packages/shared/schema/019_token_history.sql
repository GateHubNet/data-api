-- =============================================================================
-- GateHub Data API: the token history (issuer analytics, spec 2026-11-08-issuer-analytics-design.md section 2, ADR-0021).
-- Additive to 001_baseline.sql, one database per network. Required before the syncer and the api of this release. The file
-- creates seven tables and reads no other.
--
-- None of the seven is a ledger table: ingest never writes them, and recovery, --reprocess and the retention never delete
-- from them. They are derived from trust_line_states and mpt_holder_states, and are written by the syncer's token_history
-- worker (the head, repairs, promotion) and by the operator's token-history-build command (the build of a generation).
--
-- A generation is one build of the token history. token_history_state holds its state, one row for every change of a
-- generation, and the newest version of a generation is its state (as token_generations). Its through_ledger and
-- levels_through are the token history's commit marker: no reader reads past them.
--
-- The four generation tables carry generation first in their partition key, so a retired generation is dropped whole (the
-- syncer runs ALTER TABLE ... DROP PARTITION, and a repair a lightweight DELETE inside one partition, so its ClickHouse user
-- needs those rights on the four):
--
-- token_holder_changes is the change log, ordered by token then ledger: one row per node of a transaction that changed a line
-- or an MPToken for a token, where the line counted before or after. issuer and currency are the token (an MPT: its issuer
-- and its issuance ID as the currency). amount_before and amount_after are the holder's amount as exact decimal text ('0'
-- when the line does not count; an MPT in integer units, escrowed included). before_known is 0 when the line's first state
-- row in the coverage is not its creation. limit, frozen, authorized and escrowed are the state after, from the token's side.
-- order_exp and order_mant are the order key of amount_after. It carries the dedup window of the ledger tables, because its
-- batches are written with dedup tokens and a retried batch must not count twice.
--
-- token_checkpoints holds the full set of a token's counting lines at the end of checkpoint_ledger, and
-- token_checkpoint_heads one row per checkpoint (its totals, the changes since the previous one and the token's first
-- ledger). A head is written after its rows: a reader reaches rows only through a head.
--
-- token_hourly holds one row per token and UTC hour with a change: the levels at the end of the hour and the hour's flows.
-- A row is written whole, under a version that is the writer's clock in milliseconds, above the key's newest.
--
-- token_hourly_dex holds the DEX figures of a token and hour, with no generation, and the hour's sentinel (issuer and
-- currency empty), written after the hour's rows. token_history_dirty holds the ledger ranges a re-ingest rewrote, which the
-- worker repairs, as nft_dirty.
--
-- Readers never use FINAL: they keep the newest row of a key with LIMIT 1 BY.
--
-- Every statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

CREATE TABLE IF NOT EXISTS token_holder_changes
(
  generation     UInt32,
  issuer         String,
  currency       LowCardinality(String),
  ledger_index   UInt32,
  tx_index       UInt32,
  node_index     UInt16,
  holder         String,
  close_time     DateTime('UTC'),
  clawback       UInt8,
  amount_before  String,
  amount_after   String,
  counted_before UInt8,
  counted_after  UInt8,
  before_known   UInt8,
  limit          String,
  frozen         UInt8,
  authorized     UInt8,
  escrowed       String,
  order_exp      Int16,
  order_mant     UInt64
)
ENGINE = ReplacingMergeTree
PARTITION BY (generation, intDiv(ledger_index, 10000000))
ORDER BY (issuer, currency, ledger_index, tx_index, node_index, holder)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per counting line of a token at the end of checkpoint_ledger, with the holder's state and the ledgers of the
-- line's first counting change and its newest change.
CREATE TABLE IF NOT EXISTS token_checkpoints
(
  generation        UInt32,
  issuer            String,
  currency          LowCardinality(String),
  checkpoint_ledger UInt32,
  holder            String,
  amount            String,
  escrowed          String,
  limit             String,
  frozen            UInt8,
  authorized        UInt8,
  order_exp         Int16,
  order_mant        UInt64,
  first_ledger      UInt32,
  last_ledger       UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY (generation, intDiv(checkpoint_ledger, 10000000))
ORDER BY (issuer, currency, checkpoint_ledger, holder);

-- One row per checkpoint, its commit marker: the totals at checkpoint_ledger, the changes since the previous checkpoint
-- and the token's first ledger.
CREATE TABLE IF NOT EXISTS token_checkpoint_heads
(
  generation        UInt32,
  issuer            String,
  currency          LowCardinality(String),
  checkpoint_ledger UInt32,
  supply            String,
  holders           UInt64,
  trust_lines       UInt64,
  changes_since     UInt64,
  first_ledger      UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY generation
ORDER BY (issuer, currency, checkpoint_ledger);

-- One row per token and UTC hour with a change. supply, holders and trust_lines are the levels at the end of the hour (its
-- last ledger once final is 1, else the generation's through_ledger), issued to unknown_before the hour's flows, and
-- first_ledger and last_ledger the hour's ledgers with a change of the token.
CREATE TABLE IF NOT EXISTS token_hourly
(
  generation     UInt32,
  issuer         String,
  currency       LowCardinality(String),
  hour           DateTime('UTC'),
  supply         String,
  holders        UInt64,
  trust_lines    UInt64,
  issued         String,
  redeemed       String,
  clawed_back    String,
  transferred    String,
  transfers      UInt32,
  changes        UInt32,
  unknown_before UInt32,
  first_ledger   UInt32,
  last_ledger    UInt32,
  final          UInt8,
  version        UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY (generation, toYear(hour))
ORDER BY (issuer, currency, hour);

-- One row per token and UTC hour with trades: the token's amounts in the hour's exchanges and their count. The hour's
-- sentinel (issuer and currency empty) is written after its rows and carries config_version.
CREATE TABLE IF NOT EXISTS token_hourly_dex
(
  issuer         String,
  currency       LowCardinality(String),
  hour           DateTime('UTC'),
  exchanged      String,
  trades         UInt32,
  config_version UInt16,
  version        UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYear(hour)
ORDER BY (issuer, currency, hour);

-- One row per change of a generation's state. coverage_from is the first ledger the generation covers, h0 the commit marker
-- when its build started and h1 the ledger its build's levels are made up to. phase is the build's phase, with its cursors
-- (account_cursor for the changes passes, token_cursor_issuer and token_cursor_currency for the levels). Every change up to
-- through_ledger is written, and every level and checkpoint up to levels_through.
CREATE TABLE IF NOT EXISTS token_history_state
(
  generation            UInt32,
  state                 Enum8('building' = 1, 'live' = 2, 'retired' = 3),
  config_version        UInt16,
  coverage_from         UInt32,
  h0                    UInt32,
  h1                    UInt32,
  phase                 Enum8('changes' = 1, 'mpt_changes' = 2, 'levels' = 3, 'dex' = 4, 'done' = 5),
  account_cursor        String,
  token_cursor_issuer   String,
  token_cursor_currency String,
  through_ledger        UInt32,
  levels_through        UInt32,
  started_at            DateTime64(3, 'UTC'),
  changed_at            DateTime64(3, 'UTC'),
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY generation;

-- The ledger ranges whose token history must be repaired after a re-ingest, as nft_dirty is for NFTs.
CREATE TABLE IF NOT EXISTS token_history_dirty
(
  from_ledger UInt32,
  to_ledger   UInt32,
  created_at  DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (from_ledger, to_ledger);
