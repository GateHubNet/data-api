import BigNumber from 'bignumber.js';
import { pairHourSets, PAIR_HOURLY_CONFIG_VERSION } from '../../aggregate/pair-hourly.job';
import { ClickHouseService } from '../../clickhouse/clickhouse.service';
import { TokenHourlyDexRow } from '../../clickhouse/rows';
import { Table } from '../../clickhouse/tables';
import { exactAmount } from '../../query/decimal';
import { KEEP_ANY_PAIR } from '../../query/rates.service';
import { TOKEN_HISTORY_CONFIG_VERSION } from '../constants';
import { ledgersOfHour } from '../hour-sets';

/**
 * DEX hours (spec 2.4, 4.5): per token and UTC hour with trades, the token's amounts in the hour's exchanges (order-book trades and AMM
 * swaps, on either side of the pair) and their count. An hour's rows and its sentinel (issuer and currency empty) share one version,
 * the sentinel written last: a missing row means no trades only when the sentinel exists. The native currency is no token. Trades
 * whose native leg is dust are left out, as `pair_hourly` leaves them out (`KEEP_ANY_PAIR`), so the two sources agree.
 */

const HOUR = 3_600;
/** Ledgers per partition of `exchanges` (`PARTITION BY intDiv(ledger_index, 10000000)`). */
const EXCHANGES_PARTITION = 10_000_000;
const SENTINEL = "issuer = '' AND currency = ''";
const EXCHANGE_KEY = 'base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index';

/** A token's figures in an hour, summed exactly. */
interface TokenHour {
  hour: number;
  issuer: string;
  currency: string;
  exchanged: BigNumber;
  trades: number;
}

const keyOf = (hour: number, issuer: string, currency: string): string => `${hour}|${issuer}|${currency}`;

/** Writes an hour set: the token rows, then the sentinel of every hour in `hours`, all under one version (the clock in ms). */
async function writeDexSets(ch: ClickHouseService, rows: TokenHour[], hours: number[]): Promise<void> {
  const version = Date.now();
  const row = (hour: number, issuer: string, currency: string, exchanged: string, trades: number): TokenHourlyDexRow => ({
    issuer,
    currency,
    hour,
    exchanged,
    trades,
    config_version: TOKEN_HISTORY_CONFIG_VERSION,
    version,
  });
  await ch.insert(
    Table.TokenHourlyDex,
    rows.map((r) => row(r.hour, r.issuer, r.currency, r.exchanged.isZero() ? '0' : r.exchanged.toFixed(), r.trades)),
  );
  await ch.insert(
    Table.TokenHourlyDex,
    hours.map((h) => row(h, '', '', '0', 0)),
  );
}

/** Adds an amount to a token's hour, unless its side is the native currency (no issuer). */
function add(into: Map<string, TokenHour>, hour: number, issuer: string, currency: string, amount: BigNumber, trades: number) {
  if (issuer === '') return;
  const key = keyOf(hour, issuer, currency);
  const v = into.get(key) ?? { hour, issuer, currency, exchanged: new BigNumber(0), trades: 0 };
  v.exchanged = v.exchanged.plus(amount);
  v.trades += trades;
  into.set(key, v);
}

interface PairRowRead {
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  source: 'book' | 'amm';
  count: string;
  base_sum: string;
  counter_sum: string;
  unfit: number;
}

/**
 * The DEX hour of `hour` from its `pair_hourly` set (spec 4.5, live): `'not_final'` unless the hour's newest set is final and of the
 * current `PAIR_HOURLY_CONFIG_VERSION`. Each pair row gives its `base_sum` to the base token and its `counter_sum` to the counter
 * token, its `count` to both; a pair-hour with an amount its exact sums could not hold (`unfit > 0`) is summed again from `exchanges`
 * (the pair's key prefix and the hour's ledgers) in BigNumber. Writes the rows, then the sentinel.
 */
