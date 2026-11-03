import {
  NetworkProfile,
  NetworkSupplyRow,
  newestSnapshot,
  reservesDrops,
  runSupplyStep,
  startSupplyCycle,
  SUPPLY_INTERVAL_MS,
  SUPPLY_START_WAIT_TICKS,
  SupplyAmmSight,
  SupplyCycle,
  SupplyStart,
  writeSupplySnapshot,
} from '@gatehub/data-api-shared';
import { AGGREGATE_MAX_RETRY_MS, AGGREGATE_RETRY_MS, AggregateJobDeps } from './aggregate-job-deps';
import type { AggregatorJob, AggregatorTick } from './aggregator.service';
import { Backoff, backoffAfterFailure } from './job-context';

/**
 * What the `supply` job works with: the network (whether it has an AMM decides whether a start needs the sight of the `amm_pools`
 * runner), and that sight. The service fills `ammSight` in from its `amm_pools` runner; a test may lend one.
 */
export interface AggregatorSupply {
  profile: NetworkProfile;
  /**
   * What the `amm_pools` runner lends the start: its in-memory cursor (`undefined` before its first run) and the pools it has set
   * aside (`AmmPoolsJobRunner.sight`). Read when a start is attempted, never otherwise, and only on a network with an AMM. Without
   * it the start is given a sight with no cursor, and so waits.
   */
  ammSight?: () => SupplyAmmSight;
}

/** The functions of the shared package the `supply` job calls; tests replace them (the runner takes the ones to replace as its last argument). */
export interface SupplyFunctions {
  newestSnapshot: typeof newestSnapshot;
  startSupplyCycle: typeof startSupplyCycle;
  runSupplyStep: typeof runSupplyStep;
  writeSupplySnapshot: typeof writeSupplySnapshot;
}

/** The functions of the shared package, for what the options do not replace. */
export const SUPPLY_FUNCTIONS: SupplyFunctions = {
  newestSnapshot,
  startSupplyCycle,
  runSupplyStep,
  writeSupplySnapshot,
};

/** A step (or the start, or the write) that fails this many times in a row drops the cycle and starts the wait. */
export const SUPPLY_MAX_STEP_FAILURES = 3;

/** How many pools a warning names; the rest are counted. */
const MAX_POOLS_NAMED = 10;

/** The sight of a process that has no `amm_pools` runner: no cursor, so that a start on a network with an AMM waits. */
export const NO_AMM_SIGHT: SupplyAmmSight = Object.freeze({ cursor: undefined, setAside: Object.freeze([]) });

/** The pools of a warning: the first `MAX_POOLS_NAMED`, and how many more there are. */
const named = (pools: readonly string[]): string =>
  pools.length <= MAX_POOLS_NAMED
    ? pools.join(', ')
    : `${pools.slice(0, MAX_POOLS_NAMED).join(', ')} and ${pools.length - MAX_POOLS_NAMED} more`;

