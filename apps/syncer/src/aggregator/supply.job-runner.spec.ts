import {
  getNetworkProfile,
  NetworkSupplyRow,
  SUPPLY_INTERVAL_MS,
  SUPPLY_START_WAIT_TICKS,
  SupplyAmmSight,
  SupplyCycle,
  supplySnapshotRow,
  SupplyStart,
} from '@gatehub/data-api-shared';
import { fakeDeps, FakeDeps, NOW } from '../../test/aggregate-job-fakes';
import { AGGREGATE_MAX_RETRY_MS, AGGREGATE_RETRY_MS } from './aggregate-job-deps';
import { SupplyFunctions, SupplyJobRunner } from './supply.job-runner';

const NOW_SECONDS = NOW.getTime() / 1000;
const LEDGER = 5_000;
/** The budget of the job in these tests, as `AGGREGATOR_SUPPLY_BUDGET_MS`. */
const BUDGET_MS = 5_000;

const xahau = getNetworkProfile('xahau');
const xrpl = getNetworkProfile('xrpl');

/** A cycle of `count` account steps, nothing counted yet; the close time of its ledger is 30 s before the cycle began. */
const cycleOf = (count: number, over: Partial<SupplyCycle> = {}): SupplyCycle => ({
  ledger: LEDGER,
  closeTime: NOW_SECONDS - 30,
  startedAt: NOW_SECONDS,
  totalCoins: 1_000n,
  escrowed: 100n,
  escrowCount: 3,
  reserveBase: 1_000_000n,
  reserveInc: 200_000n,
  poolAccounts: [],
  amm: null,
  ammPools: 0,
  poolsAtStoredRow: [],
  poolsAtZero: [],
  accounts: 0n,
  ownerCount: 0n,
  burned: 10n,
  minted: null,
  pending: Array.from({ length: count }, (_, i) => ({
    kind: 'accounts' as const,
    range: { lo: `r${i}`, hi: `r${i + 1}` },
  })),
  steps: count,
  ...over,
});

/** A snapshot as `newestSnapshot` reads it: the columns the runner looks at (the rest is a plausible row). */
const snapshotOf = (over: Pick<NetworkSupplyRow, 'started_at' | 'close_time'>): NetworkSupplyRow => ({
  ...supplySnapshotRow(cycleOf(0), NOW_SECONDS, 1),
  ...over,
});

/**
 * The shared functions of the `supply` job as the runner calls them, over an in-memory cycle of `steps` steps: `newestSnapshot`
 * answers `snapshot` (or throws), the start answers a cycle (or what it waits for, or throws), a step takes `stepMs` of the fake
 * clock and adds one account and two owners to the cycle (or throws, as many times as `failTimes` says for its place in the plan),
 * and the write keeps the row it makes as the newest snapshot.
 */
class FakeSupply {
  snapshot?: NetworkSupplyRow;
  readError?: Error;
  reads = 0;

  steps = 5;
  cycleOver: Partial<SupplyCycle> = {};
  waiting?: 'escrows' | 'amm_pools';
  startError?: Error;
  starts: Array<{ startedAt: number; amm: SupplyAmmSight | undefined }> = [];

  stepMs = 0;
  /** The attempts of `runSupplyStep`, by the place of the step in the plan (a retried step is listed again). */
  attempts: number[] = [];
  /** The steps (by place in the plan) that throw, and how many more times each does. */
  failTimes = new Map<number, number>();
  /** Runs when a step is attempted, before it answers: by its place in the plan. */
  onStep?: (place: number) => void;
  /** The pools a step adds to the cycle's `poolsAtZero`. */
  zeroPools: string[] = [];

  writes: Array<{ cycle: SupplyCycle; computedAt: number; signal?: AbortSignal }> = [];
  writeError?: Error;

