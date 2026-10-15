import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, keysetClause, KeysetKey, orderByClause, paginate } from '../common/pagination';
import { TxObject, TxService } from '../common/tx-object';

/** The key of the list, which is the ORDER BY suffix of both tables it reads and so what a marker holds. */
export const TRANSACTION_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

/** What `GET /v2/transactions` is asked for; the values are already validated. */
export interface TransactionsQuery {
  /** Inclusive: the first ledger that closed at or after it starts the list. */
  start: Date;
  /** Exclusive; without it the list runs to the newest ledger. */
  endExclusive?: Date;
  /** A transaction type of the network (`Payment`), served from `tx_by_type`. */
  type?: string;
  /** A transaction result code of the network (`tesSUCCESS`). */
  result?: string;
  binary: boolean;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

interface Key {
  ledger_index: number;
  tx_index: number;
}

/**
 * The transactions of the API (`getTransactions` of the original, which served both routes).
 *
 * A list turns its dates into a range of ledgers once, then pages through the narrow table whose ORDER BY starts with
 * what it filters on: `tx_by_type` for a type (`ORDER BY tx_type, ledger_index, tx_index`, `result` is a column of
 * it), otherwise the key columns of `transactions` itself. The keys of a page are then read in full, from
 * `transactions`, by `TxService`.
 */
@Injectable()
export class TransactionsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly txs: TxService,
  ) {}

  /** The transaction with the given hash (upper case), `undefined` when there is none. Single ones carry no `ledger_hash`. */
  async getByHash(hash: string, binary: boolean): Promise<TxObject | undefined> {
    const [key] = await this.ch.query<Key>(
      `SELECT ledger_index, tx_index FROM ${Table.TxByHash} WHERE hash = {hash:String} LIMIT 1`,
      { hash },
    );
    if (!key) return undefined;
    const [row] = await this.txs.fetchByKeys([key]);
    return row && this.txs.toTxObject(row, { binary });
  }

  /**
   * One page of the list, in the order asked for, with the marker of the next page when there is one. Each item
   * carries the `ledger_hash` of its ledger.
   */
  async list(q: TransactionsQuery): Promise<{ transactions: TxObject[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, TRANSACTION_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { transactions: [] };

    const cursor = keysetClause(TRANSACTION_KEYS, q.descending, after);
    const byType = q.type !== undefined;
    const conditions = [
      ...(byType ? ['tx_type = {type:String}'] : []),
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(q.result !== undefined ? ['result = {result:String}'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    // `LIMIT 1 BY`: a row that was written twice (the tables are not collapsed before a merge, and no FINAL is used)
    // counts once; the extra row tells whether there is a next page
    const found = await this.ch.query<Key>(
      `SELECT ledger_index, tx_index FROM ${byType ? Table.TxByType : Table.Transactions}
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderByClause(TRANSACTION_KEYS, q.descending)}
        LIMIT 1 BY ledger_index, tx_index
        LIMIT {fetch:UInt32}`,
      {
        ...(byType && { type: q.type }),
        ...(q.result !== undefined && { result: q.result }),
        min: range.min,
        max: range.max,
        ...cursor.params,
        fetch: q.limit + 1,
      },
    );

    const page = paginate(found, q.limit, (key) => [key.ledger_index, key.tx_index]);
    const [rows, ledgerHashes] = await Promise.all([
      this.txs.fetchByKeys(page.rows),
      this.txs.ledgerHashes(page.rows.map((key) => key.ledger_index)),
    ]);
    const transactions = await this.txs.toTxObjects(rows, { binary: q.binary, ledgerHashes });
    return { transactions, ...(page.marker !== undefined && { marker: page.marker }) };
  }
}
