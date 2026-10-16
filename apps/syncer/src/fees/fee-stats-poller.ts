import {
  ClickHouseService,
  FeeStatsRow,
  NodeClient,
  retryAfterMsOf,
  ShutdownSignals,
  Table,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { NODE_CLIENT } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/** One snapshot of the node's fee state every 5 s, as `scripts/feeStats.js` of the original took it. */
export const FEE_STATS_INTERVAL_MS = 5000;

/**
 * The timeout passed to `NodeClient.request`. The client applies it to waiting for a connection AND again to waiting for
 * the answer, so a node that hangs costs up to twice as much: about 8 s, which is a little more than one tick (the
 * default of the node client is 30 s, and 3 retries on top; the poller does not retry, the next tick is the retry). The
 * ticks never overlap, so a hung node costs two ticks, not more.
 */
export const FEE_STATS_REQUEST_TIMEOUT_MS = 4000;

/**
 * How long a shutdown waits for the sample in flight (for its insert, when the node has answered already). The cleanups
 * of `ShutdownSignals` share one budget of 10 s and the ingest runner, which releases the syncer lease, can stop after
 * this one, so a node that hangs must not use it up: the sample is abandoned (it is dropped when its answer arrives).
 */
export const FEE_STATS_SHUTDOWN_WAIT_MS = 2000;

/** Optional `FeeStatsPollerOptions` (interval, logger); tests shorten the interval and capture the log. */
export const FEE_STATS_POLLER_OPTIONS = Symbol('FEE_STATS_POLLER_OPTIONS');

export interface FeeStatsPollerOptions {
  /** Default: `FEE_STATS_INTERVAL_MS`. */
  intervalMs?: number;
  /** Default: a Nest `Logger` with the context `FeeStatsPoller`. */
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** The clock, in unix milliseconds. Default: `Date.now`. A test that writes to a real database sets it here: the ClickHouse client reads `Date.now` too. */
  now?: () => number;
}

const MAX_UINT32 = 4_294_967_295;

/** A rippled count (`current_queue_size`, ...): a string of digits, or a number, that fits a `UInt32` column. */
function count(value: unknown, name: string): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > MAX_UINT32) {
    throw new Error(`Unexpected fee response: ${name} is ${JSON.stringify(value)}`);
  }
  return n;
}

/** A fee in drops, kept as the exact text of digits (a `UInt64` column reads it exactly; a number would lose digits). */
function drops(value: unknown, name: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  throw new Error(`Unexpected fee response: drops.${name} is ${JSON.stringify(value)}`);
}

/** `Number(pct.toFixed(2))`: how `feeStats.js` wrote `pct_max_queue_size` (as text), and `getFeeStats` read it back. */
export function roundPct(pct: number): number {
  return Number(pct.toFixed(2));
}

/**
 * The `fee_stats` row of a `fee` answer taken at `ts` (unix SECONDS, the milliseconds as a fraction: a `DateTime64(3)`
 * column reads a number as seconds).
 *
 * `pct_max_queue_size` is the share of the queue in use, as the original computed it: the queue holds at most 20 times
 * the expected ledger size, so `current_queue_size / (expected_ledger_size * 20) * 100`, to two decimals. (The maximum the
 * node reports, `max_queue_size`, is kept as it is, but the percentage is not worked out from it: it has a floor of 2000
 * and would show a queue of 13 as 0.65 % where the original had 2.71 %.) An expected size of 0 gives 0 %, not NaN.
 * The answer is not mutated.
 */
export function feeStatsRowFrom(result: unknown, ts: number): FeeStatsRow {
  if (typeof result !== 'object' || result === null) throw new Error('Unexpected fee response: not an object');
  const r = result as Record<string, unknown>;
  const fees = r.drops;
  if (typeof fees !== 'object' || fees === null) throw new Error('Unexpected fee response: no drops');
  const d = fees as Record<string, unknown>;

  const currentLedgerSize = count(r.current_ledger_size, 'current_ledger_size');
  const expectedLedgerSize = count(r.expected_ledger_size, 'expected_ledger_size');
  const currentQueueSize = count(r.current_queue_size, 'current_queue_size');
  const maxQueueSize =
    r.max_queue_size === undefined || r.max_queue_size === null
      ? Math.min(expectedLedgerSize * 20, MAX_UINT32)
      : count(r.max_queue_size, 'max_queue_size');

  return {
    ts,
    current_ledger_size: currentLedgerSize,
    expected_ledger_size: expectedLedgerSize,
    current_queue_size: currentQueueSize,
    max_queue_size: maxQueueSize,
    pct_max_queue_size: expectedLedgerSize === 0 ? 0 : roundPct((currentQueueSize / (expectedLedgerSize * 20)) * 100),
    median_fee: drops(d.median_fee, 'median_fee'),
    minimum_fee: drops(d.minimum_fee, 'minimum_fee'),
    open_ledger_fee: drops(d.open_ledger_fee, 'open_ledger_fee'),
  };
}

/** A sample whose answer came after the poller was stopped: dropped, not written. */
class SampleDropped extends Error {
  constructor() {
    super('the poller was stopped before the node answered');
  }
}

