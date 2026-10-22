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

/**
 * Version of the ledger parsers. Stored on every `ledgers` row so a later parser change can find stale rows.
 *
 *  - 1: the Ripple v2 data (payments, exchanges, balance changes, accounts created).
 *  - 2: AMM data (swaps as exchanges, pool states, liquidity, governance). Ledgers from the AMM enablement ledger
 *       (86795265 on mainnet) written with version 1 lack these rows; `--reprocess` rewrites them.
 */
export const PARSER_VERSION = 2;

/** The first parser version that writes swaps and the AMM tables: a ledger written by an older one lacks them. */
export const AMM_PARSER_VERSION = 2;

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
  /** The pool account of a swap against an AMM pool; `''` for an order-book trade. */
  amm_account: string;
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

// -- AMM ledger tables -------------------------------------------------------------------------------------------

/**
 * The state of a pool after a transaction that touched it: one row per pool and transaction. A value is filled whenever
 * its node is present in the transaction's metadata (the value after the transaction, changed or not) and `null` when
 * it is not; a reader carries the last known value forward. The pair is in Ripple's canonical
 * (base, counter) order, like `exchanges`.
 */
export interface AmmPoolStatesRow {
  amm_account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  close_time: UnixSeconds;
  tx_type: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  /** The 40-hex currency code of the LP token (it starts with `03`). */
  lp_currency: string | null;
  reserve_base_f: number | null;
  reserve_counter_f: number | null;
  lp_supply_f: number | null;
  /** In units of 1/100000. */
  trading_fee: number | null;
  auction_holder: string | null;
  auction_price: string | null;
  auction_price_f: number | null;
  auction_discounted_fee: number | null;
  /** Expiration of the auction slot, in seconds. */
  auction_expiration: number | null;
  /** 1 when the transaction deleted the pool. */
  deleted: number;
}

/**
 * A pool touched by a transaction: the narrow, ledger-ordered index of `amm_pool_states` (Ruling R-A14), one row per state
 * row with the three columns of its identity. The aggregator's scans ("which pools changed after this ledger", "which pools
 * have a state in these ledgers") read it by a range of the primary key, which the wide state table (ordered by pool) cannot
 * serve once its parts have merged.
 */
export interface AmmPoolTouchesRow {
  ledger_index: number;
  tx_index: number;
  amm_account: string;
}

/**
 * One liquidity event of a pool: create, deposit, withdraw, clawback or delete. Amounts are signed from the pool's
 * perspective: positive in, negative out; `lp_tokens` is positive when minted and negative when burned. `mode` is `''`
 * for events without one (create, delete).
 */
export interface AmmLiquidityRow {
  amm_account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  close_time: UnixSeconds;
  /** The liquidity provider; for a clawback the holder. */
  account: string;
  /** The sender of the transaction; differs from `account` for a clawback. */
  initiator: string;
  event: string;
  mode: string;
  base_amount: string;
  counter_amount: string;
  lp_tokens: string;
  base_amount_f: number;
  counter_amount_f: number;
  lp_tokens_f: number;
}

/** The per-account index of `amm_liquidity`: the same columns, ordered by `account`. */
export type AccountAmmLiquidityRow = AmmLiquidityRow;

