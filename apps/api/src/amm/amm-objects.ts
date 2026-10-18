import { RIPPLE_EPOCH_MS } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { fmtTime } from '../common/format';

/**
 * The objects of the AMM pool routes: `Pool` (`/v2/amm/pools` and `/v2/amm/pools/:pool`), `PoolState` (the history of a
 * pool) and `PoolDay` (its history with `interval=day`). There is no Ripple contract for them, so the shape is ours
 * (Ruling R-A24), written down here once and pinned by the tests.
 *
 * Keys are flat, in the style of the exchange objects: `base_currency`, `base_issuer`, `counter_currency`,
 * `counter_issuer`, never an asset object. The pair is the pool's own, in the canonical order the pool is stored in, and the
 * issuer of the native currency has no key. Amounts are the exact strings stored; `value_native` is a string too, a plain decimal
 * of eight significant digits with the trailing zeros dropped and never the exponent form (`valueText`: 123 is `"123"`,
 * 99999999.5 is `"100000000"`, 1e-7 is `"0.0000001"`; `precision8`, the text of a rate, would write `1.2345679e+8` from 1e8 up
 * and `1.0000000e-7` from 1e-7 down). Counts, ledger indexes and `trading_fee` (units of 1/100000, as stored)
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
 *   volume_counter, fees_base_est?, fees_counter_est?, deposit_count, withdraw_count, liquidity_in_base, liquidity_in_counter,
 *   liquidity_out_base, liquidity_out_counter, reserve_base?, reserve_counter?, lp_supply?, trading_fee?, value_native?
 *
 * `volume_*` are the amounts that went into the pool by side and `fees_*_est` are estimates (spec section 3); an estimate is
 * left out when a swap into its side had no known fee (Ruling R-A26), and an estimate of 0 is a known 0.
 *
 * A CSV has the same columns on every page whatever the objects of the page hold (a CSV takes its columns from the keys of
 * the rows, and a key that is left out would move them): the `*CsvRow` functions give every column, `null` (an empty cell)
 * where the object has none, and the slot always as its four columns.
 *
 * The objects of the event routes follow the same rules. They carry no pair: an amount is on the base or the counter of the
 * pool they name (`amm_account`), whose pair `GET /v2/amm/pools/:pool` gives.
 *
 * LiquidityEvent (`/pools/:pool/liquidity`, `/accounts/:address/amm_liquidity`; one create, deposit, withdraw, clawback or
 * delete; amounts signed from the pool's side, + into the pool; `lp_tokens` + minted, - burned; `account` is the liquidity
 * provider, `initiator` who sent the transaction; the `mode` of a deposit or withdrawal only), in this order:
 *   amm_account, ledger_index, tx_index, tx_hash, executed_time, account, initiator, event, mode?, base_amount,
 *   counter_amount, lp_tokens
 *
 * Vote (`/pools/:pool/governance`; `type` is `vote`), in this order:
 *   amm_account, ledger_index, tx_index, tx_hash, executed_time, type, account, fee_voted?, trading_fee_after?
 *
 * Bid (`type` is `bid`; `price_paid` the LP tokens the bid burned; `auction_slot` the slot after the bid, left out when the
 * row holds none of it, with `auth_accounts` always a list), in this order:
 *   amm_account, ledger_index, tx_index, tx_hash, executed_time, type, account, bid_min?, bid_max?, price_paid?,
 *   auction_slot? {holder?, discounted_fee?, expiration?, auth_accounts}
 *
 * Position (`/accounts/:address/amm_positions`) is in `amm-positions.ts`, with its key order and the rules of its numbers.
 *
 * The CSV of a vote or a bid has the columns of both kinds (the `auth_accounts` of the slot in one cell, separated by
 * semicolons); the CSV of a liquidity event has every column of the object, the mode empty where it has none.
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

/** The columns of `amm_liquidity` and `account_amm_liquidity` that a liquidity event is made of; the close time as unix seconds. */
export const LIQUIDITY_COLUMNS = [
  'amm_account',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'account',
  'initiator',
  'event',
  'mode',
  'base_amount',
  'counter_amount',
  'lp_tokens',
].join(', ');

