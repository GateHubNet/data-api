import {
  CollectionKey,
  committedHead,
  DailyRates,
  deleteNftDirty,
  markNftDirty,
  narrowNftDirty,
  NFT_DIRTY_STEP_LEDGERS,
  NFT_LIVE_STEP_LEDGERS,
  NFT_STATE_BATCH,
  nftDirtyLedgers,
  NftDirtyRange,
  NftKey,
  nftsChangedSince,
  nftsInLedgers,
  nftStateWatermark,
  oldestNftDirty,
  RatesService,
  rebuildNfts,
} from '@gatehub/data-api-shared';
import { AggregatorJobContext, AggregatorTick, describe } from './job-context';

/**
 * A batch of `nft_state` that fails is halved until the NFTs that fail on their own are found (the rule of `amm_pools`,
 * Ruling R-A15). When more than this many of one batch fail, the cause is not the NFTs (the database, a limit) and the batch is
 * the failure of the job: the cursor stays behind it and the next tick does it again.
 */
export const MAX_ISOLATED_NFTS_PER_BATCH = 3;

/**
 * An NFT that fails on its own is set aside, in memory, and tried again after this long, and after twice as long after each
 * further failure, up to `NFT_MAX_RETRY_MS`, while the cursor and the other NFTs go on. A restart forgets the set: the NFT is
 * stale in the tables (`nftStateWatermark`), so the new process finds it again.
 */
export const NFT_RETRY_MS = 5 * 60_000;
export const NFT_MAX_RETRY_MS = 60 * 60_000;

/**
 * What the NFT jobs work with: the rates of the network, which the hook of `agg_dirty` finds the ledgers of a slice with, and the
 * daily rates, for the prices of sales in the native currency (the collections job).
 */
export interface AggregatorNfts {
  rates: RatesService;
  dailyRates: DailyRates;
}

/** The functions of the shared package the `nft_state` job calls; tests replace them. */
export interface NftStateFunctions {
  /** Where the live job goes on from after a start: see `nftStateWatermark`. */
  watermark: typeof nftStateWatermark;
  /** The stale NFTs in a window of ledgers after a ledger (up to a cap), and the ledger the answer is complete up to. */
  changedSince: typeof nftsChangedSince;
  /** The NFTs of a ledger range (the step of an `nft_dirty` range). */
  inLedgers: typeof nftsInLedgers;
  rebuild: typeof rebuildNfts;
  markDirty: typeof markNftDirty;
  oldestDirty: typeof oldestNftDirty;
  narrowDirty: typeof narrowNftDirty;
  deleteDirty: typeof deleteNftDirty;
  /** The ledgers that the dirty ranges hold (`syncer_nft_dirty_ledgers`). */
  dirtyLedgers: typeof nftDirtyLedgers;
  /** The newest committed ledger, for the lag of the live cursor (`syncer_nft_state_lag_ledgers`). */
  head: typeof committedHead;
}

/** The functions of the shared package, for what the options do not replace. */
export const NFT_STATE_FUNCTIONS: NftStateFunctions = {
  watermark: nftStateWatermark,
  changedSince: nftsChangedSince,
  inLedgers: nftsInLedgers,
  rebuild: rebuildNfts,
  markDirty: markNftDirty,
  oldestDirty: oldestNftDirty,
  narrowDirty: narrowNftDirty,
  deleteDirty: deleteNftDirty,
  dirtyLedgers: nftDirtyLedgers,
  head: committedHead,
};

/** A list of NFTs in the halving of a batch that fails (see `NftStateJobRunner.runBatch`). */
interface NftNode {
  nfts: NftKey[];
  parent?: NftNode;
  /** What it failed with; set only on a list that failed. */
  error?: unknown;
  /** Whether an NFT that failed alone is found below it. */
  leadsToNft?: boolean;
}

/** The batch of NFTs `nft_state` is rebuilding, and where the halving of a failing batch has got to. */
interface NftBatch {
  /** The cursor after the batch: the ledger its NFTs are complete up to (live batches). */
  upTo?: number;
  /** The NFTs, to tell the same batch when it comes again. */
  key: string;
  /** The lists still to rebuild, the first one next. */
  todo: NftNode[];
  /** The NFTs that failed alone: set aside when the batch is done, if the rest of it worked. */
  suspects: Array<{ node: NftNode; error: unknown }>;
  /** Every list that failed. */
  failed: NftNode[];
  /** Whether any list of the batch was rebuilt. */
  succeeded: boolean;
  /** Whether this is the same batch coming again after every one of its lists failed in the run of its job just before. */
  repeated: boolean;
  /** Whether its failure has been counted and logged already (at the end of the tick of its first failure). */
  counted?: boolean;
}

