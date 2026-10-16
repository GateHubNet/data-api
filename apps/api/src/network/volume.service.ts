import { Asset, ClickHouseService, LivePeriod, RatesService, Table, VolumeMetric } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import { decodeMarker, KeysetKey, paginate } from '../common/pagination';
import { bucketStart, ceilBucket, dayText, MAX_DAY_MS, nextBucket, VolumeInterval } from './volume-buckets';
import { StoredVolumeRow, sumParts, toVolumeRow, VolumePart, VolumeRow } from './volume-object';

/** The `interval`s of the historical rows. */
export const VOLUME_INTERVALS: readonly VolumeInterval[] = ['day', 'week', 'month'];

/** The key of a bucket, and so its marker: its start in unix seconds. */
export const BUCKET_KEYS: KeysetKey[] = [{ column: 'bucket', type: 'DateTime' }];

const DAY_MS = 86_400_000;

export interface LiveVolumeQuery {
  metric: VolumeMetric;
  period: LivePeriod;
  /** Show the amounts in this currency instead of the native one. */
  display?: Asset;
}

export interface HistoricVolumeQuery {
  metric: VolumeMetric;
  interval: VolumeInterval;
  /** A bucket is a row when it STARTS at or after this. */
  start: Date;
  /** ... and before this. */
  endExclusive: Date;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
  display?: Asset;
}

/** The rows of a live set as `volume_live` holds them. */
interface LiveRow extends StoredVolumeRow {
  start_time: number | string;
  end_time: number | string;
}

/** The rows of a daily set as `volume_daily` holds them. */
interface DayRow extends StoredVolumeRow {
  day_text: string;
}

/** The SQL of the start of the bucket of a `day`. Code, chosen by the validated interval, never input. */
const BUCKET_OF_DAY: Record<VolumeInterval, string> = {
  day: 'day',
  week: 'toMonday(day)',
  month: 'toStartOfMonth(day)',
};

/**
 * The volume rows of the API (`getMetric` of the original), read from the sets the syncer's volume jobs write.
 *
 * A set (the rows of one metric and one day or live period) is written whole under one version, so a set is the rows of
 * the NEWEST version there is of it: no FINAL, and a component that is gone is not read from an older version. A set
 * that was stored twice is read once (`LIMIT 1 BY` the component). A live row is one set; a historical row is the sets of
 * a day, a week or a month, added up.
 *
 * Which buckets there are is the first read (the days that have a set, grouped by bucket, as many as the page and one
 * more); the rows of the page's buckets are the second, so a page costs its own days. The reads are ranges of the primary
 * key `(metric, day, component)`. A bucket exists when one of its days has a set, a day of zero volume included (its set
 * holds the sentinel): it is a row with no components.
 */
@Injectable()
export class VolumeService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly rates: RatesService,
  ) {}

  private get native(): string {
    return this.rates.nativeCurrency;
  }

  /** The live row of a period, or none while the syncer has not written the set. */
  async live(q: LiveVolumeQuery): Promise<VolumeRow[]> {
    const rows = await this.ch.query<LiveRow>(
      `SELECT component, base_currency, base_issuer, counter_currency, counter_issuer, amount,
              toUInt64(count) AS count, converted_f,
              toUnixTimestamp(start_time) AS start_time, toUnixTimestamp(end_time) AS end_time
         FROM ${Table.VolumeLive}
        WHERE metric = {metric:String} AND period = {period:String}
          AND version = (SELECT max(version) FROM ${Table.VolumeLive} WHERE metric = {metric:String} AND period = {period:String})
        ORDER BY metric, period, component
        LIMIT 1 BY component`,
      { metric: q.metric, period: q.period },
    );
    if (rows.length === 0) return [];
    // as the original: the latest rate, not the daily one (`live: true`); a missing rate is 0
    const display = q.display
      ? { asset: q.display, rate: await this.rates.exchangeRate({ currency: this.native }, q.display, { live: true }) }
      : undefined;
    const bucket = { start: Number(rows[0].start_time), end: Number(rows[0].end_time), parts: sumParts(rows) };
    return [toVolumeRow(q.metric, bucket, this.native, display)];
  }

  /** One page of the rows from `start`, a day, a week or a month each, oldest first. */
  async history(q: HistoricVolumeQuery): Promise<{ rows: VolumeRow[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, BUCKET_KEYS);

    let from = Math.max(ceilBucket(q.start.getTime(), q.interval), 0);
    // the days before this belong to buckets that start before `endExclusive`
    const until = Math.min(ceilBucket(q.endExclusive.getTime(), q.interval), MAX_DAY_MS + DAY_MS);
    // strictly after the bucket the marker names, whatever interval it was made for
    if (after !== undefined) from = Math.max(from, nextBucket(Number(after[0]) * 1000, q.interval));
    if (from >= until) return { rows: [] };

    const found = await this.ch.query<{ bucket: string }>(
      `SELECT toString(${BUCKET_OF_DAY[q.interval]}) AS bucket
         FROM ${Table.VolumeDaily}
        WHERE metric = {metric:String} AND day >= {from:Date} AND day < {until:Date}
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT {fetch:UInt32}`,
      // one row more than the page: it only tells whether there is a next page
      { metric: q.metric, from: dayText(from), until: dayText(until), fetch: q.limit + 1 },
    );
    const page = paginate(found, q.limit, (row) => [Date.parse(`${row.bucket}T00:00:00Z`) / 1000]);
    if (page.rows.length === 0) return { rows: [] };

    const starts = page.rows.map((row) => Date.parse(`${row.bucket}T00:00:00Z`));
    const first = starts[0];
    const last = nextBucket(starts[starts.length - 1], q.interval);
    const days = await this.ch.query<DayRow>(
      `SELECT toString(day) AS day_text, component, base_currency, base_issuer, counter_currency, counter_issuer, amount,
              toUInt64(count) AS count, converted_f
         FROM ${Table.VolumeDaily}
        WHERE metric = {metric:String} AND day >= {a:Date} AND day < {b:Date}
          AND (day, version) IN (
              SELECT day, max(version) FROM ${Table.VolumeDaily}
               WHERE metric = {metric:String} AND day >= {a:Date} AND day < {b:Date}
               GROUP BY day)
        ORDER BY metric, day, component
        LIMIT 1 BY day, component`,
      { metric: q.metric, a: dayText(first), b: dayText(last) },
    );

    const byBucket = new Map<number, DayRow[]>(starts.map((start) => [start, []]));
    for (const row of days) byBucket.get(bucketStart(Date.parse(`${row.day_text}T00:00:00Z`), q.interval))?.push(row);

    // each row is converted with the vwap of ITS OWN bucket, 0 where the pair did not trade (as the original)
    const vwaps = q.display
      ? await this.rates.bucketVwaps({ currency: this.native }, q.display, new Date(first), new Date(last), q.interval)
      : undefined;

    const rows = starts.map((start) => {
      const parts: VolumePart[] = sumParts(byBucket.get(start) ?? []);
      const display =
        q.display && vwaps ? { asset: q.display, rate: vwaps.get(start / 1000) ?? new BigNumber(0) } : undefined;
      return toVolumeRow(q.metric, { start: start / 1000, parts }, this.native, display);
    });
    return { rows, ...(page.marker !== undefined && { marker: page.marker }) };
  }
}
