import { ClickHouseService, readDistinctPage, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { TxObject, TxService } from '../common/tx-object';

/** The highest `Sequence` a transaction can have: the column is a UInt32. */
const MAX_SEQUENCE = 4_294_967_295;

/**
 * The ORDER BY of `account_transactions`. `account` is fixed by the query, but it stays in the ORDER BY: ClickHouse
 * reads a table in the order of its key only when the ORDER BY starts with a prefix of that key, and a suffix-only
 * ORDER BY can make it read the whole history of the account and sort it.
 */
const TIME_ORDER: KeysetKey[] = [
  { column: 'account', type: 'String' },
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];
/** What a marker of the time list holds: the ORDER BY without the account. */
const TIME_KEYS: KeysetKey[] = TIME_ORDER.slice(1);

/** The ORDER BY of `account_tx_by_sequence`, with the account for the same reason. */
const SEQUENCE_ORDER: KeysetKey[] = [
  { column: 'account', type: 'String' },
  { column: 'sequence', type: 'UInt32' },
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];
/** What a marker of the sequence list holds: the ORDER BY without the account. */
const SEQUENCE_KEYS: KeysetKey[] = SEQUENCE_ORDER.slice(1);

/** What both lists are asked for; the values are already validated. */
interface ListQuery {
  account: string;
  /** A transaction type of the network (`Payment`). */
  type?: string;
  /** A transaction result code of the network (`tesSUCCESS`). */
  result?: string;
  binary: boolean;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/** The list by time: the transactions that affect the account in the ledgers that closed between `start` and `end`. */
export interface TimeQuery extends ListQuery {
  /** Inclusive: the first ledger that closed at or after it starts the list. Without it, the first ledger. */
  start?: Date;
  /** Exclusive; without it the list runs to the newest ledger. */
  endExclusive?: Date;
}

/**
 * The list by sequence: the transactions the account sent with a `Sequence` between the two bounds, both ends included.
 * With both bounds given, their order does not matter: the original's HBase scan swapped them (ruling R57), so
 * `min_sequence=9&max_sequence=5` is the range 5 to 9.
 */
export interface SequenceQuery extends ListQuery {
  /** Without it, 0. Alone, above what a sequence can be, it leaves nothing to list. */
  minSequence?: number;
  /** Without it, no upper bound. Above what a sequence can be, the bound is the highest sequence. */
  maxSequence?: number;
}

/** A page: the transactions in the order asked for, and the marker of the next page when there is one. */
export interface TransactionsPage {
  transactions: TxObject[];
  marker?: string;
}

interface TimeKey {
  ledger_index: number;
  tx_index: number;
}

interface SequenceKey extends TimeKey {
  sequence: number;
}

/**
 * The transactions of an account (`getAccountTransactions` and `getAccountTransaction` of the original).
 *
 * Two lists, as in the original, each paged through the narrow table whose ORDER BY starts with the filter:
 *  - by time (the default): `account_transactions`, one row per account a transaction affects (sender, recipient,
 *    offer owners, issuers, ...). The dates become a range of ledgers once, `type` and `result` are columns of the
 *    table, a marker is `(ledger_index, tx_index)`;
 *  - by sequence (`min_sequence` or `max_sequence`): `account_tx_by_sequence`, the transactions the account sent,
 *    ordered by their `Sequence`, a marker is `(sequence, ledger_index, tx_index)`. No dates here. `type` and
 *    `result` are looked up in the sender's own row of `account_transactions`.
 *
 * The keys of a page are then read in full from `transactions` by `TxService`.
 */
@Injectable()
export class AccountTransactionsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly txs: TxService,
  ) {}

  /** One page of the transactions that affect the account in a time window. */
  async listByTime(q: TimeQuery): Promise<TransactionsPage> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, TIME_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { transactions: [] };

    const cursor = keysetClause(TIME_KEYS, q.descending, after);
    const conditions = [
      'account = {account:String}',
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(q.type !== undefined ? ['tx_type = {type:String}'] : []),
      ...(q.result !== undefined ? ['result = {result:String}'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    // in the order of the whole key, each row once (a row written twice is there twice until a merge, and no FINAL is
    // used), with one more than the page: it tells whether there is a next page
    const found = await readDistinctPage<TimeKey>(this.ch, {
      columns: 'ledger_index, tx_index',
      table: Table.AccountTransactions,
      where: conditions,
      orderBy: columnsOf(TIME_ORDER),
      unique: columnsOf(TIME_KEYS),
      descending: q.descending,
      params: {
        account: q.account,
        ...(q.type !== undefined && { type: q.type }),
        ...(q.result !== undefined && { result: q.result }),
        min: range.min,
        max: range.max,
        ...cursor.params,
      },
      limit: q.limit + 1,
    });

    const page = paginate(found, q.limit, (key) => [key.ledger_index, key.tx_index]);
    return this.page(page.rows, page.marker, q.binary);
  }

  /** One page of the transactions the account sent, by their `Sequence`. */
  async listBySequence(q: SequenceQuery): Promise<TransactionsPage> {
    const after = decodeMarker(q.marker, SEQUENCE_KEYS);

    // Both bounds given upside down are swapped, as the HBase scan of the original did (R57). Only when both are given,
    // and on the numbers as sent: a missing `max_sequence` is not the highest sequence yet, or `min_sequence=4294967296`
    // alone would swap to the highest rows where the original finds nothing.
    const { minSequence, maxSequence } = q;
    const both = minSequence !== undefined && maxSequence !== undefined;
    const low = both ? Math.min(minSequence, maxSequence) : (minSequence ?? 0);
    const high = both ? Math.max(minSequence, maxSequence) : (maxSequence ?? MAX_SEQUENCE);
    // nothing has a sequence above the highest; a bound beyond it only means "up to the highest"
    if (low > MAX_SEQUENCE) return { transactions: [] };
    const min = low;
    const max = Math.min(high, MAX_SEQUENCE);

    const cursor = keysetClause(SEQUENCE_KEYS, q.descending, after);
    const filtered = q.type !== undefined || q.result !== undefined;
    const conditions = [
      'account = {account:String}',
      'sequence BETWEEN {min_sequence:UInt32} AND {max_sequence:UInt32}',
      // The table has no type and no result: those are in the row of the sender in `account_transactions`, which the
      // account prefix of its key finds without reading any other account. The subquery is not bounded by the sequence
      // range or the marker (it cannot be, that table has no sequence), so it reads the matching rows of the whole
      // account on every page; that is the cost of a filtered sequence list, like a filtered time list scanning the
      // account until it has a page.
      ...(filtered
        ? [
            `(ledger_index, tx_index) IN (
              SELECT ledger_index, tx_index FROM ${Table.AccountTransactions}
               WHERE account = {account:String}${q.type !== undefined ? ' AND tx_type = {type:String}' : ''}${
                 q.result !== undefined ? ' AND result = {result:String}' : ''
               })`,
          ]
        : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];
    const found = await readDistinctPage<SequenceKey>(this.ch, {
      columns: 'sequence, ledger_index, tx_index',
      table: Table.AccountTxBySequence,
      where: conditions,
      orderBy: columnsOf(SEQUENCE_ORDER),
      unique: columnsOf(SEQUENCE_KEYS),
      descending: q.descending,
      params: {
        account: q.account,
        ...(q.type !== undefined && { type: q.type }),
        ...(q.result !== undefined && { result: q.result }),
        min_sequence: min,
        max_sequence: max,
        ...cursor.params,
      },
      limit: q.limit + 1,
    });

    const page = paginate(found, q.limit, (key) => [key.sequence, key.ledger_index, key.tx_index]);
    return this.page(page.rows, page.marker, q.binary);
  }

  /**
   * The transaction the account sent with this `Sequence`, `undefined` when there is none.
   *
   * Transactions that use a ticket have `Sequence` 0, so an account can have many under it. The original kept one row
   * per `account|sequence`, the one written last, so this answers with the latest of them: the highest ledger, then the
   * highest position in it.
   */
  async bySequence(account: string, sequence: number, binary: boolean): Promise<TxObject | undefined> {
    // above what a sequence can be: no transaction has it, and the database would refuse the parameter
    if (sequence > MAX_SEQUENCE) return undefined;
    const [key] = await this.ch.query<TimeKey>(
      `SELECT ledger_index, tx_index FROM ${Table.AccountTxBySequence}
        WHERE account = {account:String} AND sequence = {sequence:UInt32}
        ORDER BY account DESC, sequence DESC, ledger_index DESC, tx_index DESC
        LIMIT 1`,
      { account, sequence },
    );
    if (!key) return undefined;
    const [row] = await this.txs.fetchByKeys([key]);
    return row && this.txs.toTxObject(row, { binary });
  }

  /**
   * The transactions of a page of keys, in their order. An item carries no `ledger_hash`: the original never asked for
   * it on these routes.
   */
  private async page(keys: TimeKey[], marker: string | undefined, binary: boolean): Promise<TransactionsPage> {
    const rows = await this.txs.fetchByKeys(keys);
    const transactions = await this.txs.toTxObjects(rows, { binary });
    return { transactions, ...(marker !== undefined && { marker }) };
  }
}
