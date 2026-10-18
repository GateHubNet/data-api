import { AmmPoolsRecomputeAborted, MarketsConfig, RatesService } from '@gatehub/data-api-shared';
import { FakeClickHouse, iso, NOW, NOW_SECONDS, QUIET, unix } from '../../test/aggregator-fakes';
import {
  AGGREGATOR_AMM_POOLS_BUDGET_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AggregatorOptions,
  AggregatorService,
} from './aggregator.service';
import {
  AMM_POOL_MAX_RETRY_MS,
  AMM_POOL_RETRY_MS,
  AMM_POOLS_BATCH,
  MAX_ISOLATED_POOLS_PER_BATCH,
} from './amm-pools.job-runner';

/**
 * The `amm_pools` job (`AmmPoolsJobRunner`), driven through the `AggregatorService` it runs in: the cursor, the halving of a
 * failing batch, the retries, the budget, the hook of `agg_dirty` and the shutdown.
 */

describe('AggregatorService amm_pools job', () => {
  const RATES = { nativeCurrency: 'XRP' } as RatesService;
  const MARKETS: MarketsConfig = { version: 4, tradeMarkets: [], paymentCurrencies: [] };
  /** The ledger the persistent watermark of the job is at when the process starts. */
  const START_LEDGER = 500;

  let ch: FakeClickHouse;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
    aggregatorStatsLagSeconds: { set: jest.Mock };
  };
  const created: AggregatorService[] = [];
  /** What happened, in order. */
  let events: string[];
  let statsRecompute: jest.Mock;
  let watermark: jest.Mock;
  let changedSince: jest.Mock;
  let closedIn: jest.Mock;
  let recomputePools: jest.Mock;
  /** What `poolsChangedSince` answers for the ledger it is asked from (nothing, and the same ledger, for any other). */
  let pages: Map<number, { accounts: string[]; upTo: number }>;
  /** The pools of the slice that starts at an instant (ISO), for the agg_dirty hook. */
  let slicePools: Map<string, string[]>;
  /** How long (fake milliseconds) the recompute of a batch of pools takes. */
  let poolMs: number;
  /** The pools the fake recompute fails on, whatever batch they are in. */
  let failing: Set<string>;
  /** The pools of the batches that the fake recompute did write, in order. */
  let done: string[];

  const mark = (from: string, to: string, createdMs = 1000) => ({ from: unix(from), to: unix(to), created: createdMs });
  const jobsRun = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const batches = (): string[][] => recomputePools.mock.calls.map(([, , accounts]) => accounts);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
    };
    events = [];
    pages = new Map();
    slicePools = new Map();
    poolMs = 0;
    failing = new Set();
    done = [];
    statsRecompute = jest.fn(async (_ch: unknown, from: Date) => {
      events.push(`stats ${iso(from.getTime() / 1000)}`);
      return 1;
    });
    watermark = jest.fn(async () => START_LEDGER);
    changedSince = jest.fn(async (_ch: unknown, ledger: number) => {
      events.push(`changed ${ledger}`);
      return pages.get(ledger) ?? { accounts: [], upTo: ledger };
    });
    closedIn = jest.fn(
      async (_ch: unknown, _rates: unknown, from: Date) => slicePools.get(iso(from.getTime() / 1000)) ?? [],
    );
    recomputePools = jest.fn(async (_ch: unknown, _rates: unknown, accounts: string[]) => {
      events.push(`pools ${accounts.join(',')}`);
      if (poolMs > 0) jest.setSystemTime(Date.now() + poolMs);
      const bad = accounts.filter((a) => failing.has(a));
      if (bad.length > 0) throw new Error(`DB::Exception: memory limit on pool ${bad[0]}`);
      done.push(...accounts);
      return accounts.length;
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

  function service(options: AggregatorOptions = {}): AggregatorService {
    const svc = new AggregatorService(ch.asService(), metrics as never, { register: jest.fn() } as never, {
      logger,
      recompute: statsRecompute,
      ammPools: { rates: RATES },
      ammPoolsFunctions: { watermark, changedSince, poolsClosedIn: closedIn, recompute: recomputePools },
      ...options,
    });
    created.push(svc);
    return svc;
  }

  describe('the job in the tick', () => {
    it('comes after volume_daily and before stats_live, with the volume jobs and without them', async () => {
      const volumeFunctions = {
        computeLiveSet: jest.fn(async () => 0),
        computeDailySet: jest.fn(async () => 0),
        daysDone: jest.fn(async () => new Set<string>()),
        liveVersions: jest.fn(async () => new Map<string, number>()),
        dailyVersions: jest.fn(async () => new Map<string, number>()),
      };
      await service({ volumes: { rates: RATES, markets: MARKETS }, volumeFunctions }).tick();
      expect(jobsRun()).toEqual([
        'volume_live',
        'volume_daily',
        'amm_pools',
        'stats_live',
        'stats_dirty',
        'volume_backfill',
      ]);

      metrics.aggregatorRunsTotal.inc.mockClear();
      await service().tick();
      expect(jobsRun()).toEqual(['amm_pools', 'stats_live', 'stats_dirty']);
    });

    it('is off without the option: nothing is asked of the AMM functions, and a dirty range is only the stats', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      slicePools.set('2026-05-01T00:00:00Z', ['rA']);
      await service({ ammPools: undefined }).tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      for (const fn of [watermark, changedSince, closedIn, recomputePools]) expect(fn).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('has a budget of 3 s, which is not the live or the dirty one', () => {
      expect(AGGREGATOR_AMM_POOLS_BUDGET_MS).toBe(3000);
      expect(AMM_POOLS_BATCH).toBeGreaterThan(0);
    });
  });

  describe('the watermark', () => {
    it('is read once, when the first tick starts, and the job goes on from it', async () => {
      pages.set(500, { accounts: ['rA', 'rB'], upTo: 700 });
      pages.set(700, { accounts: ['rC'], upTo: 900 });
      const svc = service();
      await svc.tick();
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(watermark).toHaveBeenCalledWith(ch);
      expect(changedSince.mock.calls.map(([, ledger, limit]) => [ledger, limit])).toEqual([
        [500, AMM_POOLS_BATCH],
        [700, AMM_POOLS_BATCH],
        [900, AMM_POOLS_BATCH],
      ]);
      expect(batches()).toEqual([['rA', 'rB'], ['rC']]);
      // every recompute gets the database, the rates of the network and the shutdown signal
      expect(recomputePools.mock.calls[0][0]).toBe(ch);
      expect(recomputePools.mock.calls[0][1]).toBe(RATES);
      expect(recomputePools.mock.calls[0][3]).toEqual({ signal: expect.any(AbortSignal) });

      // the next tick starts where this one ended, without reading the watermark again
      pages.set(900, { accounts: ['rD'], upTo: 1000 });
      jest.setSystemTime(NOW_SECONDS * 1000 + 60_000);
      await svc.tick();
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(changedSince.mock.calls.slice(3).map(([, ledger]) => ledger)).toEqual([900, 1000]);
      expect(batches()).toEqual([['rA', 'rB'], ['rC'], ['rD']]);
    });

    it('advances after each batch is written, never before: a batch is recomputed, then the cursor moves', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      pages.set(700, { accounts: ['rB'], upTo: 900 });
      await service().tick();
      expect(events.filter((e) => !e.startsWith('stats'))).toEqual([
        'changed 500',
        'pools rA',
        'changed 700',
        'pools rB',
        'changed 900',
      ]);
    });

    it('does not move when nothing changed, and does not recompute anything', async () => {
      await service().tick();
      expect(changedSince).toHaveBeenCalledTimes(1);
      expect(recomputePools).not.toHaveBeenCalled();
      expect(jobsRun()).toContain('amm_pools');
    });

    it('does not ask for the same pools for ever when an answer does not move the cursor', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 500 });
      await service().tick();
      expect(batches()).toEqual([['rA']]);
      expect(changedSince).toHaveBeenCalledTimes(1);
    });

    it('a failing read of the watermark is a failed job, the stats still run, and the next tick reads it again', async () => {
      watermark.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      const svc = service();
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      expect(recomputePools).not.toHaveBeenCalled();

      await svc.tick();
      expect(watermark).toHaveBeenCalledTimes(2);
      expect(batches()).toEqual([['rA']]);
    });
  });

  describe('failures', () => {
    const POOLS5 = ['rA', 'rB', 'rC', 'rD', 'rE'];
    const errors = (): number => metrics.aggregatorErrorsTotal.inc.mock.calls.length;
    /** A tick `minutes` after the first one. */
    const tickAt = async (svc: AggregatorService, minutes: number): Promise<void> => {
      jest.setSystemTime(NOW_SECONDS * 1000 + minutes * 60_000);
      await svc.tick();
    };

    it('a batch that fails as a whole is the failure of the job: the cursor stays behind it, nothing is set aside, and the next tick does it again', async () => {
      pages.set(500, { accounts: POOLS5, upTo: 700 });
      pages.set(700, { accounts: ['rF'], upTo: 900 });
      // more pools than the isolation takes for a cause of its own
      for (const pool of POOLS5) failing.add(pool);
      expect(POOLS5.length).toBeGreaterThan(MAX_ISOLATED_POOLS_PER_BATCH);
      const svc = service();
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('amm_pools'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      // the jobs after it still ran
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);
      expect(done).toEqual([]);

      failing.clear();
      await tickAt(svc, 1);
      // the batch of 500 is the one done again: the cursor was at 500, and nothing was set aside to wait
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700, 900]);
      expect(done).toEqual([...POOLS5, 'rF']);
      expect(jobsRun()).toContain('amm_pools');
      expect(errors()).toBe(1);
    });

    it('a failing read of what changed is a failure of the job as well', async () => {
      changedSince.mockRejectedValueOnce(new Error('DB::Exception: no such table'));
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no such table'));
    });

    it('moves the cursor over ledgers with nothing to rebuild: an answer without pools still says how far it is complete', async () => {
      pages.set(500, { accounts: [], upTo: 900 });
      pages.set(900, { accounts: ['rA'], upTo: 950 });
      const svc = service();
      await svc.tick();
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);
      expect(recomputePools).not.toHaveBeenCalled();
      await tickAt(svc, 1);
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 900, 950]);
      expect(batches()).toEqual([['rA']]);
    });

    describe('one pool that fails every time (Ruling R-A15)', () => {
      it('is found by halving the batch and set aside; the other pools of its batch and the later batches are done', async () => {
        pages.set(500, { accounts: POOLS5, upTo: 700 });
        pages.set(700, { accounts: ['rF'], upTo: 900 });
        failing.add('rC');
        await service().tick();
        // the batch, its first half (three), that half's first half, the pool alone, and the other half of the batch
        expect(batches()).toEqual([POOLS5, ['rA', 'rB', 'rC'], ['rA', 'rB'], ['rC'], ['rD', 'rE'], ['rF']]);
        expect(done).toEqual(['rA', 'rB', 'rD', 'rE', 'rF']);
        // the cursor passed the batch, and the job ran to the end
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700, 900]);
        expect(jobsRun()).toEqual(['amm_pools', 'stats_live', 'stats_dirty']);
        // one error, for the pool, and not one for the batch
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rC'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      });

      it('is found even when it is the first of the batch, whose halves all fail until the pool is alone', async () => {
        pages.set(500, { accounts: POOLS5, upTo: 700 });
        failing.add('rA');
        await service().tick();
        expect(done).toEqual(['rB', 'rC', 'rD', 'rE']);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);
        expect(errors()).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rA'));
      });

      it('up to three pools of a batch are set aside, a fourth makes it the failure of the job', async () => {
        pages.set(500, { accounts: POOLS5, upTo: 700 });
        for (const pool of ['rA', 'rC', 'rE']) failing.add(pool);
        expect(MAX_ISOLATED_POOLS_PER_BATCH).toBe(3);
        const svc = service();
        await svc.tick();
        expect(done).toEqual(['rB', 'rD']);
        expect(errors()).toBe(3);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);

        // four in a batch: the cursor stays
        pages.set(700, { accounts: ['rF', 'rG', 'rH', 'rI'], upTo: 900 });
        for (const pool of ['rF', 'rG', 'rH', 'rI']) failing.add(pool);
        changedSince.mockClear();
        await tickAt(svc, 1);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([700]);
        expect(done).toEqual(['rB', 'rD']);
        expect(errors()).toBe(4);
      });

      it('is tried again after five minutes, then after twice as long each time up to an hour, and forgotten once it works', async () => {
        pages.set(500, { accounts: ['rA', 'rC'], upTo: 700 });
        failing.add('rC');
        const svc = service();
        const retries = (): number => batches().filter((b) => b.length === 1 && b[0] === 'rC').length;
        await svc.tick();
        expect(retries()).toBe(1);
        expect(errors()).toBe(1);
        expect([AMM_POOL_RETRY_MS, AMM_POOL_MAX_RETRY_MS]).toEqual([5 * 60_000, 60 * 60_000]);

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
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rC'));

        // it works at last: rebuilt, and not asked for again
        failing.clear();
        await tickAt(svc, at + 60);
        expect(done).toEqual(['rA', 'rC']);
        const before = recomputePools.mock.calls.length;
        await tickAt(svc, at + 600);
        expect(recomputePools.mock.calls.length).toBe(before);
        expect(errors()).toBe(count);
      });

      it('is left out of the batches that come while it waits, and rebuilt by its retry with everything it has by then', async () => {
        pages.set(500, { accounts: ['rB', 'rC'], upTo: 700 });
        pages.set(700, { accounts: ['rC', 'rD'], upTo: 900 }); // it changed again
        failing.add('rC');
        const svc = service();
        await svc.tick();
        expect(batches()).toEqual([['rB', 'rC'], ['rB'], ['rC'], ['rD']]);
        expect(done).toEqual(['rB', 'rD']);

        failing.clear();
        await tickAt(svc, 5);
        expect(batches().slice(4)).toEqual([['rC']]);
        expect(done).toEqual(['rB', 'rD', 'rC']);
      });

      it('has its retry after the new work of the tick', async () => {
        pages.set(500, { accounts: ['rB', 'rC'], upTo: 700 });
        failing.add('rC');
        const svc = service();
        await svc.tick();
        const first = batches().length;

        failing.clear();
        pages.set(700, { accounts: ['rD'], upTo: 900 });
        await tickAt(svc, 5);
        expect(batches().slice(first)).toEqual([['rD'], ['rC']]);
      });

      it('has its retry in a tick whose live part failed', async () => {
        pages.set(500, { accounts: ['rB', 'rC'], upTo: 700 });
        failing.add('rC');
        const svc = service();
        await svc.tick();
        expect(errors()).toBe(1);

        // when the retry is due, a batch fails as a whole; the pool that was set aside works again
        failing.clear();
        for (const pool of POOLS5) if (pool !== 'rC') failing.add(pool);
        pages.set(700, { accounts: POOLS5.filter((p) => p !== 'rC'), upTo: 900 });
        await tickAt(svc, 5);
        expect(errors()).toBe(2); // the failure of the job
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
        expect(done).toEqual(['rB', 'rC']);
      });

      it('the retries are under the budget of the job: a slow one uses it up, and the next waits for the next tick', async () => {
        pages.set(500, { accounts: ['rA', 'rC', 'rE'], upTo: 700 });
        failing.add('rC');
        failing.add('rE');
        const svc = service({ budgetsMs: { amm_pools: 1000 } });
        await svc.tick();
        expect(errors()).toBe(2);

        failing.clear();
        poolMs = 1100;
        await tickAt(svc, 5);
        expect(done).toEqual(['rA', 'rC']);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_pools reached its budget'));

        await tickAt(svc, 6);
        expect(done).toEqual(['rA', 'rC', 'rE']);
      });

      it('is not set aside by the shutdown: an aborted batch is neither an error nor a pool to retry', async () => {
        pages.set(500, { accounts: POOLS5, upTo: 700 });
        const svc = service();
        recomputePools.mockImplementation(async () => {
          void svc.stop();
          throw new AmmPoolsRecomputeAborted();
        });
        await svc.tick();
        expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        expect(recomputePools).toHaveBeenCalledTimes(1); // no halving
      });
    });

    describe('a halving that does not fit in the budget of one tick', () => {
      const MANY = Array.from({ length: AMM_POOLS_BATCH }, (_, i) => `r${String(i).padStart(3, '0')}`);

      it('goes on where it stopped at the next ticks, and the cursor moves on once the failing pool is found', async () => {
        pages.set(500, { accounts: MANY, upTo: 700 });
        failing.add('r137');
        poolMs = 2000; // two calls of a tick use the 3 s of the budget
        const svc = service();
        let ticks = 0;
        while (!changedSince.mock.calls.some(([, ledger]) => ledger === 700) && ticks < 40) {
          await tickAt(svc, ticks++);
        }
        // about two recomputes for each of the log2(200) levels, two a tick
        expect(ticks).toBeLessThanOrEqual(12);
        expect(changedSince.mock.calls.filter(([, ledger]) => ledger === 500)).toHaveLength(1);
        // every other pool was rebuilt, once, and the failing one is set aside and counted
        expect([...done].sort()).toEqual(MANY.filter((p) => p !== 'r137'));
        expect(errors()).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool r137'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_pools reached its budget'));
      });

      it('a batch that cannot be halved to a pool because the whole database fails is dropped once four pools fail', async () => {
        pages.set(500, { accounts: MANY, upTo: 700 });
        for (const pool of MANY) failing.add(pool);
        poolMs = 2000;
        const svc = service();
        for (let i = 0; i < 40 && errors() === 0; i++) await tickAt(svc, i);
        expect(errors()).toBe(1);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger).every((ledger) => ledger === 500)).toBe(true);
        expect(done).toEqual([]);
      });
    });

    describe('a batch in which everything fails (the database)', () => {
      it('is the failure of the job, not a reason to set its pools aside: they are, if they fail alone again next time', async () => {
        pages.set(500, { accounts: ['rA', 'rB'], upTo: 700 });
        failing.add('rA');
        failing.add('rB');
        const svc = service();
        await svc.tick();
        expect(batches()).toEqual([['rA', 'rB'], ['rA'], ['rB']]);
        expect(errors()).toBe(1);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);

        // the same batch fails the same way: now the pools are set aside, and the cursor goes on
        await tickAt(svc, 1);
        expect(errors()).toBe(3);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700]);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rA'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rB'));
      });

      it('when the database comes back the next tick does the batch, and nothing waits for a retry', async () => {
        pages.set(500, { accounts: ['rA'], upTo: 700 });
        failing.add('rA');
        const svc = service();
        await svc.tick();
        expect(errors()).toBe(1);
        expect(done).toEqual([]);

        failing.clear();
        await tickAt(svc, 1);
        expect(done).toEqual(['rA']);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700]);
        // nothing was set aside: no retry comes
        const calls = recomputePools.mock.calls.length;
        await tickAt(svc, 600);
        expect(recomputePools.mock.calls.length).toBe(calls);
        expect(errors()).toBe(1);
      });

      it('a pool that fails alone while the rest of its batch works is set aside at once', async () => {
        pages.set(500, { accounts: ['rA', 'rB'], upTo: 700 });
        failing.add('rA');
        await service().tick();
        expect(done).toEqual(['rB']);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);
      });
    });

    describe('a batch that fails as a whole although each half works', () => {
      it('is warned about and counted once, and the cursor goes on', async () => {
        pages.set(500, { accounts: ['rA', 'rB', 'rC', 'rD'], upTo: 700 });
        recomputePools.mockImplementation(async (_c: unknown, _r: unknown, accounts: string[]) => {
          if (accounts.length >= 4) throw new Error('DB::Exception: too many pools for the memory limit');
          done.push(...accounts);
          return accounts.length;
        });
        await service().tick();
        expect(done).toEqual(['rA', 'rB', 'rC', 'rD']);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);
        expect(errors()).toBe(1);
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('as a whole'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('too many pools'));
      });

      it('counts a failure that led to no pool once, and none of those on the way to a pool', async () => {
        pages.set(500, { accounts: ['rA', 'rB', 'rC', 'rD', 'rE', 'rF', 'rG', 'rH'], upTo: 700 });
        failing.add('rH');
        recomputePools.mockImplementation(async (_c: unknown, _r: unknown, accounts: string[]) => {
          if (accounts.includes('rH')) throw new Error('DB::Exception: pool rH');
          if (accounts.length >= 4) throw new Error('DB::Exception: size');
          done.push(...accounts);
          return accounts.length;
        });
        await service().tick();
        // the batch, [E..H] and [G, H] fail on the way to rH; [A..D] fails for its size alone and its halves work
        expect(done).toEqual(['rA', 'rB', 'rC', 'rD', 'rE', 'rF', 'rG']);
        expect(errors()).toBe(2); // the pool, and the size
        expect(logger.warn.mock.calls.filter(([text]) => String(text).includes('as a whole'))).toHaveLength(1);
      });
    });
  });

  describe('the budget', () => {
    it('stops starting batches when the budget of the job is spent, says so, and goes on from the cursor next tick', async () => {
      poolMs = 400;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { accounts: [`r${i}`], upTo: 510 + i * 10 });
      const svc = service({ budgetsMs: { amm_pools: 1000 } });
      await svc.tick();
      // batches start at 0, 400 and 800 ms (inside the 1000 ms) and not at 1200
      expect(batches()).toEqual([['r0'], ['r1'], ['r2']]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_pools reached its budget'));
      // the other jobs of the tick were not held up
      expect(jobsRun()).toEqual(['amm_pools', 'stats_live', 'stats_dirty']);

      jest.setSystemTime(NOW_SECONDS * 1000 + 60_000);
      await svc.tick();
      expect(batches().slice(3)).toEqual([['r3'], ['r4'], ['r5']]);
    });

    it('is 3 s by default: a slow batch uses it up, and the stats still get the rest of the tick', async () => {
      poolMs = 10_000;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { accounts: [`r${i}`], upTo: 510 + i * 10 });
      await service().tick();
      expect(batches()).toEqual([['r0']]);
      expect(events.some((e) => e.startsWith('stats'))).toBe(true);
    });

    it('does not take more than the tick has left either', async () => {
      poolMs = 5000;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { accounts: [`r${i}`], upTo: 510 + i * 10 });
      await service({ tickBudgetMs: 4000, budgetsMs: { amm_pools: 100_000 } }).tick();
      expect(batches()).toEqual([['r0']]);
    });
  });

  describe('the pools of agg_dirty slices (the hook of stats_dirty)', () => {
    it('recomputes the pools with state rows in the slice, after its stats, and removes the range', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      slicePools.set('2026-05-01T22:00:00Z', ['rA', 'rB']);
      await service().tick();
      expect(closedIn).toHaveBeenCalledTimes(1);
      const [chArg, ratesArg, from, to] = closedIn.mock.calls[0];
      expect([chArg, ratesArg]).toEqual([ch, RATES]);
      expect([iso(from.getTime() / 1000), iso(to.getTime() / 1000)]).toEqual([
        '2026-05-01T22:00:00Z',
        '2026-05-02T03:00:00Z',
      ]);
      const at = events.indexOf('stats 2026-05-01T22:00:00Z');
      expect(events.slice(at, at + 2)).toEqual(['stats 2026-05-01T22:00:00Z', 'pools rA,rB']);
      expect(recomputePools.mock.calls.at(-1)?.[3]).toEqual({ signal: expect.any(AbortSignal) });
      expect(ch.dirty).toEqual([]);
    });

    it('a range of several days: each slice has its own pools', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-02T12:00:00Z')];
      slicePools.set('2026-05-01T00:00:00Z', ['rA']);
      slicePools.set('2026-05-02T00:00:00Z', ['rB']);
      await service().tick();
      expect(
        closedIn.mock.calls.map(([, , from, to]) => [iso(from.getTime() / 1000), iso(to.getTime() / 1000)]),
      ).toEqual([
        ['2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z'],
        ['2026-05-02T00:00:00Z', '2026-05-02T12:00:00Z'],
      ]);
      expect(batches()).toEqual([['rA'], ['rB']]);
      expect(ch.dirty).toEqual([]);
    });

    it('a slice with many pools is recomputed in batches', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      const many = Array.from({ length: AMM_POOLS_BATCH * 2 + 50 }, (_, i) => `r${String(i).padStart(4, '0')}`);
      slicePools.set('2026-05-01T00:00:00Z', many);
      await service().tick();
      expect(batches().map((b) => b.length)).toEqual([AMM_POOLS_BATCH, AMM_POOLS_BATCH, 50]);
      expect(batches().flat()).toEqual(many);
    });

    it('a slice without pools recomputes nothing, and the range is removed', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service().tick();
      expect(closedIn).toHaveBeenCalledTimes(1);
      expect(recomputePools).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('a pool that fails is set aside, not the slice: the others are done, the range is removed, and its retry comes later', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      slicePools.set('2026-05-01T22:00:00Z', ['rA', 'rB', 'rC']);
      failing.add('rB');
      const svc = service();
      await svc.tick();
      expect(done.sort()).toEqual(['rA', 'rC']);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools_dirty' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('amm_pools_dirty'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rB'));

      // the job of the live pools tries the pool again when its wait is over
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_POOL_RETRY_MS);
      await svc.tick();
      expect(done).toContain('rB');
    });

    it('a slice whose only pool fails is the failure of the slice first, and the pool is set aside when it fails again', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      slicePools.set('2026-05-01T22:00:00Z', ['rA']);
      failing.add('rA');
      const svc = service();
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);

      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rA'));
    });

    it('a slice most of whose pools fail keeps the range, counts the failure, and the next tick does it again', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      slicePools.set('2026-05-01T22:00:00Z', ['rA', 'rB', 'rC', 'rD', 'rE']);
      for (const pool of ['rA', 'rB', 'rC', 'rD', 'rE']) failing.add(pool);
      const svc = service();
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools_dirty' });

      failing.clear();
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(done).toEqual(['rA', 'rB', 'rC', 'rD', 'rE']);
    });

    it('a failure in the middle of a range keeps the progress: the range is narrowed to the slice that failed', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z')];
      slicePools.set('2026-05-01T00:00:00Z', ['rA']);
      const second = ['rB1', 'rB2', 'rB3', 'rB4', 'rB5'];
      slicePools.set('2026-05-02T00:00:00Z', second);
      for (const pool of second) failing.add(pool);
      await service().tick();
      expect(ch.dirty).toEqual([mark('2026-05-02T00:00:00Z', '2026-05-03T00:00:00Z')]);
    });

    it('a lookup of the pools of a slice that fails fails the slice the same way', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      closedIn.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools_dirty' });
      expect(ch.dirty).toHaveLength(1);
    });

    it('does not start a batch after the shutdown began, and the range stays', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      slicePools.set(
        '2026-05-01T00:00:00Z',
        Array.from({ length: AMM_POOLS_BATCH * 2 }, (_, i) => `r${String(i).padStart(4, '0')}`),
      );
      const svc = service();
      recomputePools.mockImplementationOnce(async (_c: unknown, _r: unknown, accounts: string[]) => {
        void svc.stop(); // the shutdown begins during the first batch ...
        return accounts.length;
      });
      await svc.tick();
      expect(recomputePools).toHaveBeenCalledTimes(1); // ... and the second is not started
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('a batch cut short by the shutdown is neither an error nor counted, and the range stays', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      slicePools.set('2026-05-01T00:00:00Z', ['rA']);
      const svc = service();
      recomputePools.mockImplementation(async () => {
        void svc.stop();
        throw new AmmPoolsRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
    });
  });

  describe('shutdown', () => {
    it('starts nothing once it has begun: no watermark, no read, no recompute', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      const svc = service();
      await svc.stop();
      await svc.tick();
      for (const fn of [watermark, changedSince, closedIn, recomputePools]) expect(fn).not.toHaveBeenCalled();
    });

    it('hands the signal of the shutdown to the batch in flight and starts no batch after it', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      pages.set(700, { accounts: ['rB'], upTo: 900 });
      let signalOfBatch: AbortSignal | undefined;
      let release!: () => void;
      recomputePools.mockImplementationOnce(
        (_c: unknown, _r: unknown, _a: string[], options?: { signal?: AbortSignal }) =>
          new Promise<number>((resolve) => {
            signalOfBatch = options?.signal;
            release = () => resolve(1);
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
      expect(batches()).toEqual([['rA']]);
      expect(changedSince).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('a batch that was aborted at shutdown is neither an error nor counted', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      const svc = service();
      recomputePools.mockImplementation(async () => {
        void svc.stop();
        throw new AmmPoolsRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      const svc = service();
      recomputePools.mockImplementation(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });
  });
});
