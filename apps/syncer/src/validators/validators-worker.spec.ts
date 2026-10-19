import { ClickHouseService, ShutdownSignals } from '@gatehub/data-api-shared';
import { SyncerConfig } from '../config/syncer.config';
import { ComputeLoop } from './compute-loop';
import { DomainChecker } from './domain-checker';
import { NetworkStatePoller } from './network-state-poller';
import { seedValidatorSeen } from './seen-seed';
import { UnlFetcher } from './unl-fetcher';
import {
  DOMAIN_PASS_INTERVAL_MS,
  FEATURE_POLL_INTERVAL_MS,
  STATE_POLL_INTERVAL_MS,
  ValidatorsWorker,
} from './validators-worker';
import { ValidatorsWorkerOptions } from './validators.options';

jest.mock('./seen-seed', () => ({ seedValidatorSeen: jest.fn() }));
const seed = jest.mocked(seedValidatorSeen);

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
  const state = {
    pollState: jest.fn(async () => {
      calls.push('poll state');
      return true;
    }),
    pollFeatures: jest.fn(async () => {
      calls.push('poll features');
      return true;
    }),
    updateMetadataGauge: jest.fn(async () => {
      calls.push('gauge');
    }),
    stop: jest.fn(async () => {
      calls.push('stop state');
    }),
  };
  // the order in which the seeding and the compute loop were started and stopped, apart from the calls of the other loops
  const order: string[] = [];
  const compute = {
    start: jest.fn(() => {
      order.push('start compute');
    }),
    stop: jest.fn(async () => {
      order.push('stop compute');
    }),
  };
  seed.mockReset();
  seed.mockImplementation(async () => {
    order.push('seed');
    return true;
  });
  const ch = { query: jest.fn(), command: jest.fn() };
  const signals = { register: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const worker = new ValidatorsWorker(
    unl as unknown as UnlFetcher,
    domains as unknown as DomainChecker,
    state as unknown as NetworkStatePoller,
    compute as unknown as ComputeLoop,
    ch as unknown as ClickHouseService,
    { domainVerification: true, ...config } as SyncerConfig,
    signals as unknown as ShutdownSignals,
    { logger, ...options },
  );
  made.push(worker);
  return { worker, unl, domains, state, compute, ch, signals, calls, order, logger };
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
      const t = setup({ start: { state: false } }, { domainVerification: false });
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

  describe('the state loops', () => {
    it('polls the state at once, and again 60 s after each poll ended', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      expect(STATE_POLL_INTERVAL_MS).toBe(60_000);
      expect(t.state.pollState).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.state.pollState).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(59_999);
      expect(t.state.pollState).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.state.pollState).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(t.state.pollState).toHaveBeenCalledTimes(4);
      await t.worker.stop();
    });

    it('waits 60 s after a poll ends, never two at a time', async () => {
      jest.useFakeTimers();
      const t = setup();
      let finish!: () => void;
      t.state.pollState.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = () => resolve(true);
          }),
      );
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(200_000);
      expect(t.state.pollState).toHaveBeenCalledTimes(1);
      finish();
      await jest.advanceTimersByTimeAsync(59_999);
      expect(t.state.pollState).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.state.pollState).toHaveBeenCalledTimes(2);
      await t.worker.stop();
    });

    it('polls the features at once and every 10 min, and updates the gauge after each poll', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      expect(FEATURE_POLL_INTERVAL_MS).toBe(600_000);
      await jest.advanceTimersByTimeAsync(0);
      expect(t.state.pollFeatures).toHaveBeenCalledTimes(1);
      expect(t.state.updateMetadataGauge).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(599_999);
      expect(t.state.pollFeatures).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.state.pollFeatures).toHaveBeenCalledTimes(2);
      expect(t.state.updateMetadataGauge).toHaveBeenCalledTimes(2);
      // the order inside a pass: the poll, then the gauge
      const featurePasses = t.calls.filter((call) => call === 'poll features' || call === 'gauge');
      expect(featurePasses).toEqual(['poll features', 'gauge', 'poll features', 'gauge']);
      await t.worker.stop();
    });

    it('updates the gauge after a feature poll that wrote nothing too, and not before the poll is over', async () => {
      jest.useFakeTimers();
      const t = setup();
      let finish!: () => void;
      t.state.pollFeatures.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = () => resolve(false);
          }),
      );
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.state.updateMetadataGauge).not.toHaveBeenCalled();
      finish();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.state.updateMetadataGauge).toHaveBeenCalledTimes(1);
      await t.worker.stop();
    });

    it('does not let a slow feature poll hold up the state poll, nor the other way round', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.state.pollFeatures.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(120_000);
      expect(t.state.pollState).toHaveBeenCalledTimes(3);
      expect(t.state.pollFeatures).toHaveBeenCalledTimes(1);
      // the feature poll never ends: the stop gives up on it after its budget
      const stopping = t.worker.stop();
      await jest.advanceTimersByTimeAsync(2_000);
      await stopping;
    });

    it('logs a poll that fails, with its message only, and makes the next one on time', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.state.pollState.mockRejectedValueOnce(Object.assign(new Error('ClickHouse is down'), { secret: 'SECRET' }));
      t.state.updateMetadataGauge.mockRejectedValueOnce(new Error('gauge read failed'));
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      const lines = t.logger.warn.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(2);
      expect(lines.find((line) => line.includes('ClickHouse is down'))).toContain('Network state');
      expect(lines.find((line) => line.includes('gauge read failed'))).toContain('Amendment features');
      expect(lines.join('')).not.toContain('SECRET');
      await jest.advanceTimersByTimeAsync(60_000);
      expect(t.state.pollState).toHaveBeenCalledTimes(2);
      await t.worker.stop();
    });

    it('starts no state loop when start.state is false, and the others all the same', async () => {
      jest.useFakeTimers();
      const t = setup({ start: { state: false } });
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(700_000);
      expect(t.state.pollState).not.toHaveBeenCalled();
      expect(t.state.pollFeatures).not.toHaveBeenCalled();
      expect(t.unl.start).toHaveBeenCalled();
      expect(t.domains.pass).toHaveBeenCalled();
      await t.worker.stop();
      expect(t.state.stop).not.toHaveBeenCalled();
    });

    it('starts the state loops when only the other loops are switched off', async () => {
      jest.useFakeTimers();
      const t = setup({ start: { unl: false, domains: false } });
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.state.pollState).toHaveBeenCalledTimes(1);
      expect(t.state.pollFeatures).toHaveBeenCalledTimes(1);
      expect(t.unl.start).not.toHaveBeenCalled();
      expect(t.domains.pass).not.toHaveBeenCalled();
      await t.worker.stop();
    });

    it('starts them even when GH_DOMAIN_VERIFICATION is false', async () => {
      jest.useFakeTimers();
      const t = setup({}, { domainVerification: false });
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.state.pollState).toHaveBeenCalledTimes(1);
      await t.worker.stop();
    });

    it('does not start when the publishers cannot be registered', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.unl.registerPublishers.mockRejectedValueOnce(new Error('ClickHouse is down'));
      await expect(t.worker.onApplicationBootstrap()).rejects.toThrow('ClickHouse is down');
      await jest.advanceTimersByTimeAsync(700_000);
      expect(t.state.pollState).not.toHaveBeenCalled();
      expect(t.state.pollFeatures).not.toHaveBeenCalled();
    });

    it('on stop ends the timers, stops the poller and makes no more polls', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await t.worker.stop();
      expect(t.state.stop).toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(700_000);
      expect(t.state.pollState).toHaveBeenCalledTimes(1);
      expect(t.state.pollFeatures).toHaveBeenCalledTimes(1);
    });

    it('on stop waits for the poll under way, then ends', async () => {
      jest.useFakeTimers();
      const t = setup();
      let finish!: () => void;
      t.state.pollState.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = () => resolve(true);
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
    });

    it('stops waiting for a poll after 2 s, like for any loop', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.state.pollState.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
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

  describe('the compute loop', () => {
    it('seeds validator_seen first, then starts the compute loop after the other loops', async () => {
      const t = setup();
      await t.worker.onApplicationBootstrap();
      expect(t.order).toEqual(['seed', 'start compute']);
      // the seeding is the first thing the worker does: before the publishers are registered
      expect(seed).toHaveBeenCalledWith(t.ch);
      expect(seed.mock.invocationCallOrder[0]).toBeLessThan(t.unl.registerPublishers.mock.invocationCallOrder[0]);
      expect(t.compute.start.mock.invocationCallOrder[0]).toBeGreaterThan(t.unl.start.mock.invocationCallOrder[0]);
      await t.worker.stop();
    });

    it('says so when it seeded, and nothing when the table had rows', async () => {
      const seeded = setup();
      await seeded.worker.onApplicationBootstrap();
      expect(seeded.logger.log).toHaveBeenCalledWith('validator_seen was empty: seeded it from validations');
      const present = setup();
      seed.mockImplementation(async () => false);
      await present.worker.onApplicationBootstrap();
      expect(present.logger.log).not.toHaveBeenCalled();
      expect(present.compute.start).toHaveBeenCalledTimes(1);
    });

    it('starts neither the seeding nor the loop when start.compute is false, and the others all the same', async () => {
      const t = setup({ start: { compute: false } });
      await t.worker.onApplicationBootstrap();
      expect(seed).not.toHaveBeenCalled();
      expect(t.compute.start).not.toHaveBeenCalled();
      expect(t.unl.start).toHaveBeenCalled();
      await t.worker.stop();
      expect(t.compute.stop).not.toHaveBeenCalled();
    });

    it('starts the compute loop when only the other loops are switched off', async () => {
      const t = setup({ start: { unl: false, domains: false, state: false } });
      await t.worker.onApplicationBootstrap();
      expect(t.order).toEqual(['seed', 'start compute']);
      expect(t.unl.start).not.toHaveBeenCalled();
      await t.worker.stop();
    });

    it('fails the boot, with nothing started, when validator_seen cannot be seeded', async () => {
      const t = setup();
      seed.mockRejectedValueOnce(new Error('ClickHouse is down'));
      await expect(t.worker.onApplicationBootstrap()).rejects.toThrow('ClickHouse is down');
      expect(t.unl.registerPublishers).not.toHaveBeenCalled();
      expect(t.unl.start).not.toHaveBeenCalled();
      expect(t.compute.start).not.toHaveBeenCalled();
    });

    it('stops the compute loop with the others on module destroy and on the shutdown signal', async () => {
      const t = setup();
      await t.worker.onApplicationBootstrap();
      await t.worker.onModuleDestroy();
      expect(t.compute.stop).toHaveBeenCalledTimes(1);
      await (t.signals.register.mock.calls[0][1] as () => Promise<void>)();
      expect(t.compute.stop).toHaveBeenCalledTimes(1);
    });

    it('stops waiting for a compute loop that does not stop after 2 s, like for any loop', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.compute.stop.mockImplementation(() => new Promise<void>(() => undefined));
      await t.worker.onApplicationBootstrap();
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
