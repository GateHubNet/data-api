import {
  AccountFlag,
  accountFlagsOf,
  ClickHouseService,
  NetworkProfile,
  ParseContext,
  parseContextFor,
  readDistinctPage,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { TxObject, TxService } from '../common/tx-object';
import { NETWORK_PROFILE } from '../config/api.config';
import { AccountStateOfTx, toTransactionSummary, TransactionSummary } from './transaction-summary';

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

/**
 * How a page serves its transactions: as the Ripple API's objects with `tx` and `meta` as JSON or as hex (`binary=true`),
 * or as summary rows from the account's side (`format=csv`).
 */
export type TransactionsForm = 'json' | 'binary' | 'summary';

/** What both lists are asked for; the values are already validated. */
interface ListQuery {
  account: string;
  /** A transaction type of the network (`Payment`). */
  type?: string;
  /** A transaction result code of the network (`tesSUCCESS`). */
  result?: string;
  form: TransactionsForm;
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

/** What the list by time holds, whatever its pages: the account, the window and the filters. */
export type TimeWindow = Pick<TimeQuery, 'account' | 'type' | 'result' | 'start' | 'endExclusive'>;

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

/**
 * A page: the transactions in the order asked for, as objects or as summary rows (the `form` asked for), and the marker
 * of the next page when there is one.
 */
export interface TransactionsPage {
  transactions: TxObject[] | TransactionSummary[];
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
  private readonly ctx: ParseContext;
  private readonly flagNames: readonly AccountFlag[];

  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly txs: TxService,
    @Inject(NETWORK_PROFILE) profile: NetworkProfile,
  ) {
    this.ctx = parseContextFor(profile);
    this.flagNames = accountFlagsOf(profile);
  }

  /** One page of the transactions that affect the account in a time window. */
  async listByTime(q: TimeQuery): Promise<TransactionsPage> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, TIME_KEYS);

    const window = await this.timeWindow(q);
    if (!window) return { transactions: [] };

    const cursor = keysetClause(TIME_KEYS, q.descending, after);
    // in the order of the whole key, each row once (a row written twice is there twice until a merge, and no FINAL is
    // used), with one more than the page: it tells whether there is a next page
    const found = await readDistinctPage<TimeKey>(this.ch, {
      columns: 'ledger_index, tx_index',
      table: Table.AccountTransactions,
      where: [...window.conditions, ...(cursor.clause !== '' ? [cursor.clause] : [])],
      orderBy: columnsOf(TIME_ORDER),
      unique: columnsOf(TIME_KEYS),
      descending: q.descending,
      params: { ...window.params, ...cursor.params },
      limit: q.limit + 1,
    });

    const page = paginate(found, q.limit, (key) => [key.ledger_index, key.tx_index]);
    return this.page(page.rows, page.marker, q);
  }

  /**
   * How many transactions the list by time holds, all its pages together, each once: what an export of it would hold
   * (ticket #16 counts it before it queues the export).
   */
  async countByTime(q: TimeWindow): Promise<number> {
    const window = await this.timeWindow(q);
    if (!window) return 0;
    const row = await this.ch.queryOne<{ n: number | string }>(
      `SELECT count() AS n FROM (
         SELECT DISTINCT ledger_index, tx_index FROM ${Table.AccountTransactions}
          WHERE ${window.conditions.join(' AND ')}
       )`,
      window.params,
    );
    return Number(row?.n ?? 0);
  }

  /** The conditions on `account_transactions` of the list by time, without a page; `undefined` when no ledger is in it. */
  private async timeWindow(
    q: TimeWindow,
  ): Promise<{ conditions: string[]; params: Record<string, string | number> } | undefined> {
    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return undefined;
    return {
      conditions: [
        'account = {account:String}',
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...(q.type !== undefined ? ['tx_type = {type:String}'] : []),
        ...(q.result !== undefined ? ['result = {result:String}'] : []),
      ],
      params: {
        account: q.account,
        ...(q.type !== undefined && { type: q.type }),
        ...(q.result !== undefined && { result: q.result }),
        min: range.min,
        max: range.max,
      },
    };
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
    return this.page(page.rows, page.marker, q);
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
   * The transactions of a page of keys, in their order, in the form asked for. An object carries no `ledger_hash`: the
   * original never asked for it on these routes. A summary row is read from the stored transaction, without the codec,
   * and from the account's states that the page's transactions wrote (`statesOf`).
   */
  private async page(keys: TimeKey[], marker: string | undefined, q: ListQuery): Promise<TransactionsPage> {
    if (q.form === 'summary') {
      const [rows, states] = await Promise.all([this.txs.fetchByKeys(keys), this.statesOf(q.account, keys)]);
      const transactions = rows.map((row) =>
        toTransactionSummary(row, q.account, {
          ctx: this.ctx,
          flagNames: this.flagNames,
          state: states.get(`${row.ledger_index}:${row.tx_index}`),
        }),
      );
      return { transactions, ...(marker !== undefined && { marker }) };
    }
    const rows = await this.txs.fetchByKeys(keys);
    const transactions = await this.txs.toTxObjects(rows, { binary: q.form === 'binary' });
    return { transactions, ...(marker !== undefined && { marker }) };
  }

  /**
   * The state of the account that each transaction of the page wrote in the account state history, by
   * `ledger_index:tx_index`. A transaction that changed nothing of the account root, or that a parser older than
   * `STATE_PARSER_VERSION` wrote, has none. The account prefix and the page's range of ledgers bound the read to the
   * page; a row written twice is the same row.
   */
  private async statesOf(account: string, keys: TimeKey[]): Promise<Map<string, AccountStateOfTx>> {
    if (keys.length === 0) return new Map();
    const ledgers = keys.map((k) => k.ledger_index);
    const rows = await this.ch.query<AccountStateOfTx & TimeKey>(
      `SELECT ledger_index, tx_index, node_index, flags
         FROM ${Table.AccountStates}
        WHERE account = {account:String}
          AND ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
          AND (ledger_index, tx_index) IN (
              SELECT tupleElement(key, 1), tupleElement(key, 2)
                FROM (SELECT arrayJoin(arrayZip({ledgers:Array(UInt32)}, {indexes:Array(UInt32)})) AS key))`,
      {
        account,
        min: Math.min(...ledgers),
        max: Math.max(...ledgers),
        ledgers,
        indexes: keys.map((k) => k.tx_index),
      },
    );
    return new Map(
      rows.map((row) => [`${row.ledger_index}:${row.tx_index}`, { node_index: row.node_index, flags: row.flags }]),
    );
  }
}
