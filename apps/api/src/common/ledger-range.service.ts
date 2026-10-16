import { ClickHouseService, Table } from '@gatehub/data-api-shared';
import { Injectable } from '@nestjs/common';
import { LruCache } from './lru-cache';

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

/** Whether the bound lies far enough in the past for its answer to be remembered (see `RANGE_CACHE_MIN_AGE_MS`). */
function isSettled(secs: number): boolean {
  return secs * 1000 < Date.now() - RANGE_CACHE_MIN_AGE_MS;
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
    // Both dates are checked before any query is sent. A start with milliseconds is the second it falls in, as the
    // row keys of the original were (`hbaseFormatStartRow` cut the date to the second; R54): the ledgers that closed in
    // that second are in the window. The end is exclusive: closed < 12:00:20.5 is closed < 12:00:21.
    const from = start === undefined ? undefined : seconds(start, Math.floor);
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
    return this.one(`SELECT ledger_index FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`);
  }

  private firstLedger(): Promise<number | undefined> {
    return this.one(`SELECT ledger_index FROM ${Table.Ledgers} ORDER BY ledger_index ASC LIMIT 1`);
  }

  /** The first ledger with `close_time >= secs`. */
  private async firstClosedFrom(secs: number): Promise<number | undefined> {
    if (secs <= 0) return this.firstLedger();
    if (secs > MAX_UINT32) return undefined;
    const key = `from:${secs}`;
    const settled = isSettled(secs);
    if (settled) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
    }
    const found = await this.one(
      `SELECT ledger_index FROM ${Table.Ledgers}
        WHERE close_time >= toDateTime({secs:UInt32}, 'UTC') ORDER BY ledger_index ASC LIMIT 1`,
      { secs },
    );
    // A ledger that exists stays the first one at or after the bound, unless a backfill fills the gap below it (TTL).
    if (settled && found !== undefined) this.cache.set(key, found);
    return found;
  }

  /** The last ledger with `close_time < secs`. */
  private async lastClosedBefore(secs: number): Promise<number | undefined> {
    if (secs <= 0) return undefined;
    if (secs > MAX_UINT32) return this.latest();
    const key = `before:${secs}`;
    const settled = isSettled(secs);
    if (settled) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
    }
    const [row] = await this.ch.query<{ ledger_index: number; head_close: number }>(
      `SELECT ledger_index,
              (SELECT toUnixTimestamp(close_time) FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1) AS head_close
         FROM ${Table.Ledgers}
        WHERE close_time < toDateTime({secs:UInt32}, 'UTC') ORDER BY ledger_index DESC LIMIT 1`,
      { secs },
    );
    // The answer is final only once the ledgers have reached the bound. While the ingest lags behind it (the syncer
    // catching up, or stopped for more than the hour of `isSettled`), the last ledger before the bound is merely the
    // newest one so far, and the next ledger the syncer commits changes it.
    if (settled && row !== undefined && row.head_close >= secs) this.cache.set(key, row.ledger_index);
    return row?.ledger_index;
  }

  private async one(sql: string, params: Record<string, unknown> = {}): Promise<number | undefined> {
    const [row] = await this.ch.query<{ ledger_index: number }>(sql, params);
    return row?.ledger_index;
  }
}
