-- =============================================================================
-- GateHub Data API: account and market aggregates (D2). Additive to 001_baseline.sql, one database per network.
--
-- Nine new tables, all recomputable aggregates written only by the aggregator. None of them is a ledger table, so
-- ingest recovery never deletes from them, and none depends on a table of any other migration.
--
--  * Every table is a ReplacingMergeTree(version). A recompute writes a complete set (a day, an hour, a period) in one
--    insert under a new version, and a reader keeps the newest version of a set and never uses FINAL.
--  * Sets with a sentinel row: native_rates_daily (a day, with currency = '' and issuer = ''), pair_hourly (an hour,
--    with the empty pair and source book), markets_live (a period and filter, with the empty pair),
--    account_partition_rows (a partition, with account = '') and account_rollup_days (an account and day, where the
--    sentinel is the whole row, written last).
--  * The row tables of the account rollups (account_lines_daily, account_tx_daily, account_trades_daily) have version as
--    the last column of their ORDER BY. A merge keeps the newest version of each sorting key, so with a key that did not
--    have it, the rows of a newer set that is still being written (its sentinel is not in account_rollup_days yet, and
--    may never be) would replace the same groups of the set the sentinel points to, and those groups would be gone for
--    a reader. With version in the key every set keeps its own rows; a merge only collapses a row that was written twice.
--  * pair_hourly expires 45 days after its hour. ttl_only_drop_parts drops a part only when every row of it has
--    expired (a part holds one day) and never rewrites a part to cut rows out of it.
--  * Amounts are exact decimal Strings with a Float64 shadow (_f) where SQL ranks or falls back. The sentinel's
--    final flag of pair_hourly is called is_final, because FINAL is a ClickHouse keyword.
--  * Times: DateTime('UTC') for ledger and wall times (unix seconds), Date for UTC days.
--
-- Every statement is IF NOT EXISTS, so a file that failed half way can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Rates and markets.
-- ---------------------------------------------------------------------------