export async function dexHoursFromPairHourly(ch: ClickHouseService, hour: Date): Promise<'written' | 'not_final'> {
  const start = Math.floor(hour.getTime() / 1000 / HOUR) * HOUR;
  const set = (await pairHourSets(ch, start, start + HOUR)).get(start);
  if (set === undefined || !set.final || set.configVersion !== PAIR_HOURLY_CONFIG_VERSION) return 'not_final';
  const rows = await ch.query<PairRowRead>(
    `SELECT base_currency, base_issuer, counter_currency, counter_issuer, source, toString(count) AS count, base_sum, counter_sum,
            unfit
       FROM ${Table.PairHourly}
      WHERE hour = toDateTime({hour:UInt32}, 'UTC') AND version = {version:UInt64}
        AND NOT (base_currency = '' AND base_issuer = '' AND counter_currency = '' AND counter_issuer = '')`,
    { hour: start, version: set.version },
  );
  const ledgers = rows.some((r) => r.unfit > 0) ? await ledgersOfHour(ch, start) : undefined;
  const tokens = new Map<string, TokenHour>();
  for (const r of rows) {
    let base = new BigNumber(r.base_sum);
    let counter = new BigNumber(r.counter_sum);
    if (r.unfit > 0 && ledgers !== undefined) {
      const trades = await ch.query<{ base_amount: string; counter_amount: string }>(
        `SELECT base_amount, counter_amount FROM ${Table.Exchanges}
          WHERE base_currency = {base_currency:String} AND base_issuer = {base_issuer:String}
            AND counter_currency = {counter_currency:String} AND counter_issuer = {counter_issuer:String}
            AND ledger_index >= {first:UInt32} AND ledger_index <= {last:UInt32}
            AND ${KEEP_ANY_PAIR} AND (amm_account != '') = {amm:Bool}
          ORDER BY ${EXCHANGE_KEY}
          LIMIT 1 BY ${EXCHANGE_KEY}`,
        { ...r, first: ledgers.first, last: ledgers.last, amm: r.source === 'amm' },
      );
      base = trades.reduce((s, t) => s.plus(t.base_amount), new BigNumber(0));
      counter = trades.reduce((s, t) => s.plus(t.counter_amount), new BigNumber(0));
    }
    const count = Number(r.count);
    add(tokens, start, r.base_issuer, r.base_currency, base, count);
    add(tokens, start, r.counter_issuer, r.counter_currency, counter, count);
  }
  await writeDexSets(ch, [...tokens.values()], [start]);
  return 'written';
}

/** The oldest hour whose `pair_hourly` set is final, of the current config: where the live DEX hours begin. */
export async function oldestFinalPairHour(ch: ClickHouseService): Promise<number | undefined> {
  const row = await ch.queryOne<{ hour: number | null }>(
    `SELECT toUnixTimestamp(minOrNull(hour)) AS hour FROM ${Table.PairHourly}
      WHERE base_currency = '' AND base_issuer = '' AND counter_currency = '' AND counter_issuer = ''
        AND is_final = 1 AND config_version = {config:UInt32}`,
    { config: PAIR_HOURLY_CONFIG_VERSION },
  );
  return row?.hour == null ? undefined : Number(row.hour);
}

/** The hour the history may not reach: the oldest final `pair_hourly` hour, or the hour of the newest ledger (not final yet). */
async function historyLimit(ch: ClickHouseService): Promise<number> {
  const newest = await ch.queryOne<{ hour: number | null }>(
    `SELECT toUnixTimestamp(toStartOfHour(close_time)) AS hour FROM ${Table.Ledgers} ORDER BY ledger_index DESC LIMIT 1`,
  );
  const pair = await oldestFinalPairHour(ch);
  const ledgerHour = newest?.hour == null ? 0 : Number(newest.hour);
  return pair === undefined ? ledgerHour : Math.min(pair, ledgerHour);
}

/** The partition's exchanges, each once (a group of the whole key), with their hour and their exact amounts. */
const PARTITION_TRADES_SQL = `SELECT toUnixTimestamp(toStartOfHour(any(close_time))) AS hour, base_currency, base_issuer, counter_currency,
       counter_issuer, any(base_exact) AS base_exact, any(counter_exact) AS counter_exact, any(base_amount) AS base_text,
       any(counter_amount) AS counter_text
  FROM (SELECT ${EXCHANGE_KEY}, close_time, base_amount, counter_amount, ${exactAmount('base_amount')} AS base_exact,
               ${exactAmount('counter_amount')} AS counter_exact
          FROM ${Table.Exchanges}
         WHERE ledger_index >= {first:UInt32} AND ledger_index <= {last:UInt32} AND ${KEEP_ANY_PAIR})
 GROUP BY ${EXCHANGE_KEY}`;

/** The sides of the partition's trades in the history's hours, a row per token side (the native one left out). */
const PARTITION_SIDES_SQL = `SELECT hour, side.1 AS issuer, side.2 AS currency, side.3 AS amount, side.4 AS text
  FROM (${PARTITION_TRADES_SQL})
 ARRAY JOIN [tuple(base_issuer, base_currency, base_exact, base_text), tuple(counter_issuer, counter_currency, counter_exact, counter_text)] AS side
 WHERE side.1 != '' AND hour >= {from:UInt32} AND hour < {to:UInt32}`;

/**
 * The DEX history of one partition of `exchanges` (spec 4.5, history): one scan, grouped by hour and token with the exact rule; a
 * token-hour with an amount the decimal cannot hold is summed again in BigNumber from a second scan of its rows. It covers the whole
 * hours of the partition's ledgers (an hour that starts in the partition before is read whole) below the oldest final `pair_hourly`
 * hour and the hour of the newest ledger, writes the rows, then the sentinel of every one of those hours. Returns how many hours.
 */
