import {
  CollectionKey,
  collectionsBehind,
  NFT_COLLECTIONS_BATCH,
  recomputeCollections,
} from '@gatehub/data-api-shared';
import type { AggregatorJob } from './aggregator.service';
import { AggregatorJobContext, AggregatorTick, describe } from './job-context';
import { AggregatorNfts, MAX_ISOLATED_NFTS_PER_BATCH, NFT_MAX_RETRY_MS, NFT_RETRY_MS } from './nft-state.job-runner';

/** `nft_collections` runs at the first tick and then every this many ticks: the collections change slowly, and the tick is shared. */
export const NFT_COLLECTIONS_EVERY_TICKS = 5;

/**
 * A batch of `nft_collections` that fails is halved until the collections that fail on their own are found (the rule of
 * `nft_state`, whose `MAX_ISOLATED_NFTS_PER_BATCH` this is). When more than this many of one batch fail, the cause is not the
 * collections (the database, a limit) and the batch is the failure of the job: its collections go back to the queue.
 */
export const MAX_ISOLATED_COLLECTIONS_PER_BATCH = MAX_ISOLATED_NFTS_PER_BATCH;

const JOB = 'nft_collections';

/**
 * How many turns of the microtask queue a read of the collections that are behind is given to settle before the queue is worked:
 * enough for a function that already has its answer, never for a query, which is waited for by no one (see
 * `NftCollectionsJobRunner.run`).
 */
const QUICK_READ_TURNS = 8;

/** The functions of the shared package the `nft_collections` job calls; tests replace them. */
export interface NftCollectionsFunctions {
  /** The collections whose newest NFT version is above their `nft_collections` version (or which have none): the queue at the start. */
  behind: typeof collectionsBehind;
  /** Computes the rows of a batch of collections and writes them, or deletes the collections with no NFT left. */
  recompute: typeof recomputeCollections;
}

/** The functions of the shared package, for what the options do not replace. */
export const NFT_COLLECTIONS_FUNCTIONS: NftCollectionsFunctions = {
  behind: collectionsBehind,
  recompute: recomputeCollections,
};

const idOf = (key: CollectionKey): string => `${key.issuer}/${key.taxon_key}`;

/** A list of collections in the halving of a batch that fails (see `NftCollectionsJobRunner.runBatch`). */
interface CollectionNode {
  keys: CollectionKey[];
  parent?: CollectionNode;
  /** What it failed with; set only on a list that failed. */
  error?: unknown;
  /** Whether a collection that failed alone is found below it. */
  leadsToCollection?: boolean;
}

/** The batch of collections the job is computing, and where the halving of a batch that fails has got to. */
interface CollectionBatch {
  /** The collections, to tell the same batch when it comes again. */
  id: string;
  /** The lists still to compute, the first one next. */
  todo: CollectionNode[];
  /** Every list that failed. */
  failed: CollectionNode[];
  /** The collections that failed alone: set aside when the batch is done, if the rest of it worked. */
  suspects: Array<{ node: CollectionNode; error: unknown }>;
  /** Whether any list of the batch was computed. */
  succeeded: boolean;
  /** Whether this is the same batch coming again after every one of its lists failed in the run just before. */
  repeated: boolean;
  /** Whether its failure has been counted and logged already (at the end of the run of its first failure). */
  counted?: boolean;
}

/**
 * The `nft_collections` job of the aggregator (see `AggregatorService`, job 11): the `nft_collections` row of a collection (its
 * supply, holders, mints, burns, sales and volume) and the set of its holders, computed again for the collections whose NFTs
 * `nft_state` rebuilt. Its state (the queue of the collections due, the collections set aside, the read that fills the queue) is
 * its own; the database, the clock, the budget and the rules of the tick are the service's (`AggregatorJobContext`).
 *
 * The queue is in memory, so a restart loses it: the collections that `nft_state` has queued since the start are joined by the
 * ones the tables say are behind (`collectionsBehind`: a read of the whole of `nfts` and of the two tables of the collections),
 * which a read that the run does not wait for fetches at the first run. A collection is queued once, whatever the number of times
 * its NFTs are rebuilt before it is computed, and the oldest is computed first.
 *
 * A run takes `NFT_COLLECTIONS_BATCH` collections at a time (one version each: `recomputeCollections`) while the budget of the job
 * lasts and the shutdown has not begun, and then the collections that were set aside and whose wait is over. A batch that fails
 * is halved, as `nft_state` halves its batches, until the collections that fail on their own are found: a collection that fails
 * alone is counted and logged, and set aside to be tried again after `NFT_RETRY_MS`, and after twice as long each time it fails
 * again, up to `NFT_MAX_RETRY_MS`, while the other collections go on. After every run the gauge `syncer_nft_collections_pending`
 * is how many collections wait to be computed, the ones set aside included.
 */