-- Per closed UTC day, the rate of every issued asset whose rate that day is above 0. daily_count and latest_count are
-- diagnostics: the kept trades of the day, and how many of them are among the newest 50.
CREATE TABLE IF NOT EXISTS native_rates_daily
(
  currency       LowCardinality(String),
  issuer         String,
  day            Date,
  rate           String,
  rate_f         Float64,
  daily_count    UInt32,
  latest_count   UInt32,
  config_version UInt32,
  stale          UInt8,
  version        UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYear(day)
ORDER BY (currency, issuer, day);

-- Per UTC hour, pair (canonical order) and source: the trades summed, with the open, close, high and low rate and the
-- (ledger, tx, node) key of the trade each came from. The sentinel carries is_final, config_version and through_time,
-- the close time of the newest ledger the read covered.
CREATE TABLE IF NOT EXISTS pair_hourly
(
  hour             DateTime('UTC'),
  base_currency    LowCardinality(String),
  base_issuer      String,
  counter_currency LowCardinality(String),
  counter_issuer   String,
  source           Enum8('book' = 1, 'amm' = 2),
  count            UInt64,
  base_sum         String,
  counter_sum      String,
  unfit            UInt32,
  base_sum_f       Float64,
  counter_sum_f    Float64,
  open_rate        String,
  open_ledger      UInt32,
  open_tx          UInt32,
  open_node        UInt16,
  open_time        DateTime('UTC'),
  close_rate       String,
  close_ledger     UInt32,
  close_tx         UInt32,
  close_node       UInt16,
  close_time       DateTime('UTC'),
  high_rate        String,
  high_rate_f      Float64,
  high_ledger      UInt32,
  high_tx          UInt32,
  high_node        UInt16,
  low_rate         String,
  low_rate_f       Float64,
  low_ledger       UInt32,
  low_tx           UInt32,
  low_node         UInt16,
  is_final         UInt8,
  config_version   UInt32,
  through_time     DateTime('UTC'),
  version          UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toDate(hour)
ORDER BY (hour, base_currency, base_issuer, counter_currency, counter_issuer, source)
TTL hour + INTERVAL 45 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Per period (day, 7day, 30day), AMM filter and pair. closes holds the 7 daily closes, oldest first. The sentinel
-- (the empty pair) carries start_time, end_time, pairs_traded, total_count, total_native_volume and total_amm_share.
CREATE TABLE IF NOT EXISTS markets_live
(
  period              LowCardinality(String),
  amm                 Enum8('include' = 1, 'exclude' = 2, 'only' = 3),
  base_currency       LowCardinality(String),
  base_issuer         String,
  counter_currency    LowCardinality(String),
  counter_issuer      String,
  count               UInt64,
  base_volume         String,
  counter_volume      String,
  native_volume       Nullable(String),
  open                String,
  high                String,
  low                 String,
  last                String,
  open_time           DateTime('UTC'),
  last_time           DateTime('UTC'),
  closes              Array(Nullable(String)),
  amm_share           Nullable(String),
  amm_pool            Nullable(UInt8),
  start_time          DateTime('UTC'),
  end_time            DateTime('UTC'),
  pairs_traded        UInt32,
  total_count         UInt64,
  total_native_volume String,
  total_amm_share     Nullable(String),
  version             UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (period, amm, base_currency, base_issuer, counter_currency, counter_issuer);

-- ---------------------------------------------------------------------------
-- Account rollups.
-- ---------------------------------------------------------------------------

-- One row per heavy account: its balance changes when counted, and the contiguous days its rollups cover.
CREATE TABLE IF NOT EXISTS account_rollup_state
(
  account        String,
  rows           UInt64,
  first_day      Date,
  rolled_from    Nullable(Date),
  rolled_through Nullable(Date),
  config_version UInt32,
  version        UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY account;

-- Per partition of balance_changes (intDiv(ledger_index, 10000000)), the accounts with many changes in it.
CREATE TABLE IF NOT EXISTS account_partition_rows
(
  partition UInt16,
  account   String,
  rows      UInt64,
  version   UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (partition, account);

-- The sentinel of an (account, day) rollup set: version only, written after the rows of the set.
CREATE TABLE IF NOT EXISTS account_rollup_days
(
  account String,
  day     Date,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYear(day)
ORDER BY (account, day);

-- From balance_changes. owes is final_balance < 0. end_balance is the line's last final_balance of the day by
-- (ledger_index, tx_index, node_index), the same on every row of the line and day.
CREATE TABLE IF NOT EXISTS account_lines_daily
(
  account      String,
  day          Date,
  currency     LowCardinality(String),
  counterparty String,
  change_type  LowCardinality(String),
  owes         UInt8,
  count        UInt64,
  in_sum       String,
  out_sum      String,
  unfit        UInt32,
  in_sum_f     Float64,
  out_sum_f    Float64,
  end_balance  String,
  version      UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYear(day)
ORDER BY (account, day, currency, counterparty, change_type, owes, version);

-- From account_transactions: the transactions the account sent (is_initiator = 1).
CREATE TABLE IF NOT EXISTS account_tx_daily
(
  account String,
  day     Date,
  tx_type LowCardinality(String),
  result  LowCardinality(String),
  count   UInt64,
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYear(day)
ORDER BY (account, day, tx_type, result, version);

-- From account_exchanges. bought_sum is the base where the account is the buyer, sold_sum where it is the seller (a
-- self-trade is in both), and bought_counter_sum and sold_counter_sum are the counter of those same trades. Each of
-- the six sums has a Float64 shadow for the sumOf fallback.
CREATE TABLE IF NOT EXISTS account_trades_daily
(
  account              String,
  day                  Date,
  base_currency        LowCardinality(String),
  base_issuer          String,
  counter_currency     LowCardinality(String),
  counter_issuer       String,
  count                UInt64,
  base_sum             String,
  counter_sum          String,
  bought_sum           String,
  sold_sum             String,
  bought_counter_sum   String,
  sold_counter_sum     String,
  unfit                UInt32,
  base_sum_f           Float64,
  counter_sum_f        Float64,
  bought_sum_f         Float64,
  sold_sum_f           Float64,
  bought_counter_sum_f Float64,
  sold_counter_sum_f   Float64,
  version              UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYear(day)
ORDER BY (account, day, base_currency, base_issuer, counter_currency, counter_issuer, version);
