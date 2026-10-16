import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, keysetClause, KeysetKey, orderByClause, paginate } from '../common/pagination';
import { ceilTo, collectBuckets, floorTo } from './bucket-windows';
import { FeeSummary, StoredBucketFees, StoredLedgerFees, toBucketFees, toLedgerFees } from './fee-object';

/** The `interval`s of `/v2/network/fees`: a row per ledger (the default), per hour or per day. */
export const FEE_INTERVALS = ['ledger', 'hour', 'day'] as const;
export type FeeInterval = (typeof FEE_INTERVALS)[number];

/** The size in seconds of an hour or a day; both start on a multiple of it since the epoch, in UTC. */
export const BUCKET_SECONDS = { hour: 3600, day: 86400 } as const;

/** The key of a ledger row, and so its marker: the ORDER BY of `ledgers`. Close times never decrease with it. */
export const LEDGER_KEYS: KeysetKey[] = [{ column: 'ledger_index', type: 'UInt32' }];
/** The key of an hour or a day, and so its marker: its start in unix seconds. */
export const BUCKET_KEYS: KeysetKey[] = [{ column: 'bucket', type: 'DateTime' }];

/** What `GET /v2/network/fees` is asked for; the values are already validated. */
export interface FeesQuery {
  interval: FeeInterval;
  /** Inclusive. For an hour or a day: it is served when it STARTS at or after this. */
  start: Date;
  /** Exclusive; without it the list runs to the newest ledger. For an hour or a day: it is served when it starts before this. */
  endExclusive?: Date;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/** Unix seconds of a date, up to the second after it (`ledgers.close_time` is whole seconds). */
const seconds = (date: Date): number => Math.ceil(date.getTime() / 1000);

/**
 * The network fees of the API (`getNetworkFees` of the original), worked out from the fee columns of `ledgers`
 * (`fee_total`, `fee_min`, `fee_max` in drops and `tx_count`) instead of read from a table an aggregation job filled.
 *
 * `ledger_index` is the time axis: the window is turned into a range of ledgers once. A row per ledger pages that range in
 * the order of the primary key. An hour or a day is grouped from the ledgers of a window of time inside it, which starts
 * small and doubles across a gap of the data (see `bucket-windows.ts`), so a page costs its own ledgers, not the range.
 * Ledgers are deduped by `LIMIT 1 BY ledger_index` before anything is added up (no FINAL): the table is a
 * ReplacingMergeTree and a ledger written twice is there twice until a merge.
 */
@Injectable()
export class FeesService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the list, in the order asked for, with the marker of the next page when there is one. */
  async list(q: FeesQuery): Promise<{ rows: FeeSummary[]; marker?: string }> {
    return q.interval === 'ledger' ? this.perLedger(q) : this.perBucket(q, BUCKET_SECONDS[q.interval]);
  }

