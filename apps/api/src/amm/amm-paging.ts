import { FilledColumn, POOL_FIELDS } from '@gatehub/data-api-shared';
import { decodeMarker, encodeMarker, KeysetKey } from '../common/pagination';

/**
 * The pure parts of the paging of the pool routes: the carry-forward of the history, and the marker and the keyset
 * condition of the list of pools.
 */

// -- the carry-forward ---------------------------------------------------------------------------------------------

/**
 * The value of each filled column: a number for the fee and the slot's fee and expiration, else text; `null` when unknown.
 *
 * The columns carried forward are those the aggregator fills for `amm_pools` (`POOL_FIELDS`, the one list of their names): a
 * state row holds a value only when its transaction's metadata carried it (a swap through an XRP/IOU pool says nothing of the
 * LP supply, a vote nothing of the reserves), so the value of the pool after the row is the newest non-null value of the row
 * and the rows before it.
 */
export type FilledValues = Record<FilledColumn, string | number | null>;

/** A pool about which nothing is known yet. */
export const EMPTY_FILL: Readonly<FilledValues> = Object.freeze(
  Object.fromEntries(POOL_FIELDS.map((c) => [c, null])) as FilledValues,
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
    for (const column of POOL_FIELDS) {
      if (row[column] !== null && row[column] !== undefined) next[column] = row[column];
    }
    state = next;
    return { ...row, ...next };
  });
}

// -- the marker of the list of pools -------------------------------------------------------------------------------

/** The key of the list of pools: `value_native` (null for a pool with none) and `amm_account`. */
export type PoolsKey = [number | null, string];

/** The columns of the key of the list, as the marker codes them: `value_native` is a Float64 that is null for a pool without one. */
const POOLS_KEYS: KeysetKey[] = [
  { column: 'value_native', type: 'Float64', nullable: true },
  { column: 'amm_account', type: 'String' },
];

/** The marker of a page: the base64url JSON of the value and the account of its last pool. */
export function encodePoolsMarker(value: number | null, account: string): string {
  return encodeMarker([value, account]);
}

/**
 * The key of a marker, or `undefined` for the first page. Anything that is not a marker of this list answers 400
 * `invalid marker` (`decodeMarker`): text that is not base64url, JSON that is not a pair, a value that is not a finite number or
 * null, an account that is not text.
 */
export function decodePoolsMarker(marker: string | undefined): PoolsKey | undefined {
  const values = decodeMarker(marker, POOLS_KEYS);
  return values === undefined ? undefined : [values[0] as number | null, values[1] as string];
}

/**
 * The condition that selects the pools after a marker, in the order of the list (`value_native` descending with the pools
 * that have none last, then `amm_account` ascending), and its params. After a pool with a value: a lower value, the same value
 * and a later account, or no value at all. After a pool without one: the pools without one and a later account. The first
 * page has none.
 *
 * The value of the marker is the Float64 of `value_native` as JavaScript wrote it (the shortest text that reads back as the
 * same double) and ClickHouse reads back as the identical double, so `=` finds the tie it came from: proven by the walks of
 * the list with `limit=1` and by the tie test of `0.1 + 0.2` and `0.3` (`amm-pools.e2e-spec.ts`).
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
