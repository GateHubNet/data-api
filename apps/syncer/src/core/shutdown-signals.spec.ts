import { EventEmitter } from 'node:events';
import { SHUTDOWN_TIMEOUT_MS, ShutdownSignals } from './shutdown-signals';

/** Stands in for `process`: signals are emitted by the test, `exit` is recorded. */
function fakeProcess() {
  return Object.assign(new EventEmitter(), { exit: jest.fn() });
}

function quietLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('ShutdownSignals', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('listens to SIGTERM and SIGINT once each', () => {
    const proc = fakeProcess();
    new ShutdownSignals({ process: proc, logger: quietLogger() });
    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('SIGINT')).toBe(1);
  });

  it.each(['SIGTERM', 'SIGINT'])(
    'on %s runs the registered cleanups in reverse order, then exits 0',
    async (signal) => {
      const proc = fakeProcess();
      const signals = new ShutdownSignals({ process: proc, logger: quietLogger() });
      const order: string[] = [];
      signals.register('node-client', async () => void order.push('node-client'));
      signals.register('ingest', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('ingest');
      });
      signals.register('last', async () => void order.push('last'));

      proc.emit(signal, signal);
      expect(proc.exit).not.toHaveBeenCalled();
      await signals.shutdown(signal as NodeJS.Signals);

      expect(order).toEqual(['last', 'ingest', 'node-client']);
      expect(proc.exit).toHaveBeenCalledTimes(1);
      expect(proc.exit).toHaveBeenCalledWith(0);
    },
  );

  it('keeps going when a cleanup fails, and logs the failure', async () => {
    const proc = fakeProcess();
    const logger = quietLogger();
    const signals = new ShutdownSignals({ process: proc, logger });
    const ran: string[] = [];
    signals.register('first', async () => void ran.push('first'));
    signals.register('broken', async () => {
      throw new Error('lease release failed');
    });

    proc.emit('SIGTERM', 'SIGTERM');
    await signals.shutdown('SIGTERM');

    expect(ran).toEqual(['first']);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"broken"'), expect.anything());
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('runs the cleanups only once when signals repeat', async () => {
    const proc = fakeProcess();
    const signals = new ShutdownSignals({ process: proc, logger: quietLogger() });
    const cleanup = jest.fn(async () => undefined);
    signals.register('ingest', cleanup);

    proc.emit('SIGTERM', 'SIGTERM');
    proc.emit('SIGINT', 'SIGINT');
    proc.emit('SIGTERM', 'SIGTERM');
    await signals.shutdown('SIGTERM');

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });

  it(`exits after ${SHUTDOWN_TIMEOUT_MS} ms even when a cleanup never finishes`, async () => {
    jest.useFakeTimers();
    const proc = fakeProcess();
    const logger = quietLogger();
    const signals = new ShutdownSignals({ process: proc, logger });
    const after = jest.fn(async () => undefined);
    signals.register('after', after);
    signals.register('hangs', () => new Promise<void>(() => undefined));

    proc.emit('SIGTERM', 'SIGTERM');
    await jest.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS - 1);
    expect(proc.exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);

    expect(proc.exit).toHaveBeenCalledWith(0);
    expect(after).not.toHaveBeenCalled(); // still waiting behind the one that hangs
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`${SHUTDOWN_TIMEOUT_MS}`));
  });

  it('stops listening when the app shuts down', () => {
    const proc = fakeProcess();
    const signals = new ShutdownSignals({ process: proc, logger: quietLogger() });
    signals.onApplicationShutdown();
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });
});
