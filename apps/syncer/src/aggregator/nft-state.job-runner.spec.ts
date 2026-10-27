import {
  CollectionKey,
  DailyRates,
  MarketsConfig,
  NFT_DIRTY_STEP_LEDGERS,
  NFT_LIVE_STEP_LEDGERS,
  NFT_STATE_BATCH,
  NftDirtyRange,
  NftKey,
  NftRebuildAborted,
  RatesService,
} from '@gatehub/data-api-shared';
import { FakeClickHouse, iso, NOW, NOW_SECONDS, QUIET, unix } from '../../test/aggregator-fakes';
import {
  AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS,
  AGGREGATOR_NFT_STATE_BUDGET_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AggregatorOptions,
  AggregatorService,
  NFT_COLLECTIONS_EVERY_TICKS,
} from './aggregator.service';
import { AggregatorJobContext } from './job-context';
import {
  MAX_ISOLATED_NFTS_PER_BATCH,
  NFT_MAX_RETRY_MS,
  NFT_RETRY_MS,
  NftStateFunctions,
  NftStateJobRunner,
} from './nft-state.job-runner';

/**
 * The `nft_state` job (`NftStateJobRunner`), driven through the `AggregatorService` it runs in (and, for what the service does
 * not show, on its own): the cursor, the halving of a failing batch, the retries, the dirty ranges, the budget, the hook of
 * `agg_dirty`, the gauges and the shutdown. The functions of the shared package are fakes; their keys are `synthetic-…` NFTs.
 */

