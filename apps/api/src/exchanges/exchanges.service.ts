import {
  Asset,
  canonicalPair,
  ClickHouseService,
  readDistinctPage,
  readGrowingCap,
  Table,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import {
  columnsOf,
  decodeMarker,
  encodeMarker,
  keysetClause,
  KeysetKey,
  orderByClause,
  paginate,
} from '../common/pagination';
import {
  AGGREGATE_COLUMNS,
  AGGREGATE_SOURCE_COLUMNS,
  AggregateRow,
  BucketRow,
  CandleObject,
  ReducedObject,
  toCandleObject,
  toReducedObject,
} from './exchange-aggregate';
import { bucketExpr, ExchangeInterval, firstBucketAtOrAfter } from './exchange-intervals';
import { EXCHANGE_COLUMNS, ExchangeObject, StoredExchange, toExchangeObject } from './exchange-object';

/** The key of a list of exchanges, which is the end of the ORDER BY of `exchanges`, and what a marker holds. */
export const EXCHANGE_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
  { column: 'node_index', type: 'UInt16' },
];

/** The key of a list of candles, what its marker holds: the start of the bucket, in unix seconds. */
export const BUCKET_KEYS: KeysetKey[] = [{ column: 'bucket', type: 'UInt32' }];

/** The start of the ORDER BY of `exchanges`: the pair, in the order it is stored. */
export const PAIR_KEYS: KeysetKey[] = [
  { column: 'base_currency', type: 'String' },
  { column: 'base_issuer', type: 'String' },
  { column: 'counter_currency', type: 'String' },
  { column: 'counter_issuer', type: 'String' },
];

/**
 * The whole ORDER BY of `exchanges`. A list of one pair fixes the first four columns, so its order is that of
 * `EXCHANGE_KEYS`, but it has to ask for the whole key: with only `ledger_index, tx_index, node_index` ClickHouse
 * cannot read the table in the order of its primary key, and sorts every row of the pair in the range first (found in
 * Task 21 for `payments_by_currency`). Spelled out, it reads in order, and `readDistinctPage` stops it after the page.
 */
export const PAIR_ORDER: KeysetKey[] = [...PAIR_KEYS, ...EXCHANGE_KEYS];

/**
 * The least room of the read that finds the buckets of a page of candles: a quarter of a granule. ClickHouse reads whole
 * granules (8192 rows) of every part the read reaches, and a cap above a granule makes that two of each; below it, a page
 * of buckets of a few exchanges each is one read.
 */
const EDGE_MIN_ROOM = 2048;

/** The most exchanges one window of `all()` is sized for: its ledgers hold about this many, sorted to the page. */
const MAX_WINDOW_EXCHANGES = 1_000_000;

/** Whether two stored exchanges are the same one (the same key), as a row written twice is. */
function sameExchange(a: StoredExchange, b: StoredExchange): boolean {
  return a.ledger_index === b.ledger_index && a.tx_index === b.tx_index && a.node_index === b.node_index;
}

/** What both lists of exchanges are asked for; the values are already validated. */
export interface ExchangesWindow {
  /** Inclusive: the first ledger that closed at or after it starts the list. */
  start?: Date;
  /** Exclusive; without it the list runs to the newest ledger. */
  endExclusive?: Date;
  /** Only the exchanges that were autobridged (have an autobridged currency). */
  autobridged: boolean;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/** `GET /v2/exchanges/:base/:counter`: the pair as the client asked for it, in either order. */
export interface PairExchangesQuery extends ExchangesWindow {
  base: Asset;
  counter: Asset;
}

export interface ExchangesPage {
  exchanges: ExchangeObject[];
  marker?: string;
}

/** `?interval=`: the candles of a pair. The marker is that of a candle (`BUCKET_KEYS`). */
export interface CandlesQuery extends PairExchangesQuery {
  interval: ExchangeInterval;
}

export interface CandlesPage {
  candles: CandleObject[];
  marker?: string;
}

/** `?reduce=true`: one row of all the exchanges of a pair in the window. `start` is the start of the window. */
export interface ReduceQuery extends PairExchangesQuery {
  start: Date;
}

/**
 * The exchanges of the API (`hbase.getExchanges` of the original): the exchanges of a pair, its candles and its reduced
 * row, and the exchanges of every pair.
 *
 * `exchanges` is ordered by the pair first (`base_currency, base_issuer, counter_currency, counter_issuer,
 * ledger_index, tx_index, node_index`), with the pair in Ripple's canonical order, so the list of a pair is a range of
 * the primary key and is read in order. The dates become a range of ledgers once, before the query. A pair that is asked
 * for the other way round is read as it is stored and every row is inverted on the way out. The candles and the
 * reduced row are aggregated in ClickHouse from the same range of the key (the original read them from `agg_exchanges`,
 * which its importer kept up to date, and reduced raw rows in the API).
 *
 * The list of all pairs has no pair to fix, so it reads the ledger range in windows of ledgers, each sorted by the key
 * of the ledger (see `all()`).
 */
@Injectable()
export class ExchangesService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the exchanges of a pair, in the order asked for, with the marker of the next page when there is one. */
  async pair(q: PairExchangesQuery): Promise<ExchangesPage> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, EXCHANGE_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { exchanges: [] };

