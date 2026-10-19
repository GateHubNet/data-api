import {
  ClickHouseService,
  DailyRates,
  DAY_GROUPS_EPOCH,
  DayGroupsSource,
  mergedExactSum,
  NetworkProfile,
  newestValidRateDay,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { NETWORK_PROFILE } from '../config/api.config';
import { bucketStart, dayText, MAX_DAY_MS, VolumeInterval } from '../network/volume-buckets';
import {
  BalanceChanges,
  BalanceLine,
  BalanceRow,
  ratedChangeAssets,
  StoredChangeGroup,
  StoredLine,
  StoredLineBucket,
  toBalanceChanges,
  toBalanceLines,
  toBalanceRows,
} from './account-analytics-object';
import { AccountDayGroupsService } from './account-day-groups.service';
import { AnalyticsWindow, bucketOfDaySql } from './analytics-window';

/** The last day a ClickHouse `Date` holds, `YYYY-MM-DD`. */
const MAX_DAY = dayText(MAX_DAY_MS);

/** What `GET /v2/accounts/:address/analytics/balances` is asked for; the values are already validated. */
export interface BalancesQuery {
  account: string;
  window: AnalyticsWindow;
  /** Only the lines of this currency (upper case). */
  currency?: string;
  /** Only the lines with this account. */
  counterparty?: string;
  /** How many lines. */
  limit: number;
  /** The time of the request, unix ms: a bucket that has not begun has no row. */
  now: number;
}

export interface BalancesResult {
  /** How many lines the account has in the window, after the filters; `lines` are the first `limit` of them. */
  linesTotal: number;
  lines: BalanceLine[];
  rows: BalanceRow[];
}

/** What `GET /v2/accounts/:address/analytics/balance_changes` is asked for; the values are already validated. */
export interface BalanceChangesQuery {
  account: string;
  window: AnalyticsWindow;
}

/** What the read of the groups of `balance_changes` gives: a `StoredChangeGroup` under the names of its columns. */
interface ChangeGroupRow {
  day_text: string;
  change_type: string;
  currency: string;
  issuer: string;
  changes: number | string;
  in_exact: string;
  out_exact: string;
  unfit_changes: number | string;
  in_float: number;
  out_float: number;
}

/** What the ranking of the lines reads: a line, its balance at the window's end, and how many lines there are. */
interface RankedLine extends StoredLine {
  lines_total: number | string;
}

/**
 * The analytics of an account that read its balance changes: `balances` (the history of the balance of each line) and
 * `balance_changes` (the sums by change type, with their values).
 *
 * Both read the `lines` day groups of the account (`AccountDayGroupsService`: one group per UTC day, line and change type,
 * from its rollups where it has them and from its own key ranges elsewhere), so the answer is the same with or without a
 * rollup. Values are made with `DailyRates` and `nativeValue`.
 */
@Injectable()
export class AccountAnalyticsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly rates: DailyRates,
    private readonly dayGroups: AccountDayGroupsService,
    @Inject(NETWORK_PROFILE) private readonly profile: NetworkProfile,
  ) {}

  /**
   * The balance history: the lines of the account that changed up to the end of the window, ranked and cut to `limit`, and for
   * each of them a row per bucket.
   *
   * (1) One read of the day groups from the epoch to the window's end ranks the lines in SQL: the last balance of each line
   * (the `end_balance` of its last day), after the filters, the native line first, then the lines with a rate by |balance| over
   * the rate, then the others by |balance|, then by the key. Only the first `limit` leave the database, with the number of
   * all of them. (2) One read of the same groups for the chosen lines gives the last balance of each in each bucket of the
   * window, and the last before it (`label` of `''`). (3) The carry-forward is done here: a bucket without a change has the
   * balance before it.
   *
   * A bucket that has not begun has no row, so the rows stop at the bucket that holds now, whatever the end of the window.
   */
  async balances(q: BalancesQuery): Promise<BalancesResult> {
    const w = q.window;
    const none: BalancesResult = { linesTotal: 0, lines: [], rows: [] };
    // nothing is stored before the epoch of the day groups, and no day is read that a `Date` cannot hold
    if (w.empty || w.throughDay < DAY_GROUPS_EPOCH) return none;
    const through = w.throughDay > MAX_DAY ? MAX_DAY : w.throughDay;
    const source = await this.dayGroups.source('lines', q.account, DAY_GROUPS_EPOCH, through);
    if (!source) return none;

    const { lines, total } = await this.rankLines(q, source, through);
    if (lines.length === 0) return none;

    const begun = w.buckets.filter((start) => start <= q.now);
    const rows =
      begun.length === 0
        ? []
        : toBalanceRows(lines, await this.lineBuckets(q, source, lines, w.interval ?? 'day'), begun);
    return { linesTotal: total, lines: toBalanceLines(lines), rows };
  }

  /**
   * The lines of the account with a change up to `through`, after the filters, in the order of the answer, the first
   * `q.limit` of them, and how many lines there are.
   *
   * The rate of a line is that of its asset `(currency, counterparty)` on the newest valid day of `native_rates_daily` at or
   * before `through` (a day whose newest sentinel is not stale and has the current config version): the rows of that
   * set, each once. The ranking uses the Float64 shadow of the rate and of the balance.
   */
  private async rankLines(
    q: BalancesQuery,
    source: DayGroupsSource,
    through: string,
  ): Promise<{ lines: StoredLine[]; total: number }> {
    const rateDay = await newestValidRateDay(this.ch, through);
    const filters = [
      ...(q.currency !== undefined ? ['currency = {currency:String}'] : []),
      ...(q.counterparty !== undefined ? ['counterparty = {counterparty:String}'] : []),
    ];
    const params: Record<string, unknown> = {
      ...source.params,
      native: this.profile.nativeCurrency,
      limit: q.limit,
      ...(q.currency !== undefined && { currency: q.currency }),
      ...(q.counterparty !== undefined && { counterparty: q.counterparty }),
    };
    let rateJoin = '';
    if (rateDay !== undefined) {
      params.rate_day = rateDay.day;
      params.rate_version = rateDay.version;
      // each asset once (`LIMIT 1 BY`): a row written twice would be two lines
      rateJoin = `LEFT JOIN (SELECT currency, issuer, rate_f
                               FROM ${Table.NativeRatesDaily}
                              WHERE day = {rate_day:Date} AND version = {rate_version:UInt64} AND rate_f > 0
                              ORDER BY currency, issuer, day
                              LIMIT 1 BY currency, issuer) AS r
                    ON l.currency = r.currency AND l.counterparty = r.issuer`;
    }

    const found = await this.ch.query<RankedLine>(
      `SELECT currency, counterparty, balance, lines_total
         FROM (SELECT l.currency AS currency, l.counterparty AS counterparty, l.balance AS balance,
                      (l.counterparty = '' AND l.currency = {native:String}) AS is_native,
                      ${rateDay === undefined ? '0.0' : 'ifNull(r.rate_f, 0)'} AS rate,
                      abs(toFloat64OrZero(l.balance)) AS magnitude,
                      count() OVER () AS lines_total
                 FROM (SELECT currency, counterparty, argMax(end_balance, day) AS balance
                         FROM (${source.sql})
                        ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
                        GROUP BY currency, counterparty) AS l
                 ${rateJoin})
        ORDER BY is_native DESC, rate > 0 DESC, if(rate > 0, magnitude / rate, magnitude) DESC, currency, counterparty
        LIMIT {limit:UInt32}`,
      params,
    );
    return {
      lines: found.map(({ currency, counterparty, balance }) => ({ currency, counterparty, balance })),
      total: found.length === 0 ? 0 : Number(found[0].lines_total),
    };
  }

  /**
   * The last balance each of `lines` was left with in each bucket of the window (`label` is the start of the bucket,
   * `YYYY-MM-DD`), and, with the label `''`, the last one before the window: from the `end_balance` of the last day of the
   * line in the bucket, which the rows of a day have the same on every group of the line.
   */
  private lineBuckets(
    q: BalancesQuery,
    source: DayGroupsSource,
    lines: StoredLine[],
    interval: VolumeInterval,
  ): Promise<StoredLineBucket[]> {
    const fromDay = q.window.fromDay < DAY_GROUPS_EPOCH ? DAY_GROUPS_EPOCH : q.window.fromDay;
    return this.ch.query<StoredLineBucket>(
      `SELECT currency, counterparty,
              if(day < {from_day:Date}, '', toString(${bucketOfDaySql(interval)})) AS label,
              argMax(end_balance, day) AS balance
         FROM (${source.sql})
        WHERE (currency, counterparty) IN (SELECT arrayJoin(arrayZip({line_currencies:Array(String)}, {line_counterparties:Array(String)})))
        GROUP BY currency, counterparty, label`,
      {
        ...source.params,
        from_day: fromDay,
        line_currencies: lines.map((l) => l.currency),
        line_counterparties: lines.map((l) => l.counterparty),
      },
    );
  }

  /**
   * The sums of the balance changes of the window by change type: the totals of each type, and the rows per asset (without an
   * interval) or per bucket (with one).
   *
   * One read of the day groups of the window, grouped by day, change type, currency and the issuer of the asset (the
   * counterparty, or the account itself where it owes on the line: the issuer folds the lines of an issuer into one asset),
   * with the count and the exact sums of what came in and went out (`sumOf` falls back to the Float64 sums where an amount
   * does not fit a decimal). The values and the buckets are made here: each group is valued on its own day with `DailyRates`,
   * which is asked for the issued assets that moved and the days they moved on.
   */
  async balanceChanges(q: BalanceChangesQuery): Promise<BalanceChanges> {
    const w = q.window;
    const none: BalanceChanges = { totals: [], rows: [] };
    if (w.empty) return none;
    const from = w.fromDay < DAY_GROUPS_EPOCH ? DAY_GROUPS_EPOCH : w.fromDay;
    const through = w.throughDay > MAX_DAY ? MAX_DAY : w.throughDay;
    if (from > through) return none;
    const source = await this.dayGroups.source('lines', q.account, from, through);
    if (!source) return none;

    // the aliases are not the names of the columns they sum, as in the other reads of the day groups
    const found = await this.ch.query<ChangeGroupRow>(
      `SELECT toString(day) AS day_text, change_type, currency,
              if(counterparty != '' AND owes = 1, {account:String}, counterparty) AS issuer,
              toUInt64(sum(count)) AS changes,
              ${mergedExactSum('in_sum')} AS in_exact,
              ${mergedExactSum('out_sum')} AS out_exact,
              toUInt32(sum(unfit)) AS unfit_changes,
              sumKahan(in_sum_f) AS in_float,
              sumKahan(out_sum_f) AS out_float
         FROM (${source.sql})
        GROUP BY day, change_type, currency, issuer`,
      { ...source.params, account: q.account },
    );
    const groups = found.map(
      (g): StoredChangeGroup => ({
        day: g.day_text,
        change_type: g.change_type,
        currency: g.currency,
        issuer: g.issuer,
        n: g.changes,
        in_sum: g.in_exact,
        out_sum: g.out_exact,
        unfit: g.unfit_changes,
        in_sum_f: g.in_float,
        out_sum_f: g.out_float,
      }),
    );

    const { assets, days } = ratedChangeAssets(groups);
    const interval = w.interval;
    return toBalanceChanges({
      native: this.profile.nativeCurrency,
      groups,
      rates: assets.length === 0 ? new Map() : await this.rates.rates(assets, days),
      ...(interval !== undefined && {
        bucketOf: (day: string) => dayText(bucketStart(Date.parse(`${day}T00:00:00Z`), interval)),
      }),
    });
  }
}