/**
 * How many turns of the microtask queue a read of the cursor is given to settle before the live part looks for it: enough for a
 * function that already has its answer, never for a query, which is waited for by no one (see `NftStateJobRunner.run`).
 */
const QUICK_READ_TURNS = 8;

/** The two sweeps that rebuild NFTs in batches: the live one, and the steps of the oldest `nft_dirty` range. */
type BatchKind = 'live' | 'dirty';

/**
 * The step of the oldest `nft_dirty` range that is under way: the first `NFT_DIRTY_STEP_LEDGERS` ledgers of it. It is kept in
 * memory from tick to tick (a step of a re-ingested year holds more NFTs than a budget rebuilds), and the range is narrowed
 * only when the step is done.
 */
interface DirtyStep {
  range: NftDirtyRange;
  /** The last ledger of the step, inclusive. */
  to: number;
  /** The NFTs of the step that are in no batch yet. */
  rest: NftKey[];
  /** The batch whose halving is under way, and how many of the NFTs at the front of `rest` it was made of. */
  batch?: NftBatch;
  taken: number;
  /** Whether a batch of the step set an NFT aside: the range of the step is marked again when the step is done. */
  markAgain: boolean;
}

/**
 * The `nft_state` job of the aggregator (see `AggregatorService`, job 3a), and its hook in the slices of `agg_dirty`: it rebuilds
 * the `nfts` row (and the `account_nfts` rows) of every NFT with an event above what its row has seen, `NFT_STATE_BATCH` NFTs at
 * a time, oldest change first, and then, in what is left of the budget, the NFTs of the oldest range of `nft_dirty`, which a
 * re-ingest marked. Its state (the cursor, the batches whose halving is under way, the NFTs set aside, the step of the dirty
 * range) is its own; the database, the clock, the budgets and the rules of the tick are the service's (`AggregatorJobContext`).
 */
export class NftStateJobRunner {
  /**
   * The cursor of `nft_state`: every NFT with a touch up to this ledger has been rebuilt. Unknown until a read of it from the
   * tables (`nftStateWatermark`) has answered (`run`); it only moves past a batch that was written.
   */
  private watermark?: number;
  /** Whether a read of the cursor is in flight: it is not awaited by the run that starts it. */
  private reading = false;
  /** When the next read of the cursor may start after one that failed, and the wait after the next failure (0: none failed). */
  private readRetryAt = 0;
  private readDelayMs = 0;
  /** The newest committed ledger as of the end of the last run, for `lag`. */
  private head?: number;
  /** The NFTs that failed on their own: when to try each again, and the wait after the next failure. */
  private readonly retry = new Map<string, { key: NftKey; until: number; delayMs: number }>();
  /**
   * The live batch whose halving did not fit in the budget of a tick: the next tick goes on with it, from the list it stopped
   * at, instead of asking for the NFTs again and halving from the whole batch (which would never get further). The cursor stays
   * where it was until the batch is done.
   */
  private pending?: NftBatch;
  /** The step of the oldest dirty range that is under way. */
  private step?: DirtyStep;
  /** The dirty ranges (`<from>-<to>`) this run marked again: they wait for the next run, so that one that keeps failing is not done over and over in a run. */
  private readonly remarked = new Set<string>();
  /**
   * The batches (their NFTs) in which every list failed, by sweep: in the run in progress, and in the run just before. The same
   * batch coming again in the next run of its sweep is a repeat: a key older than that, or of the other sweep, is not.
   */
  private readonly allFailed: Record<BatchKind, { previous: Set<string>; current: Set<string> }> = {
    live: { previous: new Set(), current: new Set() },
    dirty: { previous: new Set(), current: new Set() },
  };

  constructor(
    private readonly ctx: AggregatorJobContext,
    private readonly nfts: AggregatorNfts,
    private readonly fns: NftStateFunctions,
    /** Told the collections (issuer and taxon) of every rebuild: the ones whose `nft_collections` row is to be computed again. */
    private readonly onRebuilt: (keys: CollectionKey[]) => void,
  ) {}

