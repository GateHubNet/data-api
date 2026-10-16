import { badRequest, notFound } from '../common/errors';
import { first, limitParam, parseDate, Query } from '../common/params';

/**
 * What `/v2/accounts/:address/balances` and `/orders` share: which ledger the live node is asked about, the `limit`,
 * and what the node's own errors become. Both routes follow `accountBalances.js` / `accountOrders.js`, which parse
 * these the same way.
 */

/** The ledgers the node names with a word. */
const SHORTCUTS = ['validated', 'closed', 'current'] as const;
export type LedgerShortcut = (typeof SHORTCUTS)[number];

/** The ledger a node request is about: one of the two keys, as rippled takes them. */
export type LedgerSpec = { ledger_index: number | LedgerShortcut } | { ledger_hash: string };

/** What the ledger was asked for with; `LiveLedgerService.resolve` makes a `LedgerSpec` of it. */
export interface LedgerSelector {
  /** 64 hex digits, upper case. */
  hash?: string;
  /** From `date` / `close_time`: the ledger closed at or before it. */
  date?: Date;
  /** From `ledger_index` / `ledger`: a ledger number, or one of the node's words. */
  index?: number | LedgerShortcut;
}

/** The message of the original for a ledger the node does not have (`lgrNotFound`, "ledgerNotFound"), and for a date no ledger is old enough for. */
export const DATE_TOO_OLD = 'the date provided is too old';

const MAX_LEDGER_INDEX = 4_294_967_295;

/**
 * `ledger_index`: the digits of a ledger number, or `validated` / `closed` / `current`. Anything else is not a ledger:
 * the original turned it into NaN, which the node read as no ledger at all, so it is no selection here either (the
 * default ledger applies).
 */
function ledgerIndexParam(raw: string | undefined): LedgerSelector['index'] {
  if (!raw) return undefined;
  if ((SHORTCUTS as readonly string[]).includes(raw)) return raw as LedgerShortcut;
  if (!/^\d{1,10}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= MAX_LEDGER_INDEX ? n : undefined;
}

/**
 * The ledger of a request, from `ledger_index` (alias `ledger`), `ledger_hash` and `date` (alias `close_time`), each
 * with the original's precedence of an empty value (an empty `ledger_index` falls back to `ledger`, an empty date is
 * none). 400 `invalid date format` for a date that is none, then 400 `invalid ledger hash` for a hash that is not 64 hex
 * digits (the original ignored the hash, so it had no message for it).
 */
export function ledgerSelector(q: Query): LedgerSelector {
  const index = ledgerIndexParam(first(q, 'ledger_index') || first(q, 'ledger'));

  const rawDate = first(q, 'close_time') || first(q, 'date');
  let date: Date | undefined;
  if (rawDate) {
    const parsed = parseDate(rawDate);
    if (!parsed) throw badRequest('invalid date format');
    date = parsed.date;
  }

  const rawHash = first(q, 'ledger_hash');
  let hash: string | undefined;
  if (rawHash) {
    if (!/^[0-9A-Fa-f]{64}$/.test(rawHash)) throw badRequest('invalid ledger hash');
    hash = rawHash.toUpperCase();
  }

  return { ...(hash && { hash }), ...(date && { date }), ...(index !== undefined && { index }) };
}

/** The `limit` of both routes. */
export const LIVE_LIMIT_DEFAULT = 200;
export const LIVE_LIMIT_MAX = 400;

/**
 * The `limit`: 200 by default, at most 400, `all` for no limit at all (`undefined`, so that nothing says "limit" in the
 * response either). A text that is not a number answers 400 `invalid limit`; below one is the default (R33).
 */
export function liveLimit(q: Query): number | undefined {
  if (first(q, 'limit') === 'all') return undefined;
  return limitParam(q, { def: LIVE_LIMIT_DEFAULT, max: LIVE_LIMIT_MAX, nanError: 'invalid limit' });
}

/** The `error` code of a node's error response (`actNotFound`, `lgrNotFound`, ...) in the `RippledError` the client rethrows. */
export function rippledErrorCode(err: unknown): string | undefined {
  const code = (err as { data?: { error?: unknown } } | null | undefined)?.data?.error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The route's answer to an error of the node: `actNotFound` is 404 `account not found` and `lgrNotFound` 400 `the date
 * provided is too old` (the original keyed on the node's messages "Account not found." and "ledgerNotFound", which are
 * these two errors). Anything else is rethrown, for the route's own 500 message.
 */
export function liveNodeError(err: unknown): never {
  switch (rippledErrorCode(err)) {
    case 'actNotFound':
      throw notFound('account not found');
    case 'lgrNotFound':
      throw badRequest(DATE_TOO_OLD);
    default:
      throw err;
  }
}

/** The key of a live response in the cache: what kind, and everything the answer depends on (`undefined` is `null`). */
export function liveCacheKey(kind: string, ...parts: unknown[]): string {
  return `${kind}:${JSON.stringify(parts)}`;
}

/**
 * The ledger the pages after the first ask the node for. A marker is only good for the ledger it came from: a hash or a
 * number the client gave names one ledger already and stays as it is (M3: the hash was replaced by the index); a word
 * (`validated`, `closed`, `current`) becomes the index the node answered the first request with, so that a later page
 * cannot land on a newer ledger.
 */
export function pagedLedger(spec: LedgerSpec, answered: number | undefined): LedgerSpec {
  if ('ledger_hash' in spec || typeof spec.ledger_index === 'number' || answered === undefined) return spec;
  return { ledger_index: answered };
}

/**
 * The `Cache-Control` of a live answer (`/balances`, `/orders`; Ruling R108): private (it is for the holder of an API key),
 * and no older than the live cache keeps it, in whole seconds; `no-store` when the live cache is off. It replaces the
 * global header of `/v2` (`GH_CACHE_CONTROL`), whose 60 s would let a downstream cache serve stale balances.
 */
export function liveCacheControl(liveCacheTtlMs: number): string {
  return liveCacheTtlMs <= 0 ? 'no-store' : `private, max-age=${Math.floor(liveCacheTtlMs / 1000)}`;
}

/** How long a `limit=all` read may page the live node in all (Ruling R108). */
export const LIMIT_ALL_DEADLINE_MS = 30_000;

/**
 * The overall deadline of a `limit=all` read (Ruling R108): an account with a huge number of trust lines or offers would
 * otherwise page the node for as long as it has pages. Past the deadline the read throws, which the route answers with its
 * own 500 message. A numeric limit ends with the limit and has no deadline of its own (each node request has its timeout).
 */
export class LiveDeadline {
  private constructor(private readonly at: number | undefined) {}

  /** The deadline of a read with this limit: 30 s from now for `limit=all` (`undefined`), none otherwise. */
  static for(limit: number | undefined): LiveDeadline {
    return new LiveDeadline(limit === undefined ? Date.now() + LIMIT_ALL_DEADLINE_MS : undefined);
  }

  /** Throws when the deadline has passed. */
  check(): void {
    if (this.at !== undefined && Date.now() >= this.at) throw this.error();
  }

  /** `request`, or the deadline's error when the deadline passes first. */
  race<T>(request: Promise<T>): Promise<T> {
    if (this.at === undefined) return request;
    const left = this.at - Date.now();
    if (left <= 0) return Promise.reject(this.error());
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(this.error()), left);
    });
    return Promise.race([request, late]).finally(() => clearTimeout(timer));
  }

  private error(): Error {
    return new Error(`limit=all paged the node for longer than ${LIMIT_ALL_DEADLINE_MS / 1000} s`);
  }
}
