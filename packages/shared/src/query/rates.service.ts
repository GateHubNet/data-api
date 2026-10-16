import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { Asset, assetKey, canonicalPair } from './asset';
import { ratio, VOLUME_SOURCE_COLUMNS, volumeColumns, volumesOf, VolumeSums } from './decimal';

/** The rolling windows of `period`, as the Ripple `/v2/exchange_rates` takes them. */
export type RatePeriod = 'hour' | 'day' | '3day' | '7day' | '30day';
export const RATE_PERIODS: readonly RatePeriod[] = ['hour', 'day', '3day', '7day', '30day'];

const PERIOD_MS: Record<RatePeriod, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  '3day': 3 * 86_400_000,
  '7day': 7 * 86_400_000,
  '30day': 30 * 86_400_000,
};

export interface RateOptions {
  /** The moment the rate is as of. Default: now. */
  date?: Date;
  /**
   * Where the period `date` names ends, exclusive: `date` is the start of what the client wrote (`2015-01-14` is a day,
   * `2015-01-14T18` an hour), and the original read up to the end of it. Default: the second after `date`, so the
   * trades that closed at or before it.
   */
  endExclusive?: Date;
  /** Count the last trades only when there are at least 10 of them (default), or whatever there are (`false`). */
  strict?: boolean;
  /** A rolling window ending a second before `date` instead of the daily and the latest rate. */
  period?: RatePeriod;
  /** Skip the daily rate: only the latest trades count. */
  live?: boolean;
}

export type NormalizeOptions = Pick<RateOptions, 'date' | 'endExclusive' | 'strict'>;

/** The trades of a window, for the pair as it was asked for. */
export interface Vwap {
  /** Counter volume over base volume; 0 when there is no base volume. */
  vwap: BigNumber;
  /** How many trades. */
  count: number;
  baseVolume: BigNumber;
  counterVolume: BigNumber;
}

/** The last trades the latest rate is made of, and how many of them it takes (strict). */
export const LATEST_TRADES = 50;
export const LATEST_MIN_TRADES = 10;
/** How far back the latest trades are looked for. */
export const LATEST_DAYS = 14;

/** A trade whose native leg is this or less is rounding noise ("tiny amounts that exist from rounding errors in XRP"). */
const NATIVE_DUST = '0.0005';

const SECOND_MS = 1000;
const DAY_MS = 86_400_000;
const MAX_UINT32 = 4_294_967_295;
/** `dailyNativeRates` answers a day at a time: a range this long is a mistake. */
const MAX_DAYS = 3660;
/** At most this many queries of one `dailyNativeRates` run at once. */
const CONCURRENCY = 6;

const ZERO = new BigNumber(0);
const ONE = new BigNumber(1);

const floorSecond = (ms: number): number => Math.floor(ms / SECOND_MS) * SECOND_MS;
const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function timeOf(date: Date): number {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new RangeError('Invalid date');
  return ms;
}

/** A window of time in milliseconds: from inclusive, to exclusive. Both are whole seconds. */
export interface RateWindow {
  from: number;
  toExclusive: number;
}

/**
 * The window of a rolling `period` (`getExchangeRate` of the original, with `period`): it ends a second before `date`
 * and is as long as the period, to the second, as its row keys were.
 */
export function periodWindow(date: Date, period: RatePeriod): RateWindow {
  const end = floorSecond(timeOf(date));
  return { from: end - SECOND_MS - PERIOD_MS[period], toExclusive: end };
}

/**
 * The window of the daily rate: from the start of the day of `date` up to `endExclusive` (the second after `date`
 * unless the client wrote a coarser date), but not past that day. A date that names a month or a year therefore reads
 * the first day of it only; the original's `limit: 1` scan of the daily rows took the first day WITH trades (another
 * day when the first has none), a deviation that was left as it is.
 */
export function dailyWindow(date: Date, endExclusive?: Date): RateWindow {
  const at = floorSecond(timeOf(date));
  const from = startOfDay(at);
  const end = endExclusive === undefined ? at + SECOND_MS : floorSecond(timeOf(endExclusive));
  return { from, toExclusive: Math.min(end, from + DAY_MS) };
}

/** The window the latest trades are looked for in: the 14 days before `date`, up to `endExclusive`. */
export function latestWindow(date: Date, endExclusive?: Date): RateWindow {
  const at = floorSecond(timeOf(date));
  const end = endExclusive === undefined ? at + SECOND_MS : floorSecond(timeOf(endExclusive));
  return { from: at - LATEST_DAYS * DAY_MS, toExclusive: end };
}

