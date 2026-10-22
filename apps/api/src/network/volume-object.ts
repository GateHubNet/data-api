import type { Asset, VolumeMetric } from '@gatehub/data-api-shared';
import { assetOfColumns } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { fmtTime, precision8 } from '../common/format';

/**
 * The rows of `/v2/network/exchange_volume` and `/v2/network/payment_volume`, as the original served them
 * (`api/routes/network/getMetric.js` and `lib/hbase/hbase-thrift/data.js getMetric`), and of `/v2/network/amm_volume`, which
 * has the same rows with a component of its own (a pool).
 *
 * The key order of the objects is the one of the original, which came of how the object was built: the columns of an
 * HBase row come sorted (`components, count, endTime, exchange, exchangeRate, startTime, total`), the reassignments of
 * `handleResponse` and `formatRows` keep their place, and what `formatRows` adds comes after, in the order it adds it: the row
 * is `components, count, exchange, total, exchange_rate, start_time, end_time`; a trade component is the object the
 * aggregation script built, `count, rate, amount, base, counter, converted_amount`, and a payment component
 * `currency, issuer, amount, count, rate, converted_amount` (`issuer` is absent for the native currency, which has none). An AMM
 * component has no original; its keys are `amm_account, base, counter, count, amount, rate, converted_amount, fees_est?`, the
 * sides formatted as a trade component formats them. `fees_est` (the estimated fees of a pool, converted like `converted_amount`)
 * is there on the live day row only, where the row has the sum of them after `end_time` (D2b.3, D9).
 */

export type VolumeAsset = { currency: string; issuer?: string };

export interface TradeComponent {
  count: number;
  rate: string;
  amount: string;
  base: VolumeAsset;
  counter: VolumeAsset;
  converted_amount: string;
}

export interface AmmComponent {
  /** The pool. */
  amm_account: string;
  base: VolumeAsset;
  counter: VolumeAsset;
  count: number;
  amount: string;
  rate: string;
  converted_amount: string;
  /** The estimated trading fees of the pool in the window, in the unit of `converted_amount`: the live day row only. */
  fees_est?: string;
}

export interface PaymentComponent {
  currency: string;
  issuer?: string;
  amount: string;
  count: number;
  rate: string;
  converted_amount: string;
}

export interface VolumeRow {
  components: (TradeComponent | PaymentComponent | AmmComponent)[];
  count: number;
  exchange: VolumeAsset;
  total: string;
  exchange_rate: string;
  start_time: string;
  end_time?: string;
  /** The sum of the `fees_est` of the components: there when the row lists a component and every listed one has it. */
  fees_est?: string;
}

/** The columns of a stored set that the API reads (see `volume_daily`, `volume_live`). */
export interface StoredVolumeRow {
  component: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  amount: string;
  /** A 64-bit column may come back as text. */
  count: number | string;
  converted_f: number | string;
  /** Only the live read selects it: NULL when the estimate is not known. A Float64 may come back as text. */
  fees_est_f?: number | string | null;
}

/** One component of a bucket, the days of it added up. `converted` is in the native currency. */
export interface VolumePart {
  component: string;
  base: Asset;
  /** The other side of a trade market; a payment component is a currency alone. */
  counter?: Asset;
  amount: BigNumber;
  count: number;
  converted: number;
  /**
   * The estimated fees in the native currency (D2b.3). Absent when the rows were read without them; `null` when they are not
   * known, which a part of several rows is when any of them is.
   */
  feesEst?: number | null;
}

/** A row to be: the parts of a bucket (a live period, a day, a week, a month) from `start` to `end`, exclusive (unix seconds). */
export interface VolumeBucket {
  start: number;
  /** Where the bucket ends, exclusive: the end of a live period, the start of the next day, week or month. */
  end?: number;
  parts: VolumePart[];
}

/** The currency the amounts are shown in, and how many of it one native coin buys (0 when that cannot be told). */
export interface DisplayCurrency {
  asset: Asset;
  rate: BigNumber;
}

/** `{currency}` or `{currency, issuer}`: the key `issuer` is absent for the native currency. */
const volumeAsset = (a: Asset): VolumeAsset =>
  a.issuer ? { currency: a.currency, issuer: a.issuer } : { currency: a.currency };

/**
 * Adds the stored rows of the days of one bucket (a day, a week, a month), part by part: the amounts exactly, the counts and
 * the converted amounts. The sentinel row of a set (component empty) is no part. A component whose sides were swapped on
 * another day (the trade volume converts through the counter leg when the base has no rate, and then its amount is of the
 * other currency) is two parts, because the amounts are of different currencies.
 *
 * A row with no converted amount (a currency that had payments but no rate that day) is not added to the component: it would
 * put an amount in the sum that nothing was converted for, and `amount / converted_amount` would no longer be a rate. Such
 * rows are parts of their own (never listed, see `toVolumeRow`), which keeps their payments in the `count` of the row only,
 * as a daily set, which does not list them either, has them.
 *
 * The estimated fees of a live row (`fees_est_f`, D2b.3) are a part's too, when the rows were read with them: `null` is a row
 * whose estimate is not known, and a part of several rows is not known if any is (part of the fees is never shown as all).
 */