export class NftCollectionsJobRunner {
  /** The collections due, oldest first, each once (a `Map` keeps the order of its first insertion). */
  private queue = new Map<string, CollectionKey>();
  /** Whether the queue has been filled from the tables: once a read of `collectionsBehind` has answered. */
  private filled = false;
  /** Whether a read of `collectionsBehind` is in flight: the run that starts it does not await it. */
  private reading = false;
  /** When the next read may start after one that failed, and the wait after the next failure (0: none failed). */
  private readRetryAt = 0;
  private readDelayMs = 0;
  /** The collections that failed on their own: when to try each again, and the wait after the next failure. */
  private readonly retry = new Map<string, { key: CollectionKey; until: number; delayMs: number }>();
  /**
   * The batch whose halving did not fit in the budget of a run: the next run goes on with it, from the list it stopped at,
   * instead of taking its collections again and halving from the whole batch (which, for a failure that takes longer than a
   * share of the budget, would never get further).
   */
  private current?: CollectionBatch;
  /**
   * The batches (their collections) that failed whole with nothing in them computed, in the run in progress and in the run just
   * before. The same batch coming again in the next run is a repeat: then its collections are the ones that fail.
   */
  private allFailed = { previous: new Set<string>(), current: new Set<string>() };

  constructor(
    private readonly ctx: AggregatorJobContext,
    private readonly nfts: AggregatorNfts,
    private readonly fns: NftCollectionsFunctions,
  ) {}

  /** How many collections wait to be computed: the queue, the batch under way and the collections set aside. */
  get pending(): number {
    const batch = this.current;
    const inBatch = batch ? batch.todo.reduce((n, node) => n + node.keys.length, 0) + batch.suspects.length : 0;
    return this.queue.size + this.retry.size + inBatch;
  }

  /**
   * The collections to compute: each once, behind the ones already queued. A collection that is set aside is not queued: its
   * retry computes it, from the NFTs as they are by then.
   */
  enqueue(keys: readonly CollectionKey[]): void {
    for (const { issuer, taxon_key } of keys) {
      const key = { issuer, taxon_key };
      const id = idOf(key);
      if (!this.queue.has(id) && !this.retry.has(id)) this.queue.set(id, key);
    }
  }

  /** The job as the service lists it: its own budget, and every `NFT_COLLECTIONS_EVERY_TICKS` ticks from the first. */
  job(): AggregatorJob {
    return {
      name: JOB,
      budgetMs: this.ctx.budgets.nft_collections,
      everyTicks: NFT_COLLECTIONS_EVERY_TICKS,
      run: (tick) => this.run(tick),
    };
  }