describe('AggregatorService nft_state job', () => {
  const RATES = { nativeCurrency: 'XRP' } as RatesService;
  const MARKETS: MarketsConfig = { version: 4, tradeMarkets: [], paymentCurrencies: [] };
  /** The ledger the persistent watermark of the job is at when the process starts. */
  const START_LEDGER = 500;
  const ISSUER = 'rSyntheticIssuer';

  /** A key of an NFT made by hand: the serial says which it is, and the taxon puts it in one of three collections. */
  const nft = (serial: number): NftKey => ({
    issuer: ISSUER,
    taxon_key: serial % 3,
    serial,
    nft_id: serial.toString(16).toUpperCase().padStart(64, '0'),
  });
  const serials = (list: NftKey[]): number[] => list.map((k) => k.serial);
  const collectionsOf = (list: NftKey[]): CollectionKey[] => [
    ...new Map(list.map((k) => [k.taxon_key, { issuer: k.issuer, taxon_key: k.taxon_key }])).values(),
  ];

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
  /** What happened, in order. */
  let events: string[];
  let statsRecompute: jest.Mock;
  let watermark: jest.Mock;
  let changedSince: jest.Mock;
  let inLedgers: jest.Mock;
  let rebuild: jest.Mock;
  let markDirty: jest.Mock;
  let oldestDirty: jest.Mock;
  let narrowDirty: jest.Mock;
  let deleteDirty: jest.Mock;
  let dirtyLedgers: jest.Mock;
  let head: jest.Mock;
  let ledgersClosedIn: jest.Mock;
  /** What `nftsChangedSince` answers for the ledger it is asked from (nothing, and the same ledger, for any other). */
  let pages: Map<number, { nfts: NftKey[]; upTo: number }>;
  /** The newest committed ledger. */
  let committed: number;
  /** The `nft_dirty` table: the newest mark of each range. */
  let dirty: NftDirtyRange[];
  /** The NFTs with a touch in a ledger, for `nftsInLedgers`. */
  let touched: Map<number, NftKey[]>;
  /** The ledgers (min, max) that closed in the slice that starts at an instant (ISO), for the agg_dirty hook. */
  let sliceLedgers: Map<string, { min: number; max: number }>;
  /** How long (fake milliseconds) the rebuild of a list of NFTs takes. */
  let rebuildMs: number;
  /**
   * The least a rebuild takes: the fake clock moves on at every call, so that a loop that does not progress runs out of its
   * budget and fails an assertion instead of hanging the suite. The tests that count on exact times set it to 0.
   */
  let minMs: number;
  /** The NFTs the fake rebuild fails on, whatever list they are in. */
  let failing: Set<number>;
  /** The NFTs of the lists that the fake rebuild did write, in order. */
  let done: number[];

  const mark = (from: number, to: number, createdMs = 1000): NftDirtyRange => ({ from, to, created: createdMs });
  const aggMark = (from: string, to: string, createdMs = 1000) => ({
    from: unix(from),
    to: unix(to),
    created: createdMs,
  });
  const jobsRun = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const rebuilt = (): number[][] => rebuild.mock.calls.map(([, nfts]) => serials(nfts));
  const errors = (): number => metrics.aggregatorErrorsTotal.inc.mock.calls.length;
  const lastLag = (): number | undefined => metrics.nftStateLagLedgers.set.mock.calls.at(-1)?.[0];
  /** A tick `minutes` after the first one. */
  const tickAt = async (svc: AggregatorService, minutes: number): Promise<void> => {
    jest.setSystemTime(NOW_SECONDS * 1000 + minutes * 60_000);
    await svc.tick();
  };

  const sameKey = (a: NftDirtyRange, b: NftDirtyRange): boolean => a.from === b.from && a.to === b.to;
  /** The dirty ranges in the order they are worked on: the oldest mark first. */
  const queue = (): NftDirtyRange[] => [...dirty].sort((a, b) => a.created - b.created || a.from - b.from);

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
    events = [];
    pages = new Map();
    committed = 1000;
    dirty = [];
    touched = new Map();
    sliceLedgers = new Map();
    rebuildMs = 0;
    minMs = 1;
    failing = new Set();
    done = [];
    statsRecompute = jest.fn(async (_ch: unknown, from: Date) => {
      events.push(`stats ${iso(from.getTime() / 1000)}`);
      return 1;
    });
    watermark = jest.fn(async () => START_LEDGER);
    changedSince = jest.fn(async (_ch: unknown, ledger: number) => {
      events.push(`changed ${ledger}`);
      return pages.get(ledger) ?? { nfts: [], upTo: ledger };
    });
    inLedgers = jest.fn(async (_ch: unknown, from: number, to: number) => {
      events.push(`in ${from}-${to}`);
      const found = new Map<string, NftKey>();
      for (const [ledger, list] of touched) {
        if (ledger >= from && ledger <= to) for (const k of list) found.set(k.nft_id, k);
      }
      return [...found.values()].sort((a, b) => a.serial - b.serial);
    });
    rebuild = jest.fn(async (_ch: unknown, nfts: NftKey[]) => {
      events.push(`rebuild ${serials(nfts).join(',')}`);
      jest.setSystemTime(Date.now() + Math.max(rebuildMs, minMs));
      const bad = nfts.filter((k) => failing.has(k.serial));
      if (bad.length > 0) throw new Error(`DB::Exception: memory limit on NFT ${bad[0].serial}`);
      done.push(...serials(nfts));
      return { written: nfts.length, removed: 0, collections: collectionsOf(nfts) };
    });
    markDirty = jest.fn(async (_ch: unknown, from: number, to: number) => {
      events.push(`mark ${from}-${to}`);
      const row = mark(from, to, Date.now());
      dirty = [...dirty.filter((r) => !sameKey(r, row)), row];
    });
    oldestDirty = jest.fn(async () => queue()[0]);
    deleteDirty = jest.fn(async (_ch: unknown, range: NftDirtyRange) => {
      events.push(`delete ${range.from}-${range.to}`);
      dirty = dirty.filter((r) => !(sameKey(r, range) && r.created <= range.created));
    });
    narrowDirty = jest.fn(async (_ch: unknown, range: NftDirtyRange, from: number) => {
      events.push(`narrow ${from}-${range.to}`);
      if (from > range.to) return deleteDirty(_ch, range);
      dirty = [
        ...dirty.filter((r) => !(sameKey(r, range) && r.created <= range.created)),
        mark(from, range.to, range.created),
      ];
    });
    dirtyLedgers = jest.fn(async () => dirty.reduce((sum, r) => sum + r.to - r.from + 1, 0));
    head = jest.fn(async () => committed);
    ledgersClosedIn = jest.fn(async (from: Date) => sliceLedgers.get(iso(from.getTime() / 1000)) ?? null);
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

  const functions = (): NftStateFunctions => ({
    watermark,
    changedSince,
    inLedgers,
    rebuild,
    markDirty,
    oldestDirty,
    narrowDirty,
    deleteDirty,
    dirtyLedgers,
    head,
  });

  function service(options: AggregatorOptions = {}): AggregatorService {
    const svc = new AggregatorService(ch.asService(), metrics as never, { register: jest.fn() } as never, {
      logger,
      recompute: statsRecompute,
      nfts: { rates: { ...RATES, ledgersClosedIn } as unknown as RatesService, dailyRates: {} as DailyRates },
      nftStateFunctions: functions(),
      // the collections job has its own spec: here it finds nothing to do
      nftCollectionsFunctions: { behind: async () => [], recompute: async () => ({ written: 0, removed: 0 }) },
      ...options,
    });
    created.push(svc);
    return svc;
  }

  describe('the job in the tick', () => {
    it('comes after amm_pools and before stats_live, with the volume jobs and without them', async () => {
      const volumeFunctions = {
        computeLiveSet: jest.fn(async () => 0),
        computeDailySet: jest.fn(async () => 0),
        daysDone: jest.fn(async () => new Set<string>()),
        liveVersions: jest.fn(async () => new Map<string, number>()),
        dailyVersions: jest.fn(async () => new Map<string, number>()),
      };
      const ammPoolsFunctions = {
        watermark: jest.fn(async () => 0),
        changedSince: jest.fn(async (_c: unknown, ledger: number) => ({ accounts: [], upTo: ledger })),
        poolsClosedIn: jest.fn(async () => []),
        recompute: jest.fn(async () => 0),
      };
      await service({
        volumes: { rates: RATES, markets: MARKETS },
        volumeFunctions,
        ammPools: { rates: RATES },
        ammPoolsFunctions,
      }).tick();
      expect(jobsRun()).toEqual([
        'volume_live',
        'volume_daily',
        'amm_pools',
        'nft_state',
        'stats_live',
        'stats_dirty',
        'nft_collections',
        'volume_backfill',
      ]);

      metrics.aggregatorRunsTotal.inc.mockClear();
      await service().tick();
      expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections']);
    });

    it('is off without the option: nothing is asked of the NFT functions, and a dirty range is only the stats', async () => {
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceLedgers.set('2026-05-01T00:00:00Z', { min: 100, max: 200 });
      await service({ nfts: undefined }).tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      for (const fn of [watermark, changedSince, inLedgers, rebuild, markDirty, oldestDirty, head, ledgersClosedIn]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(ch.dirty).toEqual([]);
    });

    it('has a budget of 3 s of its own, as nft_collections has, and that one runs every fifth tick', () => {
      expect(AGGREGATOR_NFT_STATE_BUDGET_MS).toBe(3000);
      expect(AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS).toBe(3000);
      expect(NFT_COLLECTIONS_EVERY_TICKS).toBe(5);
      expect(NFT_STATE_BATCH).toBeGreaterThan(0);
    });
  });

  describe('the live cursor', () => {
    it('starts from the watermark and moves the cursor to upTo only after a batch is written', async () => {
      pages.set(500, { nfts: [nft(1), nft(2)], upTo: 700 });
      pages.set(700, { nfts: [nft(3)], upTo: 900 });
      const svc = service();
      await svc.tick();
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(watermark).toHaveBeenCalledWith(ch);
      // each read is of one window of ledgers after the cursor: the last argument is the end of it
      expect(NFT_LIVE_STEP_LEDGERS).toBe(10_000);
      expect(changedSince.mock.calls.map(([, ledger, limit, to]) => [ledger, limit, to])).toEqual([
        [500, NFT_STATE_BATCH, 500 + NFT_LIVE_STEP_LEDGERS],
        [700, NFT_STATE_BATCH, 700 + NFT_LIVE_STEP_LEDGERS],
        [900, NFT_STATE_BATCH, 900 + NFT_LIVE_STEP_LEDGERS],
      ]);
      // never before: a batch is rebuilt, and then the cursor moves
      expect(events.filter((e) => !e.startsWith('stats'))).toEqual([
        'changed 500',
        'rebuild 1,2',
        'changed 700',
        'rebuild 3',
        'changed 900',
      ]);
      // every rebuild gets the database and the shutdown signal
      expect(rebuild.mock.calls[0][0]).toBe(ch);
      expect(rebuild.mock.calls[0][2]).toEqual({ signal: expect.any(AbortSignal) });

      // the next tick starts where this one ended, without reading the watermark again
      pages.set(900, { nfts: [nft(4)], upTo: 1000 });
      await tickAt(svc, 1);
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(changedSince.mock.calls.slice(3).map(([, ledger]) => ledger)).toEqual([900, 1000]);
      expect(rebuilt()).toEqual([[1, 2], [3], [4]]);
    });

    it('does not move when nothing changed, and does not rebuild anything', async () => {
      await service().tick();
      expect(changedSince).toHaveBeenCalledTimes(1);
      expect(rebuild).not.toHaveBeenCalled();
      expect(jobsRun()).toContain('nft_state');
    });

    it('does not ask for the same NFTs for ever when an answer does not move the cursor', async () => {
      pages.set(500, { nfts: [nft(1)], upTo: 500 });
      await service().tick();
      expect(rebuilt()).toEqual([[1]]);
      expect(changedSince).toHaveBeenCalledTimes(1);
    });

    it('moves the cursor over ledgers with nothing to rebuild: an answer without NFTs still says how far it is complete', async () => {
      pages.set(500, { nfts: [], upTo: 900 });
      pages.set(900, { nfts: [nft(1)], upTo: 950 });
      const svc = service();
      await svc.tick();
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);
      expect(rebuild).not.toHaveBeenCalled();
      await tickAt(svc, 1);
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 900, 950]);
      expect(rebuilt()).toEqual([[1]]);
    });

    describe('a cursor far behind the head', () => {
      /** What `nftsChangedSince` answers with a cap: the stale NFTs of the window `(ledger, min(head, to)]`, and its end. Each read takes a second. */
      function windowed(staleAt: Map<number, NftKey[]>): void {
        changedSince.mockImplementation(async (_ch: unknown, ledger: number, _limit: number, to?: number) => {
          events.push(`changed ${ledger}`);
          jest.setSystemTime(Date.now() + 1000);
          const end = Math.min(committed, to ?? committed);
          if (end <= ledger) return { nfts: [], upTo: ledger };
          const nfts = [...staleAt].filter(([at]) => at > ledger && at <= end).flatMap(([, list]) => list);
          return { nfts, upTo: end };
        });
      }

      it('crosses a stretch with nothing stale one window of NFT_LIVE_STEP_LEDGERS at a time, while the budget lasts, and goes on at the next tick', async () => {
        committed = 50_000;
        windowed(new Map([[32_000, [nft(7)]]]));
        const svc = service({ budgetsMs: { nft_state: 2500 } });
        await svc.tick();
        // a read at 0, 1 and 2 s; the budget of 2.5 s is spent for a fourth
        const reads = (): Array<[number, number | undefined]> =>
          changedSince.mock.calls.map(([, ledger, , to]) => [ledger, to]);
        expect(reads()).toEqual([
          [500, 10_500],
          [10_500, 20_500],
          [20_500, 30_500],
        ]);
        expect(rebuild).not.toHaveBeenCalled();
        expect(lastLag()).toBe(50_000 - 30_500);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nft_state reached its budget'));

        // the next tick goes on from the cursor, without reading the watermark again: the window with the NFT, which is rebuilt,
        // and the last one, which ends at the head, short of its cap
        await tickAt(svc, 1);
        expect(watermark).toHaveBeenCalledTimes(1);
        expect(reads().slice(3)).toEqual([
          [30_500, 40_500],
          [40_500, 50_500],
        ]);
        expect(rebuilt()).toEqual([[7]]);
        expect(lastLag()).toBe(0);
        // nothing is asked for beyond the head
        await tickAt(svc, 2);
        expect(reads().slice(5)).toEqual([[50_000, 60_000]]);
        expect(lastLag()).toBe(0);
      });

      it('does not cross a window that has NFTs before their batch is written: a batch that fails as a whole keeps the cursor at the start of its window', async () => {
        committed = 30_000;
        const four = [1, 2, 3, 4].map(nft);
        windowed(new Map([[5000, four]]));
        for (const n of [1, 2, 3, 4]) failing.add(n);
        const svc = service();
        await svc.tick();
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);
        expect(errors()).toBe(1);

        failing.clear();
        await tickAt(svc, 1);
        // the same window again, now written, and then the stretch after it up to the head
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 10_500, 20_500]);
        expect(rebuilt().at(-1)).toEqual([1, 2, 3, 4]);
        expect(lastLag()).toBe(0);
      });
    });

    it('a batch of more NFTs than the limit (all the NFTs of one ledger) is rebuilt whole', async () => {
      const many = Array.from({ length: NFT_STATE_BATCH + 100 }, (_, i) => nft(i + 1));
      pages.set(500, { nfts: many, upTo: 501 });
      await service().tick();
      expect(rebuilt()).toEqual([serials(many)]);
    });

    it('a read of the watermark that fails is counted and logged as nft_state, the jobs after it still run, and the next read waits (5 minutes, then twice as long)', async () => {
      const timeout = 'DB::Exception: Timeout exceeded: elapsed 30.001 seconds';
      watermark.mockRejectedValueOnce(new Error(timeout)).mockRejectedValueOnce(new Error(timeout));
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      const after = jest.fn(async () => undefined);
      const svc = service({ extraJobs: [{ name: 'after_nft_state', run: after }] });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_state' }]]);
      expect(logger.error).toHaveBeenCalledWith(
        `Aggregator job nft_state failed reading where the job goes on from, tried again in 5 min: ${timeout}`,
      );
      // the loop goes on: the jobs after it ran, and the job itself did not fail (a failed read is not the error of its run)
      expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections', 'after_nft_state']);
      expect(after).toHaveBeenCalledTimes(1);
      expect(changedSince).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
      // the cursor is not known: every ledger is behind it
      expect(lastLag()).toBe(committed);
      expect(metrics.nftDirtyLedgers.set).toHaveBeenCalledWith(0);

      // not read again before the wait is over
      await tickAt(svc, 4);
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(errors()).toBe(1);
      // and then it is, and fails again: counted again, and the wait is twice as long
      await tickAt(svc, 5);
      expect(watermark).toHaveBeenCalledTimes(2);
      expect(errors()).toBe(2);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('tried again in 10 min'));
      await tickAt(svc, 14);
      expect(watermark).toHaveBeenCalledTimes(2);
      expect(rebuild).not.toHaveBeenCalled();

      // the third read answers, and the live part goes on from it in the same run
      await tickAt(svc, 15);
      expect(watermark).toHaveBeenCalledTimes(3);
      expect(rebuilt()).toEqual([[1]]);
      expect(errors()).toBe(2);
      expect(jobsRun().filter((job) => job === 'nft_state')).toHaveLength(5);
    });

    describe('a read of the watermark that takes as long as the time limit of a query', () => {
      /** The reads of the watermark that are out, which the test answers when it says. */
      function pendingReads(): Array<{ resolve: (ledger: number) => void; reject: (error: Error) => void }> {
        const reads: Array<{ resolve: (ledger: number) => void; reject: (error: Error) => void }> = [];
        watermark.mockImplementation(() => new Promise<number>((resolve, reject) => reads.push({ resolve, reject })));
        return reads;
      }
      /** Lets what a settled promise woke up run. */
      const flush = (): Promise<void> => jest.advanceTimersByTimeAsync(0);
      const timeout = new Error('DB::Exception: Timeout exceeded: elapsed 30.001 seconds');

      it('does not hold the tick: the jobs after it run their slices, and so do the dirty part and the retries, while the live part waits for the cursor', async () => {
        const reads = pendingReads();
        dirty = [mark(100, 200)];
        touched.set(150, [nft(7)]);
        ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
        const after = jest.fn(async () => undefined);
        pages.set(500, { nfts: [nft(1)], upTo: 700 });
        const svc = service({ extraJobs: [{ name: 'after_nft_state', run: after }] });
        await svc.tick();

        // the read is out, and nothing waited for it
        expect(watermark).toHaveBeenCalledTimes(1);
        expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections', 'after_nft_state']);
        expect(events).toContain('stats 2026-10-16T10:00:00Z'); // the slice of stats_live
        expect(events).toContain('stats 2026-05-01T00:00:00Z'); // the slice of stats_dirty
        expect(after).toHaveBeenCalledTimes(1);
        expect(ch.dirty).toEqual([]);
        // the dirty part of the job ran, the live part did not (it has no cursor)
        expect(rebuilt()).toEqual([[7]]);
        expect(dirty).toEqual([]);
        expect(changedSince).not.toHaveBeenCalled();
        expect(errors()).toBe(0);
        // everything is behind a cursor that is not known
        expect(lastLag()).toBe(committed);

        // another tick does not start a second read while one is out
        await tickAt(svc, 1);
        expect(watermark).toHaveBeenCalledTimes(1);
        expect(changedSince).not.toHaveBeenCalled();
        expect(jobsRun().filter((job) => job === 'stats_live')).toHaveLength(2);

        // it answers, and the next tick has the cursor
        reads[0].resolve(500);
        await flush();
        await tickAt(svc, 2);
        expect(watermark).toHaveBeenCalledTimes(1);
        expect(rebuilt()).toEqual([[7], [1]]);
        expect(errors()).toBe(0);
      });

      it('that fails once the tick is over is counted and logged as nft_state, and is read again only after 5 minutes, then after twice as long up to an hour', async () => {
        const reads = pendingReads();
        const svc = service();
        await svc.tick();
        expect(errors()).toBe(0);

        // the query ran out of its 30 s while the tick went on
        jest.setSystemTime(Date.now() + 30_000);
        reads[0].reject(timeout);
        await flush();
        expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_state' }]]);
        expect(logger.error).toHaveBeenCalledWith(
          `Aggregator job nft_state failed reading where the job goes on from, tried again in 5 min: ${timeout.message}`,
        );

        let calls = 1;
        for (const waitMinutes of [5, 10, 20, 40, 60, 60]) {
          const failedAt = Date.now();
          // not a second before the wait is over ...
          jest.setSystemTime(failedAt + waitMinutes * 60_000 - 1000);
          await svc.tick();
          expect(watermark).toHaveBeenCalledTimes(calls);
          // ... and at the end of it a new read starts, which fails again: counted, and the wait doubles (at most an hour)
          jest.setSystemTime(failedAt + waitMinutes * 60_000);
          await svc.tick();
          expect(watermark).toHaveBeenCalledTimes(++calls);
          reads[calls - 1].reject(timeout);
          await flush();
          expect(errors()).toBe(calls);
        }
        expect(logger.error).toHaveBeenLastCalledWith(expect.stringContaining('tried again in 60 min'));

        // a read that answers ends it: the live part goes on from there at the next tick, and nothing is read again
        const failedAt = Date.now();
        jest.setSystemTime(failedAt + 60 * 60_000);
        await svc.tick();
        reads[calls].resolve(500);
        await flush();
        pages.set(500, { nfts: [nft(1)], upTo: 700 });
        await svc.tick();
        expect(watermark).toHaveBeenCalledTimes(calls + 1);
        expect(rebuilt()).toEqual([[1]]);
        expect(errors()).toBe(calls);
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
    });

    it('a failing watermark does not keep the dirty ranges from being worked on', async () => {
      watermark.mockRejectedValue(new Error('DB::Exception: Timeout exceeded'));
      dirty = [mark(100, 200)];
      touched.set(150, [nft(7)]);
      await service().tick();
      expect(errors()).toBe(1);
      expect(rebuilt()).toEqual([[7]]);
      expect(dirty).toEqual([]);
    });

    it('a failing read of what changed is a failure of the job as well', async () => {
      changedSince.mockRejectedValueOnce(new Error('DB::Exception: no such table'));
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no such table'));
    });
  });

  describe('failures', () => {
    const NFTS5 = [1, 2, 3, 4, 5].map(nft);

    it('a batch that fails as a whole keeps the cursor and fails the job: nothing is set aside, and the next tick does it again', async () => {
      pages.set(500, { nfts: NFTS5, upTo: 700 });
      pages.set(700, { nfts: [nft(6)], upTo: 900 });
      // more NFTs than the isolation takes for a cause of its own
      for (const n of [1, 2, 3, 4, 5]) failing.add(n);
      expect(NFTS5.length).toBeGreaterThan(MAX_ISOLATED_NFTS_PER_BATCH);
      const svc = service();
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('nft_state'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      // the jobs after it still ran
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty', 'nft_collections']);
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);
      expect(done).toEqual([]);

      failing.clear();
      await tickAt(svc, 1);
      // the batch of 500 is the one done again: the cursor was at 500, and nothing was set aside to wait
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700, 900]);
      expect(done).toEqual([1, 2, 3, 4, 5, 6]);
      expect(jobsRun()).toContain('nft_state');
      expect(errors()).toBe(1);
    });

    describe('one NFT that fails every time', () => {
      it('halves a failing batch, sets aside the NFT that fails alone and goes on: the others of its batch and the later batches are done', async () => {
        pages.set(500, { nfts: NFTS5, upTo: 700 });
        pages.set(700, { nfts: [nft(6)], upTo: 900 });
        failing.add(3);
        await service().tick();
        // the batch, its first half (three), that half's first half, the NFT alone, and the other half of the batch
        expect(rebuilt()).toEqual([[1, 2, 3, 4, 5], [1, 2, 3], [1, 2], [3], [4, 5], [6]]);
        expect(done).toEqual([1, 2, 4, 5, 6]);
        // the cursor passed the batch, and the job ran to the end
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700, 900]);
        expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections']);
        // one error, for the NFT, and not one for the batch
        expect(errors()).toBe(1);
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`NFT ${nft(3).nft_id}, set aside`));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      });

      it('is found even when it is the first of the batch, whose halves all fail until the NFT is alone', async () => {
        pages.set(500, { nfts: NFTS5, upTo: 700 });
        failing.add(1);
        await service().tick();
        expect(done).toEqual([2, 3, 4, 5]);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);
        expect(errors()).toBe(1);
      });

      it('up to three NFTs of a batch are set aside, a fourth makes it the failure of the job', async () => {
        pages.set(500, { nfts: NFTS5, upTo: 700 });
        for (const n of [1, 3, 5]) failing.add(n);
        expect(MAX_ISOLATED_NFTS_PER_BATCH).toBe(3);
        const svc = service();
        await svc.tick();
        expect(done).toEqual([2, 4]);
        expect(errors()).toBe(3);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);

        // four in a batch: the cursor stays
        pages.set(700, { nfts: [6, 7, 8, 9].map(nft), upTo: 900 });
        for (const n of [6, 7, 8, 9]) failing.add(n);
        changedSince.mockClear();
        await tickAt(svc, 1);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([700]);
        expect(done).toEqual([2, 4]);
        expect(errors()).toBe(4);
      });

      it('is tried again after five minutes, then after twice as long each time up to an hour, and forgotten once it works', async () => {
        minMs = 0; // the wait of a retry is counted from the failure: the ticks of the test are on the minute
        pages.set(500, { nfts: [nft(1), nft(3)], upTo: 700 });
        failing.add(3);
        const svc = service();
        const retries = (): number => rebuilt().filter((b) => b.length === 1 && b[0] === 3).length;
        await svc.tick();
        expect(retries()).toBe(1);
        expect(errors()).toBe(1);
        expect([NFT_RETRY_MS, NFT_MAX_RETRY_MS]).toEqual([5 * 60_000, 60 * 60_000]);

        let at = 0;
        let count = 1;
        for (const waitMinutes of [5, 10, 20, 40, 60, 60]) {
          // a tick a second before the wait is over leaves it alone ...
          jest.setSystemTime(NOW_SECONDS * 1000 + (at + waitMinutes) * 60_000 - 1000);
          await svc.tick();
          expect(retries()).toBe(count);
          // ... and one at the end of it tries again, and fails again: each failure is an error
          await tickAt(svc, at + waitMinutes);
          count++;
          expect(retries()).toBe(count);
          expect(errors()).toBe(count);
          at += waitMinutes;
        }
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining(`NFT ${nft(3).nft_id}, tried again in 60 min`),
        );

        // it works at last: rebuilt, and not asked for again
        failing.clear();
        await tickAt(svc, at + 60);
        expect(done).toEqual([1, 3]);
        const before = rebuild.mock.calls.length;
        await tickAt(svc, at + 600);
        expect(rebuild.mock.calls.length).toBe(before);
        expect(errors()).toBe(count);
      });

      it('is left out of the batches that come while it waits, and rebuilt by its retry with everything it has by then', async () => {
        minMs = 0; // the wait of a retry is counted from the failure: the ticks of the test are on the minute
        pages.set(500, { nfts: [nft(2), nft(3)], upTo: 700 });
        pages.set(700, { nfts: [nft(3), nft(4)], upTo: 900 }); // it changed again
        failing.add(3);
        const svc = service();
        await svc.tick();
        expect(rebuilt()).toEqual([[2, 3], [2], [3], [4]]);
        expect(done).toEqual([2, 4]);

        failing.clear();
        await tickAt(svc, 5);
        expect(rebuilt().slice(4)).toEqual([[3]]);
        expect(done).toEqual([2, 4, 3]);
      });

      it('has its retry after the new work of the tick', async () => {
        minMs = 0; // the wait of a retry is counted from the failure: the ticks of the test are on the minute
        pages.set(500, { nfts: [nft(2), nft(3)], upTo: 700 });
        failing.add(3);
        const svc = service();
        await svc.tick();
        const first = rebuilt().length;

        failing.clear();
        pages.set(700, { nfts: [nft(4)], upTo: 900 });
        await tickAt(svc, 5);
        expect(rebuilt().slice(first)).toEqual([[4], [3]]);
      });

      it('has its retry in a tick whose live part failed', async () => {
        pages.set(500, { nfts: [nft(2), nft(3)], upTo: 700 });
        failing.add(3);
        const svc = service();
        await svc.tick();
        expect(errors()).toBe(1);

        // when the retry is due, a batch fails as a whole; the NFT that was set aside works again
        failing.clear();
        const others = [1, 2, 4, 5, 6];
        for (const n of others) failing.add(n);
        pages.set(700, { nfts: others.map(nft), upTo: 900 });
        await tickAt(svc, 5);
        expect(errors()).toBe(2); // the failure of the job
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
        expect(done).toEqual([2, 3]);
      });

      it('the retries are under the budget of the job: a slow one uses it up, and the next waits for the next tick', async () => {
        minMs = 0; // the wait of a retry is counted from the failure: the ticks of the test are on the minute
        pages.set(500, { nfts: [nft(1), nft(3), nft(5)], upTo: 700 });
        failing.add(3);
        failing.add(5);
        const svc = service({ budgetsMs: { nft_state: 1000 } });
        await svc.tick();
        expect(errors()).toBe(2);

        failing.clear();
        rebuildMs = 1100;
        await tickAt(svc, 5);
        expect(done).toEqual([1, 3]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nft_state reached its budget'));

        await tickAt(svc, 6);
        expect(done).toEqual([1, 3, 5]);
      });

      it('is not set aside by the shutdown: an aborted batch is neither an error nor an NFT to retry', async () => {
        pages.set(500, { nfts: NFTS5, upTo: 700 });
        const svc = service();
        rebuild.mockImplementation(async () => {
          void svc.stop();
          throw new NftRebuildAborted();
        });
        await svc.tick();
        expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        expect(rebuild).toHaveBeenCalledTimes(1); // no halving
      });
    });

    describe('a halving that does not fit in the budget of one tick', () => {
      const MANY = Array.from({ length: NFT_STATE_BATCH }, (_, i) => nft(i + 1));

      it('goes on where it stopped at the next ticks, and the cursor moves on once the failing NFT is found', async () => {
        pages.set(500, { nfts: MANY, upTo: 700 });
        failing.add(137);
        rebuildMs = 2000; // two calls of a tick use the 3 s of the budget
        const svc = service();
        let ticks = 0;
        while (!changedSince.mock.calls.some(([, ledger]) => ledger === 700) && ticks < 40) {
          await tickAt(svc, ticks++);
        }
        // about two rebuilds for each of the log2(500) levels, two a tick
        expect(ticks).toBeLessThanOrEqual(14);
        expect(changedSince.mock.calls.filter(([, ledger]) => ledger === 500)).toHaveLength(1);
        // every other NFT was rebuilt, once, and the failing one is set aside and counted; the failure of the batch was counted
        // at its first tick (the halving went on over the next ones)
        expect([...done].sort((a, b) => a - b)).toEqual(MANY.map((k) => k.serial).filter((n) => n !== 137));
        expect(errors()).toBe(2);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`NFT ${nft(137).nft_id}`));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nft_state reached its budget'));
      });

      it('is counted and logged once, at its first tick, not only when the halving is over', async () => {
        pages.set(500, { nfts: MANY, upTo: 700 });
        failing.add(137);
        rebuildMs = 2000;
        const svc = service();
        await tickAt(svc, 0);
        // the batch failed and its halving goes on at the next tick: the failure is in the metrics and the log now
        expect(errors()).toBe(1);
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
        expect(logger.error).toHaveBeenCalledWith(
          `Aggregator job nft_state: a batch of ${NFT_STATE_BATCH} NFT(s) failed, halving it to find the NFTs that fail on their own (it goes on at the next tick): DB::Exception: memory limit on NFT 137`,
        );
        // and not again at the next ticks of the halving
        for (let i = 1; i < 4; i++) await tickAt(svc, i);
        expect(errors()).toBe(1);
      });
    });

    describe('a batch in which everything fails (the database)', () => {
      it('is the failure of the job, not a reason to set its NFTs aside: they are, if they fail alone again next time', async () => {
        pages.set(500, { nfts: [nft(1), nft(2)], upTo: 700 });
        failing.add(1);
        failing.add(2);
        const svc = service();
        await svc.tick();
        expect(rebuilt()).toEqual([[1, 2], [1], [2]]);
        expect(errors()).toBe(1);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);

        // the same batch fails the same way: now the NFTs are set aside, and the cursor goes on
        await tickAt(svc, 1);
        expect(errors()).toBe(3);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700]);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`NFT ${nft(1).nft_id}, set aside`));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`NFT ${nft(2).nft_id}, set aside`));
      });

      it('a batch is a repeat only of the run of the job just before: an older all-failed batch is not', async () => {
        failing.add(1);
        failing.add(2);
        const svc = service();
        // tick 0: the batch fails whole, the failure of the job
        pages.set(500, { nfts: [nft(1), nft(2)], upTo: 700 });
        await tickAt(svc, 0);
        expect(errors()).toBe(1);
        // tick 1: other NFTs first (the ledger they are at is before the batch), which work
        pages.set(500, { nfts: [nft(3)], upTo: 501 });
        pages.set(501, { nfts: [], upTo: 501 });
        await tickAt(svc, 1);
        expect(errors()).toBe(1);
        // tick 2: the batch again, failing whole again: the failure of tick 0 is two runs back, so it is no repeat
        pages.set(501, { nfts: [nft(1), nft(2)], upTo: 700 });
        await tickAt(svc, 2);
        expect(errors()).toBe(2);
        expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('set aside'));
        // tick 3: the same batch of the run just before: now it is a repeat, and its NFTs are set aside
        await tickAt(svc, 3);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`NFT ${nft(1).nft_id}, set aside`));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`NFT ${nft(2).nft_id}, set aside`));
      });

      it('when the database comes back the next tick does the batch, and nothing waits for a retry', async () => {
        pages.set(500, { nfts: [nft(1)], upTo: 700 });
        failing.add(1);
        const svc = service();
        await svc.tick();
        expect(errors()).toBe(1);
        expect(done).toEqual([]);

        failing.clear();
        await tickAt(svc, 1);
        expect(done).toEqual([1]);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700]);
        const calls = rebuild.mock.calls.length;
        await tickAt(svc, 600);
        expect(rebuild.mock.calls.length).toBe(calls);
        expect(errors()).toBe(1);
      });
    });

    describe('a batch that fails as a whole although each half works', () => {
      it('is warned about and counted once, and the cursor goes on', async () => {
        pages.set(500, { nfts: [1, 2, 3, 4].map(nft), upTo: 700 });
        rebuild.mockImplementation(async (_c: unknown, nfts: NftKey[]) => {
          if (nfts.length >= 4) throw new Error('DB::Exception: too many NFTs for the memory limit');
          done.push(...serials(nfts));
          return { written: nfts.length, removed: 0, collections: [] };
        });
        await service().tick();
        expect(done).toEqual([1, 2, 3, 4]);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);
        expect(errors()).toBe(1);
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('as a whole'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('too many NFTs'));
      });
    });
  });

  describe('the budget', () => {
    it('stops starting batches when the budget of the job is spent, says so, and goes on from the cursor next tick', async () => {
      rebuildMs = 400;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { nfts: [nft(i)], upTo: 510 + i * 10 });
      const svc = service({ budgetsMs: { nft_state: 1000 } });
      await svc.tick();
      // batches start at 0, 400 and 800 ms (inside the 1000 ms) and not at 1200: nothing is even asked for after the budget
      expect(rebuilt()).toEqual([[0], [1], [2]]);
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 510, 520]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nft_state reached its budget'));
      // the other jobs of the tick were not held up
      expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections']);

      await tickAt(svc, 1);
      expect(rebuilt().slice(3)).toEqual([[3], [4], [5]]);
    });

    it('is 3 s by default: a slow batch uses it up, and the stats still get the rest of the tick', async () => {
      rebuildMs = 10_000;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { nfts: [nft(i)], upTo: 510 + i * 10 });
      await service().tick();
      expect(rebuilt()).toEqual([[0]]);
      expect(events.some((e) => e.startsWith('stats'))).toBe(true);
    });

    it('does not take more than the tick has left either', async () => {
      rebuildMs = 5000;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { nfts: [nft(i)], upTo: 510 + i * 10 });
      await service({ tickBudgetMs: 4000, budgetsMs: { nft_state: 100_000 } }).tick();
      expect(rebuilt()).toEqual([[0]]);
    });

    it('the dirty ranges get what the live sweep left of the budget, and nothing when it left none', async () => {
      rebuildMs = 1500;
      pages.set(500, { nfts: [nft(1)], upTo: 600 });
      pages.set(600, { nfts: [nft(2)], upTo: 700 });
      pages.set(700, { nfts: [nft(3)], upTo: 800 });
      dirty = [mark(100, 200)];
      touched.set(150, [nft(9)]);
      const svc = service({ budgetsMs: { nft_state: 3000 } });
      await svc.tick();
      // the live sweep used the 3 s (batches at 0 and 1.5 s, and the dirty range is out of budget)
      expect(rebuilt()).toEqual([[1], [2]]);
      expect(oldestDirty).not.toHaveBeenCalled();
      expect(dirty).toEqual([mark(100, 200)]);

      // a tick with only a batch of live work left has the rest of its budget for the range
      await tickAt(svc, 1);
      expect(rebuilt().slice(2)).toEqual([[3], [9]]);
      expect(dirty).toEqual([]);
    });
  });

  describe('the dirty ranges (nft_dirty)', () => {
    it('works the oldest dirty range NFT_DIRTY_STEP_LEDGERS ledgers at a time and narrows it', async () => {
      expect(NFT_DIRTY_STEP_LEDGERS).toBe(10_000);
      dirty = [mark(1000, 25_999)];
      touched.set(1500, [nft(1)]);
      touched.set(11_000, [nft(2)]);
      touched.set(25_999, [nft(3)]);
      await service().tick();
      expect(events.filter((e) => !e.startsWith('stats') && !e.startsWith('changed'))).toEqual([
        'in 1000-10999',
        'rebuild 1',
        'narrow 11000-25999',
        'in 11000-20999',
        'rebuild 2',
        'narrow 21000-25999',
        'in 21000-25999',
        'rebuild 3',
        'delete 21000-25999',
      ]);
      expect(dirty).toEqual([]);
    });

    it('narrows a range to its remainder, which keeps its place in the queue, so that progress survives a restart', async () => {
      dirty = [mark(1000, 25_999, 5000), mark(50_000, 50_010, 6000)];
      touched.set(1500, [nft(1)]);
      // a budget for one step only
      rebuildMs = 2000;
      const svc = service({ budgetsMs: { nft_state: 1000 } });
      await svc.tick();
      expect(queue()).toEqual([mark(11_000, 25_999, 5000), mark(50_000, 50_010, 6000)]);
      expect(events).not.toContain('in 11000-20999');

      // a new process finishes the range from its remainder, then goes on to the next
      touched.set(12_000, [nft(2)]);
      touched.set(50_005, [nft(3)]);
      rebuildMs = 0;
      const restarted = service();
      await restarted.tick();
      expect(rebuilt()).toEqual([[1], [2], [3]]);
      expect(dirty).toEqual([]);
    });

    it('deletes a dirty range once it is done', async () => {
      dirty = [mark(100, 200, 7000)];
      touched.set(150, [nft(4), nft(5)]);
      await service().tick();
      expect(rebuilt()).toEqual([[4, 5]]);
      expect(inLedgers.mock.calls.map(([, from, to]) => [from, to])).toEqual([[100, 200]]);
      expect(narrowDirty).not.toHaveBeenCalled();
      expect(markDirty).not.toHaveBeenCalled();
      expect(deleteDirty).toHaveBeenCalledWith(ch, mark(100, 200, 7000));
      expect(dirty).toEqual([]);
    });

    it('does the ranges the oldest mark first, and rebuilds the NFTs of a step in batches', async () => {
      dirty = [mark(5000, 5100, 9000), mark(100, 200, 8000)];
      const many = Array.from({ length: NFT_STATE_BATCH * 2 + 50 }, (_, i) => nft(i + 1));
      touched.set(150, many);
      touched.set(5050, [nft(9999)]);
      await service().tick();
      expect(rebuilt().map((b) => b.length)).toEqual([NFT_STATE_BATCH, NFT_STATE_BATCH, 50, 1]);
      expect(rebuilt().flat()).toEqual([...many.map((k) => k.serial), 9999]);
      expect(dirty).toEqual([]);
    });

    it('a range with no NFT in it is just deleted', async () => {
      dirty = [mark(100, 200)];
      await service().tick();
      expect(rebuild).not.toHaveBeenCalled();
      expect(dirty).toEqual([]);
    });

    it('a step that does not fit in the budget goes on at the next tick from the batch it stopped at, and narrows the range when it is done', async () => {
      dirty = [mark(100, 200)];
      const many = Array.from({ length: NFT_STATE_BATCH * 3 }, (_, i) => nft(i + 1));
      touched.set(150, many);
      rebuildMs = 1500;
      const svc = service();
      await svc.tick();
      // batches at 0 and 1.5 s, not at 3 s: the range is as it was (nothing is narrowed before the step is done)
      expect(rebuilt().map((b) => b.length)).toEqual([NFT_STATE_BATCH, NFT_STATE_BATCH]);
      expect(dirty).toEqual([mark(100, 200)]);
      expect(inLedgers).toHaveBeenCalledTimes(1);

      await tickAt(svc, 1);
      // the third batch, without reading the NFTs of the step again
      expect(rebuilt().map((b) => b.length)).toEqual([NFT_STATE_BATCH, NFT_STATE_BATCH, NFT_STATE_BATCH]);
      expect(rebuilt().flat()).toEqual(many.map((k) => k.serial));
      expect(inLedgers).toHaveBeenCalledTimes(1);
      expect(dirty).toEqual([]);
    });

    it('a batch of a step that fails as a whole keeps the range and fails the job; the next tick goes on with the NFTs it had not done', async () => {
      dirty = [mark(100, 200)];
      const many = Array.from({ length: NFT_STATE_BATCH + 4 }, (_, i) => nft(i + 1));
      touched.set(150, many);
      // the second batch: four NFTs, which all fail
      for (const n of [NFT_STATE_BATCH + 1, NFT_STATE_BATCH + 2, NFT_STATE_BATCH + 3, NFT_STATE_BATCH + 4])
        failing.add(n);
      const svc = service();
      await svc.tick();
      expect(errors()).toBe(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      expect(dirty).toEqual([mark(100, 200)]);
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty', 'nft_collections']);

      failing.clear();
      await tickAt(svc, 1);
      // the first batch is not done again, the second is
      expect(rebuilt().filter((b) => b.length === NFT_STATE_BATCH)).toHaveLength(1);
      expect(done.filter((n) => n > NFT_STATE_BATCH)).toEqual([501, 502, 503, 504]);
      expect(inLedgers).toHaveBeenCalledTimes(1);
      expect(dirty).toEqual([]);
    });

    it('an NFT of a step that fails on its own is counted, and the range of the step is marked again before it is deleted, once a run, until the NFT works', async () => {
      dirty = [mark(100, 200, 7000)];
      touched.set(150, [1, 2, 3].map(nft));
      failing.add(2);
      const svc = service();
      await svc.tick();
      expect(done).toEqual([1, 3]);
      expect(errors()).toBe(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining(`NFT ${nft(2).nft_id}, its dirty range is marked again`),
      );
      // marked again, and only then deleted: a restart cannot find the NFT from the tables (no touch above what its row has
      // seen), so the range is what keeps it from being lost
      expect(markDirty).toHaveBeenCalledWith(ch, 100, 200);
      expect(events.filter((e) => /^(mark|delete|narrow)/.test(e))).toEqual(['mark 100-200', 'delete 100-200']);
      expect(dirty).toEqual([{ from: 100, to: 200, created: expect.any(Number) }]);
      expect(dirty[0].created).toBeGreaterThan(7000);
      // the new mark waits for the next run: a step that keeps failing is not done over and over in one
      expect(inLedgers).toHaveBeenCalledTimes(1);

      // the next run does the step again: the NFT fails again, and the range is marked again
      await tickAt(svc, 1);
      expect(inLedgers).toHaveBeenCalledTimes(2);
      expect(errors()).toBe(2);
      expect(markDirty).toHaveBeenCalledTimes(2);
      expect(dirty).toHaveLength(1);

      // it works at last: the step is done and the range is deleted, with no mark
      failing.clear();
      await tickAt(svc, 2);
      expect(done.slice(4)).toEqual([1, 2, 3]);
      expect(markDirty).toHaveBeenCalledTimes(2);
      expect(dirty).toEqual([]);
      expect(errors()).toBe(2);
    });

    it('marks the range of a step again before narrowing the range: the remainder keeps its place, and the step goes to the back of the queue', async () => {
      dirty = [mark(1000, 25_999, 5000), mark(60_000, 60_010, 6000)];
      touched.set(1500, [nft(1)]);
      touched.set(12_000, [nft(2)]);
      touched.set(13_000, [nft(5)]);
      touched.set(22_000, [nft(3)]);
      touched.set(60_005, [nft(4)]);
      failing.add(2);
      const svc = service();
      await svc.tick();
      expect(events.filter((e) => /^(in|rebuild|mark|narrow|delete)/.test(e))).toEqual([
        'in 1000-10999',
        'rebuild 1',
        'narrow 11000-25999',
        // the second step: 2 fails on its own, 5 works
        'in 11000-20999',
        'rebuild 2,5',
        'rebuild 2',
        'rebuild 5',
        'mark 11000-20999',
        'narrow 21000-25999',
        'in 21000-25999',
        'rebuild 3',
        'delete 21000-25999',
        // the next range; the step marked again is behind it, and waits for the next run
        'in 60000-60010',
        'rebuild 4',
        'delete 60000-60010',
      ]);
      expect(dirty).toEqual([{ from: 11_000, to: 20_999, created: expect.any(Number) }]);
      expect(dirty[0].created).toBeGreaterThan(6000);

      failing.clear();
      await tickAt(svc, 1);
      expect(done).toEqual([1, 5, 3, 4, 2, 5]);
      expect(dirty).toEqual([]);
    });

    it('the NFTs a live batch sets aside are retried from memory and not marked in nft_dirty: the tables say they are stale', async () => {
      pages.set(500, { nfts: [nft(1), nft(2)], upTo: 700 });
      failing.add(2);
      await service().tick();
      expect(errors()).toBe(1);
      expect(markDirty).not.toHaveBeenCalled();
      expect(dirty).toEqual([]);
    });

    it('leaves out of its batches an NFT that waits for a retry of the live job: the retry rebuilds it', async () => {
      pages.set(500, { nfts: [nft(2)], upTo: 700 });
      failing.add(2);
      const svc = service();
      await svc.tick(); // the batch of one fails whole ...
      await tickAt(svc, 1); // ... and again: now it is set aside
      expect(errors()).toBe(2);
      failing.clear();
      rebuild.mockClear();
      dirty = [mark(100, 200)];
      touched.set(150, [nft(1), nft(2)]);
      await tickAt(svc, 2);
      expect(rebuilt()).toEqual([[1]]);
      expect(dirty).toEqual([]);
    });

    it('a failing read of the oldest range is a failure of the job, and the live part still ran', async () => {
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      oldestDirty.mockRejectedValueOnce(new Error('DB::Exception: no such table nft_dirty'));
      await service().tick();
      expect(rebuilt()).toEqual([[1]]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no such table nft_dirty'));
    });

    it('a failure of the live part and of the dirty part are both counted, the first as the error of the job', async () => {
      changedSince.mockRejectedValueOnce(new Error('DB::Exception: live'));
      oldestDirty.mockRejectedValueOnce(new Error('DB::Exception: dirty'));
      await service().tick();
      expect(errors()).toBe(2);
      expect(logger.error).toHaveBeenCalledWith('Aggregator job nft_state failed: DB::Exception: live');
      expect(logger.error).toHaveBeenCalledWith('Aggregator job nft_state failed: DB::Exception: dirty');
    });

    it('does not change nft_dirty once the shutdown has begun, and the range stays', async () => {
      dirty = [mark(100, 200)];
      touched.set(150, [nft(1)]);
      const svc = service();
      rebuild.mockImplementationOnce(async (_c: unknown, nfts: NftKey[]) => {
        void svc.stop(); // the shutdown begins during the batch ...
        return { written: nfts.length, removed: 0, collections: [] };
      });
      await svc.tick();
      expect(narrowDirty).not.toHaveBeenCalled(); // ... and the range is neither narrowed nor deleted
      expect(deleteDirty).not.toHaveBeenCalled();
      expect(dirty).toEqual([mark(100, 200)]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('a step cut short by the shutdown (an aborted rebuild) is neither an error nor counted, and the range stays', async () => {
      dirty = [mark(100, 200)];
      touched.set(150, [nft(1)]);
      const svc = service();
      rebuild.mockImplementation(async () => {
        void svc.stop();
        throw new NftRebuildAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(dirty).toEqual([mark(100, 200)]);
    });
  });

  describe('the NFTs of agg_dirty slices (the hook of stats_dirty)', () => {
    it('ofSlice marks the ledgers that closed in the slice and rebuilds nothing', async () => {
      ch.dirty = [aggMark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      sliceLedgers.set('2026-05-01T22:00:00Z', { min: 90_000, max: 91_200 });
      await service().tick();
      expect(ledgersClosedIn).toHaveBeenCalledTimes(1);
      const [from, toExclusive] = ledgersClosedIn.mock.calls[0];
      // the same call as the account rollups make: two dates, the end exclusive
      expect([from, toExclusive]).toEqual([expect.any(Date), expect.any(Date)]);
      expect([iso(from.getTime() / 1000), iso(toExclusive.getTime() / 1000)]).toEqual([
        '2026-05-01T22:00:00Z',
        '2026-05-02T03:00:00Z',
      ]);
      expect(markDirty).toHaveBeenCalledTimes(1);
      expect(markDirty).toHaveBeenCalledWith(ch, 90_000, 91_200);
      // it is the next run of the job that works on the range, not the hook
      expect(inLedgers).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
      expect(dirty).toEqual([expect.objectContaining({ from: 90_000, to: 91_200 })]);
      // after the stats of the slice
      const at = events.indexOf('stats 2026-05-01T22:00:00Z');
      expect(events.slice(at, at + 2)).toEqual(['stats 2026-05-01T22:00:00Z', 'mark 90000-91200']);
      expect(ch.dirty).toEqual([]);
    });

    it('a range of several days: each slice marks its own ledgers', async () => {
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-02T12:00:00Z')];
      sliceLedgers.set('2026-05-01T00:00:00Z', { min: 100, max: 200 });
      sliceLedgers.set('2026-05-02T00:00:00Z', { min: 201, max: 250 });
      await service().tick();
      expect(markDirty.mock.calls.map(([, min, max]) => [min, max])).toEqual([
        [100, 200],
        [201, 250],
      ]);
      expect(ch.dirty).toEqual([]);
    });

    it('a slice in which no ledger closed marks nothing, and the range is removed', async () => {
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service().tick();
      expect(ledgersClosedIn).toHaveBeenCalledTimes(1);
      expect(markDirty).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('marks it again when the range is done again: marking is idempotent', async () => {
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceLedgers.set('2026-05-01T00:00:00Z', { min: 100, max: 200 });
      const svc = service();
      await svc.tick();
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z', 2000)];
      await tickAt(svc, 1);
      expect(markDirty).toHaveBeenCalledTimes(2);
      expect(dirty).toHaveLength(1);
    });

    it('runs without the aggregates option, which has no hook of its own here', async () => {
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceLedgers.set('2026-05-01T00:00:00Z', { min: 100, max: 200 });
      await service({ aggregates: undefined }).tick();
      expect(markDirty).toHaveBeenCalledWith(ch, 100, 200);
      expect(ch.dirty).toEqual([]);
    });

    it('a failing hook is counted and logged as nft_state_dirty, fails the slice and keeps the range; the jobs after it still run', async () => {
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceLedgers.set('2026-05-01T00:00:00Z', { min: 100, max: 200 });
      markDirty.mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
      const svc = service();
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_state_dirty' }]]);
      expect(logger.error).toHaveBeenCalledWith(
        'Aggregator job nft_state_dirty failed in 2026-05-01T00:00:00Z - 2026-05-01T03:00:00Z: DB::Exception: memory limit',
      );
      expect(ch.dirty).toEqual([aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')]);
      expect(dirty).toEqual([]);
      expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections']);

      await tickAt(svc, 1);
      expect(ch.dirty).toEqual([]);
      expect(dirty).toEqual([expect.objectContaining({ from: 100, to: 200 })]);
      expect(errors()).toBe(1);
    });

    it('a lookup of the ledgers of a slice that fails fails the slice the same way', async () => {
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      ledgersClosedIn.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state_dirty' });
      expect(ch.dirty).toHaveLength(1);
    });

    it('does nothing once the shutdown has begun, and the range stays', async () => {
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-02T12:00:00Z')];
      sliceLedgers.set('2026-05-01T00:00:00Z', { min: 100, max: 200 });
      sliceLedgers.set('2026-05-02T00:00:00Z', { min: 201, max: 250 });
      const svc = service();
      markDirty.mockImplementationOnce(async () => {
        void svc.stop(); // the shutdown begins during the first slice ...
      });
      await svc.tick();
      expect(markDirty).toHaveBeenCalledTimes(1); // ... and the second is not started
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });
  });

  describe('the gauges', () => {
    it('sets syncer_nft_state_lag_ledgers and syncer_nft_dirty_ledgers at the end of every run', async () => {
      committed = 5000;
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      pages.set(700, { nfts: [nft(2)], upTo: 5000 });
      dirty = [mark(100, 199), mark(300, 304)];
      await service().tick();
      // the cursor reached the head, and the dirty ranges were worked off before the gauges were read
      expect(metrics.nftStateLagLedgers.set.mock.calls).toEqual([[0]]);
      expect(metrics.nftDirtyLedgers.set.mock.calls).toEqual([[0]]);
    });

    it('the lag is the head less the cursor, which only moves past a batch that was written', async () => {
      committed = 5000;
      rebuildMs = 400;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 100, { nfts: [nft(i)], upTo: 600 + i * 100 });
      const svc = service({ budgetsMs: { nft_state: 1000 } });
      await svc.tick();
      // three batches: the cursor is at 800
      expect(lastLag()).toBe(5000 - 800);
      await tickAt(svc, 1);
      expect(lastLag()).toBe(5000 - 1100);
      committed = 6000;
      await tickAt(svc, 2);
      expect(lastLag()).toBe(6000 - 1400);
    });

    it('the dirty gauge is what nft_dirty holds when the run ended', async () => {
      rebuildMs = 2000;
      dirty = [mark(1000, 25_999), mark(40_000, 40_009)];
      touched.set(1500, [nft(1)]);
      await service({ budgetsMs: { nft_state: 1000 } }).tick();
      // one step of the first range was done: 11,000 .. 25,999 and 10 ledgers are left
      expect(metrics.nftDirtyLedgers.set.mock.calls.at(-1)).toEqual([15_000 + 10]);
    });

    it('a failing read of a gauge is counted and logged, and does not fail the run', async () => {
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      dirtyLedgers.mockRejectedValueOnce(new Error('DB::Exception: no such table'));
      await service().tick();
      expect(rebuilt()).toEqual([[1]]);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'nft_state' }]]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('reading the gauges'));
      expect(jobsRun()).toEqual(['nft_state', 'stats_live', 'stats_dirty', 'nft_collections']);
    });

    it('sets nothing, and reads nothing, once the shutdown has begun', async () => {
      const svc = service();
      rebuild.mockImplementation(async () => {
        void svc.stop();
        return { written: 1, removed: 0, collections: [] };
      });
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      await svc.tick();
      expect(head).not.toHaveBeenCalled();
      expect(metrics.nftStateLagLedgers.set).not.toHaveBeenCalled();
      expect(metrics.nftDirtyLedgers.set).not.toHaveBeenCalled();
    });
  });

  describe('on its own (the collections of the rebuilds and the lag)', () => {
    /** A runner over a hand-made context: the clock is the fake one, the budget is the deadline of the tick. */
    function runner(onRebuilt: (keys: CollectionKey[]) => void): { runner: NftStateJobRunner; stop: () => void } {
      let closing = false;
      const ctx: AggregatorJobContext = {
        ch: ch.asService(),
        logger,
        metrics: undefined,
        budgets: {} as AggregatorJobContext['budgets'],
        clock: () => Date.now(),
        closing: () => closing,
        mayStartSet: (tick) => !closing && Date.now() < tick.deadline,
        failed: (job, err) => logger.error(`${job}: ${String(err)}`),
        versionsOf: async () => new Map(),
        latestCloseTime: async () => undefined,
        announceBackfill: () => undefined,
      };
      const nfts = { rates: RATES, dailyRates: {} as DailyRates };
      return {
        runner: new NftStateJobRunner(ctx, nfts, functions(), onRebuilt),
        stop: () => {
          closing = true;
        },
      };
    }
    const tick = () => ({ now: NOW, deadline: Date.now() + 3000, signal: new AbortController().signal });

    it('hands the collections of every rebuild to onRebuilt: the live batches, the steps of a dirty range and the retries', async () => {
      const handed: CollectionKey[][] = [];
      const { runner: job } = runner((keys) => handed.push(keys));
      pages.set(500, { nfts: [nft(1), nft(2), nft(4)], upTo: 700 });
      pages.set(700, { nfts: [nft(3)], upTo: 900 });
      dirty = [mark(100, 200)];
      touched.set(150, [nft(5)]);
      await job.run(tick());
      expect(handed).toEqual([
        // nft(1) and nft(4) are of the taxon 1, nft(2) of 2
        [
          { issuer: ISSUER, taxon_key: 1 },
          { issuer: ISSUER, taxon_key: 2 },
        ],
        [{ issuer: ISSUER, taxon_key: 0 }],
        [{ issuer: ISSUER, taxon_key: 2 }],
      ]);

      // a retry hands its collection on as well
      handed.length = 0;
      pages.set(900, { nfts: [nft(6), nft(7)], upTo: 950 });
      failing.add(7);
      await job.run(tick());
      expect(handed).toEqual([[{ issuer: ISSUER, taxon_key: 0 }]]); // nft(6) only: nft(7) failed and is set aside
      failing.clear();
      jest.setSystemTime(Date.now() + NFT_RETRY_MS);
      await job.run(tick());
      expect(handed).toEqual([[{ issuer: ISSUER, taxon_key: 0 }], [{ issuer: ISSUER, taxon_key: 1 }]]);
    });

    it('does not hand on the collections of a rebuild that failed', async () => {
      const handed: CollectionKey[][] = [];
      const { runner: job } = runner((keys) => handed.push(keys));
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      failing.add(1);
      await expect(job.run(tick())).rejects.toThrow('memory limit');
      expect(handed).toEqual([]);
    });

    it('while its cursor is not known every ledger is behind it: the lag is the head', async () => {
      watermark.mockImplementation(() => new Promise<number>(() => undefined)); // a read that never answers
      const { runner: job } = runner(() => undefined);
      expect(job.lag).toBeUndefined();
      committed = 1200;
      await job.run(tick());
      expect(job.lag).toBe(1200);
      // it is not read again while that one is out
      await job.run(tick());
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(job.lag).toBe(1200);
    });

    it('knows its lag only once it has a cursor and a head, and the lag is never below 0', async () => {
      const { runner: job } = runner(() => undefined);
      expect(job.lag).toBeUndefined();
      committed = 1200;
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      pages.set(700, { nfts: [], upTo: 700 });
      await job.run(tick());
      expect(job.lag).toBe(1200 - 700);
      committed = 300; // the head cannot be below the cursor; it is not a negative lag if it ever is read so
      await job.run(tick());
      expect(job.lag).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('starts nothing once it has begun: no watermark, no read, no rebuild', async () => {
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      dirty = [mark(100, 200)];
      const svc = service();
      await svc.stop();
      await svc.tick();
      for (const fn of [watermark, changedSince, inLedgers, rebuild, oldestDirty, head])
        expect(fn).not.toHaveBeenCalled();
    });

    it('hands the signal of the shutdown to the batch in flight and starts no batch after it', async () => {
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      pages.set(700, { nfts: [nft(2)], upTo: 900 });
      let signalOfBatch: AbortSignal | undefined;
      let release!: () => void;
      rebuild.mockImplementationOnce(
        (_c: unknown, _n: NftKey[], options?: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            signalOfBatch = options?.signal;
            release = () => resolve({ written: 1, removed: 0, collections: [] });
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
      expect(rebuilt()).toEqual([[1]]);
      expect(changedSince).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('a batch that was aborted at shutdown is neither an error nor counted', async () => {
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      const svc = service();
      rebuild.mockImplementation(async () => {
        void svc.stop();
        throw new NftRebuildAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      pages.set(500, { nfts: [nft(1)], upTo: 700 });
      const svc = service();
      rebuild.mockImplementation(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'nft_state' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });

    it('stops starting batches past its budget and after the shutdown began', async () => {
      rebuildMs = 600;
      for (let i = 0; i < 6; i++) pages.set(500 + i * 10, { nfts: [nft(i)], upTo: 510 + i * 10 });
      const svc = service({ budgetsMs: { nft_state: 1000 } });
      await svc.tick();
      // batches start at 0 and 600 ms; the third would start at 1200 ms, past the budget
      expect(rebuilt()).toEqual([[0], [1]]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('nft_state reached its budget'));

      // the shutdown begins in the middle of the next tick's first batch: no batch starts after it
      rebuild.mockImplementationOnce(async (_c: unknown, nfts: NftKey[]) => {
        void svc.stop();
        return { written: nfts.length, removed: 0, collections: [] };
      });
      await tickAt(svc, 1);
      expect(rebuilt().slice(2)).toEqual([[2]]);
    });
  });
});
