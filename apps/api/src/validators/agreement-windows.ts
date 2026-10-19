import BigNumber from 'bignumber.js';

/** The sentinel of an hour in `validator_agreement_hourly` (its newest version): what decides whether a window is whole. */
export interface HourSentinel {
  /** The hour was computed from complete data and is never recomputed. */
  readonly final: boolean;
  /** The ledgers of the hour that were observed (recorded by enough of the UNL): the ones validators are held to. */
  readonly ledgers: number;
  /** The validated ledgers that were left out because too few validations of them were recorded. */
  readonly unobserved: number;
}

/** A tracked validator's row of one hour (the newest version of the hour). */
export interface KeyHour {
  readonly agreed: number;
  readonly missed: number;
  readonly partial: number;
}

/** A window of agreement (spec 2.5, "Windows"). Keys in this order. Read-only: the windows are part of the shared directory. */
export interface AgreementWindow {
  readonly missed: number;
  /** The ledgers the validator was held to: agreed plus missed. */
  readonly total: number;
  /** `(total - missed) / total` to 4 decimals, half up, as text. Absent at a total of 0. */
  readonly score?: string;
  readonly incomplete: boolean;
  readonly partial: number;
}

/** A UTC day of agreement: `date` is `YYYY-MM-DD`. */
export interface DailyAgreement extends AgreementWindow {
  readonly date: string;
}

export const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86_400;
/** The hours of the 24 h and of the 30 d window. */
export const HOURS_24H = 24;
export const HOURS_30D = 720;
/** The days of `daily`. */
export const DAILY_DAYS = 30;

/**
 * A validator before any hour is final: nothing is known, so the window is incomplete. Every such entry of the shared directory
 * holds this one object, so it is frozen.
 */
export const NO_AGREEMENT: AgreementWindow = Object.freeze({ missed: 0, total: 0, incomplete: true, partial: 0 });

/**
 * The window `[from, toExclusive)` of a validator, `from` and `toExclusive` being hours in unix seconds. The figures are the
 * sums of the rows of its hours: `total` = Σ (agreed + missed), `missed`, `partial`. `score` is `(total - missed) / total`
 * to 4 decimals, half up (BigNumber, so `0.12345` is `0.1235`), absent when the total is 0.
 *
 * The window is `incomplete` when an hour of it has no sentinel or one that is not final, or when the ledgers left out as
 * unobserved are more than 1 % of the validated ledgers of the window, observed and unobserved together (a few of them after a
 * collector reconnect do not flag a month). The test is in integers: `unobserved * 100 > observed + unobserved`.
 */
export function agreementWindow(
  sentinels: ReadonlyMap<number, HourSentinel>,
  rows: ReadonlyMap<number, KeyHour>,
  from: number,
  toExclusive: number,
): AgreementWindow {
  let missed = 0;
  let total = 0;
  let partial = 0;
  let incomplete = false;
  let observed = 0;
  let unobserved = 0;
  for (let hour = from; hour < toExclusive; hour += HOUR_SECONDS) {
    const sentinel = sentinels.get(hour);
    if (sentinel === undefined || !sentinel.final) incomplete = true;
    if (sentinel !== undefined) {
      observed += sentinel.ledgers;
      unobserved += sentinel.unobserved;
    }
    const row = rows.get(hour);
    if (row !== undefined) {
      total += row.agreed + row.missed;
      missed += row.missed;
      partial += row.partial;
    }
  }
  if (unobserved * 100 > observed + unobserved) incomplete = true;
  return {
    missed,
    total,
    ...(total > 0 && { score: new BigNumber(total - missed).div(total).toFixed(4, BigNumber.ROUND_HALF_UP) }),
    incomplete,
    partial,
  };
}

/** The newest hour with a final sentinel, in unix seconds. */
export function newestFinalHour(sentinels: ReadonlyMap<number, HourSentinel>): number | undefined {
  let newest: number | undefined;
  for (const [hour, sentinel] of sentinels) {
    if (sentinel.final && (newest === undefined || hour > newest)) newest = hour;
  }
  return newest;
}

/**
 * The first hour a directory reads (ruling P6): the first hour of the 30-day window, the newest final hour minus 719 hours.
 * It is not the start of a UTC day. The 30 daily entries lie inside the range, because the day of the newest hour starts at
 * most 23 hours before it, and the day 29 days before at most 719.
 */
export function agreementReadFrom(newestFinal: number): number {
  return newestFinal - (HOURS_30D - 1) * HOUR_SECONDS;
}

/** The windows of a validator: the three of the specification and the 30 UTC days. */
export interface AgreementWindows {
  readonly agreement1h: AgreementWindow;
  readonly agreement24h: AgreementWindow;
  readonly agreement30d: AgreementWindow;
  /** The 30 UTC days ending with the day of the newest final hour, oldest first. */
  readonly daily: readonly DailyAgreement[];
}

/**
 * The windows of one validator at the newest final hour `newestFinal`: 1 h is that hour, 24 h the 24 hours ending with it, 30 d
 * the 720 hours ending with it; `daily` the 30 UTC days ending with its day, each of its 24 hours (the day of the newest hour
 * has only the hours up to it, so it is incomplete unless that is the last hour of the day).
 */
export function agreementWindows(
  sentinels: ReadonlyMap<number, HourSentinel>,
  rows: ReadonlyMap<number, KeyHour>,
  newestFinal: number,
): AgreementWindows {
  const end = newestFinal + HOUR_SECONDS;
  const today = Math.floor(newestFinal / DAY_SECONDS) * DAY_SECONDS;
  const daily: DailyAgreement[] = [];
  for (let back = DAILY_DAYS - 1; back >= 0; back--) {
    const from = today - back * DAY_SECONDS;
    daily.push({
      date: new Date(from * 1000).toISOString().slice(0, 10),
      ...agreementWindow(sentinels, rows, from, from + DAY_SECONDS),
    });
  }
  return {
    agreement1h: agreementWindow(sentinels, rows, newestFinal, end),
    agreement24h: agreementWindow(sentinels, rows, end - HOURS_24H * HOUR_SECONDS, end),
    agreement30d: agreementWindow(sentinels, rows, end - HOURS_30D * HOUR_SECONDS, end),
    daily,
  };
}
