import { ShutdownSignals } from '@gatehub/data-api-shared';
import { SyncerConfig } from '../config/syncer.config';
import { DomainChecker } from './domain-checker';
import { UnlFetcher } from './unl-fetcher';
import { DOMAIN_PASS_INTERVAL_MS, ValidatorsWorker } from './validators-worker';
import { ValidatorsWorkerOptions } from './validators.options';

/** The workers a test made: each is stopped after it, so that no loop outlives its test. */
const made: ValidatorsWorker[] = [];

function setup(options: ValidatorsWorkerOptions = {}, config: Partial<SyncerConfig> = {}) {
  const calls: string[] = [];
  const unl = {
    registerPublishers: jest.fn(async () => {
      calls.push('register');
    }),
    start: jest.fn(() => {
      calls.push('start');
    }),
    stop: jest.fn(async () => {
      calls.push('stop');
    }),
  };
  const domains = {
    pass: jest.fn(async () => {
      calls.push('pass');
      return 0;
    }),
    stop: jest.fn(async () => {
      calls.push('stop domains');
    }),
  };
  const signals = { register: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const worker = new ValidatorsWorker(
    unl as unknown as UnlFetcher,
    domains as unknown as DomainChecker,
    { domainVerification: true, ...config } as SyncerConfig,
    signals as unknown as ShutdownSignals,
    { logger, ...options },
  );
  made.push(worker);
  return { worker, unl, domains, signals, calls, logger };
}

describe('ValidatorsWorker', () => {
  afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(made.splice(0).map((worker) => worker.stop()));
  });

  it('registers the publishers, then starts the UNL fetcher, and registers its shutdown', async () => {
    const t = setup();
    await t.worker.onApplicationBootstrap();
    expect(t.calls).toEqual(['register', 'start']);
    expect(t.signals.register).toHaveBeenCalledWith('validators', expect.any(Function));
  });

  it('starts no UNL loop when start.unl is false', async () => {
    const t = setup({ start: { unl: false } });
    await t.worker.onApplicationBootstrap();
    expect(t.unl.registerPublishers).not.toHaveBeenCalled();
    expect(t.unl.start).not.toHaveBeenCalled();
    await t.worker.stop();
    expect(t.unl.stop).not.toHaveBeenCalled();
  });

  it('starts the UNL loop when only the other loops are switched off', async () => {
    const t = setup({ start: { domains: false, state: false, compute: false } });
    await t.worker.onApplicationBootstrap();
    expect(t.calls).toEqual(['register', 'start']);
  });

  it('does not start the loop, and fails the boot, when the publishers cannot be registered', async () => {
    const t = setup();
    t.unl.registerPublishers.mockRejectedValueOnce(new Error('ClickHouse is down'));
    await expect(t.worker.onApplicationBootstrap()).rejects.toThrow('ClickHouse is down');
    expect(t.unl.start).not.toHaveBeenCalled();
  });

  it('stops every loop on module destroy and on the shutdown signal', async () => {
    const t = setup();
    await t.worker.onApplicationBootstrap();
    await t.worker.onModuleDestroy();
    expect(t.unl.stop).toHaveBeenCalledTimes(1);
    // the cleanup registered with ShutdownSignals is the same stop, and a second one changes nothing
    await (t.signals.register.mock.calls[0][1] as () => Promise<void>)();
    expect(t.unl.stop).toHaveBeenCalledTimes(1);
  });

  it('stops a worker that was never started', async () => {
    const t = setup();
    await expect(t.worker.stop()).resolves.toBeUndefined();
    expect(t.unl.stop).not.toHaveBeenCalled();
  });

  it('waits at most 2 s for the loops to stop', async () => {
    jest.useFakeTimers();
    const t = setup();
    t.unl.stop.mockImplementation(() => new Promise<void>(() => undefined)); // a loop that never ends
    await t.worker.onApplicationBootstrap();
    let stopped = false;
    const stopping = t.worker.stop().then(() => (stopped = true));
    await jest.advanceTimersByTimeAsync(1999);
    expect(stopped).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not wait for the budget when the loops stop at once', async () => {
    jest.useFakeTimers();
    const t = setup();
    await t.worker.onApplicationBootstrap();
    await t.worker.stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not fail the stop when a loop fails to stop', async () => {
    const t = setup();
    t.unl.stop.mockRejectedValueOnce(new Error('stop failed'));
    await t.worker.onApplicationBootstrap();
    await expect(t.worker.stop()).resolves.toBeUndefined();
  });

  describe('the domain loop', () => {
    it('makes a pass at once, and another every 60 s', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      expect(DOMAIN_PASS_INTERVAL_MS).toBe(60_000);
      expect(t.domains.pass).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.domains.pass).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(59_999);
      expect(t.domains.pass).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.domains.pass).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(t.domains.pass).toHaveBeenCalledTimes(4);
      await t.worker.stop();
    });

    it('waits 60 s after a pass ends, never two at a time', async () => {
      jest.useFakeTimers();
      const t = setup();
      let finish!: () => void;
      t.domains.pass.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finish = () => resolve(3);
          }),
      );
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(200_000);
      expect(t.domains.pass).toHaveBeenCalledTimes(1);
      finish();
      await jest.advanceTimersByTimeAsync(59_999);
      expect(t.domains.pass).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.domains.pass).toHaveBeenCalledTimes(2);
      await t.worker.stop();
    });

    it('logs a pass that fails, with its message only, and makes the next one on time', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.domains.pass.mockRejectedValueOnce(Object.assign(new Error('ClickHouse is down'), { secret: 'SECRET' }));
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      const [line, ...rest] = t.logger.warn.mock.calls[0] as unknown[];
      expect(line).toContain('ClickHouse is down');
      expect(rest).toEqual([]);
      expect(String(line)).not.toContain('SECRET');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(t.domains.pass).toHaveBeenCalledTimes(2);
      await t.worker.stop();
    });

    it('makes no pass when GH_DOMAIN_VERIFICATION is false', async () => {
      jest.useFakeTimers();
      const t = setup({}, { domainVerification: false });
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(200_000);
      expect(t.domains.pass).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await t.worker.stop();
      expect(t.domains.stop).not.toHaveBeenCalled();
      // the UNL loop is on all the same
      expect(t.unl.start).toHaveBeenCalled();
    });

    it('makes no pass when start.domains is false', async () => {
      jest.useFakeTimers();
      const t = setup({ start: { domains: false } });
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(200_000);
      expect(t.domains.pass).not.toHaveBeenCalled();
      expect(t.unl.start).toHaveBeenCalled();
    });

    it('starts the domain loop when only the UNL loop is switched off', async () => {
      jest.useFakeTimers();
      const t = setup({ start: { unl: false } });
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.domains.pass).toHaveBeenCalledTimes(1);
      expect(t.unl.start).not.toHaveBeenCalled();
      await t.worker.stop();
    });

    it('does not start when the publishers cannot be registered', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.unl.registerPublishers.mockRejectedValueOnce(new Error('ClickHouse is down'));
      await expect(t.worker.onApplicationBootstrap()).rejects.toThrow('ClickHouse is down');
      await jest.advanceTimersByTimeAsync(200_000);
      expect(t.domains.pass).not.toHaveBeenCalled();
    });

    it('on stop ends the timer, stops the checker and makes no more passes', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await t.worker.stop();
      expect(t.domains.stop).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(200_000);
      expect(t.domains.pass).toHaveBeenCalledTimes(1);
    });

    it('on stop waits for the pass under way, then ends', async () => {
      jest.useFakeTimers();
      const t = setup();
      let finish!: () => void;
      t.domains.pass.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            finish = () => resolve(0);
          }),
      );
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      let stopped = false;
      const stopping = t.worker.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(stopped).toBe(false);
      finish();
      await stopping;
      expect(stopped).toBe(true);
      await jest.advanceTimersByTimeAsync(200_000);
      expect(t.domains.pass).toHaveBeenCalledTimes(1);
    });

    it('stops waiting for a pass after 2 s, like for any loop', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.domains.pass.mockImplementationOnce(() => new Promise<number>(() => undefined));
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      let stopped = false;
      const stopping = t.worker.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(1_999);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
    });
  });
});