  /**
   * How many ledgers the live cursor is behind the newest committed one; none until the head is known. While the cursor is not
   * known (its read has not answered) every ledger is behind it.
   */
  get lag(): number | undefined {
    if (this.head === undefined) return undefined;
    return Math.max(0, this.head - (this.watermark ?? 0));
  }

  /**
   * One run of the job: the live sweep, then the retries of the NFTs set aside, then the steps of the dirty ranges, each until
   * nothing is left, the budget of the job is spent, or the shutdown begins. Each part runs although the one before it failed
   * (a batch that fails as a whole): the first failure is the error of the job, which is logged and counted as `nft_state` (and
   * the jobs after this one still run); the others are logged and counted here. The gauges are set at the end of every run.
   *
   * The cursor is read at the first run, and again at a later one while it is not known, **without waiting for the read**: on a
   * mainnet-sized table it may take as long as the time limit of a query (30 s), which is as long as a tick, and a run that waited
   * for it would leave nothing of the tick to the jobs after it, every tick. The live part starts at the first run after the
   * read has answered (one that answers at once, as a function with its answer in hand does, in the same run); the retries and
   * the dirty part do not need the cursor, and go on. A read that fails is counted and logged, and is started again only after a
   * wait (`NFT_RETRY_MS`, doubling up to `NFT_MAX_RETRY_MS`).
   */
  async run(tick: AggregatorTick): Promise<void> {
    this.nextRun('live');
    this.nextRun('dirty');
    this.remarked.clear();
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
    if (this.watermark !== undefined) await part(() => this.live(tick));
    await part(() => this.retries(tick));
    await part(() => this.dirty(tick));
    await this.report();
    if (failures.length > 0) {
      for (const error of failures.slice(1)) this.ctx.failed('nft_state', error);
      throw failures[0];
    }
  }

  /** Starts a read of the cursor, not awaited, unless it is known, one is in flight, the wait after a failure is not over, or the stop has begun. */
  private startRead(): void {
    if (this.watermark !== undefined || this.reading || this.ctx.closing() || this.ctx.clock() < this.readRetryAt)
      return;
    // `readWatermark` handles what goes wrong with it; the catch only keeps a failure of the reporting from being unhandled
    void this.readWatermark().catch(() => undefined);
  }

  /**
   * Reads the cursor from the tables (`nftStateWatermark`) and keeps it. A failure is counted and logged as `nft_state`, and sets
   * the time before which no new read starts. Once the shutdown has begun the result, or the failure, is of no use and is dropped.
   */
  private async readWatermark(): Promise<void> {
    this.reading = true;
    try {
      const watermark = await this.fns.watermark(this.ctx.ch);
      if (this.ctx.closing()) return;
      this.watermark = watermark;
    } catch (err) {
      if (this.ctx.closing()) return;
      const delayMs = this.readDelayMs === 0 ? NFT_RETRY_MS : Math.min(this.readDelayMs * 2, NFT_MAX_RETRY_MS);
      this.readDelayMs = delayMs;
      this.readRetryAt = this.ctx.clock() + delayMs;
      this.ctx.failed(
        'nft_state',
        err,
        ` reading where the job goes on from, tried again in ${Math.round(delayMs / 60_000)} min`,
      );
    } finally {
      this.reading = false;
    }
  }

  /** Gives a read of the cursor that is answered at once a few turns of the microtask queue to settle; a query is not waited for. */
  private async letQuickReadSettle(): Promise<void> {
    for (let turn = 0; turn < QUICK_READ_TURNS && this.reading; turn++) await Promise.resolve();
  }

