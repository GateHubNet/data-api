import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { decodeMarker, keysetClause, KeysetKey, orderByClause, paginate } from '../common/pagination';
import { ACCOUNT_COLUMNS, AccountObject, StoredAccount, toAccountObject } from './account-object';

/**
 * The key of the list: the ORDER BY of `accounts_created`, and so the marker. A transaction can create more than one
 * account, so the account completes the key of a row.
 */
export const ACCOUNT_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
  { column: 'account', type: 'String' },
];

/** What `GET /v2/accounts` is asked for; the values are already validated. */
export interface AccountsQuery {
  /** Inclusive: the first ledger that closed at or after it starts the list. */
  start?: Date;
  /** Exclusive; without it the list runs to the newest ledger. */
  endExclusive?: Date;
  /** Only the accounts this address created, compared as it is written (the original did not check it). */
  parent?: string;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

/**
 * The accounts of the API (`getAccounts` of the original): the accounts created, from `accounts_created`.
 *
 * The table is small and not partitioned, ORDER BY `(ledger_index, tx_index, account)`, with a bloom filter on
 * `account`. A list turns its dates into a range of ledgers once and reads that range in the order of the key; a lookup
 * goes through the bloom filter.
 */
@Injectable()
export class AccountsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the list, in the order asked for, with the marker of the next page when there is one. */
  async list(q: AccountsQuery): Promise<{ accounts: AccountObject[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, ACCOUNT_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { accounts: [] };

    const cursor = keysetClause(ACCOUNT_KEYS, q.descending, after);
    const where = [
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(q.parent ? ['parent = {parent:String}'] : []),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];

    // The whole key in the ORDER BY, so that ClickHouse reads the table in the order of its primary key and stops after
    // the page. `LIMIT 1 BY`: a row that was written twice (the table is not collapsed before a merge, and no FINAL is
    // used) counts once.
    const rows = await this.ch.query<StoredAccount>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ${Table.AccountsCreated}
        WHERE ${where.join(' AND ')}
        ORDER BY ${orderByClause(ACCOUNT_KEYS, q.descending)}
        LIMIT 1 BY ledger_index, tx_index, account
        LIMIT {fetch:UInt32}`,
      {
        min: range.min,
        max: range.max,
        ...(q.parent && { parent: q.parent }),
        ...cursor.params,
        // one row more than the page: it only tells whether there is a next page
        fetch: q.limit + 1,
      },
    );

    const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index, row.account]);
    return {
      accounts: page.rows.map(toAccountObject),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /**
   * The account for an address, or `undefined` when no account of that address was ever created. An address that was
   * created, deleted (`AccountDelete`) and funded again has one row per creation, and the latest wins: it is the
   * inception of the account that exists now. The address is a bound value whatever it holds.
   */
  async latest(address: string): Promise<AccountObject | undefined> {
    const [row] = await this.ch.query<StoredAccount>(
      `SELECT ${ACCOUNT_COLUMNS} FROM ${Table.AccountsCreated}
        WHERE account = {account:String}
        ORDER BY ledger_index DESC, tx_index DESC
        LIMIT 1`,
      { account: address },
    );
    return row && toAccountObject(row);
  }
}
