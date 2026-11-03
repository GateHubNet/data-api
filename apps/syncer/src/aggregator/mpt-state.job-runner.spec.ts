import { MPT_STATE_BATCH, MptStale, MptStateAborted, RatesService } from '@gatehub/data-api-shared';
import { FakeClickHouse, iso, NOW, NOW_SECONDS, QUIET, unix } from '../../test/aggregator-fakes';
import {
  AGGREGATOR_MPT_STATE_BUDGET_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AGGREGATOR_TICK_BUDGET_MS,
  AggregatorOptions,
  AggregatorService,
} from './aggregator.service';
import {
  MAX_ISOLATED_ISSUANCES_PER_BATCH,
  MPT_ISSUANCE_MAX_RETRY_MS,
  MPT_ISSUANCE_RETRY_MS,
} from './mpt-state.job-runner';

/**
 * The `mpt_state` job (`MptStateJobRunner`), driven through the `AggregatorService` it runs in: the cursor, the halving of a failing
 * batch, the retries, the budget, the gauge, the hook of `agg_dirty` and the shutdown. The shared functions are fakes; what they do
 * is `packages/shared/test/mpt-state-job.e2e-spec.ts`, and the two together on a real ClickHouse `apps/syncer/test/aggregator-mpt-state.e2e-spec.ts`.
 */

