import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { AccountPartitionRowsRow, AccountRollupStateRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import {
  DAY_GROUP_COLUMNS,
  DAY_GROUP_TABLES,
  DayGroupFamily,
  LedgerRangeOf,
  rawDayGroupsSql,
  UTC_DAY_MS,
  utcDayStart,
} from '../query/account-day-groups';
import { AggregateSetOptions, nextSetVersion, throwIfSetAborted } from './aggregate-sets';

/**
 * The account rollups of the heavy accounts (spec section 3.4): their day groups (`account-day-groups.ts`), kept per UTC day
 * in `account_lines_daily`, `account_tx_daily` and `account_trades_daily` so that a read of years does not read the
 * millions of rows behind them.
 *
 * A rollup of some accounts and days is a **set**: the rows of the three tables, then a sentinel for each (account, day)
 * in `account_rollup_days`, all under one version. A reader takes the rows of the version of each day's newest sentinel
 * (`AccountDayGroups`), so a set whose sentinel is not written yet (or never was: an abort, an error) is not read, and a
 * rewritten day is read from its newest set only. That holds because the row tables have `version` in their sorting key
 * (migration 003): a merge only collapses a row that was written twice, so the rows of the set a sentinel points to stay
 * where they are while a newer set is written beside them, and are not replaced by it. The old sets stay in the tables,
 * unread. `account_rollup_state` says which days of an account its rollups cover (`rollupCoverage`).
 * Which accounts and days are due, and when, is the runner's.
 *
 * Which accounts get rollups is decided by discovery (spec section 3.4, step 1): `balance_changes` is counted per account in
 * each of its partitions, and only the accounts with many rows in a partition are kept, in `account_partition_rows`.
 * A partition's accounts are a **set** too, counted one slice of the address space at a time (`countPartitionSlice`) and
 * written in one insert once all 58 are counted (`writePartitionSet`; `recountPartition` does both at once), and an account
 * is heavy when its rows over the newest set of every partition reach the minimum (`heavyAccounts`).
 */

/** What `account_rollup_state` holds for a heavy account, the newest row of it (`rollupStates`). */
export interface RollupState {
  account: string;
  /** Its balance changes, when they were counted. */
  rows: number;
  /** The day of its first balance change, `YYYY-MM-DD`. */
  firstDay: string;
  /** The days its rollups cover without a gap, both included; absent while it has none. */
  rolledFrom?: string;
  rolledThrough?: string;
  configVersion: number;
}

/** The newest state row of every account that has one. */
export async function rollupStates(ch: ClickHouseService): Promise<Map<string, RollupState>> {
  const rows = await ch.query<{
    account: string;
    rows: number | string;
    first_day: string;
    rolled_from: string | null;
    rolled_through: string | null;
    config_version: number | string;
  }>(
    `SELECT account, rows, first_day, rolled_from, rolled_through, config_version
       FROM ${Table.AccountRollupState}
      ORDER BY account, version DESC
      LIMIT 1 BY account`,
  );
  return new Map(
    rows.map((r): [string, RollupState] => [
      r.account,
      {
        account: r.account,
        rows: Number(r.rows),
        firstDay: r.first_day,
        ...(r.rolled_from !== null && { rolledFrom: r.rolled_from }),
        ...(r.rolled_through !== null && { rolledThrough: r.rolled_through }),
        configVersion: Number(r.config_version),
      },
    ]),
  );
}

/**
 * Writes the state rows in one insert, under one version: the table's own next one (the state of an account is its newest
 * row, and the states of many accounts are written together). An empty list writes nothing.
 */
export async function writeRollupStates(
  ch: ClickHouseService,
  states: RollupState[],
  options: AggregateSetOptions = {},
): Promise<void> {
  const { signal } = options;
  throwIfSetAborted(signal);
  if (states.length === 0) return;
  const version = await nextSetVersion(ch, Table.AccountRollupState, '1', {});
  throwIfSetAborted(signal);
  await ch.insert(
    Table.AccountRollupState,
    states.map(
      (s): AccountRollupStateRow => ({
        account: s.account,
        rows: s.rows,
        first_day: s.firstDay,
        rolled_from: s.rolledFrom ?? null,
        rolled_through: s.rolledThrough ?? null,
        config_version: s.configVersion,
        version,
      }),
    ),
  );
}

const FAMILIES: readonly DayGroupFamily[] = ['lines', 'txs', 'trades'];

/** The rows of the accounts and days of a `writeAccountRollups` call, in any of the rollup tables (all key on both). */
const OF_THESE_DAYS = 'account IN {dg_accounts:Array(String)} AND day BETWEEN {from:Date} AND {through:Date}';

/**
 * Rolls up the days `fromDay` to `throughDay` (`YYYY-MM-DD`, both included) of the accounts, as one set under one version:
 *  1. per table, a server-side `INSERT ... SELECT` of the raw day groups of all the accounts (`rawDayGroupsSql` for
 *     `many`: each row once, the text of the exact sums as the raw read gives it), so a rollup holds exactly the raw
 *     groups;
 *  2. then the sentinels, in one insert: an (account, day) that has rows of this version, or that had a sentinel before. A
 *     day that lost its rows is a sentinel with none, which is what hides the rows of its older set.
 *
 * The version is the next one over all four tables of the rollups for these accounts and days (`nextSetVersion` of each,
 * the largest): the clock in milliseconds, but past the newest version any of them holds. So a set never gets the
 * version of an attempt that failed after it wrote rows (its sentinel was never written, and its rows would otherwise
 * mix with the new ones), even when the clock of the server has stepped back. The rows of such an attempt are not read: no
 * sentinel names their version. A range of days with no ledger has no rows (the sentinels of its earlier sets are still
 * replaced). An aborted `signal` throws `AggregateSetAborted` before the work and before each insert; what an abort leaves
 * is rows without a sentinel, which nobody reads. Returns how many rows the three tables got (sentinels are not counted).
 */
export async function writeAccountRollups(
  ch: ClickHouseService,
  ranges: LedgerRangeOf,
  accounts: string[],
  fromDay: string,
  throughDay: string,
  options: AggregateSetOptions = {},
): Promise<number> {
  const { signal } = options;
  throwIfSetAborted(signal);
  const from = utcDayStart(fromDay);
  const through = utcDayStart(throughDay);
  const wanted = [...new Set(accounts)].sort();
  if (wanted.length === 0 || from > through) return 0;

  const range = await ranges(new Date(from), new Date(through + UTC_DAY_MS));
  const days = { dg_accounts: wanted, from: fromDay, through: throughDay };
  const version = Math.max(
    ...(await Promise.all(
      [Table.AccountRollupDays, ...FAMILIES.map((family) => DAY_GROUP_TABLES[family])].map((table) =>
        nextSetVersion(ch, table, OF_THESE_DAYS, days),
      ),
    )),
  );

  let written = 0;
  if (range !== null) {
    const raw = { dg_accounts: wanted, dg_min0: range.min, dg_max0: range.max };
    for (const family of FAMILIES) {
      throwIfSetAborted(signal);
      const table = DAY_GROUP_TABLES[family];
      const columns = ['account', ...DAY_GROUP_COLUMNS[family], 'version'].join(', ');
      await ch.command(
        `INSERT INTO ${table} (${columns})
         SELECT ${['account', ...DAY_GROUP_COLUMNS[family]].join(', ')}, {version:UInt64}
           FROM (${rawDayGroupsSql(family, { accounts: 'many', ranges: 1 })})`,
        { ...raw, version },
      );
    }
    const [counted] = await ch.query<{ n: number | string }>(
      `SELECT ${FAMILIES.map(
        (family) =>
          `(SELECT count() FROM ${DAY_GROUP_TABLES[family]} WHERE ${OF_THESE_DAYS} AND version = {version:UInt64})`,
      ).join(' + ')} AS n`,
      { ...days, version },
    );
    written = Number(counted?.n ?? 0);
  }

  // the days of the set: those with rows of this version, and those that had a sentinel (and now have none or have rows)
  throwIfSetAborted(signal);
  await ch.command(
    `INSERT INTO ${Table.AccountRollupDays} (account, day, version)
     SELECT account, day, {version:UInt64}
       FROM (${[
         ...FAMILIES.map(
           (family) =>
             `SELECT account, day FROM ${DAY_GROUP_TABLES[family]} WHERE ${OF_THESE_DAYS} AND version = {version:UInt64}`,
         ),
         `SELECT account, day FROM ${Table.AccountRollupDays} WHERE ${OF_THESE_DAYS}`,
       ].join(' UNION DISTINCT ')})`,
    { ...days, version },
  );
  return written;
}

/** The accounts with at least this many balance changes in a partition are kept in its set; the others are not counted. */
export const ACCOUNT_PARTITION_ROWS_FLOOR = 10_000;

/** A promotion slice (`promotionSlice`) holds about this many rows of an account. */
export const ACCOUNT_ROLLUP_SLICE_ROWS = 2_000_000;

/** The ledgers in a partition of `balance_changes` (`PARTITION BY intDiv(ledger_index, 10000000)`, migration 001). */
export const BALANCE_PARTITION_LEDGERS = 10_000_000;

/**
 * The characters an address can have after its first one (every address starts with `r`): the 58 of the base58 alphabet, in
 * code-point order. Slice i of a recount is the key range from `r` + the i-th of them up to `r` + the next, so that the
 * 58 slices together are every account there can be: the first has no lower bound, the last no upper one.
 */
export const ADDRESS_SLICE_CHARS: readonly string[] = [...'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'];

/** The partition of `balance_changes` a ledger is in (the `partition` of `account_partition_rows`). */
export function partitionOf(ledgerIndex: number): number {
  return Math.floor(ledgerIndex / BALANCE_PARTITION_LEDGERS);
}

/** An account a recount keeps, and its balance changes in the partition. */
export interface PartitionAccountRows {
  account: string;
  rows: number;
}

/**
 * Counts the balance changes of every account of one slice of a partition and returns the accounts with at least
 * `ACCOUNT_PARTITION_ROWS_FLOOR` of them; writes nothing. Slice i (0 to 57) is the key range of `balance_changes` from `r` +
 * the i-th of `ADDRESS_SLICE_CHARS` up to `r` + the next one, within the partition's ledgers, so that no read has to hold the
 * accounts of a whole partition. The count is of rows as stored: a row that was written twice and is not merged yet counts
 * twice, which is fine for a threshold. A slice that is not one of the 58 is a `RangeError`; an aborted `signal` throws
 * `AggregateSetAborted`, both before the read.
 */
export async function countPartitionSlice(
  ch: ClickHouseService,
  partition: number,
  slice: number,
  options: AggregateSetOptions = {},
): Promise<PartitionAccountRows[]> {
  const last = ADDRESS_SLICE_CHARS.length - 1;
  if (!Number.isInteger(slice) || slice < 0 || slice > last) {
    throw new RangeError(`A slice of a partition is 0 to ${last}, not ${slice}`);
  }
  throwIfSetAborted(options.signal);
  const found = await ch.query<{ account: string; n: number | string }>(
    `SELECT account, count() AS n
       FROM ${Table.BalanceChanges}
      WHERE ${[
        'ledger_index BETWEEN {p_min:UInt32} AND {p_max:UInt32}',
        ...(slice > 0 ? ['account >= {lo:String}'] : []),
        ...(slice < last ? ['account < {hi:String}'] : []),
      ].join(' AND ')}
      GROUP BY account
     HAVING count() >= {floor:UInt64}`,
    {
      p_min: partition * BALANCE_PARTITION_LEDGERS,
      p_max: (partition + 1) * BALANCE_PARTITION_LEDGERS - 1,
      floor: ACCOUNT_PARTITION_ROWS_FLOOR,
      ...(slice > 0 && { lo: `r${ADDRESS_SLICE_CHARS[slice]}` }),
      ...(slice < last && { hi: `r${ADDRESS_SLICE_CHARS[slice + 1]}` }),
    },
  );
  return found.map((r) => ({ account: r.account, rows: Number(r.n) }));
}

/**
 * Writes the set of a partition: the accounts its 58 slices kept (`countPartitionSlice`), plus the sentinel (`account = ''`,
 * `rows` 0), in one insert under one version (the newest set's plus one at least: `nextSetVersion`), so that a reader never
 * sees a part of a set. Returns how many accounts it wrote. An aborted `signal` throws `AggregateSetAborted` before the version
 * read and before the insert; an abort writes nothing.
 */
export async function writePartitionSet(
  ch: ClickHouseService,
  partition: number,
  accounts: readonly PartitionAccountRows[],
  options: AggregateSetOptions = {},
): Promise<number> {
  const { signal } = options;
  throwIfSetAborted(signal);
  const version = await nextSetVersion(ch, Table.AccountPartitionRows, 'partition = {partition:UInt16}', { partition });
  throwIfSetAborted(signal);
  await ch.insert<AccountPartitionRowsRow>(Table.AccountPartitionRows, [
    ...accounts.map((r): AccountPartitionRowsRow => ({ partition, account: r.account, rows: r.rows, version })),
    { partition, account: '', rows: 0, version },
  ]);
  return accounts.length;
}

/**
 * Counts the balance changes of every account in a partition, all 58 slices one after the other (`countPartitionSlice`), and
 * writes the set of the partition (`writePartitionSet`). Returns the accounts kept. An aborted `signal` throws
 * `AggregateSetAborted` before each read and before the insert; an abort writes nothing. The `account_rollups` runner does not
 * call it: it counts a few slices a tick and writes the set once all of them are counted.
 */
export async function recountPartition(
  ch: ClickHouseService,
  partition: number,
  options: AggregateSetOptions = {},
): Promise<number> {
  const heavy: PartitionAccountRows[] = [];
  for (let slice = 0; slice < ADDRESS_SLICE_CHARS.length; slice++) {
    heavy.push(...(await countPartitionSlice(ch, partition, slice, options)));
  }
  return writePartitionSet(ch, partition, heavy, options);
}

/**
 * The rows of the newest set of every partition: a partition's sentinel (`account = ''`) says its newest version, and only
 * rows of that version are read, so that the row of an older set (of an account that has since dropped below the floor)
 * does not count. A set is one insert, so a partition whose sentinel is there has all its rows.
 */
const NEWEST_SETS = `(partition, version) IN (
          SELECT partition, max(version) FROM ${Table.AccountPartitionRows} WHERE account = '' GROUP BY partition)`;

/** The version (ms) of the newest set of every partition that has one. */
export async function partitionSetVersions(ch: ClickHouseService): Promise<Map<number, number>> {
  const rows = await ch.query<{ partition: number | string; version: number | string }>(
    `SELECT partition, max(version) AS version
       FROM ${Table.AccountPartitionRows}
      WHERE account = ''
      GROUP BY partition`,
  );
  return new Map(rows.map((r): [number, number] => [Number(r.partition), Number(r.version)]));
}

/**
 * The heavy accounts: the rows of each account summed over the newest set of every partition, kept when the sum is at least
 * `minRows`. An account is in a set only for a partition where it has `ACCOUNT_PARTITION_ROWS_FLOOR` rows or more, so a
 * `minRows` under the floor still misses an account that has fewer than that in every partition. Each row of a set is
 * read once, though its insert was repeated.
 */
export async function heavyAccounts(ch: ClickHouseService, minRows: number): Promise<Map<string, number>> {
  const rows = await ch.query<{ account: string; total: number | string }>(
    `SELECT account, sum(account_rows) AS total
       FROM (SELECT partition, account, rows AS account_rows
               FROM ${Table.AccountPartitionRows}
              WHERE account != '' AND ${NEWEST_SETS}
              LIMIT 1 BY partition, account)
      GROUP BY account
     HAVING total >= {min_rows:UInt64}`,
    { min_rows: minRows },
  );
  return new Map(rows.map((r): [string, number] => [r.account, Number(r.total)]));
}

/** The rows an account has in each partition whose newest set holds it (a partition where it is under the floor has none). */
export async function accountPartitionRows(ch: ClickHouseService, account: string): Promise<Map<number, number>> {
  const rows = await ch.query<{ partition: number | string; account_rows: number | string }>(
    `SELECT partition, rows AS account_rows
       FROM ${Table.AccountPartitionRows}
      WHERE account = {account:String} AND account != '' AND ${NEWEST_SETS}
      ORDER BY partition
      LIMIT 1 BY partition`,
    { account },
  );
  return new Map(rows.map((r): [number, number] => [Number(r.partition), Number(r.account_rows)]));
}

/**
 * The UTC day (`YYYY-MM-DD`) of an account's first balance change, undefined when it has none: a read of one row in key order
 * (the primary key is the account, then the ledger), whatever the account's history.
 */
export async function firstChangeDay(ch: ClickHouseService, account: string): Promise<string | undefined> {
  const [row] = await ch.query<{ day: string }>(
    `SELECT toString(toDate(close_time, 'UTC')) AS day
       FROM ${Table.BalanceChanges}
      WHERE account = {account:String}
      ORDER BY account, ledger_index, tx_index, node_index
      LIMIT 1`,
    { account },
  );
  return row?.day;
}

/**
 * The UTC days the ledgers of a partition span, first day and last day included, at least 1 (a partition with one ledger or
 * none). With an account's rows in the partition it gives the rows per day for `promotionSlice`.
 */
export async function partitionDays(ch: ClickHouseService, partition: number): Promise<number> {
  const [row] = await ch.query<{ days: number | string }>(
    `SELECT dateDiff('day', toDate(min(close_time), 'UTC'), toDate(max(close_time), 'UTC')) + 1 AS days
       FROM ${Table.Ledgers}
      WHERE ledger_index BETWEEN {p_min:UInt32} AND {p_max:UInt32}`,
    { p_min: partition * BALANCE_PARTITION_LEDGERS, p_max: (partition + 1) * BALANCE_PARTITION_LEDGERS - 1 },
  );
  return Math.max(1, Number(row?.days ?? 1));
}

/**
 * The UTC day (`YYYY-MM-DD`) of the first ledger of a partition of `balance_changes`, undefined when the partition has no
 * ledger. A promotion slice never starts before it: the count of an account in the partition says how many rows a day holds
 * there, and says nothing of the partitions before it.
 */
export async function partitionFirstDay(ch: ClickHouseService, partition: number): Promise<string | undefined> {
  const row = await ch.queryOne<{ day: string; n: number | string }>(
    `SELECT toString(toDate(min(close_time), 'UTC')) AS day, count() AS n
       FROM ${Table.Ledgers}
      WHERE ledger_index BETWEEN {p_min:UInt32} AND {p_max:UInt32}`,
    { p_min: partition * BALANCE_PARTITION_LEDGERS, p_max: (partition + 1) * BALANCE_PARTITION_LEDGERS - 1 },
  );
  return row === undefined || Number(row.n) === 0 ? undefined : row.day;
}

/**
 * The next slice of a promotion, backwards from `throughDay`: as many whole days as hold about `ACCOUNT_ROLLUP_SLICE_ROWS`
 * rows at `rowsPerDay`, at least one, and never before `firstDay` (the account's first day). All days are `YYYY-MM-DD`. Rows
 * per day of 0 (unknown) take everything back to the first day.
 */
export function promotionSlice(o: { firstDay: string; throughDay: string; rowsPerDay: number }): {
  fromDay: string;
  throughDay: string;
} {
  const first = utcDayStart(o.firstDay);
  const through = utcDayStart(o.throughDay);
  const days = o.rowsPerDay > 0 ? Math.max(1, Math.floor(ACCOUNT_ROLLUP_SLICE_ROWS / o.rowsPerDay)) : Infinity;
  return {
    fromDay: new Date(Math.max(first, through - (days - 1) * UTC_DAY_MS)).toISOString().slice(0, 10),
    throughDay: o.throughDay,
  };
}
