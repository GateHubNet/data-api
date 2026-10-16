import { ClickHouseService, NetworkProfile, RatesService, Table } from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { paginate } from '../common/pagination';
import { NETWORK_PROFILE } from '../config/api.config';
import {
  ratedAssets,
  rateSpans,
  StatsRates,
  StoredBalance,
  StoredTxDay,
  toTransactionStats,
  toValueStats,
  TransactionStats,
  ValueStats,
} from './account-stats-object';
import { DAY_MS, dayMarker, markerDay, StatsWindow } from './account-stats-window';

/** What `GET /v2/accounts/:address/stats/:family` is asked for; the values are already validated. */
export interface StatsQuery {
  account: string;
  window: StatsWindow;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `markerDay` checks it. */
  marker?: string;
}

/** A page of days in the order asked for, with the marker of the next page when there is one. */
export interface StatsPage<T> {
  rows: T[];
  marker?: string;
}

/** The change type of the fee row of a transaction (`node_index` -1). */
const FEE = 'transaction_cost';

/** `YYYY-MM-DD` of the UTC day of a close time. */
const DAY = "toString(toDate(close_time, 'UTC'))";

/** One day of the list of active days of the value, with the number of balance changes it had. */
interface StoredValueDay {
  day: string;
  n: number;
}

/**
 * The daily stats of an account (`getAccountStats` of the original, which read the rows an outside job had made for each
 * day in `agg_account_stats` and `agg_account_balance_changes`; here a day is worked out from the ledgers when it is
 * asked for).
 *
 * A request becomes one range of ledgers (`LedgerRangeResolver`, from the first day to the day the window stops before,
 * narrowed by the day of the marker), and the narrow tables are read through the primary key of the account in the order
 * of the key, with `LIMIT 1 BY` the rest of the key (no FINAL, so a row written twice counts once):
 *  - `transactions`: `account_transactions`, the transactions the account sent, counted per UTC day with the maps of
 *    their results and types (`sumMap`);
 *  - `value`: the days on which `balance_changes` has a change besides the fee, a page of them; then the last balance of
 *    every line (currency and counterparty) on each of the days read, and before the first, from the same table.
 *
 * A list is a row for each day with activity, in the order of the days; the marker is the day of the last row. A day is
 * the key of the original's rows as well, and a day with nothing in it had no row there either.
 */
