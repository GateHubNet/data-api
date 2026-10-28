import { ShutdownSignals } from '@gatehub/data-api-shared';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { SyncerConfig } from '../config/syncer.config';
import { Loop, PassLoop } from '../core/pass-loop';
import { errorNameOf } from '../validators/domain-checker';
import { DomainDiscovery, TOML_DISCOVERY_INTERVAL_MS } from './domain-discovery';
import { TomlChecker } from './toml-checker';
import { TOMLS_WORKER_OPTIONS, TomlsWorkerOptions } from './tomls.options';

/** The wait between the end of a check pass and the start of the next (spec 4.2). */
export const TOMLS_PASS_INTERVAL_MS = 60_000;

/** How long a stop waits for the loops all together. The cleanups of `ShutdownSignals` share a budget of 10 s. */
export const TOMLS_STOP_WAIT_MS = 2_000;

/** The type ClickHouse gives its errors (`UNKNOWN_TABLE`, `MEMORY_LIMIT_EXCEEDED`): capitals, digits and underscores. */
const CLICKHOUSE_ERROR_TYPE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * What a log line of the tomls worker says of an error: its name (`errorNameOf`: a plain name, else `Error`) and, for an error
 * of ClickHouse, its type (`Error (UNKNOWN_TABLE)`). Never its message and nothing else it carries: a ClickHouse error can quote
 * the row it could not write, a principal or a desc, and a log names no more than a domain, a reason and a status code.
 */
export function errorTextOf(err: unknown): string {
  const name = errorNameOf(err);
  const type = (err as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' && CLICKHOUSE_ERROR_TYPE.test(type) ? `${name} (${type})` : name;
}

/**
 * The `tomls` worker (spec 4): it reads the toml of every domain accounts name, in two loops started according to
 * `options.start`:
 *
 * - the **discovery loop** (`DomainDiscovery`): at start and then every `TOML_DISCOVERY_INTERVAL_MS` (5 min) after the
 *   previous discovery ended, it reads which domains accounts name (spec 4.1);
 * - the **check loop** (`TomlChecker`): a pass at start and then one every 60 s after the previous one ended, which checks the
 *   domains that are due and writes the rows (spec 4.2). A pass first waits for the first discovery to be over, and is not made
 *   while no discovery has worked: with nothing known of the domains a pass would set the gauges to an empty store that is
 *   up to date, which is not known, so a worker whose discovery keeps failing shows its failure (a `warn` line a discovery, the
 *   name of the error) and no pass.
 *
 * With `GH_DOMAIN_VERIFICATION=false` it says so once and starts nothing: no toml is read. It does not need the node.
 *
 * **Stops** on module destroy and on SIGTERM / SIGINT (`ShutdownSignals`, as `tomls`): both loops are stopped at once and the
 * worker waits for them at most `TOMLS_STOP_WAIT_MS`; the check loop's stop writes what the pass under way has done, so
 * ClickHouse must still be there when it runs (the signal cleanups run before anything is closed). What is still under way after
 * that is left to finish by itself and a check not written is still due.
 *
 * A pass that fails is logged by the name of its error only (`errorTextOf`), never the message: an insert's error can quote a row.
 */
@Injectable()
export class TomlsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly start: NonNullable<TomlsWorkerOptions['start']>;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** The loops that were started. */
  private readonly loops: Loop[] = [];
  private stopping?: Promise<void>;

  constructor(
    @Inject(DomainDiscovery) private readonly discovery: Pick<DomainDiscovery, 'discover' | 'ready' | 'loaded'>,
    @Inject(TomlChecker) private readonly checker: Pick<TomlChecker, 'pass' | 'stop'>,
    @Inject(SyncerConfig) private readonly cfg: Pick<SyncerConfig, 'domainVerification'>,
    @Optional() private readonly shutdownSignals?: ShutdownSignals,
    @Optional() @Inject(TOMLS_WORKER_OPTIONS) options: TomlsWorkerOptions = {},
  ) {
    this.start = options.start ?? {};
    this.logger = options.logger ?? new Logger(TomlsWorker.name);
  }

  onApplicationBootstrap(): void {
    this.shutdownSignals?.register('tomls', () => this.stop());
    if (!this.cfg.domainVerification) {
      this.logger.log('Toml checks are off (GH_DOMAIN_VERIFICATION=false): no toml is read');
      return;
    }
    if (this.start.discovery !== false) {
      const loop = new PassLoop(
        'Toml discovery',
        () => this.discovery.discover(),
        async () => undefined,
        TOML_DISCOVERY_INTERVAL_MS,
        this.logger,
        errorTextOf,
      );
      loop.start();
      this.loops.push(loop);
    }
    if (this.start.checks !== false) {
      const loop = new PassLoop(
        'Toml checks',
        () => this.checkPass(),
        () => this.checker.stop(),
        TOMLS_PASS_INTERVAL_MS,
        this.logger,
        errorTextOf,
      );
      loop.start();
      this.loops.push(loop);
    }
  }

  /** One pass of the check loop: after the first discovery, and only when a discovery has worked. */
  private async checkPass(): Promise<number> {
    await this.discovery.ready;
    if (!this.discovery.loaded) return 0;
    return this.checker.pass();
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /** Stops both loops and waits for them, at most `TOMLS_STOP_WAIT_MS`. Idempotent. */
  stop(): Promise<void> {
    this.stopping ??= this.stopLoops();
    return this.stopping;
  }

  private async stopLoops(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TOMLS_STOP_WAIT_MS);
    });
    try {
      await Promise.race([Promise.allSettled(this.loops.map((loop) => loop.stop())), budget]);
    } finally {
      clearTimeout(timer);
    }
  }
}
