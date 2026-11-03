import { PassLoop } from './pass-loop';

const logger = () => ({ warn: jest.fn() });

describe('PassLoop', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('calls the pass at once and again every wait after it ended, never two at a time', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    const pass = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const loop = new PassLoop('Loop', pass, async () => undefined, 1_000, logger());
    loop.start();

    await jest.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(1);
    // a pass that is not over is not called again, however long it takes
    await jest.advanceTimersByTimeAsync(10_000);
    expect(pass).toHaveBeenCalledTimes(1);

    finish();
    await jest.advanceTimersByTimeAsync(999);
    expect(pass).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(2);
    finish();
    await loop.stop();
  });

  it('logs the message of a pass that fails, and makes the next one on time', async () => {
    jest.useFakeTimers();
    const log = logger();
    const pass = jest.fn().mockRejectedValueOnce(new Error('the store is down')).mockResolvedValue(undefined);
    const loop = new PassLoop('Store', pass, async () => undefined, 1_000, log);
    loop.start();

    await jest.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Store: the pass failed: the store is down');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(pass).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it('logs what its `describe` makes of the error, and nothing else of it', async () => {
    jest.useFakeTimers();
    const log = logger();
    const err = Object.assign(new Error('INSERT of {"desc":"a secret"}'), { secret: 'SECRET' });
    const loop = new PassLoop(
      'Store',
      jest.fn().mockRejectedValue(err),
      async () => undefined,
      1_000,
      log,
      (e) => (e as Error).name,
    );
    loop.start();

    await jest.advanceTimersByTimeAsync(0);
    expect(log.warn.mock.calls).toEqual([['Store: the pass failed: Error']]);
    await loop.stop();
  });

  it('on stop ends the timer, runs `end`, waits for the pass under way and makes no more passes', async () => {
    jest.useFakeTimers();
    let finish!: () => void;
    const pass = jest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const end = jest.fn(async () => undefined);
    const loop = new PassLoop('Loop', pass, end, 1_000, logger());
    loop.start();
    await jest.advanceTimersByTimeAsync(0);

    let stopped = false;
    const stopping = loop.stop().then(() => (stopped = true));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(end).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it('does not log a pass that fails after the stop', async () => {
    jest.useFakeTimers();
    const log = logger();
    let fail!: (err: Error) => void;
    const pass = jest.fn(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    const loop = new PassLoop('Loop', pass, async () => undefined, 1_000, log);
    loop.start();
    await jest.advanceTimersByTimeAsync(0);
    const stopping = loop.stop();
    fail(new Error('aborted'));
    await stopping;
    expect(log.warn).not.toHaveBeenCalled();
  });
});
