import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { decodeMarker, KeysetKey, paginate } from '../common/pagination';
import { collectBuckets } from '../network/bucket-windows';
import {
  bucketAlign,
  FlatStats,
  flatStats,
  NestedStats,
  nestedStats,
  StatsFamily,
  StatsInterval,
  StatsMetric,
  StoredStats,
} from './stats-object';

/** The key of a bucket, and so its marker: its start in unix seconds. */
export const STATS_KEYS: KeysetKey[] = [{ column: 'bucket', type: 'DateTime' }];

const MAX_UINT32 = 4_294_967_295;

/** What `GET /v2/stats` is asked for; the values are already validated. */
export interface StatsQuery {
  interval: StatsInterval;
  /** A bucket is served when it STARTS at or after this. */
  start: Date;
  /** Exclusive: a bucket is served when it starts before this. */
  endExclusive: Date;
  /** Without a family the rows are nested, with one they are flat. */
  family?: StatsFamily;
  /** The columns of the family to serve; without them, all of its columns. */
  names?: string[];
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/** How a bucket is named by the hours inside it. Code, never user input: it is written into the SQL text. */
const BUCKET_OF_HOUR: Record<StatsInterval, string> = {
  hour: 'toUnixTimestamp(hour)',
  day: 'toUnixTimestamp(toStartOfDay(hour))',
  // `toMonday` is a Date: the midnight UTC of it
  week: "toUnixTimestamp(toDateTime(toMonday(hour), 'UTC'))",
};

/** When a metric is not zero, over the columns of the query below. Code, never user input. */
const METRIC_PRESENT: Record<StatsMetric, string> = {
  accounts_created: 'accounts > 0',
  exchanges_count: 'exchanges > 0',
  ledger_count: 'ledgers > 0',
  ledger_interval: 'last_close > bucket',
  payments_count: 'payments > 0',
  transaction_count: 'transactions > 0',
  tx_per_ledger: 'transactions > 0',
};

const METRIC_NAMES = new Set<string>(Object.keys(METRIC_PRESENT));

/** When a bucket is a row: a condition over the columns of the window query (empty: always) and the values it binds. */
interface Presence {
  sql: string;
  params: Record<string, unknown>;
}

/** What the window query returns: the hours of a bucket added up. */
interface StoredBucket {
  bucket: number | string;
  transactions: number | string;
  payments: number | string;
  exchanges: number | string;
  accounts: number | string;
  ledgers: number | string;
  last_close: number | string;
  types: Record<string, number | string>;
  results: Record<string, number | string>;
}

/**
 * The stats of the API (`hbase.getStats` of the original), read from `stats_hourly`, which the syncer's aggregator fills
 * from the ledgers: an hour per row, and a day or a week is the sum of its hours.
 *
 * - **No FINAL.** An hour can be there more than once until ClickHouse merges (every recompute writes a new version), so the
 *   hours are deduped by `ORDER BY hour, version DESC LIMIT 1 BY hour` before anything is added up, and only then are
 *   the hours without ledgers (the zero rows of an hour whose ledgers were rewritten away) dropped.
 * - **Pages cost their own buckets.** `hour` is the primary key, so a window of buckets is a range of the primary key. The
 *   range is read in windows of whole buckets that start with just enough room for the page and double across a gap of
 *   the data (see `bucket-windows.ts`), after one cheap query that tells where the data begins and ends.
 * - **A bucket is a row only if it has what was asked for.** With a family (and metrics) the buckets that have none of the
 *   columns are not rows, and are left out by the query, so that they never take up a place in a page.
 */
@Injectable()
export class StatsService {
  constructor(private readonly ch: ClickHouseService) {}

  /** One page of the list, in the order asked for, with the marker of the next page when there is one. */
  async list(q: StatsQuery): Promise<{ rows: Array<NestedStats | FlatStats>; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, STATS_KEYS);
    const present = this.present(q);
    if (present === undefined) return { rows: [] };

    const size = bucketAlign.size(q.interval);
    // the starts of the buckets to serve: [from, until), both on a bucket start (until may be cut to what a DateTime holds)
    let from = bucketAlign.ceil(q.interval, Math.max(0, Math.floor(q.start.getTime() / 1000)));
    let until = Math.min(MAX_UINT32, bucketAlign.ceil(q.interval, Math.floor(q.endExclusive.getTime() / 1000)));
    if (after !== undefined) {
      // strictly after (before, descending) the bucket of the marker, whatever interval the marker was made for
      const marker = Number(after[0]);
      if (q.descending) until = Math.min(until, bucketAlign.floor(q.interval, marker));
      else from = Math.max(from, bucketAlign.floor(q.interval, marker) + size);
    }
    if (from >= until) return { rows: [] };

