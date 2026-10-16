import { ClickHouseService, StatsRecomputeAborted, Table } from '@gatehub/data-api-shared';
import {
  AGGREGATOR_INTERVAL_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AGGREGATOR_TICK_BUDGET_MS,
  AggregatorJob,
  AggregatorOptions,
  AggregatorService,
  MAX_SLICE_SECONDS,
  sliceRange,
} from './aggregator.service';

const HOUR = 3600;
const DAY = 86_400;
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 19) + 'Z';
const unix = (text: string): number => Date.parse(text) / 1000;

/** 2026-10-16T12:34:56Z */
const NOW = new Date('2026-10-16T12:34:56Z');
const NOW_SECONDS = NOW.getTime() / 1000;
/** 2026-10-16T10:00:00Z: the hour of now - 2h. */
const LOOKBACK = unix('2026-10-16T10:00:00Z');
/** 2026-10-16T13:00:00Z: the hour after now. */
const AFTER_NOW = unix('2026-10-16T13:00:00Z');

const QUIET = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

interface DirtyRow {
  from: number;
  to: number;
  /** Milliseconds. */
  created: number;
}

/**
 * A ClickHouse with the three things the service asks it: the newest stats hour with ledgers, the close time of the newest
 * ledger, and the `agg_dirty` queue (with the semantics of the real table: reads give the newest row of a key, oldest first;
 * the DELETE takes a key and `created_at <= created`; the INSERT adds a row).
 */
class FakeClickHouse {
  watermark?: number;
  latestClose?: number;
  dirty: DirtyRow[] = [];
  readonly sql: string[] = [];

  query = jest.fn(async (sql: string, params: Record<string, unknown> = {}): Promise<unknown[]> => {
    this.sql.push(sql);
    if (sql.includes(`FROM ${Table.StatsHourly}`)) return [{ hour: this.watermark ?? null }];
    if (sql.includes(`FROM ${Table.Ledgers}`))
      return this.latestClose === undefined ? [] : [{ closed: this.latestClose }];
    if (sql.includes(`FROM ${Table.AggDirty}`)) {
      const newest = new Map<string, DirtyRow>();
      for (const row of this.dirty) {
        const key = `${row.from}-${row.to}`;
        const seen = newest.get(key);
        if (!seen || row.created > seen.created) newest.set(key, row);
      }
      return [...newest.values()]
        .sort((a, b) => a.created - b.created || a.from - b.from || a.to - b.to)
        .slice(0, Number(params.limit))
        .map((r) => ({ from_hour: r.from, to_hour: r.to, created_ms: r.created }));
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  async queryOne(sql: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return (await this.query(sql, params))[0];
  }

  command = jest.fn(async (sql: string, params: Record<string, unknown> = {}, _options?: unknown): Promise<void> => {
    this.sql.push(sql);
    if (sql.startsWith(`DELETE FROM ${Table.AggDirty}`)) {
      this.dirty = this.dirty.filter(
        (r) => !(r.from === params.from && r.to === params.to && r.created <= Number(params.created)),
      );
    } else if (sql.startsWith(`INSERT INTO ${Table.AggDirty}`)) {
      this.dirty.push({ from: Number(params.from), to: Number(params.to), created: Number(params.created) });
    } else {
      throw new Error(`unexpected command: ${sql}`);
    }
  });

  asService(): ClickHouseService {
    return this as unknown as ClickHouseService;
  }
}

interface Recomputed {
  from: number;
  to: number;
  signal?: AbortSignal;
}

describe('sliceRange', () => {
  it('cuts a range into slices of at most MAX_SLICE_SECONDS from its start', () => {
    expect(MAX_SLICE_SECONDS).toBe(DAY);
    expect(sliceRange(0, DAY)).toEqual([[0, DAY]]);
    expect(sliceRange(0, DAY + HOUR)).toEqual([
      [0, DAY],
      [DAY, DAY + HOUR],
    ]);
    expect(sliceRange(3 * HOUR, 3 * HOUR + 2 * DAY + 5 * HOUR)).toEqual([
      [3 * HOUR, 3 * HOUR + DAY],
      [3 * HOUR + DAY, 3 * HOUR + 2 * DAY],
      [3 * HOUR + 2 * DAY, 3 * HOUR + 2 * DAY + 5 * HOUR],
    ]);
  });

  it('gives nothing for an empty or reversed range', () => {
    expect(sliceRange(DAY, DAY)).toEqual([]);
    expect(sliceRange(2 * DAY, DAY)).toEqual([]);
  });
});

describe('AggregatorService', () => {
  let ch: FakeClickHouse;
  let recomputed: Recomputed[];
  let recompute: jest.Mock;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
  };
  let shutdown: { register: jest.Mock };
  const created: AggregatorService[] = [];

  function service(options: AggregatorOptions = {}, withMetrics = true): AggregatorService {
    const svc = new AggregatorService(ch.asService(), withMetrics ? (metrics as never) : undefined, shutdown as never, {
      logger,
      recompute,
      ...options,
    });
    created.push(svc);
    return svc;
  }

  const ranges = (): [string, string][] => recomputed.map((r) => [iso(r.from), iso(r.to)]);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    recomputed = [];
    recompute = jest.fn(async (_ch: unknown, from: Date, to: Date, options?: { signal?: AbortSignal }) => {
      recomputed.push({ from: from.getTime() / 1000, to: to.getTime() / 1000, signal: options?.signal });
      return 1;
    });
    logger = QUIET();
    metrics = { aggregatorRunsTotal: { inc: jest.fn() }, aggregatorErrorsTotal: { inc: jest.fn() } };
    shutdown = { register: jest.fn() };
  });

  afterEach(async () => {
    // a service whose database never answered is abandoned after the cap, which is fake time
    const stops = created.splice(0).map((svc) => svc.stop());
    await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS);
    await Promise.all(stops);
    jest.useRealTimers();
  });

