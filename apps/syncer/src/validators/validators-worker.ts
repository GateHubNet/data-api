import { ShutdownSignals } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { SyncerConfig } from '../config/syncer.config';
import { DomainChecker } from './domain-checker';
import { NetworkStatePoller } from './network-state-poller';
import { UnlFetcher } from './unl-fetcher';
import { VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

/** How long a stop waits for the loops all together. The cleanups of `ShutdownSignals` share a budget of 10 s. */
export const VALIDATORS_STOP_WAIT_MS = 2_000;

/** The wait between the end of a domain pass and the start of the next. */
export const DOMAIN_PASS_INTERVAL_MS = 60_000;

/** The wait between the end of a network state poll and the start of the next (spec 2.3). */
export const STATE_POLL_INTERVAL_MS = 60_000;

/** The wait between the end of a feature poll (and the gauge update after it) and the start of the next (spec 2.3). */
export const FEATURE_POLL_INTERVAL_MS = 600_000;

/** A loop of the worker: it ends its timers on `stop()` and resolves when what it had under way is over. */
interface Loop {
  stop(): Promise<void>;
}

/**
 * Calls `pass` at once, and again `everyMs` after each call ended, never two at a time. A pass that rejects is logged (its
 * message only) and the next one is made on time. `stop()` ends the timer, stops what `pass` runs (`end`) and waits for
 * the pass under way.
 */
class PassLoop implements Loop {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly pass: () => Promise<unknown>,
    private readonly end: () => Promise<void>,
    private readonly everyMs: number,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {}

  start(): void {
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.all([this.end(), this.running]);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }, delayMs);
  }

  private async run(): Promise<void> {
    try {
      await this.pass();
    } catch (err) {
      if (!this.stopped)
        this.logger.warn(`${this.name}: the pass failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.schedule(this.everyMs);
  }
}

/**
 * The `validators` worker (spec 2): the loops that keep the validators and amendments data current. It does the work in
 * loops of its own, each started here according to `options.start`:
 *
 * - the **UNL loop** (`UnlFetcher`): fetches the validator lists of the publishers (`GH_UNL_PUBLISHERS`), verifies them and
 *   stores them. At boot it first writes the publisher rows (`registerPublishers`), then starts the fetches in the
 *   background. A ClickHouse that cannot be written at boot fails the boot, like the ingest worker's lease does.
 * - the **domain loop** (`DomainChecker`), while `GH_DOMAIN_VERIFICATION` is true: a pass at start and then one every
 *   60 s after the previous one ended, which verifies the domains of the validators (spec 2.2).
 * - the **state loop** (`NetworkStatePoller`): a poll of the ledger state at start and then one every 60 s after the previous
 *   one ended, and a poll of the amendment features, followed by the update of the gauge of the amendments without
 *   metadata, at start and then every 10 min (spec 2.3). The two polls are timers of their own, so a slow node holds up
 *   neither; each never overlaps itself.
 *
 * It is a worker of its own, and not steps of the aggregator, because it needs outbound HTTPS to third-party sites and the
 * node, because its cadences and failure modes are its own, and because the aggregator's 30 s tick is not its to share (spec
 * 2). An operator switches it on and off with `GH_WORKERS`.
 *
 * **Stops** on module destroy and on SIGTERM / SIGINT (`ShutdownSignals`): every loop is stopped at once and the worker
 * waits for them at most `VALIDATORS_STOP_WAIT_MS`; what is still under way after that is left to finish by itself.
 */
@Injectable()
export class ValidatorsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly start: NonNullable<ValidatorsWorkerOptions['start']>;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** The loops that were started, in the order they were. */
  private readonly loops: Loop[] = [];
  private stopping?: Promise<void>;

  constructor(
    @Inject(UnlFetcher) private readonly unl: UnlFetcher,
    @Inject(DomainChecker) private readonly domains: DomainChecker,
    @Inject(NetworkStatePoller) private readonly state: NetworkStatePoller,
    @Inject(SyncerConfig) private readonly cfg: Pick<SyncerConfig, 'domainVerification'>,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(VALIDATORS_WORKER_OPTIONS) options: ValidatorsWorkerOptions = {},
  ) {
    this.start = options.start ?? {};
    this.logger = options.logger ?? new Logger(ValidatorsWorker.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.shutdownSignals?.register('validators', () => this.stop());
    if (this.start.unl !== false) {
      await this.unl.registerPublishers();
      this.unl.start();
      this.loops.push(this.unl);
    }
    if (this.start.domains !== false && this.cfg.domainVerification) {
      const loop = new PassLoop(
        'Domain verification',
        () => this.domains.pass(),
        () => this.domains.stop(),
        DOMAIN_PASS_INTERVAL_MS,
        this.logger,
      );
      loop.start();
      this.loops.push(loop);
    }
    if (this.start.state !== false) {
      const stateLoop = new PassLoop(
        'Network state',
        () => this.state.pollState(),
        () => this.state.stop(),
        STATE_POLL_INTERVAL_MS,
        this.logger,
      );
      const featureLoop = new PassLoop(
        'Amendment features',
        async () => {
          await this.state.pollFeatures();
          // after a poll that resolved, written or not (a poll that rejects skips it): the gauge reads what is stored
          await this.state.updateMetadataGauge();
        },
        () => this.state.stop(),
        FEATURE_POLL_INTERVAL_MS,
        this.logger,
      );
      stateLoop.start();
      featureLoop.start();
      this.loops.push(stateLoop, featureLoop);
    }
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /** Stops every loop and waits for them, at most `VALIDATORS_STOP_WAIT_MS`. Idempotent. */
  stop(): Promise<void> {
    this.stopping ??= this.stopLoops();
    return this.stopping;
  }

  private async stopLoops(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, VALIDATORS_STOP_WAIT_MS);
    });
    try {
      await Promise.race([Promise.allSettled(this.loops.map((loop) => loop.stop())), budget]);
    } finally {
      clearTimeout(timer);
    }
  }
}
