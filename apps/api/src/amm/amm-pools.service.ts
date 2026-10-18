import {
  Asset,
  canonicalPair,
  ClickHouseService,
  FilledColumn,
  fillForward,
  POOL_FIELDS,
  POOL_QUERY,
  readDistinctPage,
  Table,
} from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { assetOfColumns } from '../common/asset-param';
import { notFound } from '../common/errors';
import { LedgerRangeResolver } from '../common/ledger-range.service';
import { columnsOf, decodeMarker, keysetClause, KeysetKey, KeyValue, paginate } from '../common/pagination';
import {
  POOL_COLUMNS,
  POOL_DAY_COLUMNS,
  POOL_STATE_COLUMNS,
  PoolDayObject,
  PoolObject,
  PoolStateObject,
  StoredPool,
  StoredPoolDay,
  StoredPoolState,
  toPoolDayObject,
  toPoolObject,
  toPoolStateObject,
} from './amm-objects';
import {
  carryForward,
  decodePoolsMarker,
  EMPTY_FILL,
  encodePoolsMarker,
  FilledValues,
  poolsKeyset,
} from './amm-paging';

/** The key of the history of a pool: the end of the ORDER BY of `amm_pool_states`, and what a marker holds. */
export const STATE_KEYS: KeysetKey[] = [
  { column: 'ledger_index', type: 'UInt32' },
  { column: 'tx_index', type: 'UInt32' },
];

/** The whole ORDER BY of `amm_pool_states`: the pool is fixed by the read, but the read has to ask for the whole key. */
const STATE_ORDER = ['amm_account', ...columnsOf(STATE_KEYS)];

/** The key of the days of a pool, what a marker holds: the start of the day, in unix seconds. */
export const DAY_KEYS: KeysetKey[] = [{ column: 'day', type: 'UInt32' }];

/** The whole ORDER BY of `amm_daily`. */
const DAY_ORDER = ['amm_account', 'day'];

/**
 * How many ledgers before a page the carry-in of its history looks first (about two hours): a range of the primary key of
 * the pool. A pool that has a value for every column in it costs this window; a column whose newest value is older is looked
 * for further back in steps that double (`fillForward`, Rulings R-A21 and R-A23), so the cost is about the distance back to it.
 * The window of the aggregators (`AMM_FILL_WINDOW_LEDGERS`, a week) is far too much for a page of a list: the first read
 * of the window has no LIMIT, it reads every row of the pool in it.
 */
export const AMM_HISTORY_CARRY_LEDGERS = 2048;

const DAY_SECONDS = 86_400;
/** The last day a ClickHouse `Date` holds (2149-06-06), in unix seconds. */
const MAX_DAY = 65_535 * DAY_SECONDS;

/** `YYYY-MM-DD` of a time in unix seconds. */
const dayText = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** The Asset of a filter as a pair of columns. */
const columnsOfAsset = (asset: Asset): { currency: string; issuer: string } => ({
  currency: asset.currency,
  issuer: asset.issuer ?? '',
});

/** What the list of pools is asked for; the values are already validated. */
export interface PoolsQuery {
  /** Pools that have these assets (each on either side). */
  assets: Asset[];
  includeDeleted: boolean;
  limit: number;
  /** As the client got it from the last page; `decodePoolsMarker` checks it. */
  marker?: string;
}

export interface PoolsPage {
  pools: PoolObject[];
  marker?: string;
}

/** The history of a pool: its states (or, with `interval: 'day'`, its days) in a window, and the page asked for. */
export interface HistoryQuery {
  pool: string;
  /** Inclusive; without it from the first ledger (the first day). */
  start?: Date;
  /** Exclusive; without it to the newest ledger (the last day). */
  endExclusive?: Date;
  descending: boolean;
  limit: number;
  marker?: string;
}

export interface StatesPage {
  states: PoolStateObject[];
  marker?: string;
}

export interface DaysPage {
  days: PoolDayObject[];
  marker?: string;
}

/** The output columns of the fill-forward of a pool's state rows. */
type FilledRow = Record<`filled_${FilledColumn}`, string | number | null>;