  /**
   * One run of the job: the queue, a batch at a time, then the retries of the collections set aside, each until nothing is left,
   * the budget of the job is spent, or the shutdown begins. Each part runs although the one before it failed (a batch that fails
   * as a whole): the first failure is the error of the job, which is logged and counted as `nft_collections`, and the others are
   * logged and counted here. The gauge is set at the end of every run.
   *
   * The read of the collections that are behind is started at the first run, and again at a later one while it has not answered
   * (and its wait after a failure is over), **without waiting for it**: it reads the whole of `nfts`, which on a mainnet-sized
   * table may take as long as the time limit of a query (30 s), a run that waited for it would leave nothing of the tick to the
   * jobs after it, and it has no budget to bound it. The queue is worked meanwhile, and the answer is queued when it arrives (a
   * read that answers at once, as a function with its answer in hand does, is queued in the same run). A read that fails is
   * counted and logged, and started again only after a wait (`NFT_RETRY_MS`, doubling up to `NFT_MAX_RETRY_MS`).
   */
  async run(tick: AggregatorTick): Promise<void> {
    this.allFailed = { previous: this.allFailed.current, current: new Set() };
    this.startRead();
    await this.letQuickReadSettle();
    const failures: unknown[] = [];
    const part = async (work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await part(() => this.drain(tick));
    await part(() => this.retries(tick));
    this.ctx.metrics?.nftCollectionsPending.set(this.pending);
    if (failures.length > 0) {
      for (const error of failures.slice(1)) this.ctx.failed(JOB, error);
      throw failures[0];
    }
  }

  /** Starts a read of `collectionsBehind`, not awaited, unless it has answered, one is in flight, the wait after a failure is not over, or the stop has begun. */
  private startRead(): void {
    if (this.filled || this.reading || this.ctx.closing() || this.ctx.clock() < this.readRetryAt) return;
    // `readBehind` handles what goes wrong with it; the catch only keeps a failure of the reporting from being unhandled
    void this.readBehind().catch(() => undefined);
  }

  /**
   * Reads the collections that are behind and queues them. A failure is counted and logged as `nft_collections`, and sets the time
   * before which no new read starts. Once the shutdown has begun the result, or the failure, is of no use and is dropped.
   */
  private async readBehind(): Promise<void> {
    this.reading = true;
    try {
      const keys = await this.fns.behind(this.ctx.ch);
      if (this.ctx.closing()) return;
      this.enqueue(keys);
      this.filled = true;
    } catch (err) {
      if (this.ctx.closing()) return;
      const delayMs = this.readDelayMs === 0 ? NFT_RETRY_MS : Math.min(this.readDelayMs * 2, NFT_MAX_RETRY_MS);
      this.readDelayMs = delayMs;
      this.readRetryAt = this.ctx.clock() + delayMs;
      this.ctx.failed(
        JOB,
        err,
        ` reading the collections that are behind, tried again in ${Math.round(delayMs / 60_000)} min`,
      );
    } finally {
      this.reading = false;
    }
  }

  /** Gives a read that is answered at once a few turns of the microtask queue to settle; a query is not waited for. */
  private async letQuickReadSettle(): Promise<void> {
    for (let turn = 0; turn < QUICK_READ_TURNS && this.reading; turn++) await Promise.resolve();
  }

  /**
   * The batch under way if there is one, then the queue, a batch at a time, until the queue is empty or a batch could not be
   * finished (the budget, the shutdown).
   */
  private async drain(tick: AggregatorTick): Promise<void> {
    for (;;) {
      let batch = this.current;
      if (!batch) {
        const keys = this.take();
        if (keys.length === 0) return;
        batch = this.newBatch(keys);
        this.current = batch;
      }
      if (!(await this.runBatch(batch, tick))) return;
    }
  }

  /**
   * Takes the oldest `NFT_COLLECTIONS_BATCH` collections out of the queue. One that is set aside is dropped: it was queued again
   * (an answer of the read, or a rebuild) while it was in a batch that set it aside, and its retry computes it.
   */
  private take(): CollectionKey[] {
    const batch: CollectionKey[] = [];
    for (const [id, key] of this.queue) {
      if (batch.length >= NFT_COLLECTIONS_BATCH) break;
      this.queue.delete(id);
      if (!this.retry.has(id)) batch.push(key);
    }
    return batch;
  }

  private newBatch(keys: CollectionKey[]): CollectionBatch {
    const id = keys.map(idOf).join(',');
    return {
      id,
      todo: [{ keys }],
      failed: [],
      suspects: [],
      succeeded: false,
      repeated: this.allFailed.previous.has(id),
    };
  }

  /** Computes a list of collections and writes them (or deletes the ones with no NFT left). */
  private async compute(tick: AggregatorTick, keys: CollectionKey[]): Promise<void> {
    const { written, removed } = await this.fns.recompute(this.ctx.ch, this.nfts.dailyRates, keys, {
      signal: tick.signal,
    });
    this.ctx.logger.debug(`nft_collections: ${written} collection(s) written, ${removed} removed`);
  }

  /**
   * Computes the lists of a batch, the first of `todo` first. A list that fails is halved, and the halves go first, so that the
   * collections that fail on their own are found: a list of one collection that fails is a suspect.
   *
   *  - More than `MAX_ISOLATED_COLLECTIONS_PER_BATCH` suspects: the cause is not the collections, and the error of the batch is
   *    thrown. The suspects and what was not tried go back to the end of the queue.
   *  - When the batch is done, its suspects are set aside for a retry (`NFT_RETRY_MS`), each counted and logged as an error of
   *    `nft_collections` ... but only if something in the batch worked, or if it is a repeat of a batch in which everything
   *    failed: a batch where everything fails (the database is down) is the failure of the job, thrown, with its collections
   *    back in the queue, and the same batch coming again in the next run with the same collections failing alone is the one that
   *    proves them guilty.
   *  - A list that failed and yet whose halves worked, with no collection found below it, is warned about and counted: it fails
   *    as a whole for its size, and would otherwise leave no trace.
   *
   * It stops, returning false, when the budget of the job is spent or the shutdown begins: the batch stays as it is (`current`),
   * and the next run goes on with it from the list it stopped at. A batch that has failed by then is counted and logged once, at
   * that run (a halving can take many runs, and the failure must not wait for its end to be seen); its end counts the
   * collections it sets aside, and does not count that failure again.
   */
  private async runBatch(batch: CollectionBatch, tick: AggregatorTick): Promise<boolean> {
    const { todo, failed, suspects } = batch;
    while (todo.length > 0) {
      if (!this.ctx.mayStartSet(tick, JOB)) {
        this.countDeferred(batch);
        return false;
      }
      const node = todo[0];
      try {
        await this.compute(tick, node.keys);
        todo.shift();
        batch.succeeded = true;
      } catch (error) {
        // (the batch stays as it is: it is the shutdown that stops it)
        if (this.ctx.closing()) throw error;
        node.error = error;
        failed.push(node);
        todo.shift();
        if (node.keys.length > 1) {
          const middle = Math.ceil(node.keys.length / 2);
          todo.unshift(
            { keys: node.keys.slice(0, middle), parent: node },
            { keys: node.keys.slice(middle), parent: node },
          );
        } else {
          suspects.push({ node, error });
          if (suspects.length > MAX_ISOLATED_COLLECTIONS_PER_BATCH) this.giveUp(batch);
        }
      }
    }

    if (suspects.length > 0 && !batch.succeeded && !batch.repeated) {
      // the same batch comes again at the next run: then it is a repeat
      this.allFailed.current.add(batch.id);
      this.giveUp(batch);
    }
    for (const { node, error } of suspects) {
      for (let up: CollectionNode | undefined = node; up; up = up.parent) up.leadsToCollection = true;
      const key = node.keys[0];
      this.retry.set(idOf(key), { key, until: this.ctx.clock() + NFT_RETRY_MS, delayMs: NFT_RETRY_MS });
      this.ctx.failed(JOB, error, ` for collection ${idOf(key)}, set aside to be tried again`);
    }
    // a failure from which nothing led to a collection: the topmost of each such tree (the whole batch is not counted again when
    // its failure was counted at the run of it)
    for (const node of failed) {
      if (node.leadsToCollection || (node.parent && !node.parent.leadsToCollection)) continue;
      if (!(batch.counted && node.parent === undefined)) this.ctx.metrics?.aggregatorErrorsTotal.inc({ job: JOB });
      this.ctx.logger.warn(
        `Aggregator job nft_collections: a batch of ${node.keys.length} collection(s) failed as a whole, but its halves were computed: ${describe(node.error)}`,
      );
    }
    this.current = undefined;
    return true;
  }

  /**
   * Gives up a batch whose failure is not its collections' (see `runBatch`): the collections set aside so far and the ones not
   * tried go back to the end of the queue, and the error of the batch is the failure of the job.
   */
  private giveUp(batch: CollectionBatch): never {
    this.current = undefined;
    this.enqueue([...batch.suspects.map(({ node }) => node.keys[0]), ...batch.todo.flatMap((node) => node.keys)]);
    throw batch.failed[0].error;
  }

  /** Counts and logs, once, the failure of a batch whose halving goes on at the next run. */
  private countDeferred(batch: CollectionBatch): void {
    if (batch.counted || batch.failed.length === 0) return;
    batch.counted = true;
    this.ctx.failed(
      JOB,
      batch.failed[0].error,
      ` (a batch of ${batch.failed[0].keys.length} collection(s) is halved to find the collections that fail on their own, it goes on at the next run)`,
    );
  }

  /** The collections that were set aside and whose wait is over, one at a time, under the budget of the job. */
  private async retries(tick: AggregatorTick): Promise<void> {
    const due = [...this.retry.values()].filter((retry) => retry.until <= this.ctx.clock());
    for (const { key } of due) {
      if (!this.ctx.mayStartSet(tick, JOB)) return;
      const id = idOf(key);
      try {
        await this.compute(tick, [key]);
        this.retry.delete(id);
        this.ctx.logger.log(`nft_collections: collection ${id} is computed again`);
      } catch (err) {
        if (this.ctx.closing()) throw err;
        const delayMs = Math.min((this.retry.get(id)?.delayMs ?? NFT_RETRY_MS) * 2, NFT_MAX_RETRY_MS);
        this.retry.set(id, { key, until: this.ctx.clock() + delayMs, delayMs });
        this.ctx.failed(JOB, err, ` for collection ${id}, tried again in ${Math.round(delayMs / 60_000)} min`);
      }
    }
  }
}