    const stored = canonicalPair(q.base, q.counter);
    const pairValues = [
      stored.base.currency,
      stored.base.issuer ?? '',
      stored.counter.currency,
      stored.counter.issuer ?? '',
    ];
    const cursor = keysetClause(EXCHANGE_KEYS, q.descending, after);
    const where = [
      ...PAIR_KEYS.map((k, i) => `${k.column} = {pair${i}:${k.type}}`),
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(q.autobridged ? ['autobridged_currency IS NOT NULL'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    // in the order of the whole key, each row once (a row written twice is there twice until a merge, and no FINAL is
    // used), with one more than the page: it only tells whether there is a next page
    const rows = await readDistinctPage<StoredExchange>(this.ch, {
      columns: EXCHANGE_COLUMNS,
      table: Table.Exchanges,
      where,
      orderBy: columnsOf(PAIR_ORDER),
      unique: columnsOf(EXCHANGE_KEYS),
      descending: q.descending,
      params: {
        ...Object.fromEntries(pairValues.map((v, i) => [`pair${i}`, v])),
        min: range.min,
        max: range.max,
        ...cursor.params,
      },
      limit: q.limit + 1,
    });
    return this.page(rows, q.limit, stored.inverted);
  }

  /**
   * One page of the exchanges of every pair, as they are stored, in the order of the ledgers.
   *
   * `exchanges` is ordered by the pair first, so the order of the ledgers is not an order the table can be read in: a
   * query over the whole window would sort all of it (by default every exchange since 2013) for one page, and through
   * the primary key ClickHouse can skip only the granules of pairs that are large enough to have some to themselves.
   * So the page is read in windows of ledgers, from the marker on (back, descending), each just long enough: the
   * `exchanges_count` of `ledgers` (the rows each ledger wrote to `exchanges`) says where the ledgers from the marker on
   * hold the exchanges the page still needs (`windowEdge`, one read in the order of the key of `ledgers`), and the
   * exchanges of that window are read and sorted to the page (a top-N with room for duplicates, deduped here: a row
   * written twice, no FINAL, sorts next to its copy). Usually that is one read of each table, however long the gap
   * before the next exchange; when a window holds fewer than counted (the marker cut its first ledger, a filter such as
   * `autobridged`, a ledger row written twice) the next one is sized for twice as many (Ruling R107).
   */
  async all(q: ExchangesWindow): Promise<ExchangesPage> {
    const after = decodeMarker(q.marker, EXCHANGE_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { exchanges: [] };

    // the ledgers still to read, [lo, hi]: from the ledger of the marker on (back to it, descending)
    let lo = range.min;
    let hi = range.max;
    if (after !== undefined) {
      if (q.descending) hi = Math.min(hi, Number(after[0]));
      else lo = Math.max(lo, Number(after[0]));
    }
    const cursor = keysetClause(EXCHANGE_KEYS, q.descending, after);
    // one row more than the page: it only tells whether there is a next page
    const fetch = q.limit + 1;
    const rows: StoredExchange[] = [];
    for (let round = 0; lo <= hi && rows.length < fetch; round++) {
      const want = fetch - rows.length;
      const edge = await this.windowEdge(lo, hi, Math.min(want * 2 ** round, MAX_WINDOW_EXCHANGES), q.descending);
      if (edge === undefined) break;
      const window = q.descending ? { min: edge, max: hi } : { min: lo, max: edge };
      rows.push(...(await this.allIn(window, cursor, q.autobridged, q.descending, want)));
      if (q.descending) hi = edge - 1;
      else lo = edge + 1;
    }
    return this.page(rows, q.limit, false);
  }

  /**
   * Where a window of `all()` ends: the first ledger from `lo` on (back from `hi`, descending) by which the ledgers of
   * `[lo, hi]` hold `count` exchanges, by their `exchanges_count`; the other end of the range when they hold fewer; none
   * when no ledger of the range has an exchange. One read of `ledgers` in the order of its key, with a plain `LIMIT` (a
   * ledger with an exchange holds at least one, so `count` of them are enough), and a running sum over those rows.
   * `exchanges_count` is written by the `LedgerWriter` with the exchanges of the ledger (`buildLedgerRows`), and the
   * lists serve committed ledgers only, whose `ledgers` row is that count.
   */
  private async windowEdge(lo: number, hi: number, count: number, descending: boolean): Promise<number | undefined> {
    const direction = descending ? 'DESC' : 'ASC';
    const [row] = await this.ch.query<{ found: number | string; edge: number | string }>(
      `SELECT count() AS found, ${descending ? 'maxIf' : 'minIf'}(ledger_index, total >= {count:UInt32}) AS edge
         FROM (SELECT ledger_index,
                      sum(n) OVER (ORDER BY ledger_index ${direction} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total
                 FROM (SELECT ledger_index, exchanges_count AS n FROM ${Table.Ledgers}
                        WHERE ledger_index BETWEEN {lo:UInt32} AND {hi:UInt32} AND exchanges_count > 0
                        ORDER BY ledger_index ${direction}
                        LIMIT {count:UInt32}))`,
      { lo, hi, count },
    );
    if (!row || Number(row.found) === 0) return undefined;
    // no ledger reached the count (an edge of 0: ledger indexes start at 1): the rest of the range is the window
    const edge = Number(row.edge);
    return edge === 0 ? (descending ? lo : hi) : edge;
  }

  /**
   * The first `want` exchanges of every pair in a window of ledgers, in the order of the page, each once. The read has
   * room for as many duplicates as rows wanted; if they fill it, it is read again with more (`readGrowingCap`).
   */
  private allIn(
    window: { min: number; max: number },
    cursor: { clause: string; params: Record<string, unknown> },
    autobridged: boolean,
    descending: boolean,
    want: number,
  ): Promise<StoredExchange[]> {
    const where = [
      'ledger_index BETWEEN {lo:UInt32} AND {hi:UInt32}',
      ...(autobridged ? ['autobridged_currency IS NOT NULL'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    const sql = `SELECT ${EXCHANGE_COLUMNS} FROM ${Table.Exchanges}
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderByClause(EXCHANGE_KEYS, descending)}
        LIMIT {cap:UInt32}`;
    return readGrowingCap(want, async (cap) => {
      const read = await this.ch.query<StoredExchange>(sql, { lo: window.min, hi: window.max, ...cursor.params, cap });
      const distinct = read.filter((row, i) => i === 0 || !sameExchange(row, read[i - 1]));
      return { result: distinct.slice(0, want), found: distinct.length, read: read.length };
    });
  }

  /**
   * One page of the candles of a pair, in the order asked for, with the marker of the next page when there is one.
   *
   * The candles are those of the buckets that start in the window, each of them whole, as the original served them:
   * it scanned the rows of `agg_exchanges` whose key (the start of the bucket) lies between `start` and the end, and
   * every row held its whole bucket. So the exchanges aggregated are those of the ledgers that closed from the first
   * bucket start at or after `start` to the end of the last bucket that starts before the end; both are read to the
   * second, as the original's row keys were. A marker is the start of the last bucket of the page: the next page is
   * the buckets after it (before it, descending), which narrows the ledgers to read.
   *
   * Two queries, both on the range of the primary key of the pair, read in its order:
   * - the buckets of the page and the one after it: the exchanges of the pair in the order of the page, with a plain
   *   inner `LIMIT` that ClickHouse stops at, grouped by bucket outside it: every bucket the read reached has its first
   *   exchange among the rows read (the read starts at the start of the range), so its first ledger is exact. When the
   *   read stopped at its cap with fewer than `limit + 1` buckets, it is read again with four times the room
   *   (`readGrowingCap`, from `EDGE_MIN_ROOM` on). A `LIMIT 1 BY bucket` in the same SELECT as the read made
   *   ClickHouse read the rest of the pair's range (Ruling R106). The first ledger of the bucket after the page (its
   *   last one, descending) bounds the page: one ledger closes at one time, so it lies in one bucket;
   * - the aggregation of the exchanges of those ledgers, by bucket.
   * Both rest on the close time never decreasing with the ledger index (`exchanges.close_time` is that of the ledger,
   * and a ledger closes after its parent): read in the order of the key, the buckets come in order too, so the first
   * `limit + 1` distinct ones are the page and the bucket after it, and a ledger bound is a bucket bound.
   * A page so costs what its own exchanges cost, wherever it lies in the window: the newest 30 days of a pair with years
   * of history (`descending=true&limit=30`) read 31 days of exchanges, not all of them.
   */
  async candles(q: CandlesQuery): Promise<CandlesPage> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, BUCKET_KEYS)?.[0] as number | undefined;

    const seconds = (d: Date): number => Math.floor(d.getTime() / 1000);
    let from = q.start === undefined ? undefined : firstBucketAtOrAfter(seconds(q.start), q.interval);
    let before = q.endExclusive === undefined ? undefined : firstBucketAtOrAfter(seconds(q.endExclusive), q.interval);
    if (after !== undefined && q.descending) {
      // the buckets that start before the marker (a marker inside a bucket keeps that bucket, whole)
      const bound = firstBucketAtOrAfter(after, q.interval);
      before = before === undefined ? bound : Math.min(before, bound);
    } else if (after !== undefined) {
      const bound = firstBucketAtOrAfter(after + 1, q.interval);
      from = from === undefined ? bound : Math.max(from, bound);
    }
    const date = (s: number | undefined): Date | undefined => (s === undefined ? undefined : new Date(s * 1000));
    const range = await this.ranges.resolve(date(from), date(before));
    if (!range) return { candles: [] };

    const stored = canonicalPair(q.base, q.counter);
    const bucket = `toUnixTimestamp(${bucketExpr(q.interval)})`;
    const direction = q.descending ? 'DESC' : 'ASC';

    const pair = this.pairFilter(stored, q.autobridged);
    const fetch = q.limit + 1;
    const edges = await readGrowingCap(
      fetch,
      async (cap) => {
        const rows = await this.ch.query<{ bucket: number; ledger_index: number; inner_read: number | string }>(
          `SELECT bucket, ${q.descending ? 'max' : 'min'}(ledger_index) AS ledger_index,
                  sum(count()) OVER () AS inner_read
             FROM (SELECT ${bucket} AS bucket, ledger_index
                     FROM ${Table.Exchanges}
                    WHERE ${[...pair.where, 'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}'].join(' AND ')}
                    ORDER BY ${orderByClause(PAIR_ORDER, q.descending)}
                    LIMIT {cap:UInt32})
            GROUP BY bucket
            ORDER BY bucket ${direction}
            LIMIT {fetch:UInt32}`,
          { ...pair.params, min: range.min, max: range.max, cap, fetch },
        );
        return { result: rows, found: rows.length, read: rows.length === 0 ? 0 : Number(rows[0].inner_read) };
      },
      EDGE_MIN_ROOM,
    );
    if (edges.length === 0) return { candles: [] };
    const more = edges.length > q.limit;
    const next = edges[edges.length - 1].ledger_index;
    const ledgers = !more
      ? range
      : q.descending
        ? { min: next + 1, max: range.max }
        : { min: range.min, max: next - 1 };

    const source = this.aggregationSource(stored, ledgers, q.autobridged);
    const rows = await this.ch.query<BucketRow>(
      `SELECT ${bucket} AS bucket,
         ${AGGREGATE_COLUMNS}
       FROM (${source.sql})
       GROUP BY bucket
       ORDER BY bucket ${direction}`,
      source.params,
    );
    return {
      candles: rows.map((row) => toCandleObject(row, q, stored.inverted)),
      ...(more && rows.length > 0 && { marker: encodeMarker([rows[rows.length - 1].bucket]) }),
    };
  }

  /**
   * All the exchanges of a pair in the window as one row (`reduce`). The whole window is aggregated, in ClickHouse: the
   * original reduced the first page of its scan only (`limit`, 200 by default and 400 at most), and from the `marker`
   * on; here there is neither limit nor marker. No exchange gives the original's row of zeros.
   *
   * The window is read to the second, as the candles' is and as the original's row keys were (`YYYYMMDDHHmmss`):
   * `start=…:40.500Z` takes the ledgers that closed at :40, and an `end` of `…:40.500Z` (the period up to :40.501)
   * stops before them.
   */
  async reduce(q: ReduceQuery): Promise<ReducedObject> {
    const stored = canonicalPair(q.base, q.counter);
    const toSecond = (d: Date): Date => new Date(Math.floor(d.getTime() / 1000) * 1000);
    const range = await this.ranges.resolve(
      toSecond(q.start),
      q.endExclusive === undefined ? undefined : toSecond(q.endExclusive),
    );
    if (!range) return toReducedObject(undefined, q, stored.inverted, q.start);

    const source = this.aggregationSource(stored, range, q.autobridged);
    const [row] = await this.ch.query<AggregateRow>(
      `SELECT ${AGGREGATE_COLUMNS}
       FROM (${source.sql})`,
      source.params,
    );
    return toReducedObject(row, q, stored.inverted, q.start);
  }

  /**
   * The exchanges of a stored pair that the original aggregated: the conditions on `exchanges` and their params. An
   * exchange whose native leg (the side without an issuer) is 0.0005 or less is left out, as the original's aggregation
   * did ("tiny amounts that exist from rounding errors in XRP"; its reduce used `< 0.0005`, its candles `<= 0.0005`:
   * the candles' rule is used for both).
   */
  private pairFilter(
    stored: { base: Asset; counter: Asset },
    autobridged: boolean,
  ): { where: string[]; params: Record<string, unknown> } {
    const pairValues = [
      stored.base.currency,
      stored.base.issuer ?? '',
      stored.counter.currency,
      stored.counter.issuer ?? '',
    ];
    return {
      where: [
        ...PAIR_KEYS.map((k, i) => `${k.column} = {pair${i}:${k.type}}`),
        ...(autobridged ? ['autobridged_currency IS NOT NULL'] : []),
        ...(stored.base.issuer ? [] : ['base_amount_f > 0.0005']),
        ...(stored.counter.issuer ? [] : ['counter_amount_f > 0.0005']),
      ],
      params: Object.fromEntries(pairValues.map((v, i) => [`pair${i}`, v])),
    };
  }

  /**
   * The exchanges of a stored pair in a ledger range that the original aggregated (`pairFilter`), as a subquery: the
   * columns `AGGREGATE_COLUMNS` and `bucketExpr` read, each exchange once. The pair is read as a range of the primary
   * key, in its order (the whole key spelled out, as the raw list does), and `LIMIT 1 BY` the key counts a row that was
   * written twice (no FINAL) once.
   */
  private aggregationSource(
    stored: { base: Asset; counter: Asset },
    range: { min: number; max: number },
    autobridged: boolean,
  ): { sql: string; params: Record<string, unknown> } {
    const pair = this.pairFilter(stored, autobridged);
    return {
      sql: `SELECT ${AGGREGATE_SOURCE_COLUMNS}
           FROM ${Table.Exchanges}
          WHERE ${[...pair.where, 'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}'].join(' AND ')}
          ORDER BY ${orderByClause(PAIR_ORDER, false)}
          LIMIT 1 BY ${PAIR_ORDER.map((k) => k.column).join(', ')}`,
      params: { ...pair.params, min: range.min, max: range.max },
    };
  }

  /** The page of the rows that were fetched with one row more than the limit, inverted for a reversed pair. */
  private page(rows: StoredExchange[], limit: number, inverted: boolean): ExchangesPage {
    const page = paginate(rows, limit, (row) => [row.ledger_index, row.tx_index, row.node_index]);
    return {
      exchanges: page.rows.map((row) => toExchangeObject(row, inverted)),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}