export function sumParts(rows: readonly StoredVolumeRow[]): VolumePart[] {
  const parts = new Map<string, VolumePart>();
  for (const row of rows) {
    if (row.component === '') continue;
    const base = assetOfColumns(row.base_currency, row.base_issuer);
    const counter = row.counter_currency === '' ? undefined : assetOfColumns(row.counter_currency, row.counter_issuer);
    // rows with a converted amount and rows without one are summed apart
    const id = [
      row.component,
      row.base_currency,
      row.base_issuer,
      row.counter_currency,
      row.counter_issuer,
      Number(row.converted_f) > 0 ? 'converted' : 'unconverted',
    ].join('\u0000');
    // undefined: the rows were read without the column; null: the estimate is not known
    const fees = row.fees_est_f === undefined ? undefined : row.fees_est_f === null ? null : Number(row.fees_est_f);
    const found = parts.get(id);
    if (found) {
      found.amount = found.amount.plus(row.amount);
      found.count += Number(row.count);
      found.converted += Number(row.converted_f);
      if (found.feesEst !== undefined || fees !== undefined) {
        found.feesEst = found.feesEst == null || fees == null ? null : found.feesEst + fees;
      }
    } else {
      parts.set(id, {
        component: row.component,
        base,
        ...(counter && { counter }),
        amount: new BigNumber(row.amount),
        count: Number(row.count),
        converted: Number(row.converted_f),
        ...(fees !== undefined && { feesEst: fees }),
      });
    }
  }
  return [...parts.values()];
}

/** The largest converted amount first; the same amount in the order of the component ids, so that the order is the same every time. */
function byConverted(a: VolumePart, b: VolumePart): number {
  return b.converted - a.converted || (a.component < b.component ? -1 : a.component > b.component ? 1 : 0);
}

/** `c.rate ? Number(c.rate).toPrecision(8) : '0'` of the original. */
function rateText(rate: number): string {
  return rate !== 0 && Number.isFinite(rate) ? precision8(rate) : '0';
}

/**
 * The row of a bucket. `native` is the currency of the network (the exchange of the row unless a display currency is
 * given). With a `display` currency the row is converted as the original did: `total *= X`, `exchange_rate = X`,
 * `rate /= X` (0 when X is 0), `converted_amount *= X`, where X is `display.rate`.
 *
 * A part with a converted amount of 0 (a currency with payments but no rate) is not a component, but its payments are in the
 * `count`, as in the original. A component's rate is how many units of its currency one native coin buys:
 * `amount / converted_amount`.
 */
export function toVolumeRow(
  metric: VolumeMetric,
  bucket: VolumeBucket,
  native: string,
  display?: DisplayCurrency,
): VolumeRow {
  const x = display ? display.rate.toNumber() : 1;
  const listed = bucket.parts.filter((p) => p.converted > 0).sort(byConverted);

  const components = listed.map((p): TradeComponent | PaymentComponent | AmmComponent => {
    const rate = p.converted > 0 ? p.amount.toNumber() / p.converted : 0;
    const shownRate = display ? (x ? rate / x : 0) : rate;
    const rateOut = rateText(shownRate);
    const amount = p.amount.toString();
    const converted = String(p.converted * x);
    if (metric === 'amm_volume') {
      return {
        amm_account: p.component,
        base: volumeAsset(p.base),
        counter: volumeAsset(p.counter as Asset),
        count: p.count,
        amount,
        rate: rateOut,
        converted_amount: converted,
        ...(p.feesEst != null && { fees_est: String(p.feesEst * x) }),
      };
    }
    if (metric === 'trade_volume') {
      return {
        count: p.count,
        rate: rateOut,
        amount,
        base: volumeAsset(p.base),
        counter: volumeAsset(p.counter as Asset),
        converted_amount: converted,
      };
    }
    return {
      currency: p.base.currency,
      ...(p.base.issuer && { issuer: p.base.issuer }),
      amount,
      count: p.count,
      rate: rateOut,
      converted_amount: converted,
    };
  });

  const total = listed.reduce((sum, p) => sum + p.converted, 0);
  // D9: the row has the sum of the estimates when it lists a component and every listed one has its estimate
  const feesEst =
    metric === 'amm_volume' && listed.length > 0 && listed.every((p) => p.feesEst != null)
      ? listed.reduce((sum, p) => sum + (p.feesEst as number), 0)
      : undefined;
  return {
    components,
    count: bucket.parts.reduce((sum, p) => sum + p.count, 0),
    exchange: display ? volumeAsset(display.asset) : { currency: native },
    total: String(total * x),
    exchange_rate: precision8(display ? display.rate : 1),
    start_time: fmtTime(bucket.start),
    ...(bucket.end !== undefined && { end_time: fmtTime(bucket.end) }),
    ...(feesEst !== undefined && { fees_est: String(feesEst * x) }),
  };
}
