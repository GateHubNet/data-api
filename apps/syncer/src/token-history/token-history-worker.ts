import {
  ClickHouseService,
  committedCheckpoint,
  NetworkProfile,
  RebuildReason,
  RepairOutcome,
  ShutdownSignals,
  TOKEN_HISTORY_CHECK_MS,
  TOKEN_HISTORY_LEASE_HEARTBEAT_MS,
  TOKEN_HISTORY_PASS_BUDGET_MS,
  TOKEN_HISTORY_POLL_MS,
  TokenHistoryStateRow,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { PassLoop } from '../core/pass-loop';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import { TokenHistoryLease } from './token-history-lease';
import {
  TOKEN_HISTORY_STEPS,
  TOKEN_HISTORY_WORKER_OPTIONS,
  TokenHistorySteps,
  TokenHistoryWorkerOptions,
} from './token-history.options';

/** How long a shutdown waits for the step in flight (spec 4.1). */
export const TOKEN_HISTORY_STOP_WAIT_MS = 2_000;

const HOUR_MS = 3_600_000;
const REASONS: readonly RebuildReason[] = ['none', 'coverage', 'config', 'repair'];
const PHASES = ['changes', 'mpt_changes', 'levels', 'dex', 'done'] as const;

/** The steps whose failures are counted (`syncer_token_history_errors_total{step}`). */
export type TokenHistoryStep = 'live' | 'repair' | 'catch_up' | 'dex' | 'drop';

/** What a pass did: the commit marker it read (none: no ledger is committed yet), and its steps. */
export interface TokenHistoryPass {
  head?: number;
  /** Live windows applied. */
  windows?: number;
  /** The generation whose levels a step caught up, and to which ledger. */
  caughtUp?: { generation: number; levels_through: number };
  /** What a repair step did, when one ran. */
  repair?: RepairOutcome;
  /** The DEX hours written from `pair_hourly`. */
  dexHours?: number;
  /** The generation promoted. */
  promoted?: number;
  /** The retired generations dropped. */
  dropped?: number[];
}

/** The generations a window writes: the live one and a building one. */
const writableOf = (gens: readonly TokenHistoryStateRow[]): TokenHistoryStateRow[] => gens.filter((g) => g.state !== 'retired');

/**
 * The `token_history` worker (spec 4.1): every `TOKEN_HISTORY_POLL_MS` it reads the commit marker, applies the live windows until it
 * has caught up, then spends what is left of `TOKEN_HISTORY_PASS_BUDGET_MS` on one step: a finished build's catch-up, else a repair,
 * else the live DEX hours. Then it promotes a finished build near the head and drops a generation retired 15 minutes ago; every
 * `TOKEN_HISTORY_CHECK_MS` it says whether a build is due. A failed step is counted and logged, and the pass goes on. It holds the
 * lease `<network>:token_history` and needs no node. It never builds a generation: that is the `token-history-build` command's.
 */
@Injectable()
export class TokenHistoryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger: NonNullable<TokenHistoryWorkerOptions['logger']>;
  private readonly lease: TokenHistoryLease;
  private readonly steps: TokenHistorySteps;
  private loop?: PassLoop;
  private leaseHeld = false;
  private lastHeartbeat = 0;
  private lastCheck?: number;
  private lastReason?: RebuildReason;
  private stopping?: Promise<void>;

  constructor(
    @Inject(ClickHouseService) private readonly ch: ClickHouseService,
    @Inject(SyncerConfig) private readonly cfg: Pick<SyncerConfig, 'network'>,
    @Inject(NETWORK_PROFILE) private readonly profile: Pick<NetworkProfile, 'hasMpt'>,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(TOKEN_HISTORY_WORKER_OPTIONS) private readonly options: TokenHistoryWorkerOptions = {},
    @Optional() private readonly metrics?: PrometheusService,
  ) {
    this.logger = options.logger ?? new Logger(TokenHistoryWorker.name);
    this.lease = new TokenHistoryLease(ch, cfg.network, options.holder);
    this.steps = { ...TOKEN_HISTORY_STEPS, ...options.steps };
  }

  onApplicationBootstrap(): void {
    this.shutdownSignals?.register('token_history', () => this.stop());
    if (this.options.start === false) return;
    this.loop = new PassLoop(
      'Token history',
      () => this.pass(),
      async () => undefined,
      this.options.pollMs ?? TOKEN_HISTORY_POLL_MS,
      this.logger,
    );
    this.loop.start();
  }

  /** Counts and logs a failed step; the pass goes on. */
  private failed(step: TokenHistoryStep, err: unknown): void {
    this.metrics?.tokenHistoryErrorsTotal.inc({ step });
    this.logger.error(`Token history: the ${step} step failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  private readonly onUnfit = (): void => {
    this.metrics?.tokenHistoryUnfitSumsTotal.inc();
  };

  /**
   * One pass: nothing without a committed ledger; else the lease (taken, or renewed every 10 s), then the live windows, one step,
   * the promotion, the drop and the check of whether a build is due.
   */
  async pass(): Promise<TokenHistoryPass> {
    const now = this.options.now ?? Date.now;
    const started = now();
    const head = await committedCheckpoint(this.ch);
    if (head === undefined) return { head };
    if (!(await this.holdLease())) return { head };
    const result: TokenHistoryPass = { head, windows: 0 };
    const read = () => this.steps.readStates(this.ch);
    let gens = await read();
    const common = { hasMpt: this.profile.hasMpt, floor: this.options.floor, onUnfit: this.onUnfit };

    // the live windows first, until every generation is at the head
    try {
      for (;;) {
        const writable = writableOf(gens);
        if (writable.length === 0 || this.stopping !== undefined) break;
        const from = Math.min(...writable.map((g) => g.through_ledger));
        if (from >= head) break;
        const windowStarted = now();
        const window = await this.steps.applyLiveWindow(this.ch, writable, head, {
          ...common,
          network: this.cfg.network,
          window: this.options.window,
        });
        this.metrics?.tokenHistoryWindowSeconds.observe((now() - windowStarted) / 1000);
        result.windows = (result.windows ?? 0) + 1;
        gens = await read();
        // a window that moved no generation on (nothing to apply, or a state row that did not land) ends the windows of the pass
        const moved = writableOf(gens);
        if (window.to <= from || moved.length === 0 || Math.min(...moved.map((g) => g.through_ledger)) <= from) break;
      }
    } catch (err) {
      this.failed('live', err);
      gens = await read();
    }

    // then, within the budget, one step: a catch-up (a finished build's levels, or a live generation's behind its changes), else a
    // repair, else the live DEX hours
    const budget = this.options.budgetMs ?? TOKEN_HISTORY_PASS_BUDGET_MS;
    const left = (): number => budget - (now() - started);
    const behind = writableOf(gens).find(
      (g) => g.levels_through < g.through_ledger && (g.state === 'live' || g.phase === 'done'),
    );
    if (behind !== undefined && left() > 0 && this.stopping === undefined) {
      try {
        const levels = await this.steps.catchUpLevels(this.ch, behind, behind.through_ledger, Math.max(left(), 0), {
          ...common,
          window: this.options.window,
          now,
        });
        result.caughtUp = { generation: behind.generation, levels_through: levels };
        gens = await read();
      } catch (err) {
        this.failed('catch_up', err);
      }
    } else if (left() > 0 && this.stopping === undefined) {
      try {
        result.repair = await this.steps.repairOldestRange(this.ch, gens, { ...common, network: this.cfg.network });
        if (result.repair === 'repaired') gens = await read();
      } catch (err) {
        this.failed('repair', err);
      }
      if ((result.repair ?? 'none') === 'none' && left() > 0) {
        try {
          result.dexHours = await this.dexStep(now, left);
        } catch (err) {
          this.failed('dex', err);
        }
      }
    }

    // a finished build near the head is promoted; a generation retired 15 minutes ago is dropped
    try {
      const building = gens.find((g) => g.state === 'building' && g.phase === 'done');
      if (await this.steps.promoteIfCaughtUp(this.ch, gens)) {
        result.promoted = building?.generation;
        this.logger.log(`Token history: generation ${building?.generation} is live`);
        gens = await read();
      }
    } catch (err) {
      this.failed('catch_up', err);
    }
    try {
      result.dropped = await this.steps.dropRetired(this.ch, gens, now());
      for (const g of result.dropped) this.logger.log(`Token history: the partitions of retired generation ${g} are dropped`);
    } catch (err) {
      this.failed('drop', err);
    }

    this.report(gens, head);
    await this.checkRebuild(gens, head, now());
    return result;
  }

  /** The live DEX hours: each hour after the newest DEX sentinel whose `pair_hourly` set is final, while the budget lasts. */
  private async dexStep(now: () => number, left: () => number): Promise<number> {
    const through = await this.steps.dexThrough(this.ch);
    let hour = through?.getTime();
    if (hour === undefined) {
      const oldest = await this.steps.oldestFinalPairHour(this.ch);
      if (oldest === undefined) return 0;
      hour = oldest * 1000;
    }
    let written = 0;
    while (left() > 0 && hour + HOUR_MS <= now() && this.stopping === undefined) {
      if ((await this.steps.dexHoursFromPairHourly(this.ch, new Date(hour))) !== 'written') break;
      written++;
      hour += HOUR_MS;
    }
    return written;
  }

  /** The gauges of the state rows: the live generation's lag, and the phase of a building one. */
  private report(gens: readonly TokenHistoryStateRow[], head: number): void {
    const metrics = this.metrics;
    if (!metrics) return;
    const live = gens.filter((g) => g.state === 'live').sort((a, b) => b.generation - a.generation)[0];
    if (live === undefined) metrics.tokenHistoryLagLedgers.remove();
    else metrics.tokenHistoryLagLedgers.set(Math.max(head - live.levels_through, 0));
    const building = gens.filter((g) => g.state === 'building').sort((a, b) => b.generation - a.generation)[0];
    for (const phase of PHASES) metrics.tokenHistoryBuilding.set({ phase }, building?.phase === phase ? 1 : 0);
  }

  /** Every `TOKEN_HISTORY_CHECK_MS`: whether a build is due, as the gauge `rebuild_needed{reason}` and one log line a reason. */
  private async checkRebuild(gens: readonly TokenHistoryStateRow[], head: number, at: number): Promise<void> {
    if (this.lastCheck !== undefined && at - this.lastCheck < TOKEN_HISTORY_CHECK_MS) return;
    this.lastCheck = at;
    let reason: RebuildReason | undefined;
    try {
      reason = await this.steps.rebuildNeeded(this.ch, gens, head, { hasMpt: this.profile.hasMpt });
    } catch (err) {
      this.failed('repair', err);
      return;
    }
    for (const r of REASONS) {
      if (r === reason) this.metrics?.tokenHistoryRebuildNeeded.set({ reason: r }, 1);
      else this.metrics?.tokenHistoryRebuildNeeded.remove({ reason: r });
    }
    if (reason !== undefined && reason !== this.lastReason) {
      this.logger.warn(`Token history: a build is due (${reason}); run token-history-build`);
    }
    this.lastReason = reason;
  }

  /** Whether this worker holds the lease for this pass: takes it when it has none, renews it when 10 s have passed. */
  private async holdLease(): Promise<boolean> {
    if (!this.leaseHeld) {
      try {
        await this.lease.take();
      } catch (err) {
        this.logger.warn(`Token history: ${err instanceof Error ? err.message : String(err)}; this worker waits`);
        return false;
      }
      this.leaseHeld = true;
      this.lastHeartbeat = Date.now();
      this.logger.log(`Holding the ${this.cfg.network} token_history lease as ${this.lease.holder}`);
      return true;
    }
    if (Date.now() - this.lastHeartbeat >= TOKEN_HISTORY_LEASE_HEARTBEAT_MS) {
      if (!(await this.lease.heartbeat())) {
        this.leaseHeld = false;
        this.logger.warn('Token history: another worker took the lease over; this worker waits');
        return false;
      }
      this.lastHeartbeat = Date.now();
    }
    return true;
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /** Stops the loop, waiting at most `TOKEN_HISTORY_STOP_WAIT_MS` for the step in flight, and releases the lease. Idempotent. */
  stop(): Promise<void> {
    this.stopping ??= this.stopLoop();
    return this.stopping;
  }

  private async stopLoop(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TOKEN_HISTORY_STOP_WAIT_MS);
    });
    try {
      await Promise.race([this.loop?.stop() ?? Promise.resolve(), budget]);
    } finally {
      clearTimeout(timer);
    }
    if (this.leaseHeld) await this.lease.release().catch(() => undefined);
    this.leaseHeld = false;
  }
}
