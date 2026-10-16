import { ClickHouseService, readDistinctPage, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { decodeMarker, KeysetKey, paginate } from '../common/pagination';
import { ceilTo, collectBuckets, floorTo } from './bucket-windows';
import { FeeStat, StoredFeeStat, toFeeStat } from './fee-object';

/** The `interval`s of `/v2/network/fee_stats` that sample: the first snapshot at or after each minute, hour or day. */
export const FEE_STAT_INTERVALS = ['minute', 'hour', 'day'] as const;
export type FeeStatInterval = (typeof FEE_STAT_INTERVALS)[number];

export const STAT_BUCKET_SECONDS: Record<FeeStatInterval, number> = { minute: 60, hour: 3600, day: 86400 };

/** The key of a raw snapshot, and so its marker: its time in unix MILLISECONDS (`ts` is a `DateTime64(3)`, the ORDER BY). */
export const RAW_STAT_KEYS: KeysetKey[] = [{ column: 'ts', type: 'UInt64' }];
/** The key of a sampled snapshot, and so its marker: the start of its minute, hour or day in unix seconds. */
export const SAMPLED_STAT_KEYS: KeysetKey[] = [{ column: 'bucket', type: 'DateTime' }];

/** What `GET /v2/network/fee_stats` is asked for; the values are already validated. */
export interface FeeStatsQuery {
  /** Without it: every snapshot (the original's `raw`). */
  interval?: FeeStatInterval;
  /** Inclusive. With an interval: the first boundary at or after it is the first bucket. */
  start: Date;
  /** Raw: exclusive end, one unit of the granularity of `end` on (`end=2016-08-24T00:15:55Z` takes that second). */
  endExclusive?: Date;
  /** With an interval: the instant a bucket must START before, as the original used `end` for its boundaries. */
  endAt?: Date;
  descending: boolean;
  limit: number;
  marker?: string;
}

const SQL_TS = (param: string): string => `fromUnixTimestamp64Milli({${param}:Int64}, 'UTC')`;

/** The last time a `DateTime('UTC')` holds (2106-02-07T06:28:15Z), unix seconds: no snapshot is later than that. */
const MAX_SECONDS = 4_294_967_295;
const MAX_MS = MAX_SECONDS * 1000;

/**
 * A time as milliseconds, kept inside the `DateTime` range (1970 .. 2106; there is no snapshot outside it) so that no
 * comparison depends on how ClickHouse reads a `DateTime64` far outside its own range: `start=0001` and `end=9999` are cut to it.
 */
const clampMs = (ms: number): number => Math.min(Math.max(ms, 0), MAX_MS);
/** The same in seconds. */
const clampSeconds = (seconds: number): number => Math.min(Math.max(seconds, 0), MAX_SECONDS);

/**
 * The fee stats of the API (`getFeeStats` of the original): the snapshots the syncer's poller takes of the node's `fee`
 * every five seconds, from `fee_stats` (MergeTree, ORDER BY `ts`, partitioned by month).
 *
 * Raw: the snapshots in the order of `ts` (the whole key in the ORDER BY: read in order, no sort), with `readDistinctPage`,
 * which stops the read after the page and keeps a snapshot that was written twice (a retried insert; the table is not
 * collapsed on merge) once.
 *
 * Sampled (`minute`, `hour`, `day`): the original read, for each boundary, the snapshot stored under exactly that second.
 * Its cron job ran at second 0, 5, 10, ..., so one was there for every minute, hour and day. The poller here ticks
 * wherever it was started, so a bucket serves the first snapshot at or after its boundary within the bucket: `argMin` by
 * `ts` per `[boundary, boundary + interval)`. Where a snapshot sits on the boundary that is the original's row; a bucket
 * with no snapshot has no row. Duplicates need no dedupe here: the first snapshot is the same row whichever copy is read.
 * The windows of time that are read start small and double across a gap (see `bucket-windows.ts`).
 */
@Injectable()
export class FeeStatsService {
  constructor(private readonly ch: ClickHouseService) {}

  async list(q: FeeStatsQuery): Promise<{ rows: FeeStat[]; marker?: string }> {
    return q.interval === undefined ? this.raw(q) : this.sampled(q, STAT_BUCKET_SECONDS[q.interval]);
  }

  private async raw(q: FeeStatsQuery): Promise<{ rows: FeeStat[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, RAW_STAT_KEYS);
    const where = [
      `ts >= ${SQL_TS('from')}`,
      ...(q.endExclusive !== undefined ? [`ts < ${SQL_TS('until')}`] : []),
      ...(after !== undefined
        ? [`ts ${q.descending ? '<' : '>'} fromUnixTimestamp64Milli(toInt64({k0:UInt64}), 'UTC')`]
        : []),
    ];
    // each snapshot once, with one more than the page: it only tells whether there is a next page
    const rows = await readDistinctPage<StoredFeeStat>(this.ch, {
      columns: `toUnixTimestamp64Milli(ts) AS ms, current_ledger_size, expected_ledger_size, current_queue_size,
              pct_max_queue_size, median_fee, minimum_fee, open_ledger_fee`,
      table: Table.FeeStats,
      where,
      orderBy: ['ts'],
      // the milliseconds of `ts`: the same order, and the same value for a snapshot written twice
      unique: ['ms'],
      descending: q.descending,
      params: {
        from: clampMs(q.start.getTime()),
        ...(q.endExclusive !== undefined && { until: clampMs(q.endExclusive.getTime()) }),
        ...(after !== undefined && { k0: Math.min(Number(after[0]), MAX_MS) }),
      },
      limit: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (row) => [Number(row.ms)]);
    return { rows: page.rows.map(toFeeStat), ...(page.marker !== undefined && { marker: page.marker }) };
  }

  private async sampled(q: FeeStatsQuery, size: number): Promise<{ rows: FeeStat[]; marker?: string }> {
    const after = decodeMarker(q.marker, SAMPLED_STAT_KEYS);

    // the boundaries to serve: [from, until), the first at or after start, those before end
    let from = ceilTo(clampSeconds(Math.ceil(q.start.getTime() / 1000)), size);
    let until = q.endAt === undefined ? undefined : ceilTo(clampSeconds(Math.ceil(q.endAt.getTime() / 1000)), size);
    if (after !== undefined) {
      const marker = Number(after[0]);
      if (q.descending) until = Math.min(until ?? Infinity, ceilTo(marker, size));
      else from = Math.max(from, floorTo(marker, size) + size);
    }
    if (until !== undefined && from >= until) return { rows: [] };

    // The snapshots there are bound where the windows start and stop: years without a snapshot are not walked a bucket at
    // a time. Two reads of the primary key.
    const [first, last] = await Promise.all([this.edge(from, until, 'ASC'), this.edge(from, until, 'DESC')]);
    if (first === undefined || last === undefined) return { rows: [] };
    const windowFrom = Math.max(from, floorTo(first, size));
    const windowUntil = Math.min(until ?? Infinity, floorTo(last, size) + size);

    const rows = await collectBuckets<SampledStat>({
      from: windowFrom,
      until: windowUntil,
      size,
      want: q.limit + 1,
      descending: q.descending,
      fetch: (window, limit) => this.bucketWindow(size, window, q.descending, limit),
    });
    const page = paginate(rows, q.limit, (row) => [Number(row.bucket)]);
    return { rows: page.rows.map((row) => toFeeStat(row)), ...(page.marker !== undefined && { marker: page.marker }) };
  }

  /** The time of the first (`ASC`) or the last (`DESC`) snapshot in `[from, until)`, unix seconds. */
  private async edge(from: number, until: number | undefined, direction: 'ASC' | 'DESC'): Promise<number | undefined> {
    const [row] = await this.ch.query<{ t: number }>(
      `SELECT toUnixTimestamp(ts) AS t
         FROM ${Table.FeeStats}
        WHERE ts >= ${SQL_TS('lo')}${until === undefined ? '' : ` AND ts < ${SQL_TS('hi')}`}
        ORDER BY ts ${direction}
        LIMIT 1`,
      { lo: from * 1000, ...(until !== undefined && { hi: until * 1000 }) },
    );
    return row === undefined ? undefined : Number(row.t);
  }

  /**
   * The first snapshot of every bucket that starts in `window`: `argMin` of each field by `ts`. (The aliases differ from
   * the columns: an alias that is also the name of a column inside its own aggregate is a cyclic alias.)
   */
  private async bucketWindow(
    size: number,
    window: { from: number; until: number },
    descending: boolean,
    limit: number,
  ): Promise<SampledStat[]> {
    const rows = await this.ch.query<SampledRow>(
      `SELECT intDiv(toUnixTimestamp(ts), {size:UInt32}) * {size:UInt32} AS bucket,
              argMin(toUnixTimestamp64Milli(ts), ts) AS first_ms,
              argMin(current_ledger_size, ts) AS first_ledger_size,
              argMin(expected_ledger_size, ts) AS first_expected_size,
              argMin(current_queue_size, ts) AS first_queue_size,
              argMin(pct_max_queue_size, ts) AS first_pct,
              argMin(median_fee, ts) AS first_median,
              argMin(minimum_fee, ts) AS first_minimum,
              argMin(open_ledger_fee, ts) AS first_open
         FROM ${Table.FeeStats}
        WHERE ts >= ${SQL_TS('lo')} AND ts < ${SQL_TS('hi')}
        GROUP BY bucket
        ORDER BY bucket ${descending ? 'DESC' : 'ASC'}
        LIMIT {fetch:UInt32}`,
      { size, lo: window.from * 1000, hi: window.until * 1000, fetch: limit },
    );
    return rows.map((r) => ({
      bucket: r.bucket,
      ms: r.first_ms,
      current_ledger_size: r.first_ledger_size,
      expected_ledger_size: r.first_expected_size,
      current_queue_size: r.first_queue_size,
      pct_max_queue_size: r.first_pct,
      median_fee: r.first_median,
      minimum_fee: r.first_minimum,
      open_ledger_fee: r.first_open,
    }));
  }
}

/** A sampled snapshot with the start of its bucket (the marker). */
type SampledStat = StoredFeeStat & { bucket: number };

interface SampledRow {
  bucket: number;
  first_ms: number;
  first_ledger_size: number;
  first_expected_size: number;
  first_queue_size: number;
  first_pct: number;
  first_median: number;
  first_minimum: number;
  first_open: number;
}
