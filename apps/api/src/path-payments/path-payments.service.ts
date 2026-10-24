import { ClickHouseService, PathPaymentsRow, readDistinctPage, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { TxKey, txKeysIn, txKeyString } from '../common/tx-keys';
import { PATH_PAYMENT_COLUMNS, PathPaymentObject, toPathPaymentObject } from './path-payment-object';

/** The key of the list, which is the ORDER BY of `path_payments`. */
export const PATH_PAYMENT_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

/**
 * The ORDER BY of `account_path_payments`: its whole sorting key. `account` is fixed by the query but stays in it, so
 * that ClickHouse reads the account's rows in the order of the key instead of sorting them.
 */
const ACCOUNT_PATH_PAYMENT_ORDER = ['account', ...columnsOf(PATH_PAYMENT_KEYS)];

/** What `GET /v2/path_payments` and `GET /v2/accounts/:address/path_payments` are asked for; already validated. */
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
 * The path payments of the network or of an account in a window. The dates become a range of ledgers once, then one
 * page is read in the order of the key, each path payment once (`readDistinctPage`: a ledger written twice is not
 * listed twice): from `path_payments` for the network, and for an account the keys from its index
 * `account_path_payments`, whose path payments are then read from `path_payments`.
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

  /**
   * One page of the path payments `account` sent or received, in the order asked for, with the marker of the next page
   * when there is one. A payment to oneself has one row in the index, so it is listed once.
   */
  async listOfAccount(
    account: string,
    q: PathPaymentsQuery,
  ): Promise<{ pathPayments: PathPaymentObject[]; marker?: string }> {
    const after = decodeMarker(q.marker, PATH_PAYMENT_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { pathPayments: [] };

    const cursor = keysetClause(PATH_PAYMENT_KEYS, q.descending, after);
    const keys = await readDistinctPage<TxKey>(this.ch, {
      columns: 'ledger_index, tx_index',
      table: Table.AccountPathPayments,
      where: [
        'account = {account:String}',
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: ACCOUNT_PATH_PAYMENT_ORDER,
      unique: columnsOf(PATH_PAYMENT_KEYS),
      descending: q.descending,
      params: { account, min: range.min, max: range.max, ...cursor.params },
      limit: q.limit + 1,
    });

    // the page is cut from the keys, so a key whose path payment is missing cannot end the list early
    const page = paginate(keys, q.limit, (key) => [key.ledger_index, key.tx_index]);
    const rows = await this.byKeys(page.rows);
    return {
      pathPayments: rows.map(toPathPaymentObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /** How many path payments the window of `q` holds, all its pages together (an export's count, ticket #16). */
  async count(q: Pick<PathPaymentsQuery, 'start' | 'endExclusive'>): Promise<number> {
    return this.countIn(Table.PathPayments, [], {}, q);
  }

  /** How many path payments `account` sent or received in the window of `q`, all its pages together. */
  async countOfAccount(account: string, q: Pick<PathPaymentsQuery, 'start' | 'endExclusive'>): Promise<number> {
    return this.countIn(Table.AccountPathPayments, ['account = {account:String}'], { account }, q);
  }

  /** The distinct keys of `table` in the ledgers of the window, under `conditions` (a ledger written twice counts once). */
  private async countIn(
    table: Table,
    conditions: string[],
    params: Record<string, string>,
    q: Pick<PathPaymentsQuery, 'start' | 'endExclusive'>,
  ): Promise<number> {
    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return 0;
    const row = await this.ch.queryOne<{ n: number | string }>(
      `SELECT count() AS n FROM (
         SELECT DISTINCT ledger_index, tx_index FROM ${table}
          WHERE ${[...conditions, 'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}'].join(' AND ')}
       )`,
      { ...params, min: range.min, max: range.max },
    );
    return Number(row?.n ?? 0);
  }

  /** The path payments of these keys, in their order, each once; a key without a row is left out. */
  private async byKeys(keys: TxKey[]): Promise<PathPaymentsRow[]> {
    if (keys.length === 0) return [];
    const among = txKeysIn(keys);
    // a ledger written twice has the row twice until a merge (no FINAL is used): the map below keeps one
    const rows = await this.ch.query<PathPaymentsRow>(
      `SELECT ${PATH_PAYMENT_COLUMNS} FROM ${Table.PathPayments} WHERE ${among.clause}`,
      among.params,
    );
    const byKey = new Map(rows.map((row) => [txKeyString(row), row]));
    return keys.flatMap((k) => byKey.get(txKeyString(k)) ?? []);
  }
}
