import BigNumber from 'bignumber.js';
import { RATES_DAILY_CONFIG_VERSION, validRateDays } from '../aggregate/rates-daily.job';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { Asset, assetKey } from './asset';
import { RatesService } from './rates.service';

/**
 * The rate of assets against the native currency for UTC days, as the account and market endpoints value with it.
 *
 * A closed day has a **set** in `native_rates_daily` (`rates-daily.job.ts`) when the syncer's aggregator has made one and it
 * is still valid. `DailyRates` reads those in one query, and computes the days that have none (not made yet, marked stale,
 * or of another config version) with `RatesService.dailyNativeRates`, which gives the same rates the sets are made of.
 */

/** `assetKey -> YYYY-MM-DD -> units of the asset per native coin`. */
export type DayRates = Map<string, Map<string, BigNumber>>;

/** The part of `CacheService` that `DailyRates` uses. */
export interface RateCache {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlMs: number): void;
}

export interface DailyRatesOptions {
  /** Keeps what is computed on read for `ON_READ_CACHE_MS`, per asset and day. Default: nothing is kept. */
  cache?: RateCache;
  /** Called with the number of asset-days computed on read, once per `rates` call that computed any. */
  onRead?: (assetDays: number) => void;
}

/** An asset on a day (`YYYY-MM-DD`): what a caller of `DailyRates.rateRowsSql` needs the rate of. */
export interface AssetDay {
  asset: Asset;
  day: string;
}

/**
 * The rates of assets on days as rows for a SQL join (`DailyRates.rateRowsSql`): a subquery of `currency`, `issuer`, `day`
 * and `rate_f` (the rate as a Float64), the parameters it names (all prefixed `dr_`), and what was computed on read.
 */
export interface RateRows {
  /**
   * What was computed on read, as `rates` has it, and only that: the asked asset-days of the issued assets that have no valid
   * set, 0 where an asset has no rate. The valid days are rows of the SQL and are not here; the native currency is 1 on the
   * days it was asked for.
   */
  rates: DayRates;
  /** `SELECT currency, issuer, day, rate_f ...`, to use as a subquery. Each (currency, issuer, day) is in it once. */
  sql: string;
  params: Record<string, unknown>;
}

/** How long an asset-day computed on read is kept: it is a day that is not closed or not final yet, or has no set. */
export const ON_READ_CACHE_MS = 60_000;
/** The most days of one asset that one `dailyNativeRates` call is asked for (it answers 3660 at most). */
export const ON_READ_RUN_DAYS = 3000;
/** At most this many `dailyNativeRates` calls of one `rates` call run at once. */
const ON_READ_CONCURRENCY = 4;

const DAY_MS = 86_400_000;
const ZERO = new BigNumber(0);
const ONE = new BigNumber(1);

/** The rows of the rates a SQL join reads, when there are none: no asset, no day, or nothing issued. */
const NO_RATE_ROWS = "SELECT '' AS currency, '' AS issuer, toDate('1970-01-01') AS day, toFloat64(0) AS rate_f WHERE 0";

/**
 * The rows of the assets `{dr_asset_currencies}` and `{dr_asset_issuers}` for the valid days between `{dr_from}` and
 * `{dr_through}` that are not computed on read (`{dr_read_days}`). The valid days are found in the SQL itself, from the
 * sentinels of the range (the newest of each day, not stale, of the current config version), and a day's rows are those of
 * its sentinel's version: nothing per day is passed. Each (currency, issuer, day) once.
 */
