import {
  ClickHouseService,
  DailyRates,
  DAY_GROUPS_EPOCH,
  firstChangeDay,
  NetworkProfile,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { paginate } from '../common/pagination';
import { NETWORK_PROFILE } from '../config/api.config';
import { bucketStart, dayText, MAX_DAY_MS, nextBucket, VolumeInterval } from '../network/volume-buckets';
import { AccountDayGroupsService } from './account-day-groups.service';
import {
  ratedAssets,
  StatsRates,
  StoredBalance,
  StoredTxDay,
  toTransactionStats,
  toValueStats,
  TransactionStats,
  ValueStats,
} from './account-stats-object';
import { DAY_MS, dayMarker, markerDay, StatsWindow } from './account-stats-window';
import { bucketOfDaySql, bucketSpan, BucketSpan, bucketStarts, narrowSpan } from './analytics-window';

/** What `GET /v2/accounts/:address/stats/:family` is asked for; the values are already validated. */
export interface StatsQuery {
  account: string;
  window: StatsWindow;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `markerDay` checks it. */
  marker?: string;
  /** Rows per bucket of this size instead of per active day; without it the days are read as they always were. */
  interval?: VolumeInterval;
  /** The time of the request, unix ms: the current bucket is valued on its day. */
  now: number;
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

/** One bucket of `stats/value` with an interval: its label is its first day, its rates are those of `valueDay`. */
interface ValueBucket {
  day: string;
  n: number;
  valueDay: string;
}

/**
 * What the day groups of the lines of an account give for the buckets of a page of `value`: for each bucket (`label`, its
 * first day, or `''` for everything before the page) the balance each kept line was left with, and the number of balance
 * changes of the bucket. A line that is not kept is not a row of its own: its changes are counted in the row with no line
 * (`currency` and `counterparty` of `''`).
 */
interface StoredLineBucket {
  label: string;
  currency: string;
  counterparty: string;
  balance: string;
  changes: number | string;
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
 *
 * With an `interval` the rows are buckets (a day, a week from Monday, a calendar month), read through the day groups of the
 * account (`AccountDayGroupsService`: one group per UTC day and group key, from its rollups where it has them and from its
 * own key ranges elsewhere), and `value` is valued with `DailyRates`. A bucket is a row when its START is at or after the
 * start of the window and before its end; its date is its start, and the marker is that day.
 */
@Injectable()
export class AccountStatsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly rates: DailyRates,
    private readonly dayGroups: AccountDayGroupsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /** One page of `stats/transactions`: the days the account sent a transaction, with their counts. */
  async transactions(q: StatsQuery): Promise<StatsPage<TransactionStats>> {
    if (q.interval !== undefined) return this.transactionsPerBucket(q, q.interval);
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
    if (q.interval !== undefined) return this.valuePerBucket(q, q.interval);
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
      rates: await this.ratesOf(
        balances,
        days.map((d) => d.day),
      ),
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

  /** The rate of each issued currency the account holds for each of the days (`YYYY-MM-DD`), 0 days included. */
  private async ratesOf(balances: StoredBalance[], days: string[]): Promise<StatsRates> {
    const assets = ratedAssets(balances, this.profile.nativeCurrency);
    return assets.length === 0 ? new Map() : this.rates.rates(assets, days);
  }

  // -- with an interval ---------------------------------------------------------------------------------------------

  /**
   * One page of `stats/transactions` per bucket: the buckets that start in the window and in which the account sent a
   * transaction, with the counts of the whole bucket, from the `txs` day groups of the days of those buckets. The marker
   * narrows the buckets read (the next page of an ascending list starts with the bucket after the one of its day).
   */
  private async transactionsPerBucket(q: StatsQuery, interval: VolumeInterval): Promise<StatsPage<TransactionStats>> {
    const span = this.spanOf(q, interval);
    if (!span) return { rows: [] };

    // the days of the buckets, whole: the first bucket's first day to the last bucket's last. Nothing is stored before the
    // epoch of the day groups, and no day is read that a `Date` cannot hold
    const source = await this.dayGroups.source(
      'txs',
      q.account,
      dayText(Math.max(span.first, Date.parse(DAY_GROUPS_EPOCH))),
      dayText(Math.min(nextBucket(span.last, interval) - DAY_MS, MAX_DAY_MS)),
    );
    if (!source) return { rows: [] };

    // `bucket` and not `day`, which the groups have as a column. The counts of the maps are UInt32 as the days' are
    const found = await this.ch.query<{
      bucket: string;
      n: number;
      results: Record<string, number>;
      types: Record<string, number>;
    }>(
      `SELECT toString(${bucketOfDaySql(interval)}) AS bucket,
              toUInt32(sum(count)) AS n,
              sumMap(map(toString(result), toUInt32(count))) AS results,
              sumMap(map(toString(tx_type), toUInt32(count))) AS types
         FROM (${source.sql})
        GROUP BY bucket
        ORDER BY bucket ${q.descending ? 'DESC' : 'ASC'}
        LIMIT {fetch:UInt32}`,
      { ...source.params, fetch: q.limit + 1 },
    );

    const page = paginate(found, q.limit, (row) => [row.bucket]);
    return {
      rows: page.rows.map((row) =>
        toTransactionStats({ day: row.bucket, n: row.n, results: row.results, types: row.types }),
      ),
      ...(page.marker !== undefined && { marker: dayMarker(page.rows[page.rows.length - 1].bucket) }),
    };
  }

  /**
   * One page of `stats/value` per bucket: a row for every bucket from the first one in which the account had a balance (the
   * bucket of its first change, or the first that starts in the window when it changed before) to the last that starts
   * before the end of the window, active or not.
   *
   * (1) The buckets of the page, by arithmetic: the span of the window, narrowed by the marker, from the first change of the
   * account. (2) A bucket is valued at the end of its last day, or today for one that has not ended. (3) One read of the
   * `lines` day groups from the epoch to the last day valued gives, for each line, the balance it was left with in each
   * bucket (the days before the page's first bucket are one group, `''`) and the number of changes of each bucket; it keeps
   * only the native line and the lines that are above 0 at some bucket end, since the others are worth 0 at every one.
   * (4) The buckets are valued with `toValueStats` and the rates of their value days.
   */
  private async valuePerBucket(q: StatsQuery, interval: VolumeInterval): Promise<StatsPage<ValueStats>> {
    const span = this.spanOf(q, interval);
    if (!span) return { rows: [] };
    const firstDay = await firstChangeDay(this.ch, q.account);
    if (firstDay === undefined) return { rows: [] };
    // a bucket before the one of the first change is not a row: the account had nothing in it
    const buckets = this.pageOfBuckets(
      { ...span, first: Math.max(span.first, bucketStartOf(firstDay, interval)) },
      q,
      interval,
    );
    if (buckets.starts.length === 0) return { rows: [] };

    // a bucket is valued at the end of its last day, or on today's rates when it has not ended (or has not begun)
    const today = Math.floor(q.now / DAY_MS) * DAY_MS;
    // oldest first, whichever way the page is listed
    const items: ValueBucket[] = [...buckets.starts]
      .sort((a, b) => a - b)
      .map((start) => ({
        day: dayText(start),
        n: 0,
        valueDay: dayText(Math.min(nextBucket(start, interval) - DAY_MS, today)),
      }));

    const lines = await this.lineBuckets(q.account, interval, items[0].day, items[items.length - 1].valueDay);
    const changes = new Map<string, number>();
    const balances: StoredBalance[] = [];
    for (const row of lines) {
      changes.set(row.label, (changes.get(row.label) ?? 0) + Number(row.changes));
      if (row.currency !== '') {
        balances.push({ day: row.label, currency: row.currency, counterparty: row.counterparty, balance: row.balance });
      }
    }
    const days = items.map((item) => ({ ...item, n: changes.get(item.day) ?? 0 }));
    const rows = toValueStats({
      native: this.profile.nativeCurrency,
      days,
      balances,
      rates: await this.ratesOf(balances, [...new Set(items.map((item) => item.valueDay))]),
    });

    return {
      rows: q.descending ? rows.reverse() : rows,
      ...(buckets.marker !== undefined && { marker: buckets.marker }),
    };
  }

  /**
   * The buckets a request asks for before any marker: those that start in its window. The marker is checked first (a
   * marker that is none of ours is the client's mistake, whatever the window holds) and then narrows them.
   */
  private spanOf(q: StatsQuery, interval: VolumeInterval): BucketSpan | undefined {
    const after = markerDay(q.marker);
    const span = bucketSpan(interval, q.window.from, q.window.to);
    return span && after !== undefined
      ? narrowSpan(span, interval, Date.parse(`${after}T00:00:00Z`), q.descending)
      : span;
  }

  /** The starts of the buckets of one page of a span, in the order asked for, and the marker of the next page. */
  private pageOfBuckets(
    span: BucketSpan,
    q: StatsQuery,
    interval: VolumeInterval,
  ): { starts: number[]; marker?: string } {
    // one more than the page: it only tells whether there is a next page
    const starts = bucketStarts(span, interval, q.descending, q.limit + 1);
    if (starts.length <= q.limit) return { starts };
    const page = starts.slice(0, q.limit);
    return { starts: page, marker: dayMarker(dayText(page[page.length - 1])) };
  }

  /**
   * The `lines` day groups of the account from the epoch to `lastDay` (`YYYY-MM-DD`), as `StoredLineBucket`s of the buckets
   * from `firstBucket` on (a day before it is labelled `''`). A line's balance in a bucket is the `end_balance` of its last
   * day in it; the rows of a day have the same on every group of the line. The line is kept when it is the native one or
   * its balance is above 0 in some bucket (or before the page): the rest are not rows, and the number of their changes is
   * summed into the row of no line. The changes of a bucket are those besides the fee. Reading the groups once costs the
   * account's key range once, however many buckets there are.
   */
  private async lineBuckets(
    account: string,
    interval: VolumeInterval,
    firstBucket: string,
    lastDay: string,
  ): Promise<StoredLineBucket[]> {
    const source = await this.dayGroups.source('lines', account, DAY_GROUPS_EPOCH, lastDay);
    if (!source) return [];
    return this.ch.query<StoredLineBucket>(
      `SELECT label,
              if(kept, cur, '') AS currency,
              if(kept, cp, '') AS counterparty,
              any(if(kept, bal, '')) AS balance,
              toUInt64(sum(chg)) AS changes
         FROM (SELECT label, cur, cp, bal, chg,
                      ((cp = '' AND cur = {native:String}) OR max(toFloat64OrZero(bal)) OVER (PARTITION BY cur, cp) > 0) AS kept
                 FROM (SELECT if(day < {first_bucket:Date}, '', toString(${bucketOfDaySql(interval)})) AS label,
                              currency AS cur, counterparty AS cp,
                              argMax(end_balance, day) AS bal,
                              sumIf(count, change_type != '${FEE}') AS chg
                         FROM (${source.sql})
                        GROUP BY label, cur, cp))
        GROUP BY label, currency, counterparty`,
      { ...source.params, first_bucket: firstBucket, native: this.profile.nativeCurrency },
    );
  }
}

/** The start (unix ms) of the bucket a day (`YYYY-MM-DD`) is in. */
function bucketStartOf(day: string, interval: VolumeInterval): number {
  return bucketStart(Date.parse(`${day}T00:00:00Z`), interval);
}
