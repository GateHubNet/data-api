import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Table } from '../clickhouse/tables';
import { EXACT_SCALE, exactAmount, exactSum, floatSum, VOLUME_SOURCE_COLUMNS } from './decimal';
import { LedgerRange } from './rates.service';

/**
 * What an account aggregate reads: **day groups**, one group per UTC day and group key of the account's balance changes
 * (`lines`), of the transactions it sent (`txs`) and of its trades (`trades`), from one of two sources that give identical
 * groups.
 *
 *  - The **raw** source is the account's key range in `balance_changes`, `account_transactions` or `account_exchanges`:
 *    the primary key starts with the account, so a window is one range of keys per part. The tables are not collapsed
 *    before a merge and no FINAL is used (it would read and merge the rest of every part), so the rows come out of a
 *    subquery ordered by the whole key, which `LIMIT 1 BY` the rest of the key makes one row each (as the account reads of
 *    the API do): a row written twice counts once.
 *  - The **rollup** source is the same groups, kept per day for a heavy account by the aggregator (`account_<family>_daily`,
 *    written by `writeAccountRollups`): the rows of the version of each day's sentinel in `account_rollup_days`.
 *
 * `AccountDayGroups.source` gives the groups of a window of days: the rollup for the days the account's state row covers,
 * the raw source for the rest of the window (at most two ranges of ledgers). Both give the same columns, with exact sums as
 * text (`'0'` when no amount is exact) and their Float64 shadows, so a route that merges them (`mergedExactSum`, `sumOf`)
 * answers as it would from the raw rows alone: a rollup is invisible. The amounts are `Decimal256(30)` sums with the
 * fallback of `decimal.ts`; a rollup stores the very text the raw read would give.
 */

/** The version of what a rollup means: a state row of another version has no coverage, and the account is rolled again. */
export const ACCOUNT_ROLLUP_CONFIG_VERSION = 1;

/** What a day group is made of: the balance changes of a line, the transactions sent, or the trades of a pair. */
export type DayGroupFamily = 'lines' | 'txs' | 'trades';

/**
 * The columns every day-group subquery selects, in this order, from either source. `day` is a `Date`; the sums are exact
 * text, `'0'` when there is no exact term; `*_f` are their Float64 shadows.
 */
export const DAY_GROUP_COLUMNS: Record<DayGroupFamily, readonly string[]> = {
  lines: [
    'day',
    'currency',
    'counterparty',
    'change_type',
    'owes',
    'count',
    'in_sum',
    'out_sum',
    'unfit',
    'in_sum_f',
    'out_sum_f',
    'end_balance',
  ],
  txs: ['day', 'tx_type', 'result', 'count'],
  trades: [
    'day',
    'base_currency',
    'base_issuer',
    'counter_currency',
    'counter_issuer',
    'count',
    'base_sum',
    'counter_sum',
    'bought_sum',
    'sold_sum',
    'bought_counter_sum',
    'sold_counter_sum',
    'unfit',
    'base_sum_f',
    'counter_sum_f',
    'bought_sum_f',
    'sold_sum_f',
    'bought_counter_sum_f',
    'sold_counter_sum_f',
  ],
};

/** The table of a family's rollup, and the columns that make a group (the table's key after `account`). */
export const DAY_GROUP_TABLES: Record<DayGroupFamily, Table> = {
  lines: Table.AccountLinesDaily,
  txs: Table.AccountTxDaily,
  trades: Table.AccountTradesDaily,
};

const GROUP_KEY: Record<DayGroupFamily, readonly string[]> = {
  lines: ['day', 'currency', 'counterparty', 'change_type', 'owes'],
  txs: ['day', 'tx_type', 'result'],
  trades: ['day', 'base_currency', 'base_issuer', 'counter_currency', 'counter_issuer'],
};

/** The first day of a read of "everything up to" a day. */
export const DAY_GROUPS_EPOCH = '2000-01-01';

/** The days an account's rollups cover without a gap, both included (`YYYY-MM-DD`). */
export interface RollupCoverage {
  from: string;
  through: string;
}

/** The ledgers of the days `[from, toExclusive)`, `null` when none closed in them (`RatesService.ledgersClosedIn`). */
export type LedgerRangeOf = (from: Date, toExclusive: Date) => Promise<LedgerRange | null>;

