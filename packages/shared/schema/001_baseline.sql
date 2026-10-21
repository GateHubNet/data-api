-- =============================================================================
-- GateHub Data API: ClickHouse baseline schema (one database per network).
--
-- Replaces the earlier 001_tables.sql and 002_materialized_views.sql, which were never deployed.
--
-- Design notes:
--  * Every ledger-derived table is a ReplacingMergeTree whose ORDER BY is its natural unique key.
--    That is only a safety net: list queries never use FINAL, and recovery deletes a partition range
--    before rewriting it instead of relying on merges.
--  * Wide base tables are ordered by ledger. Narrow secondary index tables (the *_by_* tables and the
--    account_* tables) are written explicitly by the syncer, so there are no aggregate materialized views.
--  * Partitions: ledger-prefixed tables use intDiv(ledger_index, 1000000), prefix-keyed tables use
--    intDiv(ledger_index, 10000000). No projections, because they conflict with lightweight DELETE.
--  * non_replicated_deduplication_window = 1000 on the ledger-derived tables lets a retried insert that
--    carries the same insert_deduplication_token be dropped by the server.
--  * Amounts are exact Strings. A *_f Float64 shadow exists only where we aggregate or sort numerically.
--    Native amounts are UInt64 drops.
--  * DateTime columns are DateTime('UTC') and are written as unix seconds.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Ledgers. The row doubles as the commit marker of a fully written ledger.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledgers
(
  ledger_index          UInt32,
  ledger_hash           String,
  parent_hash           String,
  account_hash          String,
  transaction_hash      String,
  total_coins           UInt64,
  close_time            DateTime('UTC'),
  parent_close_time     DateTime('UTC'),
  close_time_resolution UInt8,
  close_flags           UInt8,
  tx_count              UInt32,
  type_counts           Map(LowCardinality(String), UInt32),
  result_counts         Map(LowCardinality(String), UInt32),
  payments_count        UInt32,
  exchanges_count       UInt32,
  accounts_created      UInt32,
  fee_total             UInt64,
  fee_min               UInt64,
  fee_max               UInt64,
  parser_version        UInt16,
  ingested_at           DateTime('UTC') DEFAULT now(),
  INDEX close_time_mm close_time TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY ledger_index
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS ledger_by_hash
(
  ledger_hash  String,
  ledger_index UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY ledger_hash
SETTINGS non_replicated_deduplication_window = 1000;

-- ---------------------------------------------------------------------------
-- Transactions. tx_json has the metadata stripped, meta_json is the unaltered metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions
(
  ledger_index UInt32,
  tx_index     UInt32,
  hash         String,
  tx_type      LowCardinality(String),
  result       LowCardinality(String),
  account      String,
  sequence     UInt32,
  fee          UInt64,
  close_time   DateTime('UTC'),
  tx_json      String CODEC(ZSTD(3)),
  meta_json    String CODEC(ZSTD(3))
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index)
SETTINGS index_granularity = 1024, non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS tx_by_hash
(
  hash         String,
  ledger_index UInt32,
  tx_index     UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY hash
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS tx_by_type
(
  tx_type      LowCardinality(String),
  ledger_index UInt32,
  tx_index     UInt32,
  result       LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (tx_type, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per affected account.
CREATE TABLE IF NOT EXISTS account_transactions
(
  account      String,
  ledger_index UInt32,
  tx_index     UInt32,
  tx_type      LowCardinality(String),
  result       LowCardinality(String),
  is_initiator UInt8,
  close_time   DateTime('UTC')
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- Sender only.
CREATE TABLE IF NOT EXISTS account_tx_by_sequence
(
  account      String,
  sequence     UInt32,
  ledger_index UInt32,
  tx_index     UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, sequence, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments
(
  ledger_index                UInt32,
  tx_index                    UInt32,
  tx_hash                     String,
  close_time                  DateTime('UTC'),
  source                      String,
  destination                 String,
  currency                    LowCardinality(String),
  issuer                      String,
  amount                      String,
  delivered_amount            String,
  delivered_amount_f          Float64,
  max_amount                  Nullable(String),
  source_currency             LowCardinality(String),
  source_tag                  Nullable(UInt32),
  destination_tag             Nullable(UInt32),
  invoice_id                  Nullable(String),
  fee                         UInt64,
  source_balance_changes      String,
  destination_balance_changes String,
  client                      Nullable(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS payments_by_currency
(
  currency     LowCardinality(String),
  issuer       String,
  ledger_index UInt32,
  tx_index     UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (currency, issuer, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per account and payment, a `sent` row for the source and a `received` row for the destination. `direction`
-- is the last column of the key: a payment to oneself has both rows for the same account, and a ReplacingMergeTree
-- keeps one row per key, so without it a merge would drop one of them (R112).
CREATE TABLE IF NOT EXISTS account_payments
(
  account            String,
  ledger_index       UInt32,
  tx_index           UInt32,
  tx_hash            String,
  close_time         DateTime('UTC'),
  direction          Enum8('sent' = 1, 'received' = 2),
  counterparty       String,
  currency           LowCardinality(String),
  issuer             String,
  delivered_amount   String,
  delivered_amount_f Float64,
  source_tag         Nullable(UInt32),
  destination_tag    Nullable(UInt32)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, ledger_index, tx_index, direction)
SETTINGS non_replicated_deduplication_window = 1000;

-- ---------------------------------------------------------------------------
-- Exchanges. The pair is stored in Ripple's canonical (base, counter) order. A swap against an AMM pool is an
-- exchange too: amm_account is the pool account (provider is the same account, offer_sequence is 0) and is empty for an
-- order-book trade. The set index lets amm=only reads skip the granules that hold no AMM row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exchanges
(
  base_currency        LowCardinality(String),
  base_issuer          String,
  counter_currency     LowCardinality(String),
  counter_issuer       String,
  ledger_index         UInt32,
  tx_index             UInt32,
  node_index           UInt16,
  tx_hash              String,
  close_time           DateTime('UTC'),
  base_amount          String,
  counter_amount       String,
  base_amount_f        Float64,
  counter_amount_f     Float64,
  rate                 String,
  rate_f               Float64,
  buyer                String,
  seller               String,
  taker                String,
  provider             String,
  offer_sequence       UInt32,
  amm_account          String,
  autobridged_currency Nullable(String),
  autobridged_issuer   Nullable(String),
  tx_type              LowCardinality(String),
  client               Nullable(String),
  INDEX amm_account_set amm_account TYPE set(1024) GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- A full copy of every exchanges row per participating account.
CREATE TABLE IF NOT EXISTS account_exchanges
(
  account              String,
  base_currency        LowCardinality(String),
  base_issuer          String,
  counter_currency     LowCardinality(String),
  counter_issuer       String,
  ledger_index         UInt32,
  tx_index             UInt32,
  node_index           UInt16,
  tx_hash              String,
  close_time           DateTime('UTC'),
  base_amount          String,
  counter_amount       String,
  base_amount_f        Float64,
  counter_amount_f     Float64,
  rate                 String,
  rate_f               Float64,
  buyer                String,
  seller               String,
  taker                String,
  provider             String,
  offer_sequence       UInt32,
  amm_account          String,
  autobridged_currency Nullable(String),
  autobridged_issuer   Nullable(String),
  tx_type              LowCardinality(String),
  client               Nullable(String),
  INDEX amm_account_set amm_account TYPE set(1024) GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- ---------------------------------------------------------------------------
-- Balance changes. The fee row of a transaction has node_index = -1.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS balance_changes
(
  account                       String,
  ledger_index                  UInt32,
  tx_index                      UInt32,
  node_index                    Int16,
  tx_hash                       String,
  close_time                    DateTime('UTC'),
  currency                      LowCardinality(String),
  counterparty                  String,
  amount_change                 String,
  final_balance                 String,
  final_balance_f               Float64,
  change_type                   LowCardinality(String),
  escrow_counterparty           Nullable(String),
  escrow_balance_change         Nullable(String),
  paychannel_counterparty       Nullable(String),
  paychannel_fund_change        Nullable(String),
  paychannel_fund_final_balance Nullable(String),
  paychannel_final_balance      Nullable(String),
  paychannel_balance_change     Nullable(String),
  client                        Nullable(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, ledger_index, tx_index, node_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- ---------------------------------------------------------------------------
-- Accounts created. Not partitioned: the table is small and read by account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts_created
(
  account         String,
  parent          String,
  initial_balance String,
  ledger_index    UInt32,
  tx_index        UInt32,
  tx_hash         String,
  inception       DateTime('UTC'),
  genesis_balance Nullable(String),
  genesis_index   Nullable(UInt32),
  INDEX account_bf account TYPE bloom_filter GRANULARITY 1
)
ENGINE = ReplacingMergeTree
ORDER BY (ledger_index, tx_index, account)
SETTINGS non_replicated_deduplication_window = 1000;

-- ---------------------------------------------------------------------------
-- AMM ledger tables. One row per pool (or account) and transaction, written with the other ledger tables. The minmax
-- index on ledger_index lets scans by ledger skip whole parts, because the tables are ordered by pool or account and not by
-- ledger; it does not skip granules once the parts have merged, which is why the aggregator's watermark and day scans read
-- the narrow ledger-ordered amm_pool_touches instead.
-- ---------------------------------------------------------------------------

-- The state of a pool after each transaction that touched it. The pair is in Ripple's canonical (base, counter) order.
-- A value is filled whenever its node is present in the transaction's metadata (the value after the transaction, whether
-- or not the transaction changed it) and is NULL when the metadata has no such node, so readers carry the last known value
-- forward. Reserves, the LP supply and the auction price are exact Strings with Float64 shadows, the fee is in units of
-- 1/100000.
CREATE TABLE IF NOT EXISTS amm_pool_states
(
  amm_account            String,
  ledger_index           UInt32,
  tx_index               UInt32,
  tx_hash                String,
  close_time             DateTime('UTC'),
  tx_type                LowCardinality(String),
  base_currency          LowCardinality(String),
  base_issuer            String,
  counter_currency       LowCardinality(String),
  counter_issuer         String,
  reserve_base           Nullable(String),
  reserve_counter        Nullable(String),
  lp_supply              Nullable(String),
  lp_currency            Nullable(String),
  reserve_base_f         Nullable(Float64),
  reserve_counter_f      Nullable(Float64),
  lp_supply_f            Nullable(Float64),
  trading_fee            Nullable(UInt16),
  auction_holder         Nullable(String),
  auction_price          Nullable(String),
  auction_price_f        Nullable(Float64),
  auction_discounted_fee Nullable(UInt16),
  auction_expiration     Nullable(UInt32),
  deleted                UInt8,
  INDEX ledger_mm ledger_index TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (amm_account, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- The pools touched by each transaction: one row per amm_pool_states row, with the three columns of its identity, in the
-- order of the ledgers. amm_pool_states is ordered by pool, so once its parts have merged a "which pools changed after this
-- ledger" scan reads every granule (the minmax index cannot skip granules that hold a bit of every pool's history). This
-- table answers it by a range of the primary key: the aggregator's watermark and day scans read it, never the wide table.
CREATE TABLE IF NOT EXISTS amm_pool_touches
(
  ledger_index UInt32,
  tx_index     UInt32,
  amm_account  String
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, amm_account)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per create, deposit, withdraw, clawback or delete. Amounts are signed from the pool's perspective (positive
-- in, negative out), lp_tokens is positive when minted and negative when burned. mode is empty for create and delete.
CREATE TABLE IF NOT EXISTS amm_liquidity
(
  amm_account      String,
  ledger_index     UInt32,
  tx_index         UInt32,
  tx_hash          String,
  close_time       DateTime('UTC'),
  account          String,
  initiator        String,
  event            LowCardinality(String),
  mode             LowCardinality(String),
  base_amount      String,
  counter_amount   String,
  lp_tokens        String,
  base_amount_f    Float64,
  counter_amount_f Float64,
  lp_tokens_f      Float64,
  INDEX ledger_mm ledger_index TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (amm_account, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- The per-account index of amm_liquidity: the same columns, ordered by account.
CREATE TABLE IF NOT EXISTS account_amm_liquidity
(
  amm_account      String,
  ledger_index     UInt32,
  tx_index         UInt32,
  tx_hash          String,
  close_time       DateTime('UTC'),
  account          String,
  initiator        String,
  event            LowCardinality(String),
  mode             LowCardinality(String),
  base_amount      String,
  counter_amount   String,
  lp_tokens        String,
  base_amount_f    Float64,
  counter_amount_f Float64,
  lp_tokens_f      Float64,
  INDEX ledger_mm ledger_index TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, ledger_index, tx_index, amm_account)
SETTINGS non_replicated_deduplication_window = 1000;

-- One row per AMMVote or AMMBid (kind is vote or bid). price_paid is the LP tokens a bid burned.
CREATE TABLE IF NOT EXISTS amm_governance
(
  amm_account         String,
  ledger_index        UInt32,
  tx_index            UInt32,
  tx_hash             String,
  close_time          DateTime('UTC'),
  kind                LowCardinality(String),
  account             String,
  fee_voted           Nullable(UInt16),
  trading_fee_after   Nullable(UInt16),
  bid_min             Nullable(String),
  bid_max             Nullable(String),
  price_paid          Nullable(String),
  slot_holder         Nullable(String),
  slot_discounted_fee Nullable(UInt16),
  slot_expiration     Nullable(UInt32),
  auth_accounts       Array(String),
  INDEX ledger_mm ledger_index TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (amm_account, ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- ---------------------------------------------------------------------------
-- Node-sourced data
-- ---------------------------------------------------------------------------

-- A rippled fee snapshot, every few seconds.
CREATE TABLE IF NOT EXISTS fee_stats
(
  ts                    DateTime64(3, 'UTC'),
  current_ledger_size   UInt32,
  expected_ledger_size  UInt32,
  current_queue_size    UInt32,
  max_queue_size        UInt32,
  pct_max_queue_size    Float64,
  median_fee            UInt64,
  minimum_fee           UInt64,
  open_ledger_fee       UInt64
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY ts;

-- One row per (ledger_hash, validator). Repeated sightings collapse on merge: counts add up, the
-- first/last timestamps take the min/max and every other field keeps an arbitrary value.
CREATE TABLE IF NOT EXISTS validations
(
  ledger_hash           String,
  validation_public_key String,
  count                 SimpleAggregateFunction(sum, UInt64),
  first_datetime        SimpleAggregateFunction(min, DateTime64(3, 'UTC')),
  last_datetime         SimpleAggregateFunction(max, DateTime64(3, 'UTC')),
  ledger_index          SimpleAggregateFunction(any, UInt32),
  reporter_public_key   SimpleAggregateFunction(any, String),
  ephemeral_public_key  SimpleAggregateFunction(any, String),
  signature             SimpleAggregateFunction(any, String),
  signing_time          SimpleAggregateFunction(any, UInt32),
  flags                 SimpleAggregateFunction(any, UInt32),
  full                  SimpleAggregateFunction(any, UInt8),
  amendments            SimpleAggregateFunction(any, String),
  base_fee              SimpleAggregateFunction(any, Nullable(UInt64)),
  load_fee              SimpleAggregateFunction(any, Nullable(UInt64)),
  reserve_base          SimpleAggregateFunction(any, Nullable(UInt64)),
  reserve_inc           SimpleAggregateFunction(any, Nullable(UInt64))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMMDD(last_datetime)
ORDER BY (ledger_hash, validation_public_key)
TTL toDateTime(last_datetime) + INTERVAL 90 DAY;

-- The highest seq per ephemeral key wins.
CREATE TABLE IF NOT EXISTS validator_manifests
(
  ephemeral_key String,
  master_key    String,
  seq           UInt32
)
ENGINE = ReplacingMergeTree(seq)
ORDER BY ephemeral_key;

-- ---------------------------------------------------------------------------
-- Aggregates, written by the syncer's aggregator. The newest version wins.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stats_hourly
(
  hour              DateTime('UTC'),
  transaction_count UInt64,
  payments_count    UInt64,
  exchanges_count   UInt64,
  accounts_created  UInt64,
  ledger_count      UInt64,
  first_close_time  DateTime('UTC'),
  last_close_time   DateTime('UTC'),
  type_counts       Map(LowCardinality(String), UInt64),
  result_counts     Map(LowCardinality(String), UInt64),
  version           UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY hour;

CREATE TABLE IF NOT EXISTS volume_daily
(
  metric           LowCardinality(String),
  day              Date,
  component        String,
  base_currency    LowCardinality(String),
  base_issuer      String,
  counter_currency LowCardinality(String),
  counter_issuer   String,
  amount           String,
  amount_f         Float64,
  count            UInt64,
  rate_f           Float64,
  converted_f      Float64,
  config_version   UInt32,
  version          UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(day)
ORDER BY (metric, day, component);

CREATE TABLE IF NOT EXISTS volume_live
(
  metric           LowCardinality(String),
  period           LowCardinality(String),
  start_time       DateTime('UTC'),
  end_time         DateTime('UTC'),
  component        String,
  base_currency    LowCardinality(String),
  base_issuer      String,
  counter_currency LowCardinality(String),
  counter_issuer   String,
  amount           String,
  amount_f         Float64,
  count            UInt64,
  rate_f           Float64,
  converted_f      Float64,
  config_version   UInt32,
  version          UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (metric, period, component);

-- The current state of each pool, for the pool list. The aggregator rebuilds it from amm_pool_states, never ingest.
-- created_ledger and created_by are NULL for a pool whose AMMCreate was not ingested, value_native is NULL when neither
-- asset has a rate.
CREATE TABLE IF NOT EXISTS amm_pools
(
  amm_account            String,
  base_currency          LowCardinality(String),
  base_issuer            String,
  counter_currency       LowCardinality(String),
  counter_issuer         String,
  lp_currency            Nullable(String),
  created_ledger         Nullable(UInt32),
  created_by             Nullable(String),
  last_ledger            UInt32,
  reserve_base           Nullable(String),
  reserve_counter        Nullable(String),
  lp_supply              Nullable(String),
  trading_fee            Nullable(UInt16),
  auction_holder         Nullable(String),
  auction_price          Nullable(String),
  auction_discounted_fee Nullable(UInt16),
  auction_expiration     Nullable(UInt32),
  deleted                UInt8,
  value_native           Nullable(Float64),
  version                UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY amm_account;

-- One row per pool and UTC day with activity, with the closing state of the pool. volume_* are the amounts that went
-- into the pool by side, fees_*_est are estimates (NULL when a swap into that side had no known fee), liquidity_in_* and
-- liquidity_out_* the deposited and withdrawn amounts.
-- A day is one version set: the pool rows and a sentinel row (amm_account '', empty assets, zero amounts, NULL state) carry
-- the same version, and a reader takes the version of the day from the sentinel (a primary key prefix read) and keeps the pool
-- rows with that version, never the sentinel itself. final is 1 on the sentinel of a set that was made once the ingest had
-- passed the day (0 on every other row); config_version is the version of the computation that made the set.
CREATE TABLE IF NOT EXISTS amm_daily
(
  amm_account           String,
  day                   Date,
  base_currency         LowCardinality(String),
  base_issuer           String,
  counter_currency      LowCardinality(String),
  counter_issuer        String,
  swap_count            UInt64,
  volume_base           String,
  volume_counter        String,
  fees_base_est         Nullable(String),
  fees_counter_est      Nullable(String),
  deposit_count         UInt64,
  withdraw_count        UInt64,
  liquidity_in_base     String,
  liquidity_in_counter  String,
  liquidity_out_base    String,
  liquidity_out_counter String,
  reserve_base          Nullable(String),
  reserve_counter       Nullable(String),
  lp_supply             Nullable(String),
  trading_fee           Nullable(UInt16),
  value_native          Nullable(Float64),
  final                 UInt8,
  config_version        UInt32,
  version               UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(day)
ORDER BY (amm_account, day);

-- ---------------------------------------------------------------------------
-- Internal bookkeeping
-- ---------------------------------------------------------------------------

-- Range-ingest intent log: a 'started' range without a matching 'done' is redone on restart.
CREATE TABLE IF NOT EXISTS ingest_log
(
  range_start UInt32,
  range_end   UInt32,
  run_id      String,
  status      Enum8('started' = 1, 'done' = 2),
  updated_at  DateTime64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (range_start, range_end);

-- Hour ranges whose stats must be recomputed (a ledger was rewritten behind the aggregator).
CREATE TABLE IF NOT EXISTS agg_dirty
(
  from_hour  DateTime('UTC'),
  to_hour    DateTime('UTC'),
  created_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (from_hour, to_hour);

-- Single-writer lease, one row per network.
CREATE TABLE IF NOT EXISTS syncer_lease
(
  network   String,
  holder    String,
  heartbeat DateTime64(3)
)
ENGINE = ReplacingMergeTree(heartbeat)
ORDER BY network;
