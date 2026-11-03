import { ShutdownSignals } from '@gatehub/data-api-shared';
import { SyncerConfig } from '../config/syncer.config';
import { DomainDiscovery, TOML_DISCOVERY_INTERVAL_MS } from './domain-discovery';
import { TomlChecker } from './toml-checker';
import { errorTextOf, TOMLS_PASS_INTERVAL_MS, TOMLS_STOP_WAIT_MS, TomlsWorker } from './tomls-worker';
import { TomlsWorkerOptions } from './tomls.options';

/** The workers a test made: each is stopped after it, so that no loop outlives its test. */
const made: TomlsWorker[] = [];

/**
 * The worker over a discovery and a checker that note what is called. The discovery is like the real one in what the
 * worker relies on: `ready` settles after the first `discover()` whatever came of it, and `loaded` turns true with the first
 * `discover()` that did not reject. What a read does is `read`, a mock a test changes.
 */
function setup(options: TomlsWorkerOptions = {}, config: Partial<SyncerConfig> = {}) {
  const calls: string[] = [];
  let markReady!: () => void;
  const discovery = {
    ready: new Promise<void>((resolve) => (markReady = resolve)),
    loaded: false,
    read: jest.fn(async () => undefined),
    discover: jest.fn(async () => {
      calls.push('discover');
      try {
        await discovery.read();
        discovery.loaded = true;
      } finally {
        markReady();
      }
    }),
  };
  const checker = {
    pass: jest.fn(async () => {
      calls.push('pass');
      return 0;
    }),
    stop: jest.fn(async () => {
      calls.push('stop checks');
    }),
  };
  const signals = { register: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const worker = new TomlsWorker(
    discovery as unknown as DomainDiscovery,
    checker as unknown as TomlChecker,
    { domainVerification: true, ...config } as SyncerConfig,
    signals as unknown as ShutdownSignals,
    { logger, ...options },
  );
  made.push(worker);
  return { worker, discovery, checker, signals, logger, calls };
}

describe('TomlsWorker', () => {
  afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(made.splice(0).map((worker) => worker.stop()));
  });

  it('has the cadence and the stop wait of the spec', () => {
    expect(TOMLS_PASS_INTERVAL_MS).toBe(60_000);
    expect(TOMLS_STOP_WAIT_MS).toBe(2_000);
    expect(TOML_DISCOVERY_INTERVAL_MS).toBe(300_000);
  });

  it('registers its shutdown as "tomls"', async () => {
    const t = setup();
    await t.worker.onApplicationBootstrap();
    expect(t.signals.register).toHaveBeenCalledTimes(1);
    expect(t.signals.register).toHaveBeenCalledWith('tomls', expect.any(Function));
  });

  describe('with GH_DOMAIN_VERIFICATION=false', () => {
    it('logs once that no toml is read, and starts nothing', async () => {
      jest.useFakeTimers();
      const t = setup({}, { domainVerification: false });
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(2 * TOML_DISCOVERY_INTERVAL_MS);

      expect(t.logger.log.mock.calls).toEqual([
        ['Toml checks are off (GH_DOMAIN_VERIFICATION=false): no toml is read'],
      ]);
      expect(t.discovery.discover).not.toHaveBeenCalled();
      expect(t.checker.pass).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await t.worker.stop();
      expect(t.checker.stop).not.toHaveBeenCalled();
    });

    it('still registers its shutdown, which is a stop that changes nothing', async () => {
      const t = setup({}, { domainVerification: false });
      await t.worker.onApplicationBootstrap();
      expect(t.signals.register).toHaveBeenCalledWith('tomls', expect.any(Function));
      await expect((t.signals.register.mock.calls[0][1] as () => Promise<void>)()).resolves.toBeUndefined();
    });
  });

  describe('with checks on', () => {
    it('says nothing of the checks being off', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.logger.log).not.toHaveBeenCalled();
      await t.worker.stop();
    });

    it('discovers before the first check pass', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.calls).toEqual(['discover', 'pass']);
      await t.worker.stop();
    });

    it('makes the first check pass only once the first discovery is over, however long it takes', async () => {
      jest.useFakeTimers();
      const t = setup();
      let finish!: () => void;
      t.discovery.read.mockImplementationOnce(
        () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
      );
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(10 * TOMLS_PASS_INTERVAL_MS);
      expect(t.calls).toEqual(['discover']);
      expect(t.checker.pass).not.toHaveBeenCalled();

      finish();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.calls).toEqual(['discover', 'pass']);
      await t.worker.stop();
    });

    it('discovers every 5 minutes after the previous discovery ended', async () => {
      jest.useFakeTimers();
      const t = setup({ start: { checks: false } });
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.discovery.discover).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(TOML_DISCOVERY_INTERVAL_MS - 1);
      expect(t.discovery.discover).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.discovery.discover).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(TOML_DISCOVERY_INTERVAL_MS);
      expect(t.discovery.discover).toHaveBeenCalledTimes(3);
      await t.worker.stop();
    });

    it('checks every 60 s after the previous pass ended, never two passes at a time', async () => {
      jest.useFakeTimers();
      const t = setup({ start: { discovery: false } });
      await t.discovery.discover(); // the test discovers, the worker does not
      let finish!: () => void;
      t.checker.pass.mockImplementationOnce(() => new Promise<number>((resolve) => (finish = () => resolve(3))));
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(200_000);
      expect(t.checker.pass).toHaveBeenCalledTimes(1);

      finish();
      await jest.advanceTimersByTimeAsync(TOMLS_PASS_INTERVAL_MS - 1);
      expect(t.checker.pass).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(t.checker.pass).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(2 * TOMLS_PASS_INTERVAL_MS);
      expect(t.checker.pass).toHaveBeenCalledTimes(4);
      await t.worker.stop();
    });

    it('starts the discovery loop alone, or the check loop alone, as options.start says', async () => {
      jest.useFakeTimers();
      const discoveryOnly = setup({ start: { checks: false } });
      await discoveryOnly.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(discoveryOnly.discovery.discover).toHaveBeenCalledTimes(1);
      expect(discoveryOnly.checker.pass).not.toHaveBeenCalled();
      await discoveryOnly.worker.stop();
      expect(discoveryOnly.checker.stop).not.toHaveBeenCalled();

      const checksOnly = setup({ start: { discovery: false } });
      await checksOnly.discovery.discover(); // the test's own
      await checksOnly.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(checksOnly.discovery.discover).toHaveBeenCalledTimes(1);
      expect(checksOnly.checker.pass).toHaveBeenCalledTimes(1);
      await checksOnly.worker.stop();
      expect(checksOnly.checker.stop).toHaveBeenCalledTimes(1);

      const neither = setup({ start: { discovery: false, checks: false } });
      await neither.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(2 * TOML_DISCOVERY_INTERVAL_MS);
      expect(neither.discovery.discover).not.toHaveBeenCalled();
      expect(neither.checker.pass).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('a discovery that fails', () => {
    it('is logged by the name of the error and its ClickHouse type, never its message, and tried again in 5 minutes', async () => {
      jest.useFakeTimers();
      const t = setup({ start: { checks: false } });
      const failure = Object.assign(new Error('SELECT account FROM account_domains: row {"principal":"SECRET"}'), {
        type: 'UNKNOWN_TABLE',
      });
      t.discovery.read.mockRejectedValueOnce(failure);
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);

      expect(t.logger.warn.mock.calls).toEqual([['Toml discovery: the pass failed: Error (UNKNOWN_TABLE)']]);
      await jest.advanceTimersByTimeAsync(TOML_DISCOVERY_INTERVAL_MS);
      expect(t.discovery.discover).toHaveBeenCalledTimes(2);
      await t.worker.stop();
    });

    it('lets no check pass run while no discovery has worked, so that the gauges do not claim an empty store', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.discovery.read.mockRejectedValueOnce(new Error('read failed')).mockRejectedValueOnce(new Error('read failed'));
      await t.worker.onApplicationBootstrap();

      // `ready` has settled after the first discovery, which failed: the check passes of the first ten minutes find
      // nothing discovered and make no pass
      await jest.advanceTimersByTimeAsync(0);
      expect(t.calls).toEqual(['discover']);
      await jest.advanceTimersByTimeAsync(TOML_DISCOVERY_INTERVAL_MS + 2 * TOMLS_PASS_INTERVAL_MS);
      expect(t.discovery.discover).toHaveBeenCalledTimes(2);
      expect(t.discovery.loaded).toBe(false);
      expect(t.checker.pass).not.toHaveBeenCalled();
      expect(t.logger.warn).toHaveBeenCalledTimes(2); // the two failed discoveries, and nothing for the skipped passes

      // the third discovery works: the next check pass runs
      await jest.advanceTimersByTimeAsync(TOML_DISCOVERY_INTERVAL_MS);
      expect(t.discovery.loaded).toBe(true);
      await jest.advanceTimersByTimeAsync(TOMLS_PASS_INTERVAL_MS);
      expect(t.checker.pass).toHaveBeenCalled();
      await t.worker.stop();
    });

    it('lets the check passes run after a discovery that worked and was followed by one that failed', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.checker.pass).toHaveBeenCalledTimes(1);

      t.discovery.read.mockRejectedValueOnce(new Error('read failed'));
      await jest.advanceTimersByTimeAsync(TOML_DISCOVERY_INTERVAL_MS);
      expect(t.logger.warn).toHaveBeenCalledTimes(1);
      expect(t.checker.pass.mock.calls.length).toBeGreaterThan(1);
      await t.worker.stop();
    });
  });

  describe('a check pass that fails', () => {
    it('is logged by the name of the error, never its message or what it carries, and the next pass is on time', async () => {
      jest.useFakeTimers();
      const t = setup({ start: { discovery: false } });
      await t.discovery.discover();
      const failure = Object.assign(new Error('INSERT into domain_tomls: {"desc":"treasury of Jane Doe"}'), {
        secret: 'SECRET',
      });
      t.checker.pass.mockRejectedValueOnce(failure);
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);

      expect(t.logger.warn.mock.calls).toEqual([['Toml checks: the pass failed: Error']]);
      await jest.advanceTimersByTimeAsync(TOMLS_PASS_INTERVAL_MS);
      expect(t.checker.pass).toHaveBeenCalledTimes(2);
      await t.worker.stop();
    });
  });

  describe('stop', () => {
    it('ends both loops: the timers are gone, the checker is stopped, and no pass is made after', async () => {
      jest.useFakeTimers();
      const t = setup();
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await t.worker.stop();

      expect(t.checker.stop).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(2 * TOML_DISCOVERY_INTERVAL_MS);
      expect(t.discovery.discover).toHaveBeenCalledTimes(1);
      expect(t.checker.pass).toHaveBeenCalledTimes(1);
    });

    it('is the same on module destroy and on the shutdown signal, and a second one changes nothing', async () => {
      const t = setup();
      await t.worker.onApplicationBootstrap();
      await t.worker.onModuleDestroy();
      expect(t.checker.stop).toHaveBeenCalledTimes(1);
      await (t.signals.register.mock.calls[0][1] as () => Promise<void>)();
      expect(t.checker.stop).toHaveBeenCalledTimes(1);
    });

    it('waits for the pass under way, then ends', async () => {
      jest.useFakeTimers();
      const t = setup();
      let finish!: () => void;
      t.checker.pass.mockImplementationOnce(() => new Promise<number>((resolve) => (finish = () => resolve(0))));
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      let stopped = false;
      const stopping = t.worker.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(TOMLS_STOP_WAIT_MS - 1);
      expect(stopped).toBe(false);
      finish();
      await stopping;
      expect(stopped).toBe(true);
    });

    it('waits at most 2 s for the loops', async () => {
      jest.useFakeTimers();
      const t = setup();
      t.checker.pass.mockImplementationOnce(() => new Promise<number>(() => undefined)); // a pass that never ends
      await t.worker.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      let stopped = false;
      const stopping = t.worker.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(TOMLS_STOP_WAIT_MS - 1);
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
      await jest.advanceTimersByTimeAsync(0);
      await t.worker.stop();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not fail when the checker fails to stop', async () => {
      const t = setup();
      t.checker.stop.mockRejectedValueOnce(new Error('stop failed'));
      await t.worker.onApplicationBootstrap();
      await expect(t.worker.stop()).resolves.toBeUndefined();
    });

    it('stops a worker that was never started', async () => {
      const t = setup();
      await expect(t.worker.stop()).resolves.toBeUndefined();
      expect(t.checker.stop).not.toHaveBeenCalled();
    });
  });
});

describe('errorTextOf', () => {
  it('is the name of an error, and the type of a ClickHouse error, never its message', () => {
    expect(errorTextOf(new TypeError('a secret'))).toBe('TypeError');
    expect(errorTextOf(Object.assign(new Error('Code: 60. a secret (UNKNOWN_TABLE)'), { type: 'UNKNOWN_TABLE' }))).toBe(
      'Error (UNKNOWN_TABLE)',
    );
  });

  it('says Error for a name that is not a plain name, and shows no type that is not a plain code', () => {
    expect(errorTextOf(Object.assign(new Error('x'), { name: 'has a space {"a":1}' }))).toBe('Error');
    expect(errorTextOf(Object.assign(new Error('x'), { type: 'not a code {"desc":"x"}' }))).toBe('Error');
    expect(errorTextOf(Object.assign(new Error('x'), { type: 7 }))).toBe('Error');
  });

  it('gives the type of what was thrown when it is not an error', () => {
    expect(errorTextOf('a secret text')).toBe('string');
    expect(errorTextOf(undefined)).toBe('undefined');
    expect(errorTextOf(null)).toBe('object');
  });
});
