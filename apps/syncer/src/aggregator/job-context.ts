import { ClickHouseService, VOLUME_DAY_SETTLE_MS } from '@gatehub/data-api-shared';
import { Logger } from '@nestjs/common';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/** What a job is handed by the tick it runs in. */
export interface AggregatorTick {
  /** The time of the tick. */
  now: Date;
  /** The clock reading (`Date.now()` scale, milliseconds) after which a job should not start another slice. */
  deadline: number;
  /** Aborted when the shutdown begins: pass it to whatever writes, so that nothing is written after that. */
  signal: AbortSignal;
}

/** The jobs the aggregator has of its own, in the order of a tick. */
export type AggregatorJobName =
  | 'volume_live'
  | 'volume_daily'
  | 'amm_pools'
  | 'pair_hourly'
  | 'markets_live'
  | 'stats_live'
  | 'stats_dirty'
  | 'amm_daily'
  | 'rates_daily'
  | 'account_rollups'
  | 'volume_backfill';

/**
 * What the `AggregatorService` lends the runners of its jobs that live in files of their own (`amm_pools`, `amm_daily`): the
 * database, the log and the metrics, the clock, the budgets, whether the stop has begun, and the rules that every job of the
 * tick shares (when a set may start, how a failure is logged and counted, the versions of the sets, the newest ledger, the
 * announcements of a back-fill). The state of a job (its cursor, its retries) is the runner's own.
 */
export interface AggregatorJobContext {
  readonly ch: ClickHouseService;
  readonly logger: Pick<Logger, 'log' | 'warn' | 'error' | 'debug'>;
  readonly metrics?: PrometheusService;
  /** The budget of each job (`AggregatorJob.budgetMs`). */
  readonly budgets: Readonly<Record<AggregatorJobName, number>>;
  /** The clock, in unix milliseconds. */
  clock(): number;
  /** Whether the stop has begun: nothing starts, and nothing is written, after it. */
  closing(): boolean;
  /** Whether a job that works in sets or batches may start another (see `AggregatorService.mayStartSet`). */
  mayStartSet(tick: AggregatorTick, job: string): boolean;
  /** Logs and counts a failure of a job (or of one slice of it); one that comes of the shutdown is neither. */
  failed(job: string, err: unknown, where?: string): void;
  /** The newest version of each set, for `staleFirst`; the default order when the read fails (logged and counted). */
  versionsOf(job: string, read: () => Promise<Map<string, number>>): Promise<Map<string, number>>;
  /** The close time of the newest ledger, unix seconds; none without a ledger. */
  latestCloseTime(): Promise<number | undefined>;
  /** Says once that a back-fill is under way (and how much there is), and once that it is done. */
  announceBackfill(job: 'volume' | 'amm_daily', under: boolean, count: number): void;
}

export const DAY_SECONDS = 86_400;
/** The start of the UTC day of a time, unix seconds. */
export const utcDayStart = (seconds: number): number => Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
/** `YYYY-MM-DD` of the UTC day that starts at `seconds`. */
export const dayKey = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);
export const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The end (exclusive, unix seconds) of the closed days: a day is closed when it is before yesterday AND the ingest has passed
 * it (the newest ingested ledger closed `VOLUME_DAY_SETTLE_MS` after its end: R86). By wall clock alone a day would be taken for
 * final while its ledgers are still to come. The back-fills of the volume sets and of `amm_daily` use the same rule.
 */
export function closedUntil(nowSeconds: number, newestCloseSeconds: number): number {
  return Math.min(utcDayStart(nowSeconds) - DAY_SECONDS, utcDayStart(newestCloseSeconds - VOLUME_DAY_SETTLE_MS / 1000));
}

/** When a set that failed is tried again: and what it waits after the next failure. */
export interface Backoff {
  until: number;
  delayMs: number;
  /** A day of `amm_daily` that failed on the dirty path: it is owed a recompute even though it is final. */
  owed?: boolean;
}

/**
 * The wait after a failure of a set that is retried: `firstMs` the first time, twice the last wait (at most `maxMs`) after
 * each further failure. The back-fills of the volume sets and of `amm_daily` use the same rule.
 */
export function backoffAfterFailure(
  previous: Backoff | undefined,
  now: number,
  firstMs: number,
  maxMs: number,
): Backoff {
  const delayMs = previous === undefined ? firstMs : Math.min(previous.delayMs * 2, maxMs);
  return { until: now + delayMs, delayMs };
}

/**
 * The sets in the order they are started: first the ones whose last attempt did not fail, then the ones whose did, and within
 * each group the one whose newest version is the oldest first, a set with no version (never written) before all of them, equals
 * in the order they are listed in. A set that keeps failing is always the stalest, so without the second rule it would start
 * first at every tick, and a failure that is slow (a timeout longer than the budget), or three fast ones, would keep every
 * healthy set from being refreshed; it is tried last instead, with the budget that is left.
 */
export function staleFirst<T extends { key: string }>(
  sets: T[],
  versions: ReadonlyMap<string, number>,
  failedLast: ReadonlySet<string> = new Set(),
): T[] {
  return sets
    .map((set, i) => ({ set, i, version: versions.get(set.key) ?? 0, failed: failedLast.has(set.key) ? 1 : 0 }))
    .sort((a, b) => a.failed - b.failed || a.version - b.version || a.i - b.i)
    .map(({ set }) => set);
}

/** A volume job (and the back-fill of `amm_daily`) gives up after this many sets failed in a tick, so that an outage does not log a line per set. */
export const MAX_FAILED_VOLUME_SETS_PER_TICK = 3;
