import { RIPPLE_EPOCH_MS } from '@gatehub/data-api-shared';
import { fmtTime, precision8 } from '../common/format';

/**
 * The objects of the AMM pool routes: `Pool` (`/v2/amm/pools` and `/v2/amm/pools/:pool`), `PoolState` (the history of a
 * pool) and `PoolDay` (its history with `interval=day`). There is no Ripple contract for them, so the shape is ours
 * (Ruling R-A24), written down here once and pinned by the tests.
 *
 * Keys are flat, in the style of the exchange objects: `base_currency`, `base_issuer`, `counter_currency`,
 * `counter_issuer`, never an asset object. The pair is the pool's own, in the canonical order the pool is stored in, and the
 * issuer of the native currency has no key. Amounts are the exact strings stored; `value_native` is a string too, eight
 * significant digits (`precision8`, as a rate is: a value of 1e8 or more is therefore written in exponent form, as in
 * `1.2345679e+8`). Counts, ledger indexes and `trading_fee` (units of 1/100000, as stored)
 * are numbers; times are `fmtTime` (`YYYY-MM-DDTHH:mm:ssZ`). A key that is undefined or null is left out, and `deleted` is
 * a boolean that every pool and state has. The auction slot is grouped, `auction_slot: {holder, price, discounted_fee,
 * expiration}` (the expiration a time, converted from Ripple seconds), and left out when the pool has no slot.
 *
 * Pool, in this order:
 *   amm_account, base_currency, base_issuer?, counter_currency, counter_issuer?, reserve_base?, reserve_counter?, lp_supply?,
 *   lp_currency?, trading_fee?, auction_slot?, value_native?, created_ledger?, created_by?, last_ledger, deleted
 *
 * PoolState (the pool after one transaction; every value carried forward from the newest earlier state that had one), in
 * this order:
 *   amm_account, ledger_index, tx_index, tx_hash, tx_type, executed_time, base_currency, base_issuer?, counter_currency,
 *   counter_issuer?, reserve_base?, reserve_counter?, lp_supply?, lp_currency?, trading_fee?, auction_slot?, deleted
 *
 * PoolDay (a UTC day with activity and the closing state of the pool; `date` is the start of the day), in this order:
 *   amm_account, date, base_currency, base_issuer?, counter_currency, counter_issuer?, swap_count, volume_base,
 *   volume_counter, fees_base_est, fees_counter_est, deposit_count, withdraw_count, liquidity_in_base, liquidity_in_counter,
 *   liquidity_out_base, liquidity_out_counter, reserve_base?, reserve_counter?, lp_supply?, trading_fee?, value_native?
 *
 * `volume_*` are the amounts that went into the pool by side and `fees_*_est` are estimates (spec section 3).
 *
 * A CSV has the same columns on every page whatever the objects of the page hold (a CSV takes its columns from the keys of
 * the rows, and a key that is left out would move them): the `*CsvRow` functions give every column, `null` (an empty cell)
 * where the object has none, and the slot always as its four columns.
 */

/** A count as ClickHouse hands it over: a number or, depending on the settings of the client, the text of its digits. */
type Count = number | string;

/** The ripple epoch (2000-01-01) in unix seconds. */
const RIPPLE_EPOCH_SECONDS = RIPPLE_EPOCH_MS / 1000;

// -- columns -------------------------------------------------------------------------------------------------------

/** The columns of `amm_pools` that a pool is made of (not `version`: the reads order by it). */
export const POOL_COLUMNS = [
  'amm_account',
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'lp_currency',
  'created_ledger',
  'created_by',
  'last_ledger',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'trading_fee',
  'auction_holder',
  'auction_price',
  'auction_discounted_fee',
  'auction_expiration',
  'deleted',
  'value_native',
].join(', ');

/** The columns of `amm_pool_states` that a state is made of; the close time as unix seconds. */
export const POOL_STATE_COLUMNS = [
  'ledger_index',
  'tx_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'tx_type',
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'lp_currency',
  'trading_fee',
  'auction_holder',
  'auction_price',
  'auction_discounted_fee',
  'auction_expiration',
  'deleted',
].join(', ');

/** The columns of `amm_daily` that a day is made of: neither the sentinel flag, the config version nor the version. */
export const POOL_DAY_COLUMNS = [
  'day',
  'base_currency',
  'base_issuer',
  'counter_currency',
  'counter_issuer',
  'swap_count',
  'volume_base',
  'volume_counter',
  'fees_base_est',
  'fees_counter_est',
  'deposit_count',
  'withdraw_count',
  'liquidity_in_base',
  'liquidity_in_counter',
  'liquidity_out_base',
  'liquidity_out_counter',
  'reserve_base',
  'reserve_counter',
  'lp_supply',
  'trading_fee',
  'value_native',
].join(', ');

