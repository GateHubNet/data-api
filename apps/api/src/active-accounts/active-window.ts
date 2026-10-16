import { badRequest } from '../common/errors';
import { dateParam, endExclusive, first, ParsedDate, Query } from '../common/params';

/** The periods of `activeAccounts.js`, in the order its error message lists them. */
export const ACTIVE_PERIODS = ['1day', '3day', '7day'] as const;
export type ActivePeriod = (typeof ACTIVE_PERIODS)[number];

/**
 * `period`: `1day` when missing or empty, else one of `ACTIVE_PERIODS` exactly as written (the original compared the
 * text, so `1DAY` is no period) or 400 `invalid period - use: 1day, 3day, 7day`.
 */
export function periodOf(query: Query): ActivePeriod {
  const period = first(query, 'period');
  if (period === undefined || period === '') return '1day';
  if (!(ACTIVE_PERIODS as readonly string[]).includes(period)) {
    throw badRequest(`invalid period - use: ${ACTIVE_PERIODS.join(', ')}`);
  }
  return period as ActivePeriod;
}

/**
 * `date`, with the granularity of what was written; none when missing or empty. Text that is not a date answers 400
 * `invalid date format`. An empty `date` counts as none, as the check of the original did (`req.query.date && ...`); the
 * original then failed on it with a 500, having no end for its scan.
 */
export function dateOf(query: Query): ParsedDate | undefined {
  if ((first(query, 'date') ?? '') === '') return undefined;
  return dateParam(query, 'date', 'invalid date format');
}

const DAY_MS = 86_400_000;
const toSecond = (ms: number): Date => new Date(Math.floor(ms / 1000) * 1000);

/**
 * The exchanges an answer is made of, as the original scanned them: the ledgers that closed in `[start,
 * endExclusive)`, both read to the second, as its row keys (`YYYYMMDDHHmmss`) were.
 *
 * With a `date` the window runs from the date to the date `period` days after it, and then to the end of the unit
 * the date names: the original made its stop row with `hbaseFormatStopRow`, which adds one unit of the granularity of
 * the date to the end. `2015-01-14` with `7day` is therefore `[2015-01-14, 2015-01-22)`, eight days, and
 * `2015-01-14T18:28:40` with `3day` ends one second past the third day. Without a date it is the `period` before now,
 * to the end of the second of now.
 */
export function activeWindow(
  period: ActivePeriod,
  date: ParsedDate | undefined,
  now: number,
): { start: Date; endExclusive: Date } {
  const span = parseInt(period, 10) * DAY_MS;
  if (date === undefined) {
    return {
      start: toSecond(now - span),
      endExclusive: toSecond(endExclusive({ date: new Date(now), granularity: 'second' }).getTime()),
    };
  }
  const end = endExclusive({ date: new Date(date.date.getTime() + span), granularity: date.granularity });
  return { start: toSecond(date.date.getTime()), endExclusive: toSecond(end.getTime()) };
}
