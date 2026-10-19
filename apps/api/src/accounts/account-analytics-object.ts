import { Asset, assetKey, DayRates, nativeValue, sumOf } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { fmtTime } from '../common/format';
import { dayText, VolumeInterval } from '../network/volume-buckets';
import { AnalyticsWindow } from './analytics-window';

/**
 * The objects of the routes under `GET /v2/accounts/:address/analytics/`, with the keys in the order the tasks pin
 * (`Object.keys` tests). A key without a value is left out, and `null` is never served.
 */

/**
 * The change types of `balance_changes` in the order the totals and rows give them. The changes of transaction types the
 * original never classified have none (`''`): they come after these, without a `change_type` key.
 */
export const CHANGE_TYPE_ORDER = [
  'transaction_cost',
  'payment_destination',
  'payment_source',
  'exchange',
  'intermediary',
  'escrow_create',
  'escrow_finish',
  'escrow_cancel',
  'paychannel_fund',
  'paychannel_payout',
] as const;

const midnight = (day: string): string => `${day}T00:00:00Z`;
const ZERO = new BigNumber(0);
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------------
// balances
// ---------------------------------------------------------------------------------------------------------------------

/** A line of the account (a currency and its counterparty, `''` for the native currency) with its balance at the window's end. */
export interface StoredLine {
  currency: string;
  counterparty: string;
  /** Exact, as the ledger had it. */
  balance: string;
}

/**
 * The balance a line was left with in a bucket: the last of its days in it (`label`, the start of the bucket as `YYYY-MM-DD`),
 * or, for `label` of `''`, the last of all the days before the window.
 */
export interface StoredLineBucket extends StoredLine {
  label: string;
}

/** A line of the answer: `currency, counterparty?, balance`. */
export interface BalanceLine {
  currency: string;
  counterparty?: string;
  balance: string;
}

/** A row of the answer: the balance of a line at the end of a bucket, `date` being the start of the bucket. */
export interface BalanceRow {
  date: string;
  currency: string;
  counterparty?: string;
  balance: string;
}

const lineKey = (l: { currency: string; counterparty: string }): string => `${l.currency}\u0000${l.counterparty}`;

/** The lines as the answer has them: no `counterparty` for the native currency. */
export function toBalanceLines(lines: StoredLine[]): BalanceLine[] {
  return lines.map(
    (l): BalanceLine => ({
      currency: l.currency,
      ...(l.counterparty !== '' && { counterparty: l.counterparty }),
      balance: l.balance,
    }),
  );
}

/**
 * The rows of the balance history of `lines`, from what the day groups left in each bucket (`stored`) and the starts of the
 * buckets to serve (unix ms, oldest first). A line's balance at the end of a bucket is the last one up to then: a bucket
 * without a change carries the balance before it. A line has rows from the bucket of its first change, or from the first
 * bucket when it changed before them (`label` of `''`), and keeps them when its balance goes back to 0. The rows are ordered
 * by date, then by the order of `lines`.
 */
export function toBalanceRows(lines: StoredLine[], stored: StoredLineBucket[], buckets: number[]): BalanceRow[] {
  const labelsOf = new Map<string, Map<string, string>>();
  for (const s of stored) {
    const labels = labelsOf.get(lineKey(s));
    if (labels) labels.set(s.label, s.balance);
    else labelsOf.set(lineKey(s), new Map([[s.label, s.balance]]));
  }
  const days = buckets.map(dayText);

  // for each line, the index of its first bucket and the balance it had before it
  const begins = lines.map((line) => {
    const labels = labelsOf.get(lineKey(line));
    const before = labels?.get('');
    const at = before !== undefined ? 0 : days.findIndex((day) => labels?.has(day));
    return { labels, at, carried: before };
  });

  const rows: BalanceRow[] = [];
  days.forEach((day, i) => {
    lines.forEach((line, n) => {
      const b = begins[n];
      if (b.at < 0 || i < b.at || b.labels === undefined) return;
      b.carried = b.labels.get(day) ?? b.carried;
      rows.push({
        date: midnight(day),
        currency: line.currency,
        ...(line.counterparty !== '' && { counterparty: line.counterparty }),
        balance: b.carried as string,
      });
    });
  });
  return rows;
}

/** The answer of `analytics/balances`: `result, start, end, interval, lines_total, lines, count, rows`. */
export interface BalancesAnswer {
  result: 'success';
  start: string;
  end: string;
  interval: VolumeInterval;
  lines_total: number;
  lines: BalanceLine[];
  count: number;
  rows: BalanceRow[];
}