  describe('the live window (stats_live)', () => {
    it('recomputes the last two hours up to the end of the current hour', async () => {
      ch.watermark = unix('2026-10-16T12:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      await service().tick();
      expect(ranges()).toEqual([['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']]);
      expect(recompute.mock.calls[0][0]).toBe(ch);
      expect(recompute.mock.calls[0][1]).toBeInstanceOf(Date);
    });

    it('takes now from the argument of tick', async () => {
      ch.latestClose = unix('2026-01-01T00:00:00Z');
      await service().tick(new Date('2026-01-01T05:30:00Z'));
      expect(ranges()).toEqual([['2026-01-01T03:00:00Z', '2026-01-01T06:00:00Z']]);
    });

    it('starts at now - 2h when no hour has ledgers yet', async () => {
      await service().tick();
      expect(ranges()).toEqual([['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']]);
    });

    it('ends one hour after the newest ledger when it closed after now', async () => {
      ch.watermark = unix('2026-10-16T12:00:00Z');
      ch.latestClose = unix('2026-10-16T14:20:00Z');
      await service().tick();
      expect(ranges()).toEqual([['2026-10-16T10:00:00Z', '2026-10-16T15:00:00Z']]);
    });

    it('catches up from the watermark hour after an outage, in slices of at most a day, ending with the last hours', async () => {
      ch.watermark = unix('2026-10-13T08:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      await service().tick();
      expect(ranges()).toEqual([
        ['2026-10-13T08:00:00Z', '2026-10-14T08:00:00Z'],
        ['2026-10-14T08:00:00Z', '2026-10-15T08:00:00Z'],
        ['2026-10-15T08:00:00Z', '2026-10-16T08:00:00Z'],
        ['2026-10-16T08:00:00Z', '2026-10-16T10:00:00Z'],
        ['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z'],
      ]);
      for (const r of recomputed) expect(r.to - r.from).toBeLessThanOrEqual(DAY);
    });

    it('covers every hour from the watermark to the end of the window, with no gap and no overlap', async () => {
      ch.watermark = unix('2026-09-01T17:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      await service().tick();
      expect(recomputed[0].from).toBe(unix('2026-09-01T17:00:00Z'));
      for (let i = 1; i < recomputed.length; i++) expect(recomputed[i].from).toBe(recomputed[i - 1].to);
      expect(recomputed[recomputed.length - 1].to).toBe(AFTER_NOW);
    });

    it('does not walk the empty stretch between an old newest ledger and the last two hours', async () => {
      // the chain stopped on 2026-10-01: its last hour is finished, then only the last two hours are read
      ch.watermark = unix('2026-10-01T09:00:00Z');
      ch.latestClose = unix('2026-10-01T09:59:58Z');
      await service().tick();
      expect(ranges()).toEqual([
        ['2026-10-01T09:00:00Z', '2026-10-01T10:00:00Z'],
        ['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z'],
      ]);
    });

    it('starts the next tick from the same watermark when the slice before it failed', async () => {
      ch.watermark = unix('2026-10-14T08:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      recompute.mockRejectedValueOnce(new Error('memory limit'));
      const svc = service();
      await svc.tick();
      // the first slice failed: nothing after it was tried (a later slice would move the watermark past it)
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('stats_live'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'stats_live' });

      recomputed.length = 0;
      await svc.tick();
      expect(recomputed[0].from).toBe(unix('2026-10-14T08:00:00Z'));
      expect(recomputed[recomputed.length - 1].to).toBe(AFTER_NOW);
    });

    it('stops between slices when the tick budget is spent, and goes on from the watermark next tick', async () => {
      ch.watermark = unix('2026-10-10T08:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      recompute.mockImplementation(async (_ch: unknown, from: Date, to: Date) => {
        recomputed.push({ from: from.getTime() / 1000, to: to.getTime() / 1000 });
        jest.setSystemTime(Date.now() + 12_000); // every slice takes 12 s
        return 1;
      });
      await service().tick();
      // 12 s, 24 s, and the third slice starts at 24 s < 30 s; the fourth would start at 36 s
      expect(recomputed).toHaveLength(3);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
      expect(AGGREGATOR_TICK_BUDGET_MS).toBe(30_000);
    });
  });

  describe('agg_dirty (stats_dirty)', () => {
    const live = (): void => {
      ch.watermark = unix('2026-10-16T12:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
    };

    it('recomputes a row in slices of at most a day and then deletes it, guarded by the created_at it read', async () => {
      live();
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-03T06:00:00Z'), created: 1_750_000_000_123 }];
      await service().tick();

      expect(ranges().slice(1)).toEqual([
        ['2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z'],
        ['2026-05-02T00:00:00Z', '2026-05-03T00:00:00Z'],
        ['2026-05-03T00:00:00Z', '2026-05-03T06:00:00Z'],
      ]);
      expect(ch.dirty).toEqual([]);
      const del = ch.command.mock.calls.find(([sql]) => String(sql).startsWith(`DELETE FROM ${Table.AggDirty}`));
      expect(del?.[0]).toMatch(/from_hour = toDateTime\(\{from:UInt32\}, 'UTC'\)/);
      expect(del?.[0]).toMatch(/to_hour = toDateTime\(\{to:UInt32\}, 'UTC'\)/);
      expect(del?.[0]).toMatch(/toUnixTimestamp64Milli\(created_at\) <= \{created:Int64\}/);
      expect(del?.[1]).toEqual({
        from: unix('2026-05-01T00:00:00Z'),
        to: unix('2026-05-03T06:00:00Z'),
        created: 1_750_000_000_123,
      });
      // the delete is applied before the call returns, on every server
      expect(del?.[2]).toEqual({ settings: { lightweight_deletes_sync: '2' } });
    });

    it('processes the oldest row first', async () => {
      live();
      ch.dirty = [
        { from: unix('2026-06-01T00:00:00Z'), to: unix('2026-06-01T05:00:00Z'), created: 3000 },
        { from: unix('2026-04-01T00:00:00Z'), to: unix('2026-04-01T05:00:00Z'), created: 1000 },
        { from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T05:00:00Z'), created: 2000 },
      ];
      await service().tick();
      expect(ranges().slice(1)).toEqual([
        ['2026-04-01T00:00:00Z', '2026-04-01T05:00:00Z'],
        ['2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z'],
        ['2026-06-01T00:00:00Z', '2026-06-01T05:00:00Z'],
      ]);
      expect(ch.dirty).toEqual([]);
    });

    it('does not finish a row of years in one tick: it narrows the row to the progress and continues next tick', async () => {
      live();
      const from = unix('2021-01-01T00:00:00Z');
      const to = unix('2026-01-01T00:00:00Z');
      ch.dirty = [{ from, to, created: 1_700_000_000_500 }];
      recompute.mockImplementation(async (_ch: unknown, f: Date, t: Date) => {
        recomputed.push({ from: f.getTime() / 1000, to: t.getTime() / 1000 });
        jest.setSystemTime(Date.now() + 10_000);
        return 1;
      });
      const svc = service();
      await svc.tick();

      // the live slice took 10 s, three dirty days fit in the rest of the 30 s... the budget is checked before each slice
      const dirtySlices = recomputed.slice(1);
      expect(dirtySlices.length).toBeGreaterThan(0);
      expect(dirtySlices.length).toBeLessThan(5);
      const done = from + dirtySlices.length * DAY;
      expect(dirtySlices[0].from).toBe(from);
      // the row was replaced by one that starts where the work stopped, with the created_at of the original
      expect(ch.dirty).toEqual([{ from: done, to, created: 1_700_000_000_500 }]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));

      recomputed.length = 0;
      jest.setSystemTime(NOW);
      await svc.tick();
      expect(recomputed[1].from).toBe(done);
      expect(ch.dirty).toEqual([{ from: done + (recomputed.length - 1) * DAY, to, created: 1_700_000_000_500 }]);
    });

    it('inserts the narrowed row before it deletes the old one', async () => {
      live();
      ch.dirty = [{ from: unix('2021-01-01T00:00:00Z'), to: unix('2026-01-01T00:00:00Z'), created: 42 }];
      recompute.mockImplementation(async () => {
        jest.setSystemTime(Date.now() + 20_000);
        return 1;
      });
      await service().tick();
      const kinds = ch.command.mock.calls.map(([sql]) => String(sql).split(' ')[0]);
      expect(kinds).toEqual(['INSERT', 'DELETE']);
      const insert = ch.command.mock.calls[0];
      expect(insert[0]).toMatch(/fromUnixTimestamp64Milli\(\{created:Int64\}\)/);
      expect(insert[1]).toMatchObject({ created: 42 });
    });

    it('does not delete a row that was marked again after it was read', async () => {
      live();
      const row = { from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T06:00:00Z'), created: 1000 };
      ch.dirty = [row];
      recompute.mockImplementation(async (_ch: unknown, f: Date, t: Date) => {
        recomputed.push({ from: f.getTime() / 1000, to: t.getTime() / 1000 });
        // while the row is being worked on, the ingest marks the same range again
        if (f.getTime() / 1000 === row.from) ch.dirty.push({ ...row, created: 5000 });
        return 1;
      });
      const svc = service();
      await svc.tick();
      expect(ch.dirty).toEqual([{ ...row, created: 5000 }]);

      // the next tick does the range again and, nothing having changed meanwhile, deletes it
      await svc.tick();
      expect(ch.dirty).toEqual([]);
    });

    it('logs and counts a failing slice, keeps the row, goes on with the other rows and retries it next tick', async () => {
      live();
      const bad = { from: unix('2026-04-01T00:00:00Z'), to: unix('2026-04-02T00:00:00Z'), created: 1000 };
      const good = { from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T05:00:00Z'), created: 2000 };
      ch.dirty = [bad, good];
      let failing = true;
      recompute.mockImplementation(async (_ch: unknown, f: Date, t: Date) => {
        if (failing && f.getTime() / 1000 === bad.from) throw new Error('code: 241, DB::Exception: memory limit');
        recomputed.push({ from: f.getTime() / 1000, to: t.getTime() / 1000 });
        return 1;
      });
      const svc = service();
      await svc.tick();

      expect(ch.dirty).toEqual([bad]);
      expect(ranges()).toContainEqual(['2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z']);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('stats_dirty'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'stats_dirty' });

      failing = false;
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
    });

    it('keeps the progress of a row whose later slice fails: the row is narrowed to where it failed', async () => {
      live();
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-04T00:00:00Z'), created: 1000 }];
      recompute.mockImplementation(async (_ch: unknown, f: Date, t: Date) => {
        if (f.getTime() / 1000 === unix('2026-05-03T00:00:00Z')) throw new Error('boom');
        recomputed.push({ from: f.getTime() / 1000, to: t.getTime() / 1000 });
        return 1;
      });
      await service().tick();
      expect(ch.dirty).toEqual([
        { from: unix('2026-05-03T00:00:00Z'), to: unix('2026-05-04T00:00:00Z'), created: 1000 },
      ]);
    });

    it('stops after three rows failed in a tick, so that an outage does not log a line per row', async () => {
      live();
      ch.dirty = Array.from({ length: 10 }, (_, i) => ({
        from: unix('2026-04-01T00:00:00Z') + i * DAY,
        to: unix('2026-04-01T05:00:00Z') + i * DAY,
        created: 1000 + i,
      }));
      recompute.mockImplementation(async (_ch: unknown, f: Date) => {
        if (f.getTime() / 1000 < unix('2026-05-01T00:00:00Z')) throw new Error('down');
        return 1;
      });
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(3);
      expect(ch.dirty).toHaveLength(10);
    });

    it('removes a row that holds no hour', async () => {
      live();
      ch.dirty = [{ from: unix('2026-05-01T05:00:00Z'), to: unix('2026-05-01T05:00:00Z'), created: 1000 }];
      await service().tick();
      expect(ch.dirty).toEqual([]);
      expect(recomputed).toHaveLength(1); // the live window only
    });

    it('reads the queue newest-row-per-key, oldest first, and without FINAL', async () => {
      live();
      await service().tick();
      const read = ch.sql.find((s) => s.includes(`FROM ${Table.AggDirty}`)) as string;
      expect(read).toMatch(/LIMIT 1 BY from_hour, to_hour/);
      expect(read).toMatch(/ORDER BY created_at ASC/);
      expect(read).not.toMatch(/\bFINAL\b/);
    });

    it('only the newest created_at of a key counts', async () => {
      live();
      const key = { from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T05:00:00Z') };
      ch.dirty = [
        { ...key, created: 1000 },
        { ...key, created: 9000 },
      ];
      await service().tick();
      expect(ch.dirty).toEqual([]);
      const del = ch.command.mock.calls.find(([sql]) => String(sql).startsWith('DELETE'));
      expect(del?.[1]).toMatchObject({ created: 9000 });
    });
  });

  describe('a tick', () => {
    it('does not overlap: a tick that finds the previous one running is skipped and logged', async () => {
      let release!: () => void;
      recompute.mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(1);
          }),
      );
      const svc = service();
      const first = svc.tick();
      await jest.advanceTimersByTimeAsync(0);
      const second = svc.tick();
      await jest.advanceTimersByTimeAsync(0);
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still running'));
      release();
      await Promise.all([first, second]);
      expect(recompute).toHaveBeenCalledTimes(1);
      // and once it is over the next tick runs again
      recompute.mockImplementation(async () => 1);
      await svc.tick();
      expect(recompute).toHaveBeenCalledTimes(2);
    });

    it('counts a run of every job, and an error of the job that failed', async () => {
      await service().tick();
      expect(metrics.aggregatorRunsTotal.inc.mock.calls).toEqual([[{ job: 'stats_live' }], [{ job: 'stats_dirty' }]]);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('a job that fails does not stop the jobs after it', async () => {
      recompute.mockRejectedValueOnce(new Error('live failed'));
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T05:00:00Z'), created: 1000 }];
      await service().tick();
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorRunsTotal.inc.mock.calls).toEqual([[{ job: 'stats_dirty' }]]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'stats_live' });
    });

    it('a failing database read is a failed job, not a crash', async () => {
      ch.query.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(service().tick()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    });

    it('runs the jobs it was given after its own, and isolates them', async () => {
      const order: string[] = [];
      const extra: AggregatorJob[] = [
        {
          name: 'volume_live',
          run: async () => {
            order.push('volume_live');
            throw new Error('rates unavailable');
          },
        },
        { name: 'volume_daily', run: async () => void order.push('volume_daily') },
      ];
      await service({ extraJobs: extra }).tick();
      expect(order).toEqual(['volume_live', 'volume_daily']);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'volume_live' });
      expect(metrics.aggregatorRunsTotal.inc).toHaveBeenCalledWith({ job: 'volume_daily' });
    });

    it('hands every job the time of the tick, the deadline of its budget and the shutdown signal', async () => {
      let seen: { now: Date; deadline: number; signal: AbortSignal } | undefined;
      await service({ extraJobs: [{ name: 'probe', run: async (t) => void (seen = t) }] }).tick();
      expect(seen?.now).toEqual(NOW);
      expect(seen?.deadline).toBe(NOW.getTime() + AGGREGATOR_TICK_BUDGET_MS);
      expect(seen?.signal.aborted).toBe(false);
    });

    it('works without metrics', async () => {
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T05:00:00Z'), created: 1 }];
      recompute.mockRejectedValueOnce(new Error('x'));
      await expect(service({}, false).tick()).resolves.toBeUndefined();
      expect(ch.dirty).toEqual([]);
    });
  });

  describe('the timer', () => {
    it('ticks at once on bootstrap and then every 60 s, and registers a shutdown cleanup', async () => {
      const svc = service();
      svc.onApplicationBootstrap();
      expect(shutdown.register).toHaveBeenCalledWith('aggregator', expect.any(Function));
      await jest.advanceTimersByTimeAsync(0);
      expect(recompute).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(AGGREGATOR_INTERVAL_MS);
      expect(recompute).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(AGGREGATOR_INTERVAL_MS * 3);
      expect(recompute).toHaveBeenCalledTimes(5);
      expect(AGGREGATOR_INTERVAL_MS).toBe(60_000);
    });

    it('keeps ticking after a tick failed', async () => {
      recompute.mockRejectedValueOnce(new Error('first tick fails'));
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(AGGREGATOR_INTERVAL_MS * 2);
      expect(recompute).toHaveBeenCalledTimes(3);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
    });

    it('uses the interval it is given', async () => {
      const svc = service({ intervalMs: 1000 });
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(3000);
      expect(recompute).toHaveBeenCalledTimes(4);
    });

    it('starts once however often the bootstrap hook is called', async () => {
      const svc = service();
      svc.onApplicationBootstrap();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(recompute).toHaveBeenCalledTimes(1);
      expect(shutdown.register).toHaveBeenCalledTimes(1);
    });
  });

  describe('shutdown', () => {
    it('starts no tick after the stop, and clears the timer', async () => {
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await svc.stop();
      recompute.mockClear();
      await jest.advanceTimersByTimeAsync(AGGREGATOR_INTERVAL_MS * 5);
      await svc.tick();
      expect(recompute).not.toHaveBeenCalled();
    });

    it('does not start again after a stop', async () => {
      const svc = service();
      await svc.stop();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(AGGREGATOR_INTERVAL_MS * 2);
      expect(recompute).not.toHaveBeenCalled();
    });

    it('aborts the signal of the slice in flight, so that its write is dropped, and quietly', async () => {
      let signalOfSlice: AbortSignal | undefined;
      let release!: () => void;
      recompute.mockImplementation(
        (_ch: unknown, _f: Date, _t: Date, options?: { signal?: AbortSignal }) =>
          new Promise<number>((resolve) => {
            signalOfSlice = options?.signal;
            release = () => resolve(1);
          }),
      );
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(signalOfSlice?.aborted).toBe(false);

      const stopping = svc.stop();
      expect(signalOfSlice?.aborted).toBe(true);
      release();
      await stopping;
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('a slice that was aborted at shutdown is neither an error nor counted', async () => {
      const svc = service();
      recompute.mockImplementation(async () => {
        void svc.stop(); // the shutdown begins while the slice is being read ...
        throw new StatsRecomputeAborted(); // ... and the job refuses to write
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      const svc = service();
      recompute.mockImplementation(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'stats_live' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });

    it('passes the shutdown signal to every slice, of the live window and of agg_dirty alike', async () => {
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-03T00:00:00Z'), created: 1000 }];
      const svc = service();
      await svc.tick();
      expect(recomputed).toHaveLength(3);
      const signals = recomputed.map((r) => r.signal);
      for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
      expect(new Set(signals).size).toBe(1);
      expect(signals[0]?.aborted).toBe(false);
      await svc.stop();
      expect(signals.every((signal) => signal?.aborted)).toBe(true);
    });

    it('waits for the tick in flight for at most the cap and then abandons it with a warning', async () => {
      recompute.mockImplementation(() => new Promise<number>(() => undefined)); // a database that never answers
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);

      let stopped = false;
      const stopping = svc.stop().then(() => (stopped = true));
      await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS - 1);
      expect(stopped).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await stopping;
      expect(stopped).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Abandoning'));
      expect(AGGREGATOR_SHUTDOWN_WAIT_MS).toBeLessThanOrEqual(3000);
    });

    it('does not wait when nothing is running', async () => {
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      await svc.stop();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('writes nothing to agg_dirty once the shutdown has begun: no narrowing, no delete', async () => {
      ch.watermark = unix('2026-10-16T12:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-04T00:00:00Z'), created: 1000 }];
      const svc = service();
      recompute.mockImplementation(async (_ch: unknown, f: Date, t: Date) => {
        recomputed.push({ from: f.getTime() / 1000, to: t.getTime() / 1000 });
        if (f.getTime() / 1000 === unix('2026-05-02T00:00:00Z')) void svc.stop(); // the shutdown begins mid-row
        return 1;
      });
      await svc.tick();
      expect(ch.command).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
      // and no slice was started after the stop
      expect(recomputed.map((r) => r.from)).not.toContain(unix('2026-05-03T00:00:00Z'));
    });

    it('writes nothing to agg_dirty when the shutdown begins during the last slice of a range either', async () => {
      ch.watermark = unix('2026-10-16T12:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-02T00:00:00Z'), created: 1000 }];
      const svc = service();
      recompute.mockImplementation(async (_ch: unknown, f: Date) => {
        if (f.getTime() / 1000 === unix('2026-05-01T00:00:00Z')) void svc.stop();
        return 1;
      });
      await svc.tick();
      // every slice was done, but the row stays: it is deleted by the next run, which redoes the (idempotent) slices
      expect(ch.command).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
    });

    it('writes nothing to agg_dirty when the shutdown begins during a slice that then fails', async () => {
      ch.watermark = unix('2026-10-16T12:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-04T00:00:00Z'), created: 1000 }];
      const svc = service();
      recompute.mockImplementation(async (_ch: unknown, f: Date) => {
        if (f.getTime() / 1000 === unix('2026-05-02T00:00:00Z')) {
          void svc.stop();
          throw new Error('connection reset');
        }
        return 1;
      });
      await svc.tick();
      expect(ch.command).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([
        { from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-04T00:00:00Z'), created: 1000 },
      ]);
    });

    it('is idempotent, and the module destroy hook is the stop', async () => {
      const svc = service();
      svc.onApplicationBootstrap();
      const a = svc.stop();
      const b = svc.stop();
      expect(b).toBe(a);
      await svc.onModuleDestroy();
    });
  });
});
