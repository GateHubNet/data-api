/**
 * Row types: one interface per table of `schema/001_baseline.sql`, named `<Table enum key>Row`. Field names are the
 * column names (snake_case) and follow the DDL order. Rows are sent to ClickHouse as `JSONEachRow`.
 *
 * Type mapping:
 *  - `UInt64` is `string | number`. Use a string for anything that can exceed 2^53 (drops, `total_coins`).
 *  - `DateTime` is `number`: unix seconds, inserted as an integer.
 *  - `DateTime64(3)` is `number`: unix seconds with the milliseconds as the fraction (`1700000000.123`). Never pass an
 *    integer millisecond count: ClickHouse reads a bare integer as seconds and silently clamps it to year 9999.
 *  - `Date` is a `'YYYY-MM-DD'` string.
 *  - `Map(LowCardinality(String), UIntN)` is `Record<string, number>`.
 *  - `Nullable(T)` is `T | null`; `Enum8` is the union of its labels; everything else follows its plain TS type.
 *
 * Reading back is not symmetric: with the server defaults a `UInt64` comes back as a JSON number (lossy above 2^53)
 * and a `DateTime` as a `'YYYY-MM-DD HH:MM:SS'` string. Select `toString(col)` when the exact digits matter.
 */

/** Version of the ledger parsers. Stored on every `ledgers` row so a later parser change can find stale rows. */
export const PARSER_VERSION = 1;

/** `UInt64` column: a string stays exact above 2^53. */
export type UInt64Value = string | number;
/** `DateTime('UTC')` column: unix seconds. */
export type UnixSeconds = number;
/** `DateTime64(3)` column: unix seconds with a millisecond fraction. */
export type UnixSecondsMs = number;
/** `Map(LowCardinality(String), UIntN)` column. */
export type CountMap = Record<string, number>;

// -- Ledger-derived tables ---------------------------------------------------------------------------------------

export interface LedgersRow {
  ledger_index: number;
  ledger_hash: string;
  parent_hash: string;
  account_hash: string;
  transaction_hash: string;
  total_coins: UInt64Value;
  close_time: UnixSeconds;
  parent_close_time: UnixSeconds;
  close_time_resolution: number;
  close_flags: number;
  tx_count: number;
  type_counts: CountMap;
  result_counts: CountMap;
  payments_count: number;
  exchanges_count: number;
  accounts_created: number;
  fee_total: UInt64Value;
  fee_min: UInt64Value;
  fee_max: UInt64Value;
  parser_version: number;
  /** Has a server-side default (`now()`): leave it out and ClickHouse stamps the insert time. */
  ingested_at?: UnixSeconds;
}

export interface LedgerByHashRow {
  ledger_hash: string;
  ledger_index: number;
}

export interface TransactionsRow {
  ledger_index: number;
  tx_index: number;
  hash: string;
  tx_type: string;
  result: string;
  account: string;
  sequence: number;
  fee: UInt64Value;
  close_time: UnixSeconds;
  /** The transaction JSON without its metadata. */
  tx_json: string;
  /** The unaltered metadata JSON. */
  meta_json: string;
}

export interface TxByHashRow {
  hash: string;
  ledger_index: number;
  tx_index: number;
}

export interface TxByTypeRow {
  tx_type: string;
  ledger_index: number;
  tx_index: number;
  result: string;
}

export interface AccountTransactionsRow {
  account: string;
  ledger_index: number;
  tx_index: number;
  tx_type: string;
  result: string;
  /** 1 when the account is the transaction's sender, otherwise 0. */
  is_initiator: number;
  close_time: UnixSeconds;
}

export interface AccountTxBySequenceRow {
  account: string;
  sequence: number;
  ledger_index: number;
  tx_index: number;
}

export interface PaymentsRow {
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  close_time: UnixSeconds;
  source: string;
  destination: string;
  currency: string;
  issuer: string;
  amount: string;
  delivered_amount: string;
  delivered_amount_f: number;
  max_amount: string | null;
  source_currency: string;
  source_tag: number | null;
  destination_tag: number | null;
  invoice_id: string | null;
  fee: UInt64Value;
  source_balance_changes: string;
  destination_balance_changes: string;
  client: string | null;
}

export interface PaymentsByCurrencyRow {
  currency: string;
  issuer: string;
  ledger_index: number;
  tx_index: number;
}

export interface AccountPaymentsRow {
  account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  close_time: UnixSeconds;
  direction: 'sent' | 'received';
  counterparty: string;
  currency: string;
  issuer: string;
  delivered_amount: string;
  delivered_amount_f: number;
  source_tag: number | null;
  destination_tag: number | null;
}