/**
 * The `supply` job of the aggregator (job 17 of a tick, see spec 2026-10-24-supply-design.md, 4.1 and 4.6): an hourly snapshot of
 * the native supply, `network_supply`, spread over ticks. A **cycle** computes one snapshot at one ledger L: its start takes the
 * reads of the first tick, its steps (the account ranges, the AMM fill-forwards, on Xahau the burned and minted slices) add to the
 * sums, and its write is one insert (`startSupplyCycle`, `runSupplyStep`, `writeSupplySnapshot` of the shared package). The cycle
 * is in memory: a restart forgets it and the next run starts a fresh one. The database, the clock, the budget and the rule of
 * failure are the deps'; the sight of the `amm_pools` runner is lent by the service.
 *
 * **A run.** With no cycle, and no wait running, the newest snapshot is read (two reads of the end of its key); if it started less
 * than `SUPPLY_INTERVAL_MS` ago the run is over, else a cycle is started. A start that answers that it waits (for the escrows job,
 * or for the `amm_pools` runner's first cursor) counts a waiting tick, and the 10th in a row warns once. With a cycle, steps run
 * one after the other while the clock is before the deadline of the tick and the stop has not begun. The start is the run's one
 * forced unit (no step follows it past the deadline); in a run that starts nothing the first step always runs, whatever the
 * deadline says, so that a cycle moves at every tick even when the jobs before it use the whole tick. A step is never cut by the
 * budget (it takes no signal: it only reads); one that takes longer than the budget is warned about. When no step is left the
 * snapshot is written, unconditionally: it is two statements and ends the cycle.
 *
 * **Failures.** A step that fails (or a start that throws, or a read of the newest snapshot, or the write) is logged and counted
 * by `deps.failed`, ends the run, and stays first: it is tried again at the **next** tick, not at once. Its failures count across
 * runs: a run that does not attempt it (the stop began, a wait is running) neither counts nor clears the streak; a step that
 * works, a start that answers (even that it waits), a read of the newest snapshot that answers that no cycle is due, and a written
 * row clear it. The third failure in a row drops the cycle and starts a wait before the next start: 5 minutes, doubling up to an
 * hour (`AGGREGATE_RETRY_MS`, `AGGREGATE_MAX_RETRY_MS`), which a written row resets. A failure that comes of the shutdown does not
 * count toward the streak (`deps.failed` decides what is logged and counted of it: an abort is neither, a plain read error is both).
 * A step that takes longer than the budget is warned about once for as long as the steps keep being slow: the warning is said
 * again after a step that came in time, so a cycle whose steps straddle the budget can log it more than once.
 *
 * **Gauges.** `syncer_supply_snapshot_age_seconds` is set at every run from the newest snapshot the process has seen (read or
 * written), also after a failed read or a failed step; until it has seen one it has no sample (`PrometheusService` removes the 0 that
 * a registered gauge starts with, so that `absent()` can tell). `syncer_supply_cycle_seconds` is the wall time of a cycle, set when
 * its row is written, and has no sample before the first one.
 */
export class SupplyJobRunner {
  private readonly fns: SupplyFunctions;
  /** The cycle in progress. */
  private cycle?: SupplyCycle;
  /** When the cycle in progress began (the clock, milliseconds). */
  private began = 0;
  /** How many times in a row the step the job is at (the start, a step, the write) has failed. */
  private failures = 0;
  /** The wait after the cycles that were dropped, until a row is written. */
  private wait?: Backoff;
  /** The starts in a row that answered that they wait, and whether the warning for them is out. */
  private waitingTicks = 0;
  private waitWarned = false;
  /** Whether the warning for a step over its budget is out (until a step comes in time). */
  private slowWarned = false;
  /** The close time (unix seconds) of the newest snapshot this process has read or written; none before it has seen one. */
  private closeTime?: number;

  constructor(
    private readonly deps: AggregateJobDeps,
    private readonly supply: AggregatorSupply,
    fns: Partial<SupplyFunctions> = {},
  ) {
    this.fns = { ...SUPPLY_FUNCTIONS, ...fns };
  }

  job(): AggregatorJob {
    return { name: 'supply', budgetMs: this.deps.budgetMs, run: (tick) => this.run(tick) };
  }

  private async run(tick: AggregatorTick): Promise<void> {
    if (this.deps.closing()) return;
    try {
      await this.work(tick);
    } finally {
      this.setAge();
    }
  }

  private async work(tick: AggregatorTick): Promise<void> {
    const { deps } = this;
    // the units the run has attempted: the first is forced past the deadline, the others need time
    let units = 0;
    if (this.cycle === undefined) {
      if (!(await this.begin())) return;
      units = 1;
    }
    for (;;) {
      const cycle = this.cycle;
      if (cycle === undefined || deps.closing()) return;
      if (cycle.pending.length === 0) {
        await this.write(tick, cycle);
        return;
      }
      if (units > 0 && deps.clock() >= tick.deadline) return;
      units++;
      if (!(await this.step(cycle))) return;
    }
  }

