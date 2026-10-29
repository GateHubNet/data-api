import {
  escrowsOfLedgers,
  EscrowsStep,
  RatesService,
  readEscrowed,
  recomputeEscrows,
  refreshEscrowsTotal,
  runEscrowsStep,
} from '@gatehub/data-api-shared';
import { iso } from './aggregate-job-deps';
import { AggregatorJobContext, AggregatorTick } from './job-context';

/** What the `escrows` job works with: the rates of the network, which the hook of `agg_dirty` finds the ledgers of a slice with, and its native currency. */
export interface AggregatorEscrows {
  rates: RatesService;
  /** The native currency of the network: the escrows counted in the total are the ones in it. */
  nativeCurrency: 'XRP' | 'XAH';
}

/** The functions of the shared package the `escrows` job calls; tests replace them. */
export interface EscrowsFunctions {
  /** One step of the job: a window of ledgers after the watermark, and the sentinel written last (`runEscrowsStep`). */
  step: typeof runEscrowsStep;
  /** The escrows of a ledger range (the escrows touched in it, and those last seen in it): what the hook recomputes. */
  ofLedgers: typeof escrowsOfLedgers;
  recompute: typeof recomputeEscrows;
  /** The total again, and the sentinel rewritten under a newer version with the same watermark. */
  refreshTotal: typeof refreshEscrowsTotal;
  /** The sentinel: the watermark of the job and the total as of it. */
  read: typeof readEscrowed;
}

/** The functions of the shared package, for what the options do not replace. */
export const ESCROWS_FUNCTIONS: EscrowsFunctions = {
  step: runEscrowsStep,
  ofLedgers: escrowsOfLedgers,
  recompute: recomputeEscrows,
  refreshTotal: refreshEscrowsTotal,
  read: readEscrowed,
};

/**
 * The `escrows` job of the aggregator (see `AggregatorService`, job 5), and its hook in the slices of `agg_dirty`: it keeps the
 * `escrows` table (the current state of every escrow, from its `object_changes` rows) and the sentinel row that holds the
 * escrowed total and the ledger it is as of (`runEscrowsStep`, spec 4.1). The job has no state of its own besides the table: the
 * watermark is the `through_ledger` of the sentinel, which a restart reads again, so there is no cursor to place or retry. The
 * database, the clock, the budgets and the rules of the tick are the service's (`AggregatorJobContext`).
 */
export class EscrowsJobRunner {
  constructor(
    private readonly ctx: AggregatorJobContext,
    private readonly escrows: AggregatorEscrows,
    private readonly fns: EscrowsFunctions,
  ) {}

  /**
   * One run of the job: a step of the shared function, which writes the sentinel (whether or not an escrow changed, so that its
   * `through_ledger` follows the head at every tick), and then more steps while the watermark moves (one that did not would be
   * followed by one that does not either), is below the head and the budget of the job lasts. The first step is always taken
   * (a tick is the clock of the sentinel; in the steady state a step is a few narrow reads), unless the shutdown has begun. The
   * budget is checked **before** a step and never inside one: a step cannot stop partway (its sentinel is written last, and a
   * step that is cut writes none), so it is not given a signal that the budget aborts, only the shutdown's. A step that fails is
   * the failure of the job: it is thrown, and logged and counted as `escrows` by the service (the jobs after this one still
   * run), and the next tick does the same window again.
   *
   * The head is the one the step saw, so the lag gauge (`syncer_escrows_lag_ledgers`: head less watermark) and the open count
   * (`syncer_escrows_open`) are set after every step without another read. An escrow a step set aside (its rows cannot be
   * mapped) is counted and logged as a failure of `escrows`, by its ID: nothing is to be retried, as mapping is a function of the
   * rows, and the step commits without it.
   */
  async run(tick: AggregatorTick): Promise<void> {
    if (this.ctx.closing()) return;
    let step: EscrowsStep;
    do {
      step = await this.fns.step(this.ctx.ch, { native: this.escrows.nativeCurrency, signal: tick.signal });
      this.reportSetAside(step.setAside);
      this.ctx.metrics?.escrowsLagLedgers.set(Math.max(0, step.head - step.to));
      this.ctx.metrics?.escrowsOpen.set(step.escrowed.open);
    } while (step.to > step.from && step.to < step.head && this.ctx.mayStartSet(tick, 'escrows'));
  }

  /**
   * The escrows of the ledgers that closed in the slice `[start, end)` of an `agg_dirty` range, recomputed as of the watermark of
   * the job, and the total again when anything was written or removed. Only what the job has passed: a slice with no ledger, a
   * job that has written no sentinel yet (its first steps read the rows the slice rewrote), or a watermark below the first ledger
   * of the slice (the live steps cover it) does nothing. The recompute is up to the watermark and not the head: the rows above it
   * are the live steps' to read, and the sentinel's total must stay the state of the escrows at its own watermark. The total is
   * read again (a narrow row per escrow ever seen) only after a change. An escrow that cannot be mapped is set aside as in a step.
   * Once the shutdown has begun it does nothing, and the range of `agg_dirty` is left as it is.
   */
  async ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void> {
    if (this.ctx.closing()) return;
    const ledgers = await this.escrows.rates.ledgersClosedIn(new Date(start * 1000), new Date(end * 1000));
    if (ledgers === null || this.ctx.closing()) return;
    const sentinel = await this.fns.read(this.ctx.ch);
    if (sentinel === undefined || sentinel.through_ledger < ledgers.min || this.ctx.closing()) return;
    const ids = await this.fns.ofLedgers(this.ctx.ch, ledgers.min, ledgers.max);
    if (this.ctx.closing()) return;
    const native = this.escrows.nativeCurrency;
    const done = await this.fns.recompute(this.ctx.ch, ids, {
      upTo: sentinel.through_ledger,
      native,
      signal: tick.signal,
    });
    this.reportSetAside(done.setAside, ` in ${iso(start)} - ${iso(end)}`);
    if (done.written + done.removed > 0) await this.fns.refreshTotal(this.ctx.ch, { native, signal: tick.signal });
  }

  /** Counts and logs each escrow that was set aside as a failure of `escrows`; the reason is not carried, only the ID. */
  private reportSetAside(ids: readonly string[], where = ''): void {
    for (const id of ids) {
      this.ctx.failed(
        'escrows',
        new Error('its rows cannot be mapped to an escrows row'),
        ` for escrow ${id}${where}, set aside`,
      );
    }
  }
}