describe('AggregatorService mpt_state job', () => {
  const RATES = { nativeCurrency: 'XRP' } as RatesService;
  /** The ledger the persistent watermark of the job is at when the process starts. */
  const START_LEDGER = 500;
  /** The newest committed ledger. */
  const HEAD = 1000;

  let ch: FakeClickHouse;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
    aggregatorStatsLagSeconds: { set: jest.Mock };
    mptStateLagLedgers: { set: jest.Mock };
  };
  const created: AggregatorService[] = [];
  /** What happened, in order. */
  let events: string[];
  let statsRecompute: jest.Mock;
  /** How long (fake milliseconds) a slice of the stats takes: what a tick with no budget left for the job takes. */
  let statsMs: number;
  let head: jest.Mock;
  let watermark: jest.Mock;
  let changedSince: jest.Mock;
  let closedIn: jest.Mock;
  let rebuild: jest.Mock;
  /** What `mptIssuancesChangedSince` answers for the ledger it is asked from (nothing, and the same ledger, for any other). */
  let pages: Map<number, { issuances: MptStale[]; upTo: number }>;
  /** The issuances of the slice that starts at an instant (ISO), for the agg_dirty hook. */
  let sliceIssuances: Map<string, MptStale[]>;
  /** How long (fake milliseconds) the rebuild of a batch takes. */
  let rebuildMs: number;
  /** The issuances the fake rebuild fails on, whatever batch they are in. */
  let failing: Set<string>;
  /** The issuances of the batches that the fake rebuild did write, in order. */
  let done: string[];

  /** Issuances as a read of what changed names them: each with a holder of its own. */
  const stale = (...ids: string[]): MptStale[] => ids.map((id) => ({ id, holders: [`holder of ${id}`] }));
  const mark = (from: string, to: string, createdMs = 1000) => ({ from: unix(from), to: unix(to), created: createdMs });
  const jobsRun = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const batches = (): string[][] => rebuild.mock.calls.map(([, issuances]) => issuances.map((i: MptStale) => i.id));
  const cursors = (): number[] => changedSince.mock.calls.map(([, ledger]) => ledger);
  const errors = (): number => metrics.aggregatorErrorsTotal.inc.mock.calls.length;
  const gauge = (): number[] => metrics.mptStateLagLedgers.set.mock.calls.map(([value]) => value);
  const lastGauge = (): number => gauge()[gauge().length - 1];

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
      mptStateLagLedgers: { set: jest.fn() },
    };
    events = [];
    pages = new Map();
    sliceIssuances = new Map();
    rebuildMs = 0;
    statsMs = 0;
    failing = new Set();
    done = [];
    statsRecompute = jest.fn(async (_ch: unknown, from: Date) => {
      events.push(`stats ${iso(from.getTime() / 1000)}`);
      if (statsMs > 0) jest.setSystemTime(Date.now() + statsMs);
      return 1;
    });
    head = jest.fn(async () => HEAD);
    watermark = jest.fn(async () => START_LEDGER);
    changedSince = jest.fn(async (_ch: unknown, ledger: number) => {
      events.push(`changed ${ledger}`);
      return pages.get(ledger) ?? { issuances: [], upTo: ledger };
    });
    closedIn = jest.fn(
      async (_ch: unknown, _rates: unknown, from: Date) => sliceIssuances.get(iso(from.getTime() / 1000)) ?? [],
    );
    rebuild = jest.fn(async (_ch: unknown, issuances: MptStale[]) => {
      const ids = issuances.map((i) => i.id);
      events.push(`rebuild ${ids.join(',')}`);
      if (rebuildMs > 0) jest.setSystemTime(Date.now() + rebuildMs);
      const bad = ids.filter((id) => failing.has(id));
      if (bad.length > 0) throw new Error(`DB::Exception: memory limit on issuance ${bad[0]}`);
      done.push(...ids);
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
      mptState: { rates: RATES },
      mptStateFunctions: { head, watermark, changedSince, closedIn, rebuild },
      ...options,
    });
    created.push(svc);
    return svc;
  }

  /** A tick `minutes` after the first one. */
  const tickAt = async (svc: AggregatorService, minutes: number): Promise<void> => {
    jest.setSystemTime(NOW_SECONDS * 1000 + minutes * 60_000);
    await svc.tick();
  };

  describe('the job in the tick', () => {
    it('comes after stats_dirty, with a budget of 3 s', async () => {
      expect(AGGREGATOR_MPT_STATE_BUDGET_MS).toBe(3000);
      await service().tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty', 'mpt_state']);
    });

    it('is off without the option: nothing is asked of its functions, and a dirty range is only the stats', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceIssuances.set('2026-05-01T00:00:00Z', stale('A'));
      await service({ mptState: undefined }).tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      for (const fn of [head, watermark, changedSince, closedIn, rebuild]) expect(fn).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });
  });

  describe('the cursor', () => {
    it('is read once, when the first tick starts, and the job goes on from it at the head of each run', async () => {
      pages.set(500, { issuances: stale('A', 'B'), upTo: 700 });
      pages.set(700, { issuances: stale('C'), upTo: 900 });
      const svc = service();
      await svc.tick();
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(watermark).toHaveBeenCalledWith(ch);
      expect(changedSince.mock.calls.map(([, ledger, atHead, limit]) => [ledger, atHead, limit])).toEqual([
        [500, HEAD, MPT_STATE_BATCH],
        [700, HEAD, MPT_STATE_BATCH],
        [900, HEAD, MPT_STATE_BATCH],
      ]);
      expect(batches()).toEqual([['A', 'B'], ['C']]);
      // every rebuild gets the database, what the read named, the head and the signal of the shutdown
      expect(rebuild.mock.calls[0]).toEqual([ch, stale('A', 'B'), HEAD, { signal: expect.any(AbortSignal) }]);

      // the next tick starts where this one ended, at a head read again, without reading the watermark again
      head.mockImplementation(async () => HEAD + 5);
      pages.set(900, { issuances: stale('D'), upTo: HEAD + 5 });
      await tickAt(svc, 1);
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(head).toHaveBeenCalledTimes(2);
      expect(changedSince.mock.calls.slice(3).map(([, ledger, atHead]) => [ledger, atHead])).toEqual([
        [900, HEAD + 5],
        [HEAD + 5, HEAD + 5],
      ]);
      expect(rebuild.mock.calls[2][2]).toBe(HEAD + 5);
    });

    it('moves the cursor past a written batch only', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      pages.set(700, { issuances: stale('B'), upTo: 900 });
      await service().tick();
      expect(events.filter((e) => !e.startsWith('stats'))).toEqual([
        'changed 500',
        'rebuild A',
        'changed 700',
        'rebuild B',
        'changed 900',
      ]);
    });

    it('does not move past a batch that failed: the next tick does it again', async () => {
      pages.set(500, { issuances: stale('A', 'B', 'C', 'D', 'E'), upTo: 700 });
      pages.set(700, { issuances: stale('F'), upTo: 900 });
      for (const id of ['A', 'B', 'C', 'D', 'E']) failing.add(id);
      expect(failing.size).toBeGreaterThan(MAX_ISOLATED_ISSUANCES_PER_BATCH);
      const svc = service();
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'mpt_state' }]]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      expect(cursors()).toEqual([500]);
      expect(done).toEqual([]);

      failing.clear();
      await tickAt(svc, 1);
      expect(cursors()).toEqual([500, 500, 700, 900]);
      expect(done).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
      expect(errors()).toBe(1);
    });

    it('moves over ledgers with nothing to rebuild: an answer without issuances still says how far it is complete', async () => {
      pages.set(500, { issuances: [], upTo: 900 });
      pages.set(900, { issuances: stale('A'), upTo: 950 });
      const svc = service();
      await svc.tick();
      expect(cursors()).toEqual([500]);
      expect(rebuild).not.toHaveBeenCalled();
      await tickAt(svc, 1);
      expect(cursors()).toEqual([500, 900, 950]);
      expect(batches()).toEqual([['A']]);
    });

    it('does not ask for the same issuances for ever when an answer does not move the cursor', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 500 });
      await service().tick();
      expect(batches()).toEqual([['A']]);
      expect(changedSince).toHaveBeenCalledTimes(1);
    });

    it('a failing read of the watermark is a failed job, the stats still ran, and the next tick reads it again', async () => {
      watermark.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      const svc = service();
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'mpt_state' });
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      expect(rebuild).not.toHaveBeenCalled();

      await tickAt(svc, 1);
      expect(watermark).toHaveBeenCalledTimes(2);
      expect(batches()).toEqual([['A']]);
    });

    it('a failing read of the head or of what changed is a failure of the job as well', async () => {
      const svc = service();
      head.mockRejectedValueOnce(new Error('DB::Exception: no head'));
      await tickAt(svc, 0);
      changedSince.mockRejectedValueOnce(new Error('DB::Exception: no such table'));
      await tickAt(svc, 1);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'mpt_state' }], [{ job: 'mpt_state' }]]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no head'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no such table'));
    });
  });

  describe('syncer_mpt_state_lag_ledgers', () => {
    it('sets syncer_mpt_state_lag_ledgers to head minus cursor', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      const svc = service({ budgetsMs: { mpt_state: 1000 } });
      rebuildMs = 1100; // the budget ends after the first batch
      await svc.tick();
      expect(gauge()).toEqual([HEAD - 700]);

      rebuildMs = 0;
      pages.set(700, { issuances: [], upTo: HEAD });
      await tickAt(svc, 1);
      expect(lastGauge()).toBe(0);
    });

    it('sets it after a run that failed, from a cursor that stayed behind the batch', async () => {
      pages.set(500, { issuances: stale('A', 'B', 'C', 'D', 'E'), upTo: 700 });
      for (const id of ['A', 'B', 'C', 'D', 'E']) failing.add(id);
      const svc = service();
      await svc.tick();
      expect(errors()).toBe(1);
      expect(gauge()).toEqual([HEAD - START_LEDGER]);

      // a lag that grows with the head, and not the value it had
      head.mockImplementation(async () => HEAD + 60);
      await tickAt(svc, 1);
      expect(lastGauge()).toBe(HEAD + 60 - START_LEDGER);
    });

    it('sets it after a run with no budget, which attempts nothing', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      await service({ budgetsMs: { mpt_state: 0 } }).tick();
      expect(changedSince).not.toHaveBeenCalled();
      expect(rebuild).not.toHaveBeenCalled();
      expect(gauge()).toEqual([HEAD - START_LEDGER]);
      expect(jobsRun()).toContain('mpt_state');
    });

    it('sets it after a run at a late place in a spent tick, which also attempts nothing', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      statsMs = AGGREGATOR_TICK_BUDGET_MS + 1000;
      await service().tick();
      expect(rebuild).not.toHaveBeenCalled();
      expect(gauge()).toEqual([HEAD - START_LEDGER]);
    });

    it('sets it from the last head when the read of the head fails, and is not set before the job has a cursor', async () => {
      const svc = service();
      // no cursor: there is no lag to tell, and a label-less gauge reads 0 until the first run that has one
      watermark.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      await tickAt(svc, 0);
      expect(gauge()).toEqual([]);

      await tickAt(svc, 1);
      expect(gauge()).toEqual([HEAD - START_LEDGER]);

      head.mockRejectedValueOnce(new Error('DB::Exception: down'));
      await tickAt(svc, 2);
      expect(gauge()).toEqual([HEAD - START_LEDGER, HEAD - START_LEDGER]);
    });

    it('is never below 0: a head that a recovery took back below the cursor', async () => {
      pages.set(500, { issuances: [], upTo: HEAD });
      const svc = service();
      await svc.tick();
      head.mockImplementation(async () => HEAD - 10);
      await tickAt(svc, 1);
      expect(lastGauge()).toBe(0);
    });
  });

  describe('one issuance that fails every time', () => {
    const FIVE = ['A', 'B', 'C', 'D', 'E'];

    it('halves a failing batch and sets aside the issuance that fails alone', async () => {
      pages.set(500, { issuances: stale(...FIVE), upTo: 700 });
      pages.set(700, { issuances: stale('F'), upTo: 900 });
      failing.add('C');
      await service().tick();
      // the batch, its first half (three), that half's first half, the issuance alone, and the other half of the batch
      expect(batches()).toEqual([FIVE, ['A', 'B', 'C'], ['A', 'B'], ['C'], ['D', 'E'], ['F']]);
      expect(done).toEqual(['A', 'B', 'D', 'E', 'F']);
      // the cursor passed the batch, and the job ran to the end
      expect(cursors()).toEqual([500, 700, 900]);
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty', 'mpt_state']);
      // one error, for the issuance, and not one for the batch
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'mpt_state' }]]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance C, set aside'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
    });

    it('sets aside up to three issuances of a batch, and a fourth makes it the failure of the job', async () => {
      pages.set(500, { issuances: stale(...FIVE), upTo: 700 });
      for (const id of ['A', 'C', 'E']) failing.add(id);
      expect(MAX_ISOLATED_ISSUANCES_PER_BATCH).toBe(3);
      const svc = service();
      await svc.tick();
      expect(done).toEqual(['B', 'D']);
      expect(errors()).toBe(3);
      expect(cursors()).toEqual([500, 700]);

      pages.set(700, { issuances: stale('F', 'G', 'H', 'I'), upTo: 900 });
      for (const id of ['F', 'G', 'H', 'I']) failing.add(id);
      changedSince.mockClear();
      await tickAt(svc, 1);
      expect(cursors()).toEqual([700]);
      expect(errors()).toBe(4);
    });

    it('tries a set-aside issuance again after 5 minutes, then 10', async () => {
      pages.set(500, { issuances: stale('A', 'C'), upTo: 700 });
      failing.add('C');
      const svc = service();
      const retries = (): number => batches().filter((b) => b.length === 1 && b[0] === 'C').length;
      await svc.tick();
      expect(retries()).toBe(1);
      expect(errors()).toBe(1);
      expect([MPT_ISSUANCE_RETRY_MS, MPT_ISSUANCE_MAX_RETRY_MS]).toEqual([5 * 60_000, 60 * 60_000]);

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

      // it works at last: rebuilt, and not asked for again
      failing.clear();
      await tickAt(svc, at + 60);
      expect(done).toEqual(['A', 'C']);
      const before = rebuild.mock.calls.length;
      await tickAt(svc, at + 600);
      expect(rebuild.mock.calls.length).toBe(before);
      expect(errors()).toBe(count);
    });

    it('holds only its ID for the retry: the rebuild reads what was touched while it waited', async () => {
      pages.set(500, { issuances: stale('B', 'C'), upTo: 700 });
      pages.set(700, { issuances: stale('C', 'D'), upTo: 900 }); // touched again while it waits: the batch leaves it out
      failing.add('C');
      const svc = service();
      await svc.tick();
      expect(batches()).toEqual([['B', 'C'], ['B'], ['C'], ['D']]);
      expect(done).toEqual(['B', 'D']);

      failing.clear();
      rebuild.mockClear();
      await tickAt(svc, 5);
      expect(rebuild.mock.calls).toEqual([[ch, [{ id: 'C', holders: [] }], HEAD, { signal: expect.any(AbortSignal) }]]);
      expect(done).toEqual(['B', 'D', 'C']);
    });

    it('has its retry after the new work of the tick, and in a tick whose live part failed', async () => {
      pages.set(500, { issuances: stale('B', 'C'), upTo: 700 });
      failing.add('C');
      const svc = service();
      await svc.tick();
      const first = batches().length;

      failing.clear();
      pages.set(700, { issuances: stale('D'), upTo: 900 });
      changedSince.mockRejectedValueOnce(new Error('DB::Exception: no such table'));
      await tickAt(svc, 5);
      expect(batches().slice(first)).toEqual([['C']]);
      expect(errors()).toBe(2); // the set-aside, and the failure of the job
    });

    it('its retries are under the budget of the job: a slow one uses it up, and the next waits for the next tick', async () => {
      pages.set(500, { issuances: stale('A', 'C', 'E'), upTo: 700 });
      failing.add('C');
      failing.add('E');
      const svc = service({ budgetsMs: { mpt_state: 1000 } });
      await svc.tick();
      expect(errors()).toBe(2);

      failing.clear();
      rebuildMs = 1100;
      await tickAt(svc, 5);
      expect(done).toEqual(['A', 'C']);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mpt_state reached its budget'));

      await tickAt(svc, 6);
      expect(done).toEqual(['A', 'C', 'E']);
    });
  });

  describe('a halving that does not fit in the budget of one tick', () => {
    const MANY = Array.from({ length: MPT_STATE_BATCH }, (_, i) => `I${String(i).padStart(3, '0')}`);

    it('goes on where it stopped at the next ticks at the head of each, and the cursor moves on once the failing issuance is found', async () => {
      pages.set(500, { issuances: stale(...MANY), upTo: 700 });
      failing.add('I137');
      rebuildMs = 2000; // two calls of a tick use the 3 s of the budget
      const svc = service();
      let ticks = 0;
      while (!cursors().includes(700) && ticks < 40) await tickAt(svc, ticks++);
      expect(ticks).toBeGreaterThan(1);
      expect(cursors()).toEqual([500, 700]);
      expect(done).toHaveLength(MPT_STATE_BATCH - 1);
      // the failure is said at its first tick, and the set-aside at the end: not once a tick
      expect(errors()).toBe(2);
      expect(gauge().slice(0, 3)).toEqual([HEAD - 500, HEAD - 500, HEAD - 500]);
    });
  });

  describe('a batch in which everything fails (the database)', () => {
    it('is the failure of the job, not a reason to set its issuances aside: they are, if they fail alone again next time', async () => {
      pages.set(500, { issuances: stale('A', 'B'), upTo: 700 });
      failing.add('A');
      failing.add('B');
      const svc = service();
      await svc.tick();
      expect(batches()).toEqual([['A', 'B'], ['A'], ['B']]);
      expect(errors()).toBe(1);
      expect(cursors()).toEqual([500]);

      await tickAt(svc, 1);
      expect(errors()).toBe(3);
      expect(cursors()).toEqual([500, 500, 700]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance A, set aside'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance B, set aside'));
    });

    it('sets aside a lone poison issuance through a failure, an idle run and a repeat', async () => {
      pages.set(500, { issuances: stale('P'), upTo: 700 });
      failing.add('P');
      const svc = service();
      await tickAt(svc, 0); // the failure: it might be the database
      expect(errors()).toBe(1);
      expect(cursors()).toEqual([500]);
      expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('set aside'));

      statsMs = AGGREGATOR_TICK_BUDGET_MS + 1000;
      await tickAt(svc, 1); // the idle run: the stats have used the tick, so it attempts nothing, and forgets nothing
      statsMs = 0;
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(cursors()).toEqual([500]);

      await tickAt(svc, 2); // the repeat proves it guilty, and the cursor goes on
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance P, set aside'));
      expect(cursors()).toEqual([500, 500, 700]);
    });

    it('sets it aside although every run but the attempts is idle', async () => {
      pages.set(500, { issuances: stale('P'), upTo: 700 });
      failing.add('P');
      const svc = service();
      let minute = 0;
      await tickAt(svc, minute++);
      for (let idle = 0; idle < 3; idle++) {
        statsMs = AGGREGATOR_TICK_BUDGET_MS + 1000;
        await tickAt(svc, minute++);
        statsMs = 0;
      }
      await tickAt(svc, minute++);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance P, set aside'));
      expect(cursors()).toEqual([500, 500, 700]);
    });

    it('a run whose read of what changed fails attempts no batch either', async () => {
      pages.set(500, { issuances: stale('P'), upTo: 700 });
      failing.add('P');
      const svc = service();
      await tickAt(svc, 0);
      changedSince.mockRejectedValueOnce(new Error('DB::Exception: no such table'));
      await tickAt(svc, 1);
      await tickAt(svc, 2);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance P, set aside'));
    });

    it('a batch is a repeat only of the last run that attempted one: an older all-failed batch is not', async () => {
      failing.add('A');
      failing.add('B');
      const svc = service();
      // tick 0: the batch fails whole, the failure of the job
      pages.set(500, { issuances: stale('A', 'B'), upTo: 700 });
      await tickAt(svc, 0);
      expect(errors()).toBe(1);
      // tick 1: another issuance first (the ledger it is at is before the batch), which works
      pages.set(500, { issuances: stale('C'), upTo: 501 });
      pages.set(501, { issuances: [], upTo: 501 });
      await tickAt(svc, 1);
      expect(errors()).toBe(1);
      // tick 2: the batch again, failing whole again: the failure of tick 0 is two attempts back, so it is no repeat
      pages.set(501, { issuances: stale('A', 'B'), upTo: 700 });
      await tickAt(svc, 2);
      expect(errors()).toBe(2);
      expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('set aside'));
      // tick 3: the same batch of the attempt just before: now it is a repeat
      await tickAt(svc, 3);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance A, set aside'));
    });

    it('the memory of the live batches is not that of the dirty slices: a live failure makes no slice a repeat', async () => {
      failing.add('A');
      failing.add('B');
      pages.set(500, { issuances: stale('A', 'B'), upTo: 700 });
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceIssuances.set('2026-05-01T00:00:00Z', stale('A', 'B'));
      await service().tick();
      const jobs = metrics.aggregatorErrorsTotal.inc.mock.calls.map(([labels]) => labels.job);
      // the slice's fails whole (the slice), and then the live batch (the job): none set aside on either
      expect(jobs).toEqual(['mpt_state_dirty', 'mpt_state']);
      expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('set aside'));
    });
  });

  describe('a batch that fails as a whole although each half works', () => {
    it('is warned about and counted once, and the cursor goes on', async () => {
      pages.set(500, { issuances: stale('A', 'B', 'C', 'D'), upTo: 700 });
      rebuild.mockImplementationOnce(async () => {
        throw new Error('DB::Exception: too large');
      });
      await service().tick();
      expect(done).toEqual(['A', 'B', 'C', 'D']);
      expect(errors()).toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('failed as a whole, but its halves were rebuilt'),
      );
      expect(cursors()).toEqual([500, 700]);
    });
  });

  describe('the budget', () => {
    it('stops starting batches when the budget of the job is spent, says so, and goes on from the cursor next tick', async () => {
      rebuildMs = 400;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { issuances: stale(`I${i}`), upTo: 510 + i * 10 });
      const svc = service({ budgetsMs: { mpt_state: 1000 } });
      await svc.tick();
      // batches start at 0, 400 and 800 ms (inside the 1000 ms) and not at 1200
      expect(batches()).toEqual([['I0'], ['I1'], ['I2']]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('mpt_state reached its budget'));

      await tickAt(svc, 1);
      expect(batches().slice(3)).toEqual([['I3'], ['I4'], ['I5']]);
    });

    it('is 3 s by default: a slow batch uses it up', async () => {
      rebuildMs = 10_000;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { issuances: stale(`I${i}`), upTo: 510 + i * 10 });
      await service().tick();
      expect(batches()).toEqual([['I0']]);
    });

    it('does not take more than the tick has left either', async () => {
      rebuildMs = 5000;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { issuances: stale(`I${i}`), upTo: 510 + i * 10 });
      await service({ tickBudgetMs: 4000, budgetsMs: { mpt_state: 100_000 } }).tick();
      expect(batches()).toEqual([['I0']]);
    });
  });

  describe('the issuances of agg_dirty slices (the hook of stats_dirty)', () => {
    it('rebuilds the issuances of a dirty slice, after its stats, at the head read then, and removes the range', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      sliceIssuances.set('2026-05-01T22:00:00Z', stale('A', 'B'));
      await service().tick();
      const at = events.indexOf('stats 2026-05-01T22:00:00Z');
      expect(events.slice(at, at + 2)).toEqual(['stats 2026-05-01T22:00:00Z', 'rebuild A,B']);
      expect(closedIn).toHaveBeenCalledWith(
        ch,
        RATES,
        new Date('2026-05-01T22:00:00Z'),
        new Date('2026-05-02T03:00:00Z'),
      );
      expect(rebuild.mock.calls[0]).toEqual([ch, stale('A', 'B'), HEAD, { signal: expect.any(AbortSignal) }]);
      expect(ch.dirty).toEqual([]);
    });

    it('a range of several days: each slice has its own issuances', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z')];
      sliceIssuances.set('2026-05-01T00:00:00Z', stale('A'));
      sliceIssuances.set('2026-05-02T00:00:00Z', stale('B'));
      await service().tick();
      expect(batches()).toEqual([['A'], ['B']]);
      expect(ch.dirty).toEqual([]);
    });

    it('a slice with many issuances is rebuilt in batches', async () => {
      const MANY = Array.from({ length: MPT_STATE_BATCH + 1 }, (_, i) => `I${i}`);
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceIssuances.set('2026-05-01T00:00:00Z', stale(...MANY));
      await service().tick();
      expect(batches().map((b) => b.length)).toEqual([MPT_STATE_BATCH, 1]);
    });

    it('a slice without issuances reads no head and rebuilds nothing, and the range is removed', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service({ budgetsMs: { mpt_state: 0 } }).tick();
      expect(rebuild).not.toHaveBeenCalled();
      expect(head).toHaveBeenCalledTimes(1); // the run of the job, for its gauge
      expect(ch.dirty).toEqual([]);
    });

    it('an issuance that fails is set aside, not the slice: the others are done, the range is removed, and its retry holds what the slice named', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      sliceIssuances.set('2026-05-01T22:00:00Z', stale('A', 'B', 'C'));
      failing.add('B');
      const svc = service();
      await svc.tick();
      expect(done.sort()).toEqual(['A', 'C']);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'mpt_state_dirty' }]]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance B'));

      // a slice names pairs no touch above the row's last_ledger names: the retry owes them
      failing.clear();
      rebuild.mockClear();
      await tickAt(svc, 5);
      expect(rebuild.mock.calls).toEqual([[ch, stale('B'), HEAD, { signal: expect.any(AbortSignal) }]]);
      expect(done).toContain('B');
    });

    it('a slice that names an issuance set aside adds what it names to the retry, and rebuilds the others', async () => {
      pages.set(500, { issuances: stale('A', 'C'), upTo: 700 });
      failing.add('C');
      const svc = service();
      await svc.tick();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance C, set aside'));

      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      sliceIssuances.set('2026-05-01T22:00:00Z', [
        { id: 'C', holders: ['rSecond', 'rFirst'] },
        { id: 'D', holders: ['rOther'] },
      ]);
      rebuild.mockClear();
      await tickAt(svc, 1);
      expect(rebuild.mock.calls.map(([, issuances]) => issuances)).toEqual([[{ id: 'D', holders: ['rOther'] }]]);
      expect(ch.dirty).toEqual([]);

      failing.clear();
      rebuild.mockClear();
      await tickAt(svc, 5);
      expect(rebuild.mock.calls.map(([, issuances]) => issuances)).toEqual([
        [{ id: 'C', holders: ['rFirst', 'rSecond'] }],
      ]);
    });

    it('a retry that fails again keeps what the slice named', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      sliceIssuances.set('2026-05-01T22:00:00Z', stale('A', 'B'));
      failing.add('B');
      const svc = service();
      await svc.tick();
      await tickAt(svc, 5); // fails again, and waits 10 minutes
      failing.clear();
      rebuild.mockClear();
      await tickAt(svc, 15);
      expect(rebuild.mock.calls.map(([, issuances]) => issuances)).toEqual([stale('B')]);
    });

    it('a slice whose only issuance fails is the failure of the slice first, and the issuance is set aside when it fails again', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      sliceIssuances.set('2026-05-01T22:00:00Z', stale('P'));
      failing.add('P');
      const svc = service();
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect(errors()).toBe(1);

      await tickAt(svc, 1);
      expect(ch.dirty).toEqual([]);
      expect(errors()).toBe(2);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance P, set aside'));
    });

    it('a slice whose only issuance fails is proved guilty across a run of stats_dirty that had no budget', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      sliceIssuances.set('2026-05-01T22:00:00Z', stale('P'));
      failing.add('P');
      const svc = service();
      await tickAt(svc, 0);
      expect(ch.dirty).toHaveLength(1);

      // the stats use the tick: stats_dirty starts no slice in this run, and forgets nothing
      statsMs = AGGREGATOR_TICK_BUDGET_MS + 1000;
      await tickAt(svc, 1);
      statsMs = 0;
      expect(rebuild).toHaveBeenCalledTimes(1);
      expect(ch.dirty).toHaveLength(1);

      await tickAt(svc, 2);
      expect(ch.dirty).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('issuance P, set aside'));
    });

    it('a slice most of whose issuances fail keeps the range, counts the failure, and the next tick does it again', async () => {
      const FIVE = ['A', 'B', 'C', 'D', 'E'];
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      sliceIssuances.set('2026-05-01T22:00:00Z', stale(...FIVE));
      for (const id of FIVE) failing.add(id);
      const svc = service();
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'mpt_state_dirty' }]]);

      failing.clear();
      await tickAt(svc, 1);
      expect(ch.dirty).toEqual([]);
      expect(done).toEqual(FIVE);
    });

    it('a lookup of the issuances of a slice that fails fails the slice the same way', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      closedIn.mockRejectedValueOnce(new Error('DB::Exception: boom'));
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc.mock.calls).toEqual([[{ job: 'mpt_state_dirty' }]]);
      expect(ch.dirty).toHaveLength(1);
    });

    it('does not start a batch after the shutdown began, and the range stays', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceIssuances.set('2026-05-01T00:00:00Z', stale('A'));
      const svc = service();
      closedIn.mockImplementation(async () => {
        void svc.stop();
        return stale('A');
      });
      await svc.tick();
      expect(rebuild).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
    });

    it('a batch cut short by the shutdown is neither an error nor counted, and the range stays', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      sliceIssuances.set('2026-05-01T00:00:00Z', stale('A'));
      const svc = service();
      rebuild.mockImplementation(async () => {
        void svc.stop();
        throw new MptStateAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
    });
  });

  describe('shutdown', () => {
    it('starts nothing once it has begun: no head, no watermark, no read, no rebuild', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      const svc = service();
      await svc.stop();
      await svc.tick();
      for (const fn of [head, watermark, changedSince, closedIn, rebuild]) expect(fn).not.toHaveBeenCalled();
    });

    it('stops before a write once the shutdown begins: the batch in flight has its signal aborted, and no batch starts after it', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      pages.set(700, { issuances: stale('B'), upTo: 900 });
      let signalOfBatch: AbortSignal | undefined;
      let release!: () => void;
      rebuild.mockImplementationOnce(
        (_c: unknown, _i: unknown, _h: unknown, options?: { signal?: AbortSignal }) =>
          new Promise<void>((resolve) => {
            signalOfBatch = options?.signal;
            release = () => resolve();
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
      expect(batches()).toEqual([['A']]);
      expect(changedSince).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('an aborted batch is neither an error, nor counted, nor an issuance to retry', async () => {
      pages.set(500, { issuances: stale('A', 'B', 'C', 'D', 'E'), upTo: 700 });
      const svc = service();
      rebuild.mockImplementation(async () => {
        void svc.stop();
        throw new MptStateAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
      expect(rebuild).toHaveBeenCalledTimes(1); // no halving
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      const svc = service();
      rebuild.mockImplementation(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'mpt_state' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });

    it('an MptStateAborted that the shutdown did not cause is an error, as any failure', async () => {
      pages.set(500, { issuances: stale('A'), upTo: 700 });
      rebuild.mockImplementation(async () => {
        throw new MptStateAborted();
      });
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'mpt_state' });
    });
  });
});
