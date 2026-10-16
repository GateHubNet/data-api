import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { CountMap, StatsHourlyRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';

/** Seconds in an hour: the grain of `stats_hourly`. */
export const HOUR_SECONDS = 3600;

/** The largest unix time a `DateTime` column holds (2106-02-07). */
const MAX_UINT32 = 4_294_967_295;
/** The last hour that starts inside a `DateTime`. */
const LAST_HOUR = Math.floor(MAX_UINT32 / HOUR_SECONDS) * HOUR_SECONDS;

/** Thrown by a recompute whose `signal` was aborted: nothing was written after the abort. */
export class StatsRecomputeAborted extends Error {
  constructor() {
    super('The stats recompute was aborted before it wrote');
    this.name = 'StatsRecomputeAborted';
  }
}

export interface RecomputeStatsOptions {
  /**
   * Checked before the read and again just before the write: an aborted recompute throws `StatsRecomputeAborted` and
   * writes nothing. The syncer aborts it when it shuts down, so that no row is written once the shutdown has begun.
   */
  signal?: AbortSignal;
}

/** One hour as the aggregation of `ledgers` returns it; the counts come back as numbers or, depending on the settings, as text. */
interface AggregatedHour {
  hour: number | string;
  transaction_count: number | string;
  payments_count: number | string;
  exchanges_count: number | string;
  accounts_created: number | string;
  ledger_count: number | string;
  first_close_time: number | string;
  last_close_time: number | string;
  types: Record<string, number | string>;
  results: Record<string, number | string>;
  version: number | string;
}

/** The hour of a `stats_hourly` row that is the latest version of its hour and has ledgers. */
interface LiveHour {
  hour: number | string;
  version: number | string;
}

const counts = (map: Record<string, number | string>): CountMap =>
  Object.fromEntries(Object.entries(map).map(([key, value]) => [key, Number(value)]));

/** The start of the hour a time falls in, as unix seconds, kept inside what a `DateTime` can hold. */
function floorHour(date: Date): number {
  return Math.min(LAST_HOUR, Math.max(0, Math.floor(date.getTime() / 1000 / HOUR_SECONDS) * HOUR_SECONDS));
}

/**
 * The first hour boundary at or after a time, as unix seconds, kept inside what a `DateTime` can hold (the last hour of
 * the range then ends at the largest `DateTime`, which is not on a boundary).
 */
function ceilHour(date: Date): number {
  return Math.min(MAX_UINT32, Math.max(0, Math.ceil(date.getTime() / 1000 / HOUR_SECONDS) * HOUR_SECONDS));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StatsRecomputeAborted();
}

/**
 * Recomputes the hours of `stats_hourly` from `fromHour` up to, not including, `toHourExclusive`, from the `ledgers`
 * that closed in them, and writes one new version of every hour it computed. Returns how many rows it wrote.
 *
 * A range that cuts an hour is widened to whole hours (an hour is only ever written whole). Read it as the hours from the
 * one `fromHour` falls in to the one before the first boundary at or after `toHourExclusive`. Slice a long range
 * (the syncer uses a day): the aggregation of a slice is one query and one insert.
 *
 * - **Without FINAL.** `ledgers` is a ReplacingMergeTree and a ledger that was written twice is there twice until a merge,
 *   so the ledgers are deduped by `LIMIT 1 BY ledger_index` (the newest write wins) in a subquery that filters on
 *   `close_time`, which its minmax index prunes, before anything is added up.
 * - **Idempotent.** The row of an hour is a function of the ledgers in it; the `version` is the time of the write in
 *   milliseconds on the ClickHouse clock, and readers take the newest version of an hour. Running it twice leaves the same
 *   latest values; the older versions go away when ClickHouse merges.
 * - **No stale counts.** An hour of the range that has no ledgers any more but whose newest row has some (the ledgers were
 *   deleted to be rewritten) gets a zero row, `ledger_count` 0 and empty maps, as a newer version. Readers skip hours with
 *   `ledger_count` 0. An hour that never had ledgers gets no row.
 *
 * It is one read and one insert, so a ledger that commits while it runs is picked up by the next run of its hour.
 */
export async function recomputeStatsHourly(
  ch: ClickHouseService,
  fromHour: Date,
  toHourExclusive: Date,
  options: RecomputeStatsOptions = {},
): Promise<number> {
  if (Number.isNaN(fromHour.getTime()) || Number.isNaN(toHourExclusive.getTime())) {
    throw new RangeError('recomputeStatsHourly: the range needs two valid dates');
  }
  const from = floorHour(fromHour);
  const to = ceilHour(toHourExclusive);
  if (from >= to) return 0;
  const { signal } = options;
  throwIfAborted(signal);

  const params = { from, to };
  const [aggregated, existing] = await Promise.all([
    ch.query<AggregatedHour>(
      // The inner query dedupes the ledgers (the newest write of an index wins) among those that closed in the range.
      // The aliases differ from the columns they sum so that no aggregate reads its own alias.
      `SELECT toUnixTimestamp(toStartOfHour(close_time)) AS hour,
              sum(tx_count) AS transaction_count,
              sum(payments_count) AS payments_count,
              sum(exchanges_count) AS exchanges_count,
              sum(accounts_created) AS accounts_created,
              count() AS ledger_count,
              toUnixTimestamp(min(close_time)) AS first_close_time,
              toUnixTimestamp(max(close_time)) AS last_close_time,
              sumMap(type_counts) AS types,
              sumMap(result_counts) AS results,
              toUnixTimestamp64Milli(now64(3)) AS version
         FROM (
              SELECT ledger_index, close_time, tx_count, payments_count, exchanges_count, accounts_created,
                     type_counts, result_counts
                FROM ${Table.Ledgers}
               WHERE close_time >= toDateTime({from:UInt32}, 'UTC')
                 AND close_time < toDateTime({to:UInt32}, 'UTC')
               ORDER BY ledger_index ASC, ingested_at DESC
               LIMIT 1 BY ledger_index
              )
        GROUP BY hour
        ORDER BY hour ASC`,
      params,
    ),
    // The newest version of every hour of the range, of those that have ledgers: the hours that may have to be zeroed.
    ch.query<LiveHour>(
      `SELECT toUnixTimestamp(hour) AS hour, toUnixTimestamp64Milli(now64(3)) AS version
         FROM (
              SELECT hour, ledger_count
                FROM ${Table.StatsHourly}
               WHERE hour >= toDateTime({from:UInt32}, 'UTC')
                 AND hour < toDateTime({to:UInt32}, 'UTC')
               ORDER BY hour ASC, version DESC
               LIMIT 1 BY hour
              )
        WHERE ledger_count > 0
        ORDER BY hour ASC`,
      params,
    ),
  ]);

  const rows: StatsHourlyRow[] = aggregated.map((h) => ({
    hour: Number(h.hour),
    transaction_count: Number(h.transaction_count),
    payments_count: Number(h.payments_count),
    exchanges_count: Number(h.exchanges_count),
    accounts_created: Number(h.accounts_created),
    ledger_count: Number(h.ledger_count),
    first_close_time: Number(h.first_close_time),
    last_close_time: Number(h.last_close_time),
    type_counts: counts(h.types),
    result_counts: counts(h.results),
    version: Number(h.version),
  }));

  // An hour that has a row with ledgers and none in the aggregation lost its ledgers: it is zeroed.
  const computed = new Set(rows.map((r) => r.hour));
  for (const old of existing) {
    const hour = Number(old.hour);
    if (computed.has(hour)) continue;
    rows.push({
      hour,
      transaction_count: 0,
      payments_count: 0,
      exchanges_count: 0,
      accounts_created: 0,
      ledger_count: 0,
      // a DateTime column has no null: the hour itself stands in for the times of ledgers that are not there
      first_close_time: hour,
      last_close_time: hour,
      type_counts: {},
      result_counts: {},
      version: Number(old.version),
    });
  }
  if (rows.length === 0) return 0;
  rows.sort((a, b) => a.hour - b.hour);

  throwIfAborted(signal);
  await ch.insert(Table.StatsHourly, rows);
  return rows.length;
}
