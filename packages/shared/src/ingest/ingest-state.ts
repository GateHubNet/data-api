import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { allSettledOrThrow } from '../util/helpers';

/** Ledgers per partition of the ledger-prefixed tables: `PARTITION BY intDiv(ledger_index, 1000000)`. */
const P6 = 1_000_000;
/** Ledgers per partition of the secondary and prefix-keyed tables: `PARTITION BY intDiv(ledger_index, 10000000)`. */
const P7 = 10_000_000;

const MAX_LEDGER_INDEX = 2 ** 32 - 1;

export interface LedgerKeyedTable {
  table: Table;
  /** Ledgers per partition, i.e. the table is `PARTITION BY intDiv(ledger_index, partitionSize)`. Unset: unpartitioned. */
  partitionSize?: number;
}

/**
 * Every table whose rows belong to one ledger: the 14 ledger-derived tables of the baseline schema, the ones that carry
 * a `ledger_index` column and a dedup window. Fee stats, validations, manifests, aggregates and the bookkeeping tables
 * are not in the list, because a ledger's rewrite must not touch them.
 *
 * The first entry is the commit marker (`ledgers`): a ledger is deleted by removing that row first, so a delete that
 * dies halfway leaves uncommitted rows behind, which recovery removes, and never a committed ledger with missing rows.
 * The partitioning mirrors `schema/001_baseline.sql`; the e2e suite compares the two.
 */
export const LEDGER_KEYED_TABLES: ReadonlyArray<LedgerKeyedTable> = [
  { table: Table.Ledgers, partitionSize: P6 },
  { table: Table.LedgerByHash, partitionSize: P7 },
  { table: Table.Transactions, partitionSize: P6 },
  { table: Table.TxByHash, partitionSize: P7 },
  { table: Table.TxByType, partitionSize: P7 },
  { table: Table.AccountTransactions, partitionSize: P7 },
  { table: Table.AccountTxBySequence, partitionSize: P7 },
  { table: Table.Payments, partitionSize: P6 },
  { table: Table.PaymentsByCurrency, partitionSize: P7 },
  { table: Table.AccountPayments, partitionSize: P7 },
  { table: Table.Exchanges, partitionSize: P7 },
  { table: Table.AccountExchanges, partitionSize: P7 },
  { table: Table.BalanceChanges, partitionSize: P7 },
  { table: Table.AccountsCreated },
];

function requireLedgerIndex(value: number, name = 'ledger index'): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_LEDGER_INDEX) {
    throw new RangeError(`Invalid ${name} ${value}: expected an integer from 0 to ${MAX_LEDGER_INDEX} (UInt32)`);
  }
}

/** The highest ledger whose `ledgers` row exists, i.e. the highest committed ledger; `undefined` when none is. */
export async function committedCheckpoint(ch: ClickHouseService): Promise<number | undefined> {
  const row = await ch.queryOne<{ checkpoint: number | string | null }>(
    `SELECT maxOrNull(ledger_index) AS checkpoint FROM ${Table.Ledgers}`,
  );
  return row?.checkpoint == null ? undefined : Number(row.checkpoint);
}

/** The hash stored for a committed ledger, or `undefined` when the ledger is not committed. */
export async function storedLedgerHash(ch: ClickHouseService, index: number): Promise<string | undefined> {
  requireLedgerIndex(index);
  const row = await ch.queryOne<{ ledger_hash: string }>(
    `SELECT ledger_hash FROM ${Table.Ledgers} WHERE ledger_index = {index:UInt32} ORDER BY ingested_at DESC LIMIT 1`,
    { index },
  );
  return row?.ledger_hash;
}

/**
 * Delete every row of the ledgers above `checkpoint` from every ledger-keyed table: the recovery step after a failed or
 * interrupted write. Pass `committedCheckpoint()`.
 *
 * A write that failed after its child rows went in leaves rows of uncommitted ledgers behind. The child tables are
 * ReplacingMergeTree, so rewriting without deleting would only collapse the duplicates at some later merge; reads
 * (which never use FINAL) would see them in the meantime.
 *
 * The rewrite must then use a **new `LedgerWriter`**: the dedup log of the tables outlives the DELETE, and a writer
 * that keeps its `runId` would have its rows dropped as replays of the attempt that was just cleaned up.
 */
