import {
  ClickHouseService,
  committedCheckpoint,
  NetworkProfile,
  ShutdownSignals,
  TOKEN_HISTORY_LEASE_HEARTBEAT_MS,
  TOKEN_HISTORY_POLL_MS,
} from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { NETWORK_PROFILE, SyncerConfig } from '../config/syncer.config';
import { PassLoop } from '../core/pass-loop';
import { TokenHistoryLease } from './token-history-lease';
import { TOKEN_HISTORY_WORKER_OPTIONS, TokenHistoryWorkerOptions } from './token-history.options';

/** How long a shutdown waits for the step in flight (spec 4.1). */
export const TOKEN_HISTORY_STOP_WAIT_MS = 2_000;

/** What a pass did: the commit marker it read (none: no ledger is committed yet). */
export interface TokenHistoryPass {
  head?: number;
}

/**
 * The `token_history` worker (spec 4.1): every `TOKEN_HISTORY_POLL_MS` it reads the commit marker, applies the live windows until it
 * has caught up, then spends what is left of `TOKEN_HISTORY_PASS_BUDGET_MS` on one step of a finished build's catch-up, a repair or a
 * live DEX hour; the live window always comes first. It holds the lease `<network>:token_history`. It needs no node. It never builds a
 * generation: that is the `token-history-build` command's.
 */
@Injectable()
export class TokenHistoryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger: NonNullable<TokenHistoryWorkerOptions['logger']>;
  private readonly lease: TokenHistoryLease;
  private loop?: PassLoop;
  private leaseHeld = false;
  private lastHeartbeat = 0;
  private stopping?: Promise<void>;

  constructor(
    @Inject(ClickHouseService) private readonly ch: ClickHouseService,
    @Inject(SyncerConfig) private readonly cfg: Pick<SyncerConfig, 'network'>,
    @Inject(NETWORK_PROFILE) private readonly profile: Pick<NetworkProfile, 'hasMpt'>,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(TOKEN_HISTORY_WORKER_OPTIONS) private readonly options: TokenHistoryWorkerOptions = {},
  ) {
    this.logger = options.logger ?? new Logger(TokenHistoryWorker.name);
    this.lease = new TokenHistoryLease(ch, cfg.network, options.holder);
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

  /**
   * One pass: nothing without a committed ledger; else the lease (taken, or renewed every 10 s), then the work of the pass.
   */
  async pass(): Promise<TokenHistoryPass> {
    const head = await committedCheckpoint(this.ch);
    if (head === undefined) return { head };
    if (!(await this.holdLease())) return { head };
    return { head };
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

  /** Whether the network has MPTs: their touches and states are read only then. */
  protected get hasMpt(): boolean {
    return this.profile.hasMpt;
  }
}
