import {
  committedHead,
  MPT_STATE_BATCH,
  mptIssuancesChangedSince,
  mptIssuancesClosedIn,
  MptStale,
  mptStateWatermark,
  RatesService,
  rebuildMptIssuances,
} from '@gatehub/data-api-shared';
import { AggregatorJobContext, AggregatorTick, describe } from './job-context';

/**
 * A batch of `mpt_state` that fails is halved until the issuances that fail on their own are found. When more than this many of one
 * batch fail, the cause is not the issuances (the database, a limit) and the batch is the failure of the job: the cursor stays behind
 * it and the next tick does it again.
 */
export const MAX_ISOLATED_ISSUANCES_PER_BATCH = 3;

/**
 * An issuance that fails on its own is set aside, in memory, and tried again after this long, and after twice as long after each
 * further failure, up to `MPT_ISSUANCE_MAX_RETRY_MS`, while the cursor and the other issuances go on. A restart forgets the set: the
 * issuance is stale in the tables (`mptStateWatermark`), so the new process finds it again.
 */
export const MPT_ISSUANCE_RETRY_MS = 5 * 60_000;
export const MPT_ISSUANCE_MAX_RETRY_MS = 60 * 60_000;

/** What the `mpt_state` job works with: the rates of the network, which turn the time of a slice into its ledgers. */
export interface AggregatorMptState {
  rates: RatesService;
}

/** The functions of the shared package the `mpt_state` job calls; tests replace them. */
export interface MptStateFunctions {
  /** The newest committed ledger: what a run reads up to. */
  head: typeof committedHead;
  /** Where the job goes on from after a start: see `mptStateWatermark`. */
  watermark: typeof mptStateWatermark;
  changedSince: typeof mptIssuancesChangedSince;
  /** The issuances of the ledgers that closed in a window (the slice of an `agg_dirty` range). */
  closedIn: typeof mptIssuancesClosedIn;
  rebuild: typeof rebuildMptIssuances;
}

/** The functions of the shared package, for what the options do not replace. */
export const MPT_STATE_FUNCTIONS: MptStateFunctions = {
  head: committedHead,
  watermark: mptStateWatermark,
  changedSince: mptIssuancesChangedSince,
  closedIn: mptIssuancesClosedIn,
  rebuild: rebuildMptIssuances,
};

/** A list of issuances in the halving of a batch that fails (see `MptStateJobRunner.runBatch`). */
interface MptNode {
  issuances: MptStale[];
  parent?: MptNode;
  /** What it failed with; set only on a list that failed. */
  error?: unknown;
  /** Whether an issuance that failed alone is found below it. */
  leadsToIssuance?: boolean;
}

/** The batch of issuances `mpt_state` is rebuilding, and where the halving of a failing batch has got to. */
interface MptBatch {
  /** The cursor after the batch: the ledger its issuances are complete up to (live batches). */
  upTo?: number;
  /** The issuances, to tell the same batch when it comes again. */
  key: string;
  /** The lists still to rebuild, the first one next. */
  todo: MptNode[];
  /** The issuances that failed alone: set aside when the batch is done, if the rest of it worked. */
  suspects: Array<{ node: MptNode; error: unknown }>;
  /** Every list that failed. */
  failed: MptNode[];
  /** Whether any list of the batch was rebuilt. */
  succeeded: boolean;
  /** Whether this is the same batch coming again after every one of its lists failed in the last run of its job that attempted one. */
  repeated: boolean;
  /** Whether its failure has been counted and logged already (at the end of the tick of its first failure). */
  counted?: boolean;
}

/** The two jobs that rebuild issuances in batches: the live sweep, and the hook in the slices of `agg_dirty`. */
type BatchJob = 'mpt_state' | 'mpt_state_dirty';

/** The memory of a job's batches in which every list failed. */
interface FailedBatches {
  previous: Set<string>;
  current: Set<string>;
  /** Whether the run in progress has attempted a batch, and so has rolled the memory. */
  attempted: boolean;
}

