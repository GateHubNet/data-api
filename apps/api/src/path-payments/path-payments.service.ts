import { ClickHouseService, PathPaymentsRow, readDistinctPage, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { PATH_PAYMENT_COLUMNS, PathPaymentObject, toPathPaymentObject } from './path-payment-object';

/** The key of the list, which is the ORDER BY of `path_payments`. */
export const PATH_PAYMENT_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

/** What `GET /v2/path_payments` is asked for; the values are already validated. */
export interface PathPaymentsQuery {
  /** Inclusive: the first ledger that closed at or after it starts the list. */
  start?: Date;
  /** Exclusive; without it the list runs to the newest ledger. */
  endExclusive?: Date;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/**
 * The path payments of the network in a window. The dates become a range of ledgers once, then one page of
 * `path_payments` is read in the order of its key, each row once (`readDistinctPage`: a ledger written twice is not
 * listed twice).
 */
@Injectable()
export class PathPaymentsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the list, in the order asked for, with the marker of the next page when there is one. */
  async list(q: PathPaymentsQuery): Promise<{ pathPayments: PathPaymentObject[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, PATH_PAYMENT_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { pathPayments: [] };

    const cursor = keysetClause(PATH_PAYMENT_KEYS, q.descending, after);
    const rows = await readDistinctPage<PathPaymentsRow>(this.ch, {
      columns: PATH_PAYMENT_COLUMNS,
      table: Table.PathPayments,
      where: ['ledger_index BETWEEN {min:UInt32} AND {max:UInt32}', ...(cursor.clause !== '' ? [cursor.clause] : [])],
      orderBy: columnsOf(PATH_PAYMENT_KEYS),
      unique: columnsOf(PATH_PAYMENT_KEYS),
      descending: q.descending,
      params: { min: range.min, max: range.max, ...cursor.params },
      // one row more than the page: it only tells whether there is a next page
      limit: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index]);
    return {
      pathPayments: page.rows.map(toPathPaymentObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}