  fns(): Partial<SupplyFunctions> {
    return {
      newestSnapshot: async () => {
        this.reads++;
        if (this.readError) throw this.readError;
        return this.snapshot;
      },
      startSupplyCycle: async (_ch, _profile, startedAt, amm): Promise<SupplyStart> => {
        this.starts.push({ startedAt, amm });
        if (this.startError) throw this.startError;
        if (this.waiting) return { waiting: this.waiting };
        return { cycle: cycleOf(this.steps, { startedAt, ...this.cycleOver }) };
      },
      runSupplyStep: async (_ch, _profile, cycle) => {
        const place = cycle.steps - cycle.pending.length;
        this.attempts.push(place);
        this.onStep?.(place);
        if (this.stepMs > 0) jest.setSystemTime(Date.now() + this.stepMs);
        const left = this.failTimes.get(place) ?? 0;
        if (left > 0) {
          this.failTimes.set(place, left - 1);
          throw new Error(`DB::Exception: memory limit in step ${place}`);
        }
        return {
          ...cycle,
          accounts: cycle.accounts + 1n,
          ownerCount: cycle.ownerCount + 2n,
          poolsAtZero: [...new Set([...cycle.poolsAtZero, ...this.zeroPools])].sort(),
          pending: cycle.pending.slice(1),
        };
      },
      writeSupplySnapshot: async (_ch, cycle, computedAt, signal) => {
        this.writes.push({ cycle, computedAt, signal });
        if (this.writeError) throw this.writeError;
        const row = supplySnapshotRow(cycle, computedAt, this.writes.length);
        this.snapshot = row;
        return row;
      },
    };
  }
}