const STORED_RATE_ROWS = `SELECT toString(currency) AS currency, issuer, day, rate_f
  FROM (SELECT currency, issuer, day, rate_f
          FROM ${Table.NativeRatesDaily}
         WHERE (currency, issuer) IN (SELECT arrayJoin(arrayZip({dr_asset_currencies:Array(String)}, {dr_asset_issuers:Array(String)})))
           AND day BETWEEN {dr_from:Date} AND {dr_through:Date}
           AND NOT has({dr_read_days:Array(Date)}, day)
           AND (day, version) IN (SELECT day, version
                                    FROM (SELECT day, version, stale, config_version
                                            FROM ${Table.NativeRatesDaily}
                                           WHERE currency = '' AND issuer = '' AND day BETWEEN {dr_from:Date} AND {dr_through:Date}
                                           ORDER BY currency, issuer, day, version DESC
                                           LIMIT 1 BY day)
                                   WHERE stale = 0 AND config_version = {dr_config_version:UInt32})
           AND rate_f > 0
         ORDER BY currency, issuer, day
         LIMIT 1 BY currency, issuer, day)`;

/** The asset-days computed on read, one row each: `{dr_currencies}`, `{dr_issuers}`, `{dr_days}` and `{dr_rates}` side by side. */
const READ_RATE_ROWS = `SELECT t.1 AS currency, t.2 AS issuer, t.3 AS day, t.4 AS rate_f
  FROM (SELECT arrayJoin(arrayZip({dr_currencies:Array(String)}, {dr_issuers:Array(String)}, {dr_days:Array(Date)}, {dr_rates:Array(Float64)})) AS t)`;

const midnightOf = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const cacheKeyOf = (key: string, day: string): string => `daily-rate:${key}:${day}`;