// -- stored rows ---------------------------------------------------------------------------------------------------

/** A row of `amm_pools` as `POOL_COLUMNS` reads it. */
export interface StoredPool {
  amm_account: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  lp_currency: string | null;
  created_ledger: Count | null;
  created_by: string | null;
  last_ledger: Count;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  trading_fee: Count | null;
  auction_holder: string | null;
  auction_price: string | null;
  auction_discounted_fee: Count | null;
  auction_expiration: Count | null;
  deleted: Count;
  value_native: number | null;
}

/** A row of `amm_pool_states` as `POOL_STATE_COLUMNS` reads it, with every value already carried forward. */
export interface StoredPoolState {
  ledger_index: Count;
  tx_index: Count;
  tx_hash: string;
  /** Unix seconds. */
  close_time: Count;
  tx_type: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  lp_currency: string | null;
  trading_fee: Count | null;
  auction_holder: string | null;
  auction_price: string | null;
  auction_discounted_fee: Count | null;
  auction_expiration: Count | null;
  deleted: Count;
}

/** A row of `amm_daily` as `POOL_DAY_COLUMNS` reads it (`day` as `YYYY-MM-DD`, the UInt64 counts maybe as text). */
export interface StoredPoolDay {
  day: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  swap_count: Count;
  volume_base: string;
  volume_counter: string;
  fees_base_est: string;
  fees_counter_est: string;
  deposit_count: Count;
  withdraw_count: Count;
  liquidity_in_base: string;
  liquidity_in_counter: string;
  liquidity_out_base: string;
  liquidity_out_counter: string;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  trading_fee: Count | null;
  value_native: number | null;
}

// -- objects -------------------------------------------------------------------------------------------------------

export interface AuctionSlotObject {
  holder?: string;
  price?: string;
  discounted_fee?: number;
  /** `YYYY-MM-DDTHH:mm:ssZ`. */
  expiration?: string;
}

export interface PoolObject {
  amm_account: string;
  base_currency: string;
  base_issuer?: string;
  counter_currency: string;
  counter_issuer?: string;
  reserve_base?: string;
  reserve_counter?: string;
  lp_supply?: string;
  lp_currency?: string;
  trading_fee?: number;
  auction_slot?: AuctionSlotObject;
  value_native?: string;
  created_ledger?: number;
  created_by?: string;
  last_ledger: number;
  deleted: boolean;
}

export interface PoolStateObject {
  amm_account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  tx_type: string;
  executed_time: string;
  base_currency: string;
  base_issuer?: string;
  counter_currency: string;
  counter_issuer?: string;
  reserve_base?: string;
  reserve_counter?: string;
  lp_supply?: string;
  lp_currency?: string;
  trading_fee?: number;
  auction_slot?: AuctionSlotObject;
  deleted: boolean;
}

export interface PoolDayObject {
  amm_account: string;
  date: string;
  base_currency: string;
  base_issuer?: string;
  counter_currency: string;
  counter_issuer?: string;
  swap_count: number;
  volume_base: string;
  volume_counter: string;
  fees_base_est: string;
  fees_counter_est: string;
  deposit_count: number;
  withdraw_count: number;
  liquidity_in_base: string;
  liquidity_in_counter: string;
  liquidity_out_base: string;
  liquidity_out_counter: string;
  reserve_base?: string;
  reserve_counter?: string;
  lp_supply?: string;
  trading_fee?: number;
  value_native?: string;
}

/** `null` and `undefined` are the same here: nothing (the key is left out). */
const present = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

/** A number from a count that may have come as text. */
const num = (value: Count): number => Number(value);

/** The key and value, or nothing when the value is none: for spreading into an object. */
function key<K extends string, V>(name: K, value: V | null | undefined): Partial<Record<K, V>> {
  return present(value) ? ({ [name]: value } as Record<K, V>) : {};
}

/** The key with the number of a count, or nothing. */
function countKey<K extends string>(name: K, value: Count | null | undefined): Partial<Record<K, number>> {
  return present(value) ? ({ [name]: num(value) } as Record<K, number>) : {};
}

/** The key of an issuer: the native currency's is stored as '' and has no key. */
function issuerKey<K extends string>(name: K, issuer: string): Partial<Record<K, string>> {
  return issuer !== '' ? ({ [name]: issuer } as Record<K, string>) : {};
}

