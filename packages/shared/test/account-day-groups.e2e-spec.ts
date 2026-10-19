import BigNumber from 'bignumber.js';
import { join } from 'node:path';
import {
  RollupState,
  rollupStates,
  writeAccountRollups,
  writeRollupStates,
} from '../src/aggregate/account-rollups.job';
import { AggregateSetAborted } from '../src/aggregate/aggregate-sets';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { AccountExchangesRow, AccountTransactionsRow, BalanceChangesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import {
  ACCOUNT_ROLLUP_CONFIG_VERSION,
  AccountDayGroups,
  DAY_GROUP_COLUMNS,
  DAY_GROUPS_EPOCH,
  DayGroupFamily,
  DayGroupsSource,
  LedgerRangeOf,
  rawDayGroupsSql,
  rollupCoverage,
  RollupCoverage,
} from '../src/query/account-day-groups';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

/**
 * The day groups of an account (`account-day-groups.ts`) and the rollup writer (`account-rollups.job.ts`) on a real
 * ClickHouse.
 *
 * The world is the 54 mock ledgers of the original Ripple API, written through the real `LedgerWriter` (283 accounts with
 * balance changes over 7 UTC days, 300 with transactions, 53 with trades), and synthetic rows of made-up accounts on the
 * ledgers of those days: an account of hand-worked edge cases (a line that crosses zero within a day, fee rows, a change
 * type of '', two changes in one ledger, a zero change, a self-trade, rows written twice), one with amounts the exact
 * sums cannot hold, and four "heavy" accounts of binary fractions, whose float sums are the same in any order (so a rollup
 * and a raw read of them agree to the last digit).
 *
 * An oracle written from the rows (plain JavaScript and BigNumber, never the code under test) says what every group is.
 * Then the rollups: whatever the coverage of an account (the whole window, only the days after the start of it, only the
 * days before its end, the middle), the groups a read gives are the groups of the raw rows alone.
 */

// ---------------------------------------------------------------------------------------------------------------------
// The world.
// ---------------------------------------------------------------------------------------------------------------------

const profile = getNetworkProfile('xrpl');
const ctx = parseContextFor(profile);
const ledgers = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/ripple-mock')).list();
const built = ledgers.map((l) => buildLedgerRows(l, ctx));

const dayOfSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/** A ledger of the mock: the synthetic rows of a day are written on its ledgers. */
interface Anchor {
  ledger_index: number;
  close_time: number;
}
const anchorsByDay = new Map<string, Anchor[]>();
for (const b of built) {
  const day = dayOfSeconds(b.ledger.close_time);
  anchorsByDay.set(day, [
    ...(anchorsByDay.get(day) ?? []),
    { ledger_index: b.ledger.ledger_index, close_time: b.ledger.close_time },
  ]);
}
for (const list of anchorsByDay.values()) list.sort((a, b) => a.ledger_index - b.ledger_index);
/** The seven days of the mock ledgers: 2013-06-11 to 2017-05-12. */
const DAYS = [...anchorsByDay.keys()].sort();
const BIG_DAY = '2015-01-14'; // 41 ledgers
const SECOND_DAY = '2015-02-09'; // 8 ledgers
/** The whole window of the tests: all the mock ledgers are in it. */
const WINDOW: [string, string] = ['2013-01-01', '2017-12-31'];

const addr = (name: string): string => `r${name}`.padEnd(34, 'x');
const EDGE = addr('DayGroupsEdge');
const UNFIT = addr('DayGroupsUnfit');
const OTHER = addr('DayGroupsOther');
const HEAVY = [1, 2, 3, 4].map((n) => addr(`DayGroupsHeavy${n}`));
const ISSUER_B = addr('IssuerB');
const ISSUER_C = addr('IssuerC');

interface Rows {
  bc: BalanceChangesRow[];
  tx: AccountTransactionsRow[];
  ex: AccountExchangesRow[];
}
const noRows = (): Rows => ({ bc: [], tx: [], ex: [] });
const concat = (...all: Rows[]): Rows => ({
  bc: all.flatMap((r) => r.bc),
  tx: all.flatMap((r) => r.tx),
  ex: all.flatMap((r) => r.ex),
});

const hashOf = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

function bc(
  account: string,
  at: Anchor,
  tx: number,
  node: number,
  currency: string,
  counterparty: string,
  change: string,
  finalBalance: string,
  type: string,
): BalanceChangesRow {
  return {
    ...SAMPLE_ROWS[Table.BalanceChanges],
    account,
    ledger_index: at.ledger_index,
    tx_index: tx,
    node_index: node,
    tx_hash: hashOf(at.ledger_index * 1000 + tx),
    close_time: at.close_time,
    currency,
    counterparty,
    amount_change: change,
    final_balance: finalBalance,
    final_balance_f: Number(finalBalance),
    change_type: type,
  };
}

function txRow(
  account: string,
  at: Anchor,
  tx: number,
  type: string,
  result: string,
  initiator: 0 | 1,
): AccountTransactionsRow {
  return {
    account,
    ledger_index: at.ledger_index,
    tx_index: tx,
    tx_type: type,
    result,
    is_initiator: initiator,
    close_time: at.close_time,
  };
}

type Side = [currency: string, issuer: string];
function exRow(
  account: string,
  at: Anchor,
  tx: number,
  node: number,
  base: Side,
  counter: Side,
  baseAmount: string,
  counterAmount: string,
  buyer: string,
  seller: string,
): AccountExchangesRow {
  return {
    ...SAMPLE_ROWS[Table.AccountExchanges],
    account,
    base_currency: base[0],
    base_issuer: base[1],
    counter_currency: counter[0],
    counter_issuer: counter[1],
    ledger_index: at.ledger_index,
    tx_index: tx,
    node_index: node,
    tx_hash: hashOf(at.ledger_index * 1000 + tx),
    close_time: at.close_time,
    base_amount: baseAmount,
    counter_amount: counterAmount,
    base_amount_f: Number(baseAmount),
    counter_amount_f: Number(counterAmount),
    buyer,
    seller,
  };
}

const XRP_SIDE: Side = ['XRP', ''];
const USD_B: Side = ['USD', ISSUER_B];
const EUR_C: Side = ['EUR', ISSUER_C];

const mock: Rows = {
  bc: built.flatMap((b) => b.balanceChanges),
  tx: built.flatMap((b) => b.accountTransactions),
  ex: built.flatMap((b) => b.accountExchanges),
};

/**
 * The account of the edge cases (see the expected groups in the tests): all of it on the first two ledgers of the big day,
 * and the first of the second day.
 */
function edgeRows(): { rows: Rows; twice: Rows } {
  const [a0, a1] = anchorsByDay.get(BIG_DAY) as Anchor[];
  const [b0] = anchorsByDay.get(SECOND_DAY) as Anchor[];
  const usd1 = bc(EDGE, a0, 1, 0, 'USD', ISSUER_B, '10', '10', 'payment_destination');
  const fee1 = bc(EDGE, a0, 1, -1, 'XRP', '', '-0.0000152587890625', '99.9999847412109375', 'transaction_cost');
  const rows: Rows = {
    bc: [
      // the line crosses zero within the day: 10, -5, 2, -1 after its changes, so the same type is on both sides of it
      usd1,
      bc(EDGE, a0, 1, 1, 'USD', ISSUER_B, '-15', '-5', 'payment_source'),
      bc(EDGE, a0, 2, 0, 'USD', ISSUER_B, '7', '2', 'payment_destination'),
      bc(EDGE, a1, 0, 0, 'USD', ISSUER_B, '-3', '-1', 'payment_source'),
      // fee rows have node_index -1: the payment of the same transaction comes after its fee
      fee1,
      bc(EDGE, a0, 2, -1, 'XRP', '', '-0.0000152587890625', '99.999969482421875', 'transaction_cost'),
      bc(EDGE, a1, 5, -1, 'XRP', '', '-0.0000152587890625', '99.9999542236328125', 'transaction_cost'),
      bc(EDGE, a1, 5, 0, 'XRP', '', '-3', '96.9999542236328125', 'payment_source'),
      // a change type of '', and a change of 0
      bc(EDGE, a0, 4, 0, 'EUR', ISSUER_C, '5', '5', ''),
      bc(EDGE, a0, 6, 0, 'EUR', ISSUER_C, '0', '5', 'payment_source'),
      // the next day
      bc(EDGE, b0, 1, 0, 'USD', ISSUER_B, '1', '3', 'payment_destination'),
    ],
    tx: [
      txRow(EDGE, a0, 1, 'Payment', 'tesSUCCESS', 1),
      txRow(EDGE, a0, 2, 'Payment', 'tesSUCCESS', 1),
      txRow(EDGE, a0, 3, 'OfferCreate', 'tecKILLED', 1),
      txRow(EDGE, a0, 4, 'Payment', 'tesSUCCESS', 0), // received, not sent
      txRow(EDGE, b0, 1, 'Payment', 'tesSUCCESS', 1),
    ],
    ex: [
      exRow(EDGE, a0, 1, 0, XRP_SIDE, USD_B, '100', '25', EDGE, OTHER),
      exRow(EDGE, a0, 2, 0, XRP_SIDE, USD_B, '40', '10', OTHER, EDGE),
      exRow(EDGE, a0, 3, 0, XRP_SIDE, USD_B, '8', '2', EDGE, EDGE), // a self-trade: both bought and sold
      exRow(EDGE, a1, 1, 0, EUR_C, XRP_SIDE, '5', '50', EDGE, OTHER),
    ],
  };
  // written twice: the same rows again, by another insert (an insert collapses the rows of its own block, a merge those of
  // two parts, so the world stops the merges of the tables before it writes them)
  const twice: Rows = { bc: [usd1, fee1], tx: [rows.tx[0]], ex: [rows.ex[0]] };
  return { rows, twice };
}

/** The account with amounts a Decimal256(30) cannot hold: 36 places, and 1e37 either way round. */
function unfitRows(): Rows {
  const [a0] = anchorsByDay.get(BIG_DAY) as Anchor[];
  return {
    bc: [
      bc(UNFIT, a0, 1, 0, 'USD', ISSUER_B, '1.5e-35', '1.5e-35', 'payment_destination'),
      bc(UNFIT, a0, 1, 1, 'USD', ISSUER_B, '1e+37', '1e+37', 'payment_destination'),
      bc(UNFIT, a0, 2, 0, 'USD', ISSUER_B, '3', '1e+37', 'payment_destination'),
      bc(UNFIT, a0, 3, 0, 'USD', ISSUER_B, '-2e+37', '-2e+37', 'payment_source'),
      bc(UNFIT, a0, 4, 0, 'USD', ISSUER_B, '-1.25', '-1.25', 'payment_source'),
    ],
    tx: [],
    ex: [
      exRow(UNFIT, a0, 1, 0, XRP_SIDE, USD_B, '1.5e-35', '2', UNFIT, OTHER),
      exRow(UNFIT, a0, 2, 0, XRP_SIDE, USD_B, '4', '1', OTHER, UNFIT),
      exRow(UNFIT, a0, 3, 0, XRP_SIDE, USD_B, '1', '1e+37', UNFIT, UNFIT),
    ],
  };
}

const LINES: Side[] = [XRP_SIDE, USD_B, EUR_C];
const CHANGE_TYPES = ['payment_source', 'payment_destination', 'exchange', 'intermediary', ''];
const TX_TYPES = ['Payment', 'OfferCreate', 'TrustSet'];
const RESULTS = ['tesSUCCESS', 'tecPATH_DRY'];
const PAIRS: Array<[Side, Side]> = [
  [XRP_SIDE, USD_B],
  [EUR_C, XRP_SIDE],
  [USD_B, EUR_C],
];

/**
 * A heavy account: on every day of the mock, on two ledgers, three transactions with a change on each of three lines and
 * the fee of the first, a transaction of each kind and some trades (as buyer, as seller and with itself). All the
 * accounts use the same keys (`ledger_index, tx_index, node_index`): a read of many must not mix them up. Amounts are
 * multiples of 1/4 and of 2^-16, so every float sum is exact. The balances run along the keys, and cross zero.
 */
function heavyRows(account: string, a: number): Rows {
  const rows = noRows();
  const balances = new Map<string, BigNumber>();
  const move = (line: string, change: BigNumber): BigNumber => {
    const balance = (balances.get(line) ?? new BigNumber(0.5)).plus(change);
    balances.set(line, balance);
    return balance;
  };
  DAYS.forEach((day, d) => {
    const anchors = anchorsByDay.get(day) as Anchor[];
    [0, 1].forEach((s) => {
      const at = anchors[Math.min(s, anchors.length - 1)];
      for (let t = 0; t < 3; t++) {
        const tx = s * 10 + t;
        if (t === 0) {
          const fee = new BigNumber('-0.0000152587890625');
          rows.bc.push(
            bc(account, at, tx, -1, 'XRP', '', fee.toString(), move('XRP/', fee).toString(), 'transaction_cost'),
          );
        }
        LINES.forEach(([currency, counterparty], l) => {
          const size = new BigNumber((a + 1) * (d + 2) + t + l).times(0.25);
          const change = (a + d + s + t + l) % 3 === 0 ? size.times(-2) : size;
          const balance = move(`${currency}/${counterparty}`, change);
          rows.bc.push(
            bc(
              account,
              at,
              tx,
              l,
              currency,
              counterparty,
              change.toString(),
              balance.toString(),
              CHANGE_TYPES[(t + l + s + d) % CHANGE_TYPES.length],
            ),
          );
        });
        rows.tx.push(
          txRow(account, at, tx, TX_TYPES[(d + t + s) % 3], RESULTS[(t + s) % 2], (a + d + t) % 2 === 0 ? 1 : 0),
        );
        if (t < 2) {
          const [base, counter] = PAIRS[(d + s + t + a) % 3];
          const baseAmount = String((t + 1) * 4);
          const counterAmount = new BigNumber(baseAmount)
            .times(0.25)
            .times(a + 2)
            .toString();
          const how = (d + t + a) % 3; // the account buys, sells, or trades with itself
          rows.ex.push(
            exRow(
              account,
              at,
              tx,
              t,
              base,
              counter,
              baseAmount,
              counterAmount,
              how === 1 ? OTHER : account,
              how === 0 ? OTHER : account,
            ),
          );
        }
      }
    });
  });
  return rows;
}

const edge = edgeRows();
const unfit = unfitRows();
const heavy = HEAVY.map((account, a) => heavyRows(account, a));
/** What the oracle reads: the logical rows of the mock and the synthetic accounts, each once. */
const logical = concat(mock, edge.rows, unfit, ...heavy);
/** What is written besides the mock: the synthetic rows, and then the ones of them that are written twice. */
const synthetic = concat(edge.rows, unfit, ...heavy);

const accountsOf = (rows: Array<{ account: string }>): string[] => [...new Set(rows.map((r) => r.account))].sort();
const ALL_ACCOUNTS: Record<DayGroupFamily, string[]> = {
  lines: accountsOf(logical.bc),
  txs: accountsOf(logical.tx.filter((r) => r.is_initiator === 1)),
  trades: accountsOf(logical.ex),
};

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: the groups the rows make, in plain JavaScript.
// ---------------------------------------------------------------------------------------------------------------------

type Group = Record<string, string | number>;

const SUM_COLUMNS = new Set([
  'in_sum',
  'out_sum',
  'base_sum',
  'counter_sum',
  'bought_sum',
  'sold_sum',
  'bought_counter_sum',
  'sold_counter_sum',
]);
const FLOAT_COLUMNS = new Set([
  'in_sum_f',
  'out_sum_f',
  'base_sum_f',
  'counter_sum_f',
  'bought_sum_f',
  'sold_sum_f',
  'bought_counter_sum_f',
  'sold_counter_sum_f',
]);
const NUMBER_COLUMNS = new Set(['owes', 'count', 'unfit']);
const GROUP_KEY: Record<DayGroupFamily, string[]> = {
  lines: ['account', 'day', 'currency', 'counterparty', 'change_type', 'owes'],
  txs: ['account', 'day', 'tx_type', 'result'],
  trades: ['account', 'day', 'base_currency', 'base_issuer', 'counter_currency', 'counter_issuer'],
};

/** An amount the exact sums hold whole: at most 30 places, and below 1e36. */
const fits = (text: string): boolean =>
  (new BigNumber(text).decimalPlaces() as number) <= 30 && Math.abs(Number(text)) < 1e36;
const exactSum = (terms: BigNumber[]): string => terms.reduce((sum, x) => sum.plus(x), new BigNumber(0)).toFixed();
const floatSum = (terms: number[]): number => terms.reduce((sum, x) => sum + x, 0);
const afterKey = (
  a: { ledger_index: number; tx_index: number; node_index: number },
  b: { ledger_index: number; tx_index: number; node_index: number },
): boolean => (a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index) > 0;

function groupRows<T>(rows: T[], keyOf: (row: T) => Array<string | number>): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row).join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

