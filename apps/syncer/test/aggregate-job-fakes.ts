import type { ClickHouseService } from '@gatehub/data-api-shared';
import type { AggregateJobDeps } from '../src/aggregator/aggregate-job-deps';
import type { AggregatorTick } from '../src/aggregator/aggregator.service';

/**
 * The fakes and the times the unit specs of the account and market job runners share (`pair-hourly.job-runner.spec.ts`,
 * `markets-live.job-runner.spec.ts`, ...): the deps a runner is built with, a quiet logger, and the instant the ticks run at.
 * The shared functions a runner calls are replaced by each spec's own fakes (the runner takes them as its third argument).
 */

export const HOUR = 3600;
export const DAY = 86_400;
export const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
export const unix = (text: string): number => Date.parse(text) / 1000;

/** 2026-10-16T12:34:56Z */
export const NOW = new Date('2026-10-16T12:34:56Z');

type FakeLogger = { log: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

export interface FakeDeps {
  readonly deps: AggregateJobDeps;
  readonly logger: FakeLogger;
  /** The calls of `deps.failed`, in order. */
  readonly failures: Array<{ job: string; err: unknown; where?: string }>;
  /** Set it to make `deps.closing()` true, as a shutdown does. */
  closing: boolean;
  /** The gauges the runners set. */
  readonly metrics: {
    pairHourlyMissingHours: { set: jest.Mock };
    marketsLiveAgeSeconds: { set: jest.Mock };
    ratesDailyMissingDays: { set: jest.Mock };
    accountRollupsHeavyAccounts: { set: jest.Mock };
    accountRollupsPendingAccounts: { set: jest.Mock };
  };
  /** Aborts the signal of the ticks. */
  readonly abort: AbortController;
  /** The tick a job is run with: the deadline is the clock plus the budget, as `runJobs` narrows it; the signal is `abort`'s. */
  tick(now?: Date): AggregatorTick;
}

/**
 * The deps of a runner: the clock is `Date.now` (so jest's fake timers move it), the logger is quiet, `failed` is recorded
 * and `closing` is a flag of the test. `ch` is an empty object: a spec that runs a runner replaces the functions that read it.
 */
export function fakeDeps(o: { budgetMs?: number } = {}): FakeDeps {
  const budgetMs = o.budgetMs ?? 3000;
  const logger: FakeLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const metrics = {
    pairHourlyMissingHours: { set: jest.fn() },
    marketsLiveAgeSeconds: { set: jest.fn() },
    ratesDailyMissingDays: { set: jest.fn() },
    accountRollupsHeavyAccounts: { set: jest.fn() },
    accountRollupsPendingAccounts: { set: jest.fn() },
  };
  const abort = new AbortController();
  const fake: FakeDeps = {
    deps: {
      ch: {} as ClickHouseService,
      logger,
      metrics: metrics as never,
      budgetMs,
      clock: () => Date.now(),
      closing: () => fake.closing,
      failed: (job, err, where) => {
        fake.failures.push({ job, err, where });
      },
    },
    logger,
    failures: [],
    closing: false,
    metrics,
    abort,
    tick: (now = NOW) => ({ now, deadline: Date.now() + budgetMs, signal: abort.signal }),
  };
  return fake;
}
