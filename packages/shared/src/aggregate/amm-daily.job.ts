import BigNumber from 'bignumber.js';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { AmmDailyRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { RatesService } from '../query/rates.service';
import { RIPPLE_EPOCH_MS } from '../util/time';
import {
  AMM_FILL_WINDOW_LEDGERS,
  committedHead,
  decimalOf,
  deepenFill,
  fillForward,
  FillForwardQuery,
  FillForwardRow,
  fillForwardSql,
  nullable,
  Valued,
  valueNative,
} from './amm-pools.job';
import { AMM_CHUNK, AMM_SWAPS_WHERE, AMM_TOUCHED_POOLS_SQL, ammChunks, ammSwapParams } from './amm-reads';
import { at, DAY_SECONDS, dayKey, dayStartSeconds, nextVersion, VOLUME_DAY_SETTLE_MS } from './volume.job';

/**
 * The `amm_daily` job: one row per AMM pool and UTC day on which a transaction touched the pool, with the swap volume and the
 * estimated fees of the day, the liquidity that came in and went out, and the closing state of the pool (what
 * `/v2/amm/pools/:pool/history?interval=day` serves).
 *
 *  - **Version sets (as `volume.job.ts`).** A day is written whole, in one insert, under one version: a row for each pool with
 *    activity that day, and a **sentinel** row (`amm_account` `''`, empty assets, zero amounts, null state) that stands for the
 *    day: a day without any pool is still a set, which is how it is known to be computed, and a pool-day that was in an older
 *    set but not in this one (a pool whose activity was re-ingested away) is not in the newest. A reader takes the version of
 *    a day from its sentinel (`WHERE amm_account = '' AND day = ...` is a prefix of the primary key `(amm_account, day)`) and
 *    keeps the pool rows with that version; it never reads the sentinel as a pool, and never relies on a merge. The version is
 *    the ClickHouse clock in milliseconds, and never lower than one more than the day's newest.
 *  - **Finality (Ruling R86).** The `final` column of the sentinel says whether the newest committed ledger had closed
 *    `VOLUME_DAY_SETTLE_MS` after the end of the day when the set was read (the head is read BEFORE any other table, so all
 *    ledgers up to it are in what the set counted). `ammDaysDone` counts a day as done only for a final set of the current
 *    `AMM_DAILY_CONFIG_VERSION`; bump that number when the computation changes, so that the old days are done again.
 *  - **Only committed ledgers.** The ledger writer fills the tables of a ledger at the same time and writes its `ledgers` row
 *    (the commit marker) last, so the day is read up to the newest `ledgers` row (`committedHead`, read once per run): a run sees
 *    one consistent prefix of every table, and the closing state of a pool never includes a ledger whose other rows are not
 *    readable yet.
 *  - **No read crosses the pairs or the pools (Rulings R-A3 and R-A14).** The pools of the day come from the narrow
 *    `amm_pool_touches`, by a range of its primary key (the ledgers of the day). The swaps of those pools are read from
 *    `exchanges` through the pair key of each pool (its four asset columns, then the ledgers: a range of the primary key) and
 *    the `amm_account_set` skip index, never a scan of the exchanges across the pairs. Every other table is read by the key of
 *    the pool and a range of its ledgers.
 *  - **Swaps.** The pool's change of each asset is stored; the asset that flowed INTO the pool is the one that counts
 *    (Ruling R-A10): `buyer` is the pool when base went in, else counter did. `volume_*` are the sums of the inputs by side.
 *  - **Estimated fees.** For each swap: the input times the fee in force at that swap over 100000. The fee is the trading fee
 *    filled forward over the pool's state rows up to the swap, or the discounted fee of the auction slot when the taker is the
 *    slot holder, or one of the accounts of the holder's last bid, and the slot has not expired (rippled does not discount
 *    once the slot ran out, and the slot stays in the AMM object after that). A swap with no fee known (the pool was first
 *    seen without its AMM node, so nothing says the fee yet) adds its volume and no fee.
 *  - **Liquidity.** A create counts as a deposit and a clawback as a withdrawal; a delete counts as neither. The amounts are
 *    the pool's signed changes, the positive part of each side is "in" and the negative part "out".
 *  - **Closing state.** Each field is its newest non-null value over the pool's state rows up to the last ledger of the day,
 *    like `amm_pools` (`argMaxIf`, from a window of the history, then the whole of it if need be: see Cost below). A pool deleted during the day has its activity, the deleted state as its closing state
 *    (empty reserves) and no value. `value_native` is that of `amm_pools` (2 x the native reserve, else 2 x a reserve over the
 *    daily rate of the asset) at the closing reserves, and the rate of the day itself.
 *  - **Duplicates change nothing.** The tables are ReplacingMergeTrees that may not have merged: every read dedupes by the key
 *    of the table (`LIMIT 1 BY`), and the aggregates give the same answer for a row and for two copies of it.
 *
 * Cost: the closing state and the fee state at the start of the day are read from the last `AMM_FILL_WINDOW_LEDGERS` ledgers
 * before the day of the state rows of each pool (`fillForward`, Rulings R-A21 and R-A23), and a pool whose window does not hold
 * a value it needs is read further back in doubling steps that read only older ledgers. A pool with all its values in the
 * window costs the window (about a week of its rows, whatever its age); one whose oldest needed value (an AMM-node row: a
 * swap does not carry the fee, the LP supply or the slot) is older costs about the distance back to it, at most twice that, plus
 * the window; the whole history is read only for a pool with a value that is null for ever. A back-fill of many days costs
 * that for each day.
 */

/** The version of the computation: bump it when the rows would come out differently, so that `ammDaysDone` redoes the days. */
export const AMM_DAILY_CONFIG_VERSION = 1;

/** How many pools one read of the job covers (the accounts travel as an array parameter of the queries). */
export const AMM_DAILY_CHUNK = AMM_CHUNK;

const RIPPLE_EPOCH_S = RIPPLE_EPOCH_MS / 1000;
/** The fee is in units of 1/100000. */
const FEE_SCALE = 5;

/** Thrown by a recompute whose `signal` was aborted: nothing was written after the abort. */
export class AmmDailyRecomputeAborted extends Error {
  constructor() {
    super('The AMM daily recompute was aborted before it wrote');
    this.name = 'AmmDailyRecomputeAborted';
  }
}

export interface AmmDailyOptions {
  /**
   * Checked before the work, between the chunks of pools and again just before the insert: an aborted recompute throws
   * `AmmDailyRecomputeAborted` and writes nothing. The syncer aborts it when it shuts down.
   */
  signal?: AbortSignal;
  /** How many ledgers before the first ledger of the day the fill-forward looks first; default `AMM_FILL_WINDOW_LEDGERS`. */
  fillWindow?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AmmDailyRecomputeAborted();
}

type Counted = number | string;

const ZERO = new BigNumber(0);

// ---------------------------------------------------------------------------------------------------------------------
// The arithmetic of a day: no database in it
// ---------------------------------------------------------------------------------------------------------------------

/** A swap of the day, from its `exchanges` row. */
export interface DaySwap {
  ledger_index: number;
  tx_index: number;
  /** When the ledger closed, unix seconds. */
  closed: number;
  taker: string;
  /** The account that received base: the pool when base flowed into it. */
  buyer: string;
  base_amount: string;
  counter_amount: string;
}

/** What the fee of a swap depends on, at a point in the history of a pool. Null: nothing says it yet. */
export interface FeeState {
  trading_fee: number | null;
  auction_holder: string | null;
  auction_discounted_fee: number | null;
  /** In ripple seconds, as the ledger has it. */
  auction_expiration: number | null;
  /** Whose bid the authorised accounts are from: they count while that account is the holder. */
  auth_holder: string | null;
  auth_accounts: readonly string[];
}

/**
 * A change of the fee state at a point (a state row of the pool, or a bid): a field that is null or absent leaves the value
 * the state had (filled forward). A bid also says whose slot the authorised accounts are.
 */
export interface FeeEvent {
  ledger_index: number;
  tx_index: number;
  trading_fee?: number | null;
  auction_holder?: string | null;
  auction_discounted_fee?: number | null;
  auction_expiration?: number | null;
  bid?: { holder: string | null; auth_accounts: readonly string[] };
}

export interface SwapTotals {
  count: number;
  volume_base: string;
  volume_counter: string;
  fees_base_est: string;
  fees_counter_est: string;
}

interface Keyed {
  ledger_index: number;
  tx_index: number;
}

/** The order of the ledger: by ledger, then by transaction. */
const byKey = (a: Keyed, b: Keyed): number => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index;

function applied(state: FeeState, event: FeeEvent): FeeState {
  return {
    trading_fee: event.trading_fee ?? state.trading_fee,
    auction_holder: event.auction_holder ?? state.auction_holder,
    auction_discounted_fee: event.auction_discounted_fee ?? state.auction_discounted_fee,
    auction_expiration: event.auction_expiration ?? state.auction_expiration,
    auth_holder: event.bid ? event.bid.holder : state.auth_holder,
    auth_accounts: event.bid ? event.bid.auth_accounts : state.auth_accounts,
  };
}

/** The fee, in units of 1/100000, that the taker of a swap pays in this state; null when none is known. */
function feeOf(state: FeeState, swap: DaySwap): number | null {
  const holder = state.auction_holder;
  const discounted = state.auction_discounted_fee;
  const inForce = state.auction_expiration === null || swap.closed - RIPPLE_EPOCH_S < state.auction_expiration;
  const member =
    holder !== null &&
    (swap.taker === holder || (state.auth_holder === holder && state.auth_accounts.includes(swap.taker)));
  return member && inForce && discounted !== null ? discounted : state.trading_fee;
}

/**
 * The volume and the estimated fees of the swaps of a pool in a day. `carry` is the fee state at the start of the day, and
 * `events` the changes of it during the day; each swap is charged at the state of the rows up to and including its own (a
 * transaction has one row per pool). The inputs may come in any order.
 */
export function swapTotals(
  pool: string,
  swaps: readonly DaySwap[],
  carry: FeeState,
  events: readonly FeeEvent[],
): SwapTotals {
  const ordered = [...swaps].sort(byKey);
  const changes = [...events].sort(byKey);
  let state = carry;
  let next = 0;
  const volume = { base: ZERO, counter: ZERO };
  const fees = { base: ZERO, counter: ZERO };
  for (const swap of ordered) {
    while (next < changes.length && byKey(changes[next], swap) <= 0) state = applied(state, changes[next++]);
    const side = swap.buyer === pool ? 'base' : 'counter';
    const input = new BigNumber(side === 'base' ? swap.base_amount : swap.counter_amount);
    volume[side] = volume[side].plus(input);
    const fee = feeOf(state, swap);
    // the shift is exact: a division would round at 20 decimal places
    if (fee !== null) fees[side] = fees[side].plus(input.times(fee).shiftedBy(-FEE_SCALE));
  }
  return {
    count: ordered.length,
    volume_base: volume.base.toString(),
    volume_counter: volume.counter.toString(),
    fees_base_est: fees.base.toString(),
    fees_counter_est: fees.counter.toString(),
  };
}

/** A liquidity event of the day, from its `amm_liquidity` row: the amounts are signed from the pool's side (+ in, - out). */
export interface DayLiquidity {
  ledger_index: number;
  tx_index: number;
  event: string;
  base_amount: string;
  counter_amount: string;
}

export interface LiquidityTotals {
  deposit_count: number;
  withdraw_count: number;
  liquidity_in_base: string;
  liquidity_in_counter: string;
  liquidity_out_base: string;
  liquidity_out_counter: string;
}

/**
 * The counts and the flows of the liquidity events of a pool in a day. A create is the first deposit of the pool and counts
 * as a deposit, a clawback takes liquidity out and counts as a withdrawal, a delete counts as neither. The positive part of
 * each side of each event is liquidity in, the negative part (as a positive number) liquidity out.
 */
export function liquidityTotals(events: readonly DayLiquidity[]): LiquidityTotals {
  let deposits = 0;
  let withdrawals = 0;
  const flow = { inBase: ZERO, inCounter: ZERO, outBase: ZERO, outCounter: ZERO };
  for (const event of events) {
    if (event.event === 'create' || event.event === 'deposit') deposits++;
    if (event.event === 'withdraw' || event.event === 'clawback') withdrawals++;
    const [base, counter] = [new BigNumber(event.base_amount), new BigNumber(event.counter_amount)];
    if (base.gt(0)) flow.inBase = flow.inBase.plus(base);
    else flow.outBase = flow.outBase.minus(base);
    if (counter.gt(0)) flow.inCounter = flow.inCounter.plus(counter);
    else flow.outCounter = flow.outCounter.minus(counter);
  }
  return {
    deposit_count: deposits,
    withdraw_count: withdrawals,
    liquidity_in_base: flow.inBase.toString(),
    liquidity_in_counter: flow.inCounter.toString(),
    liquidity_out_base: flow.outBase.toString(),
    liquidity_out_counter: flow.outCounter.toString(),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The pools a transaction touched in the ledgers of the day, from the narrow ledger-ordered `amm_pool_touches`: a range of its
 * primary key (Ruling R-A14), never the state table (ordered by pool) or the exchanges.
 */
export const AMM_DAILY_TOUCHES_SQL = AMM_TOUCHED_POOLS_SQL;

/**
 * The closing state of some pools, a fill-forward of their state rows up to the last ledger of the day (`fillForward`: a window
 * first, then older steps for the pools the window does not answer for), and the fee state they were carried into the day
 * with: the same fill-forward up to the ledger before it, of the fee and of the auction slot. The answer is that of the whole
 * history (Rulings R-A21 and R-A23). What decides that the window is enough depends on the pool:
 *  - every pool needs its closing state, so a reserve, the LP supply or the fee that is null in what was read is looked for
 *    further back;
 *  - only a pool with swaps that day needs the fee state at the start of the day (the fee, and the slot: its holder, its
 *    discounted fee and its expiration), so those columns are looked for further back (`CARRY_REQUIRED`, with `deepenFill`)
 *    for the pools with swaps and for them only. The slot values are required and not left to the expiration: a slot may be
 *    in force at the start of the day however far back it was bid when the window is shorter than a day of ledgers.
 */
const DAILY_CARRIED = ['trading_fee', 'auction_holder', 'auction_discounted_fee', 'auction_expiration'] as const;
const CLOSING_REQUIRED = ['filled_reserve_base', 'filled_reserve_counter', 'filled_lp_supply', 'filled_trading_fee'];
const CARRY_REQUIRED = DAILY_CARRIED.map((c) => `carry_${c}`);
const dailyQuery = (first: number, required: readonly string[]): FillForwardQuery => ({
  fields: ['reserve_base', 'reserve_counter', 'lp_supply', 'trading_fee'],
  required,
  extra: {
    columns: DAILY_CARRIED,
    select: DAILY_CARRIED.map(
      (c) => `argMaxIf(${c}, row_key, isNotNull(${c}) AND ledger_index < {first:UInt32}) AS carry_${c}`,
    ).join(',\n       '),
    params: { first },
  },
});
export const AMM_DAILY_STATES_SQL = fillForwardSql(dailyQuery(0, CLOSING_REQUIRED));

/**
 * The swaps of pools in the ledgers of the day, through the pair key of each pool (the four asset columns, then the ledgers,
 * are a range of the primary key of `exchanges`) and the `amm_account_set` skip index: no scan of the exchanges across the
 * pairs (Ruling R-A3). A row that was written twice is read once (`LIMIT 1 BY` the whole key, which is also the order of the
 * read, so the table is read in key order).
 */
export const AMM_DAILY_SWAPS_SQL = `SELECT amm_account, ledger_index, tx_index, toUnixTimestamp(close_time) AS closed, taker, buyer, base_amount, counter_amount
  FROM ${Table.Exchanges}
 WHERE ${AMM_SWAPS_WHERE}
 ORDER BY base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index
 LIMIT 1 BY base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index`;

const LIQUIDITY_SQL = `SELECT amm_account, ledger_index, tx_index, event, base_amount, counter_amount
  FROM ${Table.AmmLiquidity}
 WHERE amm_account IN {accounts:Array(String)} AND ledger_index BETWEEN {first:UInt32} AND {last:UInt32}
 ORDER BY amm_account, ledger_index, tx_index
 LIMIT 1 BY amm_account, ledger_index, tx_index`;

/** The state rows of the day that say something about the fee or the auction slot (the others change nothing of it). */
const FEE_EVENTS_SQL = `SELECT amm_account, ledger_index, tx_index, trading_fee, auction_holder, auction_discounted_fee, auction_expiration
  FROM ${Table.AmmPoolStates}
 WHERE amm_account IN {accounts:Array(String)} AND ledger_index BETWEEN {first:UInt32} AND {last:UInt32}
   AND (isNotNull(trading_fee) OR isNotNull(auction_holder) OR isNotNull(auction_discounted_fee) OR isNotNull(auction_expiration))
 ORDER BY amm_account, ledger_index, tx_index
 LIMIT 1 BY amm_account, ledger_index, tx_index`;

/** The bid whose slot and authorised accounts the day starts with: the newest before it. */
const BID_CARRY_SQL = `SELECT amm_account,
       argMax(slot_holder, (ledger_index, tx_index)) AS slot_holder,
       argMax(auth_accounts, (ledger_index, tx_index)) AS auth_accounts
  FROM ${Table.AmmGovernance}
 WHERE amm_account IN {accounts:Array(String)} AND kind = 'bid' AND ledger_index < {first:UInt32}
 GROUP BY amm_account`;

/** The bids of the day. */
const BIDS_SQL = `SELECT amm_account, ledger_index, tx_index, slot_holder, auth_accounts
  FROM ${Table.AmmGovernance}
 WHERE amm_account IN {accounts:Array(String)} AND kind = 'bid' AND ledger_index BETWEEN {first:UInt32} AND {last:UInt32}
 ORDER BY amm_account, ledger_index, tx_index
 LIMIT 1 BY amm_account, ledger_index, tx_index`;

interface ClosingRow extends FillForwardRow {
  filled_reserve_base: string | null;
  filled_reserve_counter: string | null;
  filled_lp_supply: string | null;
  filled_trading_fee: Counted | null;
  carry_trading_fee: Counted | null;
  carry_auction_holder: string | null;
  carry_auction_discounted_fee: Counted | null;
  carry_auction_expiration: Counted | null;
}

interface SwapRow {
  amm_account: string;
  ledger_index: Counted;
  tx_index: Counted;
  closed: Counted;
  taker: string;
  buyer: string;
  base_amount: string;
  counter_amount: string;
}

interface LiquidityRow extends DayLiquidity {
  amm_account: string;
}

interface FeeEventRow {
  amm_account: string;
  ledger_index: Counted;
  tx_index: Counted;
  trading_fee: Counted | null;
  auction_holder: string | null;
  auction_discounted_fee: Counted | null;
  auction_expiration: Counted | null;
}

interface BidRow {
  amm_account: string;
  ledger_index: Counted;
  tx_index: Counted;
  slot_holder: string | null;
  auth_accounts: string[];
}

interface BidCarryRow {
  amm_account: string;
  slot_holder: string | null;
  auth_accounts: string[];
}

/** Rows grouped by pool. */
function byPool<T extends { amm_account: string }, R>(rows: T[], convert: (row: T) => R): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const row of rows) {
    const list = out.get(row.amm_account);
    if (list) list.push(convert(row));
    else out.set(row.amm_account, [convert(row)]);
  }
  return out;
}

/** The ledgers of the day that are committed: `last` is never past the head. A type, not an interface: it is query parameters. */
type DayLedgers = { first: number; last: number };

async function activePools(ch: ClickHouseService, ledgers: DayLedgers): Promise<string[]> {
  const rows = await ch.query<{ amm_account: string }>(AMM_DAILY_TOUCHES_SQL, ledgers);
  return rows.map((r) => r.amm_account);
}

/** The swaps of the pools of a chunk, read through the pair of each pool: one query for all the pairs of the chunk. */
async function swapsOf(
  ch: ClickHouseService,
  closing: ClosingRow[],
  ledgers: DayLedgers,
): Promise<Map<string, DaySwap[]>> {
  const rows = await ch.query<SwapRow>(
    AMM_DAILY_SWAPS_SQL,
    ammSwapParams(
      closing.map((c) => ({
        account: c.amm_account,
        pair: [c.asset_base_currency, c.asset_base_issuer, c.asset_counter_currency, c.asset_counter_issuer] as const,
      })),
      ledgers,
    ),
  );
  return byPool(
    rows,
    (r): DaySwap => ({
      ledger_index: Number(r.ledger_index),
      tx_index: Number(r.tx_index),
      closed: Number(r.closed),
      taker: r.taker,
      buyer: r.buyer,
      base_amount: r.base_amount,
      counter_amount: r.counter_amount,
    }),
  );
}

/** The fee events of the day of some pools: their state rows with a fee or a slot in them, and their bids. */
async function feeEventsOf(
  ch: ClickHouseService,
  accounts: string[],
  ledgers: DayLedgers,
): Promise<{ events: Map<string, FeeEvent[]>; carried: Map<string, BidCarryRow> }> {
  const params = { accounts, ...ledgers };
  const [states, bids, carried] = await Promise.all([
    ch.query<FeeEventRow>(FEE_EVENTS_SQL, params),
    ch.query<BidRow>(BIDS_SQL, params),
    ch.query<BidCarryRow>(BID_CARRY_SQL, { accounts, first: ledgers.first }),
  ]);
  const events = byPool(
    states,
    (r): FeeEvent => ({
      ledger_index: Number(r.ledger_index),
      tx_index: Number(r.tx_index),
      trading_fee: nullable(r.trading_fee),
      auction_holder: r.auction_holder,
      auction_discounted_fee: nullable(r.auction_discounted_fee),
      auction_expiration: nullable(r.auction_expiration),
    }),
  );
  const fromBids = byPool(
    bids,
    (r): FeeEvent => ({
      ledger_index: Number(r.ledger_index),
      tx_index: Number(r.tx_index),
      bid: { holder: r.slot_holder, auth_accounts: r.auth_accounts },
    }),
  );
  for (const [account, list] of fromBids) events.set(account, [...(events.get(account) ?? []), ...list]);
  return { events, carried: new Map(carried.map((c) => [c.amm_account, c])) };
}

/** The pool rows of a day, without a version, for the pools of a chunk. */
async function poolDays(
  ch: ClickHouseService,
  rates: RatesService,
  accounts: string[],
  ledgers: DayLedgers,
  start: number,
  window: number,
): Promise<Array<Omit<AmmDailyRow, 'version'>>> {
  const day = dayKey(start);
  const from = Math.max(0, ledgers.first - window);
  const [read, liquidity] = await Promise.all([
    // the state up to the last ledger of the day, and the fee state at the start of it, from a window before the day
    fillForward<ClosingRow>(ch, accounts, ledgers.last, from, dailyQuery(ledgers.first, CLOSING_REQUIRED)),
    ch.query<LiquidityRow>(LIQUIDITY_SQL, { accounts, ...ledgers }),
  ]);
  const swaps = await swapsOf(ch, read, ledgers);
  // the fee state at the start of the day is the business of the pools with swaps: those whose window does not hold it go on
  // further back, the others (a deposit, a vote, a bid, nothing to charge) do not
  const filled = new Map(read.map((row) => [row.amm_account, row]));
  await deepenFill(
    ch,
    filled,
    read.map((row) => row.amm_account).filter((account) => swaps.has(account)),
    ledgers.last,
    from,
    dailyQuery(ledgers.first, CARRY_REQUIRED),
  );
  const closing = read.map((row) => filled.get(row.amm_account) as ClosingRow);
  const withSwaps = closing.map((c) => c.amm_account).filter((account) => swaps.has(account));
  const { events, carried } =
    withSwaps.length > 0
      ? await feeEventsOf(ch, withSwaps, ledgers)
      : { events: new Map<string, FeeEvent[]>(), carried: new Map<string, BidCarryRow>() };
  const liquidityOf = byPool(liquidity, (r): DayLiquidity => r);

  const valued: Valued[] = [];
  const rows = closing.map((c): Omit<AmmDailyRow, 'version'> => {
    const bid = carried.get(c.amm_account);
    const totals = swapTotals(
      c.amm_account,
      swaps.get(c.amm_account) ?? [],
      {
        trading_fee: nullable(c.carry_trading_fee),
        auction_holder: c.carry_auction_holder,
        auction_discounted_fee: nullable(c.carry_auction_discounted_fee),
        auction_expiration: nullable(c.carry_auction_expiration),
        auth_holder: bid?.slot_holder ?? null,
        auth_accounts: bid?.auth_accounts ?? [],
      },
      events.get(c.amm_account) ?? [],
    );
    const flows = liquidityTotals(liquidityOf.get(c.amm_account) ?? []);
    const row = {
      amm_account: c.amm_account,
      day,
      base_currency: c.asset_base_currency,
      base_issuer: c.asset_base_issuer,
      counter_currency: c.asset_counter_currency,
      counter_issuer: c.asset_counter_issuer,
      swap_count: totals.count,
      volume_base: totals.volume_base,
      volume_counter: totals.volume_counter,
      fees_base_est: totals.fees_base_est,
      fees_counter_est: totals.fees_counter_est,
      deposit_count: flows.deposit_count,
      withdraw_count: flows.withdraw_count,
      liquidity_in_base: flows.liquidity_in_base,
      liquidity_in_counter: flows.liquidity_in_counter,
      liquidity_out_base: flows.liquidity_out_base,
      liquidity_out_counter: flows.liquidity_out_counter,
      reserve_base: c.filled_reserve_base,
      reserve_counter: c.filled_reserve_counter,
      lp_supply: c.filled_lp_supply,
      trading_fee: nullable(c.filled_trading_fee),
      value_native: null,
      final: 0,
      config_version: AMM_DAILY_CONFIG_VERSION,
    };
    valued.push({
      row: {
        deleted: Number(c.newest_deleted),
        base_currency: c.asset_base_currency,
        base_issuer: c.asset_base_issuer,
        counter_currency: c.asset_counter_currency,
        counter_issuer: c.asset_counter_issuer,
        value_native: null,
      },
      dayStart: start,
      base: {
        asset: { currency: c.asset_base_currency, ...(c.asset_base_issuer && { issuer: c.asset_base_issuer }) },
        reserve: decimalOf(c.filled_reserve_base),
      },
      counter: {
        asset: {
          currency: c.asset_counter_currency,
          ...(c.asset_counter_issuer && { issuer: c.asset_counter_issuer }),
        },
        reserve: decimalOf(c.filled_reserve_counter),
      },
    });
    return row;
  });

  // the abort is ours: a recompute of the pools job would throw its own
  await valueNative(rates, valued, undefined);
  rows.forEach((row, i) => (row.value_native = valued[i].row.value_native));
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------------------------------------------------

/** The sentinel of a set: the row of `amm_account` `''` that stands for the day. */
function sentinelRow(day: string, final: boolean, version: number): AmmDailyRow {
  return {
    amm_account: '',
    day,
    base_currency: '',
    base_issuer: '',
    counter_currency: '',
    counter_issuer: '',
    swap_count: 0,
    volume_base: '0',
    volume_counter: '0',
    fees_base_est: '0',
    fees_counter_est: '0',
    deposit_count: 0,
    withdraw_count: 0,
    liquidity_in_base: '0',
    liquidity_in_counter: '0',
    liquidity_out_base: '0',
    liquidity_out_counter: '0',
    reserve_base: null,
    reserve_counter: null,
    lp_supply: null,
    trading_fee: null,
    value_native: null,
    final: final ? 1 : 0,
    config_version: AMM_DAILY_CONFIG_VERSION,
    version,
  };
}

/** The close time of a ledger, unix seconds. */
async function closeTimeOf(ch: ClickHouseService, ledger: number): Promise<number | undefined> {
  const row = await ch.queryOne<{ closed: Counted }>(
    `SELECT toUnixTimestamp(close_time) AS closed FROM ${Table.Ledgers} WHERE ledger_index = {ledger:UInt32}`,
    { ledger },
  );
  return row === undefined ? undefined : Number(row.closed);
}

/**
 * Recomputes the set of the UTC day of `day` and writes it: the sentinel and a row for each pool a transaction touched that
 * day, under one version, in one insert. Returns how many pool rows it wrote. See the header for what a row holds.
 *
 * The sentinel says whether the set is the final one of its day (`final` 1): the newest committed ledger had closed
 * `VOLUME_DAY_SETTLE_MS` after the end of the day when the set was read, and the head is read BEFORE the tables are, so all
 * the ledgers of the day are in it. A day whose ledgers are not committed yet is never final.
 */
export async function computeAmmDaily(
  ch: ClickHouseService,
  rates: RatesService,
  day: Date,
  options: AmmDailyOptions = {},
): Promise<number> {
  const { signal } = options;
  throwIfAborted(signal);
  const start = dayStartSeconds(day);
  const key = dayKey(start);

  // 1. one view of the ingest: the newest committed ledger, and when it closed
  const head = await committedHead(ch);
  const newest = head === 0 ? undefined : await closeTimeOf(ch, head);
  const final = newest !== undefined && newest >= start + DAY_SECONDS + VOLUME_DAY_SETTLE_MS / 1000;

  // 2. the ledgers of the day, up to the head
  const closed = head === 0 ? null : await rates.ledgersClosedIn(at(start), at(start + DAY_SECONDS));
  // a day that starts above the head has `first > last`: no ledger, no touch, no pool
  const ledgers: DayLedgers | null = closed ? { first: closed.min, last: Math.min(closed.max, head) } : null;

  // 3. the pools of the day, and their rows
  const pools = ledgers ? await activePools(ch, ledgers) : [];
  const rows: Array<Omit<AmmDailyRow, 'version'>> = [];
  if (ledgers) {
    for (const chunk of ammChunks(pools, AMM_DAILY_CHUNK)) {
      throwIfAborted(signal);
      rows.push(...(await poolDays(ch, rates, chunk, ledgers, start, options.fillWindow ?? AMM_FILL_WINDOW_LEDGERS)));
    }
  }

  // 4. the set: one version for the sentinel and the pools, one insert
  const version = await nextVersion(ch, Table.AmmDaily, "amm_account = '' AND day = {day:Date}", { day: key });
  throwIfAborted(signal);
  await ch.insert(Table.AmmDaily, [
    sentinelRow(key, final, version),
    // the pools are in the order of their account: the reads of the chunks are ordered by it
    ...rows.map((r) => ({ ...r, version })),
  ]);
  return rows.length;
}

/**
 * The days among `days` (UTC days: each is cut to its midnight) that are done: the newest set of the day, by its sentinel, was
 * made with `configVersion` AND is a final one (the ingest had passed the day). A day whose newest set has another config
 * version is not in it, so it is computed again after the computation changed; neither is one whose newest set was made while
 * its ledgers were not all in. A day with only a sentinel (no pool) is done. A set that was stored twice counts once. Returns
 * the days as `YYYY-MM-DD`.
 */
export async function ammDaysDone(ch: ClickHouseService, configVersion: number, days: Date[]): Promise<Set<string>> {
  const keys = [...new Set(days.map((d) => dayKey(dayStartSeconds(d))))];
  if (keys.length === 0) return new Set();
  const rows = await ch.query<{ day: string }>(
    `SELECT toString(day) AS day
       FROM (SELECT day, config_version, final
               FROM ${Table.AmmDaily}
              WHERE amm_account = '' AND day IN {days:Array(Date)}
              ORDER BY day ASC, version DESC
              LIMIT 1 BY day)
      WHERE config_version = {configVersion:UInt32} AND final = 1`,
    { days: keys, configVersion },
  );
  return new Set(rows.map((r) => r.day));
}

/**
 * The newest version of the set of each day of `[from, to]` (UTC days), keyed `YYYY-MM-DD`: when each was last written. A day
 * without a set is not in it. The aggregator starts with the stalest, so that none starves.
 */
export async function ammDailyVersions(ch: ClickHouseService, from: Date, to: Date): Promise<Map<string, number>> {
  const first = dayStartSeconds(from);
  const last = dayStartSeconds(to);
  if (first > last) return new Map();
  const rows = await ch.query<{ day_text: string; version: Counted }>(
    `SELECT toString(day) AS day_text, toUInt64(max(version)) AS version
       FROM ${Table.AmmDaily}
      WHERE amm_account = '' AND day >= {from:Date} AND day <= {to:Date}
      GROUP BY day`,
    { from: dayKey(first), to: dayKey(last) },
  );
  return new Map(rows.map((r) => [r.day_text, Number(r.version)]));
}

/**
 * When the first pool activity closed (unix seconds): the close time of the ledger of the oldest touch in `amm_pool_touches`
 * (the first row of its primary key), none while there is no touch or its ledger is not committed. The back-fill starts at the
 * day of it: the days before the first pool have nothing to say.
 */
export async function ammFirstDay(ch: ClickHouseService): Promise<number | undefined> {
  const row = await ch.queryOne<{ closed: Counted }>(
    `SELECT toUnixTimestamp(close_time) AS closed
       FROM ${Table.Ledgers}
      WHERE ledger_index = (SELECT ledger_index FROM ${Table.AmmPoolTouches} ORDER BY ledger_index ASC LIMIT 1)`,
  );
  return row === undefined ? undefined : Number(row.closed);
}
