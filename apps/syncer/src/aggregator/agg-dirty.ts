import { ClickHouseService, Table } from '@gatehub/data-api-shared';

/**
 * The `agg_dirty` queue: hour ranges whose `stats_hourly` rows must be recomputed because ledgers were rewritten behind
 * the aggregator (`range-ingest` writes a row per chunk). A row is the range `[from, to)` in unix seconds, both on an
 * hour boundary, plus the `created_at` it was marked at, in milliseconds.
 *
 * The table is a ReplacingMergeTree keyed by `(from_hour, to_hour)` with `created_at` as the version: marking a range
 * again leaves two rows of one key until a merge, so reads take the newest of a key (no FINAL).
 */
export interface DirtyRange {
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, exclusive. */
  to: number;
  /** When the newest mark of this range was made, unix milliseconds. */
  created: number;
}

/**
 * Passed on every lightweight DELETE so that no server profile can make it asynchronous: the statement then returns only
 * once the mutation has been applied (`lightweight_deletes_sync` is the 26.8 name; 2 = wait for all replicas). The same
 * setting the ingest code uses for its deletes.
 */
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

interface DirtyRowFromClickHouse {
  from_hour: number | string;
  to_hour: number | string;
  created_ms: number | string;
}

/** The ranges to work on, oldest mark first (ties by range), at most `limit` of them. */
export async function readDirtyRanges(ch: ClickHouseService, limit: number): Promise<DirtyRange[]> {
  const rows = await ch.query<DirtyRowFromClickHouse>(
    `SELECT toUnixTimestamp(from_hour) AS from_hour, toUnixTimestamp(to_hour) AS to_hour,
            toUnixTimestamp64Milli(created_at) AS created_ms
       FROM (
            SELECT from_hour, to_hour, created_at
              FROM ${Table.AggDirty}
             ORDER BY from_hour ASC, to_hour ASC, created_at DESC
             LIMIT 1 BY from_hour, to_hour
            )
      ORDER BY created_at ASC, from_hour ASC, to_hour ASC
      LIMIT {limit:UInt32}`,
    { limit },
  );
  return rows.map((r) => ({ from: Number(r.from_hour), to: Number(r.to_hour), created: Number(r.created_ms) }));
}

/**
 * Removes a range that was worked on: every row of its key marked at or before `created`, the mark that was read. A row of
 * the same key that was marked after the read (the ingest rewrote more ledgers of the range while it was being
 * recomputed) is not touched, so it is worked on again; a mark is never lost.
 */
export async function deleteDirtyRange(ch: ClickHouseService, range: DirtyRange): Promise<void> {
  await ch.command(
    `DELETE FROM ${Table.AggDirty}
      WHERE from_hour = toDateTime({from:UInt32}, 'UTC')
        AND to_hour = toDateTime({to:UInt32}, 'UTC')
        AND toUnixTimestamp64Milli(created_at) <= {created:Int64}`,
    { from: range.from, to: range.to, created: range.created },
    { settings: SYNC_DELETE },
  );
}

/**
 * Replaces a range by the part of it that is left, `[progress, to)`: the narrowed row is inserted first, then the old one
 * is deleted (as `deleteDirtyRange` does it), so that a crash between the two leaves both, and the work in between is
 * done twice, which is harmless. A shutdown does not interrupt the pair: once the narrowed row is in, the old one goes. The
 * narrowed row keeps the `created_at` of the original: it stays where it was in the queue and is finished before younger
 * ranges are started.
 */
export async function narrowDirtyRange(ch: ClickHouseService, range: DirtyRange, progress: number): Promise<void> {
  if (progress <= range.from) return;
  if (progress >= range.to) {
    await deleteDirtyRange(ch, range);
    return;
  }
  // `fromUnixTimestamp64Milli`: the milliseconds exactly, where a JSON number would be a fraction of seconds
  await ch.command(
    `INSERT INTO ${Table.AggDirty} (from_hour, to_hour, created_at)
     SELECT toDateTime({from:UInt32}, 'UTC'), toDateTime({to:UInt32}, 'UTC'), fromUnixTimestamp64Milli({created:Int64})`,
    { from: progress, to: range.to, created: range.created },
  );
  await deleteDirtyRange(ch, range);
}
