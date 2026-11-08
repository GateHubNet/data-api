import { stateCoverageStart } from '../aggregate/tokens.job';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { firstCommittedLedger } from '../ingest/ingest-state';

/**
 * Where a generation of the token history starts (spec 4.6): the first ledger of the newest unbroken run of stored ledgers that
 * reaches the head, and never below the state coverage. Unbroken means no ledger number is missing, because the token history adds
 * levels up ledger by ledger and a missing ledger would be wrong in every figure after it.
 */

/** The `run_id` prefix of the live runner's first-write intents in `ingest_log` (`LIVE_INTENT_PREFIX` of the syncer's live runner). */
export const LIVE_INTENT_RUN_PREFIX = 'live:';

const RANGE_DISTINCT_SQL = `SELECT toString(groupBitmap(ledger_index)) AS n
  FROM ${Table.Ledgers}
 WHERE ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}`;

/**
 * Whether every ledger of `[from, to]` is stored: the number of distinct ledgers of the key range is its span. A ledger stored twice
 * (a re-ingest before the merge) counts once, so no duplicate can make up for a missing ledger. `groupBitmap` counts them exactly in
 * a roaring bitmap (about a bit a ledger for a dense run): on 90 million ledgers 0.08 s, where `count()` and `sum()` took 0.04 s
 * and `uniqExact` 0.25 s.
 */
async function wholeRange(ch: ClickHouseService, from: number, to: number): Promise<boolean> {
  const row = await ch.queryOne<{ n: string }>(RANGE_DISTINCT_SQL, { from, to });
  return BigInt(row?.n ?? '0') === BigInt(to - from + 1);
}

/**
 * The first ledger of the unbroken run of stored ledgers that ends at `head`: the lowest `a` with every ledger of `[a, head]`
 * stored, by a binary search over range counts. `undefined` when `head` is not stored.
 */
export async function unbrokenRunStart(ch: ClickHouseService, head: number): Promise<number | undefined> {
  const first = await firstCommittedLedger(ch);
  if (first === undefined || first > head || !(await wholeRange(ch, head, head))) return undefined;
  let lo = first;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await wholeRange(ch, mid, head)) hi = mid;
    else lo = mid + 1;
  }
  return hi;
}

/** A generation's `coverage_from` (spec 4.6): `max(stateCoverageStart, unbrokenRunStart(head))`, `undefined` without either. */
export async function tokenHistoryCoverageFrom(ch: ClickHouseService, head: number): Promise<number | undefined> {
  const [state, run] = await Promise.all([stateCoverageStart(ch), unbrokenRunStart(ch, head)]);
  if (state === undefined || run === undefined) return undefined;
  return Math.max(state, run);
}

/**
 * Whether a `range-ingest` is in progress: an `ingest_log` range whose newest row says `started`. The live runner's first-write
 * intents are no range and are left out.
 */
export async function rangeIngestRunning(ch: ClickHouseService): Promise<boolean> {
  const rows = await ch.query<{ range_start: number }>(
    `SELECT range_start
       FROM ${Table.IngestLog}
      WHERE NOT startsWith(run_id, {live:String})
      GROUP BY range_start, range_end
     HAVING argMax(status, updated_at) = 'started'
      LIMIT 1`,
    { live: LIVE_INTENT_RUN_PREFIX },
  );
  return rows.length > 0;
}