/**
 * The auction slot, grouped, or nothing when there is none (no part of it is known). The expiration is stored in Ripple
 * seconds. A part the slot lacks has no key.
 */
function slotOf(v: {
  auction_holder: string | null;
  auction_price: string | null;
  auction_discounted_fee: Count | null;
  auction_expiration: Count | null;
}): { auction_slot?: AuctionSlotObject } {
  const slot: AuctionSlotObject = {
    ...key('holder', v.auction_holder),
    ...key('price', v.auction_price),
    ...countKey('discounted_fee', v.auction_discounted_fee),
    ...(present(v.auction_expiration) && { expiration: fmtTime(RIPPLE_EPOCH_SECONDS + num(v.auction_expiration)) }),
  };
  return Object.keys(slot).length > 0 ? { auction_slot: slot } : {};
}

/** The value of a pool in the native currency: eight significant digits, as a string. */
const valueOf = (value: number | null | undefined): { value_native?: string } =>
  present(value) ? { value_native: precision8(value) } : {};

/** The Pool of a row of `amm_pools`. */
export function toPoolObject(row: StoredPool): PoolObject {
  return {
    amm_account: row.amm_account,
    base_currency: row.base_currency,
    ...issuerKey('base_issuer', row.base_issuer),
    counter_currency: row.counter_currency,
    ...issuerKey('counter_issuer', row.counter_issuer),
    ...key('reserve_base', row.reserve_base),
    ...key('reserve_counter', row.reserve_counter),
    ...key('lp_supply', row.lp_supply),
    ...key('lp_currency', row.lp_currency),
    ...countKey('trading_fee', row.trading_fee),
    ...slotOf(row),
    ...valueOf(row.value_native),
    ...countKey('created_ledger', row.created_ledger),
    ...key('created_by', row.created_by),
    last_ledger: num(row.last_ledger),
    deleted: num(row.deleted) === 1,
  };
}

/** The PoolState of a row of `amm_pool_states` whose values are already carried forward. `account` is the pool. */
export function toPoolStateObject(account: string, row: StoredPoolState): PoolStateObject {
  return {
    amm_account: account,
    ledger_index: num(row.ledger_index),
    tx_index: num(row.tx_index),
    tx_hash: row.tx_hash,
    tx_type: row.tx_type,
    executed_time: fmtTime(num(row.close_time)),
    base_currency: row.base_currency,
    ...issuerKey('base_issuer', row.base_issuer),
    counter_currency: row.counter_currency,
    ...issuerKey('counter_issuer', row.counter_issuer),
    ...key('reserve_base', row.reserve_base),
    ...key('reserve_counter', row.reserve_counter),
    ...key('lp_supply', row.lp_supply),
    ...key('lp_currency', row.lp_currency),
    ...countKey('trading_fee', row.trading_fee),
    ...slotOf(row),
    deleted: num(row.deleted) === 1,
  };
}

/** The PoolDay of a row of `amm_daily`. `account` is the pool. */
export function toPoolDayObject(account: string, row: StoredPoolDay): PoolDayObject {
  return {
    amm_account: account,
    date: fmtTime(Date.parse(`${row.day}T00:00:00Z`) / 1000),
    base_currency: row.base_currency,
    ...issuerKey('base_issuer', row.base_issuer),
    counter_currency: row.counter_currency,
    ...issuerKey('counter_issuer', row.counter_issuer),
    swap_count: num(row.swap_count),
    volume_base: row.volume_base,
    volume_counter: row.volume_counter,
    fees_base_est: row.fees_base_est,
    fees_counter_est: row.fees_counter_est,
    deposit_count: num(row.deposit_count),
    withdraw_count: num(row.withdraw_count),
    liquidity_in_base: row.liquidity_in_base,
    liquidity_in_counter: row.liquidity_in_counter,
    liquidity_out_base: row.liquidity_out_base,
    liquidity_out_counter: row.liquidity_out_counter,
    ...key('reserve_base', row.reserve_base),
    ...key('reserve_counter', row.reserve_counter),
    ...key('lp_supply', row.lp_supply),
    ...countKey('trading_fee', row.trading_fee),
    ...valueOf(row.value_native),
  };
}

// -- CSV -----------------------------------------------------------------------------------------------------------

/** The four columns of the slot, always: `null` for a part the pool has none of. */
interface SlotCsv {
  holder: string | null;
  price: string | null;
  discounted_fee: number | null;
  expiration: string | null;
}

