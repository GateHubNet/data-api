import {
  CollectionKey,
  DailyRates,
  NFT_COLLECTIONS_BATCH,
  NftCollectionsRecomputeAborted,
  NftKey,
  RatesService,
} from '@gatehub/data-api-shared';
import { FakeClickHouse, NOW, NOW_SECONDS, QUIET, unix } from '../../test/aggregator-fakes';
import {
  AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AggregatorOptions,
  AggregatorService,
  MAX_ISOLATED_COLLECTIONS_PER_BATCH,
  NFT_COLLECTIONS_EVERY_TICKS,
  NFT_RETRY_MS,
} from './aggregator.service';
import { AggregatorJobContext, AggregatorTick } from './job-context';
import { NftCollectionsFunctions, NftCollectionsJobRunner } from './nft-collections.job-runner';

/**
 * The `nft_collections` job (`NftCollectionsJobRunner`), driven through the `AggregatorService` it runs in (and, for what the
 * service does not show, on its own): the queue and where it is filled from, the batches, the budget, the failures, the gauge
 * and the shutdown. The functions of the shared package are fakes; their collections are `synthetic-…` ones.
 */

describe('AggregatorService nft_collections job', () => {
  const RATES = { nativeCurrency: 'XRP' } as RatesService;
  const DAILY = { nativeCurrency: 'XRP' } as unknown as DailyRates;
  const ISSUER = 'rSyntheticIssuer';

  /** A collection made by hand: the taxon says which it is. */
  const collection = (taxon: number): CollectionKey => ({ issuer: ISSUER, taxon_key: taxon });
  const collections = (from: number, to: number): CollectionKey[] =>
    Array.from({ length: to - from + 1 }, (_, i) => collection(from + i));
  const taxa = (list: readonly CollectionKey[]): number[] => list.map((k) => k.taxon_key);
  const nft = (serial: number): NftKey => ({
    issuer: ISSUER,
    taxon_key: serial,
    serial,
    nft_id: serial.toString(16).toUpperCase().padStart(64, '0'),
  });

  let ch: FakeClickHouse;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
    aggregatorStatsLagSeconds: { set: jest.Mock };
    nftStateLagLedgers: { set: jest.Mock };
    nftDirtyLedgers: { set: jest.Mock };
    nftCollectionsPending: { set: jest.Mock };
  };
  const created: AggregatorService[] = [];
  let behind: jest.Mock;
  let recompute: jest.Mock;
  /** What `collectionsBehind` answers. */
  let behindKeys: CollectionKey[];
  /** How long (fake milliseconds) the recompute of a batch takes. */
  let batchMs: number;
  /** The collections (by taxon) the fake recompute fails on, whatever batch they are in. */
  let failing: Set<number>;
  /** The most collections the fake recompute does at once: a longer list fails (a limit of the database), whatever is in it. */
  let tooLong: number | undefined;
  /** The batches (by taxon) that the fake recompute did write, in order. */
  let done: number[][];
  /** The NFTs the live part of `nft_state` finds at its next read (it takes them), and the collections its rebuild answers. */
  let found: NftKey[];
  let rebuilt: CollectionKey[];

  const jobsRun = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const batches = (): number[][] => recompute.mock.calls.map(([, , keys]) => taxa(keys));
  const errors = (): number => metrics.aggregatorErrorsTotal.inc.mock.calls.length;
  const gauge = (): number[] => metrics.nftCollectionsPending.set.mock.calls.map(([value]) => value);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
      nftStateLagLedgers: { set: jest.fn() },
      nftDirtyLedgers: { set: jest.fn() },
      nftCollectionsPending: { set: jest.fn() },
    };
    behindKeys = [];
    batchMs = 0;
    failing = new Set();
    tooLong = undefined;
    done = [];
    found = [];
    rebuilt = [];
    behind = jest.fn(async () => behindKeys);
    recompute = jest.fn(async (_ch: unknown, _rates: unknown, keys: CollectionKey[]) => {
      if (batchMs > 0) jest.setSystemTime(Date.now() + batchMs);
      if (tooLong !== undefined && keys.length > tooLong) {
        throw new Error(`DB::Exception: memory limit for ${keys.length} collection(s)`);
      }
      const bad = keys.filter((k) => failing.has(k.taxon_key));
      if (bad.length > 0) throw new Error(`DB::Exception: memory limit on collection ${bad[0].taxon_key}`);
      done.push(taxa(keys));
      return { written: keys.length, removed: 0 };
    });
    // the stats are up to date: the live window is the last slice only
    ch.watermark = unix('2026-10-16T12:00:00Z');
    ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
  });

  afterEach(async () => {
    const stops = created.splice(0).map((svc) => svc.stop());
    await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS);
    await Promise.all(stops);
    jest.useRealTimers();
  });

  /** The functions of `nft_state`: quiet, but for the NFTs of `found`, whose rebuild answers the collections of `rebuilt`. */
  const stateFunctions = (): AggregatorOptions['nftStateFunctions'] => ({
    watermark: async () => 500,
    changedSince: async (_c, ledger) => ({ nfts: found.splice(0), upTo: ledger + 1 }),
    inLedgers: async () => [],
    rebuild: async (_c, nfts) => ({ written: nfts.length, removed: 0, collections: rebuilt }),
    oldestDirty: async () => undefined,
    dirtyLedgers: async () => 0,
    head: async () => 0,
  });

  function service(options: AggregatorOptions = {}): AggregatorService {
    const svc = new AggregatorService(ch.asService(), metrics as never, { register: jest.fn() } as never, {
      logger,
      recompute: async () => 1,
      nfts: { rates: RATES, dailyRates: DAILY },
      nftStateFunctions: stateFunctions(),
      nftCollectionsFunctions: { behind, recompute } as Partial<NftCollectionsFunctions>,
      ...options,
    });
    created.push(svc);
    return svc;
  }

  /** The next tick, `n` ticks (of a minute each) after the first one at `NOW`. */
  const tickNo = async (svc: AggregatorService, n: number): Promise<void> => {
    jest.setSystemTime(NOW_SECONDS * 1000 + n * 60_000);
    await svc.tick();
  };
  /** Runs ticks `from` to `to`, both included. */
  const ticksUpTo = async (svc: AggregatorService, from: number, to: number): Promise<void> => {
    for (let n = from; n <= to; n++) await tickNo(svc, n);
  };

  /** A run of the job (every fifth tick) at the instant `ms`: the ticks before it, which skip the job, are at that instant too. */
  const runAt = async (svc: AggregatorService, ms: number): Promise<void> => {
    jest.setSystemTime(ms);
    for (let i = 0; i < NFT_COLLECTIONS_EVERY_TICKS; i++) await svc.tick();
  };

  /** The tick a runner on its own is given: the budget of 3 s. */
  const tick = (): AggregatorTick => ({ now: NOW, deadline: Date.now() + 3000, signal: new AbortController().signal });

  /** A runner over a hand-made context: the clock is the fake one, the budget is the deadline of the tick. */
  function runner(): { job: NftCollectionsJobRunner; stop: () => void } {
    let closing = false;
    const ctx: AggregatorJobContext = {
      ch: ch.asService(),
      logger,
      metrics: metrics as never,
      budgets: { nft_collections: 3000 } as AggregatorJobContext['budgets'],
      clock: () => Date.now(),
      closing: () => closing,
      mayStartSet: (t) => !closing && Date.now() < t.deadline,
      failed: (job, err, where = '') => {
        metrics.aggregatorErrorsTotal.inc({ job });
        logger.error(`Aggregator job ${job} failed${where}: ${String(err)}`);
      },
      versionsOf: async () => new Map(),
      latestCloseTime: async () => undefined,
      announceBackfill: () => undefined,
    };
    const functions = { behind, recompute } as unknown as NftCollectionsFunctions;
    return {
      job: new NftCollectionsJobRunner(ctx, { rates: RATES, dailyRates: DAILY }, functions),
      stop: () => {
        closing = true;
      },
    };
  }

  describe('the job in the tick', () => {
    it('comes after nft_state and the stats, at the first tick and then every fifth, with a budget of 3 s of its own', async () => {
      expect(AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS).toBe(3000);
      expect(NFT_COLLECTIONS_EVERY_TICKS).toBe(5);
      expect(NFT_COLLECTIONS_BATCH).toBe(50);
      const svc = service();
      await tickNo(svc, 0);
      expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections']);

      metrics.aggregatorRunsTotal.inc.mockClear();
      await ticksUpTo(svc, 1, 4);
      expect(jobsRun().filter((job) => job === 'nft_collections')).toEqual([]);
      await tickNo(svc, 5);
      expect(jobsRun().filter((job) => job === 'nft_collections')).toEqual(['nft_collections']);
      await ticksUpTo(svc, 6, 10);
      // the fifth tick and the tenth
      expect(jobsRun().filter((job) => job === 'nft_collections')).toHaveLength(2);
    });

    it('is off without the nfts option: nothing is asked of its functions, and nothing is set', async () => {
      await service({ nfts: undefined }).tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      expect(behind).not.toHaveBeenCalled();
      expect(recompute).not.toHaveBeenCalled();
      expect(metrics.nftCollectionsPending.set).not.toHaveBeenCalled();
    });

    it('is given the budget budgetsMs sets for it', async () => {
      behindKeys = collections(0, 149);
      batchMs = 600;
      await service({ budgetsMs: { nft_collections: 1000 } }).tick();
      // batches start at 0 and 600 ms; the third would start at 1200 ms, past the budget
      expect(done).toHaveLength(2);
    });

    it('hands the daily rates, and the signal of the tick, to every recompute', async () => {
      behindKeys = collections(0, 2);
      await service().tick();
      expect(recompute).toHaveBeenCalledTimes(1);
      const [db, rates, keys, options] = recompute.mock.calls[0];
      expect(db).toBe(ch);
      expect(rates).toBe(DAILY);
      expect(taxa(keys)).toEqual([0, 1, 2]);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);
    });
  });

  describe('the queue', () => {
    it('fills its queue from collectionsBehind at the first run', async () => {
      behindKeys = collections(1, 3);
      const svc = service();
      await tickNo(svc, 0);
      expect(behind).toHaveBeenCalledTimes(1);
      expect(behind).toHaveBeenCalledWith(ch);
      expect(batches()).toEqual([[1, 2, 3]]);

      // a later run asks for nothing: only what nft_state queues since is computed
      await ticksUpTo(svc, 1, 5);
      expect(behind).toHaveBeenCalledTimes(1);
      expect(batches()).toEqual([[1, 2, 3]]);
    });

    it('takes the collections nft_state rebuilt first, oldest first, and then the ones that are behind', async () => {
      found = [nft(1)];
      rebuilt = [collection(9), collection(8)];
      behindKeys = [collection(1), collection(8), collection(2)];
      await service().tick();
      // nft_state ran before the job did: its collections were queued first, and the one both name is queued once
      expect(batches()).toEqual([[9, 8, 1, 2]]);
    });

    it('queues the collections of the rebuilds of the ticks after the first too, and computes them at the next run of the job', async () => {
      const svc = service();
      await tickNo(svc, 0);
      expect(batches()).toEqual([]);

      // nft_state rebuilds an NFT at the second tick; its collection waits for the fifth
      found = [nft(2)];
      rebuilt = [collection(4)];
      await ticksUpTo(svc, 1, 4);
      expect(batches()).toEqual([]);
      await tickNo(svc, 5);
      expect(batches()).toEqual([[4]]);
      expect(gauge()).toEqual([0, 0]);
    });

    it('takes 50 keys at a time, oldest first, while the budget lasts', async () => {
      behindKeys = collections(0, 159);
      batchMs = 1500;
      const svc = service();
      await tickNo(svc, 0);
      // batches start at 0 and 1500 ms; the third would start at 3000 ms, the end of the budget of 3 s
      expect(done).toEqual([taxa(collections(0, 49)), taxa(collections(50, 99))]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nft_collections reached its budget'));
      expect(gauge()).toEqual([60]);

      // the next run goes on where this one stopped, the last batch short
      await ticksUpTo(svc, 1, 5);
      expect(done).toEqual([
        taxa(collections(0, 49)),
        taxa(collections(50, 99)),
        taxa(collections(100, 149)),
        taxa(collections(150, 159)),
      ]);
      expect(gauge()).toEqual([60, 0]);
      expect(errors()).toBe(0);
    });

    it('stops at the end of the queue, and a run with nothing queued does nothing', async () => {
      const svc = service();
      await tickNo(svc, 0);
      await ticksUpTo(svc, 1, 5);
      expect(recompute).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('enqueues each key once', () => {
      const { job } = runner();
      expect(job.pending).toBe(0);
      job.enqueue([collection(1), collection(2)]);
      job.enqueue([collection(2), collection(3), collection(1)]);
      job.enqueue([collection(3), collection(3)]);
      expect(job.pending).toBe(3);
      // the same taxon under another issuer is another collection
      job.enqueue([{ issuer: 'rSyntheticOther', taxon_key: 1 }]);
      expect(job.pending).toBe(4);
    });

    it('computes a key that was queued twice once, in the place it was first queued in', async () => {
      found = [nft(1)];
      rebuilt = [collection(5), collection(5), collection(6)];
      behindKeys = [collection(6), collection(5), collection(7)];
      await service().tick();
      expect(batches()).toEqual([[5, 6, 7]]);
    });

    it('sets syncer_nft_collections_pending', async () => {
      behindKeys = collections(0, 119);
      batchMs = 1500;
      const svc = service();
      await tickNo(svc, 0);
      // the budget of 3 s took two batches of the 120 collections (50 + 50): 20 are left
      expect(gauge()).toEqual([20]);
      await ticksUpTo(svc, 1, 4);
      // (a gauge is set when the job runs, not at the ticks it skips)
      expect(gauge()).toEqual([20]);
      await tickNo(svc, 5);
      expect(gauge()).toEqual([20, 0]);
    });

    it('does not need the gauge: without metrics nothing is set and nothing fails', async () => {
      behindKeys = collections(0, 2);
      const svc = new AggregatorService(ch.asService(), undefined, undefined, {
        logger,
        recompute: async () => 1,
        nfts: { rates: RATES, dailyRates: DAILY },
        nftStateFunctions: stateFunctions(),
        nftCollectionsFunctions: { behind, recompute } as Partial<NftCollectionsFunctions>,
      });
      created.push(svc);
      await svc.tick();
      expect(batches()).toEqual([[0, 1, 2]]);
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('a failing collection', () => {
    /** The calls of the fake recompute with the collection of this taxon alone. */
    const alone = (taxon: number): number => batches().filter((b) => b.length === 1 && b[0] === taxon).length;

    it('is found by halving its batch and set aside, and the others of the batch are computed: [P, A, B] with P always failing still computes A and B', async () => {
      behindKeys = collections(0, 2);
      failing.add(0);
      const svc = service();
      await tickNo(svc, 0);

      // [P, A, B] fails, its halves [P, A] and [B], and then P and A alone
      expect(batches()).toEqual([[0, 1, 2], [0, 1], [0], [1], [2]]);
      expect(done).toEqual([[1], [2]]);
      // P is counted and logged once, as the collection that fails, and the run did not fail
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_collections' }]]);
      expect(logger.error).toHaveBeenCalledWith(
        `Aggregator job nft_collections failed for collection ${ISSUER}/0, set aside to be tried again: DB::Exception: memory limit on collection 0`,
      );
      expect(logger.warn).not.toHaveBeenCalled();
      expect(jobsRun()).toContain('nft_collections');
      // P still waits to be computed
      expect(gauge()).toEqual([1]);
    });

    it('goes on with the rest of the queue in the same run', async () => {
      behindKeys = collections(0, 119);
      failing.add(0);
      await tickNo(service(), 0);
      expect(done.flat().sort((a, b) => a - b)).toEqual(taxa(collections(1, 119)));
      expect(errors()).toBe(1);
      expect(gauge()).toEqual([1]);
    });

    it('is tried again after 5 minutes, then after twice as long each time up to an hour, and forgotten once it works', async () => {
      behindKeys = collections(0, 2);
      failing.add(0);
      const svc = service();
      await tickNo(svc, 0);
      expect(alone(0)).toBe(1);
      expect(errors()).toBe(1);

      let calls = 1;
      let failedAt = Date.now();
      for (const waitMinutes of [5, 10, 20, 40, 60, 60]) {
        // not a minute before the wait is over ...
        await runAt(svc, failedAt + waitMinutes * 60_000 - 60_000);
        expect(alone(0)).toBe(calls);
        // ... and at the end of it P is computed again, fails again: counted, and the wait doubles (at most an hour)
        await runAt(svc, failedAt + waitMinutes * 60_000);
        expect(alone(0)).toBe(++calls);
        expect(errors()).toBe(calls);
        expect(logger.error).toHaveBeenLastCalledWith(
          `Aggregator job nft_collections failed for collection ${ISSUER}/0, tried again in ${Math.min(waitMinutes * 2, 60)} min: DB::Exception: memory limit on collection 0`,
        );
        failedAt = Date.now();
      }
      // it works at last: it is computed, forgotten, and not asked for again
      failing.clear();
      await runAt(svc, failedAt + 60 * 60_000);
      expect(done).toEqual([[1], [2], [0]]);
      expect(logger.log).toHaveBeenCalledWith(`nft_collections: collection ${ISSUER}/0 is computed again`);
      expect(gauge().at(-1)).toBe(0);
      await runAt(svc, failedAt + 120 * 60_000);
      expect(alone(0)).toBe(calls + 1);
      expect(errors()).toBe(calls);
    });

    it('is not queued again while it is set aside: its retry computes it', async () => {
      const { job } = runner();
      behindKeys = collections(0, 1);
      failing.add(0);
      await job.run(tick());
      expect(job.pending).toBe(1);
      job.enqueue([collection(0), collection(5)]);
      expect(job.pending).toBe(2);
      failing.clear();
      await job.run(tick());
      // 5 was computed, 0 waits for its retry
      expect(done).toEqual([[1], [5]]);
      expect(job.pending).toBe(1);
      jest.setSystemTime(Date.now() + NFT_RETRY_MS);
      await job.run(tick());
      expect(done).toEqual([[1], [5], [0]]);
      expect(job.pending).toBe(0);
    });

    it('a batch that fails as a whole beyond the cap fails the job but keeps its keys', async () => {
      expect(MAX_ISOLATED_COLLECTIONS_PER_BATCH).toBe(3);
      behindKeys = collections(0, 9);
      for (const taxon of [0, 1, 2, 3]) failing.add(taxon);
      const svc = service();
      await tickNo(svc, 0);

      // four collections of the batch fail alone: the cause is not the collections, so the batch is the failure of the job
      expect(done).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_collections' }]]);
      expect(logger.error).toHaveBeenCalledWith(
        'Aggregator job nft_collections failed: DB::Exception: memory limit on collection 0',
      );
      expect(jobsRun()).not.toContain('nft_collections');
      // none of them is set aside, and none is lost: all ten wait
      expect(gauge()).toEqual([10]);

      // the next run does them again, in order, in one batch
      failing.clear();
      await runAt(svc, NOW_SECONDS * 1000 + 5 * 60_000);
      expect(done).toEqual([taxa(collections(0, 9))]);
      expect(gauge()).toEqual([10, 0]);
      expect(errors()).toBe(1);
    });

    it('a batch in which everything fails (the database) is the failure of the job, not a reason to set its collections aside: they are, if they fail alone again next time', async () => {
      behindKeys = collections(0, 1);
      failing.add(0).add(1);
      const svc = service();
      await tickNo(svc, 0);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_collections' }]]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Aggregator job nft_collections failed: '));
      expect(jobsRun()).not.toContain('nft_collections');
      expect(gauge()).toEqual([2]);

      // the same batch, and the same collections failing alone again: now they are the ones
      await runAt(svc, NOW_SECONDS * 1000 + 5 * 60_000);
      expect(batches().slice(3)).toEqual([[0, 1], [0], [1]]);
      expect(errors()).toBe(3);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('for collection rSyntheticIssuer/1, set aside'),
      );
      expect(jobsRun()).toContain('nft_collections');
      expect(gauge()).toEqual([2, 2]);
    });

    it('when the database comes back the next run does the batch, and nothing waits for a retry', async () => {
      behindKeys = collections(0, 1);
      failing.add(0).add(1);
      const svc = service();
      await tickNo(svc, 0);
      failing.clear();
      await runAt(svc, NOW_SECONDS * 1000 + 5 * 60_000);
      expect(done).toEqual([[0, 1]]);
      expect(errors()).toBe(1);
      expect(gauge()).toEqual([2, 0]);
    });

    it('a list that fails as a whole although each half works is warned about and counted once', async () => {
      behindKeys = collections(0, 5);
      tooLong = 3;
      await tickNo(service(), 0);
      expect(batches()).toEqual([
        [0, 1, 2, 3, 4, 5],
        [0, 1, 2],
        [3, 4, 5],
      ]);
      expect(done).toEqual([
        [0, 1, 2],
        [3, 4, 5],
      ]);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_collections' }]]);
      expect(logger.warn).toHaveBeenCalledWith(
        'Aggregator job nft_collections: a batch of 6 collection(s) failed as a whole, but its halves were computed: DB::Exception: memory limit for 6 collection(s)',
      );
      // nothing is set aside
      expect(gauge()).toEqual([0]);
    });

    it('a halving that does not fit in the budget goes back to the front of the queue, is counted, and starts again at the next run', async () => {
      behindKeys = collections(0, 59);
      failing.add(0);
      batchMs = 600;
      const svc = service({ budgetsMs: { nft_collections: 1000 } });
      await tickNo(svc, 0);
      // [0..49] fails at 0 ms, its half [0..24] at 600 ms, and the third try would start at 1200 ms
      expect(batches()).toEqual([taxa(collections(0, 49)), taxa(collections(0, 24))]);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_collections' }]]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('a batch is being halved to find the collections that fail on their own'),
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nft_collections reached its budget'));
      // nothing was set aside or lost, and the batch is still at the head of the queue, before 50 to 59
      expect(gauge()).toEqual([60]);

      batchMs = 0;
      await runAt(svc, NOW_SECONDS * 1000 + 5 * 60_000);
      expect(batches()[2]).toEqual(taxa(collections(0, 49)));
      expect(done.flat().sort((a, b) => a - b)).toEqual(taxa(collections(1, 59)));
      expect(gauge()).toEqual([60, 1]);
    });
  });

  describe('the read of the collections that are behind', () => {
    /** The reads of `collectionsBehind` that are out, which the test answers when it says. */
    function pendingReads(): Array<{ resolve: (keys: CollectionKey[]) => void; reject: (error: Error) => void }> {
      const reads: Array<{ resolve: (keys: CollectionKey[]) => void; reject: (error: Error) => void }> = [];
      behind.mockImplementation(
        () => new Promise<CollectionKey[]>((resolve, reject) => reads.push({ resolve, reject })),
      );
      return reads;
    }
    /** Lets what a settled promise woke up run. */
    const flush = (): Promise<void> => jest.advanceTimersByTimeAsync(0);
    const timeout = new Error('DB::Exception: Timeout exceeded: elapsed 30.001 seconds');

    it('does not hold the tick: the jobs after it run, and the queue is worked while the read is out', async () => {
      const reads = pendingReads();
      found = [nft(1)];
      rebuilt = [collection(9)];
      const after = jest.fn(async () => undefined);
      const svc = service({ extraJobs: [{ name: 'after_nft_collections', run: after }] });
      await svc.tick();

      // the read is out, and nothing waited for it: the collection nft_state rebuilt was computed, the jobs after went on
      expect(behind).toHaveBeenCalledTimes(1);
      expect(batches()).toEqual([[9]]);
      expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections', 'after_nft_collections']);
      expect(after).toHaveBeenCalledTimes(1);
      expect(errors()).toBe(0);

      // and it is not started again while it is out
      await ticksUpTo(svc, 1, 10);
      expect(behind).toHaveBeenCalledTimes(1);
      expect(reads).toHaveLength(1);
    });

    it('is queued when it answers, and computed at the next run', async () => {
      const reads = pendingReads();
      const svc = service();
      await tickNo(svc, 0);
      expect(recompute).not.toHaveBeenCalled();

      reads[0].resolve(collections(1, 2));
      await flush();
      await ticksUpTo(svc, 1, 5);
      expect(batches()).toEqual([[1, 2]]);
      expect(behind).toHaveBeenCalledTimes(1);
      expect(gauge()).toEqual([0, 0]);
    });

    it('that fails once the tick is over is counted and logged as nft_collections, and is read again only after 5 minutes, then after twice as long up to an hour', async () => {
      const reads = pendingReads();
      const svc = service();
      await tickNo(svc, 0);
      expect(errors()).toBe(0);

      // the query ran out of its 30 s while the tick went on
      jest.setSystemTime(Date.now() + 30_000);
      reads[0].reject(timeout);
      await flush();
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_collections' }]]);
      expect(logger.error).toHaveBeenCalledWith(
        `Aggregator job nft_collections failed reading the collections that are behind, tried again in 5 min: ${timeout.message}`,
      );

      let calls = 1;
      for (const waitMinutes of [5, 10, 20, 40, 60, 60]) {
        const failedAt = Date.now();
        // not a second before the wait is over ...
        await runAt(svc, failedAt + waitMinutes * 60_000 - 1000);
        expect(behind).toHaveBeenCalledTimes(calls);
        // ... and at the end of it a new read starts, which fails again: counted, and the wait doubles (at most an hour)
        await runAt(svc, failedAt + waitMinutes * 60_000);
        expect(behind).toHaveBeenCalledTimes(++calls);
        reads[calls - 1].reject(timeout);
        await flush();
        expect(errors()).toBe(calls);
        expect(logger.error).toHaveBeenLastCalledWith(
          `Aggregator job nft_collections failed reading the collections that are behind, tried again in ${Math.min(waitMinutes * 2, 60)} min: ${timeout.message}`,
        );
      }
      // the job itself did not fail: a failed read is not the error of its run
      expect(jobsRun().filter((job) => job === 'nft_collections').length).toBeGreaterThan(0);
    });

    it('that answers after a failure is queued, and not read again', async () => {
      behind.mockRejectedValueOnce(timeout);
      behindKeys = collections(1, 2);
      const svc = service();
      await tickNo(svc, 0);
      expect(errors()).toBe(1);
      expect(recompute).not.toHaveBeenCalled();

      await runAt(svc, NOW_SECONDS * 1000 + 5 * 60_000);
      expect(behind).toHaveBeenCalledTimes(2);
      expect(batches()).toEqual([[1, 2]]);
      await runAt(svc, NOW_SECONDS * 1000 + 15 * 60_000);
      expect(behind).toHaveBeenCalledTimes(2);
      expect(errors()).toBe(1);
    });

    it('that fails once the shutdown has begun is dropped: no error, and no unhandled rejection', async () => {
      const reads = pendingReads();
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const svc = service();
        await svc.tick();
        void svc.stop();
        reads[0].reject(timeout);
        await flush();
        // the process gets to report an unhandled rejection after the microtasks, on a real turn of the event loop
        await new Promise((resolve) => jest.requireActual('timers').setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('that answers once the shutdown has begun is dropped: nothing is queued', async () => {
      const reads = pendingReads();
      const { job, stop } = runner();
      await job.run(tick());
      stop();
      reads[0].resolve(collections(1, 3));
      await flush();
      expect(job.pending).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('starts nothing once it has begun: no read, no recompute', async () => {
      behindKeys = collections(0, 2);
      const svc = service();
      await svc.stop();
      await svc.tick();
      expect(behind).not.toHaveBeenCalled();
      expect(recompute).not.toHaveBeenCalled();
    });

    it('hands the signal of the shutdown to the batch in flight and starts no batch after it', async () => {
      behindKeys = collections(0, 119);
      let signalOfBatch: AbortSignal | undefined;
      let release!: () => void;
      recompute.mockImplementationOnce(
        (_c: unknown, _r: unknown, keys: CollectionKey[], options?: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            signalOfBatch = options?.signal;
            release = () => resolve({ written: keys.length, removed: 0 });
          }),
      );
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(signalOfBatch?.aborted).toBe(false);

      const stopping = svc.stop();
      expect(signalOfBatch?.aborted).toBe(true);
      release();
      await stopping;
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('a batch that was aborted at shutdown is neither an error nor counted', async () => {
      behindKeys = collections(0, 2);
      const svc = service();
      recompute.mockImplementation(async () => {
        void svc.stop();
        throw new NftCollectionsRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      behindKeys = collections(0, 2);
      const svc = service();
      recompute.mockImplementation(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_collections' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });

    it('a batch that was aborted at shutdown keeps its collections in the queue', async () => {
      const { job, stop } = runner();
      behindKeys = collections(0, 2);
      recompute.mockImplementation(async () => {
        stop();
        throw new NftCollectionsRecomputeAborted();
      });
      await expect(job.run(tick())).rejects.toThrow(NftCollectionsRecomputeAborted);
      expect(job.pending).toBe(3);
    });

    it('starts no batch after the shutdown began, in the middle of a run', async () => {
      behindKeys = collections(0, 119);
      const svc = service();
      recompute.mockImplementationOnce(async (_c: unknown, _r: unknown, keys: CollectionKey[]) => {
        void svc.stop();
        return { written: keys.length, removed: 0 };
      });
      await svc.tick();
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(errors()).toBe(0);
    });
  });
});
