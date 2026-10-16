/**
 * Pages over buckets of time (an hour, a day) that a query has to compute, not read: the first buckets of a range of
 * years cost no more than their own ledgers or snapshots, however far the range reaches.
 *
 * A query that groups a table by bucket reads all of its range before it can say which buckets come first. So the
 * range is read in windows of whole buckets that start with just enough room for the page and double when the window
 * held too few non-empty buckets (a gap in the data, or fewer buckets than the page asks for). Where the data is
 * dense that is one query; across a gap of years it is a handful, not one per empty bucket.
 */

/** The largest multiple of `size` that is at most `t`. Times are unix seconds. */
export function floorTo(t: number, size: number): number {
  return Math.floor(t / size) * size;
}

/** The smallest multiple of `size` that is at least `t`. */
export function ceilTo(t: number, size: number): number {
  return Math.ceil(t / size) * size;
}

/** The part of the range one query reads: `[from, until)`, both multiples of the bucket size. */
export interface BucketWindow {
  from: number;
  until: number;
}

export interface CollectBuckets<T> {
  /** The range, `[from, until)`: both multiples of `size`. An empty or reversed range reads nothing. */
  from: number;
  until: number;
  /** The bucket size in seconds. */
  size: number;
  /** How many buckets to collect at most (the page and one more, to tell whether there is a next page). */
  want: number;
  /** Newest first: the windows start at the end of the range and walk back. */
  descending: boolean;
  /**
   * The non-empty buckets that start inside `window`, in the order asked for, at most `limit` of them. A window holds
   * whole buckets, so a bucket is never cut by it.
   */
  fetch(window: BucketWindow, limit: number): Promise<T[]>;
}

/** The first `want` non-empty buckets of the range in the order asked for (fewer when the range has fewer). */
export async function collectBuckets<T>(o: CollectBuckets<T>): Promise<T[]> {
  const rows: T[] = [];
  let span = Math.max(1, o.want) * o.size;
  let from = o.from;
  let until = o.until;
  while (from < until && rows.length < o.want) {
    const window: BucketWindow = o.descending
      ? { from: Math.max(from, until - span), until }
      : { from, until: Math.min(until, from + span) };
    rows.push(...(await o.fetch(window, o.want - rows.length)));
    if (o.descending) until = window.from;
    else from = window.until;
    span *= 2;
  }
  return rows.slice(0, o.want);
}