/** The columns of `amm_governance` that a vote or a bid is made of; the close time as unix seconds. */
export const GOVERNANCE_COLUMNS = [
  'amm_account',
  'ledger_index',
  'tx_index',
  'tx_hash',
  'toUnixTimestamp(close_time) AS close_time',
  'kind',
  'account',
  'fee_voted',
  'trading_fee_after',
  'bid_min',
  'bid_max',
  'price_paid',
  'slot_holder',
  'slot_discounted_fee',
  'slot_expiration',
  'auth_accounts',
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
  /** Null when a swap into that side had no known fee (Ruling R-A26). */
  fees_base_est: string | null;
  fees_counter_est: string | null;
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

/** A row of `amm_liquidity` (or `account_amm_liquidity`) as `LIQUIDITY_COLUMNS` reads it. */
export interface StoredLiquidity {
  amm_account: string;
  ledger_index: Count;
  tx_index: Count;
  tx_hash: string;
  /** Unix seconds. */
  close_time: Count;
  account: string;
  initiator: string;
  event: string;
  /** `''` for an event that has no mode. */
  mode: string;
  base_amount: string;
  counter_amount: string;
  lp_tokens: string;
}

/** A row of `amm_governance` as `GOVERNANCE_COLUMNS` reads it. */
export interface StoredGovernance {
  amm_account: string;
  ledger_index: Count;
  tx_index: Count;
  tx_hash: string;
  /** Unix seconds. */
  close_time: Count;
  /** `vote` or `bid`. */
  kind: string;
  account: string;
  fee_voted: Count | null;
  trading_fee_after: Count | null;
  bid_min: string | null;
  bid_max: string | null;
  price_paid: string | null;
  slot_holder: string | null;
  slot_discounted_fee: Count | null;
  /** Ripple seconds. */
  slot_expiration: Count | null;
  auth_accounts: string[];
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
  fees_base_est?: string;
  fees_counter_est?: string;
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

export interface LiquidityObject {
  amm_account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  executed_time: string;
  account: string;
  initiator: string;
  event: string;
  mode?: string;
  base_amount: string;
  counter_amount: string;
  lp_tokens: string;
}

interface GovernanceHead {
  amm_account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  executed_time: string;
  account: string;
}

export interface VoteObject extends GovernanceHead {
  type: 'vote';
  fee_voted?: number;
  trading_fee_after?: number;
}

export interface BidSlotObject {
  holder?: string;
  discounted_fee?: number;
  /** `YYYY-MM-DDTHH:mm:ssZ`. */
  expiration?: string;
  auth_accounts: string[];
}

export interface BidObject extends GovernanceHead {
  type: 'bid';
  bid_min?: string;
  bid_max?: string;
  price_paid?: string;
  auction_slot?: BidSlotObject;
}

export type GovernanceObject = VoteObject | BidObject;

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

/**
 * The text of a value in the native currency: eight significant digits as a plain decimal. `toPrecision(8)` rounds, and writes
 * the exponent form when the exponent is 8 or more or -7 or less (also when the rounding carries 99999999.5 up to 1.0000000e+8);
 * a BigNumber made of that text writes it out with `toFixed()`, without the trailing zeros.
 */
function valueText(value: number): string {
  return new BigNumber(new BigNumber(value).toPrecision(8)).toFixed();
}

/** The value of a pool in the native currency, as its text. */
const valueOf = (value: number | null | undefined): { value_native?: string } =>
  present(value) ? { value_native: valueText(value) } : {};

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
    ...key('fees_base_est', row.fees_base_est),
    ...key('fees_counter_est', row.fees_counter_est),
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

/** The LiquidityObject of a row of `amm_liquidity`. `mode` is stored as `''` where the event has none. */
export function toLiquidityObject(row: StoredLiquidity): LiquidityObject {
  return {
    amm_account: row.amm_account,
    ledger_index: num(row.ledger_index),
    tx_index: num(row.tx_index),
    tx_hash: row.tx_hash,
    executed_time: fmtTime(num(row.close_time)),
    account: row.account,
    initiator: row.initiator,
    event: row.event,
    ...(row.mode !== '' && { mode: row.mode }),
    base_amount: row.base_amount,
    counter_amount: row.counter_amount,
    lp_tokens: row.lp_tokens,
  };
}

/** The Vote or the Bid of a row of `amm_governance`: a vote serves nothing of a bid and a bid nothing of a vote. */
export function toGovernanceObject(row: StoredGovernance): GovernanceObject {
  const head = {
    amm_account: row.amm_account,
    ledger_index: num(row.ledger_index),
    tx_index: num(row.tx_index),
    tx_hash: row.tx_hash,
    executed_time: fmtTime(num(row.close_time)),
  };
  if (row.kind !== 'bid') {
    return {
      ...head,
      type: 'vote',
      account: row.account,
      ...countKey('fee_voted', row.fee_voted),
      ...countKey('trading_fee_after', row.trading_fee_after),
    };
  }
  const slot = {
    ...key('holder', row.slot_holder),
    ...countKey('discounted_fee', row.slot_discounted_fee),
    ...(present(row.slot_expiration) && {
      expiration: fmtTime(RIPPLE_EPOCH_SECONDS + num(row.slot_expiration)),
    }),
  };
  const known = Object.keys(slot).length > 0 || row.auth_accounts.length > 0;
  return {
    ...head,
    type: 'bid',
    account: row.account,
    ...key('bid_min', row.bid_min),
    ...key('bid_max', row.bid_max),
    ...key('price_paid', row.price_paid),
    ...(known && { auction_slot: { ...slot, auth_accounts: [...row.auth_accounts] } }),
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
  fees_base_est: string | null;
  fees_counter_est: string | null;
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
    fees_base_est: day.fees_base_est ?? null,
    fees_counter_est: day.fees_counter_est ?? null,
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

export type LiquidityCsvRow = Omit<LiquidityObject, 'mode'> & { mode: string | null };

/** The event as a row of the CSV: every column, in the pinned order, the mode empty where there is none. */
export function toLiquidityCsvRow(event: LiquidityObject): LiquidityCsvRow {
  return {
    amm_account: event.amm_account,
    ledger_index: event.ledger_index,
    tx_index: event.tx_index,
    tx_hash: event.tx_hash,
    executed_time: event.executed_time,
    account: event.account,
    initiator: event.initiator,
    event: event.event,
    mode: event.mode ?? null,
    base_amount: event.base_amount,
    counter_amount: event.counter_amount,
    lp_tokens: event.lp_tokens,
  };
}

export interface GovernanceCsvRow {
  amm_account: string;
  ledger_index: number;
  tx_index: number;
  tx_hash: string;
  executed_time: string;
  type: 'vote' | 'bid';
  account: string;
  fee_voted: number | null;
  trading_fee_after: number | null;
  bid_min: string | null;
  bid_max: string | null;
  price_paid: string | null;
  auction_slot: {
    holder: string | null;
    discounted_fee: number | null;
    expiration: string | null;
    /** The accounts, separated by semicolons: one cell. */
    auth_accounts: string | null;
  };
}

/** The vote or bid as a row of the CSV: the columns of both kinds, in the pinned order, `null` where the object has none. */
export function toGovernanceCsvRow(item: GovernanceObject): GovernanceCsvRow {
  const vote = item.type === 'vote' ? item : undefined;
  const bid = item.type === 'bid' ? item : undefined;
  const accounts = bid?.auction_slot?.auth_accounts ?? [];
  return {
    amm_account: item.amm_account,
    ledger_index: item.ledger_index,
    tx_index: item.tx_index,
    tx_hash: item.tx_hash,
    executed_time: item.executed_time,
    type: item.type,
    account: item.account,
    fee_voted: vote?.fee_voted ?? null,
    trading_fee_after: vote?.trading_fee_after ?? null,
    bid_min: bid?.bid_min ?? null,
    bid_max: bid?.bid_max ?? null,
    price_paid: bid?.price_paid ?? null,
    auction_slot: {
      holder: bid?.auction_slot?.holder ?? null,
      discounted_fee: bid?.auction_slot?.discounted_fee ?? null,
      expiration: bid?.auction_slot?.expiration ?? null,
      auth_accounts: accounts.length > 0 ? accounts.join(';') : null,
    },
  };
}
