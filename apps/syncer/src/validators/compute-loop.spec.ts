import {
  COMPUTE_INTERVAL_MS,
  COMPUTE_SHUTDOWN_WAIT_MS,
  COMPUTE_TICK_BUDGET_MS,
  ComputeJob,
  ComputeLoop,
  ComputeLoopOptions,
  ComputeTick,
} from './compute-loop';

const START = 1_760_000_000_000;

/** A job that notes the tick it was given and, if asked, runs `body`. */
function job(
  name: ComputeJob['name'],
  budgetMs: number,
  seen: Array<[string, ComputeTick]>,
  body: (tick: ComputeTick) => Promise<void> | void = () => undefined,
): ComputeJob & { run: jest.Mock } {
  return {
    name,
    budgetMs,
    run: jest.fn(async (tick: ComputeTick) => {
      seen.push([name, tick]);
      await body(tick);
    }),
  };
}

function setup(jobs: (seen: Array<[string, ComputeTick]>) => ComputeJob[], options: ComputeLoopOptions = {}) {
  let clock = START;
  const seen: Array<[string, ComputeTick]> = [];
  const counts: Array<[string, string]> = [];
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const metrics = {
    validatorsJobsTotal: {
      inc: jest.fn((labels: { job: string; outcome: string }) => void counts.push([labels.job, labels.outcome])),
    },
  };
  const loop = new ComputeLoop(jobs(seen), {
    now: () => clock,
    logger,
    metrics: metrics as unknown as ComputeLoopOptions['metrics'],
    ...options,
  });
  return { loop, seen, counts, logger, advance: (ms: number) => void (clock += ms) };
}

/** The loops a test made: each is stopped after it, so that no timer outlives its test. */
const made: ComputeLoop[] = [];
const track = <T extends { loop: ComputeLoop }>(t: T): T => {
  made.push(t.loop);
  return t;
};

