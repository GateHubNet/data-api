import { ClickHouseService } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';

/** A resolution is cached only when the bound it answers is older than this: that part of the history is settled. */
export const RANGE_CACHE_MIN_AGE_MS = 60 * 60 * 1000;
/** Entries kept at most. */
export const RANGE_CACHE_MAX_ENTRIES = 10_000;
/**
 * How long an entry lives. History is immutable, but a backfill can still write ledgers below a bound the cache has
 * already answered ("the first ledger closed at or after X" moves down when the gap below it is filled), so an answer
 * is not trusted forever.
 */
export const RANGE_CACHE_TTL_MS = 5 * 60 * 1000;

const MAX_UINT32 = 4_294_967_295;

interface Entry<V> {
  value: V;
  storedAt: number;
}

/** Least recently used cache with a size cap and a time to live, on the insertion order of a `Map`. */
export class LruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (Date.now() - entry.storedAt > this.ttlMs) return undefined;
    this.entries.set(key, entry); // most recently used again
    return entry.value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, storedAt: Date.now() });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
}

/** Dates and ledgers: `ledgers.close_time` is whole seconds, so the lookups work in whole seconds too. */
function seconds(date: Date, round: (value: number) => number): number {
  const ms = date.getTime();
  if (Number.isNaN(ms)) throw new RangeError('Invalid date');
  return round(ms / 1000);
}

/**
 * Turns the dates of the API into ledger indexes. The tables are keyed by `ledger_index`, and the time axis of a list
 * is the range of ledgers that closed within it, so every list endpoint starts here.
 *
 * Close times never decrease with the ledger index (several ledgers can share a second), which makes "the first
 * ledger closed at or after X" and "the last ledger closed before Y" two ends of one contiguous range of indexes.
 * Only committed ledgers count: a ledger exists once its `ledgers` row does.
 */
@Injectable()
export class LedgerRangeResolver {
  private readonly cache = new LruCache<number>(RANGE_CACHE_MAX_ENTRIES, RANGE_CACHE_TTL_MS);

  constructor(private readonly ch: ClickHouseService) {}

  /**
   * The indexes of the first ledger closed at or after `start` and of the last one closed before `endExclusive`;
   * a missing bound leaves that side open. `null` when no ledger lies in the window, which includes an empty database
   * and a window that holds no ledger (never an error: the endpoints answer `count: 0`).
   */
  async resolve(start?: Date, endExclusive?: Date): Promise<{ min: number; max: number } | null> {
    // Both dates are checked before any query is sent.
    const from = start === undefined ? undefined : seconds(start, Math.ceil);
    const before = endExclusive === undefined ? undefined : seconds(endExclusive, Math.ceil);
    const [min, max] = await Promise.all([
      from === undefined ? this.firstLedger() : this.firstClosedFrom(from),
      before === undefined ? this.latest() : this.lastClosedBefore(before),
    ]);
    if (min === undefined || max === undefined || min > max) return null;
    return { min, max };
  }

  /** The last ledger that closed at or before `date` (the ledger "as of" a date), `undefined` when there is none. */
  async ledgerAtOrBefore(date: Date): Promise<number | undefined> {
    // Close times are whole seconds: closed <= date is closed < floor(date) + 1.
    return this.lastClosedBefore(seconds(date, Math.floor) + 1);
  }

  /** The highest committed ledger, `undefined` on an empty database. Never cached: it moves with every ledger. */
  async latest(): Promise<number | undefined> {
    return this.one('SELECT ledger_index FROM ledgers ORDER BY ledger_index DESC LIMIT 1');
  }

  private firstLedger(): Promise<number | undefined> {
    return this.one('SELECT ledger_index FROM ledgers ORDER BY ledger_index ASC LIMIT 1');
  }

  /** The first ledger with `close_time >= secs`. */
  private firstClosedFrom(secs: number): Promise<number | undefined> {
    if (secs <= 0) return this.firstLedger();
    if (secs > MAX_UINT32) return Promise.resolve(undefined);
    return this.cached(
      `from:${secs}`,
      secs,
      "SELECT ledger_index FROM ledgers WHERE close_time >= toDateTime({secs:UInt32}, 'UTC') ORDER BY ledger_index ASC LIMIT 1",
    );
  }

  /** The last ledger with `close_time < secs`. */
  private lastClosedBefore(secs: number): Promise<number | undefined> {
    if (secs <= 0) return Promise.resolve(undefined);
    if (secs > MAX_UINT32) return this.latest();
    return this.cached(
      `before:${secs}`,
      secs,
      "SELECT ledger_index FROM ledgers WHERE close_time < toDateTime({secs:UInt32}, 'UTC') ORDER BY ledger_index DESC LIMIT 1",
    );
  }

  /**
   * The answer to a question about the bound `secs`, from memory when the bound is old enough to be settled history.
   * A missing ledger is never remembered: history below the bound may be backfilled later.
   */
  private async cached(key: string, secs: number, sql: string): Promise<number | undefined> {
    const settled = secs * 1000 < Date.now() - RANGE_CACHE_MIN_AGE_MS;
    if (settled) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
    }
    const found = await this.one(sql, { secs });
    if (settled && found !== undefined) this.cache.set(key, found);
    return found;
  }

  private async one(sql: string, params: Record<string, unknown> = {}): Promise<number | undefined> {
    const [row] = await this.ch.query<{ ledger_index: number }>(sql, params);
    return row?.ledger_index;
  }
}
