import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, keysetClause, KeysetKey, orderByClause, paginate } from '../common/pagination';
import { AccountWindow } from './account-window';
import {
  BALANCE_CHANGE_COLUMNS,
  BalanceChangeObject,
  StoredBalanceChange,
  toBalanceChangeObject,
} from './balance-change-object';

/**
 * The key of a list of balance changes, which is the end of the ORDER BY of `balance_changes`, and what a marker holds.
 * The fee of a transaction is at node -1, so it comes before the other changes of the transaction.
 */
export const BALANCE_CHANGE_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
  { column: 'node_index', type: 'Int16' },
];

/**
 * The whole ORDER BY of `balance_changes`. `account` is fixed by the query, but it stays in the ORDER BY: ClickHouse
 * reads a table in the order of its key only when the ORDER BY starts with a prefix of that key, and with only
 * `ledger_index, tx_index, node_index` it can read the whole history of the account and sort it (Task 21).
 */
const BALANCE_CHANGE_ORDER: KeysetKey[] = [{ column: 'account', type: 'String' }, ...BALANCE_CHANGE_KEYS];

/** What `GET /v2/accounts/:address/balance_changes` is asked for; the values are already validated. */
export interface BalanceChangesQuery extends AccountWindow {
  account: string;
  /** Only the changes of this currency (upper case). */
  currency?: string;
  /** Only the changes against this counterparty (the other side of the trust line). */
  counterparty?: string;
  /** Only the changes of this type (`transaction_cost`, `exchange`, ...). */
  changeType?: string;
}

export interface BalanceChangesPage {
  balance_changes: BalanceChangeObject[];
  marker?: string;
}

/**
 * The balance changes of an account (`getAccountBalanceChanges` of the original).
 *
 * `balance_changes` holds the whole change and is ordered by the account first (`account, ledger_index, tx_index,
 * node_index`), so a list is a range of its primary key, read in order with no join; `currency`, `counterparty` and
 * `change_type` are columns of the same table. The dates become a range of ledgers once.
 */
@Injectable()
export class AccountBalanceChangesService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the list, in the order asked for, with the marker of the next page when there is one. */
  async list(q: BalanceChangesQuery): Promise<BalanceChangesPage> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, BALANCE_CHANGE_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { balance_changes: [] };

    // the tuple of the whole key: the account is equal, so only the ledger part decides, and ClickHouse can use it on the
    // primary key
    const cursor = keysetClause(BALANCE_CHANGE_ORDER, q.descending, after && [q.account, ...after]);
    const where = [
      'account = {account:String}',
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(q.currency !== undefined ? ['currency = {currency:String}'] : []),
      ...(q.counterparty !== undefined ? ['counterparty = {counterparty:String}'] : []),
      ...(q.changeType !== undefined ? ['change_type = {change_type:String}'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];

    // `LIMIT 1 BY` the key: a row that was written twice (the table is not collapsed before a merge, and no FINAL is used)
    // counts once; the extra row of the page only tells whether there is a next page
    const rows = await this.ch.query<StoredBalanceChange>(
      `SELECT ${BALANCE_CHANGE_COLUMNS} FROM ${Table.BalanceChanges}
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderByClause(BALANCE_CHANGE_ORDER, q.descending)}
        LIMIT 1 BY ${BALANCE_CHANGE_KEYS.map((k) => k.column).join(', ')}
        LIMIT {fetch:UInt32}`,
      {
        account: q.account,
        min: range.min,
        max: range.max,
        ...(q.currency !== undefined && { currency: q.currency }),
        ...(q.counterparty !== undefined && { counterparty: q.counterparty }),
        ...(q.changeType !== undefined && { change_type: q.changeType }),
        ...cursor.params,
        fetch: q.limit + 1,
      },
    );

    const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index, row.node_index]);
    return {
      balance_changes: page.rows.map(toBalanceChangeObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}
