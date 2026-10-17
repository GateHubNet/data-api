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
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AmmPoolsRecomputeAborted();
}

type Counted = number | string;

/** The fill-forward of the state rows of one pool, as the aggregation returns it. */
interface PoolAggregate {
  amm_account: string;
  asset_base_currency: string;
  asset_base_issuer: string;
  asset_counter_currency: string;
  asset_counter_issuer: string;
  newest_ledger: Counted;
  newest_close: Counted;
  newest_deleted: Counted;
  now_ms: Counted;
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

const nullable = (value: Counted | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/**
 * The fill-forward aggregation of the state rows of some pools: one row per pool that has state rows. The newest row of a
 * pool is the one with the highest `(ledger_index, tx_index)`. The aliases differ from the columns they aggregate so that no
 * aggregate reads its own alias. The `WHERE amm_account IN` is a range of the primary key `(amm_account, ledger_index,
 * tx_index)`.
 */
const POOL_STATES_SQL = `SELECT amm_account,
       argMax(base_currency, row_key) AS asset_base_currency,
       argMax(base_issuer, row_key) AS asset_base_issuer,
       argMax(counter_currency, row_key) AS asset_counter_currency,
       argMax(counter_issuer, row_key) AS asset_counter_issuer,
       max(ledger_index) AS newest_ledger,
       toUnixTimestamp(argMax(close_time, row_key)) AS newest_close,
       argMax(deleted, row_key) AS newest_deleted,
       argMaxIf(reserve_base, row_key, isNotNull(reserve_base)) AS filled_reserve_base,
       argMaxIf(reserve_counter, row_key, isNotNull(reserve_counter)) AS filled_reserve_counter,
       argMaxIf(lp_supply, row_key, isNotNull(lp_supply)) AS filled_lp_supply,
       argMaxIf(lp_currency, row_key, isNotNull(lp_currency)) AS filled_lp_currency,
       argMaxIf(trading_fee, row_key, isNotNull(trading_fee)) AS filled_trading_fee,
       argMaxIf(auction_holder, row_key, isNotNull(auction_holder)) AS filled_auction_holder,
       argMaxIf(auction_price, row_key, isNotNull(auction_price)) AS filled_auction_price,
       argMaxIf(auction_discounted_fee, row_key, isNotNull(auction_discounted_fee)) AS filled_auction_discounted_fee,
       argMaxIf(auction_expiration, row_key, isNotNull(auction_expiration)) AS filled_auction_expiration,
       toUnixTimestamp64Milli(now64(3)) AS now_ms
  FROM (
       SELECT *, (ledger_index, tx_index) AS row_key
         FROM ${Table.AmmPoolStates}
        WHERE amm_account IN {accounts:Array(String)} AND ledger_index <= {head:UInt32}
       )
 GROUP BY amm_account
 ORDER BY amm_account`;

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

const decimalOf = (reserve: string | null): BigNumber | undefined => {
  if (reserve === null) return undefined;
  const value = new BigNumber(reserve);
  return value.isFinite() ? value : undefined;
};

const finiteOrNull = (value: BigNumber): number | null => {
  const number = value.toNumber();
  return Number.isFinite(number) ? number : null;
};

/** The pool a value is worked out for. */
interface Valued {
  row: AmmPoolsRow;
  /** The UTC day, in unix seconds, of the pool's newest state: the day of the rate. */
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
 * A deleted pool keeps `null`.
 */
async function valueNative(rates: RatesService, pools: Valued[], signal: AbortSignal | undefined): Promise<void> {
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
  signal: AbortSignal | undefined,
): Promise<number> {
  throwIfAborted(signal);
  const params = { accounts, head };
  const [states, created, versions] = await Promise.all([
    ch.query<PoolAggregate>(POOL_STATES_SQL, params),
    ch.query<CreatedPool>(POOL_CREATED_SQL, params),
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
  for (const chunk of chunksOf([...new Set(accounts)].sort(), AMM_POOLS_CHUNK)) {
    written += await recomputeChunk(ch, rates, chunk, head, signal);
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
