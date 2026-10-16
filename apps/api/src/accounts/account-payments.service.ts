import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, keysetClause, KeysetKey, orderByClause, paginate } from '../common/pagination';
import { PAYMENT_COLUMNS, PaymentObject, StoredPayment, toPaymentObject } from '../payments/payment-object';
import { PAYMENT_KEYS } from '../payments/payments.service';
import { AccountWindow } from './account-window';

/**
 * The ORDER BY of `account_payments`. `account` is fixed by the query, but it stays in the ORDER BY: ClickHouse reads a
 * table in the order of its key only when the ORDER BY starts with a prefix of that key, and a suffix-only ORDER BY can
 * make it read the whole history of the account and sort it (found in Task 21 for `payments_by_currency`).
 */
const ACCOUNT_PAYMENT_ORDER: KeysetKey[] = [{ column: 'account', type: 'String' }, ...PAYMENT_KEYS];

/** The direction of a payment for the account (`type=sent|received`). */
export type PaymentDirection = 'sent' | 'received';

/** What `GET /v2/accounts/:address/payments` is asked for; the values are already validated. */
export interface AccountPaymentsQuery extends AccountWindow {
  account: string;
  /** Only the payments the account sent / received. */
  direction?: PaymentDirection;
  /** Only the payments of this currency (upper case). */
  currency?: string;
  /** Only the payments of this issuer; the native currency's is `''`, which no address equals. */
  issuer?: string;
  /** Only this tag. `null` is a value no tag can have (not a number, or beyond a UInt32): nothing matches. */
  sourceTag?: number | null;
  destinationTag?: number | null;
}

/**
 * The payments of an account (`getAccountPayments` of the original).
 *
 * The keys of a page come from the narrow `account_payments` (`ORDER BY account, ledger_index, tx_index`, a `sent` and
 * a `received` row per payment, with the currency, issuer, tags and direction the list filters on), and the wide rows
 * from `payments` through an `IN` subquery on them: the payment is the one `GET /v2/payments` serves. The dates become
 * a range of ledgers once.
 */
@Injectable()
export class AccountPaymentsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the list, in the order asked for, with the marker of the next page when there is one. */
  async list(q: AccountPaymentsQuery): Promise<{ payments: PaymentObject[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, PAYMENT_KEYS);
    // no payment has a tag that is not a number: nothing to read
    if (q.sourceTag === null || q.destinationTag === null) return { payments: [] };

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { payments: [] };

    const cursor = keysetClause(PAYMENT_KEYS, q.descending, after);
    const conditions = [
      'account = {account:String}',
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(q.direction !== undefined ? ['direction = {direction:String}'] : []),
      ...(q.currency !== undefined ? ['currency = {currency:String}'] : []),
      ...(q.issuer !== undefined ? ['issuer = {issuer:String}'] : []),

      ...(q.sourceTag !== undefined ? ['source_tag = {source_tag:UInt32}'] : []),
      ...(q.destinationTag !== undefined ? ['destination_tag = {destination_tag:UInt32}'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];

    // `LIMIT 1 BY`: a row that was written twice (the tables are not collapsed before a merge, and no FINAL is used)
    // counts once, in the index and in the table; the extra row of the page only tells whether there is a next page
    const rows = await this.ch.query<StoredPayment>(
      `SELECT ${PAYMENT_COLUMNS} FROM ${Table.Payments}
        WHERE ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
          AND (ledger_index, tx_index) IN (
              SELECT ledger_index, tx_index FROM ${Table.AccountPayments}
               WHERE ${conditions.join(' AND ')}
               ORDER BY ${orderByClause(ACCOUNT_PAYMENT_ORDER, q.descending)}
               LIMIT 1 BY ledger_index, tx_index
               LIMIT {fetch:UInt32})
        ORDER BY ${orderByClause(PAYMENT_KEYS, q.descending)}
        LIMIT 1 BY ledger_index, tx_index`,
      {
        account: q.account,
        min: range.min,
        max: range.max,
        ...(q.direction !== undefined && { direction: q.direction }),
        ...(q.currency !== undefined && { currency: q.currency }),
        ...(q.issuer !== undefined && { issuer: q.issuer }),
        ...(q.sourceTag !== undefined && { source_tag: q.sourceTag }),
        ...(q.destinationTag !== undefined && { destination_tag: q.destinationTag }),
        ...cursor.params,
        fetch: q.limit + 1,
      },
    );

    const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index]);
    return {
      payments: page.rows.map(toPaymentObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}