/**
 * The days the rollups of an account cover: the days of its newest state row, when that row is of the current config
 * version and has both of them. The newest row decides before its version and days are looked at, so that an older row
 * with coverage does not come back when a newer one has none.
 */
export async function rollupCoverage(ch: ClickHouseService, account: string): Promise<RollupCoverage | undefined> {
  const [row] = await ch.query<{ rolled_from: string; rolled_through: string }>(
    `SELECT toString(rolled_from) AS rolled_from, toString(rolled_through) AS rolled_through
       FROM (SELECT rolled_from, rolled_through, config_version
               FROM ${Table.AccountRollupState}
              WHERE account = {account:String}
              ORDER BY account, version DESC
              LIMIT 1)
      WHERE config_version = {configVersion:UInt32} AND rolled_from IS NOT NULL AND rolled_through IS NOT NULL`,
    { account, configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION },
  );
  if (row === undefined || row.rolled_from > row.rolled_through) return undefined;
  return { from: row.rolled_from, through: row.rolled_through };
}

/**
 * The exact sum of a column of exact text over day groups, as a route merges them: a `Decimal256(30)` sum, `'0'` when no
 * group has an exact term. A group's `'0'` is a term of 0, so the merge of groups is the sum of their terms.
 */
export function mergedExactSum(column: string): string {
  return `ifNull(toString(sum(toDecimal256OrNull(${column}, ${EXACT_SCALE}))), '0')`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The raw source.
// ---------------------------------------------------------------------------------------------------------------------

export interface RawDayGroupsOptions {
  /** `one` reads `{dg_account:String}`; `many` reads `{dg_accounts:Array(String)}` and puts `account` first in the output. */
  accounts: 'one' | 'many';
  /** The ranges of ledgers read: `{dg_min0:UInt32}`..`{dg_max0:UInt32}`, and with 2 the same with 1 too. */
  ranges: 1 | 2;
}

/** What the three families of raw SQL have in common, for one account or many. */
function rawPieces(o: RawDayGroupsOptions) {
  const many = o.accounts === 'many';
  const first = 'ledger_index BETWEEN {dg_min0:UInt32} AND {dg_max0:UInt32}';
  const second = 'ledger_index BETWEEN {dg_min1:UInt32} AND {dg_max1:UInt32}';
  return {
    /** The account as a leading column of a select list or a GROUP BY. */
    lead: many ? 'account, ' : '',
    /** The account's key range: the account, and the ledgers. */
    where: `${many ? 'account IN {dg_accounts:Array(String)}' : 'account = {dg_account:String}'} AND (${
      o.ranges === 1 ? first : `${first} OR ${second}`
    })`,
    /** `LIMIT 1 BY` the rest of the key (the account too when there are many). */
    limitBy: (rest: string): string => `LIMIT 1 BY ${many ? 'account, ' : ''}${rest}`,
  };
}

/** `'0'` when no row has an exact term. `cond` is code, never input. */
const exactText = (column: string, cond?: string): string => `ifNull(${exactSum(column, cond)}, '0')`;

function rawLinesSql(o: RawDayGroupsOptions): string {
  const { lead, where, limitBy } = rawPieces(o);
  const group = `${lead}day, currency, counterparty`;
  // in is the sum of the positive changes and out minus the sum of the negative ones; a change of 0 is only counted
  return `SELECT ${lead}day, currency, counterparty, change_type, owes, count, in_sum, out_sum, unfit, in_sum_f, out_sum_f,
       argMax(group_last, group_key) OVER (PARTITION BY ${group}) AS end_balance
  FROM (SELECT ${lead}day, currency, counterparty, change_type, owes, toUInt64(count()) AS count,
               ${exactText('change_exact', 'change_f > 0')} AS in_sum,
               ${exactText('-change_exact', 'change_f < 0')} AS out_sum,
               toUInt32(countIf(change_exact IS NULL)) AS unfit,
               ${floatSum('change_f', 'change_f > 0')} AS in_sum_f, ${floatSum('-change_f', 'change_f < 0')} AS out_sum_f,
               argMax(final_balance, (ledger_index, tx_index, node_index)) AS group_last,
               max((ledger_index, tx_index, node_index)) AS group_key
          FROM (SELECT ${lead}toDate(close_time, 'UTC') AS day, currency, counterparty, change_type,
                       toUInt8(final_balance_f < 0) AS owes, ledger_index, tx_index, node_index, final_balance,
                       ${exactAmount('amount_change')} AS change_exact, toFloat64OrZero(amount_change) AS change_f
                  FROM ${Table.BalanceChanges}
                 WHERE ${where}
                 ORDER BY account, ledger_index, tx_index, node_index
                 ${limitBy('ledger_index, tx_index, node_index')})
         GROUP BY ${lead}day, currency, counterparty, change_type, owes)`;
}

function rawTxsSql(o: RawDayGroupsOptions): string {
  const { lead, where, limitBy } = rawPieces(o);
  return `SELECT ${lead}toDate(close_time, 'UTC') AS day, tx_type, result, toUInt64(count()) AS count
  FROM (SELECT ${lead}close_time, tx_type, result
          FROM ${Table.AccountTransactions}
         WHERE ${where} AND is_initiator = 1
         ORDER BY account, ledger_index, tx_index
         ${limitBy('ledger_index, tx_index')})
 GROUP BY ${lead}day, tx_type, result`;
}

function rawTradesSql(o: RawDayGroupsOptions): string {
  const { lead, where, limitBy } = rawPieces(o);
  // a self-trade (buyer and seller are the account) is both bought and sold; `unfit` is of the group, as volumeColumns has it
  return `SELECT ${lead}day, base_currency, base_issuer, counter_currency, counter_issuer, toUInt64(count()) AS count,
       ${exactText('base_exact')} AS base_sum, ${exactText('counter_exact')} AS counter_sum,
       ${exactText('base_exact', 'bought')} AS bought_sum, ${exactText('base_exact', 'sold')} AS sold_sum,
       ${exactText('counter_exact', 'bought')} AS bought_counter_sum, ${exactText('counter_exact', 'sold')} AS sold_counter_sum,
       toUInt32(countIf(base_exact IS NULL OR counter_exact IS NULL)) AS unfit,
       ${floatSum('base_amount_f')} AS base_sum_f, ${floatSum('counter_amount_f')} AS counter_sum_f,
       ${floatSum('base_amount_f', 'bought')} AS bought_sum_f, ${floatSum('base_amount_f', 'sold')} AS sold_sum_f,
       ${floatSum('counter_amount_f', 'bought')} AS bought_counter_sum_f,
       ${floatSum('counter_amount_f', 'sold')} AS sold_counter_sum_f
  FROM (SELECT ${lead}toDate(close_time, 'UTC') AS day, base_currency, base_issuer, counter_currency, counter_issuer,
               buyer = account AS bought, seller = account AS sold, ${VOLUME_SOURCE_COLUMNS}
          FROM ${Table.AccountExchanges}
         WHERE ${where}
         ORDER BY account, ledger_index, tx_index, node_index
         ${limitBy('ledger_index, tx_index, node_index')})
 GROUP BY ${lead}day, base_currency, base_issuer, counter_currency, counter_issuer`;
}

const RAW_SQL: Record<DayGroupFamily, (o: RawDayGroupsOptions) => string> = {
  lines: rawLinesSql,
  txs: rawTxsSql,
  trades: rawTradesSql,
};

/**
 * The day groups of a family read from the raw rows of an account (or of many) in one or two ranges of ledgers: the
 * columns of `DAY_GROUP_COLUMNS` (with `account` first for `many`). The params are `dg_account` (String) or `dg_accounts`
 * (Array(String)), and `dg_min0`, `dg_max0` (and `dg_min1`, `dg_max1` for two ranges), UInt32, both ends included. The
 * range must cover whole days: a day is the UTC day of `close_time`, and a group holds the rows of the ranges only.
 */
export function rawDayGroupsSql(family: DayGroupFamily, o: RawDayGroupsOptions): string {
  return RAW_SQL[family](o);
}

// ---------------------------------------------------------------------------------------------------------------------
// The rollup source, and the choice between the two.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The day groups of a family read from the rollup of one account: `{dg_account:String}`, the days `{dg_from:Date}` to
 * `{dg_through:Date}`. A day is the rows of the newest sentinel of the account and day in `account_rollup_days` (a rollup is
 * written whole under one version, then its sentinel): the rows of any other version are not read, and a day without a
 * sentinel has no rows. Ordered by the table's key, one row for each group (`LIMIT 1 BY`), so a row written twice is read
 * once.
 */
function rollupDayGroupsSql(family: DayGroupFamily): string {
  const columns = DAY_GROUP_COLUMNS[family].join(', ');
  const key = GROUP_KEY[family].join(', ');
  return `SELECT ${columns}
  FROM ${DAY_GROUP_TABLES[family]}
 WHERE account = {dg_account:String} AND day BETWEEN {dg_from:Date} AND {dg_through:Date}
   AND (day, version) IN (SELECT day, max(version)
                            FROM ${Table.AccountRollupDays}
                           WHERE account = {dg_account:String} AND day BETWEEN {dg_from:Date} AND {dg_through:Date}
                           GROUP BY day)
 ORDER BY account, ${key}
 LIMIT 1 BY ${key}`;
}

/** Day groups to read: the SQL (select from it as a subquery), its bound params, and which sources it reads. */
export interface DayGroupsSource {
  sql: string;
  params: Record<string, unknown>;
  sources: Array<'raw' | 'rollup'>;
}

const DAY_MS = 86_400_000;

/** The unix ms of the start of a UTC day (`YYYY-MM-DD`); anything else is a `RangeError`. */
export function utcDayStart(day: string): number {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
  // 2020-02-30 is read as March 1 and does not come back as itself
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) throw new RangeError(`Invalid day: ${day}`);
  return ms;
}