/**
 * The `mpt_state` job of the aggregator (see `AggregatorService`, job 11), and its hook in the slices of `agg_dirty`: it rebuilds the
 * `mpt_issuances` row of every issuance with a touch above what its row has seen, and the `mpt_holders` rows of the pairs touched,
 * `MPT_STATE_BATCH` issuances at a time, oldest touch first. Its state (the cursor, the batch whose halving is under way, the issuances
 * set aside) is its own; the database, the clock, the budgets and the rules of the tick are the service's (`AggregatorJobContext`).
 *
 * It is `AmmPoolsJobRunner` with issuances for pools, but for what a pool's whole rebuild from its name does not need:
 *
 *  - **The gauge** `syncer_mpt_state_lag_ledgers` is set after every run, also one that failed or had no budget.
 *  - **The memory of a failed batch** rolls only at a run that attempts a batch, so a run with no budget (a late place in the tick, during
 *    a stats catch-up) forgets nothing, and a lone poison issuance is still set aside by its repeat.
 *  - **What a retry holds.** A set-aside issuance of the live sweep holds only its ID: `rebuildMptIssuances` reads what was touched above
 *    its row. A slice can name what no such touch names (a pair a re-ingest rewrote below `last_ledger`, or dropped), so a set-aside
 *    issuance holds the holders a slice named, for its retry.
 */
export class MptStateJobRunner {
  /**
   * The cursor of `mpt_state`: every issuance with a touch up to this ledger has been rebuilt, or is set aside. Unknown until the first
   * tick reads it from the tables (`mptStateWatermark`); it only moves past a batch that was written.
   */
  private watermark?: number;
  /** The newest committed ledger a run has read, for the gauge. */
  private head?: number;
  /** The issuances that failed on their own: when to try each again, the wait after the next failure, and what a slice named of it. */
  private readonly retry = new Map<string, { until: number; delayMs: number; holders: string[] }>();
  /**
   * The live batch whose halving did not fit in the budget of a tick: the next tick goes on with it, from the list it stopped at, instead
   * of asking for the issuances again and halving from the whole batch (which would never get further). The cursor stays where it was
   * until the batch is done.
   */
  private pending?: MptBatch;
  /**
   * The batches (their issuances) in which every list failed, by job: in the run in progress, and in the last run that attempted one. The
   * same batch coming again in the next such run is a repeat (a key older than that, or of the other job, is not).
   */
  private readonly allFailed: Record<BatchJob, FailedBatches> = {
    mpt_state: { previous: new Set(), current: new Set(), attempted: false },
    mpt_state_dirty: { previous: new Set(), current: new Set(), attempted: false },
  };

  constructor(
    private readonly ctx: AggregatorJobContext,
    private readonly mpt: AggregatorMptState,
    private readonly fns: MptStateFunctions,
  ) {}

  /**
   * Rebuilds the issuances with a touch above the cursor, a batch at a time, until nothing is left, the budget of the job is spent, or
   * the shutdown begins; then tries again the issuances that were set aside (`retries`), also when the first part failed. An issuance
   * that fails on its own does not stop the others (`runBatch`); a batch that fails as a whole is the error of the job, which is logged
   * and counted as `mpt_state`, and the jobs after this one still run. It leaves the cursor where it was, so the next tick asks for the
   * same issuances again. The gauge is set at the end of every run, whatever became of it.
   */
  async run(tick: AggregatorTick): Promise<void> {
    this.allFailed.mpt_state.attempted = false;
    try {
      this.head = await this.fns.head(this.ctx.ch);
      this.watermark ??= await this.fns.watermark(this.ctx.ch);
      let failure: { error: unknown } | undefined;
      try {
        await this.live(tick, this.head);
      } catch (error) {
        failure = { error };
      }
      await this.retries(tick, this.head);
      if (failure) throw failure.error;
    } finally {
      this.report();
    }
  }

  /** `syncer_mpt_state_lag_ledgers`, from the newest head a run has read: nothing until the job has a cursor, as it has no lag to tell. */
  private report(): void {
    if (this.head === undefined || this.watermark === undefined) return;
    this.ctx.metrics?.mptStateLagLedgers.set(Math.max(0, this.head - this.watermark));
  }

  /** The stale issuances after the cursor, a batch at a time; the cursor moves past a batch once it is done. */
  private async live(tick: AggregatorTick, head: number): Promise<void> {
    for (;;) {
      if (!this.ctx.mayStartSet(tick, 'mpt_state')) return;
      const ledger = this.watermark as number;
      let batch = this.pending;
      if (batch) {
        this.attempting('mpt_state');
      } else {
        const { issuances, upTo } = await this.fns.changedSince(this.ctx.ch, ledger, head, MPT_STATE_BATCH);
        if (this.ctx.closing()) return;
        batch = this.newBatch('mpt_state', issuances, upTo);
        if (!batch) {
          // nothing to rebuild up to `upTo` (no stale issuance, or those waiting for a retry): the cursor goes there and that is all
          // there is when the answer has no issuance; with issuances set aside there may be more
          if (upTo <= ledger) return;
          this.watermark = upTo;
          if (issuances.length === 0) return;
          continue;
        }
        this.pending = batch;
      }
      let finished: boolean;
      try {
        finished = await this.runBatch(batch, tick, 'mpt_state', true, head);
      } catch (err) {
        this.pending = undefined;
        throw err;
      }
      if (!finished) return; // the budget, or the shutdown: the batch stays as it is, and the next tick goes on with it
      this.pending = undefined;
      this.ctx.logger.debug(`mpt_state: ${batch.key.split(',').length} issuance(s) up to ledger ${batch.upTo}`);
      // a cursor that does not move would ask for the same issuances for ever
      if ((batch.upTo as number) <= ledger) return;
      this.watermark = batch.upTo;
    }
  }

