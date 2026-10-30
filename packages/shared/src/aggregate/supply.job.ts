import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { MINT_PARSER_VERSION, NetworkSupplyRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { firstCommittedLedger } from '../ingest/ingest-state';
import { NetworkProfile } from '../network/network-profile';
import { coverageFrom } from '../query/parser-coverage';
import { mintSlices, MintSums, mintSums } from '../query/supply';
import { chunk } from '../util/helpers';
import { feesOfSetFee } from '../util/set-fee';
import { nextSetVersion, throwIfSetAborted } from './aggregate-sets';
import {
  AMM_FILL_WINDOW_LEDGERS,
  AMM_POOLS_CHUNK,
  committedHead,
  fillForward,
  FillForwardQuery,
  poolsChangedSince,
} from './amm-pools.job';
import { readEscrowed } from './escrows.job';
import {
  AccountRange,
  burnedFromCap,
  nativeReserveDrops,
  nativeSideReserve,
  PoolReserves,
  supplyAccountRanges,
} from './supply';

/**
 * A supply cycle (spec 2026-10-24-supply-design.md, 4.1 to 4.4): the start, which takes the reads of the first tick (they must be
 * taken at the tick L is chosen) and plans the steps that the later ticks work through; the steps (`runSupplyStep`: the account
 * ranges, the AMM fill-forwards, the burned and minted slices of a network that mints); and the row they add up to
 * (`supplySnapshotRow`, `writeSupplySnapshot`). The runner that spreads the steps over ticks is `apps/syncer`'s. The start and the
 * steps write nothing; the one write is the snapshot's.
 *
 *  - **L** is the `through_ledger` of the escrows sentinel, and a cycle starts at it only when the sentinel exists (and says a
 *    ledger), the committed head is no more than `SUPPLY_MAX_LAG_LEDGERS` ahead of it, and the `ledgers` row of L is stored. During
 *    a first fill or a rebuild of the escrows job L is millions of ledgers behind the head while the reads of the current state are
 *    at the head, and a step of the escrows job can land in a gap of the index: the answer is then `{ waiting: 'escrows' }`, not an
 *    error. The checks are done in the order that costs least, each a read by the end of a key.
 *  - **The AMM** (XRPL) is not waited for with `ammPoolsWatermark`, a scan of every touch of every pool that races the AMM job
 *    against the escrows job and never passes a pool the AMM job has set aside (ruling C5). The caller lends the `amm_pools` runner's
 *    in-memory cursor C and its set-aside pools (`SupplyAmmSight`). The newest `amm_pools` row of every pool is read, and the pools
 *    that are stale at L are found from the touches: a pool stale at L has a touch in `(min(C, L), L]` that its row has not seen,
 *    because the runner has rebuilt every pool touched up to C, except a pool it has set aside. Those pools, together with the pools
 *    whose row is past L, are filled forward at L in steps (`amm`); filling forward a pool that was only stale past L is harmless.
 *    The set-aside pools are not: they are counted at their stored row (a pool with none counts nothing), and listed, for the
 *    caller to warn about; they are pool accounts whether or not they have a row, since the runner's cursor goes past them. So the
 *    sum is exact except for a set-aside pool, whose AMM pages show the same stored state, and for a pool that a re-ingest of
 *    ledgers made stale below the cursor, which counts at its stored row until `agg_dirty` rebuilds it (a snapshot that a re-ingest
 *    leaves off is the case spec 4.5 tolerates; the next cycle is right again). The only wait is for the runner's first cursor.
 *  - **A row of a pool never stalls the cycle**: a native reserve that is not a whole number of drops, or that is NULL, counts as 0
 *    and the pool is listed (`poolsAtZero`).
 */

/** How often a cycle starts: when the newest snapshot's `started_at` is this far back (or there is none). */
export const SUPPLY_INTERVAL_MS = 3_600_000;

/** How many ticks a start may wait before the job warns (once). */
export const SUPPLY_START_WAIT_TICKS = 10;

/**
 * How many ledgers the committed head may be ahead of the escrows sentinel for a cycle to start at it. A cycle reads the current
 * state at the head, and the escrows it adds up to are as of L: further apart than this the escrows job is still filling.
 */
export const SUPPLY_MAX_LAG_LEDGERS = 1_000;

/**
 * The page of `poolsChangedSince` the start asks for: far above the number of pools (about 15,000 on XRPL), so that the answer is
 * one page. A page that is cut is followed (`stalePoolsUpTo`), so the limit bounds a read, never the answer.
 */
export const SUPPLY_AMM_TOUCHED_LIMIT = 100_000;

/** A step of a cycle. The kinds that a network has no use for are not in its plan. */
export type SupplyStep =
  | { kind: 'accounts'; range: AccountRange }
  /** At most `AMM_POOLS_CHUNK` pools to fill forward at L. */
  | { kind: 'amm'; pools: readonly string[] }
  /** The fees paid in the ledgers `[from, to]` (one slice of `mintSlices`): `hasMinting` networks only. */
  | { kind: 'burned'; from: number; to: number }
  /** The drops minted in the ledgers `[from, to]` (one slice of `mintSlices`): `hasMinting` networks only. */
  | { kind: 'minted'; from: number; to: number };

/** What the `amm_pools` runner lends the start: its in-memory cursor (`undefined` before its first run) and the pools it has set aside. */
export interface SupplyAmmSight {
  cursor: number | undefined;
  setAside: readonly string[];
}

export interface SupplyCycle {
  /** L, its close time (unix seconds) and the unix seconds the cycle began. */
  ledger: number;
  closeTime: number;
  startedAt: number;
  /** `total_coins` of L. */
  totalCoins: bigint;
  /** The drops in open native escrows and how many there are, as of L (the sentinel). */
  escrowed: bigint;
  escrowCount: number;
  /** The reserve values in force at L, `null` when neither `network_state` nor a `SetFee` says. */
  reserveBase: bigint | null;
  reserveInc: bigint | null;
  /**
   * Every pool account, sorted: the accounts the reserves leave out. A pool with no `amm_pools` row yet is in it (a touched one,
   * or a set-aside one), so is a set-aside pool whatever its touches.
   */
  poolAccounts: readonly string[];
  /** The native drops in the pools so far, and how many pools hold any: `null` and 0 when the network has no AMM. */
  amm: bigint | null;
  ammPools: number;
  /**
   * The pools the runner has set aside, sorted, counted at their stored row, or at nothing when they have none (the caller logs
   * one warning naming them).
   */
  poolsAtStoredRow: readonly string[];
  /** The pools counted as 0 because their native reserve is NULL or is not a whole number of drops (the caller logs them). */
  poolsAtZero: readonly string[];
  /** Account and owner count of the existing accounts so far. */
  accounts: bigint;
  ownerCount: bigint;
  /** The burned drops: `cap − total_coins` where the network cannot mint, else 0 until the burned steps have run. */
  burned: bigint;
  /** The minted drops by source so far (zeros), `null` where the network cannot mint. */
  minted: MintSums | null;
  /** The steps to do, in this order: accounts, amm, burned, minted. */
  pending: SupplyStep[];
  /** How many steps the plan had at the start. */
  steps: number;
}

export type SupplyStart = { cycle: SupplyCycle } | { waiting: 'escrows' | 'amm_pools' };

// ---------------------------------------------------------------------------------------------------------------------
// The choice of L
// ---------------------------------------------------------------------------------------------------------------------

/** The ledger L: by its key, one row. */
const LEDGER_SQL = `SELECT toUnixTimestamp(close_time) AS close_time, toString(total_coins) AS total_coins
  FROM ${Table.Ledgers}
 WHERE ledger_index = {ledger:UInt32}
 LIMIT 1`;

// ---------------------------------------------------------------------------------------------------------------------
// The reserve values
// ---------------------------------------------------------------------------------------------------------------------

/** The newest ledger of `network_state` at or before L: the end of a range of the key. */
const STATE_LEDGER_SQL = `SELECT ledger_index
  FROM ${Table.NetworkState}
 WHERE ledger_index <= {ledger:UInt32}
 ORDER BY ledger_index DESC
 LIMIT 1`;

/** The polls of that ledger by the key, of which the later is the one: a ledger polled twice is two rows until a merge. */
const STATE_RESERVES_SQL = `SELECT toString(reserve_base) AS base, toString(reserve_inc) AS inc
  FROM ${Table.NetworkState}
 WHERE ledger_index = {ledger:UInt32}
 ORDER BY polled_at DESC
 LIMIT 1`;

/** The newest `SetFee` at or before L, by the key of `tx_by_type` (the type first, so that the read is in order). */
const SET_FEE_SQL = `SELECT ledger_index, tx_index
  FROM ${Table.TxByType}
 WHERE tx_type = {type:String} AND ledger_index <= {ledger:UInt32}
 ORDER BY tx_type DESC, ledger_index DESC, tx_index DESC
 LIMIT 1`;

/** The transaction of a `tx_by_type` row, by the key of `transactions`. */
const TX_JSON_SQL = `SELECT tx_json
  FROM ${Table.Transactions}
 WHERE ledger_index = {ledger:UInt32} AND tx_index = {index:UInt32}
 LIMIT 1`;

interface Reserves {
  base: bigint | null;
  inc: bigint | null;
}

/**
 * The reserve values in force at `ledger`: the newest `network_state` row at or before it, else (the validators worker off, or
 * past the 100 days of the table) the fees of the newest `SetFee` at or before it (the reading of D1: `feesOfSetFee`), else none.
 *
 * Each lookup is a few granules: `network_state` in two reads, the newest ledger and then its polls, because one read, `ORDER BY
 * ledger_index DESC, polled_at DESC LIMIT 1`, cannot stop at the first row when `polled_at` is not in the key and reads the whole
 * part (as `newestSnapshot` found for `version`). `tx_by_type` is read in order, the type first, and `transactions` by its key.
 */
async function reservesAt(ch: ClickHouseService, ledger: number): Promise<Reserves> {
  const newest = await ch.queryOne<{ ledger_index: number }>(STATE_LEDGER_SQL, { ledger });
  const state =
    newest === undefined
      ? undefined
      : await ch.queryOne<{ base: string; inc: string }>(STATE_RESERVES_SQL, { ledger: newest.ledger_index });
  if (state !== undefined) return { base: BigInt(state.base), inc: BigInt(state.inc) };
  const setFee = await ch.queryOne<{ ledger_index: number; tx_index: number }>(SET_FEE_SQL, { type: 'SetFee', ledger });
  if (setFee === undefined) return { base: null, inc: null };
  const tx = await ch.queryOne<{ tx_json: string }>(TX_JSON_SQL, {
    ledger: setFee.ledger_index,
    index: setFee.tx_index,
  });
  const fees = tx === undefined ? undefined : feesOfSetFee(tx.tx_json);
  return fees === undefined
    ? { base: null, inc: null }
    : { base: BigInt(fees.reserve_base), inc: BigInt(fees.reserve_inc) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The AMM, part 1
// ---------------------------------------------------------------------------------------------------------------------

/** The newest row of every pool (about 15,000 rows on XRPL: the one full read of a start, which the spec names). */
const POOLS_SQL = `SELECT amm_account, base_currency, base_issuer, counter_currency, counter_issuer, last_ledger,
       reserve_base, reserve_counter, deleted
  FROM ${Table.AmmPools}
 ORDER BY amm_account, version DESC
 LIMIT 1 BY amm_account`;

interface PoolRow {
  amm_account: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  last_ledger: number | string;
  reserve_base: string | null;
  reserve_counter: string | null;
  /** A `UInt8`: 0 or 1. */
  deleted: number | string;
}

/**
 * The accounts of the pools with a touch in `(after, upTo]` that their `amm_pools` row has not seen, from `poolsChangedSince`: a
 * page of at most `limit` pools, and when the page is not complete up to `upTo`, the next from the ledger it is complete up to,
 * each page awaited before the next is asked for. It reads the touches above `after` up to the committed head, which may be
 * past `upTo`: a pool stale only past `upTo` is in the answer as well. Each pool once; the order is that of the pages.
 */
export async function stalePoolsUpTo(
  ch: ClickHouseService,
  after: number,
  upTo: number,
  limit: number,
  changedSince: typeof poolsChangedSince = poolsChangedSince,
): Promise<string[]> {
  const accounts = new Set<string>();
  for (let from = after; from < upTo; ) {
    const page = await changedSince(ch, from, limit);
    for (const account of page.accounts) accounts.add(account);
    if (page.upTo <= from)
      throw new Error(`stalePoolsUpTo: the page after ledger ${from} does not move on (${page.upTo})`);
    from = page.upTo;
  }
  return [...accounts];
}

interface AmmStart {
  amm: bigint;
  ammPools: number;
  poolAccounts: string[];
  poolsAtStoredRow: string[];
  poolsAtZero: string[];
  steps: SupplyStep[];
}

/**
 * A pool's native drops (from its stored row, or from its state filled forward to L), `null` when it cannot say: the native side's
 * reserve is NULL, or is not a whole number of drops. A deleted pool holds nothing whatever its reserve says.
 */
function readableNativeDrops(pool: PoolReserves, native: string): bigint | null {
  if (pool.deleted) return 0n;
  if (nativeSideReserve(pool, native) === null) return null;
  try {
    return nativeReserveDrops(pool, native);
  } catch {
    return null;
  }
}

/**
 * Part 1 of the AMM at L (spec 4.2) and the pools to fill forward: see the header. The newest row of every pool is read; the pools
 * whose row is at or before L and that no touch says stale add their native side now; the others become `amm` steps.
 */
async function ammStart(
  ch: ClickHouseService,
  native: string,
  ledger: number,
  cursor: number,
  setAside: readonly string[],
): Promise<AmmStart> {
  const rows = await ch.query<PoolRow>(POOLS_SQL);
  // the touches in (min(cursor, L), L]; a cursor at or past L leaves none to look for
  const touched = await stalePoolsUpTo(ch, cursor, ledger, SUPPLY_AMM_TOUCHED_LIMIT);

  // a set-aside pool is a pool of the cycle whether or not it has a row: the runner moves its cursor past a pool it sets aside, so
  // a pool that has failed from its first rebuild has no row and no touch above the cursor, and only the runner's list names it
  const poolAccounts = new Set([...rows.map((row) => row.amm_account), ...touched, ...setAside]);
  const fill = new Set(touched);
  for (const row of rows) if (Number(row.last_ledger) > ledger) fill.add(row.amm_account);
  for (const account of setAside) fill.delete(account);

  let amm = 0n;
  let ammPools = 0;
  const poolsAtZero: string[] = [];
  for (const row of rows) {
    if (fill.has(row.amm_account)) continue;
    const drops = readableNativeDrops({ ...row, deleted: Number(row.deleted) !== 0 }, native);
    if (drops === null) {
      poolsAtZero.push(row.amm_account);
      continue;
    }
    amm += drops;
    if (drops > 0n) ammPools++;
  }

  return {
    amm,
    ammPools,
    poolAccounts: [...poolAccounts].sort(),
    poolsAtStoredRow: [...new Set(setAside)].sort(),
    poolsAtZero,
    steps: chunk([...fill].sort(), AMM_POOLS_CHUNK).map((pools): SupplyStep => ({ kind: 'amm', pools })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The start
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Starts a cycle, or says what it waits for. See the header for L and the AMM. `startedAt` is the unix seconds of the tick.
 * `amm` is what the `amm_pools` runner lends; it is not used where the network has no AMM. Read failures throw: they are not waits.
 */
export async function startSupplyCycle(
  ch: ClickHouseService,
  profile: NetworkProfile,
  startedAt: number,
  amm?: SupplyAmmSight,
): Promise<SupplyStart> {
  const escrowed = await readEscrowed(ch);
  if (escrowed === undefined || escrowed.through_ledger <= 0) return { waiting: 'escrows' };
  const ledger = escrowed.through_ledger;
  if ((await committedHead(ch)) - ledger > SUPPLY_MAX_LAG_LEDGERS) return { waiting: 'escrows' };
  const stored = await ch.queryOne<{ close_time: number | string; total_coins: string }>(LEDGER_SQL, { ledger });
  if (stored === undefined) return { waiting: 'escrows' };
  const cursor = amm?.cursor;
  if (profile.hasAmm && cursor === undefined) return { waiting: 'amm_pools' };

  const totalCoins = BigInt(stored.total_coins);
  const reserves = await reservesAt(ch, ledger);
  const pools =
    profile.hasAmm && cursor !== undefined
      ? await ammStart(ch, profile.nativeCurrency, ledger, cursor, amm?.setAside ?? [])
      : undefined;

  const pending: SupplyStep[] = supplyAccountRanges().map((range): SupplyStep => ({ kind: 'accounts', range }));
  pending.push(...(pools?.steps ?? []));
  if (profile.hasMinting) {
    const first = await firstCommittedLedger(ch);
    const mintFrom = await coverageFrom(ch, MINT_PARSER_VERSION);
    if (first === undefined || mintFrom === null) throw new Error('supply: no ledger is stored');
    for (const [from, to] of mintSlices(first, ledger)) pending.push({ kind: 'burned', from, to });
    for (const [from, to] of mintSlices(mintFrom, ledger)) pending.push({ kind: 'minted', from, to });
  }

  return {
    cycle: {
      ledger,
      closeTime: Number(stored.close_time),
      startedAt,
      totalCoins,
      escrowed: BigInt(escrowed.drops),
      escrowCount: escrowed.open,
      reserveBase: reserves.base,
      reserveInc: reserves.inc,
      poolAccounts: pools?.poolAccounts ?? [],
      amm: pools === undefined ? null : pools.amm,
      ammPools: pools?.ammPools ?? 0,
      poolsAtStoredRow: pools?.poolsAtStoredRow ?? [],
      poolsAtZero: pools?.poolsAtZero ?? [],
      accounts: 0n,
      ownerCount: 0n,
      burned: profile.hasMinting ? 0n : burnedFromCap(totalCoins),
      minted: profile.hasMinting ? { rewards: 0n, import: 0n, genesis_mint: 0n } : null,
      pending,
      steps: pending.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One account range (spec 4.3): the existing accounts of `[lo, hi)` at L and their owner counts, the pool accounts left out. The
 * state of an account at L is its newest row at or before L (`argMax` over the key's place); a row written twice gives the same
 * state. `account >= lo AND account < hi` is a range of the primary key `(account, ledger_index, tx_index, node_index)`, and the read
 * never touches `fields`. A plain `GROUP BY`: the spec's `optimize_aggregation_in_order` is not set, because on ClickHouse 26.8 it
 * needs several times the memory of the hash aggregation and more with every part (spec 4.3, amendment of the Task 7 fix round).
 * Exported for the test that pins the key condition.
 */
export const SUPPLY_ACCOUNTS_SQL = `SELECT toString(count()) AS accounts, toString(sum(s.1)) AS owner_count
FROM (SELECT account, argMax(tuple(owner_count, deleted), (ledger_index, tx_index, node_index)) AS s
        FROM ${Table.AccountStates}
       WHERE account >= {lo:String} AND account < {hi:String} AND ledger_index <= {L:UInt32}
       GROUP BY account)
WHERE s.2 = 0 AND NOT has({pools:Array(String)}, account)`;

/**
 * The fees paid in the ledgers of one slice (spec 4.4, Xahau). The inner select keeps the first row of each ledger (the table can
 * hold a row twice until a merge), in key order, so that the read is the slice's rows of the one table.
 */
const BURNED_SQL = `SELECT toString(sum(fee_total)) AS burned
FROM (SELECT fee_total FROM ${Table.Ledgers}
       WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}
       ORDER BY ledger_index LIMIT 1 BY ledger_index)`;

/** What an `amm` step fills forward: both reserves, and a window is taken for the whole history only when both have a value in it. */
const AMM_FILL_QUERY: FillForwardQuery = {
  fields: ['reserve_base', 'reserve_counter'],
  required: ['filled_reserve_base', 'filled_reserve_counter'],
};

interface PoolFill {
  filled_reserve_base: string | null;
  filled_reserve_counter: string | null;
}

async function accountsStep(
  ch: ClickHouseService,
  cycle: SupplyCycle,
  range: AccountRange,
): Promise<Partial<SupplyCycle>> {
  // only the pool accounts of the range go out: about 140 of 15,000, never the list (a request carries at most 128 KiB)
  const pools = cycle.poolAccounts.filter((account) => account >= range.lo && account < range.hi);
  const [row] = await ch.query<{ accounts: string; owner_count: string }>(SUPPLY_ACCOUNTS_SQL, {
    lo: range.lo,
    hi: range.hi,
    L: cycle.ledger,
    pools,
  });
  if (row === undefined) throw new Error(`supply: the read of the accounts from ${range.lo} answered no row`);
  return { accounts: cycle.accounts + BigInt(row.accounts), ownerCount: cycle.ownerCount + BigInt(row.owner_count) };
}

async function ammStep(
  ch: ClickHouseService,
  profile: NetworkProfile,
  cycle: SupplyCycle,
  pools: readonly string[],
): Promise<Partial<SupplyCycle>> {
  if (cycle.amm === null) throw new Error('supply: an amm step for a cycle without an AMM');
  // the state of each pool at L: its newest rows up to L, a window of ledgers back and, for a pool the window leaves incomplete,
  // as far back as its values go. A pool with no row at or before L is not in the answer: it holds nothing at L.
  const rows = await fillForward<PoolFill>(
    ch,
    [...pools],
    cycle.ledger,
    cycle.ledger - AMM_FILL_WINDOW_LEDGERS,
    AMM_FILL_QUERY,
  );
  let amm = cycle.amm;
  let ammPools = cycle.ammPools;
  const unreadable: string[] = [];
  for (const row of rows) {
    const drops = readableNativeDrops(
      {
        base_currency: row.asset_base_currency,
        base_issuer: row.asset_base_issuer,
        counter_currency: row.asset_counter_currency,
        counter_issuer: row.asset_counter_issuer,
        reserve_base: row.filled_reserve_base,
        reserve_counter: row.filled_reserve_counter,
        deleted: Number(row.newest_deleted) !== 0,
      },
      profile.nativeCurrency,
    );
    if (drops === null) {
      unreadable.push(row.amm_account);
      continue;
    }
    amm += drops;
    if (drops > 0n) ammPools++;
  }
  return { amm, ammPools, poolsAtZero: [...cycle.poolsAtZero, ...unreadable].sort() };
}

async function burnedStep(
  ch: ClickHouseService,
  cycle: SupplyCycle,
  from: number,
  to: number,
): Promise<Partial<SupplyCycle>> {
  const [row] = await ch.query<{ burned: string }>(BURNED_SQL, { from, to });
  if (row === undefined)
    throw new Error(`supply: the read of the fees of the ledgers ${from} to ${to} answered no row`);
  return { burned: cycle.burned + BigInt(row.burned) };
}

async function mintedStep(
  ch: ClickHouseService,
  cycle: SupplyCycle,
  from: number,
  to: number,
): Promise<Partial<SupplyCycle>> {
  if (cycle.minted === null) throw new Error('supply: a minted step for a cycle that does not mint');
  const sums = await mintSums(ch, from, to, false);
  return {
    minted: {
      rewards: cycle.minted.rewards + sums.rewards,
      import: cycle.minted.import + sums.import,
      genesis_mint: cycle.minted.genesis_mint + sums.genesis_mint,
    },
  };
}

function resultOf(
  ch: ClickHouseService,
  profile: NetworkProfile,
  cycle: SupplyCycle,
  step: SupplyStep,
): Promise<Partial<SupplyCycle>> {
  switch (step.kind) {
    case 'accounts':
      return accountsStep(ch, cycle, step.range);
    case 'amm':
      return ammStep(ch, profile, cycle, step.pools);
    case 'burned':
      return burnedStep(ch, cycle, step.from, step.to);
    case 'minted':
      return mintedStep(ch, cycle, step.from, step.to);
  }
}

/**
 * Runs the step at the front of the plan and returns the cycle with its result added and the step off the plan. The cycle it is
 * given is not changed, so that a step that throws (a read that fails: the caller counts it) leaves the cycle where it was and
 * can be run again as it was. `steps`, how many steps the plan had at the start, stays as the start made it.
 */
export async function runSupplyStep(
  ch: ClickHouseService,
  profile: NetworkProfile,
  cycle: SupplyCycle,
): Promise<SupplyCycle> {
  const step = cycle.pending[0];
  if (step === undefined) throw new Error('supply: no step is left to run');
  const result = await resultOf(ch, profile, cycle, step);
  return { ...cycle, ...result, pending: cycle.pending.slice(1) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------------------------------------------------

/** A drops figure as the decimal text a `UInt64` column is written and read as; `null` stays `NULL`. */
const dropsText = (value: bigint | null): string | null => (value === null ? null : value.toString());

/**
 * The `network_supply` row of a finished cycle (spec 1.4), in the columns' order. Every `UInt64` is a decimal string (no value
 * passes through a float), the times are unix seconds. `amm`, the reserve values and the three `minted_*` are `NULL` where the
 * cycle has none (a network without an AMM or without minting, no reserve value known at L). The reserves themselves are not a
 * column: the api computes them from the accounts, the owner count and the two reserve values.
 */
export function supplySnapshotRow(cycle: SupplyCycle, computedAt: number, version: number): NetworkSupplyRow {
  return {
    ledger_index: cycle.ledger,
    close_time: cycle.closeTime,
    started_at: cycle.startedAt,
    computed_at: computedAt,
    total_coins: cycle.totalCoins.toString(),
    burned: cycle.burned.toString(),
    escrowed: cycle.escrowed.toString(),
    escrow_count: String(cycle.escrowCount),
    amm: dropsText(cycle.amm),
    amm_pools: cycle.ammPools,
    reserve_base: dropsText(cycle.reserveBase),
    reserve_inc: dropsText(cycle.reserveInc),
    accounts: cycle.accounts.toString(),
    owner_count: cycle.ownerCount.toString(),
    minted_rewards: dropsText(cycle.minted?.rewards ?? null),
    minted_import: dropsText(cycle.minted?.import ?? null),
    minted_genesis: dropsText(cycle.minted?.genesis_mint ?? null),
    version: String(version),
  };
}

/**
 * Writes the snapshot of a cycle whose steps are all done, in one insert, under a version above the clock and above the newest
 * snapshot of the same ledger (a cycle redone at one ledger is a newer version of its key). A cycle with steps left throws, with
 * nothing read and nothing written: its sums are partial. An aborted `signal` is checked before the work and again just before the
 * insert: nothing is written after it, and the call throws `AggregateSetAborted`. Returns the row it wrote.
 */
export async function writeSupplySnapshot(
  ch: ClickHouseService,
  cycle: SupplyCycle,
  computedAt: number,
  signal?: AbortSignal,
): Promise<NetworkSupplyRow> {
  throwIfSetAborted(signal);
  if (cycle.pending.length > 0) {
    throw new Error(`supply: the cycle at ledger ${cycle.ledger} still has ${cycle.pending.length} steps to run`);
  }
  const version = await nextSetVersion(ch, Table.NetworkSupply, 'ledger_index = {l:UInt32}', { l: cycle.ledger });
  const row = supplySnapshotRow(cycle, computedAt, version);
  throwIfSetAborted(signal);
  await ch.insert(Table.NetworkSupply, [row]);
  return row;
}

/**
 * A whole cycle in a row: the start, every step and the write. For tests, and nothing else: the job spreads the steps over ticks.
 * Answers what the start waits for when it cannot start (and writes nothing). `amm` is what the `amm_pools` runner lends.
 */
export async function computeSupplyCycle(
  ch: ClickHouseService,
  profile: NetworkProfile,
  startedAt: number,
  computedAt: number,
  amm?: SupplyAmmSight,
): Promise<NetworkSupplyRow | SupplyStart> {
  const started = await startSupplyCycle(ch, profile, startedAt, amm);
  if (!('cycle' in started)) return started;
  let cycle = started.cycle;
  while (cycle.pending.length > 0) cycle = await runSupplyStep(ch, profile, cycle);
  return writeSupplySnapshot(ch, cycle, computedAt);
}