/** The day groups of an account's window, from the rollups where they cover it and from the raw rows elsewhere. */
export class AccountDayGroups {
  constructor(
    private readonly ch: ClickHouseService,
    private readonly ranges: LedgerRangeOf,
    private readonly coverageOf: (account: string) => Promise<RollupCoverage | undefined> = (account) =>
      rollupCoverage(ch, account),
  ) {}

  /**
   * The groups of `family` of the UTC days `fromDay` to `throughDay` (`YYYY-MM-DD`, both included) of an account, or `null`
   * when no day of the window has a source. The days the account's rollups cover come from them; the days before and after
   * them, from the raw rows of the ledgers that closed in them (a part with no ledgers has no rows, and is dropped). The
   * result is one SELECT of the family's columns: `UNION ALL` of the parts, to be used as a subquery.
   */
  async source(
    family: DayGroupFamily,
    account: string,
    fromDay: string,
    throughDay: string,
  ): Promise<DayGroupsSource | null> {
    const from = utcDayStart(fromDay);
    const through = utcDayStart(throughDay);
    if (from > through) return null;

    const coverage = await this.coverageOf(account);
    let rolled: [from: number, through: number] | undefined;
    if (coverage !== undefined) {
      const lo = Math.max(from, utcDayStart(coverage.from));
      const hi = Math.min(through, utcDayStart(coverage.through));
      if (lo <= hi) rolled = [lo, hi];
    }

    // the days outside the rollups, as ranges of days
    const rawDays: Array<[number, number]> = [];
    if (rolled === undefined) rawDays.push([from, through]);
    else {
      if (from < rolled[0]) rawDays.push([from, rolled[0] - DAY_MS]);
      if (rolled[1] < through) rawDays.push([rolled[1] + DAY_MS, through]);
    }
    const found = await Promise.all(rawDays.map(([lo, hi]) => this.ranges(new Date(lo), new Date(hi + DAY_MS))));
    const raw = found.filter((range): range is LedgerRange => range !== null);

    const params: Record<string, unknown> = { dg_account: account };
    const parts: string[] = [];
    const sources: Array<'raw' | 'rollup'> = [];
    if (raw.length > 0) {
      raw.forEach((range, i) => {
        params[`dg_min${i}`] = range.min;
        params[`dg_max${i}`] = range.max;
      });
      parts.push(rawDayGroupsSql(family, { accounts: 'one', ranges: raw.length as 1 | 2 }));
      sources.push('raw');
    }
    if (rolled !== undefined) {
      params.dg_from = new Date(rolled[0]).toISOString().slice(0, 10);
      params.dg_through = new Date(rolled[1]).toISOString().slice(0, 10);
      parts.push(rollupDayGroupsSql(family));
      sources.push('rollup');
    }
    return parts.length === 0 ? null : { sql: parts.join('\nUNION ALL\n'), params, sources };
  }
}