  /**
   * The first batch of a run of `job`: the batches that failed whole before the run that last attempted one are forgotten. A run that
   * attempts none does not count, or a job at a late place in the tick, with no budget every other run, would forget the failed batch
   * at each of those and a lone poison issuance would never be set aside by its repeat, and would hold the cursor.
   */
  private attempting(job: BatchJob): void {
    const memory = this.allFailed[job];
    if (memory.attempted) return;
    memory.attempted = true;
    memory.previous = memory.current;
    memory.current = new Set();
  }

  /** A run of the hook of `agg_dirty` begins (`stats_dirty` calls it at the start of each of its runs): see `attempting`. */
  beginDirtyRun(): void {
    this.allFailed.mpt_state_dirty.attempted = false;
  }

  /**
   * A batch of the issuances of `stale` that are not waiting for a retry (they are rebuilt by it, and what a slice names of one is kept
   * for it); none if there are none.
   */
  private newBatch(job: BatchJob, stale: readonly MptStale[], upTo?: number): MptBatch | undefined {
    const issuances = stale.filter((issuance) => {
      const waiting = this.retry.get(issuance.id);
      if (waiting === undefined) return true;
      if (job === 'mpt_state_dirty') waiting.holders = [...new Set([...waiting.holders, ...issuance.holders])].sort();
      return false;
    });
    if (issuances.length === 0) return undefined;
    this.attempting(job);
    const key = issuances.map((issuance) => issuance.id).join(',');
    return {
      upTo,
      key,
      todo: [{ issuances }],
      suspects: [],
      failed: [],
      succeeded: false,
      repeated: this.allFailed[job].previous.has(key),
    };
  }

  /**
   * Rebuilds the lists of a batch, the first of `todo` first. A list that fails is halved, and the halves go first, so that the issuances
   * that fail on their own are found: a list of one issuance that fails is a suspect.
   *
   *  - More than `MAX_ISOLATED_ISSUANCES_PER_BATCH` suspects: the cause is not the issuances, and the error of the batch is thrown.
   *  - When the batch is done, its suspects are set aside for a retry (`MPT_ISSUANCE_RETRY_MS`), each counted as an error of `job` ...
   *    but only if something in the batch worked, or if it is a repeat of a batch in which everything failed: a batch where everything
   *    fails (the database is down) is the failure of the job, thrown, and the same batch coming again with the same issuances failing
   *    alone is the one that proves them guilty.
   *  - A list that failed and yet whose halves worked, with no issuance found below it, is warned about and counted: it fails as a whole
   *    for its size, and would otherwise leave no trace.
   *
   * With `budgeted` it stops, returning false, when the budget of the job is spent: the halving goes on at the next tick from where it
   * stopped, with the state in the batch. A batch that has failed by then is counted and logged once, at that tick (a halving can take
   * many ticks, and the failure must not wait for its end to be seen); its end counts the issuances it sets aside, and does not count
   * that failure again. A slice of `agg_dirty` is not budgeted (it is started whole). The shutdown stops it too, returning false.
   */
  private async runBatch(
    batch: MptBatch,
    tick: AggregatorTick,
    job: BatchJob,
    budgeted: boolean,
    head: number,
  ): Promise<boolean> {
    while (batch.todo.length > 0) {
      if (this.ctx.closing()) return false;
      if (budgeted && !this.ctx.mayStartSet(tick, 'mpt_state')) {
        this.countDeferred(batch, job);
        return false;
      }
      const node = batch.todo[0];
      try {
        await this.fns.rebuild(this.ctx.ch, node.issuances, head, { signal: tick.signal });
        batch.todo.shift();
        batch.succeeded = true;
      } catch (error) {
        if (this.ctx.closing()) throw error;
        node.error = error;
        batch.failed.push(node);
        batch.todo.shift();
        if (node.issuances.length > 1) {
          const middle = Math.ceil(node.issuances.length / 2);
          batch.todo.unshift(
            { issuances: node.issuances.slice(0, middle), parent: node },
            { issuances: node.issuances.slice(middle), parent: node },
          );
        } else {
          batch.suspects.push({ node, error });
          if (batch.suspects.length > MAX_ISOLATED_ISSUANCES_PER_BATCH) throw batch.failed[0].error;
        }
      }
    }

    if (batch.suspects.length > 0 && !batch.succeeded && !batch.repeated) {
      // the same batch comes again at the next run of the job that attempts one: then it is a repeat
      this.allFailed[job].current.add(batch.key);
      throw batch.failed[0].error;
    }
    for (const { node, error } of batch.suspects) {
      for (let up: MptNode | undefined = node; up; up = up.parent) up.leadsToIssuance = true;
      const { id, holders } = node.issuances[0];
      this.retry.set(id, {
        until: this.ctx.clock() + MPT_ISSUANCE_RETRY_MS,
        delayMs: MPT_ISSUANCE_RETRY_MS,
        // the live sweep's are above what the row has seen, and the retry reads them again with whatever came since
        holders: job === 'mpt_state_dirty' ? holders : [],
      });
      this.ctx.failed(job, error, ` for issuance ${id}, set aside to be tried again`);
    }
    // a failure from which nothing led to an issuance: the topmost of each such tree (the whole batch is not counted again when its
    // failure was counted at the tick of it)
    for (const node of batch.failed) {
      if (node.leadsToIssuance || (node.parent && !node.parent.leadsToIssuance)) continue;
      if (!(batch.counted && node.parent === undefined)) this.ctx.metrics?.aggregatorErrorsTotal.inc({ job });
      this.ctx.logger.warn(
        `Aggregator job ${job}: a batch of ${node.issuances.length} issuance(s) failed as a whole, but its halves were rebuilt: ${describe(node.error)}`,
      );
    }
    return true;
  }

