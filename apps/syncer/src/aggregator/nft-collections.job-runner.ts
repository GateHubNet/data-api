import {
  CollectionKey,
  collectionsBehind,
  NFT_COLLECTIONS_BATCH,
  recomputeCollections,
} from '@gatehub/data-api-shared';
import type { AggregatorJob } from './aggregator.service';
import { AggregatorJobContext, AggregatorTick } from './job-context';
import type { AggregatorNfts } from './nft-state.job-runner';

/** `nft_collections` runs at the first tick and then every this many ticks: the collections change slowly, and the tick is shared. */
export const NFT_COLLECTIONS_EVERY_TICKS = 5;

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

/**
 * The `nft_collections` job of the aggregator (see `AggregatorService`, job 8a): the `nft_collections` row of a collection (its
 * supply, holders, mints, burns, sales and volume) and the set of its holders, computed again for the collections whose NFTs
 * `nft_state` rebuilt. Its state (the queue of the collections due) is its own; the database, the clock, the budget and the
 * rules of the tick are the service's (`AggregatorJobContext`).
 *
 * The queue is in memory, so a restart loses it: the first run fills it from the tables (`collectionsBehind`: one grouped read of
 * `nfts` and of `nft_collections`), with the collections that `nft_state` has queued since the start. A collection is queued
 * once, whatever the number of times its NFTs are rebuilt before it is computed, and the oldest is computed first.
 *
 * A run takes `NFT_COLLECTIONS_BATCH` collections at a time (one version each: `recomputeCollections`) while the budget of the job
 * lasts and the shutdown has not begun. A batch that fails goes back to the end of the queue, so the batches after it are not
 * kept waiting by it, and its failure is the error of the run: the run stops there, and the batch is tried again at the next one.
 * After every run the gauge `syncer_nft_collections_pending` is the length of the queue.
 */
export class NftCollectionsJobRunner {
  /** The collections due, oldest first, each once (a `Map` keeps the order of its first insertion). */
  private readonly queue = new Map<string, CollectionKey>();
  /** Whether the queue has been filled from the tables: at the first run that read succeeds. */
  private filled = false;

  constructor(
    private readonly ctx: AggregatorJobContext,
    private readonly nfts: AggregatorNfts,
    private readonly fns: NftCollectionsFunctions,
  ) {}

  /** How many collections wait to be computed. */
  get pending(): number {
    return this.queue.size;
  }

  /** The collections to compute: each once, behind the ones already queued. */
  enqueue(keys: readonly CollectionKey[]): void {
    for (const { issuer, taxon_key } of keys) {
      const id = `${issuer}/${taxon_key}`;
      if (!this.queue.has(id)) this.queue.set(id, { issuer, taxon_key });
    }
  }

  /** The job as the service lists it: its own budget, and every `NFT_COLLECTIONS_EVERY_TICKS` ticks from the first. */
  job(): AggregatorJob {
    return {
      name: 'nft_collections',
      budgetMs: this.ctx.budgets.nft_collections,
      everyTicks: NFT_COLLECTIONS_EVERY_TICKS,
      run: (tick) => this.run(tick),
    };
  }

  /**
   * One run of the job: the queue is filled from the tables if this is the first run (a read that fails is the error of the run,
   * and is made again at the next), then batches are computed until the queue is empty, the budget is spent or the shutdown
   * begins. A batch that fails is put back at the end of the queue and its error thrown (counted and logged by the tick as
   * `nft_collections`, unless it is the abort of the shutdown).
   */
  async run(tick: AggregatorTick): Promise<void> {
    try {
      if (!this.filled) {
        this.enqueue(await this.fns.behind(this.ctx.ch));
        this.filled = true;
      }
      while (this.queue.size > 0 && this.ctx.mayStartSet(tick, 'nft_collections')) {
        const batch = this.take();
        try {
          const { written, removed } = await this.fns.recompute(this.ctx.ch, this.nfts.dailyRates, batch, {
            signal: tick.signal,
          });
          this.ctx.logger.debug(`nft_collections: ${written} collection(s) written, ${removed} removed`);
        } catch (err) {
          this.enqueue(batch);
          throw err;
        }
      }
    } finally {
      this.ctx.metrics?.nftCollectionsPending.set(this.pending);
    }
  }

  /** Takes the oldest `NFT_COLLECTIONS_BATCH` collections out of the queue. */
  private take(): CollectionKey[] {
    const batch: CollectionKey[] = [];
    for (const [id, key] of this.queue) {
      if (batch.length >= NFT_COLLECTIONS_BATCH) break;
      batch.push(key);
      this.queue.delete(id);
    }
    return batch;
  }
}
