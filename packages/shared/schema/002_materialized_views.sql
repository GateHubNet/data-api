-- =============================================================================
-- Materialized views — pre-aggregated analytics.
--
-- These replace the per-request Elasticsearch Painless scripts (review M2) with
-- incrementally-maintained aggregates. Candles / volumes are computed at INSERT
-- time, so the API only reads small, already-rolled-up state.
--
-- Pattern: a target *MergeTree table + a MATERIALIZED VIEW ... TO target.
-- SimpleAggregateFunction columns store partial max/min/sum; AggregateFunction
-- columns (argMin/argMax) store OHLC open/close and are read with *Merge.
-- =============================================================================

-- 1-minute exchange candles (OHLC + VWAP inputs) ------------------------------
CREATE TABLE IF NOT EXISTS exchange_candles_1m
(
  base_currency    LowCardinality(String),
  base_issuer      String,
  counter_currency LowCardinality(String),
  counter_issuer   String,
  minute           DateTime,
  open             AggregateFunction(argMin, Float64, DateTime),
  close            AggregateFunction(argMax, Float64, DateTime),
  high             SimpleAggregateFunction(max, Float64),
  low              SimpleAggregateFunction(min, Float64),
  base_volume      SimpleAggregateFunction(sum, Float64),
  counter_volume   SimpleAggregateFunction(sum, Float64),
  trade_count      SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(minute)
ORDER BY (base_currency, base_issuer, counter_currency, counter_issuer, minute);

CREATE MATERIALIZED VIEW IF NOT EXISTS exchange_candles_1m_mv TO exchange_candles_1m AS
SELECT
  base_currency,
  base_issuer,
  counter_currency,
  counter_issuer,
  toStartOfMinute(date) AS minute,
  argMinState(rate, date) AS open,
  argMaxState(rate, date) AS close,
  max(rate)  AS high,
  min(rate)  AS low,
  sum(base_amount)    AS base_volume,
  sum(counter_amount) AS counter_volume,
  toUInt64(count())   AS trade_count
FROM exchanges
GROUP BY base_currency, base_issuer, counter_currency, counter_issuer, minute;

-- Daily payment volume by currency/issuer -------------------------------------
CREATE TABLE IF NOT EXISTS payment_volume_daily
(
  currency      LowCardinality(String),
  issuer        String,
  day           Date,
  total_amount  Float64,
  payment_count UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (currency, issuer, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS payment_volume_daily_mv TO payment_volume_daily AS
SELECT
  currency,
  issuer,
  toDate(date) AS day,
  sum(amount)  AS total_amount,
  toUInt64(count()) AS payment_count
FROM payments
GROUP BY currency, issuer, day;

-- Daily exchange volume by base currency/issuer -------------------------------
CREATE TABLE IF NOT EXISTS exchange_volume_daily
(
  base_currency        LowCardinality(String),
  base_issuer          String,
  day                  Date,
  total_base_amount    Float64,
  total_counter_amount Float64,
  trade_count          UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY (base_currency, base_issuer, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS exchange_volume_daily_mv TO exchange_volume_daily AS
SELECT
  base_currency,
  base_issuer,
  toDate(date) AS day,
  sum(base_amount)    AS total_base_amount,
  sum(counter_amount) AS total_counter_amount,
  toUInt64(count())   AS trade_count
FROM exchanges
GROUP BY base_currency, base_issuer, day;

-- Daily network stats (payments / exchanges / accounts created) ---------------
CREATE TABLE IF NOT EXISTS stats_daily
(
  day              Date,
  payments         UInt64,
  exchanges        UInt64,
  accounts_created UInt64
)
ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(day)
ORDER BY day;

CREATE MATERIALIZED VIEW IF NOT EXISTS stats_daily_payments_mv TO stats_daily AS
SELECT toDate(date) AS day, toUInt64(count()) AS payments, toUInt64(0) AS exchanges, toUInt64(0) AS accounts_created
FROM payments GROUP BY day;

CREATE MATERIALIZED VIEW IF NOT EXISTS stats_daily_exchanges_mv TO stats_daily AS
SELECT toDate(date) AS day, toUInt64(0) AS payments, toUInt64(count()) AS exchanges, toUInt64(0) AS accounts_created
FROM exchanges GROUP BY day;

CREATE MATERIALIZED VIEW IF NOT EXISTS stats_daily_accounts_mv TO stats_daily AS
SELECT toDate(date) AS day, toUInt64(0) AS payments, toUInt64(0) AS exchanges, toUInt64(count()) AS accounts_created
FROM accounts_created GROUP BY day;