export async function dexHistoryPartition(ch: ClickHouseService, partition: number): Promise<{ hours: number }> {
  if (!Number.isInteger(partition) || partition < 0) throw new RangeError(`not a partition of exchanges: ${partition}`);
  const lo = partition * EXCHANGES_PARTITION;
  const hi = lo + EXCHANGES_PARTITION - 1;
  const span = await ch.queryOne<{ first_hour: number | null; last_hour: number | null; n: string }>(
    `SELECT toUnixTimestamp(toStartOfHour(min(close_time))) AS first_hour, toUnixTimestamp(toStartOfHour(max(close_time))) AS last_hour,
            toString(count()) AS n
       FROM ${Table.Ledgers} WHERE ledger_index >= {lo:UInt32} AND ledger_index <= {hi:UInt32}`,
    { lo, hi },
  );
  if (span === undefined || span.n === '0') return { hours: 0 };
  const limit = await historyLimit(ch);
  const fromHour = Number(span.first_hour);
  const toHour = Math.min(Number(span.last_hour) + HOUR, limit);
  if (toHour <= fromHour) return { hours: 0 };
  const firstRange = await ledgersOfHour(ch, fromHour);
  const lastRange = await ledgersOfHour(ch, toHour - HOUR);
  const params = {
    first: firstRange?.first ?? lo,
    last: lastRange?.last ?? hi,
    from: fromHour,
    to: toHour,
  };
  const groups = await ch.query<{ hour: number; issuer: string; currency: string; exact: string | null; unfit: number; trades: string }>(
    `SELECT hour, issuer, currency, toString(sum(amount)) AS exact, toUInt32(countIf(isNull(amount))) AS unfit,
            toString(count()) AS trades
       FROM (${PARTITION_SIDES_SQL})
      GROUP BY hour, issuer, currency`,
    params,
    { optimize_aggregation_in_order: 1 },
  );
  const tokens = new Map<string, TokenHour>();
  const unfit: string[] = [];
  for (const g of groups) {
    const key = keyOf(g.hour, g.issuer, g.currency);
    if (g.unfit > 0) unfit.push(key);
    tokens.set(key, {
      hour: g.hour,
      issuer: g.issuer,
      currency: g.currency,
      exchanged: new BigNumber(g.exact ?? 0),
      trades: Number(g.trades),
    });
  }
  if (unfit.length > 0) {
    const sides = await ch.query<{ hour: number; issuer: string; currency: string; text: string }>(
      `SELECT hour, issuer, currency, text FROM (${PARTITION_SIDES_SQL})
        WHERE concat(toString(hour), '|', issuer, '|', currency) IN {keys:Array(String)}`,
      { ...params, keys: unfit },
      { optimize_aggregation_in_order: 1 },
    );
    for (const key of unfit) tokens.get(key)!.exchanged = new BigNumber(0);
    for (const s of sides) {
      const t = tokens.get(keyOf(s.hour, s.issuer, s.currency))!;
      t.exchanged = t.exchanged.plus(s.text);
    }
  }
  const hours: number[] = [];
  for (let h = fromHour; h < toHour; h += HOUR) hours.push(h);
  await writeDexSets(ch, [...tokens.values()], hours);
  return { hours: hours.length };
}

/**
 * The newest partition of `exchanges` with an hour of stored ledgers that has no DEX sentinel, below the hour the history may reach
 * (the oldest final `pair_hourly` hour, and the hour of the newest ledger); `undefined` when every such hour has one.
 */
export async function nextDexPartition(ch: ClickHouseService): Promise<number | undefined> {
  const limit = await historyLimit(ch);
  const row = await ch.queryOne<{ p: number | null }>(
    `SELECT maxOrNull(p) AS p FROM (
       SELECT intDiv(ledger_index, ${EXCHANGES_PARTITION}) AS p, toStartOfHour(close_time) AS hour
         FROM ${Table.Ledgers}
        WHERE close_time < toDateTime({limit:UInt32}, 'UTC')
        GROUP BY p, hour)
      WHERE hour NOT IN (SELECT hour FROM ${Table.TokenHourlyDex} WHERE ${SENTINEL})`,
    { limit },
  );
  return row?.p == null ? undefined : Number(row.p);
}

/** The end of the newest unbroken run of DEX sentinel hours (the run that holds the newest one), `undefined` without a sentinel. */
export async function dexThrough(ch: ClickHouseService): Promise<Date | undefined> {
  const row = await ch.queryOne<{ hour: number | null }>(
    `SELECT toUnixTimestamp(hour) AS hour FROM ${Table.TokenHourlyDex} WHERE ${SENTINEL} ORDER BY hour DESC LIMIT 1`,
  );
  return row?.hour == null ? undefined : new Date((Number(row.hour) + HOUR) * 1000);
}
