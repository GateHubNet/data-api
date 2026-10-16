import { Asset, ClickHouseService, readDistinctPage, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { PAYMENT_COLUMNS, PaymentObject, StoredPayment, toPaymentObject } from './payment-object';

/** The key of the list, which is the ORDER BY of `payments` and the suffix of that of `payments_by_currency`. */
export const PAYMENT_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

/**
 * The ORDER BY of `payments_by_currency`, which a list of one currency has to sort by. The currency and the issuer are
 * fixed by the query, so this is the order of the key; spelled out, it lets ClickHouse read the table in the order of
 * its primary key. With only `ledger_index, tx_index` it would sort every key of the currency in the range first.
 */
const PAYMENT_BY_CURRENCY_ORDER: KeysetKey[] = [
  { column: 'currency', type: 'String' },
  { column: 'issuer', type: 'String' },
  ...PAYMENT_KEYS,
];

/** The key of a payment. */
export interface PaymentKey {
  ledger_index: number;
  tx_index: number;
}

/**
 * The rows of `payments` of some keys, in the order of the keys, each once (a payment written twice is there twice until a
 * merge: either copy is the same payment); a key without a row is left out. The keys go in as two arrays that the server
 * zips back into tuples, and the range of their ledgers prunes the partitions.
 */
export async function paymentsByKeys(ch: ClickHouseService, keys: PaymentKey[]): Promise<StoredPayment[]> {
  if (keys.length === 0) return [];
  const ledgers = keys.map((k) => k.ledger_index);
  const rows = await ch.query<StoredPayment>(
    `SELECT ${PAYMENT_COLUMNS} FROM ${Table.Payments}
      WHERE ledger_index BETWEEN {lo:UInt32} AND {hi:UInt32}
        AND (ledger_index, tx_index) IN (
            SELECT tupleElement(key, 1), tupleElement(key, 2)
              FROM (SELECT arrayJoin(arrayZip({ledgers:Array(UInt32)}, {indexes:Array(UInt32)})) AS key))`,
    {
      lo: Math.min(...ledgers),
      hi: Math.max(...ledgers),
      ledgers,
      indexes: keys.map((k) => k.tx_index),
    },
  );
  const byKey = new Map(rows.map((row) => [`${row.ledger_index}:${row.tx_index}`, row]));
  return keys.flatMap((k) => byKey.get(`${k.ledger_index}:${k.tx_index}`) ?? []);
}

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
 * `payments_by_currency` (`ORDER BY currency, issuer, ledger_index, tx_index`), whose page of keys is then read in full
 * from `payments` (`paymentsByKeys`). A page is read with `readDistinctPage`: in the order of the whole key, each row once.
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

    const inRange = ['ledger_index BETWEEN {min:UInt32} AND {max:UInt32}'];
    // one row more than the page: it only tells whether there is a next page
    const fetch = q.limit + 1;

    if (q.asset === undefined) {
      const cursor = keysetClause(PAYMENT_KEYS, q.descending, after);
      const rows = await readDistinctPage<StoredPayment>(this.ch, {
        columns: PAYMENT_COLUMNS,
        table: Table.Payments,
        where: [...inRange, ...(cursor.clause !== '' ? [cursor.clause] : [])],
        orderBy: columnsOf(PAYMENT_KEYS),
        unique: columnsOf(PAYMENT_KEYS),
        descending: q.descending,
        params: { min: range.min, max: range.max, ...cursor.params },
        limit: fetch,
      });
      const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index]);
      return {
        payments: page.rows.map(toPaymentObject),
        ...(page.marker !== undefined && { marker: page.marker }),
      };
    }

    const currency = q.asset.currency;
    const issuer = q.asset.issuer ?? '';
    const cursor = keysetClause(PAYMENT_KEYS, q.descending, after);
    const keys = await readDistinctPage<PaymentKey>(this.ch, {
      columns: 'ledger_index, tx_index',
      table: Table.PaymentsByCurrency,
      where: [
        'currency = {currency:String}',
        'issuer = {issuer:String}',
        ...inRange,
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: columnsOf(PAYMENT_BY_CURRENCY_ORDER),
      unique: columnsOf(PAYMENT_KEYS),
      descending: q.descending,
      params: { currency, issuer, min: range.min, max: range.max, ...cursor.params },
      limit: fetch,
    });
    // the page is cut from the keys, so a key whose wide row is missing cannot end the list early
    const page = paginate(keys, q.limit, (key) => [key.ledger_index, key.tx_index]);
    const rows = await paymentsByKeys(this.ch, page.rows);
    return {
      payments: rows.map(toPaymentObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}