export interface ExchangesRow {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  ledger_index: number;
  tx_index: number;
  node_index: number;
  tx_hash: string;
  close_time: UnixSeconds;
  base_amount: string;
  counter_amount: string;
  base_amount_f: number;
  counter_amount_f: number;
  rate: string;
  rate_f: number;
  buyer: string;
  seller: string;
  taker: string;
  provider: string;
  offer_sequence: number;
  autobridged_currency: string | null;
  autobridged_issuer: string | null;
  tx_type: string;
  client: string | null;
}

export type AccountExchangesRow = ExchangesRow & { account: string };

export interface BalanceChangesRow {
  account: string;
  ledger_index: number;
  tx_index: number;
  /** -1 for the transaction's fee row. */
  node_index: number;
  tx_hash: string;
  close_time: UnixSeconds;
  currency: string;
  counterparty: string;
  amount_change: string;
  final_balance: string;
  final_balance_f: number;
  change_type: string;
  escrow_counterparty: string | null;
  escrow_balance_change: string | null;
  paychannel_counterparty: string | null;
  paychannel_fund_change: string | null;
  paychannel_fund_final_balance: string | null;
  paychannel_final_balance: string | null;
  paychannel_balance_change: string | null;
  client: string | null;
}

export interface AccountsCreatedRow {
  account: string;
  parent: string;
  initial_balance: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  inception: UnixSeconds;
  genesis_balance: string | null;
  genesis_index: number | null;
}

// -- Node-sourced tables -----------------------------------------------------------------------------------------

export interface FeeStatsRow {
  ts: UnixSecondsMs;
  current_ledger_size: number;
  expected_ledger_size: number;
  current_queue_size: number;
  max_queue_size: number;
  pct_max_queue_size: number;
  median_fee: UInt64Value;
  minimum_fee: UInt64Value;
  open_ledger_fee: UInt64Value;
}

/**
 * One sighting of a validation. Rows with the same `(ledger_hash, validation_public_key)` merge in the background:
 * `count` sums, `first_datetime` takes the min, `last_datetime` the max and every other field keeps one of the values.
 * Insert a single sighting with `count: 1` and `first_datetime === last_datetime`.
 */
export interface ValidationsRow {
  ledger_hash: string;
  validation_public_key: string;
  count: UInt64Value;
  first_datetime: UnixSecondsMs;
  last_datetime: UnixSecondsMs;
  ledger_index: number;
  reporter_public_key: string;
  ephemeral_public_key: string;
  signature: string;
  signing_time: number;
  flags: number;
  /** 1 for a full validation, 0 for a partial one. */
  full: number;
  amendments: string;
  base_fee: UInt64Value | null;
  load_fee: UInt64Value | null;
  reserve_base: UInt64Value | null;
  reserve_inc: UInt64Value | null;
}

export interface ValidatorManifestsRow {
  ephemeral_key: string;
  master_key: string;
  seq: number;
}

// -- Aggregates --------------------------------------------------------------------------------------------------

export interface StatsHourlyRow {
  hour: UnixSeconds;
  transaction_count: UInt64Value;
  payments_count: UInt64Value;
  exchanges_count: UInt64Value;
  accounts_created: UInt64Value;
  ledger_count: UInt64Value;
  first_close_time: UnixSeconds;
  last_close_time: UnixSeconds;
  type_counts: CountMap;
  result_counts: CountMap;
  version: UInt64Value;
}

export interface VolumeDailyRow {
  metric: string;
  /** `'YYYY-MM-DD'` */
  day: string;
  component: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  amount: string;
  amount_f: number;
  count: UInt64Value;
  rate_f: number;
  converted_f: number;
  config_version: number;
  version: UInt64Value;
}

/** The `volume_daily` columns with `period`, `start_time` and `end_time` in place of `day`. */
export interface VolumeLiveRow extends Omit<VolumeDailyRow, 'day'> {
  period: string;
  start_time: UnixSeconds;
  end_time: UnixSeconds;
}

// -- Internal bookkeeping ----------------------------------------------------------------------------------------

export interface IngestLogRow {
  range_start: number;
  range_end: number;
  run_id: string;
  status: 'started' | 'done';
  updated_at: UnixSecondsMs;
}

export interface AggDirtyRow {
  from_hour: UnixSeconds;
  to_hour: UnixSeconds;
  created_at: UnixSecondsMs;
}

export interface SyncerLeaseRow {
  network: string;
  holder: string;
  heartbeat: UnixSecondsMs;
}
