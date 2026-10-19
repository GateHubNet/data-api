import { ShutdownSignals } from '@gatehub/data-api-shared';
import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { UnlFetcher } from './unl-fetcher';
import { VALIDATORS_WORKER_OPTIONS, ValidatorsWorkerOptions } from './validators.options';

/** How long a stop waits for the loops all together. The cleanups of `ShutdownSignals` share a budget of 10 s. */
export const VALIDATORS_STOP_WAIT_MS = 2_000;

/** A loop of the worker: it ends its timers on `stop()` and resolves when what it had under way is over. */
interface Loop {
  stop(): Promise<void>;
}

/**
 * The `validators` worker (spec 2): the loops that keep the validators and amendments data current. It does the work in
 * loops of its own, each started here according to `options.start`:
 *
 * - the **UNL loop** (`UnlFetcher`): fetches the validator lists of the publishers (`GH_UNL_PUBLISHERS`), verifies them and
 *   stores them. At boot it first writes the publisher rows (`registerPublishers`), then starts the fetches in the
 *   background. A ClickHouse that cannot be written at boot fails the boot, like the ingest worker's lease does.
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
  /** The loops that were started, in the order they were. */
  private readonly loops: Loop[] = [];
  private stopping?: Promise<void>;

  constructor(
    @Inject(UnlFetcher) private readonly unl: UnlFetcher,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(VALIDATORS_WORKER_OPTIONS) options: ValidatorsWorkerOptions = {},
  ) {
    this.start = options.start ?? {};
  }

  async onApplicationBootstrap(): Promise<void> {
    this.shutdownSignals?.register('validators', () => this.stop());
    if (this.start.unl !== false) {
      await this.unl.registerPublishers();
      this.unl.start();
      this.loops.push(this.unl);
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
