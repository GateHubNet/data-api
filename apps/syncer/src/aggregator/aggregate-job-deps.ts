import {
  accountPartitionRows,
  ClickHouseService,
  computeMarketsSet,
  computePairHourSets,
  computeRatesDailySet,
  countPartitionSlice,
  firstChangeDay,
  firstNativeTradeDay,
  heavyAccounts,
  marketsSetEndTimes,
  markRatesStale,
  newestLedgerClose,
  pairHourSets,
  partitionDays,
  partitionFirstDay,
  partitionSetVersions,
  RatesService,
  rollupStates,
  Table,
  validRateDays,
  VOLUME_DAY_SETTLE_MS,
  writeAccountRollups,
  writePartitionSet,
  writeRollupStates,
} from '@gatehub/data-api-shared';
import type { Logger } from '@nestjs/common';
import type { PrometheusService } from '../modules/prometheus/prometheus.service';

/**
 * What the runners of the account and market jobs (`pair_hourly`, `markets_live`, `rates_daily`, `account_rollups`) share: the
 * little of the `AggregatorService` they are lent, the functions of the shared package they call, and the wait of a set that
 * keeps failing. A runner imports this file, the shared package and the types of `aggregator.service.ts`, and nothing else of
 * the aggregator.
 */

/**
 * What a runner is lent by the `AggregatorService`: the database, the log and the metrics, the clock, the budget of its job,
 * whether the stop has begun, and the one rule of failure that every job shares (how it is logged and counted, and what the
 * shutdown does to it). A runner's own state (its cursors, its waits, what it has announced) is its own.
 */
export interface AggregateJobDeps {
  readonly ch: ClickHouseService;
  readonly logger: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>;
  readonly metrics?: PrometheusService;
  /** The most of a tick the job may use (`AggregatorJob.budgetMs`). */
  readonly budgetMs: number;
  /** The clock, in unix milliseconds. */
  clock(): number;
  /** Whether the stop has begun: nothing starts, and nothing is written, after it. */
  closing(): boolean;
  /** Logs and counts a failure of a job (or of one set of it); one that comes of the shutdown is neither. */
  failed(job: string, err: unknown, where?: string): void;
}

/** What the runners work with: the rates of the network, and the size from which an account is rolled up (`0`: none is). */
export interface AggregatorAggregates {
  rates: RatesService;
  accountRollupMinRows: number;
}

/** `YYYY-MM-DDTHH:mm:ssZ` of a unix time in seconds, as the log lines and the answers spell a time. */
export const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;

/** `YYYY-MM-DD`, the UTC day of a unix time in seconds. */
export const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

export const DAY_SECONDS = 86_400;

/**
 * The start (unix seconds) of the newest **final** UTC day: one that is over and that the ingest has passed, the newest
 * committed ledger having closed at least `VOLUME_DAY_SETTLE_MS` after its end (as the volume back-fill has it). Today is
 * never final, and yesterday only once the ledger of its first hour is there. `newestClose` is the close time of the newest
 * ledger, `now` the time of the tick.
 */
export function newestFinalDay(newestClose: number, now: Date): number {
  const floorDay = (seconds: number): number => Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
  return Math.min(
    floorDay(Math.floor(now.getTime() / 1000)) - DAY_SECONDS,
    floorDay(newestClose - VOLUME_DAY_SETTLE_MS / 1000) - DAY_SECONDS,
  );
}

/**
 * The close time of the oldest ingested ledger (the lowest index: a read of the start of the primary key), unix seconds;
 * none without a ledger.
 */
export async function firstLedgerClose(ch: ClickHouseService): Promise<number | undefined> {
  const row = await ch.queryOne<{ closed: number | string }>(
    `SELECT toUnixTimestamp(close_time) AS closed FROM ${Table.Ledgers} ORDER BY ledger_index ASC LIMIT 1`,
  );
  return row === undefined ? undefined : Number(row.closed);
}