describe('SupplyJobRunner', () => {
  let fake: FakeDeps;
  let world: FakeSupply;

  const runner = (profile = xahau, ammSight?: () => SupplyAmmSight): SupplyJobRunner =>
    new SupplyJobRunner(fake.deps, { profile, ammSight }, world.fns());
  /** One run of the job, as the aggregator does it. */
  const run = (r: SupplyJobRunner, tick = fake.tick()): Promise<void> => r.job().run(tick);
  const minutes = (n: number): number => n * 60_000;
  const advance = (ms: number): void => jest.setSystemTime(Date.now() + ms);
  const ageGauge = (): jest.Mock => fake.metrics.supplySnapshotAgeSeconds.set;
  const cycleGauge = (): jest.Mock => fake.metrics.supplyCycleSeconds.set;
  const warnings = (): string[] => fake.logger.warn.mock.calls.map(([text]) => text as string);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    fake = fakeDeps({ budgetMs: BUDGET_MS });
    world = new FakeSupply();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('is the job supply, with the budget of its deps', () => {
    const job = new SupplyJobRunner(fakeDeps({ budgetMs: 1234 }).deps, { profile: xahau }, world.fns()).job();
    expect(job.name).toBe('supply');
    expect(job.budgetMs).toBe(1234);
  });

  describe('when a cycle starts', () => {
    it('starts a cycle only an hour after the newest snapshot started', async () => {
      const r = runner();
      world.snapshot = snapshotOf({
        started_at: NOW_SECONDS - SUPPLY_INTERVAL_MS / 1000 + 1,
        close_time: NOW_SECONDS - 60,
      });
      await run(r);
      expect(world.reads).toBe(1);
      expect(world.starts).toHaveLength(0);

      world.snapshot = snapshotOf({
        started_at: NOW_SECONDS - SUPPLY_INTERVAL_MS / 1000,
        close_time: NOW_SECONDS - 60,
      });
      await run(r);
      expect(world.starts).toEqual([{ startedAt: NOW_SECONDS, amm: undefined }]);
    });

    it('starts the first cycle when there is no snapshot, at the whole seconds of the clock', async () => {
      jest.setSystemTime(NOW.getTime() + 250);
      await run(runner());
      expect(world.starts).toEqual([{ startedAt: NOW_SECONDS, amm: undefined }]);
    });

    it('reads the newest snapshot once a run, and only without a cycle', async () => {
      world.steps = 12;
      world.stepMs = 1_000;
      const r = runner();
      await run(r);
      expect(world.reads).toBe(1);
      // the cycle goes on over the next runs: nothing is read for the cadence
      await run(r);
      expect(world.reads).toBe(1);
      expect(world.starts).toHaveLength(1);
    });

    it('reads the sight of the amm_pools runner when a start is attempted, and only on a network with an AMM', async () => {
      const sight: SupplyAmmSight = { cursor: 4_990, setAside: ['rSetAside'] };
      const ammSight = jest.fn(() => sight);
      world.steps = 12;
      world.stepMs = 1_000;
      const r = runner(xrpl, ammSight);
      world.snapshot = snapshotOf({ started_at: NOW_SECONDS - 60, close_time: NOW_SECONDS - 90 });
      await run(r);
      expect(ammSight).not.toHaveBeenCalled(); // the cadence says not yet
      advance(minutes(60));
      await run(r);
      expect(ammSight).toHaveBeenCalledTimes(1);
      expect(world.starts[0].amm).toBe(sight);
      // the runs of the cycle that follow do not read it
      await run(r);
      expect(ammSight).toHaveBeenCalledTimes(1);

      const xahauSight = jest.fn(() => sight);
      world.starts = [];
      await run(runner(xahau, xahauSight));
      expect(xahauSight).not.toHaveBeenCalled();
      expect(world.starts[0].amm).toBeUndefined();
    });

    it('lends an AMM network with no amm_pools runner a sight with no cursor, so that the start waits', async () => {
      await run(runner(xrpl));
      expect(world.starts).toEqual([{ startedAt: NOW_SECONDS, amm: { cursor: undefined, setAside: [] } }]);
    });

    it('warns once after 10 waiting ticks, and once more after a cycle has started and a start waits again', async () => {
      world.waiting = 'escrows';
      const r = runner();
      const said = 'supply: waiting for escrows/amm_pools to reach the head';
      for (let tick = 1; tick < SUPPLY_START_WAIT_TICKS; tick++) await run(r);
      expect(warnings()).toEqual([]);
      await run(r);
      expect(warnings()).toEqual([said]);
      for (let tick = 0; tick < 10; tick++) await run(r);
      expect(warnings()).toEqual([said]);
      expect(fake.failures).toEqual([]);

      // a cycle starts (and, steps being instant, is written): the count begins again, and so does the warning
      world.waiting = undefined;
      await run(r);
      expect(world.writes).toHaveLength(1);
      world.waiting = 'amm_pools';
      advance(SUPPLY_INTERVAL_MS);
      for (let tick = 1; tick < SUPPLY_START_WAIT_TICKS; tick++) await run(r);
      expect(warnings()).toEqual([said]);
      await run(r);
      expect(warnings()).toEqual([said, said]);
    });

    it('does not count a run that attempts no start as a waiting tick', async () => {
      world.waiting = 'escrows';
      const r = runner();
      for (let tick = 1; tick < SUPPLY_START_WAIT_TICKS; tick++) await run(r);
      // an hour has not passed since the newest snapshot started: no start, nothing counted
      world.snapshot = snapshotOf({ started_at: NOW_SECONDS - 60, close_time: NOW_SECONDS - 90 });
      for (let tick = 0; tick < 20; tick++) await run(r);
      expect(warnings()).toEqual([]);
      world.snapshot = undefined;
      await run(r);
      expect(warnings()).toHaveLength(1);
    });
  });

  describe('the steps of a cycle', () => {
    it('runs steps until the deadline and goes on at the next tick', async () => {
      world.steps = 12;
      world.stepMs = 1_000;
      const r = runner();
      // the start is the run's first unit and takes no time here; a step starts while the clock is before the deadline (5 s)
      await run(r);
      expect(world.attempts).toEqual([0, 1, 2, 3, 4]);
      expect(world.writes).toHaveLength(0);
      await run(r);
      expect(world.attempts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      await run(r);
      expect(world.attempts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      expect(world.writes).toHaveLength(1);
      expect(world.starts).toHaveLength(1);
    });

    it('always runs one step of a run, even past the deadline, and the start is the one forced unit of the run that makes it', async () => {
      world.steps = 5;
      const r = runner();
      const late = () => ({ ...fake.tick(), deadline: Date.now() - 1 });
      // the deadline has passed: the start is made, and no step follows it
      await run(r, late());
      expect(world.starts).toHaveLength(1);
      expect(world.attempts).toEqual([]);
      // the next run takes exactly one step, though the deadline has passed
      await run(r, late());
      expect(world.attempts).toEqual([0]);
      await run(r, late());
      expect(world.attempts).toEqual([0, 1]);
      // with time left, a start is followed by steps
      await run(r);
      expect(world.attempts).toEqual([0, 1, 2, 3, 4]);
      expect(world.writes).toHaveLength(1);
    });

    it('writes the snapshot as soon as the last step is done, though the deadline has passed by then', async () => {
      world.steps = 2;
      world.stepMs = 3_000;
      // the second step starts at 3 s, before the deadline (5 s), and ends at 6 s: the write is not a step that needs time
      await run(runner());
      expect(world.attempts).toEqual([0, 1]);
      expect(world.writes).toHaveLength(1);
      expect(world.writes[0].computedAt).toBe(NOW_SECONDS + 6);
    });

    it('takes no step once the stop has begun, and does not start a cycle', async () => {
      world.steps = 5;
      const r = runner();
      await run(r, { ...fake.tick(), deadline: Date.now() - 1 });
      fake.closing = true;
      await run(r);
      expect(world.attempts).toEqual([]);
      expect(world.writes).toEqual([]);

      const other = runner();
      world.starts = [];
      world.reads = 0;
      await run(other);
      expect(world.reads).toBe(0);
      expect(world.starts).toEqual([]);
      expect(ageGauge()).not.toHaveBeenCalled();
    });

    it('stops in the middle of a run when the stop begins, and writes nothing after it', async () => {
      world.steps = 3;
      // the stop begins during the last step
      world.onStep = (place) => {
        if (place === 2) fake.closing = true;
      };
      const r = runner();
      await run(r);
      expect(world.attempts).toEqual([0, 1, 2]);
      expect(world.writes).toEqual([]);
      expect(cycleGauge()).not.toHaveBeenCalled();
      expect(fake.failures).toEqual([]);

      // nothing goes on while the stop lasts
      await run(r);
      expect(world.attempts).toEqual([0, 1, 2]);
      expect(world.writes).toEqual([]);
    });

    it('warns once about steps that took longer than the budget, and says how long', async () => {
      world.steps = 4;
      world.onStep = (place) => {
        if (place <= 1) advance(BUDGET_MS + 1_000);
      };
      await run(runner(), { ...fake.tick(), deadline: Date.now() + minutes(10) });
      expect(warnings()).toEqual([`supply: a step took ${BUDGET_MS + 1_000} ms, over its budget of ${BUDGET_MS} ms`]);
    });

    it('warns again about a slow step once a step has come in time', async () => {
      world.steps = 4;
      world.onStep = (place) => {
        if (place !== 1) advance(BUDGET_MS + 1);
      };
      await run(runner(), { ...fake.tick(), deadline: Date.now() + minutes(10) });
      expect(warnings()).toEqual([
        `supply: a step took ${BUDGET_MS + 1} ms, over its budget of ${BUDGET_MS} ms`,
        `supply: a step took ${BUDGET_MS + 1} ms, over its budget of ${BUDGET_MS} ms`,
      ]);
    });
  });

  describe('failures', () => {
    it('ends the run at a step that failed, keeps it first, and tries it again at the next tick, not at once', async () => {
      world.steps = 5;
      world.failTimes.set(2, 1);
      const r = runner();
      await run(r);
      // the start, steps 0 and 1, and step 2 failed: the run ends there, with steps left and time to spare
      expect(world.attempts).toEqual([0, 1, 2]);
      expect(fake.failures).toHaveLength(1);
      expect(fake.failures[0]).toMatchObject({ job: 'supply', where: ' in the accounts step' });
      expect((fake.failures[0].err as Error).message).toContain('memory limit in step 2');
      expect(world.writes).toHaveLength(0);

      await run(r);
      expect(world.attempts).toEqual([0, 1, 2, 2, 3, 4]);
      expect(fake.failures).toHaveLength(1);
      expect(world.writes).toHaveLength(1);
      // the cycle was kept: one start, and its sums are those of five steps, each counted once
      expect(world.starts).toHaveLength(1);
      expect(world.writes[0].cycle.accounts).toBe(5n);
    });

    it('drops the cycle after the third failure of a step in a row, then waits 5 minutes before the next start', async () => {
      world.steps = 5;
      world.failTimes.set(2, 3);
      const r = runner();
      await run(r);
      await run(r);
      expect(fake.failures).toHaveLength(2);
      expect(warnings()).toEqual([]);
      await run(r);
      expect(fake.failures).toHaveLength(3);
      expect(world.attempts).toEqual([0, 1, 2, 2, 2]);
      expect(warnings()).toEqual([expect.stringContaining('supply: the cycle at ledger 5000 was dropped')]);
      expect(warnings()[0]).toContain('5 min');

      // the wait: nothing is read, nothing starts
      const reads = world.reads;
      advance(AGGREGATE_RETRY_MS - 1);
      await run(r);
      expect(world.reads).toBe(reads);
      expect(world.starts).toHaveLength(1);
      advance(1);
      await run(r);
      expect(world.reads).toBe(reads + 1);
      expect(world.starts).toHaveLength(2);
      // the new cycle starts over from its first step, and the fault is gone
      expect(world.attempts.slice(5)).toEqual([0, 1, 2, 3, 4]);
      expect(world.writes).toHaveLength(1);
    });

    it('waits 5 minutes after a drop, doubling for each further drop up to an hour, and a written row resets the wait', async () => {
      world.startError = new Error('connect ECONNREFUSED');
      const r = runner();
      const threeFailures = async (): Promise<void> => {
        for (let i = 0; i < 3; i++) await run(r);
      };
      await threeFailures();
      for (const wait of [5, 10, 20, 40, 60, 60]) {
        const starts = world.starts.length;
        const reads = world.reads;
        // a minute short of the wait, nothing is read and nothing starts
        advance(minutes(wait) - 1);
        await run(r);
        expect(world.reads).toBe(reads);
        expect(world.starts).toHaveLength(starts);
        // the wait is over: three starts are tried and fail, and the wait that follows is twice as long
        advance(1);
        await threeFailures();
        expect(world.starts).toHaveLength(starts + 3);
      }
      expect(AGGREGATE_RETRY_MS).toBe(minutes(5));
      expect(AGGREGATE_MAX_RETRY_MS).toBe(minutes(60));

      // the connection is back: a cycle is written, and the next failures wait 5 minutes again
      world.startError = undefined;
      advance(minutes(60));
      await run(r);
      expect(world.writes).toHaveLength(1);
      world.startError = new Error('connect ECONNREFUSED');
      advance(SUPPLY_INTERVAL_MS);
      await threeFailures();
      const reads = world.reads;
      advance(minutes(5) - 1);
      await run(r);
      expect(world.reads).toBe(reads);
      advance(1);
      await run(r);
      expect(world.reads).toBe(reads + 1);
    });

    it('counts the failures of a step across runs: a failure every other run, with runs that attempt nothing between, still drops the cycle at its third', async () => {
      world.steps = 5;
      world.failTimes.set(1, 10);
      const r = runner();
      const idle = async (): Promise<void> => {
        // a run in which the stop has begun attempts nothing: the streak is neither counted nor cleared
        fake.closing = true;
        await run(r);
        fake.closing = false;
      };
      await run(r); // the first failure of step 1
      await idle();
      await run(r); // the second
      await idle();
      expect(fake.failures).toHaveLength(2);
      expect(warnings()).toEqual([]);
      await run(r); // the third
      expect(fake.failures).toHaveLength(3);
      expect(world.attempts).toEqual([0, 1, 1, 1]);
      expect(warnings()).toEqual([expect.stringContaining('was dropped')]);
      // the cycle is gone and the wait has begun
      const reads = world.reads;
      await run(r);
      expect(world.reads).toBe(reads);
    });

    it('does not clear the streak of a step in a run that never reaches it, and clears it when the step works', async () => {
      world.steps = 5;
      world.failTimes.set(1, 2);
      const r = runner();
      await run(r);
      await run(r);
      expect(fake.failures).toHaveLength(2);
      // step 1 works at its third attempt: the streak is cleared, and a later step that fails starts at one
      world.failTimes.set(3, 2);
      await run(r);
      expect(world.attempts).toEqual([0, 1, 1, 1, 2, 3]);
      expect(fake.failures).toHaveLength(3);
      await run(r);
      expect(fake.failures).toHaveLength(4);
      expect(warnings()).toEqual([]);
      await run(r);
      expect(world.writes).toHaveLength(1);
      expect(world.writes[0].cycle.accounts).toBe(5n);
    });

    it('does not count a failure that comes of the shutdown, and keeps nothing of it', async () => {
      world.steps = 3;
      world.failTimes.set(1, 5);
      world.onStep = (place) => {
        if (place === 1) fake.closing = true;
      };
      const r = runner();
      await run(r);
      // `failed` was told (it decides what a failure of the shutdown is), and the streak was not
      expect(fake.failures).toHaveLength(1);
      fake.closing = false;
      world.failTimes.set(1, 2);
      world.onStep = undefined;
      await run(r);
      await run(r);
      expect(fake.failures).toHaveLength(3);
      // the second and third failures counted as the first and second: the cycle is not dropped yet
      expect(warnings()).toEqual([]);
    });

    it('counts a start that throws as a failed step of its own, with the same streak and the same wait', async () => {
      world.startError = new Error('connect ECONNREFUSED');
      const r = runner();
      await run(r);
      await run(r);
      expect(fake.failures.map(({ job, where }) => [job, where])).toEqual([
        ['supply', ' in the start'],
        ['supply', ' in the start'],
      ]);
      expect(warnings()).toEqual([]);
      await run(r);
      expect(fake.failures).toHaveLength(3);
      expect(warnings()).toEqual([expect.stringContaining('supply: the start failed 3 times in a row')]);
      const reads = world.reads;
      await run(r);
      expect(world.reads).toBe(reads);
      advance(AGGREGATE_RETRY_MS);
      world.startError = undefined;
      await run(r);
      expect(world.writes).toHaveLength(1);
    });

    it('clears the streak of the start when a start answers that it waits', async () => {
      const r = runner();
      world.startError = new Error('connect ECONNREFUSED');
      await run(r);
      await run(r);
      world.startError = undefined;
      world.waiting = 'escrows';
      await run(r);
      world.waiting = undefined;
      world.startError = new Error('connect ECONNREFUSED');
      await run(r);
      await run(r);
      // four failures in all, no three in a row: nothing is waited for
      expect(fake.failures).toHaveLength(4);
      expect(warnings()).toEqual([]);
      const reads = world.reads;
      await run(r);
      expect(world.reads).toBe(reads + 1);
      expect(warnings()).toEqual([expect.stringContaining('the start failed 3 times in a row')]);
    });

    it('does not begin the count of waiting ticks again when a start threw in between', async () => {
      // the waiting ticks need ten answers of "waiting": a start that threw in between is neither one of them nor the end of them
      const r = runner();
      world.waiting = 'escrows';
      for (let i = 0; i < 5; i++) await run(r);
      world.waiting = undefined;
      world.startError = new Error('connect ECONNREFUSED');
      await run(r);
      world.startError = undefined;
      world.waiting = 'escrows';
      for (let i = 0; i < 4; i++) await run(r);
      expect(warnings()).toEqual([]);
      await run(r);
      expect(warnings()).toEqual(['supply: waiting for escrows/amm_pools to reach the head']);
    });

    it('counts a read of the newest snapshot that fails as a failed step, and the run returns without starting', async () => {
      world.readError = new Error('connect ECONNREFUSED');
      const r = runner();
      await run(r);
      expect(fake.failures).toHaveLength(1);
      expect(fake.failures[0]).toMatchObject({ job: 'supply', where: ' reading the newest snapshot' });
      expect(world.starts).toHaveLength(0);
      await run(r);
      await run(r);
      expect(warnings()).toEqual([expect.stringContaining('failed 3 times in a row')]);
      const reads = world.reads;
      await run(r);
      expect(world.reads).toBe(reads);
    });

    it('counts a write that fails as a failed step, kept in place for the next tick', async () => {
      world.steps = 2;
      world.writeError = new Error('DB::Exception: too many parts');
      const r = runner();
      await run(r);
      expect(world.writes).toHaveLength(1);
      expect(fake.failures).toEqual([{ job: 'supply', err: world.writeError, where: ' writing the snapshot' }]);
      expect(cycleGauge()).not.toHaveBeenCalled();
      // the cycle is whole: the next run writes it again, with no step to run
      world.writeError = undefined;
      await run(r);
      expect(world.attempts).toEqual([0, 1]);
      expect(world.writes).toHaveLength(2);
      expect(world.starts).toHaveLength(1);
      expect(cycleGauge()).toHaveBeenCalledTimes(1);
    });
  });

  describe('the snapshot', () => {
    it('writes one row with the sums of every step, passes the signal of the tick and the whole seconds of the clock, and sets both gauges', async () => {
      world.steps = 3;
      world.stepMs = 500;
      const tick = fake.tick();
      await run(runner(), tick);

      expect(world.attempts).toEqual([0, 1, 2]);
      expect(world.writes).toHaveLength(1);
      const [{ cycle, computedAt, signal }] = world.writes;
      expect(cycle.pending).toEqual([]);
      expect(cycle.accounts).toBe(3n);
      expect(cycle.ownerCount).toBe(6n);
      // the clock is 1.5 s after the start: the second the row is written in, whole
      expect(computedAt).toBe(NOW_SECONDS + 1);
      expect(signal).toBe(tick.signal);
      expect(fake.abort.signal).toBe(tick.signal);
      // the wall time from the start of the cycle to the write
      expect(cycleGauge()).toHaveBeenCalledTimes(1);
      expect(cycleGauge()).toHaveBeenCalledWith(1.5);
      // and the age of the newest snapshot, now the one written: whole seconds from its ledger's close time
      expect(ageGauge()).toHaveBeenLastCalledWith(31);
      expect(fake.failures).toEqual([]);
    });

    it('logs one line for the cycle: the ledger, the plan, the seconds and the figures in drops', async () => {
      world.steps = 4;
      world.stepMs = 2_000;
      world.cycleOver = {
        amm: 5_000n,
        ammPools: 2,
        minted: { rewards: 7n, import: 20n, genesis_mint: 300n },
      };
      await run(runner(), { ...fake.tick(), deadline: Date.now() + minutes(1) });
      // 4 accounts and 8 owners of the steps: 4 x 1,000,000 + 8 x 200,000 = 5,600,000 drops of reserves
      expect(fake.logger.log).toHaveBeenCalledTimes(1);
      expect(fake.logger.log).toHaveBeenCalledWith(
        'supply: ledger 5000, 4 steps, 8 s, in drops: total 1000, burned 10, escrowed 100, amm 5000, reserves 5600000, minted 327',
      );
    });

    it('says in the line that it has no amm, no reserve values or no minting where it has none', async () => {
      world.steps = 1;
      world.cycleOver = { reserveBase: null, reserveInc: null };
      await run(runner());
      expect(fake.logger.log).toHaveBeenCalledWith(
        'supply: ledger 5000, 1 steps, 0 s, in drops: total 1000, burned 10, escrowed 100, amm none, reserves unknown, minted none',
      );
    });

    it('logs the number of steps the plan had, not the number left', async () => {
      world.steps = 12;
      world.stepMs = 1_000;
      const r = runner();
      await run(r);
      await run(r);
      await run(r);
      expect(fake.logger.log).toHaveBeenCalledWith(expect.stringContaining(', 12 steps, '));
    });

    it('warns once at the start about the pools it counts at their stored row, naming them, and at the write about the pools it counted as 0', async () => {
      world.steps = 3;
      world.cycleOver = { poolsAtStoredRow: ['rPoolB', 'rPoolA'], poolsAtZero: ['rZeroStart'] };
      world.zeroPools = ['rZeroStep'];
      await run(runner(xrpl, () => ({ cursor: 1, setAside: [] })));
      const said = warnings();
      expect(said).toHaveLength(2);
      expect(said[0]).toBe(
        'supply: 2 AMM pool(s) set aside by the amm_pools job are counted at their stored row, and not as of ledger 5000: rPoolB, rPoolA',
      );
      // the pools counted as 0 grow during the amm steps: they are said once, at the end, with what the steps added
      expect(said[1]).toBe(
        'supply: 2 AMM pool(s) with a native reserve that could not be read were counted as 0 in the snapshot of ledger 5000: rZeroStart, rZeroStep',
      );
    });

    it('lists at most ten pools in such a warning, and says how many more there are', async () => {
      world.steps = 1;
      const pools = Array.from({ length: 13 }, (_, i) => `rPool${String(i).padStart(2, '0')}`);
      world.cycleOver = { poolsAtStoredRow: pools };
      await run(runner(xrpl, () => ({ cursor: 1, setAside: pools })));
      expect(warnings()[0]).toBe(
        `supply: 13 AMM pool(s) set aside by the amm_pools job are counted at their stored row, and not as of ledger 5000: ${pools.slice(0, 10).join(', ')} and 3 more`,
      );
    });

    it('warns about nothing when no pool is set aside or unreadable', async () => {
      world.steps = 2;
      await run(runner(xrpl, () => ({ cursor: 1, setAside: [] })));
      expect(warnings()).toEqual([]);
    });
  });

  describe('the gauges', () => {
    it('sets the age of the newest snapshot at every run, from the snapshot it reads: now less its close time', async () => {
      world.snapshot = snapshotOf({ started_at: NOW_SECONDS - 600, close_time: NOW_SECONDS - 640 });
      const r = runner();
      await run(r);
      expect(ageGauge()).toHaveBeenLastCalledWith(640);
      advance(minutes(1));
      await run(r);
      expect(ageGauge()).toHaveBeenLastCalledWith(700);
      expect(ageGauge()).toHaveBeenCalledTimes(2);
    });

    it('sets it after a failed read too, from the last snapshot it knew', async () => {
      world.snapshot = snapshotOf({ started_at: NOW_SECONDS - 600, close_time: NOW_SECONDS - 640 });
      const r = runner();
      await run(r);
      expect(ageGauge()).toHaveBeenLastCalledWith(640);
      world.readError = new Error('connect ECONNREFUSED');
      advance(minutes(2));
      await run(r);
      expect(fake.failures).toHaveLength(1);
      expect(ageGauge()).toHaveBeenLastCalledWith(760);
      // and during the wait of the backoff, which reads nothing
      await run(r);
      await run(r);
      expect(world.reads).toBe(4);
      advance(minutes(1));
      await run(r);
      expect(world.reads).toBe(4);
      expect(ageGauge()).toHaveBeenLastCalledWith(820);
    });

    it('sets it from memory on the runs of a cycle, and after a failed step', async () => {
      world.snapshot = snapshotOf({ started_at: NOW_SECONDS - 3_700, close_time: NOW_SECONDS - 3_730 });
      world.steps = 5;
      world.failTimes.set(1, 1);
      const r = runner();
      await run(r);
      expect(fake.failures).toHaveLength(1);
      expect(ageGauge()).toHaveBeenLastCalledWith(3_730);
      advance(10_000);
      await run(r);
      // the cycle is written: the age is that of the snapshot just written (its ledger closed 30 s before the cycle began)
      expect(world.writes).toHaveLength(1);
      expect(ageGauge()).toHaveBeenLastCalledWith(40);
    });

    it('leaves the age unset in a process that knows no snapshot, and sets it once one is written', async () => {
      world.waiting = 'escrows';
      const r = runner();
      await run(r);
      await run(r);
      expect(ageGauge()).not.toHaveBeenCalled();
      world.readError = new Error('connect ECONNREFUSED');
      await run(r);
      expect(ageGauge()).not.toHaveBeenCalled();
      world.readError = undefined;
      world.waiting = undefined;
      await run(r);
      expect(world.writes).toHaveLength(1);
      expect(ageGauge()).toHaveBeenCalledTimes(1);
    });

    it('does not set the cycle gauge before a cycle has been written', async () => {
      world.steps = 12;
      world.stepMs = 1_000;
      await run(runner());
      expect(cycleGauge()).not.toHaveBeenCalled();
    });
  });
});
