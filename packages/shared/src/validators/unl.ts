/** A validator list as stored in `unl_lists`: one verified blob of a publisher. Times are unix seconds. */
export interface StoredUnlList {
  /** The publisher's id (`vl.ripple.com`). */
  publisher: string;
  sequence: number;
  version: number;
  /** The list is valid from this time on; none means always. */
  effective?: number;
  expiration: number;
  /** Base58 node public keys. */
  validators: string[];
  /** When the list was fetched. */
  fetchedAt: number;
}

/** The list of a publisher that applies at some time, and whether it is already past its expiration. */
export interface ListInUse {
  list: StoredUnlList;
  expired: boolean;
}

/**
 * The list of `publisher` in use at `t` (spec 2.1). Without a row of the publisher: none. For a `t` before its first
 * `fetchedAt`: its lowest-sequence row, which stands in. Otherwise the highest `sequence` with
 * `effective <= t < expiration` (no `effective` is always in effect). When none is current: the highest-sequence row,
 * reported as `expired`, since a flagged old UNL is better than none.
 */
export function listInUse(lists: readonly StoredUnlList[], publisher: string, t: number): ListInUse | undefined {
  const own = lists.filter((list) => list.publisher === publisher);
  if (own.length === 0) return undefined;

  const highest = (candidates: readonly StoredUnlList[]) =>
    candidates.reduce((best, list) => (list.sequence > best.sequence ? list : best));

  if (t < Math.min(...own.map((list) => list.fetchedAt))) {
    const oldest = own.reduce((best, list) => (list.sequence < best.sequence ? list : best));
    return { list: oldest, expired: oldest.expiration <= t };
  }
  const current = own.filter((list) => (list.effective ?? -Infinity) <= t && t < list.expiration);
  return current.length > 0 ? { list: highest(current), expired: false } : { list: highest(own), expired: true };
}

/**
 * The trusted UNL at `t` (spec 2.1): the validators named by at least `threshold` of the lists in use of
 * `publishers`. A publisher without a list does not count, and a list counts a validator once.
 */
export function trustedUnl(
  lists: readonly StoredUnlList[],
  publishers: readonly string[],
  threshold: number,
  t: number,
): Set<string> {
  const counts = new Map<string, number>();
  for (const publisher of publishers) {
    const inUse = listInUse(lists, publisher, t);
    if (!inUse) continue;
    for (const validator of new Set(inUse.list.validators)) counts.set(validator, (counts.get(validator) ?? 0) + 1);
  }
  const trusted = new Set<string>();
  for (const [validator, count] of counts) if (count >= threshold) trusted.add(validator);
  return trusted;
}