/** The rate: the average of the daily and the latest rate when both are known, else the latest. */
export function combineRates(daily: BigNumber, latest: BigNumber): BigNumber {
  // `times` is exact; a division would keep 20 decimal places only
  return daily.gt(0) && latest.gt(0) ? daily.plus(latest).times('0.5') : latest;
}

/** The pair as it is stored: the sides are in the canonical order, and `inverted` says the caller asked the other way. */
interface StoredPair {
  base: Asset;
  counter: Asset;
  inverted: boolean;
}

const PAIR_COLUMNS = ['base_currency', 'base_issuer', 'counter_currency', 'counter_issuer'];
const KEY_COLUMNS = [...PAIR_COLUMNS, 'ledger_index', 'tx_index', 'node_index'];
const PAIR_WHERE = PAIR_COLUMNS.map((column, i) => `${column} = {pair${i}:String}`);

function pairParams(stored: StoredPair): Record<string, string> {
  return {
    pair0: stored.base.currency,
    pair1: stored.base.issuer ?? '',
    pair2: stored.counter.currency,
    pair3: stored.counter.issuer ?? '',
  };
}

/**
 * The conditions an exchange has to meet to count: its native leg (the side without an issuer) is more than 0.0005.
 * The original left the rounding noise out of every volume, with `<=` in its aggregation and `<` in its reduce; `<=`
 * is used for both.
 */
function keepConditions(stored: StoredPair): string[] {
  return [
    ...(stored.base.issuer ? [] : [`base_amount_f > ${NATIVE_DUST}`]),
    ...(stored.counter.issuer ? [] : [`counter_amount_f > ${NATIVE_DUST}`]),
  ];
}

/** The whole key of `exchanges`, spelled out: ClickHouse then reads in the order of the primary key and does not sort. */
const orderBy = (descending: boolean): string =>
  KEY_COLUMNS.map((c) => `${c} ${descending ? 'DESC' : 'ASC'}`).join(', ');

/** The ledgers of a window of time: the first index to the last, both inclusive. */
export interface LedgerRange {
  min: number;
  max: number;
}

/** The buckets `bucketVwaps` groups by: a UTC day, a week from Monday, a calendar month. */
export type VwapBucket = 'day' | 'week' | 'month';

/** The expression of `close_time` (a `DateTime('UTC')`) that is the unix time of its bucket's start. */
const BUCKET_START: Record<VwapBucket, string> = {
  day: 'toUnixTimestamp(toStartOfDay(close_time))',
  week: "toUnixTimestamp(toDateTime(toMonday(close_time), 'UTC'))",
  month: "toUnixTimestamp(toDateTime(toStartOfMonth(close_time), 'UTC'))",
};

/**
 * Both native legs above the dust, spelled for any pair (a side is native when it has no issuer, as `keepConditions`
 * has it): what the grouped reads (`vwaps`, `bucketVwaps`) keep, one condition for all the pairs of the group.
 */
const KEEP_ANY_PAIR = `(base_issuer != '' OR base_amount_f > ${NATIVE_DUST}) AND (counter_issuer != '' OR counter_amount_f > ${NATIVE_DUST})`;

/** The pair columns and the sums of one group of `vwaps`. */
interface PairSumsRow extends VolumeSums {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
}

const storedKey = (s: StoredPair): string =>
  [s.base.currency, s.base.issuer ?? '', s.counter.currency, s.counter.issuer ?? ''].join('\u0000');

/** One group of `dayRows`: the sums of a day of trades and the first and last ledger of all its trades. */
interface DayRow extends VolumeSums {
  day: string;
  first_ledger: number;
  last_ledger: number;
}

/** The trades of a pair as a rate sees them: oriented as asked for (stored base and counter swap when inverted). */
function orient(row: VolumeSums, inverted: boolean): Vwap {
  const v = volumesOf(row);
  const [baseVolume, counterVolume] = inverted ? [v.counter, v.base] : [v.base, v.counter];
  return {
    vwap: baseVolume.isZero() ? ZERO : ratio(counterVolume, baseVolume),
    count: row.n,
    baseVolume,
    counterVolume,
  };
}

const NO_TRADES: VolumeSums = { n: 0, base_sum: null, counter_sum: null, unfit: 0, base_sum_f: 0, counter_sum_f: 0 };