  /**
   * Starts a cycle when none is in progress, no wait is running and the newest snapshot started an hour ago or more (or there is
   * none). True when a cycle was started. A read or a start that throws is a failed step; a start that waits counts a waiting tick.
   */
  private async begin(): Promise<boolean> {
    const { deps } = this;
    if (this.wait !== undefined && this.wait.until > deps.clock()) return false;
    let newest: NetworkSupplyRow | undefined;
    try {
      newest = await this.fns.newestSnapshot(deps.ch);
    } catch (err) {
      this.fail(err, ' reading the newest snapshot', 'the read of the newest snapshot');
      return false;
    }
    if (deps.closing()) return false;
    if (newest !== undefined) {
      this.closeTime = Number(newest.close_time);
      if (deps.clock() - Number(newest.started_at) * 1000 < SUPPLY_INTERVAL_MS) {
        // no cycle is due: the failures of the reads before this one were of a start that is not wanted now
        this.failures = 0;
        return false;
      }
    }

    const began = deps.clock();
    let answer: SupplyStart;
    try {
      // the sight is read now, after the `amm_pools` job of this tick, and only where there is an AMM to wait for
      const sight = this.supply.profile.hasAmm ? (this.supply.ammSight?.() ?? NO_AMM_SIGHT) : undefined;
      answer = await this.fns.startSupplyCycle(deps.ch, this.supply.profile, Math.floor(began / 1000), sight);
    } catch (err) {
      this.fail(err, ' in the start', 'the start');
      return false;
    }
    if (deps.closing()) return false;
    // the start answered, whichever way: it did not fail
    this.failures = 0;
    if (!('cycle' in answer)) {
      if (++this.waitingTicks >= SUPPLY_START_WAIT_TICKS && !this.waitWarned) {
        this.waitWarned = true;
        deps.logger.warn('supply: waiting for escrows/amm_pools to reach the head');
      }
      return false;
    }

    const cycle = answer.cycle;
    this.cycle = cycle;
    this.began = began;
    this.waitingTicks = 0;
    this.waitWarned = false;
    deps.logger.debug(`supply: a cycle starts at ledger ${cycle.ledger} with ${cycle.steps} steps`);
    if (cycle.poolsAtStoredRow.length > 0) {
      deps.logger.warn(
        `supply: ${cycle.poolsAtStoredRow.length} AMM pool(s) set aside by the amm_pools job are counted at their stored row, ` +
          `and not as of ledger ${cycle.ledger}: ${named(cycle.poolsAtStoredRow)}`,
      );
    }
    return true;
  }

  /** Runs the first step of the plan. True when it worked; false when it failed (the cycle keeps it first, or is dropped). */
  private async step(cycle: SupplyCycle): Promise<boolean> {
    const { deps } = this;
    const kind = cycle.pending[0].kind;
    const began = deps.clock();
    let next: SupplyCycle;
    try {
      next = await this.fns.runSupplyStep(deps.ch, this.supply.profile, cycle);
    } catch (err) {
      this.fail(err, ` in the ${kind} step`, `the ${kind} step`);
      return false;
    }
    this.failures = 0;
    this.cycle = next;
    const took = deps.clock() - began;
    if (took > deps.budgetMs) {
      const text = `supply: a step took ${took} ms, over its budget of ${deps.budgetMs} ms`;
      if (this.slowWarned) {
        deps.logger.debug(text);
      } else {
        this.slowWarned = true;
        deps.logger.warn(text);
      }
    } else {
      this.slowWarned = false;
    }
    deps.logger.debug(`supply: the ${kind} step is done, ${next.pending.length} step(s) left`);
    return true;
  }