  /** Counts and logs, once, the failure of a batch whose halving goes on at the next tick. */
  private countDeferred(batch: MptBatch, job: BatchJob): void {
    if (batch.counted || batch.failed.length === 0) return;
    batch.counted = true;
    this.ctx.metrics?.aggregatorErrorsTotal.inc({ job });
    this.ctx.logger.error(
      `Aggregator job ${job}: a batch of ${batch.key.split(',').length} issuance(s) failed, halving it to find the issuances that fail on their own (it goes on at the next tick): ${describe(batch.failed[0].error)}`,
    );
  }

  /** The issuances that were set aside and whose wait is over, one at a time, under the budget of the job. */
  private async retries(tick: AggregatorTick, head: number): Promise<void> {
    const due = [...this.retry].filter(([, retry]) => retry.until <= this.ctx.clock()).map(([id]) => id);
    for (const id of due) {
      if (!this.ctx.mayStartSet(tick, 'mpt_state')) return;
      const entry = this.retry.get(id);
      try {
        await this.fns.rebuild(this.ctx.ch, [{ id, holders: entry?.holders ?? [] }], head, { signal: tick.signal });
        this.retry.delete(id);
        this.ctx.logger.log(`mpt_state: issuance ${id} is rebuilt again`);
      } catch (err) {
        if (this.ctx.closing()) throw err;
        const delayMs = Math.min((entry?.delayMs ?? MPT_ISSUANCE_RETRY_MS) * 2, MPT_ISSUANCE_MAX_RETRY_MS);
        this.retry.set(id, { until: this.ctx.clock() + delayMs, delayMs, holders: entry?.holders ?? [] });
        this.ctx.failed('mpt_state', err, ` for issuance ${id}, tried again in ${Math.round(delayMs / 60_000)} min`);
      }
    }
  }

  /**
   * The issuances the ledgers that closed in the slice `[start, end)` of an `agg_dirty` range name, rebuilt a batch at a time at the head
   * read now (an issuance that fails on its own is set aside like those of the live job; a slice most of whose issuances fail fails the
   * slice). The slice is started whole (the budget is checked before a slice, as for its stats and volumes); only the shutdown stops it
   * between batches, and then the range is left as it is (`recomputeDirty` writes nothing to `agg_dirty` after it).
   */
  async ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void> {
    const issuances = await this.fns.closedIn(
      this.ctx.ch,
      this.mpt.rates,
      new Date(start * 1000),
      new Date(end * 1000),
    );
    if (issuances.length === 0) return;
    const head = await this.fns.head(this.ctx.ch);
    for (let i = 0; i < issuances.length; i += MPT_STATE_BATCH) {
      if (this.ctx.closing()) return;
      const batch = this.newBatch('mpt_state_dirty', issuances.slice(i, i + MPT_STATE_BATCH));
      if (batch) await this.runBatch(batch, tick, 'mpt_state_dirty', false, head);
    }
  }
}