/** The text of whatever a promise rejected with. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `fee_stats` worker: every `FEE_STATS_INTERVAL_MS` it asks the node for `{command: 'fee'}` and writes one row to
 * `fee_stats` (what `scripts/feeStats.js` did every 5 s with a cron job, minus the e-mail alert).
 *
 * - **Overlap-safe.** A tick that finds the previous sample still in flight (a slow node, a slow insert) is skipped and
 *   logged; samples never run side by side, so they never reach ClickHouse out of order.
 * - **Never crashes.** A failed sample (node unreachable, odd answer, ClickHouse refusing the insert) is logged and
 *   counted in `syncer_fee_stats_errors_total`; the next tick tries again. A sample a rate-limited node held back
 *   (`NodeThrottledError`) is counted but not logged: the node client logs each pause once. A written sample counts in
 *   `syncer_fee_stats_samples_total`.
 * - **Stops on shutdown** (module destroy, or SIGTERM through `ShutdownSignals`): no tick starts after it, and a sample
 *   whose node answer arrives after it is dropped, not written. The stop waits for the sample in flight for at most
 *   `FEE_STATS_SHUTDOWN_WAIT_MS` (an insert that is under way gets that long to finish), then abandons it and says so, so
 *   that the stop of the ingest runner (the lease), which can run after this one, keeps most of the 10 s of the shutdown.
 *
 * The ticks are not aligned to the wall clock (the original's cron job ran at second 0, 5, 10, ...): the API serves
 * a minute / hour / day as the first snapshot at or after each boundary, whatever second that falls on.
 */
@Injectable()
export class FeeStatsPoller implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly intervalMs: number;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  /** Set when a stop begins: nothing starts, and nothing that was asked before it is written, after it. */
  private closing = false;
  private stopped?: Promise<void>;

  constructor(
    @Inject(NODE_CLIENT) private readonly node: NodeClient,
    private readonly ch: ClickHouseService,
    @Optional() private readonly metrics?: PrometheusService,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(FEE_STATS_POLLER_OPTIONS) options: FeeStatsPollerOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? FEE_STATS_INTERVAL_MS;
    this.logger = options.logger ?? new Logger(FeeStatsPoller.name);
    this.now = options.now ?? Date.now;
  }

  /** Takes the first sample at once (not awaited: a slow node does not hold up the boot), then one every interval. */
  onApplicationBootstrap(): void {
    if (this.closing || this.timer) return;
    this.shutdownSignals?.register('fee-stats', () => this.stop());
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /**
   * Stops the ticks and waits for the sample in flight, at most `FEE_STATS_SHUTDOWN_WAIT_MS`. A sample whose node answer
   * comes after this call is dropped. Idempotent; a stopped poller does not start again.
   */
  stop(): Promise<void> {
    this.closing = true;
    this.stopped ??= this.shutDown();
    return this.stopped;
  }

  /**
   * Asks the node for its fees, writes the row and returns it. Rejects when the node or ClickHouse does (the loop
   * catches that), and when the poller was stopped before the node answered (nothing is written then). Exported for
   * tests; the loop calls it once per tick.
   */
  async sample(): Promise<FeeStatsRow> {
    // the time the snapshot was asked for, as the original stamped it (it took the date before the request)
    const ts = this.now() / 1000;
    const result = await this.node.request({ command: 'fee' }, { timeoutMs: FEE_STATS_REQUEST_TIMEOUT_MS, retries: 0 });
    const row = feeStatsRowFrom(result, ts);
    if (this.closing) throw new SampleDropped();
    await this.ch.insert(Table.FeeStats, [row]);
    this.metrics?.feeStatsSamplesTotal.inc();
    return row;
  }

  private tick(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.inFlight) {
      this.logger.warn('Skipping a fee stats sample: the previous sample is still running');
      return this.inFlight;
    }
    const run = (async () => {
      try {
        await this.sample();
      } catch (err) {
        if (this.closing) {
          // the node answered late, or failed, while the app was going down: neither is a fault of the node or of the table
          this.logger.log(`Dropped the fee stats sample in flight at shutdown: ${describe(err)}`);
        } else {
          this.metrics?.feeStatsErrorsTotal.inc();
          // A rate-limited node (ruling R98): the node client logged the pause once; the samples it holds back are
          // only counted.
          if (retryAfterMsOf(err) === 0) this.logger.error(`Fee stats sample failed: ${describe(err)}`);
        }
      } finally {
        this.inFlight = undefined;
      }
    })();
    this.inFlight = run;
    return run;
  }

  private async shutDown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const running = this.inFlight;
    if (running === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), FEE_STATS_SHUTDOWN_WAIT_MS);
    });
    const abandoned = await Promise.race([running.then(() => false), timedOut]);
    clearTimeout(timer);
    if (abandoned) {
      this.logger.warn(
        `Abandoning the fee stats sample in flight: no answer within ${FEE_STATS_SHUTDOWN_WAIT_MS} ms of the shutdown`,
      );
    }
  }
}