const slotCsv = (slot: AuctionSlotObject | undefined): SlotCsv => ({
  holder: slot?.holder ?? null,
  price: slot?.price ?? null,
  discounted_fee: slot?.discounted_fee ?? null,
  expiration: slot?.expiration ?? null,
});

/** The pair of an object: all four columns, the issuers `null` for the native currency. */
const pairCsv = (o: {
  base_issuer?: string;
  counter_issuer?: string;
  base_currency: string;
  counter_currency: string;
}) => ({
  base_currency: o.base_currency,
  base_issuer: o.base_issuer ?? null,
  counter_currency: o.counter_currency,
  counter_issuer: o.counter_issuer ?? null,
});

export interface PoolCsvRow {
  amm_account: string;
  base_currency: string;
  base_issuer: string | null;
  counter_currency: string;
  counter_issuer: string | null;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  lp_currency: string | null;
  trading_fee: number | null;
  auction_slot: SlotCsv;
  value_native: string | null;
  created_ledger: number | null;
  created_by: string | null;
  last_ledger: number;
  deleted: boolean;
}

/** The pool as a row of the CSV: every column, in the pinned order. */
export function toPoolCsvRow(pool: PoolObject): PoolCsvRow {
  return {
    amm_account: pool.amm_account,
    ...pairCsv(pool),
    reserve_base: pool.reserve_base ?? null,
    reserve_counter: pool.reserve_counter ?? null,
    lp_supply: pool.lp_supply ?? null,
    lp_currency: pool.lp_currency ?? null,
    trading_fee: pool.trading_fee ?? null,
    auction_slot: slotCsv(pool.auction_slot),
    value_native: pool.value_native ?? null,
    created_ledger: pool.created_ledger ?? null,
    created_by: pool.created_by ?? null,
    last_ledger: pool.last_ledger,
    deleted: pool.deleted,
  };
}

export interface PoolStateCsvRow {
  amm_account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  tx_type: string;
  executed_time: string;
  base_currency: string;
  base_issuer: string | null;
  counter_currency: string;
  counter_issuer: string | null;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  lp_currency: string | null;
  trading_fee: number | null;
  auction_slot: SlotCsv;
  deleted: boolean;
}

/** The state as a row of the CSV: every column, in the pinned order. */
export function toPoolStateCsvRow(state: PoolStateObject): PoolStateCsvRow {
  return {
    amm_account: state.amm_account,
    ledger_index: state.ledger_index,
    tx_index: state.tx_index,
    tx_hash: state.tx_hash,
    tx_type: state.tx_type,
    executed_time: state.executed_time,
    ...pairCsv(state),
    reserve_base: state.reserve_base ?? null,
    reserve_counter: state.reserve_counter ?? null,
    lp_supply: state.lp_supply ?? null,
    lp_currency: state.lp_currency ?? null,
    trading_fee: state.trading_fee ?? null,
    auction_slot: slotCsv(state.auction_slot),
    deleted: state.deleted,
  };
}

export interface PoolDayCsvRow {
  amm_account: string;
  date: string;
  base_currency: string;
  base_issuer: string | null;
  counter_currency: string;
  counter_issuer: string | null;
  swap_count: number;
  volume_base: string;
  volume_counter: string;
  fees_base_est: string;
  fees_counter_est: string;
  deposit_count: number;
  withdraw_count: number;
  liquidity_in_base: string;
  liquidity_in_counter: string;
  liquidity_out_base: string;
  liquidity_out_counter: string;
  reserve_base: string | null;
  reserve_counter: string | null;
  lp_supply: string | null;
  trading_fee: number | null;
  value_native: string | null;
}

/** The day as a row of the CSV: every column, in the pinned order. */
export function toPoolDayCsvRow(day: PoolDayObject): PoolDayCsvRow {
  return {
    amm_account: day.amm_account,
    date: day.date,
    ...pairCsv(day),
    swap_count: day.swap_count,
    volume_base: day.volume_base,
    volume_counter: day.volume_counter,
    fees_base_est: day.fees_base_est,
    fees_counter_est: day.fees_counter_est,
    deposit_count: day.deposit_count,
    withdraw_count: day.withdraw_count,
    liquidity_in_base: day.liquidity_in_base,
    liquidity_in_counter: day.liquidity_in_counter,
    liquidity_out_base: day.liquidity_out_base,
    liquidity_out_counter: day.liquidity_out_counter,
    reserve_base: day.reserve_base ?? null,
    reserve_counter: day.reserve_counter ?? null,
    lp_supply: day.lp_supply ?? null,
    trading_fee: day.trading_fee ?? null,
    value_native: day.value_native ?? null,
  };
}
