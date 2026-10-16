import { Asset, assetKey, ratio } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { QUOTIENT_DIGITS, ReportRates } from './account-report-object';
import { DAY_MS } from './account-stats-window';

/**
 * What one UTC day of `GET /v2/accounts/:address/stats/transactions` reads: the transactions the account sent that day
 * (`GROUP BY day`), their number, and how many had each result and each type.
 */
export interface StoredTxDay {
  /** `YYYY-MM-DD` */
  day: string;
  n: number;
  results: Record<string, number>;
  types: Record<string, number>;
}

/** A row of `stats/transactions`, as `agg_account_stats` was served: `date`, then the `d` columns, then the maps. */
export interface TransactionStats {
  /** `YYYY-MM-DDT00:00:00Z` */
  date: string;
  transaction_count: number;
  result: Record<string, number>;
  type: Record<string, number>;
}

/** A row of `stats/value`. */
export interface ValueStats {
  /** `YYYY-MM-DDT00:00:00Z` */
  date: string;
  /** The total of what the account holds, in the native currency: a string. */
  account_value: string;
  /** How many times a balance of the account changed that day, the fee not counted. */
  balance_change_count: number;
}

const midnight = (day: string): string => `${day}T00:00:00Z`;

/** The map with its keys in order, as HBase gave the columns of a family (sorted by name). */
function sorted(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** One day of `stats/transactions` with the keys in the order the original served them. */
export function toTransactionStats(row: StoredTxDay): TransactionStats {
  return {
    date: midnight(row.day),
    transaction_count: row.n,
    result: sorted(row.results),
    type: sorted(row.types),
  };
}

/**
 * The last balance of a line of the account (a currency and the other side of its trust line; `''` for the native
 * currency), as the ledgers left it. `day` is the UTC day it was left on (`YYYY-MM-DD`), or `''` for the balance the
 * line had before the first day that is read: the last one of all the days before it.
 */
export interface StoredBalance {
  day: string;
  currency: string;
  counterparty: string;
  /** Exact, as the ledger had it. */
  balance: string;
}

/** The rate of each asset against the native currency for each day: `assetKey -> YYYY-MM-DD -> units per native coin`. */
export type StatsRates = ReportRates;

const ZERO = new BigNumber(0);

const isNative = (b: StoredBalance, native: string): boolean => b.counterparty === '' && b.currency === native;

/**
 * The issued currencies whose rate the values need: those of the lines that are above 0 at some point, each once, in the
 * order they first appear. The issuer of what an account holds is the other side of its trust line. A balance below 0 is
 * what the account owes (it issued that currency to the counterparty): that is not held, and it is worth 0.
 */
export function ratedAssets(balances: StoredBalance[], native: string): Asset[] {
  const assets = new Map<string, Asset>();
  for (const b of balances) {
    if (isNative(b, native) || b.counterparty === '' || !new BigNumber(b.balance).gt(0)) continue;
    const asset = { currency: b.currency, issuer: b.counterparty };
    assets.set(assetKey(asset), asset);
  }
  return [...assets.values()];
}

/**
 * The most days one call of `RatesService.dailyNativeRates` is given. It refuses more than 3660 (ten years), and the
 * days of one page of values can lie further apart than that.
 */
export const VALUE_DAYS_PER_RATE_CALL = 3000;

/**
 * The runs of days to ask the rates for: `[from, toExclusive)` from the first of the days to the day after the last, a
 * new run when one would be more than `VALUE_DAYS_PER_RATE_CALL` days long. `days` are `YYYY-MM-DD`, oldest first.
 */
export function rateSpans(days: string[]): { from: Date; toExclusive: Date }[] {
  const spans: { from: Date; toExclusive: Date }[] = [];
  let from: number | undefined;
  let last = 0;
  for (const day of days) {
    const at = Date.parse(`${day}T00:00:00Z`);
    if (from !== undefined && (at - from) / DAY_MS >= VALUE_DAYS_PER_RATE_CALL) {
      spans.push({ from: new Date(from), toExclusive: new Date(last + DAY_MS) });
      from = undefined;
    }
    from ??= at;
    last = at;
  }
  if (from !== undefined) spans.push({ from: new Date(from), toExclusive: new Date(last + DAY_MS) });
  return spans;
}

export interface ValueInput {
  /** The native currency of the network. */
  native: string;
  /** The days of the rows, oldest first, each with the number of balance changes it had. */
  days: { day: string; n: number }[];
  /**
   * The last balance of every line on every day it changed, and (`day: ''`) before the first row. Days that are no row
   * are here too, for the lines they changed (a day that only paid the fee): their balances are carried to the next row.
   */
  balances: StoredBalance[];
  rates: StatsRates;
}

/**
 * The value of an account at the end of each of the days: what it holds in the native currency, plus what it holds of
 * each issued currency over that currency's rate of the day (how many units of it a native coin buys), as
 * `agg_account_balance_changes` had it.
 *
 * A line keeps the balance it was left with until a later day changes it, so a row is the whole account, not what
 * changed that day; the lines change from the balances before the first day. The native balance counts as it is. An
 * issued currency counts as its balance over the rate of the day, cut to 17 significant digits as the reports are (the
 * double the original printed), and as 0 where the day has no rate (and for the rate being 0). A balance below 0 (the
 * account issued that currency and owes it) is worth 0: the value is what the account holds. The sum of the parts is
 * exact.
 */
export function toValueStats(input: ValueInput): ValueStats[] {
  const byDay = new Map<string, StoredBalance[]>();
  for (const b of input.balances) {
    const list = byDay.get(b.day);
    if (list) list.push(b);
    else byDay.set(b.day, [b]);
  }
  const updateDays = [...byDay.keys()].filter((day) => day !== '').sort();

  const lines = new Map<string, { balance: BigNumber; asset?: string }>();
  const apply = (updates: StoredBalance[] | undefined): void => {
    for (const b of updates ?? []) {
      const line = isNative(b, input.native)
        ? { balance: new BigNumber(b.balance) }
        : { balance: new BigNumber(b.balance), asset: assetKey({ currency: b.currency, issuer: b.counterparty }) };
      lines.set(`${b.currency}\u0000${b.counterparty}`, line);
    }
  };
  apply(byDay.get(''));

  let next = 0;
  return input.days.map(({ day, n }): ValueStats => {
    for (; next < updateDays.length && updateDays[next] <= day; next++) apply(byDay.get(updateDays[next]));

    let total = ZERO;
    for (const { balance, asset } of lines.values()) {
      if (!balance.gt(0)) continue;
      if (asset === undefined) {
        total = total.plus(balance);
        continue;
      }
      const rate = input.rates.get(asset)?.get(day);
      if (rate?.gt(0)) total = total.plus(ratio(balance, rate).precision(QUOTIENT_DIGITS));
    }
    return { date: midnight(day), account_value: total.toString(), balance_change_count: n };
  });
}
