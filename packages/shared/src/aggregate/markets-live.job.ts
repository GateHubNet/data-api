import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { MarketsLiveRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { assetKey } from '../query/asset';
import { EXACT_LIMIT, ratio, sumOf } from '../query/decimal';
import { QUOTIENT_DIGITS } from '../query/valuation';
import { AggregateSetOptions, nextSetVersion, throwIfSetAborted } from './aggregate-sets';
import { HourSet, PAIR_HOURLY_CONFIG_VERSION, pairHourSets } from './pair-hourly.job';

/**
 * The `markets_live` job: for each live period (`day`, `7day`, `30day`), the statistics of every pair traded in it (the
 * trades counted, the volumes, the open, high, low and last rate, the volume in native coins and the 7 daily closes of
 * the sparkline), made from the hour sets of `pair_hourly` (a few rows per pair and hour) and not from the trades.
 *
 * A (period, filter) is a **set**: a row for each pair with a kept trade in the window, and a **sentinel** row (the empty
 * pair) that carries the window (`start_time`, `end_time`) and the totals of the set. The whole set is one insert under
 * one version, and a reader takes the rows of the newest version (spec 3.3, 7). D2 writes the `include` filter only, with
 * no AMM field (`amm_share`, `amm_pool` and `total_amm_share` are NULL): D2b fills the others in. Which period is due, and
 * when, is the runner's.
 */

export const MARKETS_PERIODS = ['day', '7day', '30day'] as const;
export type MarketsPeriod = (typeof MARKETS_PERIODS)[number];

/** The hours of each period's window. */
export const MARKETS_PERIOD_HOURS: Record<MarketsPeriod, number> = { day: 24, '7day': 168, '30day': 720 };

/** The UTC days of the closes of a market: the 6 before the day of `t`, and that day. */
export const SPARKLINE_DAYS = 7;

/** What a run came to: the set it wrote, or the hours that kept it from writing (the previous set stays). */
export type MarketsSetOutcome =
  | { written: true; pairs: number; startTime: number; endTime: number }
  | { written: false; missingHours: number[] };

const HOUR = 3600;
const DAY = 86_400;

const PAIR_COLUMNS = ['base_currency', 'base_issuer', 'counter_currency', 'counter_issuer'];
/** The sentinel of an hour's set: the empty pair. */
const SENTINEL = "base_currency = '' AND base_issuer = '' AND counter_currency = '' AND counter_issuer = ''";
/** The rows that tell the newest version of a markets set (D2: the filter `include`). */
const SET_OF_PERIOD = "period = {period:String} AND amm = 'include'";

/**
 * The hour rows a read takes: those of the newest version of each hour (`hours` and `versions`, bound, are what the sets
 * said: the version that was checked is the version that is read), each row once by its key (`LIMIT 1 BY`, in the order of
 * the key; a row written twice would count twice otherwise), and no sentinel. Both sources count (the filter `include`).
 * `fit` is whether the hour's sums are exact ones: no amount the exact sums cannot hold, and both Float64 sums below the
 * limit that keeps the sum of many hours in a `Decimal256(30)`.
 */
const HOUR_ROWS = `(SELECT hour, ${PAIR_COLUMNS.join(', ')}, count, base_sum, counter_sum,
                           (unfit = 0 AND base_sum_f < ${EXACT_LIMIT} AND counter_sum_f < ${EXACT_LIMIT}) AS fit,
                           base_sum_f, counter_sum_f,
                           open_rate, open_ledger, open_tx, open_node, open_time,
                           close_rate, close_ledger, close_tx, close_node, close_time,
                           high_rate, high_rate_f, high_ledger, high_tx, high_node,
                           low_rate, low_rate_f, low_ledger, low_tx, low_node
                      FROM ${Table.PairHourly}
                     WHERE hour >= toDateTime({from:UInt32}, 'UTC') AND hour <= toDateTime({to:UInt32}, 'UTC')
                       AND (hour, version) IN (SELECT toDateTime(newest.1, 'UTC'), newest.2
                                                 FROM (SELECT arrayJoin(arrayZip({hours:Array(UInt32)}, {versions:Array(UInt64)})) AS newest))
                       AND NOT (${SENTINEL})
                     ORDER BY hour, ${PAIR_COLUMNS.join(', ')}, source
                     LIMIT 1 BY hour, ${PAIR_COLUMNS.join(', ')}, source)`;

/** One group of the window read: a pair over the hours of the window. The aliases are none of the columns of the hour rows. */
interface WindowGroup {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  trades: number | string;
  /** The exact volumes (`NULL`: no hour was fit) and the Float64 ones; `misfit_hours` says which of them a reader takes. */
  base_exact: string | null;
  counter_exact: string | null;
  misfit_hours: number | string;
  base_float: number | null;
  counter_float: number | null;
  first_rate: string;
  first_ts: number | string;
  last_rate: string;
  last_ts: number | string;
  top_rate: string;
  bottom_rate: string;
}

/** The close of a pair on a UTC day (`YYYY-MM-DD`). */
interface DayClose {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  day: string;
  day_close: string;
}

const floorHour = (seconds: number): number => Math.floor(seconds / HOUR) * HOUR;
const floorDay = (seconds: number): number => Math.floor(seconds / DAY) * DAY;
const dayKey = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
const pairKey = (r: {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
}): string => JSON.stringify([r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer]);

/** A row of the set that has no pair's statistics: the sentinel's frame, and the base of every pair's row. */
function frameOf(period: MarketsPeriod, version: number, startTime: number, endTime: number): MarketsLiveRow {
  return {
    period,
    amm: 'include',
    base_currency: '',
    base_issuer: '',
    counter_currency: '',
    counter_issuer: '',
    count: 0,
    base_volume: '0',
    counter_volume: '0',
    native_volume: null,
    open: '',
    high: '',
    low: '',
    last: '',
    open_time: startTime,
    last_time: startTime,
    closes: [],
    amm_share: null,
    amm_pool: null,
    start_time: startTime,
    end_time: endTime,
    pairs_traded: 0,
    total_count: 0,
    total_native_volume: '0',
    total_amm_share: null,
    version,
  };
}

/** The hours of `[from, to]` (both included, unix seconds of whole hours) that cannot be read: see `computeMarketsSet`. */
function missingOf(sets: Map<number, HourSet>, from: number, to: number): number[] {
  const missing: number[] = [];
  for (let hour = from; hour <= to; hour += HOUR) {
    const set = sets.get(hour);
    // the last two hours need not be final: the current hour is not over, and the one before it may still lack a trade
    const mayBeOpen = hour >= to - HOUR;
    if (!set || set.configVersion !== PAIR_HOURLY_CONFIG_VERSION || (!set.final && !mayBeOpen)) missing.push(hour);
  }
  return missing;
}

/**
 * Computes the set of a period at `now` and writes it, or says why it cannot. Returns the set it wrote (how many pairs,
 * and its window), or the hours that kept it from writing; the set that was there stays then.
 *
 * - `t` is the `through_time` of the newest set of the hour of `now`: the close time of the newest ledger that set read.
 *   The window is the hours from `floorHour(t) - P` to `floorHour(t)`, both included, so `start_time = floorHour(t) - P`
 *   and `end_time = t`, and it is at least `P` and at most `P` + 59:59 long. (A set's `through_time` is in its own hour: the
 *   hour of `t` is the hour of `now`.)
 * - The sparkline days are the 7 UTC days that end with the day of `t`. The hours that have to have a set are those of the
 *   window and those from the start of the first sparkline day up to `floorHour(t)` (the hours after it do not exist yet):
 *   each needs a newest set of the current config version, and a final one except `floorHour(t)` and the hour before it.
 * - The pairs, per period and window, are those with a kept trade: `count` and the volumes are sums (exact; the Float64
 *   sums where an hour's sums are not exact ones, the `sumOf` rule), `open` and `last` the rates of the first and last
 *   trade by key, `high` and `low` the highest and lowest rate (the key breaks a tie), and the times of the first and last.
 * - The native volume of a pair with a native side is that side's volume; else the base volume over the base's rate, else
 *   the counter volume over the counter's rate (an asset's rate is its volume over the native volume of its pair against
 *   the native currency, in the same window), the quotient cut to 17 significant digits; else there is none.
 * - The closes are the last trade of each of the sparkline days; a quiet day carries the close before it, and a day with
 *   none before it (in the 7 days) has none.
 *
 * `pair_hourly` is read in three queries however many hours and pairs there are: the sets of the hours, the pairs of the
 * window, and the closes of the sparkline days. A `signal` that is aborted before the work, or before the insert, throws
 * `AggregateSetAborted` and writes nothing.
 */
export async function computeMarketsSet(
  ch: ClickHouseService,
  nativeCurrency: string,
  period: MarketsPeriod,
  now: Date,
  options: AggregateSetOptions = {},
): Promise<MarketsSetOutcome> {
  const { signal } = options;
  if (!MARKETS_PERIODS.includes(period)) throw new RangeError(`Not a markets period: ${String(period)}`);
  const periodHours = MARKETS_PERIOD_HOURS[period];
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isFinite(nowSeconds)) throw new RangeError('Invalid date');
  throwIfSetAborted(signal);

  const currentHour = floorHour(nowSeconds);
  const sparkStart = floorDay(currentHour) - (SPARKLINE_DAYS - 1) * DAY;
  const windowStart = currentHour - periodHours * HOUR;
  const firstHour = Math.min(windowStart, sparkStart);

  const sets = await pairHourSets(ch, firstHour, currentHour + HOUR);
  const current = sets.get(currentHour);
  if (!current) return { written: false, missingHours: [currentHour] };
  const missingHours = missingOf(sets, firstHour, currentHour);
  if (missingHours.length > 0) return { written: false, missingHours };
  const endTime = current.throughTime;

  // the rows of the newest version of each hour the sets named: the window's, and the sparkline days' (one read each: the
  // groupings differ)
  const hoursFrom = (from: number): { from: number; to: number; hours: number[]; versions: number[] } => {
    const hours: number[] = [];
    for (let hour = from; hour <= currentHour; hour += HOUR) hours.push(hour);
    return {
      from,
      to: currentHour,
      hours,
      versions: hours.map((hour) => (sets.get(hour) as HourSet).version),
    };
  };
  const [groups, dayCloses] = await Promise.all([
    ch.query<WindowGroup>(
      `SELECT ${PAIR_COLUMNS.join(', ')},
              toUInt64(sum(count)) AS trades,
              toString(sumIf(toDecimal256OrNull(base_sum, 30), fit)) AS base_exact,
              toString(sumIf(toDecimal256OrNull(counter_sum, 30), fit)) AS counter_exact,
              toUInt32(countIf(NOT fit)) AS misfit_hours,
              sumKahan(base_sum_f) AS base_float,
              sumKahan(counter_sum_f) AS counter_float,
              argMin(open_rate, (open_ledger, open_tx, open_node)) AS first_rate,
              toUnixTimestamp(argMin(open_time, (open_ledger, open_tx, open_node))) AS first_ts,
              argMax(close_rate, (close_ledger, close_tx, close_node)) AS last_rate,
              toUnixTimestamp(argMax(close_time, (close_ledger, close_tx, close_node))) AS last_ts,
              argMax(high_rate, (high_rate_f, -toInt64(high_ledger), -toInt64(high_tx), -toInt32(high_node))) AS top_rate,
              argMin(low_rate, (low_rate_f, low_ledger, low_tx, low_node)) AS bottom_rate
         FROM ${HOUR_ROWS}
        GROUP BY ${PAIR_COLUMNS.join(', ')}
        ORDER BY ${PAIR_COLUMNS.join(', ')}`,
      hoursFrom(windowStart),
    ),
    ch.query<DayClose>(
      `SELECT ${PAIR_COLUMNS.join(', ')}, toString(toDate(hour)) AS day,
              argMax(close_rate, (close_ledger, close_tx, close_node)) AS day_close
         FROM ${HOUR_ROWS}
        GROUP BY ${PAIR_COLUMNS.join(', ')}, day`,
      hoursFrom(sparkStart),
    ),
  ]);

  // the volumes of each pair, and from the pairs against the native currency the rate of each asset: its volume over the
  // native volume (units of the asset one native coin buys)
  const isNative = (currency: string, issuer: string): boolean => issuer === '' && currency === nativeCurrency;
  const pairs = groups.map((g) => ({
    g,
    base: sumOf(Number(g.misfit_hours), g.base_exact, g.base_float),
    counter: sumOf(Number(g.misfit_hours), g.counter_exact, g.counter_float),
  }));
  const rates = new Map<string, BigNumber>();
  for (const { g, base, counter } of pairs) {
    if (isNative(g.counter_currency, g.counter_issuer)) {
      if (counter.gt(0))
        rates.set(assetKey({ currency: g.base_currency, issuer: g.base_issuer }), ratio(base, counter));
    } else if (isNative(g.base_currency, g.base_issuer)) {
      if (base.gt(0))
        rates.set(assetKey({ currency: g.counter_currency, issuer: g.counter_issuer }), ratio(counter, base));
    }
  }

  // the close of each pair on each sparkline day, then the 7 days in order, a quiet day carrying the close before it
  const closesOf = new Map<string, Map<string, string>>();
  for (const c of dayCloses) {
    const days = closesOf.get(pairKey(c)) ?? new Map<string, string>();
    days.set(c.day, c.day_close);
    closesOf.set(pairKey(c), days);
  }
  const days = Array.from({ length: SPARKLINE_DAYS }, (_, i) => dayKey(sparkStart + i * DAY));

  let totalCount = 0;
  let totalNative = new BigNumber(0);
  const version = await nextSetVersion(ch, Table.MarketsLive, SET_OF_PERIOD, { period });
  const frame = frameOf(period, version, windowStart, endTime);
  const rows = pairs.map(({ g, base, counter }): MarketsLiveRow => {
    let native: BigNumber | null = null;
    if (isNative(g.counter_currency, g.counter_issuer)) native = counter;
    else if (isNative(g.base_currency, g.base_issuer)) native = base;
    else {
      const baseRate = rates.get(assetKey({ currency: g.base_currency, issuer: g.base_issuer }));
      const counterRate = rates.get(assetKey({ currency: g.counter_currency, issuer: g.counter_issuer }));
      if (baseRate?.gt(0)) native = ratio(base, baseRate).precision(QUOTIENT_DIGITS);
      else if (counterRate?.gt(0)) native = ratio(counter, counterRate).precision(QUOTIENT_DIGITS);
    }
    const count = Number(g.trades);
    totalCount += count;
    if (native) totalNative = totalNative.plus(native);

    const dayClosesOfPair = closesOf.get(pairKey(g));
    let carried: string | null = null;
    const closes = days.map((day) => {
      carried = dayClosesOfPair?.get(day) ?? carried;
      return carried;
    });
    return {
      ...frame,
      base_currency: g.base_currency,
      base_issuer: g.base_issuer,
      counter_currency: g.counter_currency,
      counter_issuer: g.counter_issuer,
      count,
      base_volume: base.toString(),
      counter_volume: counter.toString(),
      native_volume: native === null ? null : native.toString(),
      open: g.first_rate,
      high: g.top_rate,
      low: g.bottom_rate,
      last: g.last_rate,
      open_time: Number(g.first_ts),
      last_time: Number(g.last_ts),
      closes,
    };
  });
  const sentinel: MarketsLiveRow = {
    ...frame,
    pairs_traded: rows.length,
    total_count: totalCount,
    total_native_volume: totalNative.toString(),
  };

  throwIfSetAborted(signal);
  await ch.insert(Table.MarketsLive, [sentinel, ...rows]);
  return { written: true, pairs: rows.length, startTime: windowStart, endTime };
}

/**
 * The `end_time` of the newest `include` set of each period, unix seconds (the newest by version: a set that was written
 * twice counts once, and a set of another filter does not count). A period that has no set is not in the map. The runner
 * starts with the period whose set is the stalest.
 */
export async function marketsSetEndTimes(ch: ClickHouseService): Promise<Map<MarketsPeriod, number>> {
  const rows = await ch.query<{ period: string; end: number | string }>(
    `SELECT period, toUnixTimestamp(end_time) AS end
       FROM ${Table.MarketsLive}
      WHERE amm = 'include' AND ${SENTINEL}
      ORDER BY period, version DESC
      LIMIT 1 BY period`,
  );
  const ends = new Map<MarketsPeriod, number>();
  for (const period of MARKETS_PERIODS) {
    const row = rows.find((r) => r.period === period);
    if (row) ends.set(period, Number(row.end));
  }
  return ends;
}
