import BigNumber from 'bignumber.js';

/**
 * The time formats of the Ripple API. A number is unix seconds (what `moment.unix()` took in the original; a fraction
 * counts as milliseconds and one below a millisecond is cut), a Date is itself. Everything is UTC.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `YYYY-MM-DDTHH:mm:ss.SSSZ` */
function iso(t: number | Date): string {
  return (t instanceof Date ? t : new Date(t * 1000)).toISOString();
}

/** `YYYY-MM-DDTHH:mm:ssZ`, the default time of the API (`smoment().format()`). */
export function fmtTime(t: number | Date): string {
  return `${iso(t).slice(0, 19)}Z`;
}

/** `YYYY-MM-DDTHH:mm:ss+00:00`, the `date` of a transaction (moment's `Z` token on a UTC moment). */
export function fmtTxDate(t: number): string {
  return `${iso(t).slice(0, 19)}+00:00`;
}

/** `YYYY-MMM-DD HH:mm:ss`, the `close_time_human` of a ledger: `2015-Jan-14 17:29:10`. */
export function fmtCloseTimeHuman(t: number): string {
  const s = iso(t);
  return `${s.slice(0, 4)}-${MONTHS[Number(s.slice(5, 7)) - 1]}-${s.slice(8, 10)} ${s.slice(11, 19)}`;
}

/** `YYYY-MM-DDTHH:mm:ss.SSSZ`, the datetimes of a validation. */
export function fmtMillis(t: number | Date): string {
  return iso(t);
}

/** An exchange `rate` or a candle `open`/`high`/`low`/`close`/`vwap`: eight significant digits, `0.004` is `0.0040000000`. */
export function precision8(v: BigNumber.Value): string {
  return new BigNumber(v).toPrecision(8);
}

/**
 * The same object without the keys whose value is `undefined`; `null` stays. Success bodies of the API omit what they
 * do not have, and a CSV must not get a column for it. Surface only: nested objects are the caller's to compact.
 */
export function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
