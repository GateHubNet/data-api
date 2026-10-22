import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { PairHourlyRow } from '../clickhouse/rows';
import { Table } from '../clickhouse/tables';
import { AGGREGATE_COLUMNS, AGGREGATE_SOURCE_COLUMNS } from '../query/candle-columns';
import { VolumeSums } from '../query/decimal';
import { KEEP_ANY_PAIR, RatesService } from '../query/rates.service';
import { AggregateSetOptions, newestLedgerClose, nextSetVersion, throwIfSetAborted } from './aggregate-sets';

/**
 * The `pair_hourly` job: for each UTC hour, the candle of every pair and source (the trades of the hour summed, with the
 * open, close, high and low rate and the `(ledger, tx, node)` key of the trade each came from), kept in `pair_hourly` so
 * that the markets and the sparklines read a few rows per pair and hour instead of its trades. The source is `amm` for
 * a swap against a pool (a row of `exchanges` with `amm_account` set) and `book` for an order-book trade: a pair with
 * both in an hour has a row of each, and each is the candle of its own trades.
 *
 * An hour is a **set**: a row for each pair and source that has a kept trade in it (native legs of 0.0005 or less are
 * left out, swaps too, as in candles and `reduce`: `KEEP_ANY_PAIR`) and a **sentinel** row (the empty pair, source
 * `book`) that every hour has, trades or not.
 * Every row of the set carries the set's `is_final` (a ledger closed at or after the hour's end, so no trade can still
 * come), `config_version` and `through_time` (the close time of the hour's newest ledger, or the hour's start when it
 * has none). The whole set is one insert under one version, and a reader takes the newest sentinel of an hour
 * (`pairHourSets`) and then the rows of that version. Which hours are due, and when, is the runner's.
 */

/**
 * The version of what a set means: a change of the candle rules is a new one, and every hour is computed again. 2 is the
 * split of each pair by source (`book`, `amm`); 1 had one row per pair, of the order book and the pools together.
 */
export const PAIR_HOURLY_CONFIG_VERSION = 2;

/** How many days back the aggregator keeps sets for (the table's TTL, 45 days, drops what is older). */
export const PAIR_HOURLY_DAYS = 31;

const HOUR = 3600;
const DAY = 86_400;

const PAIR_COLUMNS = ['base_currency', 'base_issuer', 'counter_currency', 'counter_issuer'];
/**
 * The whole key of `exchanges`, spelled out: ClickHouse then reads in the order of the primary key and does not sort,
 * and `LIMIT 1 BY` it counts a row that was written twice once.
 */
const KEY_COLUMNS = [...PAIR_COLUMNS, 'ledger_index', 'tx_index', 'node_index'];
const TRADE_KEY = '(ledger_index, tx_index, node_index)';
/** The sentinel of a set: the empty pair. */
const SENTINEL = "base_currency = '' AND base_issuer = '' AND counter_currency = '' AND counter_issuer = ''";
/** The rows of an hour's sets, which tell the newest version the hour has. */
const ROWS_OF_HOUR = "hour = toDateTime({hour:UInt32}, 'UTC')";

/** The key of a trade: its ledger, transaction and node. */
type TradeKey = [ledger: number, tx: number, node: number];

/** One group of the read of `exchanges`: a pair and source in an hour. `n` and the sums are those of `volumeColumns`. */
interface PairHourGroup extends VolumeSums {
  hour_start: number;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  source: 'book' | 'amm';
  open_rate: string;
  close_rate: string;
  high_rate: string;
  low_rate: string;
  /** Unix seconds of the close time of the first trade and of the last. */
  open_ts: number;
  close_ts: number;
  open_key: TradeKey;
  close_key: TradeKey;
  high_key: TradeKey;
  low_key: TradeKey;
  high_rate_f: number;
  low_rate_f: number;
}

/** What is common to the rows of a set. */
interface SetFields {
  hour: number;
  is_final: 0 | 1;
  through_time: number;
  version: number;
}

/** The newest set of an hour: what `pairHourSets` reads from its sentinel. */
export interface HourSet {
  /** The version of the set: all its rows have it. */
  version: number;
  /** A ledger closed at or after the hour's end when the set was made. */
  final: boolean;
  configVersion: number;
  /** The close time of the hour's newest ledger when the set was made, unix seconds (the hour's start without one). */
  throughTime: number;
}

