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

/** How long an asset-day computed on read is kept: it is a day that is not closed or not final yet, or has no set. */
export const ON_READ_CACHE_MS = 60_000;
/** The most days of one asset that one `dailyNativeRates` call is asked for (it answers 3660 at most). */
export const ON_READ_RUN_DAYS = 3000;
/** At most this many `dailyNativeRates` calls of one `rates` call run at once. */
const ON_READ_CONCURRENCY = 4;

const DAY_MS = 86_400_000;
const ZERO = new BigNumber(0);
const ONE = new BigNumber(1);

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
    if (missing.length > 0) await this.computeOnRead(out, issued, missing);
    return out;
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

  /** The rates of `issued` on `days`, from the cache or computed with `dailyNativeRates`. */
  private async computeOnRead(out: DayRates, issued: Map<string, Asset>, days: string[]): Promise<void> {
    const { cache, onRead } = this.options;
    const runs: { key: string; asset: Asset; days: string[] }[] = [];
    for (const [key, asset] of issued) {
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
