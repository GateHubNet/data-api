import type { FilledColumn } from '@gatehub/data-api-shared';
import { badRequest } from '../common/errors';
import { encodeMarker } from '../common/pagination';

/**
 * The pure parts of the paging of the pool routes: the carry-forward of the history, and the marker and the keyset
 * condition of the list of pools.
 */

// -- the carry-forward ---------------------------------------------------------------------------------------------

/**
 * The columns of a state that are carried forward: a state row holds a value only when its transaction's metadata carried
 * it (a swap through an XRP/IOU pool says nothing of the LP supply, a vote nothing of the reserves), so the value of the
 * pool after the row is the newest non-null value of the row and the rows before it.
 */
export const FILLED_COLUMNS: readonly FilledColumn[] = [
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

/** The value of each filled column: a number for the fee and the slot's fee and expiration, else text; `null` when unknown. */
export type FilledValues = Record<FilledColumn, string | number | null>;

/** A pool about which nothing is known yet. */
export const EMPTY_FILL: Readonly<FilledValues> = Object.freeze(
  Object.fromEntries(FILLED_COLUMNS.map((c) => [c, null])) as FilledValues,
);

/**
 * The rows with their nulls filled in: `rows` are in the order of time (oldest first), `carryIn` is the state of the pool
 * before the first of them. A column that has a value in a row keeps it (0 and '0' are values) and becomes the state
 * after the row; one that is null takes the state before it. Nothing is changed in place.
 */
export function carryForward<T extends FilledValues>(rows: readonly T[], carryIn: Readonly<FilledValues>): T[] {
  let state: FilledValues = { ...carryIn };
  return rows.map((row) => {
    const next = { ...state };
    for (const column of FILLED_COLUMNS) {
      if (row[column] !== null && row[column] !== undefined) next[column] = row[column];
    }
    state = next;
    return { ...row, ...next };
  });
}

// -- the marker of the list of pools -------------------------------------------------------------------------------

/** The key of the list of pools: `value_native` (null for a pool with none) and `amm_account`. */
export type PoolsKey = [number | null, string];

/** The marker of a page: the base64url JSON of the value and the account of its last pool. */
export function encodePoolsMarker(value: number | null, account: string): string {
  // `encodeMarker` takes the keys of the tables, which are never null; a pool without a value is `null` in JSON
  return encodeMarker([value, account] as unknown as Array<string | number>);
}

/**
 * The key of a marker, or `undefined` for the first page. Anything that is not a marker of this list answers 400
 * `invalid marker`: text that is not base64url, JSON that is not a pair, a value that is not a finite number or null, an
 * account that is not text.
 */
export function decodePoolsMarker(marker: string | undefined): PoolsKey | undefined {
  if (marker === undefined || marker === '') return undefined;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(marker)) throw badRequest('invalid marker');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));
  } catch {
    throw badRequest('invalid marker');
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw badRequest('invalid marker');
  const [value, account] = parsed as unknown[];
  const validValue = value === null || (typeof value === 'number' && Number.isFinite(value));
  if (!validValue || typeof account !== 'string') throw badRequest('invalid marker');
  return [value as number | null, account];
}

/**
 * The condition that selects the pools after a marker, in the order of the list (`value_native` descending with the pools
 * that have none last, then `amm_account` ascending), and its params. After a pool with a value: a lower value, the same value
 * and a later account, or no value at all. After a pool without one: the pools without one and a later account. The first
 * page has none.
 */
export function poolsKeyset(after: PoolsKey | undefined): { clause: string; params: Record<string, unknown> } {
  if (after === undefined) return { clause: '', params: {} };
  const [value, account] = after;
  if (value === null) {
    return {
      clause: '(value_native IS NULL AND amm_account > {after_account:String})',
      params: { after_account: account },
    };
  }
  return {
    clause:
      '(value_native < {after_value:Float64} OR (value_native = {after_value:Float64} AND amm_account > {after_account:String}) OR value_native IS NULL)',
    params: { after_value: value, after_account: account },
  };
}