function linesOracle(rows: BalanceChangesRow[]): Group[] {
  const owes = (r: BalanceChangesRow): number => (r.final_balance_f < 0 ? 1 : 0);
  const day = (r: BalanceChangesRow): string => dayOfSeconds(r.close_time);
  // the last final_balance of each line and day, by (ledger_index, tx_index, node_index)
  const lastOfLine = new Map<string, BalanceChangesRow>();
  for (const r of rows) {
    const line = [r.account, day(r), r.currency, r.counterparty].join('\u0000');
    const last = lastOfLine.get(line);
    if (last === undefined || afterKey(r, last)) lastOfLine.set(line, r);
  }
  return [
    ...groupRows(rows, (r) => [r.account, day(r), r.currency, r.counterparty, r.change_type, owes(r)]).values(),
  ].map((g) => {
    const r = g[0];
    const positive = g.filter((x) => Number(x.amount_change) > 0);
    const negative = g.filter((x) => Number(x.amount_change) < 0);
    return {
      account: r.account,
      day: day(r),
      currency: r.currency,
      counterparty: r.counterparty,
      change_type: r.change_type,
      owes: owes(r),
      count: g.length,
      in_sum: exactSum(positive.filter((x) => fits(x.amount_change)).map((x) => new BigNumber(x.amount_change))),
      out_sum: exactSum(
        negative.filter((x) => fits(x.amount_change)).map((x) => new BigNumber(x.amount_change).negated()),
      ),
      unfit: g.filter((x) => !fits(x.amount_change)).length,
      in_sum_f: floatSum(positive.map((x) => Number(x.amount_change))),
      out_sum_f: floatSum(negative.map((x) => -Number(x.amount_change))),
      end_balance: (lastOfLine.get([r.account, day(r), r.currency, r.counterparty].join('\u0000')) as BalanceChangesRow)
        .final_balance,
    };
  });
}