/**
 * The AMM pool routes: the list of pools, a pool by its account or its pair, and its history.
 *
 * `amm_pools` is rebuilt by the aggregator with a new version at each recompute (ReplacingMergeTree(version), no FINAL), so
 * every read here keeps the newest version of each pool: `ORDER BY amm_account, version DESC LIMIT 1 BY amm_account`. What
 * a pool can lose between versions (`deleted`, the value) is filtered AFTER that, on the newest version; the assets never
 * change for a pool account, so a filter on them may come before it.
 *
 *  - **The list** sorts the (small) set of newest versions in SQL, by `value_native` descending with the pools without a value
 *    last, then by account, with a keyset marker on both (Ruling R-A4). It reads `amm_pools` only, all of it, once a page.
 *  - **A pool** is a primary-key read of `amm_pools`. The pair form reads the set of newest versions and picks the live pool
 *    of the pair or, when it has none, the one deleted last (the highest `last_ledger`).
 *  - **The history** reads `amm_pool_states` (pool, then ledgers: a range of its primary key) up to the committed head, a page
 *    at a time by `readDistinctPage`, and carries the values forward: a state row holds a value only when the transaction's
 *    metadata carried it, so a null takes the newest earlier non-null value, from the rows of the page and from the state
 *    before it (`carryIn`). With `interval=day` it reads the pool's rows of `amm_daily` of the version of the sentinel of
 *    their day.
 */
