import { badRequest } from './errors';

/**
 * The parsed query string of a request (`req.query`). Parameters are read by the helpers below, which follow the
 * Ripple Data API routes: unknown parameters are ignored and, for a repeated one, the first value wins.
 */
export type Query = Record<string, unknown>;

/**
 * The text of a parameter: the first value of a repeated one. Numbers and booleans count as their text, anything else
 * (a missing param, an object) as missing.
 */
export function first(q: Query, name: string): string | undefined {
  const raw = q[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      return undefined;
  }
}

/** Ripple tests `/true/i` against the text, so `TRUE` and even `xtruex` are true and `1` is not. */
export function bool(q: Query, name: string): boolean {
  return /true/i.test(first(q, name) ?? '');
}

/** `strict` is on unless the text matches `/false/i`. */
export function strictFlag(q: Query): boolean {
  return !/false/i.test(first(q, 'strict') ?? '');
}

/** A flag that is on for any non-empty text (`include_exchanges`), even `0` or `false`. */
export function anyFlag(q: Query, name: string): boolean {
  return (first(q, name) ?? '') !== '';
}

/**
 * The `limit` of a list. Missing, empty, below one or (without `nanError`) not a number gives `def`; more than `max`
 * gives `max`; a decimal is cut to its whole part. With `allowAll`, `all` gives `max`. A text that is not a number
 * answers 400 `nanError` on the routes that have one (`invalid limit`).
 */
export function limitParam(q: Query, o: { def: number; max: number; nanError?: string; allowAll?: boolean }): number {
  const raw = first(q, 'limit');
  if (raw === undefined || raw === '') return o.def;
  if (o.allowAll && raw === 'all') return o.max;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    if (o.nanError !== undefined) throw badRequest(o.nanError);
    return o.def;
  }
  if (n > o.max) return o.max;
  const whole = Math.floor(n);
  return whole < 1 ? o.def : whole;
}

/** The precision of a parsed date, which decides how far its `end` reaches. */
export type Granularity = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'ms';

export interface ParsedDate {
  date: Date;
  granularity: Granularity;
}

// The formats of lib/smoment.js, which parses them with moment in strict mode (the whole text must match) and UTC. They
// exclude each other, so their order does not matter. A zone designator is `Z` (or `z`) or an offset: `+hh`, `+hhmm`,
// `+hh:mm`.
const ZONE = '([Zz]|[+-]\\d\\d(?::?\\d\\d)?)';
const FORMATS: { re: RegExp; granularity: Granularity; zone: boolean }[] = [
  { re: /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)$/, granularity: 'second', zone: false },
  {
    re: new RegExp(`^(\\d{4})-(\\d\\d)-(\\d\\d)T(\\d\\d):(\\d\\d):(\\d\\d)${ZONE}$`),
    granularity: 'second',
    zone: true,
  },
  {
    re: new RegExp(`^(\\d{4})-(\\d\\d)-(\\d\\d)T(\\d\\d):(\\d\\d):(\\d\\d)\\.(\\d{3})${ZONE}$`),
    granularity: 'ms',
    zone: true,
  },
  { re: /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/, granularity: 'minute', zone: false },
  { re: /^(\d{4})-(\d\d)-(\d\d)T(\d\d)$/, granularity: 'hour', zone: false },
  { re: /^(\d{4})-(\d\d)-(\d\d)$/, granularity: 'day', zone: false },
  { re: /^(\d{4})-(\d\d)$/, granularity: 'month', zone: false },
  { re: /^(\d{4})$/, granularity: 'year', zone: false },
  { re: /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)$/, granularity: 'second', zone: false },
  { re: /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d{3})$/, granularity: 'ms', zone: false },
];
const UNIX_SECONDS = /^\d{10}$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month0: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month0];
}

/** Minutes east of UTC for a zone designator; `undefined` where moment rejects it (minutes > 59, over +14:00/-12:00) */
function zoneOffsetMinutes(zone: string): number | undefined {
  if (zone.toUpperCase() === 'Z') return 0;
  const digits = zone.slice(1).replace(':', '');
  const minutes = Number(digits.slice(2) || 0);
  const total = Number(digits.slice(0, 2)) * 60 + minutes;
  if (minutes > 59 || total > (zone[0] === '+' ? 840 : 720)) return undefined;
  return zone[0] === '+' ? total : -total;
}

/**
 * A date in one of the formats Ripple accepts, in UTC, with the granularity of the text: `YYYY`, `YYYY-MM`,
 * `YYYY-MM-DD`, `YYYY-MM-DDTHH`, `…THH:mm`, `…THH:mm:ss`, `…THH:mm:ssZ`, `…THH:mm:ss.SSSZ`, `YYYYMMDDHHmmss`,
 * `YYYYMMDDHHmmssSSS`, and 10 digits as unix seconds. Anything else, including a day or hour that does not exist, is
 * `undefined`.
 */
