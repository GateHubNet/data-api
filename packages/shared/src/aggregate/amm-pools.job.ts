import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { AmmPoolsRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { Asset, assetKey } from '../query/asset';
import { ratio } from '../query/decimal';
import { RatesService } from '../query/rates.service';

/**
 * The `amm_pools` job: the current state of every AMM pool, rebuilt from the append-only `amm_pool_states` (one row per pool
 * and transaction that touched it) for the pool list and the pool detail of the API.
 *
 *  - **Fill-forward.** A state row carries a value only when its node was in the transaction's metadata (a swap through an
 *    XRP/IOU pool says nothing about the LP supply, a vote nothing about the reserves), so a field of the pool is its
 *    newest non-null value over all its state rows: `argMaxIf(field, (ledger_index, tx_index), isNotNull(field))`. The
 *    exceptions are `deleted` and `last_ledger`, which are those of the newest row, and the assets, which never change for
 *    one pool account. `created_ledger` and `created_by` are those of the pool's `AMMCreate` (`amm_liquidity`, event
 *    `create`) and are null for a pool whose creation was not ingested (a pool first seen in the middle of its life).
 *  - **A window, then older steps if need be (Rulings R-A21, R-A23 and R-A25).** The fill-forward reads the state rows of the
 *    last `AMM_FILL_WINDOW_LEDGERS` ledgers of the head first, a range of the primary key of each pool (`fillForward`, shared
 *    with `amm_daily` and the API). A pool for which that does not give every column a value (or gives no row at all) is read
 *    further back in steps that double (each step reads only the ledgers before the ones already read), until it has them all
 *    or its own first state ledger is reached (one grouped read finds the first ledger of each such pool, and a pool with
 *    nothing older than the window is not walked at all): the answer is the one the whole history gives, and the cost is a
 *    window for a pool whose values are all recent, about the distance back to its oldest needed value (at most twice that,
 *    four times when the step is the last one, plus the window) for one whose AMM-node row is older, and its own history,
 *    never more, for a pool with a value that is null for ever.
 *  - **Exact amounts.** The reserves, the LP supply and the auction price are the exact strings of the state rows; only
 *    `value_native` is a Float64.
 *  - **`value_native`** (spec section 3): 2 × the native reserve when one of the assets is the native currency; otherwise
 *    2 × the reserve of the first asset (base, then counter) that has a rate, divided by that rate, which is how many units
 *    of the asset one native coin buys (`RatesService.dailyNativeRates`, the same rate `converted = amount / rate` of the
 *    volume sets uses) on the UTC day of the pool's newest state; null when neither has one. A deleted pool has none (null):
 *    it holds nothing, and a value kept from its last live state would rank it among the pools that do.
 *  - **Only committed ledgers.** The ledger writer fills the tables of a ledger at the same time and writes its `ledgers` row
 *    (the commit marker) last, so a row of a ledger above the newest `ledgers` row (the head) may be readable while another
 *    table's rows of that ledger, or a later chunk of this one, are not. Everything here reads up to the head only: a
 *    recompute ignores state rows above it (so a pool's `last_ledger` is never past the head, and `last_ledger >= ledger`
 *    means every row of that ledger was seen), and the scans for what changed stop at it, so that the cursor never passes a
 *    ledger whose rows are not all readable.
 *  - **Idempotent, versioned.** A pool's row is a function of its state rows. Every recompute writes a new version, never
 *    lower than one more than the newest version the pool has now (the ClickHouse clock in milliseconds otherwise), so the
 *    newest row of a pool is always the newest write even when the clock steps back. Readers keep the highest version of
 *    a pool (`LIMIT 1 BY amm_account`, no FINAL).
 *  - **Duplicates change nothing.** The state table is a ReplacingMergeTree that has not merged yet, so a row may be there
 *    twice; the aggregates (`max`, `argMax`) give the same answer for a row and for two copies of it.
 */

const DAY_SECONDS = 86_400;

/** How many pools one read and one write of a recompute cover (the accounts travel as an array parameter of the query). */
export const AMM_POOLS_CHUNK = 200;

/** How many ledgers back from the ledger a fill-forward looks first (about seven days): see `fillForward`. */
export const AMM_FILL_WINDOW_LEDGERS = 160_000;

/** Thrown by a recompute whose `signal` was aborted: nothing was written after the abort. */
export class AmmPoolsRecomputeAborted extends Error {
  constructor() {
    super('The AMM pools recompute was aborted before it wrote');
    this.name = 'AmmPoolsRecomputeAborted';
  }
}

export interface RecomputeAmmPoolsOptions {
  /**
   * Checked before each read and again just before each write: an aborted recompute throws `AmmPoolsRecomputeAborted` and
   * writes nothing more. The syncer aborts it when it shuts down, so that no row is written once the shutdown has begun.
   */
  signal?: AbortSignal;
  /** How many ledgers back from the head the fill-forward looks first; default `AMM_FILL_WINDOW_LEDGERS`. */
  fillWindow?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AmmPoolsRecomputeAborted();
}

type Counted = number | string;

/** The fill-forward of the state rows of one pool, as the aggregation returns it (`fillForward`). */
interface PoolAggregate extends FillForwardRow {
  filled_reserve_base: string | null;
  filled_reserve_counter: string | null;
  filled_lp_supply: string | null;
  filled_lp_currency: string | null;
  filled_trading_fee: Counted | null;
  filled_auction_holder: string | null;
  filled_auction_price: string | null;
  filled_auction_discounted_fee: Counted | null;
  filled_auction_expiration: Counted | null;
}

interface CreatedPool {
  amm_account: string;
  created_ledger: Counted;
  created_by: string;
}

interface PoolVersion {
  amm_account: string;
  newest: Counted;
}

/** A nullable counter as a number: `null` stays `null`. */
export const nullable = (value: Counted | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

// ---------------------------------------------------------------------------------------------------------------------
// The fill-forward of the state rows of some pools
// ---------------------------------------------------------------------------------------------------------------------

/** The columns of a state row that are filled forward: the newest non-null value over the rows up to a ledger. */
export type FilledColumn =
  | 'reserve_base'
  | 'reserve_counter'
  | 'lp_supply'
  | 'lp_currency'
  | 'trading_fee'
  | 'auction_holder'
  | 'auction_price'
  | 'auction_discounted_fee'
  | 'auction_expiration';

/** What every fill-forward row says besides the filled values: the pool's pair and its newest row (the assets never change for one pool account). */
export interface FillForwardRow {
  amm_account: string;
  asset_base_currency: string;
  asset_base_issuer: string;
  asset_counter_currency: string;
  asset_counter_issuer: string;
  /** The ledger of the newest row, its close time (unix seconds) and whether it deleted the pool. */
  newest_ledger: Counted;
  newest_close: Counted;
  newest_deleted: Counted;
  now_ms: Counted;
}

export interface FillForwardQuery {
  /** The columns to fill forward: the output column of `x` is `filled_x`. */
  fields: readonly FilledColumn[];
  /**
   * The output columns (`filled_x`, or an alias of `extra`) that must be non-null for a window to be taken for the whole
   * history: a pool whose row has one of them null in the window is read further back, as far as its first ledger. Name only
   * what the answer depends on; a column that is null in the whole history of a pool makes the pool be read down to its first
   * state ledger every time. A function gives each pool its own list (`amm_daily`: the fee state at the start of the day is
   * needed only by the pools with swaps).
   */
  required: readonly string[] | ((account: string) => readonly string[]);
  /**
   * More select items over the same rows (aggregates over `row_key`, `ledger_index` and the state columns they name in
   * `columns`), and the parameters they use.
   */
  extra?: { select: string; columns: readonly FilledColumn[]; params: Record<string, unknown> };
}

/**
 * The select of a fill-forward: one row per pool that has state rows in `[fill_from, fill_up_to]`. The newest row of a pool is
 * the one with the highest `(ledger_index, tx_index)`; the assets, the newest ledger, its close time and `deleted` are those of
 * that row, and each filled column is the newest non-null value (`argMaxIf`). The aliases differ from the columns they aggregate
 * so that no aggregate reads its own alias. The `WHERE amm_account IN` and the range of ledgers are a range of the primary key
 * `(amm_account, ledger_index, tx_index)`. This is the one text of the fill-forward of `amm_pools` and `amm_daily`.
 */
export function fillForwardSql(query: Pick<FillForwardQuery, 'fields' | 'extra'>): string {
  const filled = query.fields.map((f) => `argMaxIf(${f}, row_key, isNotNull(${f})) AS filled_${f}`);
  const columns = [...new Set<string>(['deleted', 'close_time', ...query.fields, ...(query.extra?.columns ?? [])])];
  return `SELECT amm_account,
       argMax(base_currency, row_key) AS asset_base_currency,
       argMax(base_issuer, row_key) AS asset_base_issuer,
       argMax(counter_currency, row_key) AS asset_counter_currency,
       argMax(counter_issuer, row_key) AS asset_counter_issuer,
       max(ledger_index) AS newest_ledger,
       toUnixTimestamp(argMax(close_time, row_key)) AS newest_close,
       argMax(deleted, row_key) AS newest_deleted,
       ${[...filled, ...(query.extra ? [query.extra.select] : [])].join(',\n       ')},
       toUnixTimestamp64Milli(now64(3)) AS now_ms
  FROM (
       SELECT amm_account, ledger_index, (ledger_index, tx_index) AS row_key,
              base_currency, base_issuer, counter_currency, counter_issuer, ${columns.join(', ')}
         FROM ${Table.AmmPoolStates}
        WHERE amm_account IN {accounts:Array(String)} AND ledger_index BETWEEN {fill_from:UInt32} AND {fill_up_to:UInt32}
       )
 GROUP BY amm_account
 ORDER BY amm_account`;
}

/** The columns of a fill-forward row that describe its newest row: they come from the newest range in which the pool has a row. */
const NEWEST_ROW_COLUMNS: ReadonlySet<string> = new Set([
  'amm_account',
  'asset_base_currency',
  'asset_base_issuer',
  'asset_counter_currency',
  'asset_counter_issuer',
  'newest_ledger',
  'newest_close',
  'newest_deleted',
  'now_ms',
]);

/**
 * A fill-forward row of a range, completed with the row of an older range: a filled column that is null in the newer one takes
 * the value of the older one, because the newest non-null value over both ranges is the newest range's if it has one and the
 * older range's if it has none. The columns about the newest row are the newer range's.
 */
function olderInto<R extends object>(newer: R, older: R): R {
  const merged: Record<string, unknown> = { ...(newer as Record<string, unknown>) };
  for (const [column, value] of Object.entries(older)) {
    if (!NEWEST_ROW_COLUMNS.has(column) && merged[column] === null) merged[column] = value;
  }
  return merged as R;
}

/** The pools of `accounts` that have no row yet, or one with a required column still null. */
function incompleteOf<R extends object>(
  rows: ReadonlyMap<string, R>,
  accounts: readonly string[],
  query: FillForwardQuery,
): string[] {
  return accounts.filter((account) => {
    const row = rows.get(account) as Record<string, unknown> | undefined;
    const required = typeof query.required === 'function' ? query.required(account) : query.required;
    return row === undefined || required.some((column) => row[column] === null);
  });
}

/**
 * The fill-forward of the state rows of the ledgers `[from, upTo]` of some pools, one row per pool that has rows there, in the
 * order of the accounts: one read, a range of the primary key of each pool. `fillForward` is this and then `deepenFill`.
 */
export async function readFill<R extends object>(
  ch: ClickHouseService,
  accounts: string[],
  from: number,
  upTo: number,
  query: FillForwardQuery,
): Promise<Array<FillForwardRow & R>> {
  return ch.query<FillForwardRow & R>(fillForwardSql(query), {
    accounts,
    fill_from: from,
    fill_up_to: upTo,
    ...query.extra?.params,
  });
}

/**
 * The first state ledger of each of some pools among the ledgers before `before`: one grouped read of the key of the pools (the
 * ledger column of their older rows, no other). A pool that is not in it has no row before `before`.
 */
export const FIRST_LEDGERS_BEFORE_SQL = `SELECT amm_account, min(ledger_index) AS first_ledger
  FROM ${Table.AmmPoolStates}
 WHERE amm_account IN {accounts:Array(String)} AND ledger_index < {before:UInt32}
 GROUP BY amm_account`;

async function firstLedgersBefore(
  ch: ClickHouseService,
  accounts: string[],
  before: number,
): Promise<Map<string, number>> {
  const rows = await ch.query<{ amm_account: string; first_ledger: Counted }>(FIRST_LEDGERS_BEFORE_SQL, {
    accounts,
    before,
  });
  return new Map(rows.map((r) => [r.amm_account, Number(r.first_ledger)]));
}

/**
 * Reads further back, for the pools of `accounts` that `rows` does not give completely, the ledgers before `from` (the first
 * ledger `rows` has read) in doubling steps (Rulings R-A23 and R-A25). One grouped read first finds the first state ledger of
 * each of those pools before `from` (`FIRST_LEDGERS_BEFORE_SQL`): a pool with none has every value it will ever have in the
 * rows read and is not walked; the others are each walked down to their own first ledger at most. The steps end at `upTo - 2 *
 * (upTo - from)`, `upTo - 4 * (upTo - from)`, ..., and the one that would reach back half of the way to the lowest first ledger
 * of the pools left goes all the way to it (not to ledger 0). Each step reads the pools that are still incomplete and still
 * have older rows, only the ledgers no earlier step read, and completes their rows (`olderInto`); a pool leaves the walk once
 * it has every required column or a step has reached its first ledger. The rows come out as if they had been read from the
 * first ledger: a pool stops only when it has every required column or nothing older is left to read.
 *
 * The cost: two round trips and no step for pools whose first ledger is in what was read, and otherwise one round trip per step,
 * about `log2((upTo - lowest first ledger) / (upTo - from))` of them; a pool pays for the distance back to its oldest needed
 * value, at most twice that, four times when the step is the last one, and never more than its own history, and the grouped
 * read reads the ledger column of the older rows of the pools the window left incomplete. `rows` is changed in place.
 */
export async function deepenFill<R extends object>(
  ch: ClickHouseService,
  rows: Map<string, FillForwardRow & R>,
  accounts: readonly string[],
  upTo: number,
  from: number,
  query: FillForwardQuery,
): Promise<void> {
  let read = Math.max(0, Math.floor(from));
  if (read === 0) return;
  const incomplete = incompleteOf(rows, accounts, query);
  if (incomplete.length === 0) return;
  const firsts = await firstLedgersBefore(ch, incomplete, read);
  // the pools that are incomplete and have rows below what was read
  const pending = (): string[] =>
    incompleteOf(rows, accounts, query).filter((account) => (firsts.get(account) ?? read) < read);
  let walk = pending();
  let span = Math.max(1, 2 * (upTo - read));
  while (walk.length > 0) {
    const lowest = Math.min(...walk.map((account) => firsts.get(account) as number));
    const start = span >= (upTo - lowest) / 2 ? lowest : Math.max(lowest, upTo - span);
    for (const row of await readFill<R>(ch, walk, start, read - 1, query)) {
      const have = rows.get(row.amm_account);
      rows.set(row.amm_account, have === undefined ? row : olderInto(have, row));
    }
    read = start;
    walk = pending();
    span *= 2;
  }
}

/**
 * The fill-forward state of some pools at a ledger, read from a window and, if need be, further back (Rulings R-A21, R-A23 and
 * R-A25): the state rows of the ledgers `[from, upTo]` first (`readFill`, a range of the primary key of each pool), and then,
 * for the pools with no row in the window and those with one of the `required` columns null in it, `deepenFill`. The answer is
 * exactly the one the whole history gives: a column that has a value in what was read has the same newest value in the
 * history, and `deleted`, the assets and the newest ledger are those of the newest row, which is in the first range in which
 * the pool has a row. With `from` 0 the window is the history. One row per pool that has state rows up to `upTo`, in the order
 * of `accounts` (the callers pass them sorted, which is the order of the select). The `extra` items have to be fill-forwards as
 * well: null when no row qualifies, and the newest value otherwise.
 */
export async function fillForward<R extends object = Record<string, never>>(
  ch: ClickHouseService,
  accounts: string[],
  upTo: number,
  from: number,
  query: FillForwardQuery,
): Promise<Array<FillForwardRow & R>> {
  const first = Math.max(0, Math.floor(from));
  const rows = new Map((await readFill<R>(ch, accounts, first, upTo, query)).map((row) => [row.amm_account, row]));
  await deepenFill(ch, rows, accounts, upTo, first, query);
  return accounts.flatMap((account) => rows.get(account) ?? []);
}

/**
 * The columns of the pool row that come from the fill-forward, and so decide when a window is enough. The one list of them:
 * the API's history fills the same columns (`POOL_QUERY`).
 */
export const POOL_FIELDS: readonly FilledColumn[] = [
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'lp_currency',
  'trading_fee',
  'auction_holder',
  'auction_price',
  'auction_discounted_fee',
  'auction_expiration',
];
export const POOL_QUERY: FillForwardQuery = {
  fields: POOL_FIELDS,
  required: POOL_FIELDS.map((f) => `filled_${f}`),
};

/** The ledger and the sender of the `AMMCreate` of each pool whose creation was ingested (the first, should there be two). */
const POOL_CREATED_SQL = `SELECT amm_account,
       min(ledger_index) AS created_ledger,
       argMin(account, (ledger_index, tx_index)) AS created_by
  FROM ${Table.AmmLiquidity}
 WHERE amm_account IN {accounts:Array(String)} AND event = 'create' AND ledger_index <= {head:UInt32}
 GROUP BY amm_account`;

/** The newest version each of the pools has now. */
const POOL_VERSIONS_SQL = `SELECT amm_account, toUInt64(max(version)) AS newest
  FROM ${Table.AmmPools}
 WHERE amm_account IN {accounts:Array(String)}
 GROUP BY amm_account`;

// ---------------------------------------------------------------------------------------------------------------------
// The value of a pool
// ---------------------------------------------------------------------------------------------------------------------

const isNative = (currency: string, issuer: string, nativeCurrency: string): boolean =>
  currency === nativeCurrency && issuer === '';

export const decimalOf = (reserve: string | null): BigNumber | undefined => {
  if (reserve === null) return undefined;
  const value = new BigNumber(reserve);
  return value.isFinite() ? value : undefined;
};

const finiteOrNull = (value: BigNumber): number | null => {
  const number = value.toNumber();
  return Number.isFinite(number) ? number : null;
};

/**
 * What a pool's value is written to: a row of `amm_pools`, or a day of `amm_daily` (which has no `deleted` column of its own, so
 * its caller says whether the pool was deleted at the end of the day).
 */
export interface ValueTarget {
  deleted: number;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  value_native: number | null;
}

/** The pool a value is worked out for. */
export interface Valued {
  row: ValueTarget;
  /** The UTC day, in unix seconds, of the rate: that of the pool's newest state (`amm_pools`), or the day itself (`amm_daily`). */
  dayStart: number;
  base: { asset: Asset; reserve?: BigNumber };
  counter: { asset: Asset; reserve?: BigNumber };
}

const dayKeyOf = (dayStart: number): string => new Date(dayStart * 1000).toISOString().slice(0, 10);

/**
 * The rates of some assets on some days, a day at a time (one `dailyNativeRates` per day, with the assets of that day): how
 * many units of the asset one native coin buys at the end of the day, 0 when it cannot be told. `signal` is checked between
 * the days.
 */
async function ratesOn(
  rates: RatesService,
  wanted: Array<{ asset: Asset; dayStart: number }>,
  signal: AbortSignal | undefined,
): Promise<Map<string, BigNumber>> {
  const byDay = new Map<number, Map<string, Asset>>();
  for (const { asset, dayStart } of wanted) {
    let assets = byDay.get(dayStart);
    if (!assets) byDay.set(dayStart, (assets = new Map()));
    assets.set(assetKey(asset), asset);
  }
  const out = new Map<string, BigNumber>();
  for (const [dayStart, assets] of byDay) {
    throwIfAborted(signal);
    const key = dayKeyOf(dayStart);
    const found = await rates.dailyNativeRates(
      [...assets.values()],
      new Date(dayStart * 1000),
      new Date((dayStart + DAY_SECONDS) * 1000),
    );
    for (const asset of assets.keys()) {
      const rate = found.get(asset)?.get(key);
      if (rate) out.set(`${asset}@${key}`, rate);
    }
  }
  return out;
}

/**
 * Sets `value_native` of the pools (spec section 3): 2 × the native reserve when the pool has the native currency, else the
 * rate-based value of the first asset, base then counter, that has a reserve and a rate. The counter's rate is only asked for
 * the pools whose base has none.
 * A deleted pool keeps `null`. Shared by `amm_pools` (the rate of the day of the newest state) and `amm_daily` (the rate of the
 * day, the reserves those of its close).
 */
export async function valueNative(
  rates: RatesService,
  pools: Valued[],
  signal: AbortSignal | undefined,
): Promise<void> {
  const rated = (pool: Valued, side: Valued['base'], rate: BigNumber | undefined): boolean => {
    if (!side.reserve || !rate || !rate.gt(0)) return false;
    pool.row.value_native = finiteOrNull(ratio(side.reserve.times(2), rate));
    return true;
  };
  const rateOf = (found: Map<string, BigNumber>, pool: Valued, side: Valued['base']): BigNumber | undefined =>
    found.get(`${assetKey(side.asset)}@${dayKeyOf(pool.dayStart)}`);

  const native = rates.nativeCurrency;
  const others: Valued[] = [];
  for (const pool of pools) {
    const { row } = pool;
    // a deleted pool holds nothing: no value, and no rate looked up for it
    if (row.deleted === 1) continue;
    if (isNative(row.base_currency, row.base_issuer, native)) {
      row.value_native = pool.base.reserve ? finiteOrNull(pool.base.reserve.times(2)) : null;
    } else if (isNative(row.counter_currency, row.counter_issuer, native)) {
      row.value_native = pool.counter.reserve ? finiteOrNull(pool.counter.reserve.times(2)) : null;
    } else {
      others.push(pool);
    }
  }

  const withBase = others.filter((pool) => pool.base.reserve);
  const baseRates = await ratesOn(
    rates,
    withBase.map((pool) => ({ asset: pool.base.asset, dayStart: pool.dayStart })),
    signal,
  );
  // the counter's rate is asked for the pools whose base gave no value
  const unrated = others.filter((pool) => !rated(pool, pool.base, rateOf(baseRates, pool, pool.base)));

  const withCounter = unrated.filter((pool) => pool.counter.reserve);
  const counterRates = await ratesOn(
    rates,
    withCounter.map((pool) => ({ asset: pool.counter.asset, dayStart: pool.dayStart })),
    signal,
  );
  for (const pool of withCounter) rated(pool, pool.counter, rateOf(counterRates, pool, pool.counter));
}

// ---------------------------------------------------------------------------------------------------------------------
// The recompute
// ---------------------------------------------------------------------------------------------------------------------

function chunksOf<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function recomputeChunk(
  ch: ClickHouseService,
  rates: RatesService,
  accounts: string[],
  head: number,
  window: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  throwIfAborted(signal);
  const [states, created, versions] = await Promise.all([
    fillForward<PoolAggregate>(ch, accounts, head, head - window, POOL_QUERY),
    ch.query<CreatedPool>(POOL_CREATED_SQL, { accounts, head }),
    ch.query<PoolVersion>(POOL_VERSIONS_SQL, { accounts }),
  ]);
  if (states.length === 0) return 0;

  const createdBy = new Map(created.map((c) => [c.amm_account, c]));
  const newest = new Map(versions.map((v) => [v.amm_account, Number(v.newest)]));

  const pools: Valued[] = states.map((s) => {
    const made = createdBy.get(s.amm_account);
    const row: AmmPoolsRow = {
      amm_account: s.amm_account,
      base_currency: s.asset_base_currency,
      base_issuer: s.asset_base_issuer,
      counter_currency: s.asset_counter_currency,
      counter_issuer: s.asset_counter_issuer,
      lp_currency: s.filled_lp_currency,
      created_ledger: made ? Number(made.created_ledger) : null,
      created_by: made ? made.created_by : null,
      last_ledger: Number(s.newest_ledger),
      reserve_base: s.filled_reserve_base,
      reserve_counter: s.filled_reserve_counter,
      lp_supply: s.filled_lp_supply,
      trading_fee: nullable(s.filled_trading_fee),
      auction_holder: s.filled_auction_holder,
      auction_price: s.filled_auction_price,
      auction_discounted_fee: nullable(s.filled_auction_discounted_fee),
      auction_expiration: nullable(s.filled_auction_expiration),
      deleted: Number(s.newest_deleted),
      value_native: null,
      // the clock, but one past the version the pool has now
      version: Math.max(Number(s.now_ms), (newest.get(s.amm_account) ?? -1) + 1),
    };
    return {
      row,
      dayStart: Math.floor(Number(s.newest_close) / DAY_SECONDS) * DAY_SECONDS,
      base: {
        asset: { currency: s.asset_base_currency, ...(s.asset_base_issuer && { issuer: s.asset_base_issuer }) },
        reserve: decimalOf(s.filled_reserve_base),
      },
      counter: {
        asset: {
          currency: s.asset_counter_currency,
          ...(s.asset_counter_issuer && { issuer: s.asset_counter_issuer }),
        },
        reserve: decimalOf(s.filled_reserve_counter),
      },
    };
  });

  await valueNative(rates, pools, signal);

  throwIfAborted(signal);
  await ch.insert(
    Table.AmmPools,
    pools.map((pool) => pool.row),
  );
  return pools.length;
}

/**
 * Rebuilds the `amm_pools` row of each of the pools `accounts` names, from their state rows, and writes them under a new
 * version each (see the header). Returns how many rows it wrote: an account without state rows has none. The pools are
 * read and written `AMM_POOLS_CHUNK` at a time.
 *
 * It is idempotent: running it again leaves the same latest values under newer versions (the older versions go away when
 * ClickHouse merges). Without FINAL, so a pre-merge duplicate of a state row changes nothing. It reads the committed ledgers
 * only (see the header): no row above the head is in a pool, and nothing is written while no ledger is committed.
 */
export async function recomputeAmmPools(
  ch: ClickHouseService,
  rates: RatesService,
  accounts: string[],
  options: RecomputeAmmPoolsOptions = {},
): Promise<number> {
  const { signal } = options;
  throwIfAborted(signal);
  if (accounts.length === 0) return 0;
  // read once, before any state row: a ledger at or below it is committed, so all its rows are there to read
  const head = await committedHead(ch);
  let written = 0;
  const window = options.fillWindow ?? AMM_FILL_WINDOW_LEDGERS;
  for (const chunk of chunksOf([...new Set(accounts)].sort(), AMM_POOLS_CHUNK)) {
    written += await recomputeChunk(ch, rates, chunk, head, window, signal);
  }
  return written;
}

// ---------------------------------------------------------------------------------------------------------------------
// What to recompute
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The newest ledger that is committed: the highest `ledgers` row (the commit marker, written after every child table), 0 when
 * there is none. A ledger at or below it has all its rows readable (the ledger writer waits for every insert of a ledger
 * before it writes the marker); one above it may be there in part. Read first, by the end of the primary key.
 */
export async function committedHead(ch: ClickHouseService): Promise<number> {
  const row = await ch.queryOne<{ head: Counted }>(
    `SELECT ledger_index AS head FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
  );
  return row === undefined ? 0 : Number(row.head);
}

/**
 * The touches of the pools with, for each, what the pool's newest `amm_pools` row has seen (`reflected`: its `last_ledger`, and
 * nothing for a pool that has no row). A touch above it is stale: its state row is not in the pool yet (`IS_STALE`; the same
 * definition of stale as `ammPoolsWatermark`).
 */
const TOUCHES_WITH_REFLECTED = `FROM ${Table.AmmPoolTouches} AS t
  LEFT JOIN (
       SELECT amm_account, argMax(last_ledger, version) AS reflected
         FROM ${Table.AmmPools}
        GROUP BY amm_account
       ) AS p ON t.amm_account = p.amm_account`;
const IS_STALE = 't.ledger_index > ifNull(p.reflected, 0)';

/**
 * The stale pools after `ledger` (up to the head), with the first and newest stale ledger of each. It reads `amm_pool_touches`,
 * the narrow index of the state rows ordered by ledger, so the range of ledgers is a range of its primary key: the granules
 * of older ledgers are not read, whatever the state table's parts look like (Rulings R-A2 and R-A14: `amm_pool_states` is
 * ordered by pool, and once its parts have merged the minmax index on its ledgers skips no granule). A pool the job has
 * already rebuilt up to the head is not in it: a catch-up that asks again from a cursor just after the rows of a busy
 * pool does not get it back.
 */
export const POOLS_CHANGED_SINCE_SQL = `SELECT t.amm_account AS amm_account, min(t.ledger_index) AS first_ledger, max(t.ledger_index) AS newest_ledger
  ${TOUCHES_WITH_REFLECTED}
 WHERE t.ledger_index > {ledger:UInt32} AND t.ledger_index <= {head:UInt32} AND ${IS_STALE}
 GROUP BY t.amm_account
 ORDER BY first_ledger ASC, amm_account ASC
 LIMIT {n:UInt32}`;

/** The stale pools with a touch at one ledger. */
const POOLS_AT_LEDGER_SQL = `SELECT DISTINCT t.amm_account AS amm_account
  ${TOUCHES_WITH_REFLECTED}
 WHERE t.ledger_index = {at:UInt32} AND ${IS_STALE}
 ORDER BY amm_account`;

interface ChangedPool {
  amm_account: string;
  first_ledger: Counted;
  newest_ledger: Counted;
}

export interface PoolsChanged {
  /** The stale pools after the ledger, at most `limit` of them (see `poolsChangedSince`). */
  accounts: string[];
  /**
   * The ledger up to which `accounts` is everything there is: every pool with a stale state row in `(ledger, upTo]` is in it.
   * Equal to the ledger when the committed head is not past it; higher than it otherwise, also with no pool to rebuild.
   */
  upTo: number;
}

/**
 * The pools to rebuild after `ledger`: those with a state row above what their `amm_pools` row has seen, in a committed ledger
 * (see `committedHead`), oldest such row first, at most `limit` of them, and the ledger the answer is complete up to. A caller
 * that has rebuilt `accounts` goes on from `upTo`, and nothing is missed or waits for ever.
 *
 *  - When there are no more than `limit` such pools they are all returned and `upTo` is the head (the ledgers between their
 *    rows and the head have no stale row, so the cursor may skip them: also when no pool is returned).
 *  - Otherwise the pools whose first stale row is before that of the first one left out are returned, and `upTo` is the ledger
 *    before it.
 *  - When more than `limit` pools have their first stale row in the very first ledger there is, the cut would never move on,
 *    so all the pools of that ledger are returned (more than `limit` of them) and `upTo` is that ledger.
 *  - Nothing is returned, and `upTo` is `ledger`, while the head is not past it.
 */
export async function poolsChangedSince(ch: ClickHouseService, ledger: number, limit: number): Promise<PoolsChanged> {
  const n = Math.max(1, Math.floor(limit));
  const head = await committedHead(ch);
  if (head <= ledger) return { accounts: [], upTo: ledger };
  const rows = await ch.query<ChangedPool>(POOLS_CHANGED_SINCE_SQL, { ledger, head, n: n + 1 });
  if (rows.length <= n) return { accounts: rows.map((r) => r.amm_account), upTo: head };
  const edge = Number(rows[n].first_ledger);
  const before = rows.slice(0, n).filter((r) => Number(r.first_ledger) < edge);
  if (before.length > 0) return { accounts: before.map((r) => r.amm_account), upTo: edge - 1 };
  // the ledgers of the edge are committed (the edge is at most the head), so the pools there are all readable
  const atEdge = await ch.query<{ amm_account: string }>(POOLS_AT_LEDGER_SQL, { at: edge });
  return { accounts: atEdge.map((r) => r.amm_account), upTo: edge };
}

/**
 * The pools with a state row in a ledger that closed in `[from, toExclusive)`: the pools of an `agg_dirty` slice, whose ledgers
 * were rewritten behind the aggregator. The time window becomes a range of ledgers first (`RatesService.ledgersClosedIn`, the
 * way the volume jobs find theirs), and the pools are read from `amm_pool_touches` by a range of its primary key.
 */
export async function poolsClosedIn(
  ch: ClickHouseService,
  rates: RatesService,
  from: Date,
  toExclusive: Date,
): Promise<string[]> {
  const range = await rates.ledgersClosedIn(from, toExclusive);
  if (!range) return [];
  const rows = await ch.query<{ amm_account: string }>(
    `SELECT DISTINCT amm_account
       FROM ${Table.AmmPoolTouches}
      WHERE ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
      ORDER BY amm_account`,
    { min: range.min, max: range.max },
  );
  return rows.map((r) => r.amm_account);
}

/**
 * Where the live job of `amm_pools` goes on from: the highest ledger such that every pool with a state row up to it is
 * reflected in `amm_pools` (its newest version has seen the row: `last_ledger` is at least the row's ledger). It is the
 * persistent cursor of the job, worked out from the tables themselves, so that a restart resumes where the last run
 * stopped instead of rebuilding every pool: one scan of `amm_pool_touches` (the ledger and pool of every state row; narrow, and
 * not the state table), at the start of the process. The scan reads the whole table, not a range of its key: a pool that was
 * never rebuilt, or not since long ago, may have a stale row anywhere.
 *
 * It is the ledger before the oldest state row that its pool has not seen, or the committed head (see `committedHead`)
 * when there is none: 0 for a database without a ledger. Rows above the head are not counted, as they are not for
 * `poolsChangedSince`. It is not `max(last_ledger)` of `amm_pools`: a pool that a dirty slice recomputed up to the live head
 * has a `last_ledger` far past the pools the live job has not got to yet.
 */
export async function ammPoolsWatermark(ch: ClickHouseService): Promise<number> {
  const head = await committedHead(ch);
  if (head === 0) return 0;
  const row = await ch.queryOne<{ first_stale: Counted; stale: Counted }>(
    `SELECT minIf(t.ledger_index, ${IS_STALE}) AS first_stale, countIf(${IS_STALE}) AS stale
       ${TOUCHES_WITH_REFLECTED}
      WHERE t.ledger_index <= {head:UInt32}`,
    { head },
  );
  return row !== undefined && Number(row.stale) > 0 ? Number(row.first_stale) - 1 : head;
}