function txsOracle(rows: AccountTransactionsRow[]): Group[] {
  return [
    ...groupRows(
      rows.filter((r) => r.is_initiator === 1),
      (r) => [r.account, dayOfSeconds(r.close_time), r.tx_type, r.result],
    ).values(),
  ].map((g) => ({
    account: g[0].account,
    day: dayOfSeconds(g[0].close_time),
    tx_type: g[0].tx_type,
    result: g[0].result,
    count: g.length,
  }));
}

function tradesOracle(rows: AccountExchangesRow[]): Group[] {
  const terms = (g: AccountExchangesRow[], amount: 'base' | 'counter'): BigNumber[] =>
    g.filter((x) => fits(x[`${amount}_amount`])).map((x) => new BigNumber(x[`${amount}_amount`]));
  const floats = (g: AccountExchangesRow[], amount: 'base' | 'counter'): number[] =>
    g.map((x) => x[`${amount}_amount_f`]);
  return [
    ...groupRows(rows, (r) => [
      r.account,
      dayOfSeconds(r.close_time),
      r.base_currency,
      r.base_issuer,
      r.counter_currency,
      r.counter_issuer,
    ]).values(),
  ].map((g) => {
    const bought = g.filter((x) => x.buyer === x.account);
    const sold = g.filter((x) => x.seller === x.account);
    return {
      account: g[0].account,
      day: dayOfSeconds(g[0].close_time),
      base_currency: g[0].base_currency,
      base_issuer: g[0].base_issuer,
      counter_currency: g[0].counter_currency,
      counter_issuer: g[0].counter_issuer,
      count: g.length,
      base_sum: exactSum(terms(g, 'base')),
      counter_sum: exactSum(terms(g, 'counter')),
      bought_sum: exactSum(terms(bought, 'base')),
      sold_sum: exactSum(terms(sold, 'base')),
      bought_counter_sum: exactSum(terms(bought, 'counter')),
      sold_counter_sum: exactSum(terms(sold, 'counter')),
      unfit: g.filter((x) => !fits(x.base_amount) || !fits(x.counter_amount)).length,
      base_sum_f: floatSum(floats(g, 'base')),
      counter_sum_f: floatSum(floats(g, 'counter')),
      bought_sum_f: floatSum(floats(bought, 'base')),
      sold_sum_f: floatSum(floats(sold, 'base')),
      bought_counter_sum_f: floatSum(floats(bought, 'counter')),
      sold_counter_sum_f: floatSum(floats(sold, 'counter')),
    };
  });
}

const ORACLE: Record<DayGroupFamily, (rows: Rows, accounts: string[]) => Group[]> = {
  lines: (rows, accounts) => linesOracle(rows.bc.filter((r) => accounts.includes(r.account))),
  txs: (rows, accounts) => txsOracle(rows.tx.filter((r) => accounts.includes(r.account))),
  trades: (rows, accounts) => tradesOracle(rows.ex.filter((r) => accounts.includes(r.account))),
};

/** A group read from ClickHouse, with the numbers as numbers and the exact sums as BigNumber writes them. */
function normalized(row: Group): Group {
  const out: Group = {};
  for (const [column, value] of Object.entries(row)) {
    out[column] = SUM_COLUMNS.has(column)
      ? new BigNumber(value).toFixed()
      : NUMBER_COLUMNS.has(column) || FLOAT_COLUMNS.has(column)
        ? Number(value)
        : value;
  }
  return out;
}

/** Two floats agree to 12 significant digits (the order of a float sum is not the same everywhere). */
function close(got: number, want: number): boolean {
  return Math.abs(got - want) <= Math.max(Math.abs(want) * 1e-12, 1e-300);
}

