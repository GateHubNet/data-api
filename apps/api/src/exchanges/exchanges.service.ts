import { Asset, canonicalPair, ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, keysetClause, KeysetKey, orderByClause, paginate } from '../common/pagination';
import { EXCHANGE_COLUMNS, ExchangeObject, StoredExchange, toExchangeObject } from './exchange-object';

/** The key of a list of exchanges, which is the end of the ORDER BY of `exchanges`, and what a marker holds. */
export const EXCHANGE_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
  { column: 'node_index', type: 'UInt16' },
];

/** The start of the ORDER BY of `exchanges`: the pair, in the order it is stored. */
const PAIR_KEYS: KeysetKey[] = [
  { column: 'base_currency', type: 'String' },
  { column: 'base_issuer', type: 'String' },
  { column: 'counter_currency', type: 'String' },
  { column: 'counter_issuer', type: 'String' },
];

/**
 * The whole ORDER BY of `exchanges`. A list of one pair fixes the first four columns, so its order is that of
 * `EXCHANGE_KEYS`, but it has to ask for the whole key: with only `ledger_index, tx_index, node_index` ClickHouse
 * cannot read the table in the order of its primary key, and sorts every row of the pair in the range first (found in
 * Task 21 for `payments_by_currency`). Spelled out, it reads in order and stops after the page.
 */
const PAIR_ORDER: KeysetKey[] = [...PAIR_KEYS, ...EXCHANGE_KEYS];

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

/**
 * The exchanges of the API (`hbase.getExchanges` of the original, without the aggregation).
 *
 * `exchanges` is ordered by the pair first (`base_currency, base_issuer, counter_currency, counter_issuer,
 * ledger_index, tx_index, node_index`), with the pair in Ripple's canonical order, so the list of a pair is a range of
 * the primary key and is read in order. The dates become a range of ledgers once, before the query. A pair that is asked
 * for the other way round is read as it is stored and every row is inverted on the way out.
 *
 * The list of all pairs has no pair to fix, so it is a scan of the ledger range, sorted by the key of the ledger.
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
    // the tuple of the whole key: the pair is equal, so only the ledger part decides, and ClickHouse can use it
    // on the primary key
    const cursor = keysetClause(PAIR_ORDER, q.descending, after && [...pairValues, ...after]);
    const where = [
      ...PAIR_KEYS.map((k, i) => `${k.column} = {pair${i}:${k.type}}`),
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(q.autobridged ? ['autobridged_currency IS NOT NULL'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    const params: Record<string, unknown> = {
      ...Object.fromEntries(pairValues.map((v, i) => [`pair${i}`, v])),
      min: range.min,
      max: range.max,
      ...cursor.params,
      // one row more than the page: it only tells whether there is a next page
      fetch: q.limit + 1,
    };

    // `LIMIT 1 BY` the whole key: a row that was written twice (the tables are not collapsed before a merge, and no FINAL
    // is used) counts once
    const rows = await this.ch.query<StoredExchange>(
      `SELECT ${EXCHANGE_COLUMNS} FROM ${Table.Exchanges}
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderByClause(PAIR_ORDER, q.descending)}
        LIMIT 1 BY ${PAIR_ORDER.map((k) => k.column).join(', ')}
        LIMIT {fetch:UInt32}`,
      params,
    );
    return this.page(rows, q.limit, stored.inverted);
  }

  /** One page of the exchanges of every pair, as they are stored, in the order of the ledgers. */
  async all(q: ExchangesWindow): Promise<ExchangesPage> {
    const after = decodeMarker(q.marker, EXCHANGE_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { exchanges: [] };

    const cursor = keysetClause(EXCHANGE_KEYS, q.descending, after);
    const where = [
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(q.autobridged ? ['autobridged_currency IS NOT NULL'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    const rows = await this.ch.query<StoredExchange>(
      `SELECT ${EXCHANGE_COLUMNS} FROM ${Table.Exchanges}
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderByClause(EXCHANGE_KEYS, q.descending)}
        LIMIT 1 BY ${EXCHANGE_KEYS.map((k) => k.column).join(', ')}
        LIMIT {fetch:UInt32}`,
      { min: range.min, max: range.max, ...cursor.params, fetch: q.limit + 1 },
    );
    return this.page(rows, q.limit, false);
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
