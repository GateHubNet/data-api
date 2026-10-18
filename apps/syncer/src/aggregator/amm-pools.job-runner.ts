import {
  ammPoolsWatermark,
  poolsChangedSince,
  poolsClosedIn,
  RatesService,
  recomputeAmmPools,
} from '@gatehub/data-api-shared';
import { AggregatorJobContext, AggregatorTick, describe } from './job-context';

/** How many pools one batch of `amm_pools` recomputes (and so how far the cursor of the job moves at a time). */
export const AMM_POOLS_BATCH = 200;

/**
 * A batch of `amm_pools` that fails is halved until the pools that fail on their own are found (Ruling R-A15). When more than
 * this many of one batch fail, the cause is not the pools (the database, a limit) and the batch is the failure of the job: the
 * cursor stays behind it and the next tick does it again.
 */
export const MAX_ISOLATED_POOLS_PER_BATCH = 3;

/**
 * A pool that fails on its own is set aside, in memory, and tried again after this long, and after twice as long after each
 * further failure, up to `AMM_POOL_MAX_RETRY_MS`, while the cursor and the other pools go on. A restart forgets the set: the
 * pool is stale in the tables (`ammPoolsWatermark`), so the new process finds it again.
 */
export const AMM_POOL_RETRY_MS = 5 * 60_000;
export const AMM_POOL_MAX_RETRY_MS = 60 * 60_000;

/** What the `amm_pools` job works with: the rates of the network, for the value of a pool. */
export interface AggregatorAmmPools {
  rates: RatesService;
}

/** The functions of the shared package the `amm_pools` job calls; tests replace them. */
export interface AmmPoolsFunctions {
  /** Where the job goes on from after a start: see `ammPoolsWatermark`. */
  watermark: typeof ammPoolsWatermark;
  changedSince: typeof poolsChangedSince;
  /** The pools of the ledgers that closed in a window (the slice of an `agg_dirty` range). */
  poolsClosedIn: typeof poolsClosedIn;
  recompute: typeof recomputeAmmPools;
}

/** The functions of the shared package, for what the options do not replace. */
export const AMM_POOLS_FUNCTIONS: AmmPoolsFunctions = {
  watermark: ammPoolsWatermark,
  changedSince: poolsChangedSince,
  poolsClosedIn,
  recompute: recomputeAmmPools,
};

/** A list of pools in the halving of a batch that fails (see `AmmPoolsJobRunner.runBatch`). */
interface AmmNode {
  accounts: string[];
  parent?: AmmNode;
  /** What it failed with; set only on a list that failed. */
  error?: unknown;
  /** Whether a pool that failed alone is found below it. */
  leadsToPool?: boolean;
}

/** The batch of pools `amm_pools` is rebuilding, and where the halving of a failing batch has got to. */
interface AmmBatch {
  /** The cursor after the batch: the ledger its pools are complete up to (live batches). */
  upTo?: number;
  /** The pools, to tell the same batch when it comes again. */
  key: string;
  /** The lists still to rebuild, the first one next. */
  todo: AmmNode[];
  /** The pools that failed alone: set aside when the batch is done, if the rest of it worked. */
  suspects: Array<{ node: AmmNode; error: unknown }>;
  /** Every list that failed. */
  failed: AmmNode[];
  /** Whether any list of the batch was rebuilt. */
  succeeded: boolean;
  /** Whether this is the same batch coming again after every one of its lists failed. */
  repeated: boolean;
}

/**
 * The `amm_pools` job of the aggregator (see `AggregatorService`, job 3), and its hook in the slices of `agg_dirty`: it rebuilds
 * the `amm_pools` row of every AMM pool whose state rows changed since its cursor, `AMM_POOLS_BATCH` pools at a time, oldest
 * change first. Its state (the cursor, the batch whose halving is under way, the pools set aside) is its own; the database, the
 * clock, the budgets and the rules of the tick are the service's (`AggregatorJobContext`).
 */
export class AmmPoolsJobRunner {
  /**
   * The cursor of `amm_pools`: every pool with a state row up to this ledger has been rebuilt. Unknown until the first tick
   * reads it from the tables (`ammPoolsWatermark`); it only moves past a batch that was written.
   */
  private watermark?: number;
  /** The pools of `amm_pools` that failed on their own: when to try each again, and the wait after the next failure. */
  private readonly retry = new Map<string, { until: number; delayMs: number }>();
  /**
   * The live batch whose halving did not fit in the budget of a tick: the next tick goes on with it, from the list it stopped
   * at, instead of asking for the pools again and halving from the whole batch (which would never get further). The cursor
   * stays where it was until the batch is done.
   */
  private pending?: AmmBatch;
  /** The batches (their pools) in which every list failed, the last few: the same batch coming again is a repeat. */
  private readonly allFailed = new Set<string>();

