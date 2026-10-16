import { badRequest } from '../common/errors';
import { dateParam, endExclusive, Query as QueryParams } from '../common/params';

/**
 * How far past now a date may lie: the original compared `date - now` with 10 milliseconds, so a client whose clock is
 * a hair ahead is not turned away.
 */
export const FUTURE_TOLERANCE_MS = 10;

/** The moment a rate is as of, and where the period that the client wrote ends (exclusive). */
export interface RateDate {
  date: Date;
  endExclusive: Date;
}

/**
 * The `date` of `/v2/exchange_rates` and `/v2/normalize` (`smoment(req.query.date)` of the original): missing is now, to
 * the second; otherwise one of the formats Ripple takes. The original checked it after the currencies, so this is called
 * after them.
 *  - Text that is not a date answers 400 `invalid date format`. The original left it as `undefined` and failed on
 *    `date.moment` with a 500; that is fixed.
 *  - More than 10 milliseconds ahead of `now` answers 400 `must not be a future date`.
 *
 * `endExclusive` is the end of the period the text names (`2015-01-14` is a day, `2015-01-14T18` an hour): the original
 * read the daily and the latest rate up to the end of it.
 */
export function rateDate(query: QueryParams, now: number = Date.now()): RateDate {
  const parsed = dateParam(query, 'date', 'invalid date format');
  if (parsed === undefined) {
    const second = Math.floor(now / 1000) * 1000;
    return { date: new Date(now), endExclusive: new Date(second + 1000) };
  }
  if (parsed.date.getTime() - now > FUTURE_TOLERANCE_MS) throw badRequest('must not be a future date');
  return { date: parsed.date, endExclusive: endExclusive(parsed) };
}
