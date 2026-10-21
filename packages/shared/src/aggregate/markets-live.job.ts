import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { AMM_PARSER_VERSION, MarketsLiveRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { assetKey } from '../query/asset';
import { EXACT_LIMIT, ratio, sumOf } from '../query/decimal';
import { QUOTIENT_DIGITS } from '../query/valuation';
import { AggregateSetOptions, nextSetVersion, throwIfSetAborted } from './aggregate-sets';
import { HourSet, PAIR_HOURLY_CONFIG_VERSION, pairHourSets } from './pair-hourly.job';

/**
 * The `markets_live` job: for each live period (`day`, `7day`, `30day`), the statistics of every pair traded in it (the
 * trades counted, the volumes, the open, high, low and last rate, the volume in native coins and the 7 daily closes of
 * the sparkline), made from the hour sets of `pair_hourly` (a few rows per pair, source and hour) and not from the trades.
 *
 * A (period, filter) is a **set**: a row for each pair with a kept trade of the filter in the window, and a **sentinel**
 * row (the empty pair) that carries the window (`start_time`, `end_time`) and the totals of the set. The filter is which
 * trades the set takes: `include` all of them, `exclude` the order-book trades (the hour rows of source `book`), `only`
 * the swaps against pools (source `amm`). The whole set is one insert under one version, and a reader takes the rows of
 * the newest version (spec 3.3, 7). A run of a period writes its three filter sets from the same hour rows (D2b.1), with
 * the AMM fields: `amm_share` and `amm_pool` on each pair's row, `total_amm_share` on the sentinel, when every ledger of
 * the window was written by a parser that knows AMM (the parser gate), and NULL otherwise. Which period is due, and when,
 * is the runner's.
 */

export const MARKETS_PERIODS = ['day', '7day', '30day'] as const;
export type MarketsPeriod = (typeof MARKETS_PERIODS)[number];

/** The hours of each period's window. */
export const MARKETS_PERIOD_HOURS: Record<MarketsPeriod, number> = { day: 24, '7day': 168, '30day': 720 };

/** The UTC days of the closes of a market: the 6 before the day of `t`, and that day. */
export const SPARKLINE_DAYS = 7;

/** The filters of the markets sets: every trade, the order-book trades, the swaps against pools. */
export const MARKETS_AMM_FILTERS = ['include', 'exclude', 'only'] as const;
export type MarketsAmmFilter = (typeof MARKETS_AMM_FILTERS)[number];

/**
 * What a run came to: the sets it wrote (how many pairs the `include` set has, the window, and whether the sets have
 * their AMM fields), or the hours that kept it from writing (the previous sets stay).
 */
export type MarketsSetOutcome =
  | { written: true; pairs: number; startTime: number; endTime: number; ammShareKnown: boolean }
  | { written: false; missingHours: number[] };

const HOUR = 3600;
const DAY = 86_400;

const PAIR_COLUMNS = ['base_currency', 'base_issuer', 'counter_currency', 'counter_issuer'];
/** The sentinel of an hour's set: the empty pair. */
const SENTINEL = "base_currency = '' AND base_issuer = '' AND counter_currency = '' AND counter_issuer = ''";
/** The rows that tell the newest version of a markets set: those of its period and filter. */
const SET_OF_PERIOD = 'period = {period:String} AND amm = {amm:String}';

/** The sources of the hour rows each filter takes. */
const FILTER_SOURCES: Record<MarketsAmmFilter, string[]> = {
  include: ['book', 'amm'],
  exclude: ['book'],
  only: ['amm'],
};

/** The order the sets of a run are written in (D6): `include`, the set the explorer reads first, is the last to change. */
const WRITE_ORDER: readonly MarketsAmmFilter[] = ['exclude', 'only', 'include'];

/**
 * The hour rows a read takes: those of the newest version of each hour (`hours` and `versions`, bound, are what the sets
 * said: the version that was checked is the version that is read), each row once by its key (`LIMIT 1 BY`, in the order of
 * the key; a row written twice would count twice otherwise), of the sources of the set's filter (`sources`, bound), and no
 * sentinel. `fit` is whether the hour's sums are exact ones: no amount the exact sums cannot hold, and both Float64 sums
 * below the limit that keeps the sum of many hours in a `Decimal256(30)`.
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
                       AND source IN {sources:Array(String)}
                       AND NOT (${SENTINEL})
                     ORDER BY hour, ${PAIR_COLUMNS.join(', ')}, source
                     LIMIT 1 BY hour, ${PAIR_COLUMNS.join(', ')}, source)`;

/** The pairs of the window: each pair over the hour rows (of every source the filter takes), with its candle. */
const WINDOW_SQL = `SELECT ${PAIR_COLUMNS.join(', ')},
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
                     ORDER BY ${PAIR_COLUMNS.join(', ')}`;

/** The close of each pair on each sparkline day: the last trade by key of the day's hour rows. */
const CLOSES_SQL = `SELECT ${PAIR_COLUMNS.join(', ')}, toString(toDate(hour)) AS day,
                           argMax(close_rate, (close_ledger, close_tx, close_node)) AS day_close
                      FROM ${HOUR_ROWS}
                     GROUP BY ${PAIR_COLUMNS.join(', ')}, day`;

/**
 * The lowest parser version of the ledgers that closed in `[start, end]`: a range of the primary key from the first ledger
 * that closed at or after `start` (found by the order of the key, as `RatesService` finds it, with the skip index of
 * `close_time`; never a scan of the close times of the whole table), cut at the last that closed at or before `end`. NULL
 * when no ledger closed in it (with none at or after `start` the subquery is NULL, and so is the comparison with it).
 */
const PARSER_VERSION_OF_WINDOW = `SELECT minOrNull(parser_version) AS lowest
                                    FROM ${Table.Ledgers}
                                   WHERE ledger_index >= (SELECT ledger_index FROM ${Table.Ledgers}
                                                           WHERE close_time >= toDateTime({start:UInt32}, 'UTC')
                                                           ORDER BY ledger_index LIMIT 1)
                                     AND close_time <= toDateTime({end:UInt32}, 'UTC')`;

/** The pairs that have a pool whose newest row of `amm_pools` (the highest version: no FINAL) is not deleted. */
const POOLED_PAIRS = `SELECT DISTINCT ${PAIR_COLUMNS.join(', ')}
                        FROM (SELECT amm_account, ${PAIR_COLUMNS.join(', ')}, deleted
                                FROM ${Table.AmmPools}
                               ORDER BY amm_account, version DESC
                               LIMIT 1 BY amm_account)
                       WHERE deleted = 0`;

/** A pair, as the stored rows have it. */
interface Pair {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
}

/** One group of the window read: a pair over the hours of the window. The aliases are none of the columns of the hour rows. */
interface WindowGroup extends Pair {
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
interface DayClose extends Pair {
  day: string;
  day_close: string;
}

/** A pair of the window with its volumes read back (the `sumOf` rule). */
interface PairVolumes {
  g: WindowGroup;
  base: BigNumber;
  counter: BigNumber;
}

const floorHour = (seconds: number): number => Math.floor(seconds / HOUR) * HOUR;
const floorDay = (seconds: number): number => Math.floor(seconds / DAY) * DAY;
const dayKey = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
const pairKey = (r: Pair): string =>
  JSON.stringify([r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer]);

/** Rounds a quotient to 4 places, half up, as it is divided: once, never first to more places. */
const Share = BigNumber.clone({ DECIMAL_PLACES: 4, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });

/**
 * A share as `amm_share` and `total_amm_share` store it: `part / whole` with exactly 4 decimals, rounded half up
 * (`"0.3400"`); `null` when `whole` is not above 0.
 */
export function ammShareText(part: BigNumber, whole: BigNumber): string | null {
  if (!whole.gt(0)) return null;
  return new Share(part).dividedBy(whole).toFixed(4);
}

/** A row of the set that has no pair's statistics: the sentinel's frame, and the base of every pair's row. */
function frameOf(
  period: MarketsPeriod,
  filter: MarketsAmmFilter,
  version: number,
  startTime: number,
  endTime: number,
): MarketsLiveRow {
  return {
    period,
    amm: filter,
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
 * Whether every ledger that closed in `[start, end]` (unix seconds) was written by a parser that knows AMM (D4): the lowest
 * `parser_version` of those ledgers is at least `AMM_PARSER_VERSION`. A window without a ledger passes.
 */
async function ammParserCovers(ch: ClickHouseService, start: number, end: number): Promise<boolean> {
  const row = await ch.queryOne<{ lowest: number | string | null }>(PARSER_VERSION_OF_WINDOW, { start, end });
  return row?.lowest === null || row?.lowest === undefined || Number(row.lowest) >= AMM_PARSER_VERSION;
}

/**
 * Computes the three sets of a period at `now` (one per filter) and writes them, or says why it cannot. Returns what it
 * wrote (how many pairs the `include` set has, the window, and whether the AMM fields are known), or the hours that kept
 * it from writing; the sets that were there stay then.
 *
 * - `t` is the `through_time` of the newest set of the hour of `now`: the close time of the newest ledger that set read.
 *   The window is the hours from `floorHour(t) - P` to `floorHour(t)`, both included, so `start_time = floorHour(t) - P`
 *   and `end_time = t`, and it is at least `P` and at most `P` + 59:59 long. (A set's `through_time` is in its own hour: the
 *   hour of `now` is the hour of `t`.)
 * - The sparkline days are the 7 UTC days that end with the day of `t`. The hours that have to have a set are those of the
 *   window and those from the start of the first sparkline day up to `floorHour(t)` (the hours after it do not exist yet):
 *   each needs a newest set of the current config version, and a final one except `floorHour(t)` and the hour before it.
 *   A missing hour skips all three sets.
 * - The pairs of a set, per period and window, are those with a kept trade of the filter: `count` and the volumes are sums
 *   over the hour rows of the filter's sources (exact; the Float64 sums where an hour's sums are not exact ones, the
 *   `sumOf` rule), `open` and `last` the rates of the first and last trade by key, `high` and `low` the highest and lowest
 *   rate (the key breaks a tie, between the sources too), and the times of the first and last.
 * - The native volume of a pair with a native side is that side's volume; else the base volume over the base's rate, else
 *   the counter volume over the counter's rate (an asset's rate is its volume over the native volume of its pair against
 *   the native currency, in the same window and of every trade, whatever the filter), the quotient cut to 17 significant
 *   digits; else there is none.
 * - The closes are the last trade of the filter on each of the sparkline days; a quiet day carries the close before it,
 *   and a day with none before it (in the 7 days) has none.
 * - `amm_share` (D5) is the base volume of a pair's swaps over the base volume of all its trades (`ammShareText`), the same
 *   on the pair's row in every set; `amm_pool` is 1 when a pool of the pair has a newest row of `amm_pools` that is not
 *   deleted, else 0; `total_amm_share` (D3), the same on the three sentinels, is the sum over the pairs of all trades that
 *   have a native volume of `native_volume × swap base ÷ base_volume` (each quotient to 20 places) over the sum of their
 *   native volumes, rounded once, `"0.0000"` when no pair has a native volume. When a ledger that closed in
 *   `[start_time, end_time]` was written by a parser older than `AMM_PARSER_VERSION` (D4), the three are NULL on every
 *   row of the three sets.
 *
 * `pair_hourly` is read in seven queries however many hours and pairs there are: the sets of the hours, and for each
 * filter the pairs of the window and the closes of the sparkline days; `amm_pools` and `ledgers` once each. The sets are
 * written as three inserts, `exclude`, `only`, then `include` (D6), each under its own version. A `signal` that is aborted
 * before the work, or before an insert, throws `AggregateSetAborted` and writes nothing more.
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

  // the rows of the newest version of each hour the sets named, of a filter's sources: the window's, and the sparkline
  // days' (one read each: the groupings differ), for each filter; and the pools and the parser gate beside them
  const hoursFrom = (
    from: number,
    filter: MarketsAmmFilter,
  ): { from: number; to: number; hours: number[]; versions: number[]; sources: string[] } => {
    const hours: number[] = [];
    for (let hour = from; hour <= currentHour; hour += HOUR) hours.push(hour);
    return {
      from,
      to: currentHour,
      hours,
      versions: hours.map((hour) => (sets.get(hour) as HourSet).version),
      sources: FILTER_SOURCES[filter],
    };
  };
  const [reads, pooledRows, ammKnown] = await Promise.all([
    Promise.all(
      MARKETS_AMM_FILTERS.map((filter) =>
        Promise.all([
          ch.query<WindowGroup>(WINDOW_SQL, hoursFrom(windowStart, filter)),
          ch.query<DayClose>(CLOSES_SQL, hoursFrom(sparkStart, filter)),
        ]),
      ),
    ),
    ch.query<Pair>(POOLED_PAIRS),
    ammParserCovers(ch, windowStart, endTime),
  ]);
  const byFilter = new Map(
    MARKETS_AMM_FILTERS.map((filter, i) => {
      const [groups, dayCloses] = reads[i];
      const pairs = groups.map(
        (g): PairVolumes => ({
          g,
          base: sumOf(Number(g.misfit_hours), g.base_exact, g.base_float),
          counter: sumOf(Number(g.misfit_hours), g.counter_exact, g.counter_float),
        }),
      );
      return [filter, { pairs, dayCloses }] as const;
    }),
  );
  const pairsOf = (filter: MarketsAmmFilter): PairVolumes[] => byFilter.get(filter)?.pairs ?? [];

  // from the pairs of every trade against the native currency, the rate of each asset: its volume over the native volume
  // (units of the asset one native coin buys), the same for every filter's set
  const isNative = (currency: string, issuer: string): boolean => issuer === '' && currency === nativeCurrency;
  const rates = new Map<string, BigNumber>();
  for (const { g, base, counter } of pairsOf('include')) {
    if (isNative(g.counter_currency, g.counter_issuer)) {
      if (counter.gt(0))
        rates.set(assetKey({ currency: g.base_currency, issuer: g.base_issuer }), ratio(base, counter));
    } else if (isNative(g.base_currency, g.base_issuer)) {
      if (base.gt(0))
        rates.set(assetKey({ currency: g.counter_currency, issuer: g.counter_issuer }), ratio(counter, base));
    }
  }
  const nativeOf = ({ g, base, counter }: PairVolumes): BigNumber | null => {
    if (isNative(g.counter_currency, g.counter_issuer)) return counter;
    if (isNative(g.base_currency, g.base_issuer)) return base;
    const baseRate = rates.get(assetKey({ currency: g.base_currency, issuer: g.base_issuer }));
    const counterRate = rates.get(assetKey({ currency: g.counter_currency, issuer: g.counter_issuer }));
    if (baseRate?.gt(0)) return ratio(base, baseRate).precision(QUOTIENT_DIGITS);
    if (counterRate?.gt(0)) return ratio(counter, counterRate).precision(QUOTIENT_DIGITS);
    return null;
  };

  // the AMM share of each pair (the base volume of its swaps over that of all its trades), and the total share: each
  // pair's native volume weighted by its share, over the native volumes of the pairs that have one
  const swapBase = new Map(pairsOf('only').map(({ g, base }) => [pairKey(g), base]));
  const shares = new Map<string, string | null>();
  let weighted = new BigNumber(0);
  let natives = new BigNumber(0);
  for (const pair of pairsOf('include')) {
    const swapped = swapBase.get(pairKey(pair.g)) ?? new BigNumber(0);
    shares.set(pairKey(pair.g), ammShareText(swapped, pair.base));
    const native = nativeOf(pair);
    if (native === null) continue;
    natives = natives.plus(native);
    if (pair.base.gt(0)) weighted = weighted.plus(native.times(swapped).dividedBy(pair.base));
  }
  const totalAmmShare = ammShareText(weighted, natives) ?? '0.0000';
  const pooled = new Set(pooledRows.map(pairKey));

  const days = Array.from({ length: SPARKLINE_DAYS }, (_, i) => dayKey(sparkStart + i * DAY));
  /** The set of a filter: the sentinel, then the pairs. */
  const rowsOf = (filter: MarketsAmmFilter, version: number): MarketsLiveRow[] => {
    // the close of each pair on each sparkline day, then the 7 days in order, a quiet day carrying the close before it
    const closesOf = new Map<string, Map<string, string>>();
    for (const c of byFilter.get(filter)?.dayCloses ?? []) {
      const closes = closesOf.get(pairKey(c)) ?? new Map<string, string>();
      closes.set(c.day, c.day_close);
      closesOf.set(pairKey(c), closes);
    }

    let totalCount = 0;
    let totalNative = new BigNumber(0);
    const frame = frameOf(period, filter, version, windowStart, endTime);
    const rows = pairsOf(filter).map((pair): MarketsLiveRow => {
      const { g, base, counter } = pair;
      const native = nativeOf(pair);
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
        amm_share: ammKnown ? (shares.get(pairKey(g)) ?? null) : null,
        amm_pool: ammKnown ? (pooled.has(pairKey(g)) ? 1 : 0) : null,
      };
    });
    const sentinel: MarketsLiveRow = {
      ...frame,
      pairs_traded: rows.length,
      total_count: totalCount,
      total_native_volume: totalNative.toString(),
      total_amm_share: ammKnown ? totalAmmShare : null,
    };
    return [sentinel, ...rows];
  };

  const versions = await Promise.all(
    WRITE_ORDER.map((filter) => nextSetVersion(ch, Table.MarketsLive, SET_OF_PERIOD, { period, amm: filter })),
  );
  const written = WRITE_ORDER.map((filter, i) => rowsOf(filter, versions[i]));
  for (const rows of written) {
    throwIfSetAborted(signal);
    await ch.insert(Table.MarketsLive, rows);
  }
  return {
    written: true,
    pairs: pairsOf('include').length,
    startTime: windowStart,
    endTime,
    ammShareKnown: ammKnown,
  };
}

/**
 * The `end_time` of the newest `include` set of each period, unix seconds (the newest by version: a set that was written
 * twice counts once, and a set of another filter does not count). A period that has no set is not in the map. The runner
 * goes through the periods in the order day, 7day, 30day, and reads this for the age of each set it reports.
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

/**
 * For each period, whether the newest `include` set (by version, as `marketsSetEndTimes` takes it) has its AMM fields:
 * its sentinel has a `total_amm_share` (the parser gate let them through). A period that has no set is not in the map.
 */
export async function marketsAmmShareKnown(ch: ClickHouseService): Promise<Map<MarketsPeriod, boolean>> {
  const rows = await ch.query<{ period: string; known: number | string }>(
    `SELECT period, toUInt8(isNotNull(total_amm_share)) AS known
       FROM ${Table.MarketsLive}
      WHERE amm = 'include' AND ${SENTINEL}
      ORDER BY period, version DESC
      LIMIT 1 BY period`,
  );
  const known = new Map<MarketsPeriod, boolean>();
  for (const period of MARKETS_PERIODS) {
    const row = rows.find((r) => r.period === period);
    if (row) known.set(period, Number(row.known) === 1);
  }
  return known;
}