  private async perLedger(q: FeesQuery): Promise<{ rows: FeeSummary[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, LEDGER_KEYS);
    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { rows: [] };

    const cursor = keysetClause(LEDGER_KEYS, q.descending, after);
    const where = [
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    // The whole key in the ORDER BY, so that ClickHouse reads the table in the order of its primary key and stops after
    // the page. `LIMIT 1 BY`: a ledger that was written twice counts once.
    const rows = await this.ch.query<StoredLedgerFees>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS closed, tx_count, fee_total, fee_min, fee_max
         FROM ${Table.Ledgers}
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderByClause(LEDGER_KEYS, q.descending)}
        LIMIT 1 BY ledger_index
        LIMIT {fetch:UInt32}`,
      {
        min: range.min,
        max: range.max,
        ...cursor.params,
        // one row more than the page: it only tells whether there is a next page
        fetch: q.limit + 1,
      },
    );
    const page = paginate(rows, q.limit, (row) => [Number(row.ledger_index)]);
    return { rows: page.rows.map(toLedgerFees), ...(page.marker !== undefined && { marker: page.marker }) };
  }

  /**
   * An hour or a day is served when it starts inside the window (`hour|<start>` .. `hour|<end + one unit>` of the
   * original, whose keys are the starts of the buckets), whole: all its ledgers count, also those after `end`.
   */
  private async perBucket(q: FeesQuery, size: number): Promise<{ rows: FeeSummary[]; marker?: string }> {
    const after = decodeMarker(q.marker, BUCKET_KEYS);

    // the starts of the buckets to serve: [from, until), both on a bucket boundary
    let from = ceilTo(seconds(q.start), size);
    let until = q.endExclusive === undefined ? undefined : ceilTo(seconds(q.endExclusive), size);
    if (after !== undefined) {
      // strictly after (before, descending) the bucket of the marker, whatever interval the marker was made for
      const marker = Number(after[0]);
      if (q.descending) until = Math.min(until ?? Infinity, ceilTo(marker, size));
      else from = Math.max(from, floorTo(marker, size) + size);
    }
    if (until !== undefined && from >= until) return { rows: [] };

    const range = await this.ranges.resolve(
      new Date(from * 1000),
      until === undefined ? undefined : new Date(until * 1000),
    );
    if (!range) return { rows: [] };

    // The ledgers there are inside the range bound where the windows start and stop: a range of years with a few ledgers
    // in it is not walked an hour at a time.
    const edges = await this.closeTimes(range);
    if (edges === undefined) return { rows: [] };
    const [first, last] = edges;
    const windowFrom = Math.max(from, floorTo(first, size));
    const windowUntil = Math.min(until ?? Infinity, floorTo(last, size) + size);

    const rows = await collectBuckets<StoredBucketFees>({
      from: windowFrom,
      until: windowUntil,
      size,
      want: q.limit + 1,
      descending: q.descending,
      fetch: (window, limit) => this.bucketWindow(range, size, window, q.descending, limit),
    });
    const page = paginate(rows, q.limit, (row) => [Number(row.bucket)]);
    return { rows: page.rows.map(toBucketFees), ...(page.marker !== undefined && { marker: page.marker }) };
  }

  /** The close times of the first and the last ledger of a range, unix seconds. */
  private async closeTimes(range: { min: number; max: number }): Promise<[number, number] | undefined> {
    const rows = await this.ch.query<{ ledger_index: number; closed: number }>(
      `SELECT ledger_index, toUnixTimestamp(close_time) AS closed
         FROM ${Table.Ledgers}
        WHERE ledger_index IN ({min:UInt32}, {max:UInt32})
        ORDER BY ledger_index ASC
        LIMIT 1 BY ledger_index`,
      range,
    );
    // the ledgers of the range exist, unless they were removed between the two reads
    if (rows.length === 0) return undefined;
    return [Number(rows[0].closed), Number(rows[rows.length - 1].closed)];
  }

  /**
   * The buckets that start in `window`, grouped from their ledgers: how many there are, the transactions, the fees added
   * up, the smallest minimum above zero (a ledger without transactions, or whose transactions paid nothing, has a minimum
   * of 0, which must not hold the bucket's) and the largest maximum. The ledgers are deduped in the inner query.
   */
  private bucketWindow(
    range: { min: number; max: number },
    size: number,
    window: { from: number; until: number },
    descending: boolean,
    limit: number,
  ): Promise<StoredBucketFees[]> {
    return this.ch.query<StoredBucketFees>(
      `SELECT bucket,
              count() AS ledgers,
              sum(txs) AS tx_count,
              sum(drops_total) AS fee_total,
              minIf(drops_min, drops_min > 0) AS fee_min,
              max(drops_max) AS fee_max
         FROM (
              SELECT ledger_index,
                     intDiv(toUnixTimestamp(close_time), {size:UInt32}) * {size:UInt32} AS bucket,
                     tx_count AS txs, fee_total AS drops_total, fee_min AS drops_min, fee_max AS drops_max
                FROM ${Table.Ledgers}
               WHERE ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
                 AND close_time >= toDateTime({lo:UInt32}, 'UTC')
                 AND close_time < toDateTime({hi:UInt32}, 'UTC')
               ORDER BY ledger_index ASC
               LIMIT 1 BY ledger_index
              )
        GROUP BY bucket
        ORDER BY bucket ${descending ? 'DESC' : 'ASC'}
        LIMIT {fetch:UInt32}`,
      { size, min: range.min, max: range.max, lo: window.from, hi: window.until, fetch: limit },
    );
  }
}