/** The functions the runners call; tests replace them (a runner takes the ones to replace as its last argument). */
export interface AggregateFunctions {
  computePairHourSets: typeof computePairHourSets;
  pairHourSets: typeof pairHourSets;
  computeMarketsSet: typeof computeMarketsSet;
  marketsSetEndTimes: typeof marketsSetEndTimes;
  newestLedgerClose: typeof newestLedgerClose;
  firstLedgerClose: typeof firstLedgerClose;
  computeRatesDailySet: typeof computeRatesDailySet;
  markRatesStale: typeof markRatesStale;
  validRateDays: typeof validRateDays;
  firstNativeTradeDay: typeof firstNativeTradeDay;
  rollupStates: typeof rollupStates;
  writeRollupStates: typeof writeRollupStates;
  writeAccountRollups: typeof writeAccountRollups;
  countPartitionSlice: typeof countPartitionSlice;
  writePartitionSet: typeof writePartitionSet;
  partitionSetVersions: typeof partitionSetVersions;
  heavyAccounts: typeof heavyAccounts;
  accountPartitionRows: typeof accountPartitionRows;
  firstChangeDay: typeof firstChangeDay;
  partitionDays: typeof partitionDays;
  partitionFirstDay: typeof partitionFirstDay;
}

export function defaultAggregateFunctions(): AggregateFunctions {
  return {
    computePairHourSets,
    pairHourSets,
    computeMarketsSet,
    marketsSetEndTimes,
    newestLedgerClose,
    firstLedgerClose,
    computeRatesDailySet,
    markRatesStale,
    validRateDays,
    firstNativeTradeDay,
    rollupStates,
    writeRollupStates,
    writeAccountRollups,
    countPartitionSlice,
    writePartitionSet,
    partitionSetVersions,
    heavyAccounts,
    accountPartitionRows,
    firstChangeDay,
    partitionDays,
    partitionFirstDay,
  };
}

/**
 * A set that failed is left alone for this long before it is tried again, and for twice as long after each further failure,
 * up to `AGGREGATE_MAX_RETRY_MS`: a set that fails every time (bad data, a query over the memory limit) must not keep the
 * others from running. Kept in memory: a restart tries them all again.
 */
export const AGGREGATE_RETRY_MS = 5 * 60_000;
export const AGGREGATE_MAX_RETRY_MS = 60 * 60_000;

/** A runner gives up after this many sets failed in a tick, so that an outage does not log a line per set. */
export const MAX_FAILED_AGGREGATE_SETS_PER_TICK = 3;

/** The waits of the sets that failed, by key (the clock is the caller's, in unix milliseconds). */
export class SetBackoff {
  private readonly waits = new Map<string, { until: number; delayMs: number }>();

  /** Whether the set failed and its wait is not over at `now`. */
  waiting(key: string, now: number): boolean {
    const wait = this.waits.get(key);
    return wait !== undefined && wait.until > now;
  }

  /** The set failed at `now`: it waits `AGGREGATE_RETRY_MS`, or twice its last wait (at most `AGGREGATE_MAX_RETRY_MS`). */
  failed(key: string, now: number): void {
    const last = this.waits.get(key);
    const delayMs = last === undefined ? AGGREGATE_RETRY_MS : Math.min(last.delayMs * 2, AGGREGATE_MAX_RETRY_MS);
    this.waits.set(key, { until: now + delayMs, delayMs });
  }

  /** The set worked: it has no wait to remember. */
  done(key: string): void {
    this.waits.delete(key);
  }

  /** Forgets the waits of every set that is not in `keys` (a set that is done, or no longer wanted, has none). */
  keepOnly(keys: ReadonlySet<string>): void {
    for (const key of [...this.waits.keys()]) if (!keys.has(key)) this.waits.delete(key);
  }
}

/**
 * Whether a runner may start another set. Not after the shutdown began, and not once the deadline of the tick has passed.
 * Running out of the budget is how a long back-fill works, tick after tick, so it is said once (a warning) for as long as the
 * runs of the job keep hitting it and at debug level after that; a run that finishes in time ends the streak (`endRun`).
 */
export class SetGate {
  private hit = false;
  private warned = false;

  constructor(
    private readonly deps: Pick<AggregateJobDeps, 'logger' | 'clock' | 'closing'>,
    private readonly job: string,
  ) {}

  /** `deadline` is the clock reading (`AggregatorTick.deadline`) after which no set starts. */
  mayStart(deadline: number): boolean {
    if (this.deps.closing()) return false;
    if (this.deps.clock() < deadline) return true;
    this.hit = true;
    const text = `Aggregator job ${this.job} reached its budget; the sets left go on next tick`;
    if (this.warned) {
      this.deps.logger.debug(text);
    } else {
      this.warned = true;
      this.deps.logger.warn(`${text} (said once until a tick finishes in time)`);
    }
    return false;
  }

  /** The run is over: if it did not hit its budget, the warning is out of date. */
  endRun(): void {
    if (!this.hit) this.warned = false;
    this.hit = false;
  }
}