  /** The stale NFTs after the cursor, a batch at a time; the cursor moves past a batch once it is done. */
  private async live(tick: AggregatorTick): Promise<void> {
    for (;;) {
      if (!this.ctx.mayStartSet(tick, 'nft_state')) return;
      const ledger = this.watermark as number;
      let batch = this.pending;
      if (!batch) {
        // one window of ledgers at a time: a cursor far behind the head does not group every touch after it in one query
        const cap = ledger + NFT_LIVE_STEP_LEDGERS;
        const { nfts, upTo } = await this.fns.changedSince(this.ctx.ch, ledger, NFT_STATE_BATCH, cap);
        if (this.ctx.closing()) return;
        batch = this.newBatch('live', nfts, upTo);
        if (!batch) {
          // nothing to rebuild up to `upTo` (no stale NFT, or those waiting for a retry): the cursor goes there. An answer with
          // no NFT that stopped short of the cap is complete up to the head, and that is all there is; one that reached the end
          // of its window (or has NFTs set aside) may have more behind it, which the next read looks at while the budget lasts
          if (upTo <= ledger) return;
          this.watermark = upTo;
          if (nfts.length === 0 && upTo < cap) return;
          continue;
        }
        this.pending = batch;
      }
      let finished: boolean;
      try {
        finished = await this.runBatch(batch, tick, 'live');
      } catch (err) {
        this.pending = undefined;
        throw err;
      }
      if (!finished) return; // the budget, or the shutdown: the batch stays as it is, and the next tick goes on with it
      this.pending = undefined;
      this.ctx.logger.debug(`nft_state: ${batch.key.split(',').length} NFT(s) up to ledger ${batch.upTo}`);
      // a cursor that does not move would ask for the same NFTs for ever
      if ((batch.upTo as number) <= ledger) return;
      this.watermark = batch.upTo;
    }
  }

  /** A run of a sweep begins: the batches that failed whole in its run before the last one are forgotten. */
  private nextRun(kind: BatchKind): void {
    const memory = this.allFailed[kind];
    memory.previous = memory.current;
    memory.current = new Set();
  }

  /** A batch of the NFTs of `nfts` that are not waiting for a retry (they are rebuilt by it); none if there are none. */
  private newBatch(kind: BatchKind, nfts: NftKey[], upTo?: number): NftBatch | undefined {
    const wanted = nfts.filter((nft) => !this.retry.has(nft.nft_id));
    if (wanted.length === 0) return undefined;
    const key = wanted.map((nft) => nft.nft_id).join(',');
    return {
      upTo,
      key,
      todo: [{ nfts: wanted }],
      suspects: [],
      failed: [],
      succeeded: false,
      repeated: this.allFailed[kind].previous.has(key),
    };
  }

  /** Rebuilds a list of NFTs and hands the collections of the rebuild on. */
  private async rebuild(tick: AggregatorTick, nfts: NftKey[]): Promise<void> {
    const { collections } = await this.fns.rebuild(this.ctx.ch, nfts, { signal: tick.signal });
    this.onRebuilt(collections);
  }

  /**
   * Rebuilds the lists of a batch, the first of `todo` first. A list that fails is halved, and the halves go first, so that the
   * NFTs that fail on their own are found: a list of one NFT that fails is a suspect.
   *
   *  - More than `MAX_ISOLATED_NFTS_PER_BATCH` suspects: the cause is not the NFTs, and the error of the batch is thrown.
   *  - When the batch is done, its suspects are set aside for a retry (`NFT_RETRY_MS`), each counted as an error of `nft_state`
   *    ... but only if something in the batch worked, or if it is a repeat of a batch in which everything failed: a batch where
   *    everything fails (the database is down) is the failure of the job, thrown, and the same batch coming again with the same
   *    NFTs failing alone is the one that proves them guilty. The suspects of a live batch are retried from memory (a restart
   *    finds them again: they are stale in the tables); those of a batch of a dirty step are not (nothing in the tables says they
   *    are stale), so the step is marked again instead (`dirty`), and they are tried again when it comes round.
   *  - A list that failed and yet whose halves worked, with no NFT found below it, is warned about and counted: it fails as a
   *    whole for its size, and would otherwise leave no trace.
   *
   * It stops, returning false, when the budget of the job is spent: the halving goes on at the next tick from where it stopped,
   * with the state in the batch. A batch that has failed by then is counted and logged once, at that tick (a halving can take
   * many ticks, and the failure must not wait for its end to be seen); its end counts the NFTs it sets aside, and does not count
   * that failure again. The shutdown stops it too, returning false.
   */
  private async runBatch(batch: NftBatch, tick: AggregatorTick, kind: BatchKind): Promise<boolean> {
    while (batch.todo.length > 0) {
      if (this.ctx.closing()) return false;
      if (!this.ctx.mayStartSet(tick, 'nft_state')) {
        this.countDeferred(batch);
        return false;
      }
      const node = batch.todo[0];
      try {
        await this.rebuild(tick, node.nfts);
        batch.todo.shift();
        batch.succeeded = true;
      } catch (error) {
        if (this.ctx.closing()) throw error;
        node.error = error;
        batch.failed.push(node);
        batch.todo.shift();
        if (node.nfts.length > 1) {
          const middle = Math.ceil(node.nfts.length / 2);
          batch.todo.unshift(
            { nfts: node.nfts.slice(0, middle), parent: node },
            { nfts: node.nfts.slice(middle), parent: node },
          );
        } else {
          batch.suspects.push({ node, error });
          if (batch.suspects.length > MAX_ISOLATED_NFTS_PER_BATCH) throw batch.failed[0].error;
        }
      }
    }

    if (batch.suspects.length > 0 && !batch.succeeded && !batch.repeated) {
      // the same batch comes again at the next run of the sweep: then it is a repeat
      this.allFailed[kind].current.add(batch.key);
      throw batch.failed[0].error;
    }
    for (const { node, error } of batch.suspects) {
      for (let up: NftNode | undefined = node; up; up = up.parent) up.leadsToNft = true;
      const nft = node.nfts[0];
      if (kind === 'live') {
        this.retry.set(nft.nft_id, { key: nft, until: this.ctx.clock() + NFT_RETRY_MS, delayMs: NFT_RETRY_MS });
        this.ctx.failed('nft_state', error, ` for NFT ${nft.nft_id}, set aside to be tried again`);
      } else {
        this.ctx.failed('nft_state', error, ` for NFT ${nft.nft_id}, its dirty range is marked again`);
      }
    }
    // a failure from which nothing led to an NFT: the topmost of each such tree (the whole batch is not counted again when its
    // failure was counted at the tick of it)
    for (const node of batch.failed) {
      if (node.leadsToNft || (node.parent && !node.parent.leadsToNft)) continue;
      if (!(batch.counted && node.parent === undefined))
        this.ctx.metrics?.aggregatorErrorsTotal.inc({ job: 'nft_state' });
      this.ctx.logger.warn(
        `Aggregator job nft_state: a batch of ${node.nfts.length} NFT(s) failed as a whole, but its halves were rebuilt: ${describe(node.error)}`,
      );
    }
    return true;
  }

