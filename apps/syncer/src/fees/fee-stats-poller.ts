import { ClickHouseService, FeeStatsRow, NodeClient, ShutdownSignals, Table } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { NODE_CLIENT } from '../config/syncer.config';
import { PrometheusService } from '../modules/prometheus/prometheus.service';

/** One snapshot of the node's fee state every 5 s, as `scripts/feeStats.js` of the original took it. */
export const FEE_STATS_INTERVAL_MS = 5000;

/**
 * Longest a `fee` request may take (to connect, and again to answer): under the interval, so that a node that hangs holds
 * up one tick, not six (the default of the node client is 30 s). It is not retried: the next tick is the retry.
 */
export const FEE_STATS_REQUEST_TIMEOUT_MS = 4000;

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
 *   counted in `syncer_fee_stats_errors_total`; the next tick tries again. A written sample counts in
 *   `syncer_fee_stats_samples_total`.
 * - **Stops on shutdown** (module destroy, or SIGTERM through `ShutdownSignals`): no tick starts after it, and the sample
 *   in flight is allowed to finish and be written.
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
    if (this.stopped || this.timer) return;
    this.shutdownSignals?.register('fee-stats', () => this.stop());
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** Stops the ticks and waits for the sample in flight. Idempotent; a stopped poller does not start again. */
  stop(): Promise<void> {
    this.stopped ??= this.shutDown();
    return this.stopped;
  }

  /**
   * Asks the node for its fees, writes the row and returns it. Rejects when the node or ClickHouse does (the loop
   * catches that). Exported for tests; the loop calls it once per tick.
   */
  async sample(): Promise<FeeStatsRow> {
    // the time the snapshot was asked for, as the original stamped it (it took the date before the request)
    const ts = this.now() / 1000;
    const result = await this.node.request({ command: 'fee' }, { timeoutMs: FEE_STATS_REQUEST_TIMEOUT_MS, retries: 0 });
    const row = feeStatsRowFrom(result, ts);
    await this.ch.insert(Table.FeeStats, [row]);
    this.metrics?.feeStatsSamplesTotal.inc();
    return row;
  }

  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) {
      this.logger.warn('Skipping a fee stats sample: the previous sample is still running');
      return this.inFlight;
    }
    const run = (async () => {
      try {
        await this.sample();
      } catch (err) {
        this.metrics?.feeStatsErrorsTotal.inc();
        this.logger.error(`Fee stats sample failed: ${describe(err)}`);
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
    await this.inFlight;
  }
}