/** The sentinel of an hour's set: the empty pair, source book, no trade, and the times of the hour. */
function sentinelOf(set: SetFields): PairHourlyRow {
  return {
    hour: set.hour,
    base_currency: '',
    base_issuer: '',
    counter_currency: '',
    counter_issuer: '',
    source: 'book',
    count: 0,
    base_sum: '0',
    counter_sum: '0',
    unfit: 0,
    base_sum_f: 0,
    counter_sum_f: 0,
    open_rate: '',
    open_ledger: 0,
    open_tx: 0,
    open_node: 0,
    open_time: set.hour,
    close_rate: '',
    close_ledger: 0,
    close_tx: 0,
    close_node: 0,
    close_time: set.hour,
    high_rate: '',
    high_rate_f: 0,
    high_ledger: 0,
    high_tx: 0,
    high_node: 0,
    low_rate: '',
    low_rate_f: 0,
    low_ledger: 0,
    low_tx: 0,
    low_node: 0,
    is_final: set.is_final,
    config_version: PAIR_HOURLY_CONFIG_VERSION,
    through_time: set.through_time,
    version: set.version,
  };
}

/** The row of a pair and source in an hour. The sums are stored as ClickHouse wrote them (`'0'` for no amount to sum). */
function pairRowOf(g: PairHourGroup, set: SetFields): PairHourlyRow {
  return {
    ...sentinelOf(set),
    base_currency: g.base_currency,
    base_issuer: g.base_issuer,
    counter_currency: g.counter_currency,
    counter_issuer: g.counter_issuer,
    source: g.source,
    count: g.n,
    base_sum: g.base_sum ?? '0',
    counter_sum: g.counter_sum ?? '0',
    unfit: g.unfit,
    base_sum_f: g.base_sum_f ?? 0,
    counter_sum_f: g.counter_sum_f ?? 0,
    open_rate: g.open_rate,
    open_ledger: g.open_key[0],
    open_tx: g.open_key[1],
    open_node: g.open_key[2],
    open_time: g.open_ts,
    close_rate: g.close_rate,
    close_ledger: g.close_key[0],
    close_tx: g.close_key[1],
    close_node: g.close_key[2],
    close_time: g.close_ts,
    high_rate: g.high_rate,
    high_rate_f: g.high_rate_f,
    high_ledger: g.high_key[0],
    high_tx: g.high_key[1],
    high_node: g.high_key[2],
    low_rate: g.low_rate,
    low_rate_f: g.low_rate_f,
    low_ledger: g.low_key[0],
    low_tx: g.low_key[1],
    low_node: g.low_key[2],
  };
}

/** `[fromHour, toHour)` has to be 1 to 24 whole hours of one UTC day (unix seconds from 1970). */
function checkHours(fromHour: number, toHour: number): void {
  const whole = (t: number): boolean => Number.isInteger(t) && t >= 0 && t % HOUR === 0;
  if (
    !whole(fromHour) ||
    !whole(toHour) ||
    toHour <= fromHour ||
    Math.floor(fromHour / DAY) !== Math.floor((toHour - 1) / DAY)
  ) {
    throw new RangeError(`Not 1 to 24 whole hours of one UTC day: [${fromHour}, ${toHour})`);
  }
}

/**
 * Computes the sets of the hours of `[fromHour, toHour)` (unix seconds of whole hours, 1 to 24 of them, inside one UTC
 * day: else a `RangeError`) and writes them: each hour is one insert, the sentinel and a row for each pair and source with a
 * kept trade, under a version of its own. Returns how many sets it wrote, one for each hour of the range, an hour without a
 * trade included. The exchanges of the whole range are read once, however many hours it has.
 *
 * `is_final` is judged by the newest ledger, read before the others: a ledger that comes in later can only make an hour
 * more final than the set says. A `signal` that is aborted before the work, or before an insert, throws
 * `AggregateSetAborted`; the sets written before that stay, and none is written after.
 */