/** One `AMMVote` or `AMMBid`. */
export interface AmmGovernanceRow {
  amm_account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  close_time: UnixSeconds;
  /** `'vote'` or `'bid'`. */
  kind: string;
  account: string;
  fee_voted: number | null;
  trading_fee_after: number | null;
  bid_min: string | null;
  bid_max: string | null;
  /** The LP tokens a bid burned. */
  price_paid: string | null;
  slot_holder: string | null;
  slot_discounted_fee: number | null;
  slot_expiration: number | null;
  auth_accounts: string[];
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

/** The `volume_daily` columns with `period`, `start_time` and `end_time` in place of `day`, and the fee estimates. */
export interface VolumeLiveRow extends Omit<VolumeDailyRow, 'day'> {
  period: string;
  start_time: UnixSeconds;
  end_time: UnixSeconds;
  /**
   * The estimated fees of the pool's swaps in the window, in the native currency: on the components of the `amm_volume` set of
   * the period `day` only (D2b.3). NULL when they are not known, on the sentinel and on every row of the other sets.
   */
  fees_est_f: number | null;
}

/** The current state of a pool, rebuilt by the aggregator from `amm_pool_states`. The newest `version` wins. */
export interface AmmPoolsRow {
  amm_account: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  lp_currency: string | null;
  /** Set only when an `AMMCreate` of the pool was ingested. */
  created_ledger: number | null;
  created_by: string | null;
  last_ledger: number;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  trading_fee: number | null;
  auction_holder: string | null;
  auction_price: string | null;
  auction_discounted_fee: number | null;
  auction_expiration: number | null;
  /** 1 when the pool was deleted. */
  deleted: number;
  /** The pool's value in the native currency; `null` when neither asset has a rate. */
  value_native: number | null;
  version: UInt64Value;
}

/**
 * One UTC day of a pool with activity, plus its closing state. The fee amounts are estimates.
 *
 * A day is a version set: its pool rows and its sentinel row (`amm_account` `''`, empty assets, `'0'` amounts and 0 counts, null
 * state) carry the same `version`. A reader takes the version of the day from the sentinel and keeps the pool rows with it
 * (never the sentinel, and never a row of an older set: a pool that had no activity in the newer set has no row in it).
 */
export interface AmmDailyRow {
  amm_account: string;
  /** `'YYYY-MM-DD'` */
  day: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  swap_count: UInt64Value;
  /** The amounts that went into the pool, by side. */
  volume_base: string;
  volume_counter: string;
  /**
   * The estimated fees of the swaps by the side that went in; null when a swap into that side had no known fee (the pool was
   * first seen without its AMM node, so nothing says its fee yet: Ruling R-A26). A known fee of 0 is `'0'`.
   */
  fees_base_est: string | null;
  fees_counter_est: string | null;
  deposit_count: UInt64Value;
  withdraw_count: UInt64Value;
  liquidity_in_base: string;
  liquidity_in_counter: string;
  liquidity_out_base: string;
  liquidity_out_counter: string;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  trading_fee: number | null;
  value_native: number | null;
  /** 1 on the sentinel of a set made once the ingest had passed the day (a final set), 0 on every other row. */
  final: number;
  config_version: number;
  version: UInt64Value;
}

/**
 * Per closed UTC day, the rate of an issued asset (units of the asset per unit of native). A day is a version set: its
 * sentinel row has `currency = ''` and `issuer = ''` and carries `config_version` and `stale`.
 */
export interface NativeRatesDailyRow {
  currency: string;
  issuer: string;
  /** `'YYYY-MM-DD'` */
  day: string;
  /** Exact decimal text of the rate. */
  rate: string;
  rate_f: number;
  /** Diagnostics: the kept trades of the day, and how many of them are among the newest 50. */
  daily_count: number;
  latest_count: number;
  config_version: number;
  stale: number;
  version: UInt64Value;
}

/**
 * One UTC hour of one pair (canonical order) and source. An hour is a version set: its sentinel row (empty pair, source
 * `'book'`) carries `is_final`, `config_version` and `through_time`, the close time of the newest ledger the read
 * covered. (`is_final`, because `FINAL` is a ClickHouse keyword.) Rows expire 45 days after their hour.
 */
export interface PairHourlyRow {
  hour: UnixSeconds;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  source: 'book' | 'amm';
  count: UInt64Value;
  base_sum: string;
  counter_sum: string;
  unfit: number;
  base_sum_f: number;
  counter_sum_f: number;
  /** The first, last, highest and lowest rate of the hour, with the `(ledger, tx, node)` key of the trade. */
  open_rate: string;
  open_ledger: number;
  open_tx: number;
  open_node: number;
  open_time: UnixSeconds;
  close_rate: string;
  close_ledger: number;
  close_tx: number;
  close_node: number;
  close_time: UnixSeconds;
  high_rate: string;
  high_rate_f: number;
  high_ledger: number;
  high_tx: number;
  high_node: number;
  low_rate: string;
  low_rate_f: number;
  low_ledger: number;
  low_tx: number;
  low_node: number;
  is_final: number;
  config_version: number;
  through_time: UnixSeconds;
  version: UInt64Value;
}

/**
 * One pair of one (period, AMM filter) set. A set is written whole in one insert; its sentinel row (empty pair) carries
 * `start_time`, `end_time`, `pairs_traded`, `total_count`, `total_native_volume` and `total_amm_share`.
 */
export interface MarketsLiveRow {
  /** `'day'`, `'7day'` or `'30day'` */
  period: string;
  amm: 'include' | 'exclude' | 'only';
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  count: UInt64Value;
  base_volume: string;
  counter_volume: string;
  native_volume: string | null;
  open: string;
  high: string;
  low: string;
  last: string;
  open_time: UnixSeconds;
  last_time: UnixSeconds;
  /** The 7 daily closes, oldest first. */
  closes: (string | null)[];
  /** NULL until the AMM data lands. */
  amm_share: string | null;
  amm_pool: number | null;
  start_time: UnixSeconds;
  end_time: UnixSeconds;
  pairs_traded: number;
  total_count: UInt64Value;
  total_native_volume: string;
  total_amm_share: string | null;
  version: UInt64Value;
}

/** One row per heavy account: the contiguous days its rollups cover are `rolled_from` to `rolled_through`. */
export interface AccountRollupStateRow {
  account: string;
  /** Its balance changes, when counted. */
  rows: UInt64Value;
  /** `'YYYY-MM-DD'` */
  first_day: string;
  /** `'YYYY-MM-DD'` or NULL */
  rolled_from: string | null;
  /** `'YYYY-MM-DD'` or NULL */
  rolled_through: string | null;
  config_version: number;
  version: UInt64Value;
}

/**
 * The accounts with many balance changes in one partition of `balance_changes` (`intDiv(ledger_index, 10000000)`);
 * `account = ''` is its sentinel.
 */
export interface AccountPartitionRowsRow {
  partition: number;
  account: string;
  rows: UInt64Value;
  version: UInt64Value;
}

/** The sentinel of an (account, day) rollup set: written after the set's rows. */
export interface AccountRollupDaysRow {
  account: string;
  /** `'YYYY-MM-DD'` */
  day: string;
  version: UInt64Value;
}

/** One account's balance changes of one line (asset) and UTC day. */
export interface AccountLinesDailyRow {
  account: string;
  /** `'YYYY-MM-DD'` */
  day: string;
  currency: string;
  counterparty: string;
  change_type: string;
  /** `final_balance < 0` */
  owes: number;
  count: UInt64Value;
  /** Sum of the positive and minus the sum of the negative `amount_change`, exact. */
  in_sum: string;
  out_sum: string;
  unfit: number;
  in_sum_f: number;
  out_sum_f: number;
  /** The line's last `final_balance` of the day, the same on every row of the line and day. */
  end_balance: string;
  version: UInt64Value;
}

/** The transactions an account sent (`is_initiator = 1`) on one UTC day. */
export interface AccountTxDailyRow {
  account: string;
  /** `'YYYY-MM-DD'` */
  day: string;
  tx_type: string;
  result: string;
  count: UInt64Value;
  version: UInt64Value;
}

/** One account's trades of one pair and UTC day; `bought_*` is where it is the buyer, `sold_*` the seller. */
export interface AccountTradesDailyRow {
  account: string;
  /** `'YYYY-MM-DD'` */
  day: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  count: UInt64Value;
  base_sum: string;
  counter_sum: string;
  bought_sum: string;
  sold_sum: string;
  /** The counter amounts of the same trades as `bought_sum` and `sold_sum`. */
  bought_counter_sum: string;
  sold_counter_sum: string;
  unfit: number;
  base_sum_f: number;
  counter_sum_f: number;
  bought_sum_f: number;
  sold_sum_f: number;
  bought_counter_sum_f: number;
  sold_counter_sum_f: number;
  version: UInt64Value;
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
