import { RIPPLE_EPOCH_MS } from '../util/time';

/** Ripple epoch (2000-01-01T00:00:00Z) in unix seconds. */
const RIPPLE_EPOCH_S = RIPPLE_EPOCH_MS / 1000;

export interface LedgerHeader {
  ledger_index: number;
  ledger_hash: string;
  parent_hash: string;
  account_hash: string;
  transaction_hash: string;
  /** Drops, as a decimal string (can exceed 2^53). */
  total_coins: string;
  /** Unix seconds. */
  close_time: number;
  /** Unix seconds; 0 when the source did not report it. */
  parent_close_time: number;
  close_time_resolution: number;
  close_flags: number;
}

export interface RawTransaction {
  hash: string;
  /** The transaction as returned by the node, without `hash`, `metaData` and `meta`. */
  tx: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface RawLedger {
  header: LedgerHeader;
  /** Sorted by `meta.TransactionIndex`. */
  transactions: RawTransaction[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively freeze plain objects and arrays so later stages cannot mutate shared ledger data. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function requireString(ledger: JsonObject, field: string, ...fallbacks: string[]): string {
  for (const key of [field, ...fallbacks]) {
    const value = ledger[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  throw new Error(`Ledger response is missing "${[field, ...fallbacks].join('" or "')}"`);
}

/** A non-negative safe integer given as a number or a decimal string. */
function requireInteger(ledger: JsonObject, field: string): number {
  const value = ledger[field];
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Ledger response has an invalid "${field}": ${JSON.stringify(value)}`);
  }
  return parsed;
}

function optionalInteger(ledger: JsonObject, field: string): number {
  return ledger[field] === undefined || ledger[field] === null ? 0 : requireInteger(ledger, field);
}

function normalizeHeader(ledger: JsonObject): LedgerHeader {
  const totalCoins = ledger.total_coins ?? ledger.totalCoins;
  if (typeof totalCoins !== 'string' || !/^\d+$/.test(totalCoins)) {
    throw new Error(`Ledger response has an invalid "total_coins": ${JSON.stringify(totalCoins)}`);
  }
  const parentCloseTime = optionalInteger(ledger, 'parent_close_time');
  return {
    ledger_index: requireInteger(ledger, 'ledger_index'),
    ledger_hash: requireString(ledger, 'ledger_hash', 'hash'),
    parent_hash: requireString(ledger, 'parent_hash'),
    account_hash: requireString(ledger, 'account_hash'),
    transaction_hash: requireString(ledger, 'transaction_hash'),
    total_coins: totalCoins,
    close_time: requireInteger(ledger, 'close_time') + RIPPLE_EPOCH_S,
    // Ripple time 0 means "no parent close time" (genesis, or a source that does not report it).
    parent_close_time: parentCloseTime === 0 ? 0 : parentCloseTime + RIPPLE_EPOCH_S,
    close_time_resolution: requireInteger(ledger, 'close_time_resolution'),
    close_flags: optionalInteger(ledger, 'close_flags'),
  };
}

function normalizeTransaction(entry: unknown, ledgerIndex: number): RawTransaction {
  if (!isObject(entry)) {
    throw new Error(
      `Ledger ${ledgerIndex}: transactions must be expanded objects, got ${typeof entry}; ` +
        'request the ledger with transactions:true and expand:true',
    );
  }
  const { hash, metaData, meta, ...tx } = entry;
  if (typeof hash !== 'string' || hash === '') {
    throw new Error(`Ledger ${ledgerIndex}: a transaction has no hash`);
  }
  const rawMeta = metaData ?? meta;
  if (!isObject(rawMeta)) {
    throw new Error(`Ledger ${ledgerIndex}: transaction ${hash} has no metaData/meta object`);
  }
  const index = rawMeta.TransactionIndex;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Ledger ${ledgerIndex}: transaction ${hash} has no valid meta.TransactionIndex`);
  }
  // Clone so that freezing the result never touches the caller's object.
  return { hash, tx: structuredClone(tx), meta: structuredClone(rawMeta) };
}

/**
 * Turn a rippled API v1 `ledger` result (`result.ledger`, requested with `transactions:true, expand:true`) or a Ripple
 * Data API mock ledger into the immutable model that every parser and the ledger writer consume.
 *
 * - `ledger_index` may be a string or a number; `ledger_hash` falls back to `hash`, `total_coins` to `totalCoins`.
 * - `close_time` and `parent_close_time` are ripple-epoch seconds in the input and unix seconds in the output; a missing
 *   `parent_close_time` and a missing `close_flags` become 0.
 * - Each transaction's `hash` and `metaData`/`meta` are lifted out of `tx`; transactions are sorted by
 *   `meta.TransactionIndex`.
 * - The input is not modified and the output is deeply frozen.
 */
export function normalizeLedgerResponse(ledger: Record<string, unknown>): RawLedger {
  const header = normalizeHeader(ledger);
  const entries = ledger.transactions ?? [];
  if (!Array.isArray(entries)) {
    throw new Error(`Ledger ${header.ledger_index}: "transactions" is not an array`);
  }
  const transactions = entries
    .map((entry) => normalizeTransaction(entry, header.ledger_index))
    .sort((a, b) => (a.meta.TransactionIndex as number) - (b.meta.TransactionIndex as number));
  return deepFreeze({ header, transactions });
}