/** The days of `[fromDay, toDayExclusive)`, the first cut back to its UTC midnight. */
function utcDays(fromDay: Date, toDayExclusive: Date): { key: string; ms: number }[] {
  const to = timeOf(toDayExclusive);
  const days: { key: string; ms: number }[] = [];
  for (let ms = startOfDay(timeOf(fromDay)); ms < to; ms += DAY_MS) {
    if (days.length >= MAX_DAYS) throw new RangeError(`More than ${MAX_DAYS} days`);
    days.push({ key: dayKey(ms), ms });
  }
  return days;
}

/** `fn` over `items`, at most `limit` at a time; the results come in the order of the items. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Exchange rates from the trades in `exchanges` (`getExchangeRate` and `normalize` of the Ripple Data API, which read
 * the same from HBase's `agg_exchanges`). The API serves them, and the syncer's aggregator reuses them for the volume
 * jobs, so this is a plain class: wrap it in a provider.
 *
 * The trades of a pair are a range of the primary key of `exchanges` (the pair is the start of it, in the canonical
 * order, and a pair asked for the other way round is read as it is stored and its volumes swapped). The dates become a
 * range of ledgers before the query, from `ledgers`, and the last 50 trades are read in reverse key order and stop
 * after 50, so a rate costs what its own trades cost, not the history of the pair.
 *
 * Volumes are exact sums of the stored amounts (a Float64 sum when an amount does not fit a decimal, see
 * `./decimal`), so a rate does not change in its last digits between two requests.
 */
export class RatesService {
  constructor(
    private readonly ch: ClickHouseService,
    /** `XRP` or `XAH`: the currency every rate is converted through. It has no issuer. */
    readonly nativeCurrency: string,
  ) {}

  /**
   * How many `counter` one `base` buys, as of `date`: 1 for the same asset; else, as the original had it:
   *  - with `period`, the vwap of the window that ends a second before `date`;
   *  - else the daily vwap (the trades from the start of the day of `date` up to it; none with `live`) and the latest
   *    vwap (the last 50 trades in the 14 days before it, counted only when there are 10 of them, unless
   *    `strict: false`). The rate is the average of the two when both are above 0, else the latest.
   * 0 when nothing can be told. The original answered the same asset with a `period` with 0 (it looked up trades of a
   * pair with itself), which is fixed here.
   */
  async exchangeRate(base: Asset, counter: Asset, o: RateOptions = {}): Promise<BigNumber> {
    if (assetKey(base) === assetKey(counter)) return ONE;
    const date = o.date ?? new Date();
    const stored = canonicalPair(base, counter);

    if (o.period !== undefined) {
      const w = periodWindow(date, o.period);
      return (await this.window(stored, w)).vwap;
    }

    const strict = o.strict !== false;
    const [daily, latest] = await Promise.all([
      o.live ? ZERO : this.window(stored, dailyWindow(date, o.endExclusive)).then((v) => v.vwap),
      this.window(stored, latestWindow(date, o.endExclusive), LATEST_TRADES).then((v) =>
        strict && v.count < LATEST_MIN_TRADES ? ZERO : v.vwap,
      ),
    ]);
    return combineRates(daily, latest);
  }

  /**
   * The volume weighted average price of a pair over the trades that closed in `[from, toExclusive)`, the pair as it was
   * asked for. Both are read to the second, as the original's row keys were. A trade whose native leg is 0.0005 or less
   * is left out.
   */
  async vwap(base: Asset, counter: Asset, from: Date, toExclusive: Date): Promise<Vwap> {
    return this.window(canonicalPair(base, counter), {
      from: floorSecond(timeOf(from)),
      toExclusive: floorSecond(timeOf(toExclusive)),
    });
  }

  /**
   * The same as `vwap` for many pairs of one window, in one read of the exchanges (the volume jobs ask for a window of
   * every market they list): the window is turned into ledgers once, and the pairs are grouped by the database. The
   * answers come in the order of `pairs`; a pair may be there twice, or the other way round as well.
   */
  async vwaps(pairs: { base: Asset; counter: Asset }[], from: Date, toExclusive: Date): Promise<Vwap[]> {
    const w = { from: floorSecond(timeOf(from)), toExclusive: floorSecond(timeOf(toExclusive)) };
    if (pairs.length === 0) return [];
    const stored = pairs.map((p) => canonicalPair(p.base, p.counter));
    const range = await this.ledgerRange(w.from, w.toExclusive);
    const sums = range ? await this.pairSums(stored, range) : new Map<string, VolumeSums>();
    return stored.map((s) => orient(sums.get(storedKey(s)) ?? NO_TRADES, s.inverted));
  }

