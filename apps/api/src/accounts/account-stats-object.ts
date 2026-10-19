import { Asset, assetKey, DayRates, nativeValue } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';

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
export type StatsRates = DayRates;

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

export interface ValueInput {
  /** The native currency of the network. */
  native: string;
  /**
   * The rows, oldest first, each with the number of balance changes it had. `day` is what dates the row and says which
   * balances it has (those left on that day or before it, `YYYY-MM-DD`); `valueDay` is the day whose rates value it,
   * `day` itself when it has none. A bucket of a week or a month is dated by its first day and valued on its last.
   */
  days: { day: string; n: number; valueDay?: string }[];
  /**
   * The last balance of every line on every day it changed, and (`day: ''`) before the first row. Days that are no row
   * are here too, for the lines they changed (a day that only paid the fee): their balances are carried to the next row.
   * With buckets, `day` is the start of the bucket the balance was left in.
   */
  balances: StoredBalance[];
  rates: StatsRates;
}

/**
 * The value of an account at the end of each of the days: what it holds in the native currency, plus what it holds of
 * each issued currency over that currency's rate of the day (how many units of it a native coin buys), as
 * `agg_account_balance_changes` had it. A row with a `valueDay` is valued at the rates of that day (a bucket, valued at the
 * end of its last day) and dated by its `day`.
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

  const lines = new Map<string, { balance: BigNumber; asset: Asset }>();
  const apply = (updates: StoredBalance[] | undefined): void => {
    for (const b of updates ?? []) {
      // the issuer of what an account holds is the other side of its trust line; the native currency has none
      const asset: Asset = isNative(b, input.native)
        ? { currency: b.currency }
        : { currency: b.currency, issuer: b.counterparty };
      lines.set(`${b.currency}\u0000${b.counterparty}`, { balance: new BigNumber(b.balance), asset });
    }
  };
  apply(byDay.get(''));

  let next = 0;
  return input.days.map(({ day, n, valueDay }): ValueStats => {
    for (; next < updateDays.length && updateDays[next] <= day; next++) apply(byDay.get(updateDays[next]));

    let total = ZERO;
    for (const { balance, asset } of lines.values()) {
      if (balance.gt(0)) total = total.plus(nativeValue(balance, asset, valueDay ?? day, input.rates, input.native));
    }
    return { date: midnight(day), account_value: total.toString(), balance_change_count: n };
  });
}