/** The days (`YYYY-MM-DD`, ascending) as runs of consecutive days, none longer than `ON_READ_RUN_DAYS`. */
function runsOf(days: string[]): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  let previous = NaN;
  for (const day of days) {
    const ms = midnightOf(day);
    if (run.length > 0 && (ms !== previous + DAY_MS || run.length >= ON_READ_RUN_DAYS)) {
      runs.push(run);
      run = [];
    }
    run.push(day);
    previous = ms;
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** `fn` over `items`, at most `limit` at a time. */
async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class DailyRates {
  /** `XRP` or `XAH`: the currency every rate is against. It is worth 1 on every day. */
  readonly nativeCurrency: string;

  constructor(
    private readonly ch: ClickHouseService,
    private readonly ratesService: RatesService,
    private readonly options: DailyRatesOptions = {},
  ) {
    this.nativeCurrency = ratesService.nativeCurrency;
  }

  /**
   * The rate of each asset on each of the days (`YYYY-MM-DD`): how many units of the asset one native coin buys, with an
   * entry for every asset and day asked for. It is 1 for the native currency and 0 where an asset has no rate (an issued
   * currency without an issuer has none).
   *
   * (1) The valid days of the range come from one read of `validRateDays`. (2) The rows of the assets for the valid days
   * come from one read of the table, each of the set that the day's sentinel names. (3) Every other day, for each asset
   * that is not in the cache, is computed with `dailyNativeRates` in runs of consecutive days, and kept for a minute.
   */
  async rates(assets: Asset[], days: string[]): Promise<DayRates> {
    const wanted = [...new Set(days)].sort();
    const out: DayRates = new Map();
    const issued = new Map<string, Asset>();
    for (const asset of assets) {
      const key = assetKey(asset);
      if (out.has(key)) continue;
      const native = asset.currency === this.nativeCurrency && !asset.issuer;
      out.set(key, new Map(wanted.map((day) => [day, native ? ONE : ZERO])));
      if (!native && asset.issuer) issued.set(key, asset);
    }
    if (issued.size === 0 || wanted.length === 0) return out;

    const valid = await validRateDays(this.ch, wanted[0], wanted[wanted.length - 1]);
    const stored = wanted.filter((day) => valid.has(day));
    if (stored.length > 0) await this.readSets(out, [...issued.values()], stored, valid);
    const missing = wanted.filter((day) => !valid.has(day));
    if (missing.length > 0) {
      await this.computeOnRead(
        out,
        [...issued].map(([key, asset]) => ({ key, asset, days: missing })),
      );
    }
    return out;
  }

  /**
   * The rates of the asset-days a caller needs, for a SQL that joins them to rows (a route that ranks in SQL by value): a
   * subquery of `currency`, `issuer`, `day` and `rate_f` with a row for each of them that has a rate above 0, and its
   * parameters. The same rates as `rates` gives, but for the pairs asked for, not for every asset on every day: an asset that
   * was paid on one day and another on another are two asset-days, not four.
   *
   * What is stored is not read here. The rows of the valid days are selected by the SQL itself, from the sentinels of the
   * range, so no list of days or versions travels in the parameters (they go in the URL, whose size is limited); only the
   * asked asset-days computed on read are passed, as arrays (`dr_currencies`, `dr_issuers`, `dr_days`, `dr_rates`), each with
   * its rate above 0. The stored rows are those of the assets that have an asked day with a valid set, between the first and
   * the last such day (the join takes the rows it needs). A day with an asked asset-day computed on read is left out of the
   * stored rows (`dr_read_days`), so that a day that becomes valid between the two reads is in one of them only.
   * The one read made here is `validRateDays`, which tells the days to compute; they go through the cache of the rates as
   * the days of `rates` do. The native currency and an issued currency without an issuer have no rows.
   */
  async rateRowsSql(pairs: AssetDay[]): Promise<RateRows> {
    const out: DayRates = new Map();
    // the issued assets, each with the days it was asked for
    const issued = new Map<string, { asset: Asset; days: Set<string> }>();
    for (const { asset, day } of pairs) {
      const key = assetKey(asset);
      const perDay = out.get(key) ?? new Map<string, BigNumber>();
      out.set(key, perDay);
      if (!asset.issuer) {
        perDay.set(day, asset.currency === this.nativeCurrency ? ONE : ZERO);
        continue;
      }
      const found = issued.get(key) ?? { asset, days: new Set<string>() };
      found.days.add(day);
      issued.set(key, found);
    }
    const wanted = [...new Set([...issued.values()].flatMap((i) => [...i.days]))].sort();
    if (wanted.length === 0) return { rates: out, sql: NO_RATE_ROWS, params: {} };

    const valid = await validRateDays(this.ch, wanted[0], wanted[wanted.length - 1]);
    const read = wanted.filter((day) => !valid.has(day));
    const targets = [...issued].map(([key, { asset, days }]) => ({
      key,
      asset,
      days: [...days].filter((day) => !valid.has(day)).sort(),
    }));
    await this.computeOnRead(
      out,
      targets.filter((t) => t.days.length > 0),
    );

    const parts: string[] = [];
    const params: Record<string, unknown> = {};
    // the assets with an asked day that is valid, and the first and last of those days
    const stored = [...issued.values()].filter((i) => [...i.days].some((day) => valid.has(day)));
    if (stored.length > 0) {
      const storedDays = wanted.filter((day) => valid.has(day));
      parts.push(STORED_RATE_ROWS);
      Object.assign(params, {
        dr_asset_currencies: stored.map((i) => i.asset.currency),
        dr_asset_issuers: stored.map((i) => i.asset.issuer),
        dr_from: storedDays[0],
        dr_through: storedDays[storedDays.length - 1],
        dr_read_days: read,
        dr_config_version: RATES_DAILY_CONFIG_VERSION,
      });
    }
    const rows = { currencies: [] as string[], issuers: [] as string[], days: [] as string[], rates: [] as number[] };
    for (const { key, asset, days } of targets) {
      for (const day of days) {
        const rate = out.get(key)?.get(day)?.toNumber();
        if (rate === undefined || !(rate > 0) || !Number.isFinite(rate)) continue;
        rows.currencies.push(asset.currency);
        rows.issuers.push(asset.issuer as string);
        rows.days.push(day);
        rows.rates.push(rate);
      }
    }
    if (rows.days.length > 0) {
      parts.push(READ_RATE_ROWS);
      Object.assign(params, {
        dr_currencies: rows.currencies,
        dr_issuers: rows.issuers,
        dr_days: rows.days,
        dr_rates: rows.rates,
      });
    }
    return { rates: out, sql: parts.length > 0 ? parts.join('\nUNION ALL\n') : NO_RATE_ROWS, params };
  }

  /** The rates of `assets` on `days`, from the sets whose versions `valid` names. */
  private async readSets(out: DayRates, assets: Asset[], days: string[], valid: Map<string, number>): Promise<void> {
    const rows = await this.ch.query<{ currency: string; issuer: string; day_key: string; rate: string }>(
      `SELECT currency, issuer, toString(day) AS day_key, rate
         FROM ${Table.NativeRatesDaily}
        WHERE (currency, issuer) IN (SELECT arrayJoin(arrayZip({currencies:Array(String)}, {issuers:Array(String)})))
          AND day BETWEEN {from:Date} AND {through:Date}
          AND (day, version) IN (SELECT arrayJoin(arrayZip({days:Array(Date)}, {versions:Array(UInt64)})))
        ORDER BY currency, issuer, day
        LIMIT 1 BY currency, issuer, day`,
      {
        currencies: assets.map((a) => a.currency),
        issuers: assets.map((a) => a.issuer ?? ''),
        from: days[0],
        through: days[days.length - 1],
        days,
        versions: days.map((day) => valid.get(day)),
      },
    );
    for (const row of rows) {
      // the exponential text of a BigNumber ("1e-8") is read back with BigNumber
      out.get(assetKey(row))?.set(row.day_key, new BigNumber(row.rate));
    }
  }

  /** The rates of each issued asset on its days, from the cache or computed with `dailyNativeRates`. */
  private async computeOnRead(out: DayRates, targets: { key: string; asset: Asset; days: string[] }[]): Promise<void> {
    const { cache, onRead } = this.options;
    const runs: { key: string; asset: Asset; days: string[] }[] = [];
    for (const { key, asset, days } of targets) {
      const perDay = out.get(key) as Map<string, BigNumber>;
      const uncached: string[] = [];
      for (const day of days) {
        const kept = cache?.get(cacheKeyOf(key, day));
        if (typeof kept === 'string') perDay.set(day, new BigNumber(kept));
        else uncached.push(day);
      }
      for (const run of runsOf(uncached)) runs.push({ key, asset, days: run });
    }

    let computed = 0;
    try {
      await forEachLimit(runs, ON_READ_CONCURRENCY, async ({ key, asset, days: run }) => {
        const from = new Date(midnightOf(run[0]));
        const toExclusive = new Date(midnightOf(run[run.length - 1]) + DAY_MS);
        const got = (await this.ratesService.dailyNativeRates([asset], from, toExclusive)).get(key);
        const perDay = out.get(key) as Map<string, BigNumber>;
        for (const day of run) {
          const rate = got?.get(day) ?? ZERO;
          perDay.set(day, rate);
          cache?.set(cacheKeyOf(key, day), rate.toString(), ON_READ_CACHE_MS);
        }
        computed += run.length;
      });
    } finally {
      if (computed > 0) onRead?.(computed);
    }
  }
}

/**
 * The newest valid day at or before `throughDay` (`YYYY-MM-DD`) and the version of its set, `undefined` when there is
 * none: the day whose newest sentinel is not stale and has the current config version. The newest sentinel of each day
 * counts (a set written twice counts once).
 */
export async function newestValidRateDay(
  ch: ClickHouseService,
  throughDay: string,
): Promise<{ day: string; version: number } | undefined> {
  const row = await ch.queryOne<{ day_key: string; version: number | string }>(
    `SELECT toString(day) AS day_key, toUInt64(version) AS version
       FROM (SELECT day, version, stale, config_version
               FROM ${Table.NativeRatesDaily}
              WHERE currency = '' AND issuer = '' AND day <= {through:Date}
              ORDER BY currency, issuer, day, version DESC
              LIMIT 1 BY day)
      WHERE stale = 0 AND config_version = {configVersion:UInt32}
      ORDER BY day DESC
      LIMIT 1`,
    { through: throughDay, configVersion: RATES_DAILY_CONFIG_VERSION },
  );
  return row === undefined ? undefined : { day: row.day_key, version: Number(row.version) };
}