  /**
   * The vwap of a pair in each `bucket` (a UTC day, a week from Monday, a calendar month) of the window, in one read: a
   * map from the unix time of the start of a bucket to its vwap, the pair as asked for, in the order of the buckets.
   * A bucket without a trade (or whose trades are all native dust) is not in it. Pass whole buckets: the trades that
   * closed in `[from, toExclusive)` count, to the second, and a bucket is the sum of those that fall in it.
   */
  async bucketVwaps(
    base: Asset,
    counter: Asset,
    from: Date,
    toExclusive: Date,
    bucket: VwapBucket,
  ): Promise<Map<number, BigNumber>> {
    const w = { from: floorSecond(timeOf(from)), toExclusive: floorSecond(timeOf(toExclusive)) };
    const stored = canonicalPair(base, counter);
    const out = new Map<number, BigNumber>();
    const range = await this.ledgerRange(w.from, w.toExclusive);
    if (!range) return out;
    const keep = keepConditions(stored);
    const rows = await this.ch.query<VolumeSums & { bucket: number | string }>(
      `SELECT ${BUCKET_START[bucket]} AS bucket,
              ${volumeColumns(keep.length > 0 ? keep.join(' AND ') : undefined)}
         FROM (SELECT close_time, ${VOLUME_SOURCE_COLUMNS}
                 FROM ${Table.Exchanges}
                WHERE ${[...PAIR_WHERE, 'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}'].join(' AND ')}
                ORDER BY ${orderBy(false)}
                LIMIT 1 BY ${KEY_COLUMNS.join(', ')})
        GROUP BY bucket
        ORDER BY bucket`,
      { ...pairParams(stored), min: range.min, max: range.max },
    );
    for (const row of rows) {
      const v = orient(row, stored.inverted);
      if (v.count > 0) out.set(Number(row.bucket), v.vwap);
    }
    return out;
  }

  /**
   * The ledgers that closed in `[from, toExclusive)`, to the second (the first index to the last), `null` when none did.
   * The volume jobs resolve a window once and read the payments with it.
   */
  ledgersClosedIn(from: Date, toExclusive: Date): Promise<LedgerRange | null> {
    return this.ledgerRange(floorSecond(timeOf(from)), floorSecond(timeOf(toExclusive)));
  }

  /**
   * `amount` of `from` in `to`, through the native currency: `rate = rate(from → native) / rate(to → native)` and
   * `converted = amount * rate`. The same asset is 1; a `to` that has no rate gives 0.
   */
  async normalize(
    amount: BigNumber,
    from: Asset,
    to: Asset,
    o: NormalizeOptions = {},
  ): Promise<{ rate: BigNumber; converted: BigNumber }> {
    if (assetKey(from) === assetKey(to)) return { rate: ONE, converted: amount };
    const [fromRate, toRate] = await Promise.all([this.nativeRate(from, o), this.nativeRate(to, o)]);
    const rate = toRate.isZero() ? ZERO : ratio(fromRate, toRate);
    return { rate, converted: amount.times(rate) };
  }

  /**
   * The rate of each asset against the native currency, a UTC day at a time: how many units of the asset one native
   * coin buys at the end of the day. It is the rate of `exchangeRate(native, asset, { date: day })` with a date that
   * names the day (the day's trades and the last 50 within 14 days of its end, strict); 0 when there is none, and 1 for
   * the native currency.
   *
   * The days run from the UTC day of `fromDay` up to `toDayExclusive`. The answer is `assetKey -> YYYY-MM-DD -> rate`
   * with an entry for every asset and day. The trades of an asset are read in one query for all the days; only the
   * "last 50" of a day whose window changed is read again.
   */
  async dailyNativeRates(
    assets: Asset[],
    fromDay: Date,
    toDayExclusive: Date,
  ): Promise<Map<string, Map<string, BigNumber>>> {
    const days = utcDays(fromDay, toDayExclusive);
    const wanted = new Map(assets.map((asset) => [assetKey(asset), asset]));
    const out = new Map<string, Map<string, BigNumber>>();
    for (const [key, asset] of wanted) {
      out.set(
        key,
        this.isNative(asset)
          ? new Map(days.map((day) => [day.key, ONE]))
          : await this.dailyRatesOf({ currency: this.nativeCurrency }, asset, days),
      );
    }
    return out;
  }

  private isNative(asset: Asset): boolean {
    return asset.currency === this.nativeCurrency && !asset.issuer;
  }

