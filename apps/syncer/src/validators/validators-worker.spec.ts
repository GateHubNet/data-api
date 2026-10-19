import { ShutdownSignals } from '@gatehub/data-api-shared';
import { UnlFetcher } from './unl-fetcher';
import { ValidatorsWorker } from './validators-worker';
import { ValidatorsWorkerOptions } from './validators.options';

function setup(options: ValidatorsWorkerOptions = {}) {
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
  const signals = { register: jest.fn() };
  const worker = new ValidatorsWorker(unl as unknown as UnlFetcher, signals as unknown as ShutdownSignals, options);
  return { worker, unl, signals, calls };
}

describe('ValidatorsWorker', () => {
  afterEach(() => {
    jest.useRealTimers();
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
});
