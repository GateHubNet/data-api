import { Logger } from '@nestjs/common';
import { describeError } from '../validators/describe-error';

/** A loop of a worker: it ends its timers on `stop()` and resolves when what it had under way is over. */
export interface Loop {
  stop(): Promise<void>;
}

/**
 * Calls `pass` at once, and again `everyMs` after each call ended, never two at a time. A pass that rejects is logged and the
 * next one is made on time. `stop()` ends the timer, stops what `pass` runs (`end`) and waits for the pass under way.
 *
 * What a log line says of a pass that rejected is `describe(err)`, by default the error's message. A loop whose passes
 * can fail with an error that quotes what it was handling (a ClickHouse insert that quotes a row) gives a `describe` that
 * says less.
 */
export class PassLoop implements Loop {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly name: string,
    private readonly pass: () => Promise<unknown>,
    private readonly end: () => Promise<void>,
    private readonly everyMs: number,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly describe: (err: unknown) => string = describeError,
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
      if (!this.stopped) this.logger.warn(`${this.name}: the pass failed: ${this.describe(err)}`);
    }
    this.schedule(this.everyMs);
  }
}
