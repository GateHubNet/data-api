import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { allSettledOrThrow, wait } from '../util/helpers';

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
 * Every table whose rows belong to one ledger: the 19 ledger-derived tables of the baseline schema (the 14 of the
 * Ripple v2 data and the 5 AMM ledger tables), `account_states` (migration 005), `trust_line_states` (006),
 * `path_payments` (007) and `account_path_payments` (008), the ones that carry a `ledger_index` column and a dedup
 * window. Fee stats, validations, manifests, aggregates (`amm_pools` and `amm_daily` among them) and the bookkeeping
 * tables are not in the list, because a ledger's rewrite must not touch them.
 *
 * The first entry is the commit marker (`ledgers`): a ledger is deleted by removing that row first, so a delete that
 * dies halfway leaves uncommitted rows behind, which recovery removes, and never a committed ledger with missing rows.
 * The partitioning mirrors the schema files; the e2e suite compares the two.
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
  { table: Table.AmmPoolStates, partitionSize: P7 },
  { table: Table.AmmPoolTouches, partitionSize: P6 },
  { table: Table.AmmLiquidity, partitionSize: P7 },
  { table: Table.AccountAmmLiquidity, partitionSize: P7 },
  { table: Table.AmmGovernance, partitionSize: P7 },
  { table: Table.AccountStates, partitionSize: P7 },
  { table: Table.TrustLineStates, partitionSize: P7 },
  { table: Table.PathPayments, partitionSize: P6 },
  { table: Table.AccountPathPayments, partitionSize: P7 },
];

export interface DeleteOptions {
  /**
   * Tags each DELETE with the query_id `${queryIdPrefix}:delete:${table}:${partition}` (`all` for an unpartitioned
   * table), so that `awaitQuiescence(ch, queryIdPrefix)` can wait for it and, if need be, kill it.
   */
  queryIdPrefix?: string;
}

/**
 * Passed on every lightweight DELETE so that no server profile can make it asynchronous: the statement then returns
 * only once the mutation has been applied (`lightweight_deletes_sync` is the 26.8 name; 2 = wait for all replicas).
 */
const SYNC_DELETE = { lightweight_deletes_sync: '2' } as const;

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