export async function computePairHourSets(
  ch: ClickHouseService,
  rates: RatesService,
  fromHour: number,
  toHour: number,
  options: AggregateSetOptions = {},
): Promise<number> {
  checkHours(fromHour, toHour);
  const { signal } = options;
  throwIfSetAborted(signal);

  const newest = await newestLedgerClose(ch);
  const range = await rates.ledgersClosedIn(new Date(fromHour * 1000), new Date(toHour * 1000));
  const groups = new Map<number, PairHourGroup[]>();
  const closed = new Map<number, number>();
  if (range) {
    const params = { min: range.min, max: range.max };
    const [pairs, ledgers] = await Promise.all([
      ch.query<PairHourGroup>(
        `SELECT toUnixTimestamp(toStartOfHour(close_time)) AS hour_start,
                ${PAIR_COLUMNS.join(', ')}, source,
                ${AGGREGATE_COLUMNS},
                min(${TRADE_KEY}) AS open_key,
                max(${TRADE_KEY}) AS close_key,
                argMax(${TRADE_KEY}, (rate_f, -toInt64(ledger_index), -toInt64(tx_index), -toInt32(node_index))) AS high_key,
                max(rate_f) AS high_rate_f,
                argMin(${TRADE_KEY}, (rate_f, ledger_index, tx_index, node_index)) AS low_key,
                min(rate_f) AS low_rate_f
           FROM (SELECT ${PAIR_COLUMNS.join(', ')}, if(amm_account != '', 'amm', 'book') AS source,
                        ${AGGREGATE_SOURCE_COLUMNS}
                   FROM ${Table.Exchanges}
                  WHERE ledger_index BETWEEN {min:UInt32} AND {max:UInt32} AND ${KEEP_ANY_PAIR}
                  ORDER BY ${KEY_COLUMNS.join(', ')}
                  LIMIT 1 BY ${KEY_COLUMNS.join(', ')})
          GROUP BY hour_start, ${PAIR_COLUMNS.join(', ')}, source
          ORDER BY hour_start, ${PAIR_COLUMNS.join(', ')}, source`,
        params,
      ),
      ch.query<{ hour_start: number; closed: number }>(
        `SELECT toUnixTimestamp(toStartOfHour(close_time)) AS hour_start, toUnixTimestamp(max(close_time)) AS closed
           FROM ${Table.Ledgers}
          WHERE ledger_index BETWEEN {min:UInt32} AND {max:UInt32}
          GROUP BY hour_start`,
        params,
      ),
    ]);
    for (const g of pairs) {
      const ofHour = groups.get(g.hour_start);
      if (ofHour) ofHour.push(g);
      else groups.set(g.hour_start, [g]);
    }
    for (const l of ledgers) closed.set(l.hour_start, l.closed);
  }

  for (let hour = fromHour; hour < toHour; hour += HOUR) {
    const version = await nextSetVersion(ch, Table.PairHourly, ROWS_OF_HOUR, { hour });
    throwIfSetAborted(signal);
    const set: SetFields = {
      hour,
      is_final: newest !== undefined && newest >= hour + HOUR ? 1 : 0,
      through_time: closed.get(hour) ?? hour,
      version,
    };
    await ch.insert(Table.PairHourly, [sentinelOf(set), ...(groups.get(hour) ?? []).map((g) => pairRowOf(g, set))]);
  }
  return (toHour - fromHour) / HOUR;
}

/**
 * The newest set of each hour of `[fromHour, toHour)` (unix seconds of whole hours), by hour start: read from the
 * sentinels, the newest version of an hour counting, and a set that was written twice once. An hour without a set is
 * not in the map.
 */
export async function pairHourSets(
  ch: ClickHouseService,
  fromHour: number,
  toHour: number,
): Promise<Map<number, HourSet>> {
  const rows = await ch.query<{
    hour_start: number;
    version: number | string;
    is_final: number;
    config_version: number;
    through: number;
  }>(
    `SELECT toUnixTimestamp(hour) AS hour_start, toUInt64(version) AS version, is_final, config_version,
            toUnixTimestamp(through_time) AS through
       FROM ${Table.PairHourly}
      WHERE ${SENTINEL} AND hour >= toDateTime({from:UInt32}, 'UTC') AND hour < toDateTime({to:UInt32}, 'UTC')
      ORDER BY hour, version DESC
      LIMIT 1 BY hour`,
    { from: fromHour, to: toHour },
  );
  return new Map(
    rows.map((r) => [
      Number(r.hour_start),
      {
        version: Number(r.version),
        final: Number(r.is_final) === 1,
        configVersion: Number(r.config_version),
        throughTime: Number(r.through),
      },
    ]),
  );
}
