import { badRequest } from '../common/errors';
import { fmtTime } from '../common/format';
import { first, Query } from '../common/params';

/** The families of a stat: what `lib/aggregation/stats.js` counted. */
export const STATS_FAMILIES = ['type', 'result', 'metric'] as const;
export type StatsFamily = (typeof STATS_FAMILIES)[number];

/** The `interval`s of `/v2/stats`: an hour, a day, or a week (Monday to Sunday, UTC). */
export const STATS_INTERVALS = ['hour', 'day', 'week'] as const;
export type StatsInterval = (typeof STATS_INTERVALS)[number];

/**
 * The columns of the family `metric`, sorted by name: HBase gave the columns of a row sorted, and so the original served
 * them, whatever the order in which they were asked for.
 */
export const STATS_METRICS = [
  'accounts_created',
  'exchanges_count',
  'ledger_count',
  'ledger_interval',
  'payments_count',
  'transaction_count',
  'tx_per_ledger',
] as const;
export type StatsMetric = (typeof STATS_METRICS)[number];

/** A count as ClickHouse hands it over: a number or, depending on the settings of the client, the text of its digits. */
type Count = number | string;

/**
 * An hour, day or week as the query reads it: the hours of `stats_hourly` added up. `bucket` is its start and
 * `last_close` the close time of its last ledger, both unix seconds.
 */
export interface StoredStats {
  bucket: Count;
  transaction_count: Count;
  payments_count: Count;
  exchanges_count: Count;
  accounts_created: Count;
  ledger_count: Count;
  last_close: Count;
  types: Record<string, Count>;
  results: Record<string, Count>;
}

/** The counts of a family, by name. */
export type StatsCounts = Record<string, number>;

/** A row of the list without a family. */
export interface NestedStats {
  date: string;
  type: StatsCounts;
  result: StatsCounts;
  metric: StatsCounts;
}

/** A row of the list of a family: its columns by name, `date` last. */
export type FlatStats = Record<string, number | string>;

/**
 * Where the buckets of an interval start, in unix seconds. An hour and a day are multiples of their size since the epoch;
 * a week starts on Monday, and 1970-01-01 was a Thursday, so the first Monday is four days on.
 */
const SIZE: Record<StatsInterval, number> = { hour: 3600, day: 86_400, week: 604_800 };
const OFFSET: Record<StatsInterval, number> = { hour: 0, day: 0, week: 4 * 86_400 };

export const bucketAlign = {
  /** The length of a bucket. */
  size: (interval: StatsInterval): number => SIZE[interval],
  /** The start of the bucket a time is in. */
  floor: (interval: StatsInterval, seconds: number): number =>
    Math.floor((seconds - OFFSET[interval]) / SIZE[interval]) * SIZE[interval] + OFFSET[interval],
  /** The first bucket start at or after a time. */
  ceil: (interval: StatsInterval, seconds: number): number =>
    Math.ceil((seconds - OFFSET[interval]) / SIZE[interval]) * SIZE[interval] + OFFSET[interval],
};

// -- the request -----------------------------------------------------------------------------------------------------

/** What a request asks for: a family (as the client wrote it, lower-cased; empty for none) and, optionally, columns of it. */
export interface StatsSelection {
  family: string;
  /** The names of the columns, without the family. Not lower-cased: the columns of the original were case-sensitive. */
  names?: string[];
}

/**
 * The family and the metrics of a request, as `prepareOptions` of the original read them. The family is the one of the path,
 * else `family=`, lower-cased; `/:family/:metric` is that one metric, and `metrics=a,b` (of the query, when the path names no
 * metric) is a list. Metrics need a family: 400 `family is required`.
 */
export function statsSelection(params: { family?: string; metric?: string }, query: Query): StatsSelection {
  const family = (params.family || first(query, 'family') || '').toLowerCase();
  if (params.metric) return { family, names: [params.metric] };
  const metrics = first(query, 'metrics');
  if (metrics) {
    if (!family) throw badRequest('family is required');
    return { family, names: metrics.split(',') };
  }
  return { family };
}

/** The family a selection names, `undefined` for none; 400 for one the aggregation does not have. */
export function checkFamily(family: string): StatsFamily | undefined {
  if (family === '') return undefined;
  if (!(STATS_FAMILIES as readonly string[]).includes(family)) {
    throw badRequest(`invalid family, use: ${STATS_FAMILIES.join(', ')}`);
  }
  return family as StatsFamily;
}

/**
 * The name of the CSV file, without `.csv`: `stats`, then ` family`, then `-family:metric` for every metric asked for
 * (the original kept the family in front of the name of the column, as it asked HBase for it).
 */
export function statsFilename(selection: StatsSelection): string {
  const { family, names } = selection;
  return (
    'stats' + (family ? ` ${family}` : '') + (names ? `-${names.map((name) => `${family}:${name}`).join('-')}` : '')
  );
}

// -- the rows --------------------------------------------------------------------------------------------------------

/** The nonzero counts of a family, sorted by name (code units, as HBase sorted the bytes of ASCII names). */
function countsOf(map: Record<string, Count>): StatsCounts {
  return Object.fromEntries(
    Object.entries(map)
      .map(([name, count]): [string, number] => [name, Number(count)])
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** `avg.toPrecision(5)` of the aggregation, which stored the text and was read back as a number. */
const fiveDigits = (value: number): number => Number(value.toPrecision(5));

/**
 * The metrics of a bucket, by name in sorted order, zero left out. `tx_per_ledger` is the transactions over the ledgers and
 * `ledger_interval` the seconds from the start of the bucket to its last ledger over the ledgers, both to five significant
 * digits as the aggregation kept them.
 */
function metricsOf(stored: StoredStats): StatsCounts {
  const ledgers = Number(stored.ledger_count);
  const transactions = Number(stored.transaction_count);
  const all: Record<StatsMetric, number> = {
    accounts_created: Number(stored.accounts_created),
    exchanges_count: Number(stored.exchanges_count),
    ledger_count: ledgers,
    ledger_interval: ledgers > 0 ? fiveDigits((Number(stored.last_close) - Number(stored.bucket)) / ledgers) : 0,
    payments_count: Number(stored.payments_count),
    transaction_count: transactions,
    tx_per_ledger: ledgers > 0 ? fiveDigits(transactions / ledgers) : 0,
  };
  return Object.fromEntries(
    STATS_METRICS.filter((name) => all[name] > 0).map((name): [string, number] => [name, all[name]]),
  );
}

/** The row of a list without a family: `{date, type, result, metric}`. */
export function nestedStats(stored: StoredStats): NestedStats {
  return {
    date: fmtTime(Number(stored.bucket)),
    type: countsOf(stored.types),
    result: countsOf(stored.results),
    metric: metricsOf(stored),
  };
}

/**
 * The row of a list of a family: the columns of the family (only the ones asked for, with `names`) in sorted order and `date`
 * after them, as the HBase row had them. A bucket that has none of the columns is not a row (`undefined`): the original's scan
 * did not return a row without the columns it asked for.
 */
export function flatStats(stored: StoredStats, family: StatsFamily, names?: string[]): FlatStats | undefined {
  const columns =
    family === 'type' ? countsOf(stored.types) : family === 'result' ? countsOf(stored.results) : metricsOf(stored);
  const picked = Object.entries(columns).filter(([name]) => names === undefined || names.includes(name));
  if (picked.length === 0) return undefined;
  return { ...Object.fromEntries(picked), date: fmtTime(Number(stored.bucket)) };
}