  /** Counts and logs, once, the failure of a batch whose halving goes on at the next tick. */
  private countDeferred(batch: NftBatch): void {
    if (batch.counted || batch.failed.length === 0) return;
    batch.counted = true;
    this.ctx.metrics?.aggregatorErrorsTotal.inc({ job: 'nft_state' });
    this.ctx.logger.error(
      `Aggregator job nft_state: a batch of ${batch.key.split(',').length} NFT(s) failed, halving it to find the NFTs that fail on their own (it goes on at the next tick): ${describe(batch.failed[0].error)}`,
    );
  }

  /** The NFTs that were set aside and whose wait is over, one at a time, under the budget of the job. */
  private async retries(tick: AggregatorTick): Promise<void> {
    const due = [...this.retry.values()].filter((retry) => retry.until <= this.ctx.clock());
    for (const { key } of due) {
      if (!this.ctx.mayStartSet(tick, 'nft_state')) return;
      try {
        await this.rebuild(tick, [key]);
        this.retry.delete(key.nft_id);
        this.ctx.logger.log(`nft_state: NFT ${key.nft_id} is rebuilt again`);
      } catch (err) {
        if (this.ctx.closing()) throw err;
        const delayMs = Math.min((this.retry.get(key.nft_id)?.delayMs ?? NFT_RETRY_MS) * 2, NFT_MAX_RETRY_MS);
        this.retry.set(key.nft_id, { key, until: this.ctx.clock() + delayMs, delayMs });
        this.ctx.failed('nft_state', err, ` for NFT ${key.nft_id}, tried again in ${Math.round(delayMs / 60_000)} min`);
      }
    }
  }

