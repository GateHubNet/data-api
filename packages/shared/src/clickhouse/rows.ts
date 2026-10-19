/**
 * Row types: one interface per table of `schema/*.sql`, named `<Table enum key>Row`. Field names are the column names
 * (snake_case) and follow the DDL order. Rows are sent to ClickHouse as `JSONEachRow`.
 *
 * Type mapping:
 *  - `UInt64` is `string | number`. Use a string for anything that can exceed 2^53 (drops, `total_coins`).
 *  - `DateTime` is `number`: unix seconds, inserted as an integer.
 *  - `DateTime64(3)` is `number`: unix seconds with the milliseconds as the fraction (`1700000000.123`). Never pass an
 *    integer millisecond count: ClickHouse reads a bare integer as seconds and silently clamps it to year 9999.
 *  - `Date` is a `'YYYY-MM-DD'` string.
 *  - `Map(LowCardinality(String), UIntN)` is `Record<string, number>`.
 *  - `Nullable(T)` is `T | null`; `Enum8` is the union of its labels; everything else follows its plain TS type.
 *  - `Array(String)` is `string[]`; a named `Tuple` is an object with the tuple's element names.
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
  /**
   * The software version the validator reported (`sfServerVersion`), an encoded UInt64 (keep it a string: it exceeds
   * 2^53). NULL when the validation carries none: only a validation of a voting ledger does. Added by migration 002.
   */
  server_version: UInt64Value | null;
}

export interface ValidatorManifestsRow {
  ephemeral_key: string;
  master_key: string;
  seq: number;
  /** The domain the manifest names, `''` when it names none. Added by migration 002. */
  domain: string;
  /** The raw manifest, upper-case hex, `''` when not known. Added by migration 002. */
  manifest: string;
  /** Where the manifest came from: the validations stream, the `manifest` RPC or a published UNL list. */
  source: 'stream' | 'rpc' | 'unl';
}

// -- Validators and amendments (migration 002) -------------------------------------------------------------------

/**
 * One validator's validations of one ledger, kept 7 days. Rows with the same `(validation_public_key, ledger_index,
 * ledger_hash)` merge in the background like `validations` does: `count` sums, `first_datetime` takes the min,
 * `last_datetime` the max, `full` the max (a full validation wins over a partial one), the rest keep one value.
 */
export interface ValidatorValidationsRow {
  validation_public_key: string;
  ledger_index: number;
  ledger_hash: string;
  count: UInt64Value;
  first_datetime: UnixSecondsMs;
  last_datetime: UnixSecondsMs;
  ephemeral_public_key: string;
  signing_time: number;
  /** 1 for a full validation, 0 for a partial one. */
  full: number;
  server_version: UInt64Value | null;
}

/** When a validator was first and last seen by this deployment. Rows of one key merge: min, max, max. */
export interface ValidatorSeenRow {
  validation_public_key: string;
  first_seen: UnixSecondsMs;
  last_seen: UnixSecondsMs;
  last_ledger_index: number;
}

/** One list a UNL publisher served (the newest row of a `(publisher, sequence)` wins). */
export interface UnlListsRow {
  /** The publisher's id, e.g. `vl.ripple.com`. */
  publisher: string;
  /** The publisher's master key, hex. */
  publisher_key: string;
  sequence: UInt64Value;
  /** The list format: 1 or 2. */
  version: number;
  effective: UnixSeconds | null;
  expiration: UnixSeconds;
  /** Master keys (base58), sorted. */
  validators: string[];
  blob_sha256: string;
  fetched_at: UnixSecondsMs;
  /** The JSON as the publisher served it. */
  response: string;
}

/** The newest state of each configured UNL publisher. */
export interface UnlPublishersRow {
  publisher: string;
  url: string;
  publisher_key: string;
  /** 1 while the publisher is in the configuration. */
  configured: number;
  /** The trusted-set threshold in force. */
  threshold: number;
  checked_at: UnixSecondsMs;
  /** `ok` or `error`. */
  status: string;
  /** A reason code, `''` when `ok`. */
  error: string;
  last_ok_at: UnixSecondsMs | null;
}

/** The newest domain check of a validator. */
export interface ValidatorDomainsRow {
  validation_public_key: string;
  domain: string;
  /** `verified` or `unverified`. */
  status: string;
  reason: string;
  /** The HTTP status when `reason` is `http_status`, else 0. */
  status_code: number;
  toml_url: string;
  checked_at: UnixSecondsMs;
  /** The last time the check succeeded. */
  verified_at: UnixSecondsMs | null;
  next_check_at: UnixSeconds;
  /** The `[[ACCOUNTS]]` addresses of the last TOML that verified, sorted; empty when unverified. */
  accounts: string[];
}

/** The ledger state the node reports: enabled amendments, majorities, negative UNL and fees at `ledger_index`. */
export interface NetworkStateRow {
  ledger_index: number;
  ledger_hash: string;
  polled_at: UnixSecondsMs;
  /** Enabled amendment IDs, upper-case hex. */
  amendments: string[];
  majorities: { amendment: string; since: UnixSeconds }[];
  negative_unl: { validation_public_key: string; first_ledger: number }[];
  /** base58, `''` when none. */
  to_disable: string;
  /** base58, `''` when none. */
  to_reenable: string;
  /** Fees in force, in drops. */
  base_fee: UInt64Value;
  reserve_base: UInt64Value;
  reserve_inc: UInt64Value;
  /** The quorum the node reports, 0 when it reports none. */
  node_quorum: number;
}

/** The name and support the node reports for an amendment ID. */
export interface AmendmentFeaturesRow {
  amendment_id: string;
  name: string;
  supported: number;
  polled_at: UnixSecondsMs;
}

/** One validator's vote in one voting ledger. Part of a version set: read only the newest sentinel's `version`. */
export interface ValidatorVotesRow {
  /** The voting ledger V. */
  ledger_index: number;
  validation_public_key: string;
  ledger_hash: string;
  close_time: UnixSeconds;
  full: number;
  amendments: string[];
  /** Drops. NULL when the validation carries no such vote. */
  base_fee: UInt64Value | null;
  reserve_base: UInt64Value | null;
  reserve_inc: UInt64Value | null;
  server_version: UInt64Value | null;
  version: UInt64Value;
}

/** The tally of one amendment in one voting ledger; `amendment_id = ''` is the round's sentinel. A version set. */
export interface AmendmentTalliesRow {
  ledger_index: number;
  amendment_id: string;
  close_time: UnixSeconds;
  yes: number;
  trusted: number;
  threshold: number;
  unl_size: number;
  observed: number;
  /** Filled on the sentinel only: the UNL and the negative UNL of the round, and the fees in force (drops). */
  unl: string[];
  negative_unl: string[];
  base_fee: UInt64Value;
  reserve_base: UInt64Value;
  reserve_inc: UInt64Value;
  version: UInt64Value;
}

/** One validator's agreement in one hour; `validation_public_key = ''` is the hour's sentinel. A version set. */
export interface ValidatorAgreementHourlyRow {
  hour: UnixSeconds;
  validation_public_key: string;
  agreed: number;
  missed: number;
  partial: number;
  last_seen: UnixSecondsMs;
  /** Filled on the sentinel only: the hour's totals. */
  ledgers: number;
  unobserved: number;
  gaps: number;
  unl_size: number;
  quorum: number;
  final: number;
  version: UInt64Value;
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