/** The lowest ledger whose `ledgers` row exists; `undefined` when none is (`minOrNull(ledger_index)`). */
export async function firstCommittedLedger(ch: ClickHouseService): Promise<number | undefined> {
  const row = await ch.queryOne<{ first_ledger: number | string | null }>(
    `SELECT minOrNull(ledger_index) AS first_ledger FROM ${Table.Ledgers}`,
  );
  return row?.first_ledger == null ? undefined : Number(row.first_ledger);
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
 * Recovery is a contract, see `LedgerWriter`: `awaitQuiescence` of the failed run first, this, `awaitQuiescence` of
 * `opts.queryIdPrefix`, then a writer from `withNewRunId()`. The dedup log of the tables outlives the DELETE, so a writer
 * that keeps its `runId` has its rows dropped as replays of the attempt that was just cleaned up.
 */
export async function deleteLedgersAbove(
  ch: ClickHouseService,
  checkpoint: number,
  opts: DeleteOptions = {},
): Promise<void> {
  requireLedgerIndex(checkpoint, 'checkpoint');
  if (checkpoint === MAX_LEDGER_INDEX) return;
  await deleteWhere(ch, 'ledger_index > {checkpoint:UInt32}', { checkpoint }, checkpoint + 1, undefined, opts);
}

/**
 * Delete every row of the ledgers `from` to `to` (both inclusive) from every ledger-keyed table, to rewrite them with a
 * writer from `withNewRunId()` (see `deleteLedgersAbove` for the contract).
 */
export async function deleteLedgerRange(
  ch: ClickHouseService,
  from: number,
  to: number,
  opts: DeleteOptions = {},
): Promise<void> {
  requireLedgerIndex(from, 'ledger range start');
  requireLedgerIndex(to, 'ledger range end');
  if (from > to) throw new RangeError(`Invalid ledger range ${from}-${to}: the start is after the end`);
  await deleteWhere(ch, 'ledger_index >= {from:UInt32} AND ledger_index <= {to:UInt32}', { from, to }, from, to, opts);
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
  highest: number | undefined,
  opts: DeleteOptions,
): Promise<void> {
  const [marker, ...others] = LEDGER_KEYED_TABLES;
  await deleteFromTable(ch, marker, predicate, params, lowest, highest, opts);
  await allSettledOrThrow(others.map((t) => deleteFromTable(ch, t, predicate, params, lowest, highest, opts)));
}

async function deleteFromTable(
  ch: ClickHouseService,
  { table, partitionSize }: LedgerKeyedTable,
  predicate: string,
  params: Record<string, unknown>,
  lowest: number,
  highest: number | undefined,
  { queryIdPrefix }: DeleteOptions,
): Promise<void> {
  const commandOptions = (partition: string) => ({
    ...(queryIdPrefix !== undefined && { queryId: `${queryIdPrefix}:delete:${table}:${partition}` }),
    settings: SYNC_DELETE,
  });

  if (partitionSize === undefined) {
    await ch.command(`DELETE FROM ${table} WHERE ${predicate}`, params, commandOptions('all'));
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
    await ch.command(
      `DELETE FROM ${table} IN PARTITION ID {partition:String} WHERE ${predicate}`,
      { ...params, partition },
      commandOptions(partition),
    );
  }
}

export interface QuiescenceOptions {
  /** How long to wait before killing what still runs, and again how long to wait after the kill. Default 60000. */
  timeoutMs?: number;
  /** Pause between two looks at the server. Default 250. */
  pollMs?: number;
}

/**
 * Wait until the server is no longer working on anything a failed attempt started: no running query whose `query_id`
 * is `queryIdPrefix` or starts with `${queryIdPrefix}:` (the ids of a `LedgerWriter` run and of the deletes tagged with
 * a `queryIdPrefix`), and no unfinished mutation on the ledger-keyed tables (an abandoned lightweight DELETE is one).
 *
 * A client-side timeout does not stop the statement on the server. Without this wait, an INSERT of the failed attempt
 * can land after the recovery's DELETE, and a DELETE can still be running when the rewrite starts.
 *
 * After `timeoutMs` the queries that still match are killed (`KILL QUERY ... SYNC`) and the mutations get `timeoutMs`
 * more. If they are not done by then, this throws; the caller retries. A mutation is not killed, because the delete it
 * carries is wanted. Only the id part is matched, so a run `abc` does not wait for, or kill, a run `abcd`.
 */
export async function awaitQuiescence(
  ch: ClickHouseService,
  queryIdPrefix: string,
  opts: QuiescenceOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 250;
  if (typeof queryIdPrefix !== 'string' || queryIdPrefix === '') {
    throw new Error('awaitQuiescence needs a non-empty query id prefix: an empty one would match every query');
  }
  if (!(timeoutMs >= 0) || !(pollMs > 0)) {
    throw new RangeError(`Invalid awaitQuiescence options: timeoutMs ${timeoutMs}, pollMs ${pollMs}`);
  }

  const match = { exact: queryIdPrefix, nested: `${queryIdPrefix}:` };
  const tables = LEDGER_KEYED_TABLES.map((t) => t.table);
  const idle = async (): Promise<boolean> => {
    const row = await ch.queryOne<{ queries: number | string; mutations: number | string }>(
      `SELECT
         (SELECT count() FROM system.processes WHERE query_id = {exact:String} OR startsWith(query_id, {nested:String})) AS queries,
         (SELECT count() FROM system.mutations
           WHERE database = currentDatabase() AND table IN {tables:Array(String)} AND is_done = 0) AS mutations`,
      { ...match, tables },
    );
    return Number(row?.queries) === 0 && Number(row?.mutations) === 0;
  };

  if (await pollUntil(idle, timeoutMs, pollMs)) return;

  await ch.command(`KILL QUERY WHERE query_id = {exact:String} OR startsWith(query_id, {nested:String}) SYNC`, match);
  if (await pollUntil(idle, timeoutMs, pollMs)) return;

  const stuck = await ch.query<{ table: string; mutation_id: string; latest_fail_reason: string }>(
    `SELECT table, mutation_id, latest_fail_reason FROM system.mutations
      WHERE database = currentDatabase() AND table IN {tables:Array(String)} AND is_done = 0 LIMIT 5`,
    { tables },
  );
  const running = await ch.queryOne<{ n: number | string }>(
    'SELECT count() AS n FROM system.processes WHERE query_id = {exact:String} OR startsWith(query_id, {nested:String})',
    match,
  );
  throw new Error(
    `The ledger tables are not quiescent after ${timeoutMs}ms, a KILL QUERY and ${timeoutMs}ms more: ` +
      `${Number(running?.n)} queries under "${queryIdPrefix}" still running, unfinished mutations ` +
      `${JSON.stringify(stuck)}. Retry.`,
  );
}

/** Poll `check` every `pollMs` until it is true (then true) or `timeoutMs` has passed (then false). */
async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await wait(Math.min(pollMs, left));
  }
}
