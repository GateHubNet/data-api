import { ClickHouseService, FeeStatsRow, NodeClient, ShutdownSignals, Table } from '@gatehub/data-api-shared';
import { PrometheusService } from '../modules/prometheus/prometheus.service';
import {
  FEE_STATS_INTERVAL_MS,
  FEE_STATS_REQUEST_TIMEOUT_MS,
  FEE_STATS_SHUTDOWN_WAIT_MS,
  FeeStatsPoller,
  feeStatsRowFrom,
  roundPct,
} from './fee-stats-poller';

/** What rippled answers to `{command: 'fee'}`: every number is a string, the fees are in `drops`. */
const FEE_RESULT = {
  current_ledger_size: '46',
  current_queue_size: '13',
  drops: { base_fee: '10', median_fee: '5000', minimum_fee: '10', open_ledger_fee: '12' },
  expected_ledger_size: '24',
  ledger_current_index: 26575101,
  levels: { median_level: '128000', minimum_level: '256', open_ledger_level: '256', reference_level: '256' },
  max_queue_size: '480',
  status: 'success',
};

const NOW = new Date('2026-10-16T12:00:00.123Z');
const NOW_SECONDS = 1_792_152_000.123;

function fee(overrides: Record<string, unknown> = {}, drops: Record<string, unknown> = {}) {
  return { ...FEE_RESULT, ...overrides, drops: { ...FEE_RESULT.drops, ...drops } };
}