/**
 * The groups read are the groups wanted: the same keys, the exact columns exactly, the floats to 12 digits. Returns how
 * many groups it compared, so that a test can see it compared something.
 */
function expectGroups(family: DayGroupFamily, got: Group[], want: Group[], label: string): number {
  const text = (g: Group): string => GROUP_KEY[family].map((c) => String(g[c])).join('\u0000');
  const sorted = (groups: Group[]): Group[] =>
    groups.map(normalized).sort((a, b) => (text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0));
  const have = sorted(got);
  const need = sorted(want);
  expect([label, have.map(text)]).toEqual([label, need.map(text)]);
  have.forEach((g, i) => {
    for (const column of ['account', ...DAY_GROUP_COLUMNS[family]]) {
      const [x, y] = [g[column], need[i][column]];
      if (FLOAT_COLUMNS.has(column)) {
        if (!close(x as number, y as number)) expect([label, text(g), column, x]).toEqual([label, text(g), column, y]);
      } else {
        expect([label, text(g), column, x]).toEqual([label, text(g), column, y]);
      }
    }
  });
  return have.length;
}

const ORDER_BY = (family: DayGroupFamily): string => DAY_GROUP_COLUMNS[family].join(', ');

// ---------------------------------------------------------------------------------------------------------------------

describe('account day groups and the rollup writer (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /** A migrated database of its own. */
  async function freshService(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `account_day_groups_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  const rangesOf = (ch: ClickHouseService): LedgerRangeOf => {
    const rates = new RatesService(ch, 'XRP');
    return (from, toExclusive) => rates.ledgersClosedIn(from, toExclusive);
  };

  /** Keeps the parts of tables as they are written, so that rows of older versions and duplicates stay where a test can see them. */
  async function stopMerges(ch: ClickHouseService, tables: Table[]): Promise<void> {
    const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
    for (const table of tables) await ch.command(`SYSTEM STOP MERGES ${database}.${table}`);
  }

  /** The groups of an account over a window, from the raw rows alone or from the rollups where `coverage` has them. */
  async function readGroups(
    ch: ClickHouseService,
    family: DayGroupFamily,
    account: string,
    window: [string, string],
    coverage?: RollupCoverage,
  ): Promise<{ rows: Group[]; source: DayGroupsSource | null }> {
    const source = await new AccountDayGroups(ch, rangesOf(ch), async () => coverage).source(
      family,
      account,
      window[0],
      window[1],
    );
    if (source === null) return { rows: [], source };
    const rows = await ch.query<Group>(`SELECT * FROM (${source.sql}) ORDER BY ${ORDER_BY(family)}`, source.params);
    return { rows: rows.map((r) => ({ account, ...r })), source };
  }

  // -------------------------------------------------------------------------------------------------------------------
  describe('on the mock ledgers and synthetic accounts', () => {
    let ch: ClickHouseService;
    const raw = (family: DayGroupFamily, account: string, window: [string, string] = WINDOW) =>
      readGroups(ch, family, account, window);

    beforeAll(async () => {
      ch = await freshService();
      await new LedgerWriter(ch, ctx).write(ledgers);
      await stopMerges(ch, [Table.BalanceChanges, Table.AccountTransactions, Table.AccountExchanges]);
      await ch.insert(Table.BalanceChanges, synthetic.bc);
      await ch.insert(Table.AccountTransactions, synthetic.tx);
      await ch.insert(Table.AccountExchanges, synthetic.ex);
      await ch.insert(Table.BalanceChanges, edge.twice.bc);
      await ch.insert(Table.AccountTransactions, edge.twice.tx);
      await ch.insert(Table.AccountExchanges, edge.twice.ex);
    });

    it('the world has what the tests rely on', async () => {
      expect(DAYS).toHaveLength(7);
      expect(anchorsByDay.get(BIG_DAY)?.length).toBeGreaterThanOrEqual(2);
      expect(anchorsByDay.get(SECOND_DAY)?.length).toBeGreaterThanOrEqual(1);
      // no two logical rows share a key: the oracle reads each once, as the database does
      const keys = (rows: object[], columns: string[]): number =>
        new Set(rows.map((r) => columns.map((c) => (r as Record<string, unknown>)[c]).join('\u0000'))).size;
      expect(keys(logical.bc, ['account', 'ledger_index', 'tx_index', 'node_index'])).toBe(logical.bc.length);
      expect(keys(logical.tx, ['account', 'ledger_index', 'tx_index'])).toBe(logical.tx.length);
      expect(keys(logical.ex, ['account', 'ledger_index', 'tx_index', 'node_index'])).toBe(logical.ex.length);
      // the heavy accounts have lines on both sides of zero, and trades of every kind
      for (const [a, account] of HEAVY.entries()) {
        const rows = linesOracle(heavy[a].bc);
        expect(new Set(rows.map((g) => g.owes))).toEqual(new Set([0, 1]));
        expect(account).toHaveLength(34);
        const trades = tradesOracle(heavy[a].ex);
        expect(trades.some((g) => Number(g.bought_sum) > 0 && Number(g.sold_sum) === 0)).toBe(true);
        expect(trades.some((g) => Number(g.sold_sum) > 0 && Number(g.bought_sum) === 0)).toBe(true);
        expect(trades.some((g) => Number(g.sold_sum) > 0 && Number(g.bought_sum) > 0)).toBe(true);
      }
      // the rows that are written twice are in the tables twice (no merge has collapsed them)
      for (const [table, written, once] of [
        [Table.BalanceChanges, edge.rows.bc.length + edge.twice.bc.length, edge.rows.bc.length],
        [Table.AccountTransactions, edge.rows.tx.length + edge.twice.tx.length, edge.rows.tx.length],
        [Table.AccountExchanges, edge.rows.ex.length + edge.twice.ex.length, edge.rows.ex.length],
      ] as const) {
        const [row] = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${table} WHERE account = {a:String}`, {
          a: EDGE,
        });
        expect([table, Number(row.n)]).toEqual([table, written]);
        expect(written).toBeGreaterThan(once);
      }
      expect(ALL_ACCOUNTS.lines.length).toBeGreaterThan(280);
      expect(ALL_ACCOUNTS.txs.length).toBeGreaterThan(150);
      expect(ALL_ACCOUNTS.trades.length).toBeGreaterThan(50);
    });

    it("raw line groups: one per day, line, change type and owes, with count, in and out exact; end_balance is the line's last final_balance of the day, the same on every row of the line and day", async () => {
      // the hand-worked account first: every group, written out
      const { rows, source } = await raw('lines', EDGE);
      expect(source?.sources).toEqual(['raw']);
      const group = (
        day: string,
        currency: string,
        counterparty: string,
        change_type: string,
        owes: number,
        count: number,
        in_sum: string,
        out_sum: string,
        end_balance: string,
      ): Group => ({
        account: EDGE,
        day,
        currency,
        counterparty,
        change_type,
        owes,
        count,
        in_sum,
        out_sum,
        unfit: 0,
        in_sum_f: Number(in_sum),
        out_sum_f: Number(out_sum),
        end_balance,
      });
      const want = [
        // the fees (three, one of them written twice) and the payment after the fee of its transaction (-1 is below 0)
        group(BIG_DAY, 'XRP', '', 'payment_source', 0, 1, '0', '3', '96.9999542236328125'),
        group(BIG_DAY, 'XRP', '', 'transaction_cost', 0, 3, '0', '0.0000457763671875', '96.9999542236328125'),
        // a change type of '' and a change of 0 (counted, in neither sum)
        group(BIG_DAY, 'EUR', ISSUER_C, '', 0, 1, '5', '0', '5'),
        group(BIG_DAY, 'EUR', ISSUER_C, 'payment_source', 0, 1, '0', '0', '5'),
        // the line crosses zero: the same type is two groups, and the end balance is the last change's
        group(BIG_DAY, 'USD', ISSUER_B, 'payment_destination', 0, 2, '17', '0', '-1'),
        group(BIG_DAY, 'USD', ISSUER_B, 'payment_source', 1, 2, '0', '18', '-1'),
        group(SECOND_DAY, 'USD', ISSUER_B, 'payment_destination', 0, 1, '1', '0', '3'),
      ];
      const sortKey = (g: Group): string => [g.day, g.currency, g.counterparty, g.change_type, g.owes].join('\u0000');
      expect(rows.map(normalized).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))).toEqual(
        want.map(normalized).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1)),
      );
      // the oracle agrees with the hand
      expectGroups('lines', want, linesOracle(edge.rows.bc), 'edge oracle');

      // the same on every row of a line and day
      const ends = new Map<string, Set<string>>();
      for (const g of rows) {
        const line = [g.day, g.currency, g.counterparty].join('/');
        ends.set(line, (ends.get(line) ?? new Set()).add(String(g.end_balance)));
      }
      expect([...ends.values()].every((set) => set.size === 1)).toBe(true);
      expect(rows.length).toBeGreaterThan(ends.size);
    });

    it('raw line groups of every account, one account at a time and all at once, are what the rows make (amounts that do not fit a decimal fall back to floats)', async () => {
      const busiest = [...groupRows(logical.bc, (r) => [r.account]).entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 6)
        .map(([, g]) => g[0].account);
      let compared = 0;
      for (const account of [EDGE, UNFIT, ...HEAVY, ...busiest]) {
        const { rows } = await raw('lines', account);
        compared += expectGroups('lines', rows, ORACLE.lines(logical, [account]), account);
      }
      expect(compared).toBeGreaterThan(300);

      // the amounts that do not fit: counted as unfit, and only the others are in the exact sums
      const { rows: odd } = await raw('lines', UNFIT);
      const byType = new Map(odd.map((g) => [`${g.change_type}/${g.owes}`, normalized(g)]));
      expect(byType.get('payment_destination/0')).toMatchObject({ count: 3, in_sum: '3', unfit: 2 });
      expect(byType.get('payment_source/1')).toMatchObject({ count: 2, out_sum: '1.25', unfit: 1 });
      expect(Number(byType.get('payment_destination/0')?.in_sum_f)).toBeCloseTo(1e37, -20);

      // many accounts in one read: the same groups, each with its account, and no mixing of accounts that share keys
      const range = (await rangesOf(ch)(
        new Date(`${DAY_GROUPS_EPOCH}T00:00:00Z`),
        new Date('2018-01-01T00:00:00Z'),
      )) as {
        min: number;
        max: number;
      };
      const many = await ch.query<Group>(
        `SELECT * FROM (${rawDayGroupsSql('lines', { accounts: 'many', ranges: 1 })}) ORDER BY account, ${ORDER_BY('lines')}`,
        { dg_accounts: ALL_ACCOUNTS.lines, dg_min0: range.min, dg_max0: range.max },
      );
      expect(Object.keys(many[0])).toEqual(['account', ...DAY_GROUP_COLUMNS.lines]);
      expect(expectGroups('lines', many, ORACLE.lines(logical, ALL_ACCOUNTS.lines), 'many')).toBeGreaterThan(1000);
    });

    it('raw tx groups: the transactions the account sent, per day, type and result', async () => {
      const { rows } = await raw('txs', EDGE);
      expect(rows.map(normalized)).toEqual(
        [
          // the row written twice counts once; the transaction it received (is_initiator 0) is not a group
          { account: EDGE, day: BIG_DAY, tx_type: 'OfferCreate', result: 'tecKILLED', count: 1 },
          { account: EDGE, day: BIG_DAY, tx_type: 'Payment', result: 'tesSUCCESS', count: 2 },
          { account: EDGE, day: SECOND_DAY, tx_type: 'Payment', result: 'tesSUCCESS', count: 1 },
        ].map(normalized),
      );

      const busiest = [...groupRows(logical.tx, (r) => [r.account]).entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 6)
        .map(([, g]) => g[0].account);
      let compared = 0;
      for (const account of [EDGE, ...HEAVY, ...busiest]) {
        const one = await raw('txs', account);
        compared += expectGroups('txs', one.rows, ORACLE.txs(logical, [account]), account);
      }
      expect(compared).toBeGreaterThan(80);

      const range = (await rangesOf(ch)(
        new Date(`${DAY_GROUPS_EPOCH}T00:00:00Z`),
        new Date('2018-01-01T00:00:00Z'),
      )) as {
        min: number;
        max: number;
      };
      const many = await ch.query<Group>(
        `SELECT * FROM (${rawDayGroupsSql('txs', { accounts: 'many', ranges: 1 })}) ORDER BY account, ${ORDER_BY('txs')}`,
        { dg_accounts: ALL_ACCOUNTS.txs, dg_min0: range.min, dg_max0: range.max },
      );
      expect(expectGroups('txs', many, ORACLE.txs(logical, ALL_ACCOUNTS.txs), 'many')).toBeGreaterThan(300);
    });

    it('raw trade groups: count, base, counter, bought, sold, bought_counter, sold_counter (a self-trade in both), their floats and unfit', async () => {
      const { rows } = await raw('trades', EDGE);
      const sorted = rows.map(normalized).sort((a, b) => (a.base_currency < b.base_currency ? -1 : 1));
      // EUR/XRP: one trade, bought
      expect(sorted[0]).toEqual({
        account: EDGE,
        day: BIG_DAY,
        base_currency: 'EUR',
        base_issuer: ISSUER_C,
        counter_currency: 'XRP',
        counter_issuer: '',
        count: 1,
        base_sum: '5',
        counter_sum: '50',
        bought_sum: '5',
        sold_sum: '0',
        bought_counter_sum: '50',
        sold_counter_sum: '0',
        unfit: 0,
        base_sum_f: 5,
        counter_sum_f: 50,
        bought_sum_f: 5,
        sold_sum_f: 0,
        bought_counter_sum_f: 50,
        sold_counter_sum_f: 0,
      });
      // XRP/USD: bought 100, sold 40, and a self-trade of 8 in both (the row written twice counts once)
      expect(sorted[1]).toEqual({
        account: EDGE,
        day: BIG_DAY,
        base_currency: 'XRP',
        base_issuer: '',
        counter_currency: 'USD',
        counter_issuer: ISSUER_B,
        count: 3,
        base_sum: '148',
        counter_sum: '37',
        bought_sum: '108',
        sold_sum: '48',
        bought_counter_sum: '27',
        sold_counter_sum: '12',
        unfit: 0,
        base_sum_f: 148,
        counter_sum_f: 37,
        bought_sum_f: 108,
        sold_sum_f: 48,
        bought_counter_sum_f: 27,
        sold_counter_sum_f: 12,
      });
      expect(sorted).toHaveLength(2);

      // amounts a decimal cannot hold: the exact sums leave them out, `unfit` counts the trades, the floats have them all
      const { rows: odd } = await raw('trades', UNFIT);
      const unfitGroup: Group = {
        account: UNFIT,
        day: BIG_DAY,
        base_currency: 'XRP',
        base_issuer: '',
        counter_currency: 'USD',
        counter_issuer: ISSUER_B,
        count: 3,
        base_sum: '5', // 4 + 1; the 1.5e-35 has too many places
        counter_sum: '3', // 2 + 1; the 1e37 is too big
        bought_sum: '1', // the trades it bought: 1.5e-35 (left out) and the self-trade's 1
        sold_sum: '5',
        bought_counter_sum: '2',
        sold_counter_sum: '1',
        unfit: 2,
        base_sum_f: 5,
        counter_sum_f: 1e37,
        bought_sum_f: 1,
        sold_sum_f: 5,
        bought_counter_sum_f: 1e37,
        sold_counter_sum_f: 1e37,
      };
      expect(expectGroups('trades', odd, [unfitGroup], 'unfit by hand')).toBe(1);
      expect(expectGroups('trades', [unfitGroup], tradesOracle(unfit.ex), 'unfit oracle')).toBe(1);

      const busiest = [...groupRows(logical.ex, (r) => [r.account]).entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 6)
        .map(([, g]) => g[0].account);
      let compared = 0;
      for (const account of [EDGE, UNFIT, ...HEAVY, ...busiest]) {
        const one = await raw('trades', account);
        compared += expectGroups('trades', one.rows, ORACLE.trades(logical, [account]), account);
      }
      expect(compared).toBeGreaterThan(100);

      const range = (await rangesOf(ch)(
        new Date(`${DAY_GROUPS_EPOCH}T00:00:00Z`),
        new Date('2018-01-01T00:00:00Z'),
      )) as {
        min: number;
        max: number;
      };
      const many = await ch.query<Group>(
        `SELECT * FROM (${rawDayGroupsSql('trades', { accounts: 'many', ranges: 1 })}) ORDER BY account, ${ORDER_BY('trades')}`,
        { dg_accounts: ALL_ACCOUNTS.trades, dg_min0: range.min, dg_max0: range.max },
      );
      expect(expectGroups('trades', many, ORACLE.trades(logical, ALL_ACCOUNTS.trades), 'many')).toBeGreaterThan(150);
    });

    it('the raw read is a key range of the account (EXPLAIN indexes = 1: Keys account), with no FINAL', async () => {
      for (const family of ['lines', 'txs', 'trades'] as const) {
        const source = (await new AccountDayGroups(ch, rangesOf(ch), async () => undefined).source(
          family,
          EDGE,
          '2015-01-01',
          '2015-12-31',
        )) as DayGroupsSource;
        expect(source.sql).not.toMatch(/\bFINAL\b/i);
        const plan = (
          await ch.query<{ explain: string }>(`EXPLAIN indexes = 1 SELECT * FROM (${source.sql})`, source.params)
        )
          .map((r) => r.explain)
          .join('\n');
        expect(plan).not.toMatch(/\bFINAL\b/i);
        expect(plan).toMatch(/PrimaryKey\s+Keys:\s+account\s+ledger_index/);
        // the range of the one account, read in the order of the key (no sort of the account's rows)
        expect(plan).toContain(`(account in ['${EDGE}', '${EDGE}'])`);
        expect(plan).toContain('Read type: InOrder');
      }
    });

    it('rolled-up groups equal raw groups: complete, partial before, partial after', async () => {
      const rangeOf = rangesOf(ch);
      // four accounts, four coverages of the window: all of it; only from the middle of it (the days before are raw); only
      // up to the middle (the days after are raw); the middle only (raw on both sides)
      const coverages: RollupCoverage[] = [
        { from: WINDOW[0], through: WINDOW[1] },
        { from: BIG_DAY, through: WINDOW[1] },
        { from: WINDOW[0], through: SECOND_DAY },
        { from: BIG_DAY, through: SECOND_DAY },
      ];
      const expectedSources = [['rollup'], ['raw', 'rollup'], ['raw', 'rollup'], ['raw', 'rollup']];
      const states: RollupState[] = [];
      for (const [i, account] of HEAVY.entries()) {
        const written = await writeAccountRollups(ch, rangeOf, [account], coverages[i].from, coverages[i].through);
        expect(written).toBeGreaterThan(40);
        states.push({
          account,
          rows: heavy[i].bc.length,
          firstDay: DAYS[0],
          rolledFrom: coverages[i].from,
          rolledThrough: coverages[i].through,
          configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
        });
      }
      await writeRollupStates(ch, states);

      // windows: all of it, the middle, a single day, the days a coverage starts and ends on, days without rows around
      const windows: Array<[string, string]> = [
        WINDOW,
        ['2014-06-01', '2016-12-31'],
        ['2015-01-01', '2015-12-31'],
        [BIG_DAY, BIG_DAY],
        [SECOND_DAY, SECOND_DAY],
        ['2013-10-25', '2015-01-14'],
        ['2015-02-09', '2016-03-28'],
        ['2013-01-01', '2013-06-10'],
      ];
      let rolledGroups = 0;
      let touchedBoth = 0;
      for (const [i, account] of HEAVY.entries()) {
        // the coverage comes from the state rows, as the API reads it
        expect(await rollupCoverage(ch, account)).toEqual(coverages[i]);
        for (const family of ['lines', 'txs', 'trades'] as const) {
          for (const window of windows) {
            const withRollups = await new AccountDayGroups(ch, rangeOf).source(family, account, window[0], window[1]);
            const rawOnly = await readGroups(ch, family, account, window);
            const rolled = withRollups
              ? await ch.query<Group>(
                  `SELECT * FROM (${withRollups.sql}) ORDER BY ${ORDER_BY(family)}`,
                  withRollups.params,
                )
              : [];
            // the very same groups, as JSON
            expect(JSON.stringify(rolled)).toBe(
              JSON.stringify(rawOnly.rows.map(({ account: _account, ...group }) => group)),
            );
            if (withRollups?.sources.includes('rollup')) rolledGroups += rolled.length;
            if (withRollups?.sources.length === 2) touchedBoth++;
            if (window === WINDOW) expect(withRollups?.sources).toEqual(expectedSources[i]);
          }
        }
      }
      expect(rolledGroups).toBeGreaterThan(1000);
      expect(touchedBoth).toBeGreaterThan(20);
    });

    it('rolled-up groups equal raw groups of the real accounts of the mock ledgers too (the floats to 12 digits)', async () => {
      const rangeOf = rangesOf(ch);
      const busiest = [...groupRows(logical.bc, (r) => [r.account]).entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 3)
        .map(([, g]) => g[0].account);
      // a rollup for the days from the 14th of January 2015 to the 9th of February 2015: raw on both sides
      await writeAccountRollups(ch, rangeOf, busiest, BIG_DAY, SECOND_DAY);
      const coverage = { from: BIG_DAY, through: SECOND_DAY };
      let compared = 0;
      for (const account of busiest) {
        for (const family of ['lines', 'txs', 'trades'] as const) {
          const rolled = await readGroups(ch, family, account, WINDOW, coverage);
          const rawOnly = await readGroups(ch, family, account, WINDOW);
          expect(rolled.source?.sources).toEqual(['raw', 'rollup']);
          compared += expectGroups(family, rolled.rows, rawOnly.rows, `${account} ${family}`);
        }
      }
      expect(compared).toBeGreaterThan(50);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the rollup writer', () => {
    const R = addr('TinyA');
    const R2 = addr('TinyB');
    const TINY = ['2020-03-01', '2020-03-02', '2020-03-03', '2020-03-04', '2020-03-05'];
    const anchor = (day: number, k = 0): Anchor => ({
      ledger_index: 100 + day * 10 + k,
      close_time: Date.UTC(2020, 2, 1 + day, 6 + 6 * k) / 1000,
    });

    /** Two ledgers on each of five days; rows of R on four of them, of R2 on the second. */
    async function seedTiny(ch: ClickHouseService): Promise<void> {
      await ch.insert(
        Table.Ledgers,
        TINY.flatMap((_, day) =>
          [0, 1].map((k) => ({
            ...SAMPLE_ROWS[Table.Ledgers],
            ledger_index: anchor(day, k).ledger_index,
            ledger_hash: hashOf(anchor(day, k).ledger_index),
            close_time: anchor(day, k).close_time,
          })),
        ),
      );
      await ch.insert(Table.BalanceChanges, [
        bc(R, anchor(0), 0, 0, 'USD', ISSUER_B, '5', '5', 'payment_destination'),
        bc(R, anchor(0, 1), 0, 1, 'USD', ISSUER_B, '-2', '3', 'payment_source'),
        bc(R, anchor(0), 1, 0, 'EUR', ISSUER_B, '9', '9', 'payment_destination'),
        bc(R, anchor(1), 0, 0, 'USD', ISSUER_B, '1', '4', 'payment_destination'),
        bc(R2, anchor(1), 0, 0, 'EUR', ISSUER_B, '9', '9', 'payment_destination'),
      ]);
      await ch.insert(Table.AccountTransactions, [
        txRow(R, anchor(0), 0, 'Payment', 'tesSUCCESS', 1),
        txRow(R, anchor(3), 0, 'OfferCreate', 'tesSUCCESS', 1),
      ]);
      await ch.insert(Table.AccountExchanges, [
        exRow(R, anchor(0), 0, 0, XRP_SIDE, USD_B, '10', '2.5', R, OTHER),
        exRow(R, anchor(4), 0, 0, XRP_SIDE, USD_B, '20', '5', OTHER, R),
      ]);
    }

    const DAILY = [Table.AccountLinesDaily, Table.AccountTxDaily, Table.AccountTradesDaily];

    /** The distinct versions of the rows of a rollup table, newest last. */
    async function versionsIn(ch: ClickHouseService, table: Table, where = '1'): Promise<number[]> {
      const rows = await ch.query<{ version: string }>(
        `SELECT DISTINCT toUInt64(version) AS version FROM ${table} WHERE ${where} ORDER BY version`,
      );
      return rows.map((r) => Number(r.version));
    }

    async function sentinels(ch: ClickHouseService): Promise<Array<[string, string, number]>> {
      const rows = await ch.query<{ account: string; day: string; version: string }>(
        `SELECT account, toString(day) AS day, toUInt64(max(version)) AS version
           FROM ${Table.AccountRollupDays} GROUP BY account, day ORDER BY account, day`,
      );
      return rows.map((r) => [r.account, r.day, Number(r.version)]);
    }

    it('writeAccountRollups writes the three tables under one version, then a sentinel per (account, day) that has rows or had one; a day that lost its rows gets a sentinel with none', async () => {
      const ch = await freshService();
      await seedTiny(ch);
      await stopMerges(ch, [...DAILY, Table.AccountRollupDays]);
      const ranges = rangesOf(ch);

      const written = await writeAccountRollups(ch, ranges, [R2, R, R], TINY[0], TINY[4]);
      // R: 4 line groups (two on the first day: its USD pair of types, and EUR... three; one on the second), R2: 1
      const lines = await ch.query<{ account: string; day: string; currency: string; change_type: string }>(
        `SELECT account, toString(day) AS day, currency, change_type FROM ${Table.AccountLinesDaily} ORDER BY account, day, currency, change_type`,
      );
      expect(lines.map((l) => [l.account, l.day, l.currency, l.change_type])).toEqual([
        [R, TINY[0], 'EUR', 'payment_destination'],
        [R, TINY[0], 'USD', 'payment_destination'],
        [R, TINY[0], 'USD', 'payment_source'],
        [R, TINY[1], 'USD', 'payment_destination'],
        [R2, TINY[1], 'EUR', 'payment_destination'],
      ]);
      // 5 line groups, 2 days of R's transactions, 2 days of R's trades
      expect(written).toBe(9);

      // one version over the three tables
      const [version] = await versionsIn(ch, Table.AccountLinesDaily);
      for (const table of DAILY) expect(await versionsIn(ch, table)).toEqual([version]);
      // the sentinels: the days that have rows (not the third, which has none), all of that version
      expect(await sentinels(ch)).toEqual([
        [R, TINY[0], version],
        [R, TINY[1], version],
        [R, TINY[3], version],
        [R, TINY[4], version],
        [R2, TINY[1], version],
      ]);

      // the rollup reads as the raw rows do
      const rolledOnly = { from: TINY[0], through: TINY[4] };
      for (const family of ['lines', 'txs', 'trades'] as const) {
        for (const account of [R, R2]) {
          const rolled = await readGroups(ch, family, account, [TINY[0], TINY[4]], rolledOnly);
          expect(rolled.source?.sources).toEqual(['rollup']);
          expect(rolled.rows).toEqual((await readGroups(ch, family, account, [TINY[0], TINY[4]])).rows);
        }
      }

      // the second day of R loses its rows, as a re-ingest of the day could make it: the next set has none for it
      await ch.command(
        `ALTER TABLE ${Table.BalanceChanges} DELETE WHERE account = {a:String} AND toDate(close_time, 'UTC') = {d:Date} SETTINGS mutations_sync = 2`,
        { a: R, d: TINY[1] },
      );
      const again = await writeAccountRollups(ch, ranges, [R2, R], TINY[0], TINY[4]);
      expect(again).toBe(8);
      const [newer] = (await versionsIn(ch, Table.AccountLinesDaily)).slice(-1);
      expect(newer).toBeGreaterThan(version);
      // the sentinel of the day is newer and it has no rows of that version, the old ones are still in the table
      const second = await sentinels(ch);
      expect(second).toEqual([
        [R, TINY[0], newer],
        [R, TINY[1], newer],
        [R, TINY[3], newer],
        [R, TINY[4], newer],
        [R2, TINY[1], newer],
      ]);
      expect(await versionsIn(ch, Table.AccountLinesDaily, `account = '${R}' AND day = '${TINY[1]}'`)).toEqual([
        version,
      ]);
      expect(await versionsIn(ch, Table.AccountLinesDaily, `account = '${R2}' AND day = '${TINY[1]}'`)).toEqual([
        version,
        newer,
      ]);
      // and the read does not see the old rows of R
      for (const family of ['lines', 'txs', 'trades'] as const) {
        for (const account of [R, R2]) {
          const rolled = await readGroups(ch, family, account, [TINY[0], TINY[4]], rolledOnly);
          expect(rolled.rows).toEqual((await readGroups(ch, family, account, [TINY[0], TINY[4]])).rows);
        }
      }
      expect((await readGroups(ch, 'lines', R, [TINY[1], TINY[1]], rolledOnly)).rows).toEqual([]);

      // a window with no ledger at all writes no rows, and no sentinel of a day that had none
      const none = await writeAccountRollups(ch, ranges, [R], '2019-01-01', '2019-01-31');
      expect(none).toBe(0);
      expect(await sentinels(ch)).toEqual(second);
    });

    it("a rollup read takes the rows of each day's sentinel version, and a row written twice once", async () => {
      const ch = await freshService();
      await seedTiny(ch);
      await stopMerges(ch, [...DAILY, Table.AccountRollupDays]);
      const ranges = rangesOf(ch);
      const window: [string, string] = [TINY[0], TINY[4]];
      const rolledOnly = { from: TINY[0], through: TINY[4] };
      const lines = (): ReturnType<typeof readGroups> => readGroups(ch, 'lines', R, window, rolledOnly);

      await writeAccountRollups(ch, ranges, [R], TINY[0], TINY[4]);
      const [first] = await versionsIn(ch, Table.AccountLinesDaily);
      expect((await lines()).rows).toHaveLength(4);

      // the first day loses a group (its EUR) and another changes (a new USD change), and the day is rolled again
      await ch.command(
        `ALTER TABLE ${Table.BalanceChanges} DELETE WHERE account = {a:String} AND currency = 'EUR' SETTINGS mutations_sync = 2`,
        { a: R },
      );
      await ch.insert(Table.BalanceChanges, [
        bc(R, anchor(0, 1), 3, 0, 'USD', ISSUER_B, '0.5', '3.5', 'payment_destination'),
      ]);
      await writeAccountRollups(ch, ranges, [R], TINY[0], TINY[0]);
      const versions = await versionsIn(ch, Table.AccountLinesDaily);
      const second = versions[versions.length - 1];
      expect(second).toBeGreaterThan(first);

      // the old rows are all still there: the old EUR group has no newer row to replace it
      const physical = await ch.query<{ currency: string; version: string }>(
        `SELECT currency, toUInt64(version) AS version FROM ${Table.AccountLinesDaily}
          WHERE account = {a:String} AND day = {d:Date} ORDER BY version, currency, change_type`,
        { a: R, d: TINY[0] },
      );
      expect(physical.map((r) => [r.currency, Number(r.version)])).toEqual([
        ['EUR', first],
        ['USD', first],
        ['USD', first],
        ['USD', second],
        ['USD', second],
      ]);
      // and the read has the new set of the first day (no EUR; the USD destination of two changes) and the old one of the second
      const afterRewrite = await lines();
      expect(afterRewrite.rows.map((g) => [g.day, g.currency, g.change_type, Number(g.count)])).toEqual([
        [TINY[0], 'USD', 'payment_destination', 2],
        [TINY[0], 'USD', 'payment_source', 1],
        [TINY[1], 'USD', 'payment_destination', 1],
      ]);
      expect(afterRewrite.rows).toEqual((await readGroups(ch, 'lines', R, window)).rows);

      // a row written twice (the same insert read again) is read once
      await ch.command(
        `INSERT INTO ${Table.AccountLinesDaily} SELECT * FROM ${Table.AccountLinesDaily} WHERE account = {a:String} AND version = {v:UInt64}`,
        { a: R, v: second },
      );
      // a set that is being written, newer than the sentinel of its day, is not read
      await ch.command(
        `INSERT INTO ${Table.AccountLinesDaily}
         SELECT account, day, currency, counterparty, change_type, owes, 999, in_sum, out_sum, unfit, in_sum_f, out_sum_f, end_balance, version + 1000
           FROM ${Table.AccountLinesDaily} WHERE account = {a:String} AND version = {v:UInt64}`,
        { a: R, v: second },
      );
      const duplicates = await ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AccountLinesDaily} WHERE account = {a:String} AND day = {d:Date} AND version = {v:UInt64}`,
        { a: R, d: TINY[0], v: second },
      );
      expect(Number(duplicates[0].n)).toBe(4); // two groups, each twice
      const planted = await ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.AccountLinesDaily} WHERE account = {a:String} AND count = 999`,
        { a: R },
      );
      expect(Number(planted[0].n)).toBe(2);
      expect((await lines()).rows).toEqual(afterRewrite.rows);
    });

    it('an aborted set writes nothing, and no account or an empty window is nothing to write', async () => {
      const ch = await freshService();
      await seedTiny(ch);
      const ranges = rangesOf(ch);
      const controller = new AbortController();
      controller.abort();
      await expect(
        writeAccountRollups(ch, ranges, [R], TINY[0], TINY[4], { signal: controller.signal }),
      ).rejects.toBeInstanceOf(AggregateSetAborted);
      await expect(
        writeRollupStates(ch, [{ account: R, rows: 1, firstDay: TINY[0], configVersion: 1 }], {
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(AggregateSetAborted);
      expect(await writeAccountRollups(ch, ranges, [], TINY[0], TINY[4])).toBe(0);
      expect(await writeAccountRollups(ch, ranges, [R], TINY[4], TINY[0])).toBe(0);
      await expect(writeAccountRollups(ch, ranges, [R], '2020-02-30', TINY[4])).rejects.toThrow(RangeError);
      for (const table of [...DAILY, Table.AccountRollupDays, Table.AccountRollupState]) {
        const [row] = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`);
        expect([table, Number(row.n)]).toEqual([table, 0]);
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the state rows', () => {
    it('are written in one insert under one version; the newest row of an account is its state, and its coverage only when it is of the current config version with both days', async () => {
      const ch = await freshService();
      const A = addr('StateA');
      const B = addr('StateB');
      expect((await rollupStates(ch)).size).toBe(0);
      expect(await rollupCoverage(ch, A)).toBeUndefined();

      await writeRollupStates(ch, []);
      expect((await rollupStates(ch)).size).toBe(0);

      const covered: RollupState = {
        account: A,
        rows: 1_500_000,
        firstDay: '2014-05-06',
        rolledFrom: '2020-02-01',
        rolledThrough: '2020-02-10',
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
      };
      await writeRollupStates(ch, [covered, { account: B, rows: 20, firstDay: '2019-01-01', configVersion: 1 }]);
      const versions = await versionsOf(ch);
      expect(versions).toHaveLength(1);
      expect(await rollupStates(ch)).toEqual(
        new Map<string, RollupState>([
          [A, covered],
          [B, { account: B, rows: 20, firstDay: '2019-01-01', configVersion: 1 }],
        ]),
      );
      expect(await rollupCoverage(ch, A)).toEqual({ from: '2020-02-01', through: '2020-02-10' });
      expect(await rollupCoverage(ch, B)).toBeUndefined();

      // the next write is newer, and it is the one that counts: no coverage now, though an older row had it
      await writeRollupStates(ch, [{ ...covered, rolledFrom: undefined, rolledThrough: undefined, rows: 1_600_000 }]);
      const after = await versionsOf(ch);
      expect(after).toHaveLength(2);
      expect(after[1]).toBeGreaterThan(after[0]);
      expect((await rollupStates(ch)).get(A)).toEqual({
        account: A,
        rows: 1_600_000,
        firstDay: '2014-05-06',
        configVersion: 1,
      });
      expect(await rollupCoverage(ch, A)).toBeUndefined();

      // coverage of another config version is none; of a half (one day set) is none
      await writeRollupStates(ch, [{ ...covered, configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION + 1 }]);
      expect(await rollupCoverage(ch, A)).toBeUndefined();
      await writeRollupStates(ch, [{ ...covered, rolledThrough: undefined }]);
      expect(await rollupCoverage(ch, A)).toBeUndefined();
      await writeRollupStates(ch, [covered]);
      expect(await rollupCoverage(ch, A)).toEqual({ from: '2020-02-01', through: '2020-02-10' });
      expect((await rollupStates(ch)).get(A)).toEqual(covered);
    });

    async function versionsOf(ch: ClickHouseService): Promise<number[]> {
      const rows = await ch.query<{ version: string }>(
        `SELECT DISTINCT toUInt64(version) AS version FROM ${Table.AccountRollupState} ORDER BY version`,
      );
      return rows.map((r) => Number(r.version));
    }
  });
});
