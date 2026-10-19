import {
  Asset,
  assetKey,
  ClickHouseService,
  DailyRates,
  DAY_GROUPS_EPOCH,
  DayGroupsSource,
  exactAmount,
  mergedExactSum,
  NetworkProfile,
  newestValidRateDay,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { NETWORK_PROFILE } from '../config/api.config';
import { bucketStart, dayText, MAX_DAY_MS, VolumeInterval } from '../network/volume-buckets';
import {
  BalanceChanges,
  BalanceLine,
  BalanceRow,
  Counterparty,
  CounterpartySort,
  ExchangePair,
  ratedChangeAssets,
  ratedCounterpartyAssets,
  ratedPairAssets,
  StoredChangeGroup,
  StoredCounterparty,
  StoredCounterpartySum,
  StoredLine,
  StoredLineBucket,
  StoredPairGroup,
  toBalanceChanges,
  toBalanceLines,
  toBalanceRows,
  toCounterparties,
  toExchangePairs,
} from './account-analytics-object';
import { AccountDayGroupsService } from './account-day-groups.service';
import { readPayments, SIDE } from './account-reports.service';
import { AnalyticsWindow, bucketOfDaySql } from './analytics-window';

/** The last day a ClickHouse `Date` holds, `YYYY-MM-DD`. */
const MAX_DAY = dayText(MAX_DAY_MS);

const DAY_MS = 86_400_000;

/**
 * How many counterparties more than the `limit` the database keeps: it ranks by Float64 values, which can tie, or differ in
 * their last bits, where the exact ones do not, so the exact order is made among a few more than are served.
 */
const COUNTERPARTY_MARGIN = 10;

/** The order of the counterparties the database keeps. Code, chosen by the validated `sort`. */
const COUNTERPARTY_ORDER: Record<CounterpartySort, string> = {
  value: 'total_f DESC, counterparty',
  count: 'payments_sent + payments_received DESC, counterparty',
};

/**
 * The days of a window that can hold anything: from the epoch of the day groups to the last day a `Date` holds, as
 * `[from, through]` (`YYYY-MM-DD`), `undefined` when the window is empty or has none.
 */
function storedDays(w: AnalyticsWindow): [from: string, through: string] | undefined {
  if (w.empty) return undefined;
  const from = w.fromDay < DAY_GROUPS_EPOCH ? DAY_GROUPS_EPOCH : w.fromDay;
  const through = w.throughDay > MAX_DAY ? MAX_DAY : w.throughDay;
  return from > through ? undefined : [from, through];
}

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

/** What `GET /v2/accounts/:address/analytics/counterparties` is asked for; the values are already validated. */
export interface CounterpartiesQuery {
  account: string;
  window: AnalyticsWindow;
  sort: CounterpartySort;
  limit: number;
}

export interface CounterpartiesResult {
  /** How many different counterparties the account has in the window. */
  total: number;
  /** The first `limit` of them, in the order of `sort`. */
  counterparties: Counterparty[];
}

/** What `GET /v2/accounts/:address/analytics/exchanges` is asked for; the values are already validated. */
export interface ExchangesQuery {
  account: string;
  window: AnalyticsWindow;
  limit: number;
}

export interface ExchangesResult {
  /** How many pairs the account traded in the window. */
  total: number;
  /** The first `limit` of them. */
  pairs: ExchangePair[];
}

/** What the read of the day groups of `trades` gives: a `StoredPairGroup` under the names of its columns. */
interface PairGroupRow {
  day_text: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  trades: number | string;
  base_exact: string;
  counter_exact: string;
  bought_exact: string;
  sold_exact: string;
  bought_counter_exact: string;
  sold_counter_exact: string;
  unfit_trades: number | string;
  base_float: number;
  counter_float: number;
  bought_float: number;
  sold_float: number;
  bought_counter_float: number;
  sold_counter_float: number;
}

/** What the read of the sums of a counterparty gives: a `StoredCounterpartySum` under the names of its columns. */
interface CounterpartySumRow {
  counterparty: string;
  side: 'sent' | 'received';
  currency: string;
  issuer: string;
  day_text: string;
  amount_sum: string | null;
  unfit: number | string;
  amount_sum_f: number | null;
}

/** What the read of the counterparties to keep gives, with the number of all of them. */
interface RankedCounterparty extends StoredCounterparty {
  total: number | string;
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
 *
 * `exchanges` reads the `trades` groups the same way. `counterparties` reads the payments of the account (`account_payments`)
 * on read, as `reports` does, for it has no rollup.
 */
@Injectable()
export class AccountAnalyticsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly rates: DailyRates,
    private readonly dayGroups: AccountDayGroupsService,
    private readonly ranges: LedgerRangeResolver,
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

  /**
   * The counterparties of the account in the window: the accounts it paid and was paid by, each with what the payments were
   * worth, how many there were each way, and when the first and the last were. Three reads of `account_payments`, each a
   * payment once, in the order of its key (`readPayments`, as `reports` has it), a payment to oneself the account's own
   * (`SIDE`):
   *
   *  1. The issued assets that were paid and the days they were, so that the rates to ask for are known.
   *  2. Per counterparty, in SQL: the numbers of payments each way, the first and last time, and a Float64 value (the
   *     delivered amounts over the rate of their day, as `DailyRates.rateRowsSql` gives the rates: the stored sets of the valid
   *     days and the others computed on read). It gives the number of all the counterparties and the best `limit` and a few
   *     more by the `sort`.
   *  3. For those, the exact sums per side, asset and day.
   *
   * The exact values and the exact order are made here (`toCounterparties`), and `limit` of them served.
   */
  async counterparties(q: CounterpartiesQuery): Promise<CounterpartiesResult> {
    const none: CounterpartiesResult = { total: 0, counterparties: [] };
    const days = storedDays(q.window);
    if (days === undefined) return none;
    const range = await this.ranges.resolve(
      new Date(`${days[0]}T00:00:00Z`),
      new Date(Date.parse(`${days[1]}T00:00:00Z`) + DAY_MS),
    );
    if (range === null) return none;
    const params = { account: q.account, min: range.min, max: range.max };

    // (1) an asset that was paid is a currency and an issuer; a payment of the native currency has no issuer, and no rate
    const paid = await this.ch.query<{ currency: string; issuer: string; day_text: string }>(
      `SELECT currency, issuer, toString(day) AS day_text
         FROM (${readPayments("toDate(close_time, 'UTC') AS day, currency, issuer, delivered_amount_f", "issuer != ''")})
        GROUP BY currency, issuer, day
       HAVING sum(delivered_amount_f) > 0`,
      params,
    );
    const assets = new Map<string, Asset>();
    for (const p of paid) assets.set(assetKey(p), { currency: p.currency, issuer: p.issuer });
    const rateRows = await this.rates.rateRowsSql([...assets.values()], [...new Set(paid.map((p) => p.day_text))]);

    // (2) the value of a payment is its amount, or its amount over the rate of its day; a payment without a rate is worth 0.
    // (`p.` and `r.` of the join: both have a currency, an issuer and a day.)
    const chosen = await this.ch.query<RankedCounterparty>(
      `SELECT counterparty, payments_sent, payments_received, first_at, last_at, total
         FROM (SELECT counterparty, payments_sent, payments_received, first_at, last_at, total_f, count() OVER () AS total
                 FROM (SELECT counterparty,
                              toUInt32(countIf(side = 'sent')) AS payments_sent,
                              toUInt32(countIf(side = 'received')) AS payments_received,
                              toUInt32(min(paid_at)) AS first_at,
                              toUInt32(max(paid_at)) AS last_at,
                              sumKahan(payment_value) AS total_f
                         FROM (SELECT p.counterparty AS counterparty, p.side AS side,
                                      toUnixTimestamp(p.close_time) AS paid_at,
                                      if(p.issuer = '', p.delivered_amount_f,
                                         if(r.rate_f > 0, p.delivered_amount_f / r.rate_f, 0)) AS payment_value
                                 FROM (${readPayments(`counterparty, ${SIDE} AS side, close_time, toDate(close_time, 'UTC') AS day, currency, issuer, delivered_amount_f`)}) AS p
                                 LEFT ANY JOIN (${rateRows.sql}) AS r
                                   ON p.currency = r.currency AND p.issuer = r.issuer AND p.day = r.day)
                        GROUP BY counterparty))
        ORDER BY ${COUNTERPARTY_ORDER[q.sort]}
        LIMIT {kept:UInt32}`,
      { ...params, ...rateRows.params, kept: q.limit + COUNTERPARTY_MARGIN },
    );
    if (chosen.length === 0) return none;

    // (3) the exact sums, which the exact values are made of
    const sums = await this.ch.query<CounterpartySumRow>(
      `SELECT counterparty, side, currency, issuer, toString(day) AS day_text,
              toString(sum(delivered_exact)) AS amount_sum,
              toUInt32(countIf(delivered_exact IS NULL)) AS unfit,
              sumKahan(delivered_amount_f) AS amount_sum_f
         FROM (${readPayments(
           `counterparty, ${SIDE} AS side, currency, issuer, toDate(close_time, 'UTC') AS day, delivered_amount_f, ${exactAmount('delivered_amount')} AS delivered_exact`,
           'counterparty IN {counterparties:Array(String)}',
         )})
        GROUP BY counterparty, side, currency, issuer, day`,
      { ...params, counterparties: chosen.map((c) => c.counterparty) },
    );
    const stored = sums.map(({ day_text, ...rest }): StoredCounterpartySum => ({ ...rest, day: day_text }));
    const rated = ratedCounterpartyAssets(stored);
    return {
      total: Number(chosen[0].total),
      counterparties: toCounterparties({
        native: this.profile.nativeCurrency,
        sort: q.sort,
        limit: q.limit,
        chosen,
        sums: stored,
        rates: rated.assets.length === 0 ? new Map() : await this.rates.rates(rated.assets, rated.days),
      }),
    };
  }

  /**
   * The pairs the account traded in the window, each with its volumes and what they were worth.
   *
   * One read of the `trades` day groups of the window, grouped by day and pair, with the count and the exact sums (`sumOf`
   * falls back to the Float64 sums where an amount does not fit a decimal). The native volumes and the order are made here:
   * a pair with a native side is worth that side, the others each day at the rate of the base or else of the counter, which
   * `DailyRates` is asked for, only for the issued sides of those pairs and the days of their groups.
   */
  async exchanges(q: ExchangesQuery): Promise<ExchangesResult> {
    const none: ExchangesResult = { total: 0, pairs: [] };
    const days = storedDays(q.window);
    if (days === undefined) return none;
    const source = await this.dayGroups.source('trades', q.account, days[0], days[1]);
    if (!source) return none;

    // the aliases are not the names of the columns they sum, as in the other reads of the day groups
    const found = await this.ch.query<PairGroupRow>(
      `SELECT toString(day) AS day_text, base_currency, base_issuer, counter_currency, counter_issuer,
              toUInt64(sum(count)) AS trades,
              ${mergedExactSum('base_sum')} AS base_exact,
              ${mergedExactSum('counter_sum')} AS counter_exact,
              ${mergedExactSum('bought_sum')} AS bought_exact,
              ${mergedExactSum('sold_sum')} AS sold_exact,
              ${mergedExactSum('bought_counter_sum')} AS bought_counter_exact,
              ${mergedExactSum('sold_counter_sum')} AS sold_counter_exact,
              toUInt32(sum(unfit)) AS unfit_trades,
              sumKahan(base_sum_f) AS base_float,
              sumKahan(counter_sum_f) AS counter_float,
              sumKahan(bought_sum_f) AS bought_float,
              sumKahan(sold_sum_f) AS sold_float,
              sumKahan(bought_counter_sum_f) AS bought_counter_float,
              sumKahan(sold_counter_sum_f) AS sold_counter_float
         FROM (${source.sql})
        GROUP BY day, base_currency, base_issuer, counter_currency, counter_issuer`,
      source.params,
    );
    const groups = found.map(
      (g): StoredPairGroup => ({
        day: g.day_text,
        base_currency: g.base_currency,
        base_issuer: g.base_issuer,
        counter_currency: g.counter_currency,
        counter_issuer: g.counter_issuer,
        n: g.trades,
        base_sum: g.base_exact,
        counter_sum: g.counter_exact,
        bought_sum: g.bought_exact,
        sold_sum: g.sold_exact,
        bought_counter_sum: g.bought_counter_exact,
        sold_counter_sum: g.sold_counter_exact,
        unfit: g.unfit_trades,
        base_sum_f: g.base_float,
        counter_sum_f: g.counter_float,
        bought_sum_f: g.bought_float,
        sold_sum_f: g.sold_float,
        bought_counter_sum_f: g.bought_counter_float,
        sold_counter_sum_f: g.sold_counter_float,
      }),
    );

    const native = this.profile.nativeCurrency;
    const rated = ratedPairAssets(groups, native);
    return toExchangePairs({
      native,
      groups,
      rates: rated.assets.length === 0 ? new Map() : await this.rates.rates(rated.assets, rated.days),
      limit: q.limit,
    });
  }
}