    const bounds = await this.hourBounds(from, until);
    if (bounds === undefined) return { rows: [] };
    const windowFrom = Math.max(from, bucketAlign.floor(q.interval, bounds.first));
    const windowUntil = Math.min(until, bucketAlign.floor(q.interval, bounds.last) + size);

    const buckets = await collectBuckets<StoredBucket>({
      from: windowFrom,
      until: windowUntil,
      size,
      want: q.limit + 1,
      descending: q.descending,
      fetch: (window, limit) => this.window(q.interval, window, present, q.descending, limit),
    });
    const page = paginate(buckets, q.limit, (row) => [Number(row.bucket)]);
    const rows = page.rows.flatMap((bucket) => {
      const stored: StoredStats = {
        bucket: bucket.bucket,
        transaction_count: bucket.transactions,
        payments_count: bucket.payments,
        exchanges_count: bucket.exchanges,
        accounts_created: bucket.accounts,
        ledger_count: bucket.ledgers,
        last_close: bucket.last_close,
        types: bucket.types,
        results: bucket.results,
      };
      const row = q.family === undefined ? nestedStats(stored) : flatStats(stored, q.family, q.names);
      return row === undefined ? [] : [row];
    });
    return { rows, ...(page.marker !== undefined && { marker: page.marker }) };
  }

  /**
   * The condition (over the columns of the window query) under which a bucket is a row; empty when every bucket is. `undefined`
   * when nothing can be: the metrics asked for are none of the family's.
   */
  private present(q: StatsQuery): Presence | undefined {
    if (q.family === undefined) return { sql: '', params: {} };
    if (q.family === 'metric') {
      if (q.names === undefined) return { sql: '', params: {} };
      const names = [...new Set(q.names)].filter((name) => METRIC_NAMES.has(name));
      return names.length === 0
        ? undefined
        : { sql: names.map((name) => `(${METRIC_PRESENT[name as StatsMetric]})`).join(' OR '), params: {} };
    }
    const column = q.family === 'type' ? 'types' : 'results';
    return q.names === undefined
      ? { sql: `arrayExists(n -> n > 0, mapValues(${column}))`, params: {} }
      : { sql: `arrayExists(name -> ${column}[name] > 0, {names:Array(String)})`, params: { names: q.names } };
  }

  /** The first and the last hour of the range that has ledgers (any version of the hour: the bounds only have to be wide enough). */
  private async hourBounds(from: number, until: number): Promise<{ first: number; last: number } | undefined> {
    const row = await this.ch.queryOne<{ first_hour: number | string | null; last_hour: number | string | null }>(
      `SELECT toUnixTimestamp(minOrNull(hour)) AS first_hour, toUnixTimestamp(maxOrNull(hour)) AS last_hour
         FROM ${Table.StatsHourly}
        WHERE ledger_count > 0
          AND hour >= toDateTime({lo:UInt32}, 'UTC')
          AND hour < toDateTime({hi:UInt32}, 'UTC')`,
      { lo: from, hi: until },
    );
    if (row?.first_hour == null || row.last_hour == null) return undefined;
    return { first: Number(row.first_hour), last: Number(row.last_hour) };
  }

  /** The buckets that start in `window`, added up from their hours, at most `limit` of them in the order asked for. */
  private window(
    interval: StatsInterval,
    window: { from: number; until: number },
    present: Presence,
    descending: boolean,
    limit: number,
  ): Promise<StoredBucket[]> {
    return this.ch.query<StoredBucket>(
      `SELECT bucket, transactions, payments, exchanges, accounts, ledgers, last_close, types, results
         FROM (
              SELECT ${BUCKET_OF_HOUR[interval]} AS bucket,
                     sum(transaction_count) AS transactions,
                     sum(payments_count) AS payments,
                     sum(exchanges_count) AS exchanges,
                     sum(accounts_created) AS accounts,
                     sum(ledger_count) AS ledgers,
                     toUnixTimestamp(max(last_close_time)) AS last_close,
                     sumMap(type_counts) AS types,
                     sumMap(result_counts) AS results
                FROM (
                     SELECT hour, transaction_count, payments_count, exchanges_count, accounts_created, ledger_count,
                            last_close_time, type_counts, result_counts
                       FROM ${Table.StatsHourly}
                      WHERE hour >= toDateTime({lo:UInt32}, 'UTC')
                        AND hour < toDateTime({hi:UInt32}, 'UTC')
                      ORDER BY hour ASC, version DESC
                      LIMIT 1 BY hour
                     )
               WHERE ledger_count > 0
               GROUP BY bucket
              )
        ${present.sql === '' ? '' : `WHERE ${present.sql}`}
        ORDER BY bucket ${descending ? 'DESC' : 'ASC'}
        LIMIT {fetch:UInt32}`,
      { lo: window.from, hi: window.until, fetch: limit, ...present.params },
    );
  }
}
