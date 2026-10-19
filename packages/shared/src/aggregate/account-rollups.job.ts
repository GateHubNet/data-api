import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { AccountRollupStateRow } from '../clickhouse/rows';
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