  /** How many native coins one unit of `asset` buys: `rate(asset → native)`. */
  private nativeRate(asset: Asset, o: NormalizeOptions): Promise<BigNumber> {
    if (this.isNative(asset)) return Promise.resolve(ONE);
    return this.exchangeRate(asset, { currency: this.nativeCurrency }, o);
  }

  /** The trades in a window (or the `newest` of them) as a vwap. */
  private async window(stored: StoredPair, w: RateWindow, newest?: number): Promise<Vwap> {
    const range = await this.ledgerRange(w.from, w.toExclusive);
    return orient(range ? await this.sums(stored, range, newest) : NO_TRADES, stored.inverted);
  }

  /**
   * The sums of the trades of a stored pair in a range of ledgers, or of the `newest` of them. Each trade counts once
   * (`LIMIT 1 BY` the key: the table is not collapsed before a merge, and no FINAL is used).
   *
   * Without `newest`, the trades of a native leg of 0.0005 or less are left out first. With it, the newest are taken
   * first and then the noise is left out of them, as the original did (its reduce filtered the 50 rows it had scanned):
   * the newest 50 are read in reverse key order and the read stops after 50.
   */
  private async sums(stored: StoredPair, range: LedgerRange, newest?: number): Promise<VolumeSums> {
    const keep = keepConditions(stored);
    const where = [...PAIR_WHERE, 'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}'];
    const source = (conditions: string[], descending: boolean, limit: string): string =>
      `SELECT ${VOLUME_SOURCE_COLUMNS}
         FROM ${Table.Exchanges}
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy(descending)}
        LIMIT 1 BY ${KEY_COLUMNS.join(', ')}${limit}`;
    const params: Record<string, unknown> = { ...pairParams(stored), min: range.min, max: range.max };
    let sql: string;
    if (newest === undefined) {
      sql = `SELECT ${volumeColumns()} FROM (${source([...where, ...keep], false, '')})`;
    } else {
      params.newest = newest;
      sql =
        `SELECT ${volumeColumns()} FROM (${source(where, true, '\n        LIMIT {newest:UInt32}')})` +
        (keep.length > 0 ? ` WHERE ${keep.join(' AND ')}` : '');
    }
    const [row] = await this.ch.query<VolumeSums>(sql, params);
    return row ?? NO_TRADES;
  }

  /**
   * The sums of the trades of some stored pairs in a range of ledgers, one group per pair: one read, each trade once
   * (`LIMIT 1 BY` the key), the native legs of 0.0005 or less left out. The pairs are matched as the start of the primary
   * key, so the read is bounded by their own trades.
   */
  private async pairSums(pairs: StoredPair[], range: LedgerRange): Promise<Map<string, VolumeSums>> {
    const unique = [...new Map(pairs.map((p) => [storedKey(p), p])).values()];
    // The pairs go in as four arrays of text and are zipped back into tuples by the server: a tuple parameter is a class of
    // the client, which a second copy of the client (two module registries in one process) does not recognise.
    const rows = await this.ch.query<PairSumsRow>(
      `SELECT ${PAIR_COLUMNS.join(', ')}, ${volumeColumns(KEEP_ANY_PAIR)}
         FROM (SELECT ${PAIR_COLUMNS.join(', ')}, ${VOLUME_SOURCE_COLUMNS}
                 FROM ${Table.Exchanges}
                WHERE (${PAIR_COLUMNS.join(', ')}) IN (
                      SELECT arrayJoin(arrayZip({pair0:Array(String)}, {pair1:Array(String)}, {pair2:Array(String)}, {pair3:Array(String)})))
                  AND ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
                ORDER BY ${orderBy(false)}
                LIMIT 1 BY ${KEY_COLUMNS.join(', ')})
        GROUP BY ${PAIR_COLUMNS.join(', ')}`,
      {
        pair0: unique.map((p) => p.base.currency),
        pair1: unique.map((p) => p.base.issuer ?? ''),
        pair2: unique.map((p) => p.counter.currency),
        pair3: unique.map((p) => p.counter.issuer ?? ''),
        min: range.min,
        max: range.max,
      },
    );
    return new Map(
      rows.map((r) => [[r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer].join('\u0000'), r]),
    );
  }

