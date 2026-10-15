-- =============================================================================
-- GateHub Data API — ClickHouse base tables
--
-- Design notes:
--  * Every per-transaction table is a ReplacingMergeTree keyed on its natural
--    XRPL identity (CTID / tx_hash + node_index). Re-processing a ledger therefore
--    collapses to the same rows — ingestion is idempotent (fixes review finding C4,
--    which Elasticsearch's auto-generated _id could not provide).
--  * `version` columns drive ReplacingMergeTree so the newest write always wins.
--  * Time columns are DateTime (UTC, unix seconds). Tables are partitioned by month
--    for cheap retention and pruning.
--  * Amount columns are Float64 for fast aggregation (volume / OHLC). The exact
--    string form is preserved in the raw transaction JSON when full fidelity is needed.
-- =============================================================================

-- Ledgers ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledgers
(
  ledger_index          UInt32,
  ledger_hash           String,
  parent_hash           String,
  account_hash          String,
  transaction_hash      String,
  total_coins           String,
  close_time            DateTime,
  close_time_human      String,
  close_time_resolution UInt16,
  close_flags           UInt32,
  closed                UInt8 DEFAULT 1,
  parent_close_time     DateTime,
  tx_count              UInt32 DEFAULT 0
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(close_time)
ORDER BY ledger_index;

-- Raw transactions ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions
(
  ctid       String,
  hash       String,
  ledger_index UInt32,
  tx_index   UInt16,
  tx_type    LowCardinality(String),
  account    String,
  destination String DEFAULT '',
  result     LowCardinality(String),
  date       DateTime,
  tx_json    String,
  meta_json  String,
  INDEX idx_hash hash TYPE bloom_filter GRANULARITY 4,
  INDEX idx_account account TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY ctid;

-- Payments --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments
(
  ctid             String,
  tx_hash          String,
  source           String,
  destination      String,
  currency         LowCardinality(String),
  issuer           String DEFAULT '',
  amount           Float64,
  delivered_amount Float64,
  source_currency  LowCardinality(String) DEFAULT '',
  max_amount       Float64 DEFAULT 0,
  fee              Float64,
  source_tag       Nullable(UInt32),
  destination_tag  Nullable(UInt32),
  invoice_id       String DEFAULT '',
  date             DateTime,
  ledger_index     UInt32,
  tx_index         UInt16,
  client           LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY ctid;

-- Exchanges (DEX trades) ------------------------------------------------------
CREATE TABLE IF NOT EXISTS exchanges
(
  tx_hash             String,
  node_index          UInt16,
  base_currency       LowCardinality(String),
  base_issuer         String DEFAULT '',
  base_amount         Float64,
  counter_currency    LowCardinality(String),
  counter_issuer      String DEFAULT '',
  counter_amount      Float64,
  rate                Float64,
  buyer               String,
  seller              String,
  taker               String,
  provider            String,
  sequence            UInt32,
  date                DateTime,
  tx_type             LowCardinality(String),
  tx_index            UInt16,
  ledger_index        UInt32,
  client              LowCardinality(String) DEFAULT '',
  autobridged_currency String DEFAULT '',
  autobridged_issuer   String DEFAULT ''
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY (base_currency, base_issuer, counter_currency, counter_issuer, date, tx_hash, node_index);

-- Balance changes -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS balance_changes
(
  account        String,
  counterparty   String DEFAULT '',
  currency       LowCardinality(String),
  change         Float64,
  final_balance  Float64,
  type           LowCardinality(String) DEFAULT '',
  date           DateTime,
  ledger_index   UInt32,
  tx_index       UInt16,
  node_index     Int16,
  tx_hash        String,
  client         LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY (account, currency, date, tx_hash, node_index);

-- Affected accounts (account activity index) ----------------------------------
CREATE TABLE IF NOT EXISTS affected_accounts
(
  account      String,
  tx_result    LowCardinality(String),
  tx_type      LowCardinality(String),
  date         DateTime,
  ledger_index UInt32,
  tx_index     UInt16,
  tx_hash      String,
  client       LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY (account, date, tx_hash);

-- Accounts created ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts_created
(
  account      String,
  parent       String,
  balance      Float64,
  date         DateTime,
  ledger_index UInt32,
  tx_index     UInt16,
  tx_hash      String,
  client       LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY account;

-- Offers ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offers
(
  tx_type             LowCardinality(String),
  node_type           LowCardinality(String),
  account             String,
  offer_sequence      UInt32,
  expiration          Nullable(UInt32),
  book_directory      String,
  tx_hash             String,
  date                DateTime,
  ledger_index        UInt32,
  tx_index            UInt16,
  node_index          UInt16,
  prev_offer_sequence Nullable(UInt32),
  next_offer_sequence Nullable(UInt32),
  taker_pays_currency LowCardinality(String),
  taker_pays_value    Float64,
  taker_gets_currency LowCardinality(String),
  taker_gets_value    Float64,
  rate                Float64 DEFAULT 0,
  pays_change         Float64 DEFAULT 0,
  gets_change         Float64 DEFAULT 0,
  change_type         LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY (account, date, tx_hash, node_index);

-- Issuer trustlines (latest snapshot per holder) ------------------------------
CREATE TABLE IF NOT EXISTS issuers
(
  issuer       String,
  currency     LowCardinality(String),
  counterparty String,
  balance      Float64,
  date         DateTime,
  ledger_index UInt32
)
ENGINE = ReplacingMergeTree(ledger_index)
ORDER BY (issuer, currency, counterparty);

-- Escrows ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS escrows
(
  tx_hash         String,
  tx_type         LowCardinality(String),
  account         String,
  owner           String DEFAULT '',
  destination     String DEFAULT '',
  amount          Float64 DEFAULT 0,
  fee             Float64,
  flags           String DEFAULT '',
  destination_tag Nullable(UInt32),
  source_tag      Nullable(UInt32),
  create_tx_seq   Nullable(UInt32),
  create_tx       String DEFAULT '',
  condition       String DEFAULT '',
  fulfillment     String DEFAULT '',
  cancel_after    Nullable(UInt32),
  finish_after    Nullable(UInt32),
  date            DateTime,
  ledger_index    UInt32,
  tx_index        UInt16
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY tx_hash;

-- Payment channels ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS paychannels
(
  tx_hash         String,
  tx_type         LowCardinality(String),
  account         String,
  source          String DEFAULT '',
  destination     String DEFAULT '',
  channel         String DEFAULT '',
  amount          Float64 DEFAULT 0,
  balance         Float64 DEFAULT 0,
  settle          Nullable(UInt32),
  destination_tag Nullable(UInt32),
  source_tag      Nullable(UInt32),
  fee             Float64,
  flags           Nullable(UInt32),
  cancel_after    Nullable(UInt32),
  expiration      Nullable(UInt32),
  date            DateTime,
  ledger_index    UInt32,
  tx_index        UInt16
)
ENGINE = ReplacingMergeTree(ledger_index)
PARTITION BY toYYYYMM(date)
ORDER BY tx_hash;