  /**
   * The ranges of `nft_dirty`, the oldest first, a step of `NFT_DIRTY_STEP_LEDGERS` ledgers at a time: the NFTs of the step are
   * rebuilt in batches (a batch that fails is halved like a live one), and then the range is narrowed to what is left of it, or
   * deleted when it is done, so that progress survives a restart. It runs in what the live sweep left of the budget; a step that
   * does not fit in it goes on at the next tick where it stopped. A step that fails keeps the NFTs it has not rebuilt, and the
   * range stays as it was.
   *
   * An NFT of a step that fails on its own is counted, and the range of the step is **marked again** before it is narrowed or
   * deleted: nothing in the tables says the NFT is stale (a re-ingest changed its events behind the cursor, and left no touch
   * above what its row has seen), so a restart could not find it again, as it does the NFTs the live part sets aside. The new
   * mark is the newest, so the step comes round again at the back of the queue, and an NFT that keeps failing keeps it
   * circulating, once a run at most (a range marked again in a run waits for the next one).
   */
  private async dirty(tick: AggregatorTick): Promise<void> {
    for (;;) {
      if (!this.ctx.mayStartSet(tick, 'nft_state')) return;
      let step = this.step;
      if (!step) {
        const range = await this.fns.oldestDirty(this.ctx.ch);
        if (this.ctx.closing() || !range) return;
        if (this.remarked.has(`${range.from}-${range.to}`)) return;
        const to = Math.min(range.to, range.from + NFT_DIRTY_STEP_LEDGERS - 1);
        const nfts = await this.fns.inLedgers(this.ctx.ch, range.from, to);
        if (this.ctx.closing()) return;
        step = { range, to, rest: nfts, taken: 0, markAgain: false };
        this.step = step;
      }
      if (!(await this.rebuildStep(step, tick))) return;
      // nothing is written to `nft_dirty` once the shutdown has begun: the range stays, and is done again
      if (this.ctx.closing()) return;
      if (step.markAgain) {
        await this.fns.markDirty(this.ctx.ch, step.range.from, step.to);
        this.remarked.add(`${step.range.from}-${step.to}`);
      }
      if (step.to >= step.range.to) await this.fns.deleteDirty(this.ctx.ch, step.range);
      else await this.fns.narrowDirty(this.ctx.ch, step.range, step.to + 1);
      this.ctx.logger.debug(`nft_state: ledgers ${step.range.from} - ${step.to} of a dirty range are rebuilt`);
      this.step = undefined;
    }
  }

  /** Rebuilds the NFTs of a dirty step, a batch at a time; false when the budget or the shutdown stopped it. */
  private async rebuildStep(step: DirtyStep, tick: AggregatorTick): Promise<boolean> {
    for (;;) {
      if (!step.batch) {
        if (step.rest.length === 0) return true;
        // the NFTs of a batch leave `rest` once the batch is done; those that wait for a retry make no batch (the retry rebuilds them)
        step.taken = Math.min(NFT_STATE_BATCH, step.rest.length);
        step.batch = this.newBatch('dirty', step.rest.slice(0, step.taken));
        if (!step.batch) {
          step.rest.splice(0, step.taken);
          continue;
        }
      }
      let finished: boolean;
      try {
        finished = await this.runBatch(step.batch, tick, 'dirty');
      } catch (err) {
        // the NFTs of the batch stay in `rest`: the next tick makes the batch again, without redoing the ones before it
        step.batch = undefined;
        throw err;
      }
      if (!finished) return false;
      if (step.batch.suspects.length > 0) step.markAgain = true;
      step.batch = undefined;
      step.rest.splice(0, step.taken);
    }
  }

  /**
   * The ledgers that closed in the slice `[start, end)` of an `agg_dirty` range, marked in `nft_dirty`; it rebuilds nothing (a day
   * of the busiest ledgers of 2022 must not hold a tick), the dirty sweep of the job does, within its budget. Marking a range
   * again is harmless. A slice with no ledger marks nothing. Once the shutdown has begun it does nothing, and the range of
   * `agg_dirty` is left as it is.
   */
  async ofSlice(start: number, end: number, _tick: AggregatorTick): Promise<void> {
    if (this.ctx.closing()) return;
    const ledgers = await this.nfts.rates.ledgersClosedIn(new Date(start * 1000), new Date(end * 1000));
    if (ledgers === null || this.ctx.closing()) return;
    await this.fns.markDirty(this.ctx.ch, ledgers.min, ledgers.max);
  }

  /** Sets the gauges: the lag of the live cursor, and the ledgers the dirty ranges hold. A failure to read them is counted and logged. */
  private async report(): Promise<void> {
    if (this.ctx.closing()) return;
    try {
      this.head = await this.fns.head(this.ctx.ch);
      const metrics = this.ctx.metrics;
      if (!metrics) return;
      const lag = this.lag;
      if (lag !== undefined) metrics.nftStateLagLedgers.set(lag);
      metrics.nftDirtyLedgers.set(await this.fns.dirtyLedgers(this.ctx.ch));
    } catch (err) {
      this.ctx.failed('nft_state', err, ' reading the gauges');
    }
  }
}