@Injectable()
export class AccountStatsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly rates: RatesService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** One page of `stats/transactions`: the days the account sent a transaction, with their counts. */
  async transactions(q: StatsQuery): Promise<StatsPage<TransactionStats>> {
    const range = await this.rangeOf(q);
    if (!range) return { rows: [] };

    // `account` stays in the ORDER BY though it is fixed: ClickHouse then reads the table in the order of its primary key,
    // as `LIMIT 1 BY` needs, and does not sort the account's history (Task 21). `is_initiator` is the sender.
    const found = await this.ch.query<StoredTxDay>(
      `SELECT ${DAY} AS day,
              toUInt32(count()) AS n,
              sumMap(map(toString(result), toUInt32(1))) AS results,
              sumMap(map(toString(tx_type), toUInt32(1))) AS types
         FROM (SELECT close_time, result, tx_type FROM ${Table.AccountTransactions}
                WHERE account = {account:String} AND ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
                  AND is_initiator = 1
                ORDER BY account, ledger_index, tx_index
                LIMIT 1 BY ledger_index, tx_index)
        GROUP BY day
        ORDER BY day ${q.descending ? 'DESC' : 'ASC'}
        LIMIT {fetch:UInt32}`,
      { account: q.account, min: range.min, max: range.max, fetch: q.limit + 1 },
    );

    const page = paginate(found, q.limit, (row) => [row.day]);
    return {
      rows: page.rows.map(toTransactionStats),
      ...(page.marker !== undefined && { marker: dayMarker(page.rows[page.rows.length - 1].day) }),
    };
  }

  /** One page of `stats/value`: the days a balance of the account changed, with the value of the account at their end. */
  async value(q: StatsQuery): Promise<StatsPage<ValueStats>> {
    const range = await this.rangeOf(q);
    if (!range) return { rows: [] };

    const found = await this.ch.query<StoredValueDay>(
      `SELECT ${DAY} AS day, toUInt32(count()) AS n
         FROM (SELECT close_time FROM ${Table.BalanceChanges}
                WHERE account = {account:String} AND ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
                  AND change_type != '${FEE}'
                ORDER BY account, ledger_index, tx_index, node_index
                LIMIT 1 BY ledger_index, tx_index, node_index)
        GROUP BY day
        ORDER BY day ${q.descending ? 'DESC' : 'ASC'}
        LIMIT {fetch:UInt32}`,
      { account: q.account, min: range.min, max: range.max, fetch: q.limit + 1 },
    );
    const page = paginate(found, q.limit, (row) => [row.day]);
    if (page.rows.length === 0) return { rows: [] };

    // the page, oldest day first: the value of a day is the balances after it, whichever way the page is read
    const days = [...page.rows].sort((a, b) => (a.day < b.day ? -1 : 1));
    const balances = await this.balances(q.account, days[0].day, days[days.length - 1].day);
    const rows = toValueStats({
      native: this.profile.nativeCurrency,
      days,
      balances,
      rates: await this.ratesOf(balances, days),
    });

    return {
      rows: q.descending ? rows.reverse() : rows,
      ...(page.marker !== undefined && { marker: dayMarker(page.rows[page.rows.length - 1].day) }),
    };
  }

  /**
   * The ledgers of the days a request asks for, `null` when there are none. The window is cut by the marker first: the
   * next page of an ascending list starts on the day after its day, of a descending one stops before it.
   */
  private async rangeOf(q: StatsQuery): Promise<{ min: number; max: number } | null> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = markerDay(q.marker);
    let { from, to } = q.window;
    if (after !== undefined) {
      const at = Date.parse(`${after}T00:00:00Z`);
      if (q.descending) to = Math.min(to, at);
      else from = Math.max(from, at + DAY_MS);
    }
    if (from >= to) return null;
    return this.ranges.resolve(new Date(from), new Date(to));
  }

  /**
   * The last balance of every line of the account on each day from `first` to `last` (`YYYY-MM-DD`) on which it changed,
   * and (`day: ''`) the last balance of every line before `first`. The last is by the whole key of the change, `(ledger_index,
   * tx_index, node_index)`: the fee row of a transaction (-1) comes before its other changes. The balance is the exact
   * text of the ledger, not its Float64 shadow. The fee rows count here: they move the balance of the native currency.
   *
   * A row written twice has the same key and the same balance, so the last one is the same one: no `LIMIT 1 BY` is
   * needed, and it would hold a key for every change of the history of the account in memory.
   */
  private async balances(account: string, first: string, last: string): Promise<StoredBalance[]> {
    const range = await this.ranges.resolve(
      new Date(`${first}T00:00:00Z`),
      new Date(Date.parse(`${last}T00:00:00Z`) + DAY_MS),
    );
    if (!range) return [];
    return this.ch.query<StoredBalance>(
      `SELECT if(ledger_index < {min:UInt32}, '', ${DAY}) AS day, currency, counterparty,
              argMax(final_balance, (ledger_index, tx_index, node_index)) AS balance
         FROM ${Table.BalanceChanges}
        WHERE account = {account:String} AND ledger_index <= {max:UInt32}
        GROUP BY day, currency, counterparty`,
      { account, min: range.min, max: range.max },
    );
  }

  /** The rate of each issued currency the account holds for each day of the page, 0 days included. */
  private async ratesOf(balances: StoredBalance[], days: StoredValueDay[]): Promise<StatsRates> {
    const assets = ratedAssets(balances, this.profile.nativeCurrency);
    const rates: StatsRates = new Map();
    if (assets.length === 0) return rates;
    for (const span of rateSpans(days.map((d) => d.day))) {
      for (const [asset, byDay] of await this.rates.dailyNativeRates(assets, span.from, span.toExclusive)) {
        rates.set(asset, new Map([...(rates.get(asset) ?? []), ...byDay]));
      }
    }
    return rates;
  }
}