  /**
   * The ledgers that closed in `[from, toExclusive)` (milliseconds, whole seconds): the first one closed at or after
   * `from` to the last one closed before `toExclusive`. Close times never decrease with the ledger index, so that is
   * one contiguous range. `null` when no ledger closed in the window.
   */
  private async ledgerRange(from: number, toExclusive: number): Promise<LedgerRange | null> {
    const first = Math.max(from / SECOND_MS, 0);
    const before = Math.min(toExclusive / SECOND_MS, MAX_UINT32);
    if (first > MAX_UINT32 || before <= 0) return null;
    const [min, max] = await Promise.all([
      this.ch.queryOne<{ ledger_index: number }>(
        `SELECT ledger_index FROM ${Table.Ledgers}
          WHERE close_time >= toDateTime({secs:UInt32}, 'UTC') ORDER BY ledger_index ASC LIMIT 1`,
        { secs: first },
      ),
      this.ch.queryOne<{ ledger_index: number }>(
        `SELECT ledger_index FROM ${Table.Ledgers}
          WHERE close_time < toDateTime({secs:UInt32}, 'UTC') ORDER BY ledger_index DESC LIMIT 1`,
        { secs: before },
      ),
    ]);
    if (!min || !max || min.ledger_index > max.ledger_index) return null;
    return { min: min.ledger_index, max: max.ledger_index };
  }

  /**
   * The rate of every day against the native currency, for one asset: `exchangeRate(native, asset)` of each day.
   *
   * One grouped query gives, for every day with a trade, its sums and the first and last ledger of its trades. The
   * daily rate is the vwap of the day. The latest rate of a day needs the last 50 trades in the window of 14 days up to
   * its end: the window is the ledgers between the first trade of the first of those days and the last trade of the
   * last, and two days with the same ledgers share one query.
   */
  private async dailyRatesOf(
    native: Asset,
    asset: Asset,
    days: { key: string; ms: number }[],
  ): Promise<Map<string, BigNumber>> {
    const rates = new Map<string, BigNumber>();
    if (days.length === 0) return rates;
    const stored = canonicalPair(native, asset);
    const range = await this.ledgerRange(days[0].ms - LATEST_DAYS * DAY_MS, days[days.length - 1].ms + DAY_MS);
    const rows = range ? await this.dayRows(stored, range) : [];
    const byDay = new Map(rows.map((row) => [row.day, row]));

    const latest = new Map<string, Promise<BigNumber>>();
    const latestOf = (ms: number): Promise<BigNumber> => {
      let min: number | undefined;
      let max: number | undefined;
      for (let back = 0; back <= LATEST_DAYS; back++) {
        const row = byDay.get(dayKey(ms - back * DAY_MS));
        if (!row) continue;
        min = min === undefined ? row.first_ledger : Math.min(min, row.first_ledger);
        max = max === undefined ? row.last_ledger : Math.max(max, row.last_ledger);
      }
      if (min === undefined || max === undefined) return Promise.resolve(ZERO);
      const key = `${min}:${max}`;
      let found = latest.get(key);
      if (!found) {
        found = this.sums(stored, { min, max }, LATEST_TRADES).then((row) => {
          const v = orient(row, stored.inverted);
          return v.count < LATEST_MIN_TRADES ? ZERO : v.vwap;
        });
        latest.set(key, found);
      }
      return found;
    };

    await mapLimit(days, CONCURRENCY, async (day) => {
      const row = byDay.get(day.key);
      const daily = row ? orient(row, stored.inverted).vwap : ZERO;
      rates.set(day.key, combineRates(daily, await latestOf(day.ms)));
    });
    // in the order of the days, whatever order the queries finished in
    return new Map(days.map((day) => [day.key, rates.get(day.key) as BigNumber]));
  }

  /**
   * The trades of a stored pair in a range of ledgers, a row per UTC day: the sums of the trades that count (a native
   * leg of more than 0.0005), and the first and last ledger of all of them, which bound the window of a day's last 50.
   */
  private async dayRows(stored: StoredPair, range: LedgerRange): Promise<DayRow[]> {
    const keep = keepConditions(stored);
    return this.ch.query<DayRow>(
      `SELECT toString(toDate(close_time)) AS day,
              ${volumeColumns(keep.length > 0 ? keep.join(' AND ') : undefined)},
              min(ledger_index) AS first_ledger, max(ledger_index) AS last_ledger
         FROM (SELECT close_time, ledger_index, ${VOLUME_SOURCE_COLUMNS}
                 FROM ${Table.Exchanges}
                WHERE ${[...PAIR_WHERE, 'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}'].join(' AND ')}
                ORDER BY ${orderBy(false)}
                LIMIT 1 BY ${KEY_COLUMNS.join(', ')})
        GROUP BY day
        ORDER BY day`,
      { ...pairParams(stored), min: range.min, max: range.max },
    );
  }
}