@Injectable()
export class AmmPoolsService {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeResolver,
  ) {}

  // -- the pools ---------------------------------------------------------------------------------------------------

  /** One page of the pools. */
  async list(q: PoolsQuery): Promise<PoolsPage> {
    // before any query: a marker that is none of ours is the client's mistake
    const after = decodePoolsMarker(q.marker);

    const params: Record<string, unknown> = {};
    // the assets of a pool never change: the filter is on the rows of every version, before the newest is picked
    const assetConditions = q.assets.map((asset, i) => {
      const { currency, issuer } = columnsOfAsset(asset);
      params[`asset${i}_currency`] = currency;
      params[`asset${i}_issuer`] = issuer;
      return `((base_currency = {asset${i}_currency:String} AND base_issuer = {asset${i}_issuer:String})
            OR (counter_currency = {asset${i}_currency:String} AND counter_issuer = {asset${i}_issuer:String}))`;
    });
    const keyset = poolsKeyset(after);
    // on the newest version: whether the pool is deleted now, and where it is in the order
    const newest = [...(q.includeDeleted ? [] : ['deleted = 0']), ...(keyset.clause !== '' ? [keyset.clause] : [])];

    const rows = await this.ch.query<StoredPool>(
      `SELECT ${POOL_COLUMNS}
         FROM (SELECT ${POOL_COLUMNS}
                 FROM ${Table.AmmPools}${assetConditions.length > 0 ? `\n                WHERE ${assetConditions.join(' AND ')}` : ''}
                ORDER BY amm_account ASC, version DESC
                LIMIT 1 BY amm_account)${newest.length > 0 ? `\n        WHERE ${newest.join(' AND ')}` : ''}
        ORDER BY value_native DESC NULLS LAST, amm_account ASC
        LIMIT {limit:UInt32}`,
      { ...params, ...keyset.params, limit: q.limit + 1 },
    );
    // one more than the page: it only tells whether there is a next page
    const page = rows.length > q.limit ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      pools: page.map(toPoolObject),
      ...(rows.length > q.limit && { marker: encodePoolsMarker(last.value_native ?? null, last.amm_account) }),
    };
  }

  /** The pool of an account, in its newest version; `undefined` when there is none. */
  async detail(account: string): Promise<PoolObject | undefined> {
    const [row] = await this.ch.query<StoredPool>(
      `SELECT ${POOL_COLUMNS}
         FROM ${Table.AmmPools}
        WHERE amm_account = {account:String}
        ORDER BY version DESC
        LIMIT 1`,
      { account },
    );
    return row === undefined ? undefined : toPoolObject(row);
  }

  /**
   * The pool of a pair, in either order: the live pool or, when there is none, the one deleted last (a pair can have had
   * several pools, each deleted before the next was created); `undefined` when the pair never had one.
   */
  async byPair(base: Asset, counter: Asset): Promise<PoolObject | undefined> {
    const stored = canonicalPair(base, counter);
    const first = columnsOfAsset(stored.base);
    const second = columnsOfAsset(stored.counter);
    const [row] = await this.ch.query<StoredPool>(
      `SELECT ${POOL_COLUMNS}
         FROM (SELECT ${POOL_COLUMNS}
                 FROM ${Table.AmmPools}
                WHERE base_currency = {base_currency:String} AND base_issuer = {base_issuer:String}
                  AND counter_currency = {counter_currency:String} AND counter_issuer = {counter_issuer:String}
                ORDER BY amm_account ASC, version DESC
                LIMIT 1 BY amm_account)
        ORDER BY deleted ASC, last_ledger DESC, amm_account ASC
        LIMIT 1`,
      {
        base_currency: first.currency,
        base_issuer: first.issuer,
        counter_currency: second.currency,
        counter_issuer: second.issuer,
      },
    );
    return row === undefined ? undefined : toPoolObject(row);
  }

  // -- the history -------------------------------------------------------------------------------------------------

  /**
   * One page of the states of a pool in the ledgers of the window, each with its values carried forward. 404 `pool not
   * found` when the pool has no state in a committed ledger.
   */
  async states(q: HistoryQuery): Promise<StatesPage> {
    // before any query: a marker that is none of ours is the client's mistake
    const after = decodeMarker(q.marker, STATE_KEYS);

    const range = await this.ranges.resolve(q.start, q.endExclusive);
    const stored = range ? await this.statePage(q, range, after) : [];
    if (stored.length === 0) {
      await this.requirePool(q.pool);
      return { states: [] };
    }

    // the values are carried in the order of time, whichever way the page runs
    const inTime = q.descending ? [...stored].reverse() : stored;
    const oldest = inTime[0];
    const carry = await this.carryIn(q.pool, Number(oldest.ledger_index), Number(oldest.tx_index));
    const filled = carryForward(inTime, carry);
    const rows = q.descending ? filled.reverse() : filled;

    const page = paginate(rows, q.limit, (row) => [Number(row.ledger_index), Number(row.tx_index)]);
    return {
      states: page.rows.map((row) => toPoolStateObject(q.pool, row)),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }

  /**
   * The states of the page, one more than the page, in the order asked for. A plain read of the pool's rows of the window
   * (`min` to `max`, the committed ledgers of the dates: `max` is never above the newest `ledgers` row), a range of the primary
   * key, capped; a row stored twice is kept once.
   */
  private statePage(
    q: HistoryQuery,
    range: { min: number; max: number },
    after: KeyValue[] | undefined,
  ): Promise<StoredPoolState[]> {
    const cursor = keysetClause(STATE_KEYS, q.descending, after);
    return readDistinctPage<StoredPoolState>(this.ch, {
      columns: POOL_STATE_COLUMNS,
      table: Table.AmmPoolStates,
      where: [
        'amm_account = {pool:String}',
        'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}',
        ...(cursor.clause !== '' ? [cursor.clause] : []),
      ],
      orderBy: STATE_ORDER,
      unique: columnsOf(STATE_KEYS),
      descending: q.descending,
      params: { pool: q.pool, min: range.min, max: range.max, ...cursor.params },
      limit: q.limit + 1,
    });
  }

  /**
   * The state of the pool just before the row at `(ledger, tx)`: the newest non-null value of every column over all the rows
   * before it, from before `start` and before the page too. The rows of the ledgers before `ledger` are the fill-forward of
   * `fillForward` (a window of `AMM_HISTORY_CARRY_LEDGERS`, then further back in doubling steps as far as a column needs:
   * exact and bounded), those of `ledger` itself before `tx` are read apart and put on top of it.
   *
   * The window is read first, and the steps back only when it leaves a column null and the pool has older rows at all (the
   * walk ends at the pool's first state ledger, Ruling R-A25): a pool that has all its values in the window costs one read, and
   * the first page of a pool, which has nothing before it, costs the window and one look for its first ledger, and does not
   * walk back to the first ledger of the chain one step after the other.
   */
  private async carryIn(pool: string, ledger: number, tx: number): Promise<FilledValues> {
    let state: FilledValues = EMPTY_FILL;
    if (ledger > 0) {
      const upTo = ledger - 1;
      const [row] = await fillForward<FilledRow>(
        this.ch,
        [pool],
        upTo,
        Math.max(0, upTo - AMM_HISTORY_CARRY_LEDGERS + 1),
        POOL_QUERY,
      );
      if (row !== undefined) state = fromFill(row);
    }
    if (tx > 0) {
      const earlier = await this.ch.query<FilledValues>(
        `SELECT ${POOL_FIELDS.join(', ')}
           FROM ${Table.AmmPoolStates}
          WHERE amm_account = {pool:String} AND ledger_index = {ledger:UInt32} AND tx_index < {tx:UInt32}
          ORDER BY amm_account ASC, ledger_index ASC, tx_index ASC
          LIMIT 1 BY tx_index`,
        { pool, ledger, tx },
      );
      const filled = carryForward(earlier, state);
      if (filled.length > 0) state = valuesOf(filled[filled.length - 1]);
    }
    return state;
  }

  /**
   * The existence rule of every route of one pool (history, swaps, liquidity, governance): the pool is found as soon as it has a
   * state row in a committed ledger (`ledger_index` at most the newest `ledgers` row), which is what the ledger writer
   * commits together with the swap, the liquidity event or the vote that touched the pool. `amm_pools`, which the detail and
   * the pair read, is rebuilt by the aggregator later: a pool is 404 there until its tick and is found here at once. Returns
   * the pair of the pool in its canonical order; 404 `pool not found` when there is no such row. One read of the key of the
   * pool, a granule.
   */
  async requirePool(pool: string): Promise<{ base: Asset; counter: Asset }> {
    const head = await this.ranges.latest();
    if (head !== undefined) {
      const [row] = await this.ch.query<{
        base_currency: string;
        base_issuer: string;
        counter_currency: string;
        counter_issuer: string;
      }>(
        `SELECT base_currency, base_issuer, counter_currency, counter_issuer
           FROM ${Table.AmmPoolStates}
          WHERE amm_account = {pool:String} AND ledger_index <= {head:UInt32}
          LIMIT 1`,
        { pool, head },
      );
      // the assets never change for a pool account: any of its rows names them
      if (row !== undefined) {
        return {
          base: assetOfColumns(row.base_currency, row.base_issuer),
          counter: assetOfColumns(row.counter_currency, row.counter_issuer),
        };
      }
    }
    throw notFound('pool not found');
  }

  // -- the days ----------------------------------------------------------------------------------------------------

  /**
   * One page of the days of a pool from `amm_daily`: a day is a version set, so the pool's rows that count are those of the
   * version of the sentinel of their day (`amm_account ''`, a prefix of the primary key, read in the same statement for the
   * days of the window), which leaves out the pool-days that a newer set no longer holds. A day is in the window when it
   * starts within `start` and `endExclusive`. 404 `pool not found` when the page is empty and the pool has no state.
   */
  async days(q: HistoryQuery): Promise<DaysPage> {
    const after = decodeMarker(q.marker, DAY_KEYS);

    // the first and last day (their start, unix seconds) of the window
    let first = q.start === undefined ? 0 : Math.ceil(q.start.getTime() / 1000 / DAY_SECONDS) * DAY_SECONDS;
    let last =
      q.endExclusive === undefined
        ? MAX_DAY
        : Math.ceil(q.endExclusive.getTime() / 1000 / DAY_SECONDS) * DAY_SECONDS - DAY_SECONDS;
    if (after !== undefined) {
      // strictly after (before, descending) the day the marker names
      const marked = Math.floor(Number(after[0]) / DAY_SECONDS) * DAY_SECONDS;
      if (q.descending) last = Math.min(last, marked - DAY_SECONDS);
      else first = Math.max(first, marked + DAY_SECONDS);
    }
    first = Math.max(first, 0);
    last = Math.min(last, MAX_DAY);

    const stored =
      first > last
        ? []
        : await readDistinctPage<StoredPoolDay>(this.ch, {
            columns: POOL_DAY_COLUMNS,
            table: Table.AmmDaily,
            where: [
              'amm_account = {pool:String}',
              'day BETWEEN {first:Date} AND {last:Date}',
              // the pool-days of the sets that are the newest of their day
              `(day, version) IN (SELECT day, max(version) FROM ${Table.AmmDaily}
                                   WHERE amm_account = '' AND day BETWEEN {first:Date} AND {last:Date} GROUP BY day)`,
            ],
            orderBy: DAY_ORDER,
            unique: ['day'],
            descending: q.descending,
            params: { pool: q.pool, first: dayText(first), last: dayText(last) },
            limit: q.limit + 1,
          });
    if (stored.length === 0) {
      await this.requirePool(q.pool);
      return { days: [] };
    }
    const page = paginate(stored, q.limit, (row) => [Date.parse(`${row.day}T00:00:00Z`) / 1000]);
    return {
      days: page.rows.map((row) => toPoolDayObject(q.pool, row)),
      ...(page.marker !== undefined && { marker: page.marker }),
    };
  }
}

/** The state a fill-forward row says (`filled_<column>`). */
function fromFill(row: FilledRow): FilledValues {
  return Object.fromEntries(POOL_FIELDS.map((column) => [column, row[`filled_${column}`] ?? null])) as FilledValues;
}

/** The filled columns of a row that has them under their own names. */
function valuesOf(row: FilledValues): FilledValues {
  return Object.fromEntries(POOL_FIELDS.map((column) => [column, row[column] ?? null])) as FilledValues;
}
