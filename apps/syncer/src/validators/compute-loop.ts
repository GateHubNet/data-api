import { Logger } from '@nestjs/common';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { describeError } from './describe-error';

/** The compute loop makes a tick this often (spec 2). */
export const COMPUTE_INTERVAL_MS = 60_000;

/** All the jobs of a tick together may use this much of it; a job gets what the jobs before it left, at most its own budget. */
export const COMPUTE_TICK_BUDGET_MS = 20_000;

/**
 * How long a stop waits for the tick in flight. The cleanups of `ShutdownSignals` share a budget of 10 s and the other loops
 * of the worker are stopped at the same time, so a database that hangs must not use it up: the tick is abandoned (it has been
 * told to write nothing more, see `stop()`).
 */
export const COMPUTE_SHUTDOWN_WAIT_MS = 2_000;

/** What a job is handed by the tick it runs in. */
export interface ComputeTick {
  /** The time of the tick, in milliseconds since the Unix epoch. */
  now: number;
  /** The clock reading (the same scale as `now`) after which the job should not start another unit of work. */
  deadline: number;
  /** Aborted when the shutdown begins: the job writes nothing more after that. */
  signal: AbortSignal;
}

/**
 * One piece of the tick. The tick runs its jobs one after the other; a job that throws is logged and counted
 * (`syncer_validators_jobs_total{job, outcome="error"}`) and the jobs after it still run, one that returns is counted `ok`.
 */
export interface ComputeJob {
  /** The `job` label of its metric and the name in its log lines. */
  readonly name: 'rounds' | 'agreement';
  /**
   * The most of the tick this job may use, counted from the moment it starts and never more than what is left of the tick. It
   * caps the job's own use and reserves nothing for the jobs after it.
   */
  readonly budgetMs: number;
  run(tick: ComputeTick): Promise<void>;
}

export interface ComputeLoopOptions {
  /** Default `COMPUTE_INTERVAL_MS`. */
  intervalMs?: number;
  /** Default `COMPUTE_TICK_BUDGET_MS`. */
  tickBudgetMs?: number;
  /** Default `COMPUTE_SHUTDOWN_WAIT_MS`. */
  shutdownWaitMs?: number;
  metrics?: Pick<PrometheusService, 'validatorsJobsTotal'>;
  /** Default: a Nest `Logger` with the context `ComputeLoop`. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** The clock, in milliseconds since the Unix epoch. Default `Date.now`. */
  now?: () => number;
}

/**
 * The compute loop of the validators worker (spec 2): once a minute it runs its jobs, in order, in the job model of the
 * aggregator (`AggregatorService`), without its file: the jobs of a tick share a budget of 20 s and each has a budget of its
 * own (`rounds` 5 s, `agreement` 10 s), so what has to run at every tick goes first and none can take the tick from the ones
 * after it.
 *
 * - **A job that throws** is logged (its message only, never the error object) and counted as `error`; the next job still
 *   runs, and the job runs again at the next tick. One that returns is counted `ok`.
 * - **No overlap.** A tick called while one runs is skipped and logged; it resolves with the one in flight.
 * - **Shutdown.** `stop()` ends the timer, aborts the signal of the tick in flight (a job writes nothing more after it, and no
 *   job starts), and waits for the tick at most `shutdownWaitMs`, then abandons it and says so. A failure of a job that comes
 *   of the shutdown is neither logged as an error nor counted.
 */
export class ComputeLoop {
  private readonly intervalMs: number;
  private readonly tickBudgetMs: number;
  private readonly shutdownWaitMs: number;
  private readonly metrics?: Pick<PrometheusService, 'validatorsJobsTotal'>;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly clock: () => number;
  private readonly abort = new AbortController();
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  /** Set when a stop begins: nothing starts, and nothing is written, after it. */
  private closing = false;
  private stopped?: Promise<void>;

  constructor(
    private readonly jobs: readonly ComputeJob[],
    o: ComputeLoopOptions = {},
  ) {
    this.intervalMs = o.intervalMs ?? COMPUTE_INTERVAL_MS;
    this.tickBudgetMs = o.tickBudgetMs ?? COMPUTE_TICK_BUDGET_MS;
    this.shutdownWaitMs = o.shutdownWaitMs ?? COMPUTE_SHUTDOWN_WAIT_MS;
    this.metrics = o.metrics;
    this.logger = o.logger ?? new Logger(ComputeLoop.name);
    this.clock = o.now ?? Date.now;
  }

  /** Makes the first tick at once (not awaited: a slow database does not hold up the boot), then one every interval. */
  start(): void {
    if (this.closing || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  /** One run of all the jobs. Never rejects: what goes wrong is logged and counted. Called by the timer; exported for tests. */
  tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.inFlight) {
      this.logger.warn('Skipping a compute tick: the previous tick is still running');
      return this.inFlight;
    }
    const now = this.clock();
    const run = this.runJobs({ now, deadline: now + this.tickBudgetMs, signal: this.abort.signal }).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  /**
   * Stops the ticks, tells the job in flight to write nothing more, and waits for the tick, at most `shutdownWaitMs`.
   * Idempotent; a stopped loop does not start again.
   */
  stop(): Promise<void> {
    this.closing = true;
    this.abort.abort();
    this.stopped ??= this.shutDown();
    return this.stopped;
  }

  private async runJobs(tick: ComputeTick): Promise<void> {
    for (const job of this.jobs) {
      if (this.closing) return;
      try {
        const deadline = Math.min(tick.deadline, this.clock() + job.budgetMs);
        await job.run({ ...tick, deadline });
        this.metrics?.validatorsJobsTotal.inc({ job: job.name, outcome: 'ok' });
      } catch (err) {
        this.failed(job.name, err);
      }
    }
  }

  /** Logs and counts a failure of a job; one that comes of the shutdown is neither. */
  private failed(job: string, err: unknown): void {
    if (this.closing) {
      this.logger.log(`Compute job ${job} ended at the shutdown: ${describeError(err)}`);
      return;
    }
    this.metrics?.validatorsJobsTotal.inc({ job, outcome: 'error' });
    this.logger.error(`Compute job ${job} failed: ${describeError(err)}`);
  }

  private async shutDown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const running = this.inFlight;
    if (running === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.shutdownWaitMs);
    });
    const abandoned = await Promise.race([running.then(() => false), timedOut]);
    clearTimeout(timer);
    if (abandoned) {
      this.logger.warn(
        `Abandoning the compute tick in flight: it did not end within ${this.shutdownWaitMs} ms of the shutdown`,
      );
    }
  }
}