export async function deleteLedgersAbove(ch: ClickHouseService, checkpoint: number): Promise<void> {
  requireLedgerIndex(checkpoint, 'checkpoint');
  if (checkpoint === MAX_LEDGER_INDEX) return;
  await deleteWhere(ch, 'ledger_index > {checkpoint:UInt32}', { checkpoint }, checkpoint + 1);
}

/**
 * Delete every row of the ledgers `from` to `to` (both inclusive) from every ledger-keyed table, to rewrite them with a
 * new `LedgerWriter` (see `deleteLedgersAbove` for why it must be a new one).
 */
export async function deleteLedgerRange(ch: ClickHouseService, from: number, to: number): Promise<void> {
  requireLedgerIndex(from, 'ledger range start');
  requireLedgerIndex(to, 'ledger range end');
  if (from > to) throw new RangeError(`Invalid ledger range ${from}-${to}: the start is after the end`);
  await deleteWhere(ch, 'ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}', { from, to }, from, to);
}

/**
 * Ledgers in `[from, to]` that have no `ledgers` row, ascending. Only the commit marker counts: a ledger whose child
 * rows are there without it is missing. The result has one number per missing ledger, so mind the size of the range.
 */
export async function missingLedgers(ch: ClickHouseService, from: number, to: number): Promise<number[]> {
  requireLedgerIndex(from, 'ledger range start');
  requireLedgerIndex(to, 'ledger range end');
  if (from > to) return [];
  const rows = await ch.query<{ missing: number | string }>(
    `SELECT toUInt32({from:UInt32} + number) AS missing
       FROM numbers({total:UInt64})
      WHERE missing NOT IN (
        SELECT ledger_index FROM ${Table.Ledgers} WHERE ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}
      )
      ORDER BY missing`,
    { from, to, total: to - from + 1 },
  );
  return rows.map((r) => Number(r.missing));
}

/**
 * Lightweight-DELETE the rows matching `predicate` from every ledger-keyed table. `lowest` and `highest` bound the
 * ledgers the predicate can match (`highest` unset: no upper bound); they only choose which partitions to visit.
 *
 * A partitioned table gets one `DELETE ... IN PARTITION ID` per existing partition that can hold such a ledger, so the
 * mutation reads those partitions only and never the history. The partitions come from `system.parts`, which makes an
 * unbounded "everything above" delete as cheap as a bounded one. The unpartitioned table gets a plain DELETE.
 *
 * The commit marker goes first and alone, then the other tables run in parallel; all of them finish before an error is
 * thrown, so a caller that retries never races a delete of the failed attempt.
 */
async function deleteWhere(
  ch: ClickHouseService,
  predicate: string,
  params: Record<string, unknown>,
  lowest: number,
  highest?: number,
): Promise<void> {
  const [marker, ...others] = LEDGER_KEYED_TABLES;
  await deleteFromTable(ch, marker, predicate, params, lowest, highest);
  await allSettledOrThrow(others.map((t) => deleteFromTable(ch, t, predicate, params, lowest, highest)));
}

async function deleteFromTable(
  ch: ClickHouseService,
  { table, partitionSize }: LedgerKeyedTable,
  predicate: string,
  params: Record<string, unknown>,
  lowest: number,
  highest: number | undefined,
): Promise<void> {
  if (partitionSize === undefined) {
    await ch.command(`DELETE FROM ${table} WHERE ${predicate}`, params);
    return;
  }

  const lowestPartition = Math.floor(lowest / partitionSize);
  const highestPartition = highest === undefined ? Infinity : Math.floor(highest / partitionSize);
  const partitions = await ch.query<{ partition: string }>(
    `SELECT DISTINCT partition_id AS partition FROM system.parts
      WHERE database = currentDatabase() AND table = {table:String} AND active`,
    { table },
  );
  for (const { partition } of partitions) {
    const id = Number(partition);
    if (!Number.isInteger(id)) {
      throw new Error(
        `Table ${table} has a partition "${partition}" that is not a number: was its partition key changed?`,
      );
    }
    if (id < lowestPartition || id > highestPartition) continue;
    await ch.command(`DELETE FROM ${table} IN PARTITION ID {partition:String} WHERE ${predicate}`, {
      ...params,
      partition,
    });
  }
}
