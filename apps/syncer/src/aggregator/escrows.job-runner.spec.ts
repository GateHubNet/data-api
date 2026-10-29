import { Escrowed, EscrowsAborted, EscrowsStep, RatesService } from '@gatehub/data-api-shared';
import { FakeClickHouse, iso, NOW, NOW_SECONDS, QUIET, unix } from '../../test/aggregator-fakes';
import {
  AGGREGATOR_ESCROWS_BUDGET_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AggregatorOptions,
  AggregatorService,
} from './aggregator.service';
import { EscrowsFunctions, EscrowsJobRunner } from './escrows.job-runner';
import { AggregatorJobContext, AggregatorTick } from './job-context';

/**
 * The `escrows` job (`EscrowsJobRunner`), driven through the `AggregatorService` it runs in: the steps of a tick and the budget
 * that ends them, the gauges, a failing step, the escrows a step sets aside, the hook of `agg_dirty`, and the shutdown. The
 * functions of the shared package are fakes (their own behavior is tested in `packages/shared/test/escrows.job.e2e-spec.ts`);
 * the escrow IDs are made by hand.
 */

describe('AggregatorService escrows job', () => {
  /** The ledgers of every slice that has some are what `sliceLedgers` says; the rest closed none. */
  let sliceLedgers: Map<string, { min: number; max: number }>;
  let ledgersClosedIn: jest.Mock;
  const RATES = {
    nativeCurrency: 'XRP',
    ledgersClosedIn: (from: Date, to: Date) => ledgersClosedIn(from, to),
  } as unknown as RatesService;

  /** The ID of an escrow made by hand. */
  const idOf = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');
  const IDS = [idOf(1), idOf(2)];
  const SLICE = ['2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z'] as const;
  const SLICE_WHERE = ' in 2026-05-01T00:00:00Z - 2026-05-01T03:00:00Z';

  let ch: FakeClickHouse;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
    aggregatorStatsLagSeconds: { set: jest.Mock };
    escrowsLagLedgers: { set: jest.Mock };
    escrowsOpen: { set: jest.Mock };
  };
  const created: AggregatorService[] = [];
  /** What the fakes were asked, in order. */
  let events: string[];
  let step: jest.Mock;
  let ofLedgers: jest.Mock;
  let recomputeIds: jest.Mock;
  let refreshTotal: jest.Mock;
  let read: jest.Mock;
  /** The read of the newest committed ledger, which the runner makes only after a step that failed. */
  let readHead: jest.Mock;
  /** The newest committed ledger. */
  let head: number;
  /** The `through_ledger` of the sentinel the fake steps move on. */
  let through: number;
  /** How many native escrows are open, as the sentinel of the fake steps says. */
  let open: number;
  /** How many ledgers a fake step covers, at most. */
  let stepLedgers: number;
  /** How long (fake milliseconds) a step takes, at least one: a loop that does not progress runs out of its budget. */
  let stepMs: number;
  /** The escrows the fake steps set aside. */
  let stepSetAside: string[];
  /** What the fake recompute of a slice did. */
  let recomputed: { written: number; removed: number; setAside: string[] };
  /** The signal of each step the fake was given. */
  let signals: AbortSignal[];

  const jobsRun = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const errors = (): Array<{ job: string }> => metrics.aggregatorErrorsTotal.inc.mock.calls.map(([labels]) => labels);
  const lags = (): number[] => metrics.escrowsLagLedgers.set.mock.calls.map(([value]) => value);
  const opens = (): number[] => metrics.escrowsOpen.set.mock.calls.map(([value]) => value);
  /** What the fakes of the escrows functions were asked, without the stats. */
  const asked = (): string[] => events.filter((event) => !event.startsWith('stats'));
  const aggMark = (from: string, to: string, createdMs = 1000) => ({
    from: unix(from),
    to: unix(to),
    created: createdMs,
  });
  /** A tick `minutes` after the first one. */
  const tickAt = async (svc: AggregatorService, minutes: number): Promise<void> => {
    jest.setSystemTime(NOW_SECONDS * 1000 + minutes * 60_000);
    await svc.tick();
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
      escrowsLagLedgers: { set: jest.fn() },
      escrowsOpen: { set: jest.fn() },
    };
    events = [];
    sliceLedgers = new Map();
    ledgersClosedIn = jest.fn(async (from: Date) => sliceLedgers.get(iso(from.getTime() / 1000)) ?? null);
    head = 1000;
    through = 900;
    open = 3;
    stepLedgers = 1_000_000;
    stepMs = 0;
    stepSetAside = [];
    recomputed = { written: 2, removed: 0, setAside: [] };
    signals = [];
    step = jest.fn(async (_ch: unknown, opts: { signal?: AbortSignal }) => {
      events.push('step');
      if (opts.signal) signals.push(opts.signal);
      jest.setSystemTime(Date.now() + Math.max(stepMs, 1));
      const from = through;
      const to = Math.max(from, Math.min(head, from + stepLedgers));
      through = to;
      const escrowed: Escrowed = { drops: '0', open, through_ledger: to };
      const done: EscrowsStep = {
        from,
        to,
        head,
        touched: 0,
        written: 0,
        removed: 0,
        setAside: stepSetAside,
        escrowed,
      };
      return done;
    });
    read = jest.fn(async () => {
      events.push('read');
      return { drops: '0', open, through_ledger: through };
    });
    readHead = jest.fn(async () => head);
    ofLedgers = jest.fn(async (_ch: unknown, min: number, max: number) => {
      events.push(`of ${min}-${max}`);
      return IDS;
    });
    recomputeIds = jest.fn(async (_ch: unknown, ids: string[], opts: { upTo: number }) => {
      events.push(`recompute ${ids.length} upTo ${opts.upTo}`);
      return recomputed;
    });
    refreshTotal = jest.fn(async () => {
      events.push('refresh');
      return { drops: '0', open, through_ledger: through };
    });
  });

  afterEach(async () => {
    const stops = created.splice(0).map((svc) => svc.stop());
    await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS);
    await Promise.all(stops);
    jest.useRealTimers();
  });

  /** A service with the escrows job and, of the stats, a recompute that does nothing (the stats have their own tests). */
  function service(options: AggregatorOptions = {}, withMetrics = true): AggregatorService {
    const svc = new AggregatorService(
      ch.asService(),
      withMetrics ? (metrics as never) : undefined,
      { register: jest.fn() } as never,
      {
        logger,
        recompute: jest.fn(async (_ch: unknown, from: Date) => {
          events.push(`stats ${iso(from.getTime() / 1000)}`);
          return 0;
        }),
        escrows: { rates: RATES, nativeCurrency: 'XRP' },
        escrowsFunctions: { step, ofLedgers, recompute: recomputeIds, refreshTotal, read, head: readHead } as never,
        ...options,
      },
    );
    created.push(svc);
    return svc;
  }

  describe('the job of every tick', () => {
    it('moves the watermark to the head on a tick with no escrow', async () => {
      await service().tick();
      expect(step).toHaveBeenCalledTimes(1);
      expect(step).toHaveBeenCalledWith(ch, { native: 'XRP', signal: expect.any(AbortSignal) });
      expect(through).toBe(1000);
      expect(lags()).toEqual([0]);
      expect(opens()).toEqual([3]);
      expect(jobsRun()).toEqual(['escrows', 'stats_live', 'stats_dirty']);
      expect(errors()).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
      // the live run is all there is: no hook, no read of the sentinel, and no read of the head (the step carries it)
      expect(asked()).toEqual(['step']);
      expect(readHead).not.toHaveBeenCalled();
    });

    it('logs a debug line for every step: the window, what it touched and wrote, and how long it took', async () => {
      head = 10_000;
      through = 0;
      stepLedgers = 1000;
      stepMs = 250;
      await service({ budgetsMs: { escrows: 400 } }).tick();
      expect(logger.debug.mock.calls.map(([line]) => line).filter((line) => line.startsWith('escrows:'))).toEqual([
        'escrows: ledgers after 0 up to 1000 (head 10000): 0 escrow(s) touched, 0 row(s) written, 0 removed, 250 ms',
        'escrows: ledgers after 1000 up to 2000 (head 10000): 0 escrow(s) touched, 0 row(s) written, 0 removed, 250 ms',
      ]);
    });

    it('takes the native currency of the network to the step', async () => {
      await service({ escrows: { rates: RATES, nativeCurrency: 'XAH' } }).tick();
      expect(step).toHaveBeenCalledWith(ch, expect.objectContaining({ native: 'XAH' }));
    });

    it('steps at every tick, also when no ledger came: the sentinel follows the clock of the ticks', async () => {
      head = 900;
      const svc = service();
      await svc.tick();
      await tickAt(svc, 1);
      await tickAt(svc, 2);
      expect(step).toHaveBeenCalledTimes(3);
      expect(through).toBe(900);
      expect(lags()).toEqual([0, 0, 0]);
    });

    it('takes steps until the head while the budget lasts, and goes on at the next tick', async () => {
      expect(AGGREGATOR_ESCROWS_BUDGET_MS).toBe(2000);
      head = 10_000;
      through = 0;
      stepLedgers = 1000;
      stepMs = 500;
      const svc = service();
      await svc.tick();
      // a step at 0, 0.5, 1 and 1.5 s; at 2 s the budget is spent
      expect(step).toHaveBeenCalledTimes(4);
      expect(through).toBe(4000);
      expect(lags()).toEqual([9000, 8000, 7000, 6000]);

      await tickAt(svc, 1);
      expect(step).toHaveBeenCalledTimes(8);
      expect(through).toBe(8000);

      // the head is reached in the third tick, with budget to spare, and the job stops there
      await tickAt(svc, 2);
      expect(step).toHaveBeenCalledTimes(10);
      expect(through).toBe(10_000);
      expect(lags().at(-1)).toBe(0);
      expect(errors()).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('escrows reached its budget'));
    });

    it('stops at the head and does not step again in the tick while budget is left', async () => {
      head = 3000;
      through = 0;
      stepLedgers = 1000;
      stepMs = 100;
      await service().tick();
      expect(step).toHaveBeenCalledTimes(3);
      expect(through).toBe(3000);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not take another step after one that did not move the watermark', async () => {
      head = 10_000;
      through = 900;
      stepLedgers = 0;
      await service().tick();
      expect(step).toHaveBeenCalledTimes(1);
      expect(lags()).toEqual([9100]);
    });

    it('changes its budget with budgetsMs', async () => {
      head = 10_000;
      through = 0;
      stepLedgers = 1000;
      stepMs = 500;
      await service({ budgetsMs: { escrows: 1000 } }).tick();
      expect(step).toHaveBeenCalledTimes(2);
    });

    it('takes a first step even when the budget is spent, and no other: the sentinel follows the head at every tick', async () => {
      head = 10_000;
      through = 0;
      stepLedgers = 1000;
      stepMs = 10;
      const svc = service({ budgetsMs: { escrows: 0 } });
      await svc.tick();
      expect(step).toHaveBeenCalledTimes(1);
      expect(through).toBe(1000);
      await tickAt(svc, 1);
      expect(step).toHaveBeenCalledTimes(2);
      expect(through).toBe(2000);
    });

    it('never cuts a step at the budget: the signal of a step is the shutdown, which the budget does not abort', async () => {
      head = 10_000;
      through = 0;
      stepLedgers = 1000;
      stepMs = 700;
      await service().tick();
      // three steps (0, 0.7 and 1.4 s) and the budget ended after them
      expect(step).toHaveBeenCalledTimes(3);
      expect(signals).toHaveLength(3);
      expect(new Set(signals).size).toBe(1);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
    });

    it('does not start a step once the shutdown has begun', async () => {
      head = 10_000;
      through = 0;
      stepLedgers = 1000;
      const svc = service();
      step.mockImplementationOnce(async () => {
        void svc.stop();
        return {
          from: 0,
          to: 1000,
          head,
          touched: 0,
          written: 0,
          removed: 0,
          setAside: [],
          escrowed: { drops: '0', open, through_ledger: 1000 },
        };
      });
      await svc.tick();
      // the step in flight finished (it had written its sentinel), and no other began
      expect(step).toHaveBeenCalledTimes(1);
      expect(errors()).toEqual([]);
    });

    it('runs without the metrics', async () => {
      await service({}, false).tick();
      expect(step).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('is not registered without the escrows option, and the slices of agg_dirty run no hook of it', async () => {
      ch.dirty = [aggMark(...SLICE)];
      sliceLedgers.set(SLICE[0], { min: 100, max: 200 });
      await service({ escrows: undefined }).tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      expect(step).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(ledgersClosedIn).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });
  });

  describe('the runner on its own', () => {
    /** A context in which the shutdown has begun: the service does not start a tick then, so the runner is called by hand. */
    const closing = {
      ch: {},
      closing: () => true,
      mayStartSet: () => false,
      failed: jest.fn(),
    } as unknown as AggregatorJobContext;
    const tick = (): AggregatorTick => ({
      now: NOW,
      deadline: Date.now() + 1000,
      signal: new AbortController().signal,
    });

    it('takes no step and reads nothing once the shutdown has begun', async () => {
      const runner = new EscrowsJobRunner(closing, { rates: RATES, nativeCurrency: 'XRP' }, {
        step,
        ofLedgers,
        recompute: recomputeIds,
        refreshTotal,
        read,
      } as unknown as EscrowsFunctions);
      await runner.run(tick());
      await runner.ofSlice(unix(SLICE[0]), unix(SLICE[1]), tick());
      expect(step).not.toHaveBeenCalled();
      expect(ledgersClosedIn).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('a failing step', () => {
    it('is thrown for the service to count and log as escrows, and the jobs after it still run', async () => {
      step.mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
      const svc = service();
      await svc.tick();
      expect(errors()).toEqual([{ job: 'escrows' }]);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith('Aggregator job escrows failed: DB::Exception: memory limit');
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      // the gauges say where the watermark is: the sentinel is at 900 and the head at 1000
      expect(lags()).toEqual([100]);
      expect(opens()).toEqual([3]);

      // and the next tick does the step again
      await tickAt(svc, 1);
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty', 'escrows', 'stats_live', 'stats_dirty']);
      expect(errors()).toHaveLength(1);
      expect(through).toBe(1000);
    });

    it('ends the tick there and sets the gauges to where the steps that worked left the watermark', async () => {
      head = 10_000;
      through = 0;
      stepLedgers = 1000;
      const working = step.getMockImplementation() as (...args: unknown[]) => Promise<EscrowsStep>;
      step.mockImplementationOnce(working).mockImplementationOnce(working);
      step.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      await service().tick();
      expect(step).toHaveBeenCalledTimes(3);
      // the two steps that worked, and the sentinel they wrote (2000) read after the one that did not
      expect(lags()).toEqual([9000, 8000, 8000]);
      expect(errors()).toEqual([{ job: 'escrows' }]);
    });

    it('a step that fails at every tick lets the lag grow with the head', async () => {
      step.mockRejectedValue(new Error('DB::Exception: table is read-only'));
      const svc = service();
      await svc.tick();
      head = 1500;
      await tickAt(svc, 1);
      head = 2000;
      await tickAt(svc, 2);
      // the watermark stays at 900 (the step writes nothing), and the head moves on
      expect(lags()).toEqual([100, 600, 1100]);
      expect(opens()).toEqual([3, 3, 3]);
      expect(through).toBe(900);
      expect(errors()).toEqual([{ job: 'escrows' }, { job: 'escrows' }, { job: 'escrows' }]);
      expect(readHead).toHaveBeenCalledTimes(3);
    });

    it('after a restart, a failing step does not report 0: the gauge is never set by a step that worked', async () => {
      head = 5000;
      through = 1200;
      step.mockRejectedValue(new Error('DB::Exception: memory limit'));
      // a process that has not set a gauge yet: the first value it sets is the lag, not a 0 from the default
      await service().tick();
      expect(lags()).toEqual([3800]);
      expect(opens()).toEqual([3]);
    });

    it('without a sentinel the lag is the head, and the open count is left alone', async () => {
      head = 700;
      read.mockResolvedValue(undefined);
      step.mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
      await service().tick();
      expect(lags()).toEqual([700]);
      expect(opens()).toEqual([]);
    });

    it('never goes below 0 for a watermark above the head', async () => {
      head = 500;
      through = 900;
      step.mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
      await service().tick();
      expect(lags()).toEqual([0]);
    });

    it('a failure to read the gauges is counted and logged on its own, and the error of the step is thrown all the same', async () => {
      readHead.mockRejectedValueOnce(new Error('DB::Exception: no such table'));
      step.mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
      await service().tick();
      expect(errors()).toEqual([{ job: 'escrows' }, { job: 'escrows' }]);
      expect(logger.error.mock.calls.map(([line]) => line)).toEqual([
        'Aggregator job escrows failed reading the gauges: DB::Exception: no such table',
        'Aggregator job escrows failed: DB::Exception: memory limit',
      ]);
      expect(lags()).toEqual([]);
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
    });

    it('a failure to read the sentinel for the gauges is handled the same way', async () => {
      read.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      step.mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
      await service().tick();
      expect(logger.error.mock.calls.map(([line]) => line)).toEqual([
        'Aggregator job escrows failed reading the gauges: DB::Exception: timeout',
        'Aggregator job escrows failed: DB::Exception: memory limit',
      ]);
      expect(lags()).toEqual([]);
    });

    it('reads nothing for the gauges without the metrics', async () => {
      step.mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
      await service({}, false).tick();
      expect(readHead).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('the escrows a step sets aside', () => {
    it('are each counted and logged as a failure of escrows, by ID, and the step still counts as done', async () => {
      stepSetAside = [idOf(0xa1), idOf(0xa2)];
      await service().tick();
      expect(errors()).toEqual([{ job: 'escrows' }, { job: 'escrows' }]);
      expect(logger.error.mock.calls.map(([line]) => line)).toEqual([
        `Aggregator job escrows failed for escrow ${idOf(0xa1)}, set aside: its rows cannot be mapped to an escrows row`,
        `Aggregator job escrows failed for escrow ${idOf(0xa2)}, set aside: its rows cannot be mapped to an escrows row`,
      ]);
      // the sentinel was written: the job ran, and its gauges were set
      expect(jobsRun()).toEqual(['escrows', 'stats_live', 'stats_dirty']);
      expect(lags()).toEqual([0]);
      expect(through).toBe(1000);
    });

    it('are counted in the step that sets them aside, whichever of the steps of a tick it is', async () => {
      head = 3000;
      through = 0;
      stepLedgers = 1000;
      const working = step.getMockImplementation() as (...args: unknown[]) => Promise<EscrowsStep>;
      step.mockImplementationOnce(working);
      step.mockImplementationOnce(async (...args: unknown[]) => ({
        ...(await working(...args)),
        setAside: [idOf(0xb1)],
      }));
      await service().tick();
      expect(step).toHaveBeenCalledTimes(3);
      expect(errors()).toEqual([{ job: 'escrows' }]);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(idOf(0xb1)));
    });
  });

  describe('the gauges', () => {
    it('are set after every step: the lag is the head of the step less the watermark it wrote, and the open count is the sentinel it wrote', async () => {
      head = 10_000;
      through = 0;
      stepLedgers = 1000;
      stepMs = 800;
      open = 12;
      await service().tick();
      // a step at 0, 0.8 and 1.6 s
      expect(lags()).toEqual([9000, 8000, 7000]);
      expect(opens()).toEqual([12, 12, 12]);
    });

    it('never go below 0 for a watermark above the head', async () => {
      head = 500;
      through = 900;
      await service().tick();
      expect(through).toBe(900);
      expect(lags()).toEqual([0]);
    });
  });

  describe('the shutdown', () => {
    it('does not count or log an EscrowsAborted of a step that the shutdown cut short', async () => {
      const svc = service();
      step.mockImplementationOnce(async () => {
        void svc.stop();
        throw new EscrowsAborted();
      });
      await svc.tick();
      expect(errors()).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith('Dropped the escrows slice in flight at shutdown');
      // the failure is the shutdown's: the gauges are not read
      expect(lags()).toEqual([]);
      expect(readHead).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    });

    it('counts an EscrowsAborted that the shutdown did not cause, as any failure', async () => {
      step.mockRejectedValueOnce(new EscrowsAborted());
      await service().tick();
      expect(errors()).toEqual([{ job: 'escrows' }]);
      expect(lags()).toEqual([100]);
    });
  });

  describe('the escrows of agg_dirty slices (the hook of stats_dirty)', () => {
    beforeEach(() => {
      // the live step has nothing to do, and the watermark is within the slice
      head = 150;
      through = 150;
      ch.dirty = [aggMark(...SLICE)];
      sliceLedgers.set(SLICE[0], { min: 100, max: 200 });
    });

    it('recomputes the escrows of the ledgers that closed in the slice as of the watermark, and refreshes the total', async () => {
      await service().tick();
      expect(ledgersClosedIn).toHaveBeenCalledTimes(1);
      const [from, toExclusive] = ledgersClosedIn.mock.calls[0];
      // two dates, the end exclusive
      expect([from, toExclusive]).toEqual([expect.any(Date), expect.any(Date)]);
      expect([iso(from.getTime() / 1000), iso(toExclusive.getTime() / 1000)]).toEqual([...SLICE]);
      expect(ofLedgers).toHaveBeenCalledWith(ch, 100, 200);
      expect(recomputeIds).toHaveBeenCalledWith(ch, IDS, { upTo: 150, native: 'XRP', signal: expect.any(AbortSignal) });
      expect(refreshTotal).toHaveBeenCalledWith(ch, { native: 'XRP', signal: expect.any(AbortSignal) });
      // after the stats of the slice, in this order
      const at = events.indexOf(`stats ${SLICE[0]}`);
      expect(events.slice(at)).toEqual([`stats ${SLICE[0]}`, 'read', 'of 100-200', 'recompute 2 upTo 150', 'refresh']);
      expect(ch.dirty).toEqual([]);
      expect(errors()).toEqual([]);
    });

    it('recomputes as of the watermark of the sentinel, not the head: the live run covers what is above it', async () => {
      head = 5000;
      stepLedgers = 0;
      await service().tick();
      expect(lags()).toEqual([4850]);
      expect(recomputeIds).toHaveBeenCalledWith(ch, IDS, expect.objectContaining({ upTo: 150 }));
    });

    it('does not refresh the total when no escrow was written or removed: the total reads a row per escrow ever seen', async () => {
      recomputed = { written: 0, removed: 0, setAside: [] };
      await service().tick();
      expect(recomputeIds).toHaveBeenCalledTimes(1);
      expect(refreshTotal).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it.each([
      ['written', { written: 1, removed: 0, setAside: [] }],
      ['removed', { written: 0, removed: 1, setAside: [] }],
    ])('refreshes the total when an escrow was %s', async (_what, outcome) => {
      recomputed = outcome;
      await service().tick();
      expect(refreshTotal).toHaveBeenCalledTimes(1);
    });

    it('does nothing for a slice in which no ledger closed, and the range is removed', async () => {
      sliceLedgers.clear();
      await service().tick();
      expect(ledgersClosedIn).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(ofLedgers).not.toHaveBeenCalled();
      expect(recomputeIds).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('does nothing before the job has written a sentinel: its first steps read what the slice rewrote', async () => {
      read.mockResolvedValue(undefined);
      await service().tick();
      expect(read).toHaveBeenCalledTimes(1);
      expect(ofLedgers).not.toHaveBeenCalled();
      expect(recomputeIds).not.toHaveBeenCalled();
      expect(refreshTotal).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it.each([
      ['below the first ledger of the slice is left to the live run', 99, false],
      ['at the first ledger of the slice is recomputed', 100, true],
      ['within the slice is recomputed', 150, true],
      ['past the slice is recomputed', 5000, true],
    ])('a watermark %s', async (_what, watermark, recomputes) => {
      read.mockResolvedValue({ drops: '0', open, through_ledger: watermark });
      await service().tick();
      expect(recomputeIds).toHaveBeenCalledTimes(recomputes ? 1 : 0);
      if (recomputes) expect(recomputeIds).toHaveBeenCalledWith(ch, IDS, expect.objectContaining({ upTo: watermark }));
      expect(ch.dirty).toEqual([]);
      expect(errors()).toEqual([]);
    });

    it('a range of several days: each slice recomputes the escrows of its own ledgers', async () => {
      through = 400;
      head = 400;
      ch.dirty = [aggMark('2026-05-01T00:00:00Z', '2026-05-02T12:00:00Z')];
      sliceLedgers.set('2026-05-01T00:00:00Z', { min: 100, max: 200 });
      sliceLedgers.set('2026-05-02T00:00:00Z', { min: 201, max: 250 });
      await service().tick();
      expect(ofLedgers.mock.calls.map(([, min, max]) => [min, max])).toEqual([
        [100, 200],
        [201, 250],
      ]);
      expect(refreshTotal).toHaveBeenCalledTimes(2);
      expect(ch.dirty).toEqual([]);
    });

    it('counts and logs each escrow the hook sets aside as a failure of escrows, and the slice goes on', async () => {
      recomputed = { written: 1, removed: 0, setAside: [idOf(0xc1), idOf(0xc2)] };
      await service().tick();
      expect(errors()).toEqual([{ job: 'escrows' }, { job: 'escrows' }]);
      expect(logger.error.mock.calls.map(([line]) => line)).toEqual([
        `Aggregator job escrows failed for escrow ${idOf(0xc1)}${SLICE_WHERE}, set aside: its rows cannot be mapped to an escrows row`,
        `Aggregator job escrows failed for escrow ${idOf(0xc2)}${SLICE_WHERE}, set aside: its rows cannot be mapped to an escrows row`,
      ]);
      // mapping is a function of the rows, so there is nothing to try again: the slice is done, and the range is removed
      expect(refreshTotal).toHaveBeenCalledTimes(1);
      expect(ch.dirty).toEqual([]);
    });

    it('a set aside escrow alone writes nothing, so the total is not refreshed', async () => {
      recomputed = { written: 0, removed: 0, setAside: [idOf(0xc1)] };
      await service().tick();
      expect(errors()).toEqual([{ job: 'escrows' }]);
      expect(refreshTotal).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it.each([
      ['the lookup of the ledgers of the slice', () => ledgersClosedIn],
      ['the read of the sentinel', () => read],
      ['the lookup of the escrows of the ledgers', () => ofLedgers],
      ['the recompute', () => recomputeIds],
      ['the refresh of the total', () => refreshTotal],
    ])(
      'a failure of %s is counted and logged as escrows_dirty, fails the slice and keeps the range; the jobs after it still run, and the next tick does it again',
      async (_what, fake) => {
        fake().mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
        const svc = service();
        await svc.tick();
        expect(errors()).toEqual([{ job: 'escrows_dirty' }]);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
          `Aggregator job escrows_dirty failed${SLICE_WHERE}: DB::Exception: memory limit`,
        );
        expect(ch.dirty).toEqual([aggMark(...SLICE)]);
        expect(jobsRun()).toEqual(['escrows', 'stats_live', 'stats_dirty']);

        await tickAt(svc, 1);
        expect(ch.dirty).toEqual([]);
        expect(errors()).toHaveLength(1);
      },
    );

    // A step that failed after some of its chunks were written leaves rows as of its window beside a sentinel that is still
    // at the old watermark: a recompute and a total then would write a sentinel whose total is not the state at its watermark.
    it('after a step that failed in this tick, a slice is left in agg_dirty and no sentinel is written', async () => {
      step.mockRejectedValueOnce(new Error('DB::Exception: memory limit'));
      const svc = service();
      await svc.tick();
      expect(ledgersClosedIn).not.toHaveBeenCalled();
      expect(ofLedgers).not.toHaveBeenCalled();
      expect(recomputeIds).not.toHaveBeenCalled();
      expect(refreshTotal).not.toHaveBeenCalled();
      expect(errors()).toEqual([{ job: 'escrows' }, { job: 'escrows_dirty' }]);
      expect(logger.error.mock.calls.map(([line]) => line)).toEqual([
        'Aggregator job escrows failed: DB::Exception: memory limit',
        `Aggregator job escrows_dirty failed${SLICE_WHERE}: the escrows step of this tick failed`,
      ]);
      expect(ch.dirty).toEqual([aggMark(...SLICE)]);
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);

      // the next tick's step commits, and its slice is recomputed as of the new watermark
      await tickAt(svc, 1);
      expect(recomputeIds).toHaveBeenCalledTimes(1);
      expect(refreshTotal).toHaveBeenCalledTimes(1);
      expect(ch.dirty).toEqual([]);
      expect(errors()).toHaveLength(2);
    });

    it('does nothing once the shutdown has begun, and the range stays', async () => {
      const svc = service();
      ledgersClosedIn.mockImplementationOnce(async () => {
        void svc.stop(); // the shutdown begins as the first thing the hook asks ...
        return { min: 100, max: 200 };
      });
      await svc.tick();
      // ... and nothing else is read or written
      expect(read).not.toHaveBeenCalled();
      expect(recomputeIds).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
      expect(errors()).toEqual([]);
    });

    it('does not start the recompute of a slice after the shutdown began during the reads before it', async () => {
      const svc = service();
      ofLedgers.mockImplementationOnce(async () => {
        void svc.stop();
        return IDS;
      });
      await svc.tick();
      expect(recomputeIds).not.toHaveBeenCalled();
      expect(refreshTotal).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
      expect(errors()).toEqual([]);
    });

    it('does not count or log an EscrowsAborted of a recompute that the shutdown cut short, and the range stays', async () => {
      const svc = service();
      recomputeIds.mockImplementationOnce(async () => {
        void svc.stop();
        throw new EscrowsAborted();
      });
      await svc.tick();
      expect(errors()).toEqual([]);
      expect(logger.error).not.toHaveBeenCalled();
      expect(refreshTotal).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([aggMark(...SLICE)]);
    });
  });
});
