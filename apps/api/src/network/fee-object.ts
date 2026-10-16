import { fmtTime } from '../common/format';

/** Drops in one unit of the native currency: a million, for XRP and for XAH alike. */
export const DROPS_PER_NATIVE = 1_000_000;

/** A `UInt64` the client may hand over as a number or, depending on its settings, as the text of its digits. */
type Drops = number | string;

/** Drops as native units, a JSON number: `10` drops is `0.00001`. Integer over 10^6, so the double is the nearest one. */
export function toNative(drops: Drops): number {
  return Number(drops) / DROPS_PER_NATIVE;
}

/**
 * `round(x, 6)` of `lib/aggregation/fees.js`: a value in native units rounded to six decimals, which is a whole drop.
 * Half goes up. The original did it through the text of the number (`Number(Math.round(x + 'e6') + 'e-6')`), which is
 * `NaN` for a value like `5e-7` whose text has an exponent; `toFixed` spells every double out in plain decimals.
 */
export function roundToDrops(value: number): number {
  return Math.round(Number(`${value.toFixed(12)}e6`)) / DROPS_PER_NATIVE;
}

/**
 * The `avg` of a ledger: `lib/ledgerParser/fees.js` took the mean to six significant digits (`toPrecision(6)`), and
 * `lib/aggregation/fees.js` wrote it with `round(avg, 6)`, so what the API served is that mean to a drop (ledger
 * 11118827: 138000 drops over 13 transactions is 0.0106153846..., 0.0106154, and was served as 0.010615). A ledger without
 * transactions has an `avg` of 0.
 */
export function ledgerAvg(totalDrops: Drops, txCount: number): number {
  if (txCount === 0) return 0;
  return roundToDrops(Number((toNative(totalDrops) / txCount).toPrecision(6)));
}

/**
 * The `avg` of an hour or a day: the aggregation merged the ledgers by adding their totals and counts and dividing,
 * and wrote it with `round(avg, 6)`. A bucket without transactions has an `avg` of 0 (the original divided 0 by 0 and
 * served `null`).
 */
export function bucketAvg(totalDrops: Drops, txCount: number): number {
  if (txCount === 0) return 0;
  return roundToDrops(toNative(totalDrops) / txCount);
}

/** What the per-ledger query reads from `ledgers`: the fee columns are drops. */
export interface StoredLedgerFees {
  ledger_index: number;
  /** `close_time` in unix seconds. */
  closed: number;
  tx_count: number;
  fee_total: number;
  fee_min: number;
  fee_max: number;
}

/** What the per-bucket query reads: the sums over the ledgers that closed in an hour or a day. */
export interface StoredBucketFees {
  /** The start of the bucket, unix seconds. */
  bucket: number;
  /** How many ledgers closed in it. */
  ledgers: number;
  tx_count: number;
  fee_total: number;
  /** The smallest fee of any ledger that has one above zero; 0 when none does. */
  fee_min: number;
  fee_max: number;
}

/** A row of `/v2/network/fees`: fees in native units, the keys in the order of the API. */
export interface FeeSummary {
  avg: number;
  min: number;
  max: number;
  total: number;
  tx_count: number;
  /** `YYYY-MM-DDTHH:mm:ssZ`: the close time of the ledger, or the start of the hour or day. */
  date: string;
  /** Only the rows of a ledger. */
  ledger_index?: number;
}

/**
 * The row of a ledger. `min` is the smallest fee of its transactions, 0 for a ledger without any (the parser's rule,
 * which `ledgers.fee_min` stores as it is).
 */
export function toLedgerFees(row: StoredLedgerFees): FeeSummary {
  const txCount = Number(row.tx_count);
  return {
    avg: ledgerAvg(row.fee_total, txCount),
    min: toNative(row.fee_min),
    max: toNative(row.fee_max),
    total: toNative(row.fee_total),
    tx_count: txCount,
    date: fmtTime(Number(row.closed)),
    ledger_index: Number(row.ledger_index),
  };
}

/**
 * The row of an hour or a day: the ledgers merged as `lib/aggregation/fees.js` merged them, `total` and `tx_count`
 * added, `avg` worked out again, `min` the smallest of the minimums above zero (a ledger without transactions, or whose
 * transactions paid nothing, has none, and the original let one of them hold a bucket's `min` at 0 depending on which
 * ledger it saw first), `max` the largest. The `date` is the start of the bucket and there is no `ledger_index`.
 *
 * A bucket of a single ledger is that ledger: the original set the bucket from the first ledger it saw and only
 * worked `avg` out again from the second on, so the `avg` of such a bucket is the `avg` of the ledger.
 */
export function toBucketFees(row: StoredBucketFees): FeeSummary {
  const txCount = Number(row.tx_count);
  return {
    avg: Number(row.ledgers) === 1 ? ledgerAvg(row.fee_total, txCount) : bucketAvg(row.fee_total, txCount),
    min: toNative(row.fee_min),
    max: toNative(row.fee_max),
    total: toNative(row.fee_total),
    tx_count: txCount,
    date: fmtTime(Number(row.bucket)),
  };
}

/** What the fee stats queries read from `fee_stats`: one snapshot, fees in drops, `ms` its time in unix milliseconds. */
export interface StoredFeeStat {
  ms: number;
  current_ledger_size: number;
  expected_ledger_size: number;
  current_queue_size: number;
  pct_max_queue_size: number;
  median_fee: number;
  minimum_fee: number;
  open_ledger_fee: number;
}

/** A row of `/v2/network/fee_stats`: fees in native units, the keys in the order of the API. */
export interface FeeStat {
  /** `YYYY-MM-DDTHH:mm:ssZ`: when the snapshot was taken, to the second. */
  date: string;
  current_ledger_size: number;
  expected_ledger_size: number;
  current_queue_size: number;
  pct_max_queue_size: number;
  median_fee: number;
  minimum_fee: number;
  open_ledger_fee: number;
}

export function toFeeStat(row: StoredFeeStat): FeeStat {
  return {
    date: fmtTime(new Date(Number(row.ms))),
    current_ledger_size: Number(row.current_ledger_size),
    expected_ledger_size: Number(row.expected_ledger_size),
    current_queue_size: Number(row.current_queue_size),
    pct_max_queue_size: Number(row.pct_max_queue_size),
    median_fee: toNative(row.median_fee),
    minimum_fee: toNative(row.minimum_fee),
    open_ledger_fee: toNative(row.open_ledger_fee),
  };
}
