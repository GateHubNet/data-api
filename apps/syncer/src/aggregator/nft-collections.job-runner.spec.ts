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
  NFT_COLLECTIONS_EVERY_TICKS,
} from './aggregator.service';
import { AggregatorJobContext } from './job-context';
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
    done = [];
    found = [];
    rebuilt = [];
    behind = jest.fn(async () => behindKeys);
    recompute = jest.fn(async (_ch: unknown, _rates: unknown, keys: CollectionKey[]) => {
      if (batchMs > 0) jest.setSystemTime(Date.now() + batchMs);
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
      const job = new NftCollectionsJobRunner(
        { ch: ch.asService(), logger, budgets: { nft_collections: 3000 } } as unknown as AggregatorJobContext,
        { rates: RATES, dailyRates: DAILY },
        { behind, recompute } as unknown as NftCollectionsFunctions,
      );
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

  describe('a failing batch', () => {
    it('puts a failed batch back at the end', async () => {
      behindKeys = collections(0, 119);
      failing.add(0);
      const svc = service();
      await tickNo(svc, 0);
      // the first batch failed: the batches after it were not started, the run threw, and the tick counted it once
      expect(batches()).toEqual([taxa(collections(0, 49))]);
      expect(done).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_collections' }]]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Aggregator job nft_collections failed'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit on collection 0'));
      expect(jobsRun()).not.toContain('nft_collections');
      // and the gauge says all of them are still due
      expect(gauge()).toEqual([120]);

      // the next run takes the batches that were waiting first, and the failed one last: 50, 50 (20 of them and 30 of the failed), 20
      failing.clear();
      await ticksUpTo(svc, 1, 5);
      expect(done).toEqual([
        taxa(collections(50, 99)),
        [...taxa(collections(100, 119)), ...taxa(collections(0, 29))],
        taxa(collections(30, 49)),
      ]);
      expect(gauge()).toEqual([120, 0]);
      expect(jobsRun()).toContain('nft_collections');
    });

    it('a read of collectionsBehind that fails is the error of the run, and is made again at the next run', async () => {
      behind.mockRejectedValueOnce(new Error('DB::Exception: timeout reading nfts'));
      behindKeys = collections(1, 2);
      const svc = service();
      await tickNo(svc, 0);
      expect(recompute).not.toHaveBeenCalled();
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_collections' }]]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('timeout reading nfts'));
      expect(gauge()).toEqual([0]);

      await ticksUpTo(svc, 1, 5);
      expect(behind).toHaveBeenCalledTimes(2);
      expect(batches()).toEqual([[1, 2]]);
      expect(errors()).toBe(1);
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
