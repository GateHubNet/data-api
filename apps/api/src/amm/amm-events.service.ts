import { ClickHouseService, readDistinctPage, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, paginate } from '../common/pagination';
import { EXCHANGE_KEYS, ExchangesPage, ExchangesService, ExchangesWindow } from '../exchanges/exchanges.service';
import {
  GOVERNANCE_COLUMNS,
  GovernanceObject,
  LIQUIDITY_COLUMNS,
  LiquidityObject,
  StoredGovernance,
  StoredLiquidity,
  toGovernanceObject,
  toLiquidityObject,
} from './amm-objects';
import { GovernanceType } from './amm-params';
import { AmmPoolsService } from './amm-pools.service';

/** The key of the liquidity events and of the governance rows of a pool: the end of their ORDER BY, and what a marker holds. */
export const POOL_EVENT_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

/** The whole ORDER BY of `amm_liquidity` and `amm_governance`: the pool is fixed by the read, but the read has to ask for the whole key. */
const POOL_EVENT_ORDER = ['amm_account', ...columnsOf(POOL_EVENT_KEYS)];

/** The window of a list of the events of a pool: the pool, the dates, the page asked for. The values are already validated. */
interface PoolEventsQuery {
  pool: string;
  /** Inclusive; without it from the first ledger. */
  start?: Date;
  /** Exclusive; without it to the newest ledger. */
  endExclusive?: Date;
  descending: boolean;
  limit: number;
  /** As the client got it from the last page; `decodeMarker` checks it. */
  marker?: string;
}

export interface LiquidityQuery extends PoolEventsQuery {
  /** One of `AMM_LIQUIDITY_EVENTS`. */
  event?: string;
  /** The liquidity provider. */
  account?: string;
}

export interface GovernanceQuery extends PoolEventsQuery {
  type?: GovernanceType;
}

/** The swaps of a pool: the window of the exchange routes (`amm` is `only` whatever it holds) and the pool. */
export type SwapsQuery = ExchangesWindow & { pool: string };

export interface LiquidityPage {
  events: LiquidityObject[];
  marker?: string;
}

export interface GovernancePage {
  items: GovernanceObject[];
  marker?: string;
}

/**
 * The event lists of one pool: its swaps, its liquidity events and its votes and bids.
 *
 * Every list is 404 `pool not found` for an address with no state row in a committed ledger (`AmmPoolsService.requirePool`:
 * the pool is found as soon as its ledger is committed, whether or not the aggregator has built `amm_pools` yet) and reads
 * ledgers up to the newest `ledgers` row only (the dates become a range of ledgers once, `LedgerRangeResolver`).
 *
 *  - **Liquidity and governance** are a range of the primary key of their table (the pool, then its ledgers), read in the
 *    order of the key a page at a time by `readDistinctPage`. A filter (`event`, `account`, `type`) is a condition of the
 *    inner read that is capped: a filter after the page would leave a page short or empty while there is a next one.
 *  - **The swaps** are the exchange rows of the pool: `ExchangesService.pair` on the pool's pair, in the order it is stored
 *    (the pair the pool's state rows name), with `amm=only` and the pool's account, so the same read, mapper, pages and
 *    markers as `GET /v2/exchanges/:base/:counter?amm=only`, restricted to one pool: the pair key and the skip index on
 *    `amm_account`, never a scan across pairs.
 */
@Injectable()
export class AmmEventsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
    private readonly pools: AmmPoolsService,
    private readonly exchanges: ExchangesService,
  ) {}

  /** One page of the swaps of a pool, in the order asked for. */
  async swaps(q: SwapsQuery): Promise<ExchangesPage> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the pool is
    decodeMarker(q.marker, EXCHANGE_KEYS);
    const { base, counter } = await this.pools.requirePool(q.pool);
    const { pool, ...window } = q;
    return this.exchanges.pair({ ...window, base, counter, amm: 'only', ammAccount: pool });
  }

  /** One page of the liquidity events of a pool. */
  async liquidity(q: LiquidityQuery): Promise<LiquidityPage> {
    const rows = await this.page<StoredLiquidity>(
      Table.AmmLiquidity,
      LIQUIDITY_COLUMNS,
      q,
      [
        ...(q.event !== undefined ? ['event = {event:String}'] : []),
        ...(q.account !== undefined ? ['account = {account:String}'] : []),
      ],
      {
        ...(q.event !== undefined && { event: q.event }),
        ...(q.account !== undefined && { account: q.account }),
      },
    );
    return { events: rows.rows.map(toLiquidityObject), ...(rows.marker !== undefined && { marker: rows.marker }) };
  }

  /** One page of the votes and bids of a pool. */
  async governance(q: GovernanceQuery): Promise<GovernancePage> {
    const rows = await this.page<StoredGovernance>(
      Table.AmmGovernance,
      GOVERNANCE_COLUMNS,
      q,
      q.type !== undefined ? ['kind = {kind:String}'] : [],
      q.type !== undefined ? { kind: q.type } : {},
    );
    return { items: rows.rows.map(toGovernanceObject), ...(rows.marker !== undefined && { marker: rows.marker }) };
  }

  /**
   * One page of a table keyed by `(amm_account, ledger_index, tx_index)`, for the pool of the query, with `conditions` (the
   * filters, bound by `params`) inside the capped read. A row stored twice is kept once.
   */
  private async page<T extends { ledger_index: number | string; tx_index: number | string }>(
    table: Table.AmmLiquidity | Table.AmmGovernance,
    columns: string,
    q: PoolEventsQuery,
    conditions: string[],
    params: Record<string, unknown>,
  ): Promise<{ rows: T[]; marker?: string }> {
    // before any query: a marker that is none of ours is the client's mistake, whatever the pool is
    const after = decodeMarker(q.marker, POOL_EVENT_KEYS);
    await this.pools.requirePool(q.pool);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    if (!range) return { rows: [] };

    // the columns after the pool, which the query fixes: `keysetClause` bounds the first of them on its own, which
    // ClickHouse narrows the read with
    const cursor = keysetClause(POOL_EVENT_KEYS, q.descending, after);
    const rows = await readDistinctPage<T>(this.ch, {
      columns,
      table,
      where: [
        'amm_account = {pool:String}',
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...conditions,
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: POOL_EVENT_ORDER,
      unique: columnsOf(POOL_EVENT_KEYS),
      descending: q.descending,
      params: { pool: q.pool, min: range.min, max: range.max, ...params, ...cursor.params },
      limit: q.limit + 1,
    });
    return paginate(rows, q.limit, (row) => [Number(row.ledger_index), Number(row.tx_index)]);
  }
}
