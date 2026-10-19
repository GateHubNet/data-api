import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { NativeRatesDailyRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { NATIVE_PAIR_FILTER, RatesService } from '../query/rates.service';
import { AggregateSetOptions, nextSetVersion, throwIfSetAborted } from './aggregate-sets';

/**
 * The `rates_daily` job: for a closed, final UTC day D, the rate against the native currency of every issued asset that has
 * one, the value `RatesService.dailyNativeRates([asset], D, D + 1)` would give, kept in `native_rates_daily` so that a
 * reader does not read the trades of 15 days for each day it asks about.
 *
 * A day is a **set**: the assets with a rate above 0 (an absent asset has none) and a **sentinel** row (empty currency and
 * issuer) that carries `config_version` and `stale`. The whole set is one insert under one version, and the newest sentinel
 * of a day says whether the day is **valid**: not stale, and of the current config version (`validRateDays`). A correction
 * (`markRatesStale`) is a newer sentinel with `stale = 1` and no rows. Which days are due, and when, is the runner's.
 */

/** The version of what a set means: a change of the rate rules is a new one, and every day is computed again. */
export const RATES_DAILY_CONFIG_VERSION = 1;

const DAY_MS = 86_400_000;
/** The rows that tell the newest version of a day's set: its sentinels. */
const SENTINEL_OF_DAY = "currency = '' AND issuer = '' AND day = {day:Date}";

/** `YYYY-MM-DD`, the UTC day of a date; an invalid date is a `RangeError`. */
function dayKeyOf(date: Date): string {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new RangeError('Invalid date');
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** The sentinel of a day's set: no rate, the current config version. */
function sentinelOf(day: string, version: number, stale: 0 | 1): NativeRatesDailyRow {
  return {
    currency: '',
    issuer: '',
    day,
    rate: '0',
    rate_f: 0,
    daily_count: 0,
    latest_count: 0,
    config_version: RATES_DAILY_CONFIG_VERSION,
    stale,
    version,
  };
}

/**
 * Computes the set of the UTC day of `day` and writes it: the sentinel and a row for each asset with a rate above 0, one
 * insert, one version. Returns how many assets it wrote. A `signal` that is aborted before the work, or before the insert,
 * throws `AggregateSetAborted` and writes nothing.
 */
export async function computeRatesDailySet(
  ch: ClickHouseService,
  rates: RatesService,
  day: Date,
  options: AggregateSetOptions = {},
): Promise<number> {
  const { signal } = options;
  throwIfSetAborted(signal);
  const key = dayKeyOf(day);
  const assets = await rates.dailyNativeRatesOfDay(new Date(`${key}T00:00:00Z`));
  const version = await nextSetVersion(ch, Table.NativeRatesDaily, SENTINEL_OF_DAY, { day: key });
  throwIfSetAborted(signal);
  // in the order of the asset keys, so that the same day writes the same set
  const rows = [...assets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(
      ([, r]): NativeRatesDailyRow => ({
        ...sentinelOf(key, version, 0),
        currency: r.asset.currency,
        issuer: r.asset.issuer ?? '',
        rate: r.rate.toString(),
        rate_f: r.rate.toNumber(),
        daily_count: r.dailyCount,
        latest_count: r.latestCount,
      }),
    );
  await ch.insert(Table.NativeRatesDaily, [sentinelOf(key, version, 0), ...rows]);
  return rows.length;
}

/**
 * The valid days of `[fromDay, throughDay]` (`YYYY-MM-DD`, both included) and the version of the set of each: the days
 * whose newest sentinel is not stale and has the current config version. Each day counts by its newest sentinel, and a set
 * that was written twice counts once.
 */
export async function validRateDays(
  ch: ClickHouseService,
  fromDay: string,
  throughDay: string,
): Promise<Map<string, number>> {
  const rows = await ch.query<{ day: string; version: number | string }>(
    `SELECT toString(day) AS day, toUInt64(version) AS version
       FROM (SELECT day, version, stale, config_version
               FROM ${Table.NativeRatesDaily}
              WHERE currency = '' AND issuer = '' AND day >= {from:Date} AND day <= {through:Date}
              ORDER BY currency, issuer, day, version DESC
              LIMIT 1 BY day)
      WHERE stale = 0 AND config_version = {configVersion:UInt32}
      ORDER BY day`,
    { from: fromDay, through: throughDay, configVersion: RATES_DAILY_CONFIG_VERSION },
  );
  return new Map(rows.map((r) => [r.day, Number(r.version)]));
}

/**
 * Marks the given days (`YYYY-MM-DD`) stale: for each of them that is valid, a new sentinel with `stale = 1` and no rows,
 * all in one insert. A day without a set, or one that is stale already, is left alone. Returns how many days it marked.
 * The days are computed again, newest first, by the runner; readers value them on read until then.
 */
export async function markRatesStale(
  ch: ClickHouseService,
  days: string[],
  options: AggregateSetOptions = {},
): Promise<number> {
  const { signal } = options;
  throwIfSetAborted(signal);
  const wanted = [...new Set(days)].sort();
  if (wanted.length === 0) return 0;
  const valid = await validRateDays(ch, wanted[0], wanted[wanted.length - 1]);
  const marked = wanted.filter((day) => valid.has(day));
  if (marked.length === 0) return 0;
  const rows = await Promise.all(
    marked.map(async (day) =>
      sentinelOf(day, await nextSetVersion(ch, Table.NativeRatesDaily, SENTINEL_OF_DAY, { day }), 1),
    ),
  );
  throwIfSetAborted(signal);
  await ch.insert(Table.NativeRatesDaily, rows);
  return marked.length;
}

/**
 * The UTC day (`YYYY-MM-DD`) of the first trade against the native currency, `undefined` when there is none: the oldest day
 * a set can be made for. One read of the whole table, so a caller reads it once.
 */
export async function firstNativeTradeDay(ch: ClickHouseService, nativeCurrency: string): Promise<string | undefined> {
  const row = await ch.queryOne<{ day: string; n: number | string }>(
    `SELECT toString(toDate(min(close_time), 'UTC')) AS day, count() AS n
       FROM ${Table.Exchanges}
      WHERE ${NATIVE_PAIR_FILTER}`,
    { native: nativeCurrency },
  );
  return row === undefined || Number(row.n) === 0 ? undefined : row.day;
}