export function parseDate(raw: string): ParsedDate | undefined {
  if (UNIX_SECONDS.test(raw)) return { date: new Date(Number(raw) * 1000), granularity: 'second' };

  for (const { re, granularity, zone } of FORMATS) {
    const m = re.exec(raw);
    if (!m) continue;

    // every format begins with the digits of year, month, day, hour, minute, second, as far as it goes
    const [year, month = 1, day = 1, hour = 0, minute = 0, second = 0] = m.slice(1, 7).map(Number);
    const ms = granularity === 'ms' ? Number(m[7]) : 0;
    const offset = zone ? zoneOffsetMinutes(m[m.length - 1]) : 0;

    const validDay = month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month - 1);
    // 24:00:00.000 is the midnight that ends the day; any other hour 24 is not a time
    const validTime = minute <= 59 && second <= 59 && (hour <= 23 || (hour === 24 && minute + second + ms === 0));
    if (offset === undefined || !validDay || !validTime) return undefined;

    // `Date.UTC` would read years below 100 as 19xx
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, ms);
    date.setTime(date.getTime() - offset * 60_000);
    return { date, granularity };
  }
  return undefined;
}

/**
 * A date parameter. Missing gives `undefined` (Ripple's own default then applies); text that is not a date answers
 * 400 `error`. With `def`, a missing or empty parameter takes that text instead, like Ripple's `query.start || def`.
 */
export function dateParam(q: Query, name: string, error: string): ParsedDate | undefined;
export function dateParam(q: Query, name: string, error: string, def: string): ParsedDate;
export function dateParam(q: Query, name: string, error: string, def?: string): ParsedDate | undefined {
  let raw = first(q, name);
  if (def !== undefined && (raw === undefined || raw === '')) raw = def;
  if (raw === undefined) return undefined;
  const parsed = parseDate(raw);
  if (!parsed) throw badRequest(error);
  return parsed;
}

/** `moment.add(n, 'month')` in UTC: the day of the month is kept, or cut to the last day of a shorter month. */
function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  result.setUTCDate(Math.min(day, daysInMonth(result.getUTCFullYear(), result.getUTCMonth())));
  return result;
}

const UNIT_MS: Record<'ms' | 'second' | 'minute' | 'hour' | 'day', number> = {
  ms: 1,
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** The end of the period a date names, exclusive: one unit of its granularity on (`end=2015-08-31` is 2015-09-01). */
export function endExclusive(p: ParsedDate): Date {
  switch (p.granularity) {
    case 'year':
      return addMonths(p.date, 12);
    case 'month':
      return addMonths(p.date, 1);
    default:
      return new Date(p.date.getTime() + UNIT_MS[p.granularity]);
  }
}

/**
 * A whole number such as a ledger or sequence: missing or empty gives `undefined`, anything but digits (or more than a
 * double holds exactly) answers 400 `error`.
 */
export function uintParam(q: Query, name: string, error: string): number | undefined {
  const raw = first(q, name);
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) throw badRequest(error);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw badRequest(error);
  return n;
}

/** Which exchanges a list serves, as the `amm` param names them. */
export type AmmFilter = 'include' | 'exclude' | 'only';
export const AMM_FILTERS: readonly AmmFilter[] = ['include', 'exclude', 'only'];

/**
 * `amm`, for the lists of exchanges: a swap against an AMM pool is an exchange too, so `include` (the default, also for a
 * missing or empty param) lists it with the order-book ones, `exclude` lists the order-book exchanges only (what the
 * routes served before AMM) and `only` the swaps. Anything else answers 400 `invalid amm filter - use: include, exclude,
 * only` (the text must be exactly one of the three).
 */
export function ammFilter(q: Query): AmmFilter {
  const raw = first(q, 'amm');
  if (raw === undefined || raw === '') return 'include';
  if (!(AMM_FILTERS as readonly string[]).includes(raw)) {
    throw badRequest(`invalid amm filter - use: ${AMM_FILTERS.join(', ')}`);
  }
  return raw as AmmFilter;
}

/**
 * The condition of an `amm` filter on `exchanges` or `account_exchanges` (both have `amm_account`, empty for an
 * order-book exchange), for the WHERE of the read that is capped, never for a step after the page: a swap is not where
 * the key puts the rows of its pair, so a filter applied to the rows of a page would leave pages short or empty. Both
 * tables carry `INDEX amm_account_set amm_account TYPE set(1024) GRANULARITY 1` (Ruling R-A1), which lets the read skip
 * the granules that hold no swap (for `only`) or nothing but swaps (for `exclude`).
 */
export function ammConditions(filter: AmmFilter): string[] {
  switch (filter) {
    case 'only':
      return ["amm_account != ''"];
    case 'exclude':
      return ["amm_account = ''"];
    default:
      return [];
  }
}