function setup(options: { intervalMs?: number } = {}) {
  const request = jest.fn(async (_req: Record<string, unknown>, _opts?: unknown): Promise<unknown> => fee());
  const insert = jest.fn(async (_table: Table | string, _rows: unknown[]): Promise<void> => undefined);
  const metrics = { feeStatsSamplesTotal: { inc: jest.fn() }, feeStatsErrorsTotal: { inc: jest.fn() } };
  const signals = { register: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const poller = new FeeStatsPoller(
    { request } as unknown as NodeClient,
    { insert } as unknown as ClickHouseService,
    metrics as unknown as PrometheusService,
    signals as unknown as ShutdownSignals,
    { logger, ...options },
  );
  return { poller, request, insert, metrics, signals, logger };
}

/** A promise a test settles by hand: a request that is still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FeeStatsPoller', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('sample()', () => {
    it('asks the node for the fee, as the reference does, without an api_version', async () => {
      const { poller, request } = setup();
      await poller.sample();
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toEqual({ command: 'fee' });
      // The node client applies the timeout to the connection AND to the answer, so a hung node costs up to twice as much:
      // 8 s, not the 30 s (and 3 retries) of the client's defaults. The poller does not retry; the next tick does.
      expect(request.mock.calls[0][1]).toEqual({ timeoutMs: FEE_STATS_REQUEST_TIMEOUT_MS, retries: 0 });
      expect(FEE_STATS_REQUEST_TIMEOUT_MS * 2).toBeLessThan(30_000);
      expect(FEE_STATS_REQUEST_TIMEOUT_MS).toBeLessThan(FEE_STATS_INTERVAL_MS);
    });

    it('computes pct_max_queue_size', async () => {
      const { poller } = setup();
      // 13 queued of a maximum of 20 x 24 = 480 ledger slots: 13 / 480 * 100 = 2.708333…
      expect((await poller.sample()).pct_max_queue_size).toBe(2.71);
    });

    it('writes a row per sample, with the drops of the node and a fractional-seconds ts', async () => {
      const { poller, insert } = setup();
      const row = await poller.sample();
      const expected: FeeStatsRow = {
        ts: NOW_SECONDS,
        current_ledger_size: 46,
        expected_ledger_size: 24,
        current_queue_size: 13,
        max_queue_size: 480,
        pct_max_queue_size: 2.71,
        median_fee: '5000',
        minimum_fee: '10',
        open_ledger_fee: '12',
      };
      expect(row).toEqual(expected);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledWith(Table.FeeStats, [expected]);

      await jest.advanceTimersByTimeAsync(1_234);
      const second = await poller.sample();
      expect(insert).toHaveBeenCalledTimes(2);
      expect(insert).toHaveBeenLastCalledWith(Table.FeeStats, [second]);
      expect(second.ts).toBeCloseTo(NOW_SECONDS + 1.234, 6);
    });

    it('stamps ts in unix SECONDS with the milliseconds as a fraction, never as a millisecond integer', async () => {
      const { poller } = setup();
      const { ts } = await poller.sample();
      // ClickHouse reads a number into a DateTime64(3) as seconds: ms integers would land 1000 x too far in the future
      expect(ts).toBe(Date.now() / 1000);
      expect(ts).toBeLessThan(1e10);
      expect(Number.isInteger(ts)).toBe(false);
      expect(Math.round((ts % 1) * 1000)).toBe(123);
    });

    it('stamps the time the sample was asked for, not the time the node answered', async () => {
      const { poller, request } = setup();
      const answer = deferred<unknown>();
      request.mockReturnValueOnce(answer.promise);
      const pending = poller.sample();
      await jest.advanceTimersByTimeAsync(2_000);
      answer.resolve(fee());
      expect((await pending).ts).toBe(NOW_SECONDS);
    });

    it('reads the time from the clock it is given', async () => {
      const request = jest.fn(async () => fee());
      const insert = jest.fn(async () => undefined);
      const poller = new FeeStatsPoller(
        { request } as unknown as NodeClient,
        { insert } as unknown as ClickHouseService,
        undefined,
        undefined,
        { now: () => 1_700_000_000_500 },
      );
      expect((await poller.sample()).ts).toBe(1_700_000_000.5);
    });

    it('keeps the fees in drops, exactly, as strings of digits', async () => {
      const { poller, request, insert } = setup();
      request.mockResolvedValueOnce(
        fee({}, { median_fee: '9007199254740993', minimum_fee: '10', open_ledger_fee: '123456789012' }),
      );
      const row = await poller.sample();
      expect(row.median_fee).toBe('9007199254740993'); // above 2^53: a number would round it
      expect(row.open_ledger_fee).toBe('123456789012');
      expect(insert).toHaveBeenCalledWith(Table.FeeStats, [row]);
    });

    it('takes max_queue_size from the node, and 20 x expected_ledger_size when the node does not say', async () => {
      const a = setup();
      a.request.mockResolvedValueOnce(fee({ max_queue_size: '2000' }));
      const row = await a.poller.sample();
      expect(row.max_queue_size).toBe(2000);
      // but the percentage is of 20 x expected_ledger_size, as the original had it (13 / 2000 would be 0.65)
      expect(row.pct_max_queue_size).toBe(2.71);

      const b = setup();
      b.request.mockResolvedValueOnce(fee({ max_queue_size: undefined }));
      expect((await b.poller.sample()).max_queue_size).toBe(480);
    });

    it('is 0 % for an empty queue and 100 % for a full one', async () => {
      const empty = setup();
      empty.request.mockResolvedValueOnce(fee({ current_queue_size: '0' }));
      expect((await empty.poller.sample()).pct_max_queue_size).toBe(0);

      const full = setup();
      full.request.mockResolvedValueOnce(fee({ current_queue_size: '480' }));
      expect((await full.poller.sample()).pct_max_queue_size).toBe(100);
    });

    it('rejects an answer that is not a fee answer, and writes nothing', async () => {
      for (const bad of [
        {},
        null,
        { ...FEE_RESULT, drops: undefined },
        fee({ current_ledger_size: 'many' }),
        fee({ expected_ledger_size: '-1' }),
        fee({}, { median_fee: '1.5' }),
        fee({}, { open_ledger_fee: undefined }),
      ]) {
        const { poller, request, insert } = setup();
        request.mockResolvedValueOnce(bad);
        await expect(poller.sample()).rejects.toThrow(/unexpected fee response/i);
        expect(insert).not.toHaveBeenCalled();
      }
    });

    it('rejects when the node does and when ClickHouse does, with the error unchanged', async () => {
      const failing = setup();
      failing.request.mockRejectedValueOnce(new Error('No node connection within 4000 ms'));
      await expect(failing.poller.sample()).rejects.toThrow('No node connection within 4000 ms');
      expect(failing.insert).not.toHaveBeenCalled();

      const refused = setup();
      refused.insert.mockRejectedValueOnce(new Error('ClickHouse is down'));
      await expect(refused.poller.sample()).rejects.toThrow('ClickHouse is down');
    });
  });

  describe('feeStatsRowFrom()', () => {
    it('does not mutate the node answer', () => {
      const result = fee();
      const before = JSON.parse(JSON.stringify(result));
      feeStatsRowFrom(result, NOW_SECONDS);
      expect(result).toEqual(before);
    });

    it('is 0 % when the node expects no ledger size at all (no division by zero)', () => {
      const row = feeStatsRowFrom(fee({ expected_ledger_size: '0', current_queue_size: '5' }), NOW_SECONDS);
      expect(row.pct_max_queue_size).toBe(0);
      expect(row.max_queue_size).toBe(480); // the node still says so
    });

    it('accepts numbers where the node sends strings (xahaud, older servers)', () => {
      const row = feeStatsRowFrom(
        { ...FEE_RESULT, current_ledger_size: 46, current_queue_size: 13, expected_ledger_size: 24 },
        NOW_SECONDS,
      );
      expect(row.pct_max_queue_size).toBe(2.71);
    });
  });

  describe('roundPct()', () => {
    it('rounds to two decimals like toFixed(2) of the reference', () => {
      expect(roundPct(2.708333333)).toBe(2.71);
      expect(roundPct(0.125)).toBe(0.13); // an exact tie goes up in toFixed
      expect(roundPct(1.005)).toBe(1); // 1.005 is a hair below in binary
      expect(roundPct(100)).toBe(100);
      expect(roundPct(0)).toBe(0);
      expect(roundPct(33.333333)).toBe(33.33);
    });
  });

  describe('the loop', () => {
    it('takes a sample when it starts and then one every 5000 ms', async () => {
      const { poller, request, insert, metrics } = setup();
      await poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(4_999);
      expect(request).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(10_000);
      expect(request).toHaveBeenCalledTimes(4);
      expect(insert).toHaveBeenCalledTimes(4);
      expect(metrics.feeStatsSamplesTotal.inc).toHaveBeenCalledTimes(4);
      expect(metrics.feeStatsErrorsTotal.inc).not.toHaveBeenCalled();

      // one row per sample, each with its own ts, five seconds apart
      const stamps = insert.mock.calls.map(([, rows]) => (rows as FeeStatsRow[])[0].ts);
      expect(stamps.map((t, i) => (i === 0 ? 0 : Math.round(t - stamps[i - 1])))).toEqual([0, 5, 5, 5]);
      await poller.onModuleDestroy();
    });

    it('does not wait for the first sample to boot (the first tick is not awaited)', async () => {
      const { poller, request } = setup();
      const answer = deferred<unknown>();
      request.mockReturnValueOnce(answer.promise);
      expect(poller.onApplicationBootstrap()).toBeUndefined(); // the boot is not held up by a slow node
      answer.resolve(fee());
      await poller.onModuleDestroy();
    });

    it('uses the interval it is given', async () => {
      const { poller, request } = setup({ intervalMs: 1_000 });
      await poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(request).toHaveBeenCalledTimes(4);
      await poller.onModuleDestroy();
    });

    it('skips a tick while the previous sample is still in flight (no overlap), and goes on after it', async () => {
      const { poller, request, insert, logger, metrics } = setup();
      const slow = deferred<unknown>();
      request.mockReturnValueOnce(slow.promise);
      await poller.onApplicationBootstrap();

      await jest.advanceTimersByTimeAsync(15_000); // three ticks while the first request waits
      expect(request).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(3);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/previous sample is still running/i));

      slow.resolve(fee());
      await jest.advanceTimersByTimeAsync(0);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(metrics.feeStatsSamplesTotal.inc).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(request).toHaveBeenCalledTimes(2);
      await poller.onModuleDestroy();
    });

    it('logs a failed sample, counts it, and goes on with the next tick', async () => {
      const { poller, request, insert, logger, metrics } = setup();
      request.mockRejectedValueOnce(new Error('No node connection within 4000 ms'));
      await poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);

      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('No node connection within 4000 ms'));
      expect(metrics.feeStatsErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.feeStatsSamplesTotal.inc).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5_000);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(metrics.feeStatsSamplesTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.feeStatsErrorsTotal.inc).toHaveBeenCalledTimes(1);
      await poller.onModuleDestroy();
    });

    it('does not count a sample ClickHouse refused as written', async () => {
      const { poller, insert, logger, metrics } = setup();
      insert.mockRejectedValueOnce(new Error('Code: 241. Memory limit exceeded'));
      await poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Memory limit exceeded'));
      expect(metrics.feeStatsSamplesTotal.inc).not.toHaveBeenCalled();
      expect(metrics.feeStatsErrorsTotal.inc).toHaveBeenCalledTimes(1);
      await poller.onModuleDestroy();
    });

    it('never crashes on a failure that is not an Error', async () => {
      const { poller, request, logger } = setup();
      request.mockRejectedValueOnce('boom');
      await poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('boom'));
      await poller.onModuleDestroy();
    });

    it('works without metrics, a shutdown hook or options (all optional)', async () => {
      const request = jest.fn(async () => fee());
      const insert = jest.fn(async () => undefined);
      const poller = new FeeStatsPoller(
        { request } as unknown as NodeClient,
        { insert } as unknown as ClickHouseService,
      );
      await poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(insert).toHaveBeenCalledTimes(2);
      await poller.onModuleDestroy();
    });
  });

  describe('shutdown', () => {
    it('registers its stop with the shutdown signals', async () => {
      const { poller, signals } = setup();
      await poller.onApplicationBootstrap();
      expect(signals.register).toHaveBeenCalledWith('fee-stats', expect.any(Function));
      await poller.onModuleDestroy();
    });

    it('stops sampling once stopped, from the module hook or from SIGTERM', async () => {
      for (const stop of ['hook', 'signal'] as const) {
        const { poller, request, signals } = setup();
        await poller.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(5_000);
        expect(request).toHaveBeenCalledTimes(2);

        if (stop === 'hook') {
          await poller.onModuleDestroy();
        } else {
          await (signals.register.mock.calls[0][1] as () => Promise<void>)();
        }
        await jest.advanceTimersByTimeAsync(60_000);
        expect([stop, request.mock.calls.length]).toEqual([stop, 2]);
        expect(jest.getTimerCount()).toBe(0);
      }
    });

    it('drops a sample whose node answer arrives after the stop: nothing is written, nothing is counted as an error', async () => {
      const { poller, request, insert, logger, metrics } = setup();
      const slow = deferred<unknown>();
      request.mockReturnValueOnce(slow.promise);
      await poller.onApplicationBootstrap();

      let stopped = false;
      const stopping = poller.onModuleDestroy().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(stopped).toBe(false); // it waits for the sample in flight, for a while

      slow.resolve(fee()); // the answer comes after the stop began
      await stopping;
      expect(insert).not.toHaveBeenCalled();
      expect(metrics.feeStatsSamplesTotal.inc).not.toHaveBeenCalled();
      expect(metrics.feeStatsErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/dropped the fee stats sample in flight/i));
    });

    it('does not count a node that fails while the app goes down as an error either', async () => {
      const { poller, request, logger, metrics } = setup();
      const slow = deferred<unknown>();
      request.mockReturnValueOnce(slow.promise);
      await poller.onApplicationBootstrap();
      const stopping = poller.onModuleDestroy();
      slow.reject(new Error('NodeClient is stopped'));
      await stopping;
      expect(metrics.feeStatsErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('NodeClient is stopped'));
    });

    it('lets an insert that is under way finish before the stop resolves', async () => {
      const { poller, insert, metrics } = setup();
      const writing = deferred<void>();
      insert.mockReturnValueOnce(writing.promise);
      await poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0); // the node answered, the insert is on its way
      expect(insert).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopping = poller.onModuleDestroy().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(1_000);
      expect(stopped).toBe(false);

      writing.resolve();
      await stopping;
      expect(metrics.feeStatsSamplesTotal.inc).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('abandons the sample in flight after FEE_STATS_SHUTDOWN_WAIT_MS, so the stop of the ingest runner keeps the rest of the 10 s', async () => {
      expect(FEE_STATS_SHUTDOWN_WAIT_MS).toBeLessThanOrEqual(2_000);
      const { poller, request, insert, logger } = setup();
      const hung = deferred<unknown>();
      request.mockReturnValueOnce(hung.promise);
      await poller.onApplicationBootstrap();

      let stopped = false;
      const stopping = poller.onModuleDestroy().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(FEE_STATS_SHUTDOWN_WAIT_MS - 1);
      expect(stopped).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/abandoning the fee stats sample in flight/i));
      expect(jest.getTimerCount()).toBe(0); // the wait left no timer behind

      // the node answers at last: the sample is dropped, not written
      hung.resolve(fee());
      await jest.advanceTimersByTimeAsync(0);
      expect(insert).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('the SIGTERM cleanup is capped the same way', async () => {
      const { poller, request, signals } = setup();
      request.mockReturnValueOnce(deferred<unknown>().promise); // never answers
      await poller.onApplicationBootstrap();
      let done = false;
      const cleanup = (signals.register.mock.calls[0][1] as () => Promise<void>)().then(() => (done = true));
      await jest.advanceTimersByTimeAsync(FEE_STATS_SHUTDOWN_WAIT_MS);
      await cleanup;
      expect(done).toBe(true);
    });

    it('is idempotent, and a stopped poller cannot be started again', async () => {
      const { poller, request } = setup();
      await poller.onApplicationBootstrap();
      await Promise.all([poller.onModuleDestroy(), poller.onModuleDestroy()]);
      await poller.onModuleDestroy();
      await poller.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(request).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('stops cleanly when it was never started', async () => {
      const { poller } = setup();
      await expect(poller.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