  constructor(
    private readonly ctx: AggregatorJobContext,
    private readonly amm: AggregatorAmmPools,
    private readonly fns: AmmPoolsFunctions,
  ) {}

  /**
   * Rebuilds the pools whose state rows changed since the cursor, a batch at a time, until nothing is left, the budget of the job
   * is spent, or the shutdown begins; then tries again the pools that were set aside (`retries`), also when the first part
   * failed. A pool that fails on its own does not stop the others (`runBatch`); a batch that fails as a whole is the error of the
   * job, which is logged and counted as `amm_pools`, and the jobs after this one still run. It leaves the cursor where it was, so
   * the next tick asks for the same pools again.
   */
  async run(tick: AggregatorTick): Promise<void> {
    this.watermark ??= await this.fns.watermark(this.ctx.ch);
    let failure: { error: unknown } | undefined;
    try {
      await this.live(tick);
    } catch (error) {
      failure = { error };
    }
    await this.retries(tick);
    if (failure) throw failure.error;
  }

  /** The stale pools after the cursor, a batch at a time; the cursor moves past a batch once it is done. */
  private async live(tick: AggregatorTick): Promise<void> {
    for (;;) {
      if (!this.ctx.mayStartSet(tick, 'amm_pools')) return;
      const ledger = this.watermark as number;
      let batch = this.pending;
      if (!batch) {
        const { accounts, upTo } = await this.fns.changedSince(this.ctx.ch, ledger, AMM_POOLS_BATCH);
        if (this.ctx.closing()) return;
        batch = this.newBatch(accounts, upTo);
        if (!batch) {
          // nothing to rebuild up to `upTo` (no stale pool, or those waiting for a retry): the cursor goes there and that is all
          // there is when the answer has no pool; with pools set aside there may be more
          if (upTo <= ledger) return;
          this.watermark = upTo;
          if (accounts.length === 0) return;
          continue;
        }
        this.pending = batch;
      }
      let finished: boolean;
      try {
        finished = await this.runBatch(batch, tick, 'amm_pools', true);
      } catch (err) {
        this.pending = undefined;
        throw err;
      }
      if (!finished) return; // the budget, or the shutdown: the batch stays as it is, and the next tick goes on with it
      this.pending = undefined;
      this.ctx.logger.debug(`amm_pools: ${batch.key.split(',').length} pool(s) up to ledger ${batch.upTo}`);
      // a cursor that does not move would ask for the same pools for ever
      if ((batch.upTo as number) <= ledger) return;
      this.watermark = batch.upTo;
    }
  }

  /** A batch of the pools of `accounts` that are not waiting for a retry (they are rebuilt by it); none if there are none. */
  private newBatch(accounts: string[], upTo?: number): AmmBatch | undefined {
    const pools = accounts.filter((account) => !this.retry.has(account));
    if (pools.length === 0) return undefined;
    const key = pools.join(',');
    return {
      upTo,
      key,
      todo: [{ accounts: pools }],
      suspects: [],
      failed: [],
      succeeded: false,
      repeated: this.allFailed.has(key),
    };
  }