describe('ComputeLoop', () => {
  afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(made.splice(0).map((loop) => loop.stop()));
  });

  it('has the cadence of the worker: a tick a minute, 20 s long, and a stop that waits 2 s', () => {
    expect(COMPUTE_INTERVAL_MS).toBe(60_000);
    expect(COMPUTE_TICK_BUDGET_MS).toBe(20_000);
    expect(COMPUTE_SHUTDOWN_WAIT_MS).toBe(2_000);
  });

  describe('a tick', () => {
    it('runs the jobs in order, each with the time of the tick and its own deadline', async () => {
      const t = track(setup((seen) => [job('rounds', 5_000, seen), job('agreement', 10_000, seen)]));
      await t.loop.tick();
      expect(t.seen.map(([name]) => name)).toEqual(['rounds', 'agreement']);
      expect(t.seen[0][1].now).toBe(START);
      expect(t.seen[0][1].deadline).toBe(START + 5_000);
      expect(t.seen[1][1].now).toBe(START);
      expect(t.seen[1][1].deadline).toBe(START + 10_000);
    });

    it('counts the budget of a job from the moment the job starts', async () => {
      let advance!: (ms: number) => void;
      const t = track(
        setup((seen) => [job('rounds', 5_000, seen, () => advance(4_000)), job('agreement', 10_000, seen)]),
      );
      advance = t.advance;
      await t.loop.tick();
      expect(t.seen[0][1].deadline).toBe(START + 5_000);
      expect(t.seen[1][1].deadline).toBe(START + 4_000 + 10_000);
    });

    it('never gives a job more than what is left of the tick', async () => {
      let advance!: (ms: number) => void;
      const t = track(
        setup((seen) => [job('rounds', 5_000, seen, () => advance(4_000)), job('agreement', 60_000, seen)], {
          tickBudgetMs: 20_000,
        }),
      );
      advance = t.advance;
      await t.loop.tick();
      expect(t.seen[1][1].deadline).toBe(START + 20_000);
    });

    it('uses a tick of 20 s by default', async () => {
      const t = track(setup((seen) => [job('rounds', 60_000, seen)]));
      await t.loop.tick();
      expect(t.seen[0][1].deadline).toBe(START + COMPUTE_TICK_BUDGET_MS);
    });

    it('counts a job that ends as ok', async () => {
      const t = track(setup((seen) => [job('rounds', 5_000, seen), job('agreement', 10_000, seen)]));
      await t.loop.tick();
      await t.loop.tick();
      expect(t.counts).toEqual([
        ['rounds', 'ok'],
        ['agreement', 'ok'],
        ['rounds', 'ok'],
        ['agreement', 'ok'],
      ]);
    });

    it('logs and counts a job that throws, and still runs the next', async () => {
      const t = track(
        setup((seen) => [
          job('rounds', 5_000, seen, () => {
            throw Object.assign(new Error('ClickHouse is down'), { secret: 'SECRET' });
          }),
          job('agreement', 10_000, seen),
        ]),
      );
      await expect(t.loop.tick()).resolves.toBeUndefined();
      expect(t.seen.map(([name]) => name)).toEqual(['rounds', 'agreement']);
      expect(t.counts).toEqual([
        ['rounds', 'error'],
        ['agreement', 'ok'],
      ]);
      // the message only: never the error object
      expect(t.logger.error).toHaveBeenCalledTimes(1);
      const [line, ...rest] = t.logger.error.mock.calls[0] as unknown[];
      expect(line).toBe('Compute job rounds failed: ClickHouse is down');
      expect(rest).toEqual([]);
      expect(String(line)).not.toContain('SECRET');
    });

    it('logs what is thrown that is not an error by its text', async () => {
      const t = track(
        setup((seen) => [
          job('rounds', 5_000, seen, () => {
            throw 'plain text';
          }),
        ]),
      );
      await t.loop.tick();
      expect(t.logger.error).toHaveBeenCalledWith('Compute job rounds failed: plain text');
    });

    it('runs on after a tick that failed: the next tick runs the jobs again', async () => {
      let fail = true;
      const t = track(
        setup((seen) => [
          job('rounds', 5_000, seen, () => {
            if (fail) throw new Error('once');
          }),
        ]),
      );
      await t.loop.tick();
      fail = false;
      await t.loop.tick();
      expect(t.counts).toEqual([
        ['rounds', 'error'],
        ['rounds', 'ok'],
      ]);
    });

    it('needs no metrics', async () => {
      const t = track(setup((seen) => [job('rounds', 5_000, seen)], { metrics: undefined }));
      await expect(t.loop.tick()).resolves.toBeUndefined();
      expect(t.seen).toHaveLength(1);
    });

    it('does not overlap: a tick called while one runs is skipped, with a warning', async () => {
      let release!: () => void;
      let runs = 0;
      const t = track(
        setup((seen) => [
          job('rounds', 5_000, seen, () =>
            // only the first run waits
            runs++ === 0
              ? new Promise<void>((resolve) => {
                  release = resolve;
                })
              : undefined,
          ),
        ]),
      );
      const first = t.loop.tick();
      await Promise.resolve();
      const second = t.loop.tick();
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      expect(t.logger.warn).toHaveBeenCalledWith('Skipping a compute tick: the previous tick is still running');
      release();
      await Promise.all([first, second]);
      expect(t.seen).toHaveLength(1);
      // the tick is over: the next one runs
      await t.loop.tick();
      expect(t.seen).toHaveLength(2);
    });
  });

  describe('start', () => {
    it('runs a tick at once and another every interval', async () => {
      jest.useFakeTimers();
      const t = track(setup((seen) => [job('rounds', 5_000, seen)], { intervalMs: 60_000 }));
      t.loop.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.seen).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(59_999);
      expect(t.seen).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.seen).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(t.seen).toHaveLength(4);
      await t.loop.stop();
    });

    it('starts once, however often it is called', async () => {
      jest.useFakeTimers();
      const t = track(setup((seen) => [job('rounds', 5_000, seen)]));
      t.loop.start();
      t.loop.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.seen).toHaveLength(1);
      await t.loop.stop();
    });

    it('does not start after a stop', async () => {
      jest.useFakeTimers();
      const t = track(setup((seen) => [job('rounds', 5_000, seen)]));
      await t.loop.stop();
      t.loop.start();
      await jest.advanceTimersByTimeAsync(180_000);
      expect(t.seen).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('stop', () => {
    it('ends the timer and runs no tick afterwards', async () => {
      jest.useFakeTimers();
      const t = track(setup((seen) => [job('rounds', 5_000, seen)]));
      t.loop.start();
      await jest.advanceTimersByTimeAsync(0);
      await t.loop.stop();
      expect(jest.getTimerCount()).toBe(0);
      await t.loop.tick();
      await jest.advanceTimersByTimeAsync(180_000);
      expect(t.seen).toHaveLength(1);
    });

    it('aborts the signal of the job in flight, waits for it, and starts no job after it', async () => {
      let observed: AbortSignal | undefined;
      let finish!: () => void;
      const t = track(
        setup((seen) => [
          job(
            'rounds',
            5_000,
            seen,
            (tick) =>
              new Promise<void>((resolve) => {
                observed = tick.signal;
                finish = resolve;
              }),
          ),
          job('agreement', 10_000, seen),
        ]),
      );
      const running = t.loop.tick();
      await Promise.resolve();
      expect(observed?.aborted).toBe(false);
      let stopped = false;
      const stopping = t.loop.stop().then(() => (stopped = true));
      expect(observed?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false); // the job has not ended
      finish();
      await Promise.all([running, stopping]);
      expect(stopped).toBe(true);
      expect(t.seen.map(([name]) => name)).toEqual(['rounds']);
      expect(t.logger.warn).not.toHaveBeenCalled();
    });

    it('waits at most 2 s for a job that does not end, and says so', async () => {
      jest.useFakeTimers();
      const t = track(setup((seen) => [job('rounds', 5_000, seen, () => new Promise<void>(() => undefined))]));
      void t.loop.tick();
      await jest.advanceTimersByTimeAsync(0);
      let stopped = false;
      const stopping = t.loop.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(1_999);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
      expect(t.logger.warn).toHaveBeenCalledWith(
        'Abandoning the compute tick in flight: it did not end within 2000 ms of the shutdown',
      );
      expect(jest.getTimerCount()).toBe(0);
    });

    it('waits as long as the option says', async () => {
      jest.useFakeTimers();
      const t = track(
        setup((seen) => [job('rounds', 5_000, seen, () => new Promise<void>(() => undefined))], {
          shutdownWaitMs: 500,
        }),
      );
      void t.loop.tick();
      await jest.advanceTimersByTimeAsync(0);
      let stopped = false;
      const stopping = t.loop.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(499);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
    });

    it('does not wait when nothing is running, and may be called again', async () => {
      jest.useFakeTimers();
      const t = track(setup((seen) => [job('rounds', 5_000, seen)]));
      await t.loop.stop();
      await t.loop.stop();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not count or log as a failure a job that fails because of the shutdown', async () => {
      let fail!: (err: Error) => void;
      const t = track(
        setup((seen) => [
          job(
            'rounds',
            5_000,
            seen,
            () =>
              new Promise<void>((_, reject) => {
                fail = reject;
              }),
          ),
        ]),
      );
      const running = t.loop.tick();
      await Promise.resolve();
      const stopping = t.loop.stop();
      fail(new Error('the client was closed'));
      await Promise.all([running, stopping]);
      expect(t.counts).toEqual([]);
      expect(t.logger.error).not.toHaveBeenCalled();
      expect(t.logger.log).toHaveBeenCalledWith('Compute job rounds ended at the shutdown: the client was closed');
    });
  });
});