export function balancesAnswer(
  window: AnalyticsWindow,
  found: { linesTotal: number; lines: BalanceLine[]; rows: BalanceRow[] },
): BalancesAnswer {
  return {
    result: 'success',
    start: fmtTime(window.start),
    end: fmtTime(window.end),
    interval: window.interval ?? 'day',
    lines_total: found.linesTotal,
    lines: found.lines,
    count: found.rows.length,
    rows: found.rows,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// balance changes
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The balance changes of one UTC day, one change type and one asset (`GROUP BY day, change_type, currency, issuer`), as the
 * day groups of the account's lines add up: their number, and the exact sum of the positive changes (`in_sum`) and of the
 * negative ones as a positive amount (`out_sum`), with their Float64 shadows for the changes a decimal cannot hold whole
 * (`unfit` counts those: if there are any, the floats are used, as `sumOf` has it).
 */
export interface StoredChangeGroup {
  /** `YYYY-MM-DD` */
  day: string;
  /** `''` for a change of a transaction type the original never classified. */
  change_type: string;
  currency: string;
  /** `''` for the native currency; the account itself where it owes on the line. */
  issuer: string;
  n: number | string;
  in_sum: string | null;
  out_sum: string | null;
  unfit: number | string;
  in_sum_f: number | null;
  out_sum_f: number | null;
}

/** A total of the answer, one per change type: `change_type?, count, in_value, out_value, net_value`. */
export interface ChangeTotal {
  change_type?: string;
  count: number;
  in_value: string;
  out_value: string;
  net_value: string;
}

/** A row without an interval, one per change type and asset: `change_type?, currency, issuer?, count, in, out, in_value, out_value`. */
export interface ChangeAssetRow {
  change_type?: string;
  currency: string;
  issuer?: string;
  count: number;
  in: string;
  out: string;
  in_value: string;
  out_value: string;
}

/** A row with an interval, one per bucket and change type: `date, change_type?, count, in_value, out_value`. */
export interface ChangeBucketRow {
  date: string;
  change_type?: string;
  count: number;
  in_value: string;
  out_value: string;
}

export interface BalanceChanges {
  totals: ChangeTotal[];
  rows: (ChangeAssetRow | ChangeBucketRow)[];
}

/** The asset of a group: the native currency, or the currency and its issuer. */
export function changeAsset(g: { currency: string; issuer: string }): Asset {
  return g.issuer === '' ? { currency: g.currency } : { currency: g.currency, issuer: g.issuer };
}

const amounts = (g: StoredChangeGroup): { inn: BigNumber; out: BigNumber } => {
  const unfit = Number(g.unfit);
  return { inn: sumOf(unfit, g.in_sum, g.in_sum_f), out: sumOf(unfit, g.out_sum, g.out_sum_f) };
};

/**
 * What the values of `groups` need: the issued assets that moved, each once, and the days (`YYYY-MM-DD`, ascending) on which
 * one did. The native currency (no issuer) is worth itself and a group that moved nothing is worth nothing, so neither asks
 * for a rate.
 */
export function ratedChangeAssets(groups: StoredChangeGroup[]): { assets: Asset[]; days: string[] } {
  const assets = new Map<string, Asset>();
  const days = new Set<string>();
  for (const g of groups) {
    const asset = changeAsset(g);
    // the native currency is worth itself, and an asset without an issuer has no rate (`DailyRates`: 0)
    if (asset.issuer === undefined) continue;
    const { inn, out } = amounts(g);
    if (!inn.gt(0) && !out.gt(0)) continue;
    assets.set(assetKey(asset), asset);
    days.add(g.day);
  }
  return { assets: [...assets.values()], days: [...days].sort() };
}

export interface BalanceChangesInput {
  /** The native currency of the network. */
  native: string;
  groups: StoredChangeGroup[];
  /** The rate of each issued asset that moved, on each day it did (`ratedChangeAssets`). */
  rates: DayRates;
  /** The bucket of the rows, and the start (`YYYY-MM-DD`) of the bucket a day is in. Without it the rows are per asset. */
  bucketOf?: (day: string) => string;
}

interface Sums {
  count: number;
  inn: BigNumber;
  out: BigNumber;
  inValue: BigNumber;
  outValue: BigNumber;
}

const sumsOf = (): Sums => ({ count: 0, inn: ZERO, out: ZERO, inValue: ZERO, outValue: ZERO });

function add(to: Sums, count: number, inn: BigNumber, out: BigNumber, inValue: BigNumber, outValue: BigNumber): void {
  to.count += count;
  to.inn = to.inn.plus(inn);
  to.out = to.out.plus(out);
  to.inValue = to.inValue.plus(inValue);
  to.outValue = to.outValue.plus(outValue);
}

/** Where a change type stands in the lists: the ten in `CHANGE_TYPE_ORDER`, any other after them, the unclassified last. */
function typeRank(type: string): number {
  if (type === '') return CHANGE_TYPE_ORDER.length + 1;
  const at = (CHANGE_TYPE_ORDER as readonly string[]).indexOf(type);
  return at < 0 ? CHANGE_TYPE_ORDER.length : at;
}

const byType = (a: string, b: string): number => typeRank(a) - typeRank(b) || compare(a, b);
const typed = (type: string): { change_type?: string } => (type === '' ? {} : { change_type: type });

/**
 * The totals and the rows of `analytics/balance_changes` from the groups of its window.
 *
 * Every change counts once, the fee rows included. A group is valued on its own day, at the rate of its asset on that day: the
 * native currency is worth itself, an issued amount its amount over the rate, cut to 17 significant digits per group and day,
 * and 0 where there is no rate (`nativeValue`); the sums of values are exact. `net_value` is `in_value - out_value`.
 *  - `totals`: one per change type with a change, in `CHANGE_TYPE_ORDER`.
 *  - `rows` without `bucketOf`: per change type and asset, by type, then `in_value + out_value` largest first, then the
 *    currency and the issuer.
 *  - `rows` with `bucketOf`: per bucket and change type, by date, then type.
 */
export function toBalanceChanges(input: BalanceChangesInput): BalanceChanges {
  const totals = new Map<string, Sums>();
  const perAsset = new Map<string, Sums & { type: string; currency: string; issuer: string }>();
  const perBucket = new Map<string, Sums & { type: string; date: string }>();

  for (const g of input.groups) {
    const { inn, out } = amounts(g);
    const asset = changeAsset(g);
    const inValue = nativeValue(inn, asset, g.day, input.rates, input.native);
    const outValue = nativeValue(out, asset, g.day, input.rates, input.native);
    const count = Number(g.n);

    add(entry(totals, g.change_type, sumsOf), count, inn, out, inValue, outValue);
    if (input.bucketOf === undefined) {
      const key = `${g.change_type}\u0000${g.currency}\u0000${g.issuer}`;
      const row = entry(perAsset, key, () => ({
        ...sumsOf(),
        type: g.change_type,
        currency: g.currency,
        issuer: g.issuer,
      }));
      add(row, count, inn, out, inValue, outValue);
    } else {
      const date = input.bucketOf(g.day);
      const row = entry(perBucket, `${date}\u0000${g.change_type}`, () => ({
        ...sumsOf(),
        type: g.change_type,
        date,
      }));
      add(row, count, inn, out, inValue, outValue);
    }
  }

  const totalList = [...totals.entries()]
    .sort(([a], [b]) => byType(a, b))
    .map(
      ([type, s]): ChangeTotal => ({
        ...typed(type),
        count: s.count,
        in_value: s.inValue.toString(),
        out_value: s.outValue.toString(),
        net_value: s.inValue.minus(s.outValue).toString(),
      }),
    );

  if (input.bucketOf !== undefined) {
    const rows = [...perBucket.values()]
      .sort((a, b) => compare(a.date, b.date) || byType(a.type, b.type))
      .map(
        (s): ChangeBucketRow => ({
          date: midnight(s.date),
          ...typed(s.type),
          count: s.count,
          in_value: s.inValue.toString(),
          out_value: s.outValue.toString(),
        }),
      );
    return { totals: totalList, rows };
  }

  const rows = [...perAsset.values()]
    .sort(
      (a, b) =>
        byType(a.type, b.type) ||
        b.inValue.plus(b.outValue).comparedTo(a.inValue.plus(a.outValue)) ||
        compare(a.currency, b.currency) ||
        compare(a.issuer, b.issuer),
    )
    .map(
      (s): ChangeAssetRow => ({
        ...typed(s.type),
        currency: s.currency,
        ...(s.issuer !== '' && { issuer: s.issuer }),
        count: s.count,
        in: s.inn.toString(),
        out: s.out.toString(),
        in_value: s.inValue.toString(),
        out_value: s.outValue.toString(),
      }),
    );
  return { totals: totalList, rows };
}

/** The value of a key of a map, made and kept when the key has none yet. */
function entry<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

/** The answer of `analytics/balance_changes`: `result, start, end, interval?, totals, count, rows`. */
export interface BalanceChangesAnswer {
  result: 'success';
  start: string;
  end: string;
  interval?: VolumeInterval;
  totals: ChangeTotal[];
  count: number;
  rows: (ChangeAssetRow | ChangeBucketRow)[];
}

export function balanceChangesAnswer(window: AnalyticsWindow, found: BalanceChanges): BalanceChangesAnswer {
  return {
    result: 'success',
    start: fmtTime(window.start),
    end: fmtTime(window.end),
    ...(window.interval !== undefined && { interval: window.interval }),
    totals: found.totals,
    count: found.rows.length,
    rows: found.rows,
  };
}
