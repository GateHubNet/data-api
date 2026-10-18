import {
  AMM_POOLS_CHUNK,
  ClickHouseService,
  fillForward,
  FillForwardQuery,
  readDistinctPage,
  Table,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import BigNumber from 'bignumber.js';
import {
  LIQUIDITY_COLUMNS,
  LiquidityObject,
  PositionObject,
  StoredLiquidity,
  toLiquidityObject,
  toPositionObject,
} from '../amm/amm-objects';
import { AMM_HISTORY_CARRY_LEDGERS } from '../amm/amm-pools.service';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';

/** The key of the liquidity events of an account: the end of the ORDER BY of `account_amm_liquidity`, and what a marker holds. */
export const ACCOUNT_LIQUIDITY_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
  { column: 'amm_account', type: 'String' },
];

/** The whole ORDER BY of `account_amm_liquidity`: the account is fixed by the read, but the read has to ask for the whole key. */
const ACCOUNT_LIQUIDITY_ORDER = ['account', ...columnsOf(ACCOUNT_LIQUIDITY_KEYS)];

/** What `GET /v2/accounts/:address/amm_liquidity` is asked for; the values are already validated. */
export interface AccountLiquidityQuery {
  account: string;
  /** Only the events of this pool. */
  pool?: string;
  /** One of `AMM_LIQUIDITY_EVENTS`. */
  event?: string;
  /** Inclusive; without it from the first ledger. */
  start?: Date;
  /** Exclusive; without it to the newest ledger. */
  endExclusive?: Date;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

export interface AccountLiquidityPage {
  events: LiquidityObject[];
  marker?: string;
}

/**
 * The currencies of an LP token: 40 hex digits starting with `03` (what rippled makes of the two assets of a pool). The
 * pattern is bound as a parameter. It is a filter on the read, not the proof that a line is a position: that is the pool
 * naming this very currency as its LP currency.
 */
const LP_CURRENCY = '^03[0-9A-Fa-f]{38}$';

/** The columns of the state of a pool a position needs; each is the newest non-null value over the state rows up to a ledger. */
const POSITION_QUERY: FillForwardQuery = {
  fields: ['reserve_base', 'reserve_counter', 'lp_supply', 'lp_currency'],
  required: ['filled_reserve_base', 'filled_reserve_counter', 'filled_lp_supply', 'filled_lp_currency'],
};

/** A fill-forward row of `POSITION_QUERY`. */
interface PositionState {
  amm_account: string;
  newest_deleted: number | string;
  filled_reserve_base: string | null;
  filled_reserve_counter: string | null;
  filled_lp_supply: string | null;
  filled_lp_currency: string | null;
}

/** The last balance of an LP-token line of the account. */
interface LpBalance {
  currency: string;
  counterparty: string;
  balance: string;
}

/**
 * The account side of the AMM data: the liquidity events of an account, and its LP-token positions.
 *
 *  - **The events** are a range of the primary key of `account_amm_liquidity` (the account, then its ledgers), the narrow
 *    index of the table ordered by pool, read a page at a time by `readDistinctPage` up to the committed head. The `pool`
 *    and `event` filters are conditions of the inner read that is capped. The pool need not exist: it is a filter.
 *  - **The positions** (spec section 3, "amm_positions details"). `date` becomes a ledger L, the last committed ledger that
 *    closed at or before it (the newest one without a date). The LP-token lines of the account come from
 *    `balance_changes`, which records an LP token as the trust line it is: the latest balance of every `(currency,
 *    counterparty)` of the account up to L, a range of the primary key `(account, ledger_index, ...)` filtered to the
 *    currencies of LP tokens (a code of 40 hex digits starting with `03`). A line is a position when its counterparty is a
 *    pool whose LP currency, as of L, is the line's currency, the balance is not 0, and the pool, as of L, was not deleted
 *    and has a supply of LP tokens. The state of the pools (LP currency, supply, reserves) is the shared fill-forward of the
 *    state rows up to L, exact and bounded (a window of ledgers, then further back in doubling steps), for the counterparties
 *    in batches of `AMM_POOLS_CHUNK`. `share` is the balance over the supply and the amounts the share of each reserve,
 *    in decimals (`toPositionObject`).
 */
@Injectable()
export class AccountAmmService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  /** One page of the liquidity events of an account, in the order asked for. */
  async liquidity(q: AccountLiquidityQuery): Promise<AccountLiquidityPage> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the range holds
    const after = decodeMarker(q.marker, ACCOUNT_LIQUIDITY_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { events: [] };

    // the columns after the account, which the query fixes: `keysetClause` bounds the first of them on its own, which
    // ClickHouse narrows the read with
    const cursor = keysetClause(ACCOUNT_LIQUIDITY_KEYS, q.descending, after);
    const rows = await readDistinctPage<StoredLiquidity>(this.ch, {
      columns: LIQUIDITY_COLUMNS,
      table: Table.AccountAmmLiquidity,
      where: [
        'account = {account:String}',
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        // inside the read that is capped: a filter after the page would leave it short or empty
        ...(q.pool !== undefined ? ['amm_account = {pool:String}'] : []),
        ...(q.event !== undefined ? ['event = {event:String}'] : []),
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: ACCOUNT_LIQUIDITY_ORDER,
      unique: columnsOf(ACCOUNT_LIQUIDITY_KEYS),
      descending: q.descending,
      params: {
        account: q.account,
        min: range.min,
        max: range.max,
        ...(q.pool !== undefined && { pool: q.pool }),
        ...(q.event !== undefined && { event: q.event }),
        ...cursor.params,
      },
      limit: q.limit + 1,
    });
    const page = paginate(rows, q.limit, (row) => [Number(row.ledger_index), Number(row.tx_index), row.amm_account]);
    return { events: page.rows.map(toLiquidityObject), ...(page.marker !== undefined && { marker: page.marker }) };
  }

  /**
   * The LP-token positions of an account at `date` (now without one), sorted by pool. Empty when no ledger had closed by
   * then. Nothing is read of the pools for an account with no LP-token line.
   */
  async positions(account: string, date?: Date): Promise<PositionObject[]> {
    const ledger = date === undefined ? await this.ranges.latest() : await this.ranges.ledgerAtOrBefore(date);
    if (ledger === undefined) return [];

    // a line at 0 holds nothing: the pools it names are not even looked at
    const balances = (await this.lpBalances(account, ledger)).filter((line) => !new BigNumber(line.balance).isZero());
    if (balances.length === 0) return [];
    const pools = await this.poolsAt([...new Set(balances.map((line) => line.counterparty))].sort(), ledger);

    return balances
      .flatMap((line) => {
        const pool = pools.get(line.counterparty);
        // a pool names its LP currency; a line of another code, or against an account that is no pool, is nothing
        if (pool === undefined || pool.filled_lp_currency !== line.currency) return [];
        const position = toPositionObject({
          pool: line.counterparty,
          lp_currency: line.currency,
          lp_balance: line.balance,
          lp_supply: pool.filled_lp_supply,
          reserve_base: pool.filled_reserve_base,
          reserve_counter: pool.filled_reserve_counter,
          deleted: Number(pool.newest_deleted) === 1,
        });
        return position === undefined ? [] : [position];
      })
      .sort((a, b) => compareText(a.pool, b.pool) || compareText(a.lp_currency, b.lp_currency));
  }

  /**
   * The latest balance of every LP-token line of the account up to `ledger`: a range of the primary key of `balance_changes`
   * (the account, then the ledgers up to `ledger`), the currencies of LP tokens only, grouped in the read so that a handful
   * of rows come out of it. The latest is by the whole key of the change, `(ledger_index, tx_index, node_index)`; a row
   * written twice has the same key and the same balance, so no `LIMIT 1 BY` is needed (it would hold a key per change).
   */
  private lpBalances(account: string, ledger: number): Promise<LpBalance[]> {
    return this.ch.query<LpBalance>(
      `SELECT currency, counterparty, argMax(final_balance, (ledger_index, tx_index, node_index)) AS balance
         FROM ${Table.BalanceChanges}
        WHERE account = {account:String} AND ledger_index <= {ledger:UInt32} AND match(currency, {lp_currency:String})
        GROUP BY currency, counterparty`,
      { account, ledger, lp_currency: LP_CURRENCY },
    );
  }

  /**
   * The state, as of `ledger`, of each of the pools that has a state row up to it: the shared fill-forward (`fillForward`: a
   * window of ledgers before `ledger`, then further back in doubling steps for the pools whose window leaves a value null and
   * that have older rows), in batches of `AMM_POOLS_CHUNK`. An account that is no pool has no row.
   */
  private async poolsAt(accounts: string[], ledger: number): Promise<Map<string, PositionState>> {
    const from = Math.max(0, ledger - AMM_HISTORY_CARRY_LEDGERS + 1);
    const pools = new Map<string, PositionState>();
    for (let i = 0; i < accounts.length; i += AMM_POOLS_CHUNK) {
      const rows = await fillForward<PositionState>(
        this.ch,
        accounts.slice(i, i + AMM_POOLS_CHUNK),
        ledger,
        from,
        POSITION_QUERY,
        { onlyPoolsWithOlderRows: true },
      );
      for (const row of rows) pools.set(row.amm_account, row);
    }
    return pools;
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