  /** Writes the snapshot of a cycle with no step left, and ends the cycle: the gauge, the line of the log, the wait reset. */
  private async write(tick: AggregatorTick, cycle: SupplyCycle): Promise<void> {
    const { deps } = this;
    let row: NetworkSupplyRow;
    try {
      row = await this.fns.writeSupplySnapshot(deps.ch, cycle, Math.floor(deps.clock() / 1000), tick.signal);
    } catch (err) {
      this.fail(err, ' writing the snapshot', 'the write');
      return;
    }
    const ms = deps.clock() - this.began;
    this.cycle = undefined;
    this.failures = 0;
    this.wait = undefined;
    this.closeTime = Number(row.close_time);
    deps.metrics?.supplyCycleSeconds.set(ms / 1000);
    deps.logger.log(
      `supply: ledger ${cycle.ledger}, ${cycle.steps} steps, ${Math.round(ms / 1000)} s, in drops: ` +
        `total ${row.total_coins}, burned ${row.burned}, escrowed ${row.escrowed}, amm ${row.amm ?? 'none'}, ` +
        `reserves ${reservesOf(row)}, minted ${mintedOf(row)}`,
    );
    // the pools counted as 0 grow while the amm steps run, so they are said once, with what is known at the end
    if (cycle.poolsAtZero.length > 0) {
      deps.logger.warn(
        `supply: ${cycle.poolsAtZero.length} AMM pool(s) with a native reserve that could not be read were counted as 0 ` +
          `in the snapshot of ledger ${cycle.ledger}: ${named(cycle.poolsAtZero)}`,
      );
    }
  }

  /**
   * A step of the job failed: it is logged and counted, and its streak grows; the third failure in a row drops the cycle (if
   * there is one) and starts the wait. `where` ends the log line, `what` names the step in the warning. A failure that comes of
   * the shutdown is `deps.failed`'s to treat as such, and is not counted here.
   */
  private fail(err: unknown, where: string, what: string): void {
    const { deps } = this;
    deps.failed('supply', err, where);
    if (deps.closing()) return;
    if (++this.failures < SUPPLY_MAX_STEP_FAILURES) return;
    const cycle = this.cycle;
    this.cycle = undefined;
    this.failures = 0;
    this.wait = backoffAfterFailure(this.wait, deps.clock(), AGGREGATE_RETRY_MS, AGGREGATE_MAX_RETRY_MS);
    const minutes = Math.round(this.wait.delayMs / 60_000);
    deps.logger.warn(
      cycle === undefined
        ? `supply: ${what} failed ${SUPPLY_MAX_STEP_FAILURES} times in a row; the next try waits ${minutes} min`
        : `supply: the cycle at ledger ${cycle.ledger} was dropped after ${SUPPLY_MAX_STEP_FAILURES} failures in a row of ${what}; ` +
            `the next start waits ${minutes} min`,
    );
  }

  /** Sets the age of the newest snapshot this process has seen; nothing before it has seen one. Set at every run, after a failure too. */
  private setAge(): void {
    if (this.closeTime === undefined) return;
    this.deps.metrics?.supplySnapshotAgeSeconds.set(Math.max(0, Math.floor(this.deps.clock() / 1000) - this.closeTime));
  }
}

/** What the accounts must hold in reserve, in drops, as the api computes it; `unknown` without the reserve values. */
function reservesOf(row: NetworkSupplyRow): string {
  if (row.reserve_base === null || row.reserve_inc === null) return 'unknown';
  return reservesDrops(
    BigInt(row.accounts),
    BigInt(row.owner_count),
    BigInt(row.reserve_base),
    BigInt(row.reserve_inc),
  ).toString();
}

/** The drops minted by all three sources; `none` on a network that does not mint. */
function mintedOf(row: NetworkSupplyRow): string {
  if (row.minted_rewards === null || row.minted_import === null || row.minted_genesis === null) return 'none';
  return (BigInt(row.minted_rewards) + BigInt(row.minted_import) + BigInt(row.minted_genesis)).toString();
}
