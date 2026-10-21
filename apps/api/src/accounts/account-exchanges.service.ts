import { ClickHouseService, readDistinctPage, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { AssetParts } from '../common/asset-param';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { ammConditions, AmmFilter } from '../common/params';
import {
  ACCOUNT_EXCHANGE_COLUMNS,
  AccountExchangeObject,
  StoredAccountExchange,
  toAccountExchangeObject,
} from './account-exchange-object';
import { AccountWindow } from './account-window';

/** The key of a list of exchanges, which is the end of the ORDER BY of `account_exchanges`, and what a marker holds. */
export const ACCOUNT_EXCHANGE_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
  { column: 'node_index', type: 'UInt16' },
];

/**
 * The whole ORDER BY of `account_exchanges`. `account` is fixed by the query, but it stays in the ORDER BY: ClickHouse
 * reads a table in the order of its key only when the ORDER BY starts with a prefix of that key, and with only
 * `ledger_index, tx_index, node_index` it can read the whole history of the account and sort it (Task 21).
 */
const ACCOUNT_EXCHANGE_ORDER: KeysetKey[] = [{ column: 'account', type: 'String' }, ...ACCOUNT_EXCHANGE_KEYS];

/** What `GET /v2/accounts/:address/exchanges[/:base[/:counter]]` is asked for; the values are already validated. */
export interface AccountExchangesQuery extends AccountWindow {
  account: string;
  /** The asset the exchanges are of, as the base (a missing part matches anything). Without it, any asset. */
  base?: AssetParts;
  /** The asset on the other side, as the counter. */
  counter?: AssetParts;
  /** Whether the swaps against AMM pools are listed with the order-book exchanges, instead of them, or alone. */
  amm: AmmFilter;
}

export interface AccountExchangesPage {
  exchanges: AccountExchangeObject[];
  marker?: string;
}

/** Whether an asset of a stored row is what the filter asks for: a part the filter does not name matches anything. */
function matches(currency: string, issuer: string, filter?: AssetParts): boolean {
  return (
    filter === undefined ||
    ((filter.currency === undefined || filter.currency === currency) &&
      (filter.issuer === undefined || filter.issuer === issuer))
  );
}

/**
 * The conditions that one side of a stored pair is the asset of the filter, with the filter's values bound as
 * `{<name>_currency}` and `{<name>_issuer}`. A part the filter does not name has no condition.
 */
function sideConditions(side: 'base' | 'counter', name: string, filter?: AssetParts): string[] {
  return [
    ...(filter?.currency !== undefined ? [`${side}_currency = {${name}_currency:String}`] : []),
    ...(filter?.issuer !== undefined ? [`${side}_issuer = {${name}_issuer:String}`] : []),
  ];
}

/**
 * The exchanges of an account (`getAccountExchanges` of the original).
 *
 * `account_exchanges` holds the whole exchange for each account that took part in it, ordered by the account first
 * (`account, ledger_index, tx_index, node_index`), so a list is a range of its primary key and is read in order, with no
 * join. The dates become a range of ledgers once.
 *
 * The pair is stored in Ripple's canonical order, and the original compared the base and the counter of the path with
 * the stored ones as they were, so the reverse of a stored pair found nothing. Here the asset asked for as the base
 * may be on either side of the stored pair, and so may the counter: a row is listed when the stored pair is the pair
 * as asked for, or when it is its reverse, and then it is inverted as `GET /v2/exchanges/:base/:counter` inverts it
 * (base and counter, buyer and seller swap, the rate is 1/rate), so the asset asked for as the base is always the base
 * of what is served. A row that fits both ways (the same currency from two issuers, with the issuers not named) is
 * served as stored.
 */
@Injectable()
export class AccountExchangesService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the list, in the order asked for, with the marker of the next page when there is one. */
  async list(q: AccountExchangesQuery): Promise<AccountExchangesPage> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, ACCOUNT_EXCHANGE_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { exchanges: [] };

    // the columns after the account, which the query fixes: `keysetClause` bounds the first of them on its own, which
    // ClickHouse narrows the read with
    const cursor = keysetClause(ACCOUNT_EXCHANGE_KEYS, q.descending, after);
    const asStored = [...sideConditions('base', 'base', q.base), ...sideConditions('counter', 'counter', q.counter)];
    const reversed = [...sideConditions('counter', 'base', q.base), ...sideConditions('base', 'counter', q.counter)];
    const where = [
      'account = {account:String}',
      'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
      ...(asStored.length > 0 ? [`((${asStored.join(' AND ')}) OR (${reversed.join(' AND ')}))`] : []),
      // inside the read that is capped: a filter after the page would leave it short or empty
      ...ammConditions(q.amm),
      ...(cursor.clause !== '' ? [cursor.clause] : []),
    ];

    // in the order of the whole key, each row once (a row written twice is there twice until a merge, and no FINAL is
    // used), with one more than the page: it only tells whether there is a next page
    const rows = await readDistinctPage<StoredAccountExchange>(this.ch, {
      columns: ACCOUNT_EXCHANGE_COLUMNS,
      table: Table.AccountExchanges,
      where,
      orderBy: columnsOf(ACCOUNT_EXCHANGE_ORDER),
      unique: columnsOf(ACCOUNT_EXCHANGE_KEYS),
      descending: q.descending,
      params: {
        account: q.account,
        min: range.min,
        max: range.max,
        ...(q.base?.currency !== undefined && { base_currency: q.base.currency }),
        ...(q.base?.issuer !== undefined && { base_issuer: q.base.issuer }),
        ...(q.counter?.currency !== undefined && { counter_currency: q.counter.currency }),
        ...(q.counter?.issuer !== undefined && { counter_issuer: q.counter.issuer }),
        ...cursor.params,
      },
      limit: q.limit + 1,
    });

    const page = paginate(rows, q.limit, (row) => [row.ledger_index, row.tx_index, row.node_index]);
    // a row is inverted when it is not the pair as asked for, so it is the reverse of it
    const filtered = asStored.length > 0;
    return {
      exchanges: page.rows.map((row) =>
        toAccountExchangeObject(
          row,
          filtered &&
            !(
              matches(row.base_currency, row.base_issuer, q.base) &&
              matches(row.counter_currency, row.counter_issuer, q.counter)
            ),
        ),
      ),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}
