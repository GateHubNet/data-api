import { Inject, Injectable, Logger, OnApplicationShutdown, Optional } from '@nestjs/common';

/** How long the registered cleanups may take in total before the process exits anyway. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];

/** The part of `process` this class uses; tests pass a stand-in. */
export interface ShutdownProcess {
  on(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  removeListener(event: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

export interface ShutdownSignalsOptions {
  /** Default: the real `process`. */
  process?: ShutdownProcess;
  /** Default: `SHUTDOWN_TIMEOUT_MS`. */
  timeoutMs?: number;
  logger?: { log(message: string): void; warn(message: string): void; error(message: string, trace?: unknown): void };
}

export const SHUTDOWN_SIGNALS_OPTIONS = Symbol('SHUTDOWN_SIGNALS_OPTIONS');

/**
 * Graceful shutdown on SIGTERM / SIGINT (ruling R19). The toolbox `bootstrap()` never enables Nest's shutdown hooks, so
 * a signal would otherwise kill the process without running `onModuleDestroy` / `onApplicationShutdown`.
 *
 * Components `register()` an async cleanup. On the first signal the cleanups run one after the other in reverse order of
 * registration (what was set up last is torn down first: the ingest runner before the node client it reads from), each
 * one's failure is logged and does not stop the others, and the process exits with code 0 once they are done or
 * `SHUTDOWN_TIMEOUT_MS` has passed, whichever comes first. Later signals are ignored.
 */
@Injectable()
export class ShutdownSignals implements OnApplicationShutdown {
  private readonly proc: ShutdownProcess;
  private readonly timeoutMs: number;
  private readonly logger: NonNullable<ShutdownSignalsOptions['logger']>;
  private readonly cleanups: { name: string; fn: () => Promise<void> }[] = [];
  private shuttingDown?: Promise<void>;

  constructor(@Optional() @Inject(SHUTDOWN_SIGNALS_OPTIONS) options: ShutdownSignalsOptions = {}) {
    this.proc = options.process ?? process;
    this.timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    this.logger = options.logger ?? new Logger('Shutdown');
    for (const signal of SIGNALS) this.proc.on(signal, this.onSignal);
  }

  /** Run `fn` on shutdown; `name` identifies it in the logs. */
  register(name: string, fn: () => Promise<void>): void {
    this.cleanups.push({ name, fn });
  }

  /** Run the cleanups and exit; what a signal does. Every later call returns the same promise. */
  shutdown(signal: NodeJS.Signals): Promise<void> {
    this.shuttingDown ??= this.run(signal);
    return this.shuttingDown;
  }

  /** The app was closed without a signal (tests, `app.close()`): stop listening, so nothing outlives the app. */
  onApplicationShutdown(): void {
    for (const signal of SIGNALS) this.proc.removeListener(signal, this.onSignal);
  }

  private readonly onSignal = (signal: NodeJS.Signals): void => {
    void this.shutdown(signal);
  };

  private async run(signal: NodeJS.Signals): Promise<void> {
    this.logger.log(`Received ${signal}: shutting down`);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.timeoutMs);
    });
    const finished = this.runCleanups().then(() => false);
    if (await Promise.race([finished, timedOut])) {
      this.logger.warn(`Shutdown did not finish within ${this.timeoutMs} ms; exiting anyway`);
    } else {
      this.logger.log('Shutdown complete');
    }
    clearTimeout(timer);
    this.proc.exit(0);
  }

  private async runCleanups(): Promise<void> {
    for (const { name, fn } of [...this.cleanups].reverse()) {
      try {
        await fn();
      } catch (err) {
        this.logger.error(
          `Shutdown step "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : err,
        );
      }
    }
  }
}
