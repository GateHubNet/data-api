import { Asset, ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, keysetClause, KeysetKey, orderByClause, paginate } from '../common/pagination';
import { PAYMENT_COLUMNS, PaymentObject, StoredPayment, toPaymentObject } from './payment-object';

/** The key of the list, which is the ORDER BY of `payments` and the suffix of that of `payments_by_currency`. */
export const PAYMENT_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

/**
 * The ORDER BY of `payments_by_currency`, which a list of one currency has to sort by. The currency and the issuer are
 * fixed by the query, so this is the order of the key; spelled out, it lets ClickHouse read the table in the order of
 * its primary key and stop after the page. With only `ledger_index, tx_index` it would sort every key of the currency
 * in the range first.
 */
const PAYMENT_BY_CURRENCY_ORDER: KeysetKey[] = [
  { column: 'currency', type: 'String' },
  { column: 'issuer', type: 'String' },
  ...PAYMENT_KEYS,
];

/** What `GET /v2/payments[/:currency]` is asked for; the values are already validated. */
export interface PaymentsQuery {
  /** Inclusive: the first ledger that closed at or after it starts the list. */
  start?: Date;
  /** Exclusive; without it the list runs to the newest ledger. */
  endExclusive?: Date;
  /** The payments of this currency only (`issuer` unset for the native currency), served from `payments_by_currency`. */
  asset?: Asset;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/**
 * The payments of the API (`getPayments` of the original).
 *
 * A list turns its dates into a range of ledgers once, then reads the table whose ORDER BY starts with what it filters
 * on: `payments` itself for all currencies (`ORDER BY ledger_index, tx_index`), and for a currency the narrow
 * `payments_by_currency` (`ORDER BY currency, issuer, ledger_index, tx_index`), whose page of keys selects the wide rows
 * of `payments` with an `IN` subquery.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the list, in the order asked for, with the marker of the next page when there is one. */
  async list(q: PaymentsQuery): Promise<{ payments: PaymentObject[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, PAYMENT_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { payments: [] };

    const cursor = keysetClause(PAYMENT_KEYS, q.descending, after);
    const inRange = [
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    const order = orderByClause(PAYMENT_KEYS, q.descending);
    const params = {
      min: range.min,
      max: range.max,
      ...cursor.params,
      // one row more than the page: it only tells whether there is a next page
      fetch: q.limit + 1,
    };

    // `LIMIT 1 BY`: a row that was written twice (the tables are not collapsed before a merge, and no FINAL is used)
    // counts once
    const rows =
      q.asset === undefined
        ? await this.ch.query<StoredPayment>(
            `SELECT ${PAYMENT_COLUMNS} FROM ${Table.Payments}
              WHERE ${inRange.join(' AND ')}
              ORDER BY ${order}
              LIMIT 1 BY ledger_index, tx_index
              LIMIT {fetch:UInt32}`,
            params,
          )
        : await this.ch.query<StoredPayment>(
            `SELECT ${PAYMENT_COLUMNS} FROM ${Table.Payments}
              WHERE ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
                AND (ledger_index, tx_index) IN (
                    SELECT ledger_index, tx_index FROM ${Table.PaymentsByCurrency}
                     WHERE currency = {currency:String} AND issuer = {issuer:String} AND ${inRange.join(' AND ')}
                     ORDER BY ${orderByClause(PAYMENT_BY_CURRENCY_ORDER, q.descending)}
                     LIMIT 1 BY ledger_index, tx_index
                     LIMIT {fetch:UInt32})
              ORDER BY ${order}
              LIMIT 1 BY ledger_index, tx_index`,
            { ...params, currency: q.asset.currency, issuer: q.asset.issuer ?? '' },
          );

    const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index]);
    return {
      payments: page.rows.map(toPaymentObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}