  /**
   * Rebuilds the lists of a batch, the first of `todo` first (Ruling R-A15). A list that fails is halved, and the halves go
   * first, so that the pools that fail on their own are found: a list of one pool that fails is a suspect.
   *
   *  - More than `MAX_ISOLATED_POOLS_PER_BATCH` suspects: the cause is not the pools, and the error of the batch is thrown.
   *  - When the batch is done, its suspects are set aside for a retry (`AMM_POOL_RETRY_MS`), each counted as an error of `job`
   *    ... but only if something in the batch worked, or if it is a repeat of a batch in which everything failed: a batch where
   *    everything fails (the database is down) is the failure of the job, thrown, and the same batch coming again with the same
   *    pools failing alone is the one that proves them guilty.
   *  - A list that failed and yet whose halves worked, with no pool found below it, is warned about and counted: it fails as a
   *    whole for its size, and would otherwise leave no trace.
   *
   * With `budgeted` it stops, returning false, when the budget of the job is spent: the halving goes on at the next tick from
   * where it stopped, with the state in the batch. A slice of `agg_dirty` is not budgeted (it is started whole). The
   * shutdown stops it too, returning false.
   */
  private async runBatch(batch: AmmBatch, tick: AggregatorTick, job: string, budgeted: boolean): Promise<boolean> {
    while (batch.todo.length > 0) {
      if (this.ctx.closing() || (budgeted && !this.ctx.mayStartSet(tick, 'amm_pools'))) return false;
      const node = batch.todo[0];
      try {
        await this.fns.recompute(this.ctx.ch, this.amm.rates, node.accounts, { signal: tick.signal });
        batch.todo.shift();
        batch.succeeded = true;
      } catch (error) {
        if (this.ctx.closing()) throw error;
        node.error = error;
        batch.failed.push(node);
        batch.todo.shift();
        if (node.accounts.length > 1) {
          const middle = Math.ceil(node.accounts.length / 2);
          batch.todo.unshift(
            { accounts: node.accounts.slice(0, middle), parent: node },
            { accounts: node.accounts.slice(middle), parent: node },
          );
        } else {
          batch.suspects.push({ node, error });
          if (batch.suspects.length > MAX_ISOLATED_POOLS_PER_BATCH) throw batch.failed[0].error;
        }
      }
    }

    if (batch.suspects.length > 0 && !batch.succeeded && !batch.repeated) {
      this.allFailed.add(batch.key);
      // the few last batches are enough: the same one comes again at the next tick
      for (const key of this.allFailed) if (this.allFailed.size > 16) this.allFailed.delete(key);
      throw batch.failed[0].error;
    }
    this.allFailed.delete(batch.key);
    for (const { node, error } of batch.suspects) {
      for (let up: AmmNode | undefined = node; up; up = up.parent) up.leadsToPool = true;
      const account = node.accounts[0];
      this.retry.set(account, { until: this.ctx.clock() + AMM_POOL_RETRY_MS, delayMs: AMM_POOL_RETRY_MS });
      this.ctx.failed(job, error, ` for pool ${account}, set aside to be tried again`);
    }
    // a failure from which nothing led to a pool: the topmost of each such tree
    for (const node of batch.failed) {
      if (node.leadsToPool || (node.parent && !node.parent.leadsToPool)) continue;
      this.ctx.metrics?.aggregatorErrorsTotal.inc({ job });
      this.ctx.logger.warn(
        `Aggregator job ${job}: a batch of ${node.accounts.length} pool(s) failed as a whole, but its halves were rebuilt: ${describe(node.error)}`,
      );
    }
    return true;
  }

  /** The pools that were set aside and whose wait is over, one at a time, under the budget of the job. */
  private async retries(tick: AggregatorTick): Promise<void> {
    const due = [...this.retry].filter(([, retry]) => retry.until <= this.ctx.clock()).map(([account]) => account);
    for (const account of due) {
      if (!this.ctx.mayStartSet(tick, 'amm_pools')) return;
      try {
        await this.fns.recompute(this.ctx.ch, this.amm.rates, [account], { signal: tick.signal });
        this.retry.delete(account);
        this.ctx.logger.log(`amm_pools: pool ${account} is rebuilt again`);
      } catch (err) {
        if (this.ctx.closing()) throw err;
        const delayMs = Math.min((this.retry.get(account)?.delayMs ?? AMM_POOL_RETRY_MS) * 2, AMM_POOL_MAX_RETRY_MS);
        this.retry.set(account, { until: this.ctx.clock() + delayMs, delayMs });
        this.ctx.failed('amm_pools', err, ` for pool ${account}, tried again in ${Math.round(delayMs / 60_000)} min`);
      }
    }
  }

  /**
   * The pools with a state row in the ledgers that closed in the slice `[start, end)` of an `agg_dirty` range, rebuilt a batch at
   * a time (a pool that fails on its own is set aside like those of the live job; a slice most of whose pools fail fails the
   * slice). The slice is started whole (the budget is checked before a slice, as for its stats and volumes); only the shutdown
   * stops it between batches, and then the range is left as it is (`recomputeDirty` writes nothing to `agg_dirty` after it).
   */
  async ofSlice(start: number, end: number, tick: AggregatorTick): Promise<void> {
    const accounts = await this.fns.poolsClosedIn(
      this.ctx.ch,
      this.amm.rates,
      new Date(start * 1000),
      new Date(end * 1000),
    );
    for (let i = 0; i < accounts.length; i += AMM_POOLS_BATCH) {
      if (this.ctx.closing()) return;
      const batch = this.newBatch(accounts.slice(i, i + AMM_POOLS_BATCH));
      if (batch) await this.runBatch(batch, tick, 'amm_pools_dirty', false);
    }
  }
}
