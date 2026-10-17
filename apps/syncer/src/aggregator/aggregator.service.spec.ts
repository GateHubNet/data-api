import {
  AMM_DAILY_CONFIG_VERSION,
  AmmDailyRecomputeAborted,
  AmmPoolsRecomputeAborted,
  ClickHouseService,
  MarketsConfig,
  RatesService,
  StatsRecomputeAborted,
  Table,
  VOLUME_DAY_SETTLE_MS,
  VolumeRecomputeAborted,
} from '@gatehub/data-api-shared';
import {
  AGGREGATOR_AMM_DAILY_BUDGET_MS,
  AGGREGATOR_AMM_POOLS_BUDGET_MS,
  AGGREGATOR_DIRTY_BUDGET_MS,
  AGGREGATOR_INTERVAL_MS,
  AGGREGATOR_LIVE_BUDGET_MS,
  AGGREGATOR_SHUTDOWN_WAIT_MS,
  AGGREGATOR_TICK_BUDGET_MS,
  AGGREGATOR_VOLUME_BACKFILL_BUDGET_MS,
  AGGREGATOR_VOLUME_DAILY_BUDGET_MS,
  AGGREGATOR_VOLUME_LIVE_BUDGET_MS,
  AggregatorJob,
  AggregatorOptions,
  AggregatorService,
  AMM_DAILY_BACKFILL_MAX_RETRY_MS,
  AMM_DAILY_BACKFILL_RETRY_MS,
  AMM_DAILY_EVERY_TICKS,
  AMM_POOL_MAX_RETRY_MS,
  AMM_POOL_RETRY_MS,
  AMM_POOLS_BATCH,
  MAX_ISOLATED_POOLS_PER_BATCH,
  MAX_SLICE_SECONDS,
  sliceRange,
  VOLUME_BACKFILL_MAX_RETRY_MS,
  VOLUME_BACKFILL_RETRY_MS,
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
 * A ClickHouse with the things the service asks it: the hours of `stats_hourly` (newest first), the close times of the
 * ledgers (ascending, as their indexes are), and the `agg_dirty` queue (with the semantics of the real table: reads give the
 * newest row of a key, oldest first; the DELETE takes a key and `created_at <= created`; the INSERT adds a row).
 */
class FakeClickHouse {
  /** The newest hour of `stats_hourly` that has ledgers; shorthand for one row of `statsRows`. */
  watermark?: number;
  /** Rows of `stats_hourly`, newest hour first; replaces `watermark` when set. */
  statsRows?: Array<{ hour: number; ledger_count: number }>;
  /** The close times of the ledgers, ascending. */
  closes: number[] = [];
  dirty: DirtyRow[] = [];
  readonly sql: string[] = [];
  readonly params: Array<Record<string, unknown>> = [];

  /** The close time of the newest ledger; shorthand for `closes = [it]`. */
  set latestClose(closed: number | undefined) {
    this.closes = closed === undefined ? [] : [closed];
  }

  query = jest.fn(async (sql: string, params: Record<string, unknown> = {}): Promise<unknown[]> => {
    this.sql.push(sql);
    this.params.push(params);
    if (sql.includes(`FROM ${Table.StatsHourly}`)) {
      const rows = this.statsRows ?? (this.watermark === undefined ? [] : [{ hour: this.watermark, ledger_count: 1 }]);
      return rows
        .filter((r) => r.hour < Number(params.before))
        .sort((a, b) => b.hour - a.hour)
        .slice(0, Number(params.n))
        .map((r) => ({ hour_start: r.hour, ledger_count: r.ledger_count }));
    }
    if (sql.includes(`FROM ${Table.Ledgers}`)) {
      if (sql.includes('DESC')) {
        return this.closes.length === 0 ? [] : [{ closed: this.closes[this.closes.length - 1] }];
      }
      const found = sql.includes('close_time >=') ? this.closes.find((c) => c >= Number(params.from)) : this.closes[0];
      return found === undefined ? [] : [{ closed: found }];
    }
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
    aggregatorStatsLagSeconds: { set: jest.Mock };
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

  /**
   * A recompute that behaves like the job: it writes a row for every hour of the slice that has a ledger (so it returns how
   * many there are, and the watermark moves to the newest of them), and it takes `sliceMs` of the fake clock.
   */
  /** One close time a day at the same time of day, `days` + 1 of them, from `first`. */
  const dailyCloses = (first: string, days: number): number[] =>
    Array.from({ length: days + 1 }, (_, i) => unix(first) + i * DAY);

  function jobLike(sliceMs = 0): void {
    recompute.mockImplementation(async (_ch: unknown, from: Date, to: Date, options?: { signal?: AbortSignal }) => {
      const f = from.getTime() / 1000;
      const t = to.getTime() / 1000;
      recomputed.push({ from: f, to: t, signal: options?.signal });
      const hours = [...new Set(ch.closes.filter((c) => c >= f && c < t).map((c) => Math.floor(c / HOUR) * HOUR))];
      if (hours.length > 0) ch.watermark = Math.max(ch.watermark ?? 0, ...hours);
      if (sliceMs > 0) jest.setSystemTime(Date.now() + sliceMs);
      return hours.length;
    });
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    recomputed = [];
    recompute = jest.fn(async (_ch: unknown, from: Date, to: Date, options?: { signal?: AbortSignal }) => {
      recomputed.push({ from: from.getTime() / 1000, to: to.getTime() / 1000, signal: options?.signal });
      return 1;
    });
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
    };
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
      ch.watermark = unix('2026-01-01T03:00:00Z');
      ch.latestClose = unix('2026-01-01T04:00:00Z');
      await service().tick(new Date('2026-01-01T05:30:00Z'));
      expect(ranges()).toEqual([['2026-01-01T03:00:00Z', '2026-01-01T06:00:00Z']]);
    });

    it('starts at now - 2h when there is no ledger at all', async () => {
      await service().tick();
      expect(ranges()).toEqual([['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']]);
    });

    it('starts at the hour of the first ledger when no hour has stats yet (a fresh database, an aggregator enabled late)', async () => {
      ch.closes = [unix('2026-10-14T09:20:00Z'), unix('2026-10-15T00:00:00Z'), NOW_SECONDS - 3];
      await service().tick();
      expect(ranges()).toEqual([
        ['2026-10-14T09:00:00Z', '2026-10-15T09:00:00Z'],
        ['2026-10-15T09:00:00Z', '2026-10-16T09:00:00Z'],
        ['2026-10-16T09:00:00Z', '2026-10-16T10:00:00Z'],
        ['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z'],
      ]);
    });

    it('a first ledger inside the last two hours leaves the window as it was', async () => {
      ch.closes = [unix('2026-10-16T11:20:00Z'), NOW_SECONDS - 3];
      await service().tick();
      expect(ranges()).toEqual([['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']]);
    });

    it('reads the first ledger only when there is no watermark, and by the primary key', async () => {
      ch.closes = [unix('2026-10-14T09:20:00Z'), NOW_SECONDS - 3];
      await service().tick();
      const first = ch.sql.filter((q) => q.includes(`FROM ${Table.Ledgers}`) && /ORDER BY ledger_index ASC/.test(q));
      expect(first).toHaveLength(1);
      expect(first[0]).toMatch(/ORDER BY ledger_index ASC\s+LIMIT 1/);
      expect(first[0]).not.toMatch(/\bmin\(|FINAL/);

      ch.sql.length = 0;
      ch.watermark = unix('2026-10-16T12:00:00Z');
      await service().tick();
      expect(ch.sql.filter((q) => /ORDER BY ledger_index ASC/.test(q))).toEqual([]);
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
      // stats_live has 20 s of the tick: a slice at 0 s and one at 12 s; the third would start at 24 s
      expect(recomputed).toHaveLength(2);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
      expect(AGGREGATOR_TICK_BUDGET_MS).toBe(30_000);
      expect(AGGREGATOR_LIVE_BUDGET_MS).toBe(20_000);
    });

    it('gives stats_live at most 20 s of the tick, so that stats_dirty is always served', async () => {
      ch.watermark = unix('2026-10-10T08:00:00Z');
      ch.closes = [...dailyCloses('2026-10-10T08:30:00Z', 6), NOW_SECONDS - 3];
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-02T00:00:00Z'), created: 1000 }];
      jobLike(12_000);
      await service().tick();
      // the live window is far from done (a week of slices), but it stopped at 24 s and the dirty range got its slice
      const live = recomputed.filter((r) => r.from > unix('2026-06-01T00:00:00Z'));
      expect(live).toHaveLength(2);
      expect(ranges()).toContainEqual(['2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z']);
      expect(ch.dirty).toEqual([]);
    });

    it('the tail of the window runs only after the catch-up has finished, never before it', async () => {
      ch.watermark = unix('2026-10-10T08:00:00Z');
      ch.closes = [...dailyCloses('2026-10-10T08:30:00Z', 6), NOW_SECONDS - 3];
      jobLike(12_000);
      await service().tick();
      // 2 of the 7 catch-up slices fit in the budget: the tail [10:00, 13:00) was not touched, and the watermark, which
      // is where the next tick starts, is the hour of the last slice that had a ledger
      expect(recomputed.map((r) => r.to)).not.toContain(AFTER_NOW);
      expect(ch.watermark).toBe(unix('2026-10-11T08:00:00Z'));
    });

    describe('a gap in the ledgers', () => {
      const W = unix('2025-09-01T05:00:00Z');
      const gapped = (): void => {
        ch.watermark = W;
        ch.closes = [W + 600, unix('2026-10-10T08:20:00Z'), unix('2026-10-12T00:00:00Z'), NOW_SECONDS - 3];
      };

      it('is jumped over: a slice that writes nothing continues at the hour of the next ledger', async () => {
        gapped();
        jobLike(1000); // a gap of 400 days would take 400 s of slices of a second: far more than the budget
        await service().tick();
        expect(ranges()).toEqual([
          ['2025-09-01T05:00:00Z', '2025-09-02T05:00:00Z'], // the watermark hour: written
          ['2025-09-02T05:00:00Z', '2025-09-03T05:00:00Z'], // nothing: jump to the hour of the next ledger
          ['2026-10-10T08:00:00Z', '2026-10-11T08:00:00Z'],
          ['2026-10-11T08:00:00Z', '2026-10-12T08:00:00Z'],
          ['2026-10-12T08:00:00Z', '2026-10-13T08:00:00Z'], // nothing: the next ledger is after the catch-up
          ['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z'], // so the tail runs, in the same tick
        ]);
        const next = ch.sql.filter((q) => q.includes('close_time >='));
        expect(next).toHaveLength(2);
        expect(next[0]).toMatch(
          /WHERE close_time >= toDateTime\(\{from:UInt32\}, 'UTC'\)\s+ORDER BY ledger_index ASC\s+LIMIT 1/,
        );
        expect(next[0]).not.toMatch(/\bmin\(|FINAL/);
        expect(ch.params.filter((_, i) => ch.sql[i].includes('close_time >=')).map((p) => iso(Number(p.from)))).toEqual(
          ['2025-09-03T05:00:00Z', '2026-10-13T08:00:00Z'],
        );
      });

      it('does not keep a catch-up from the tail, or the tick from stats_dirty, however long it is', async () => {
        gapped();
        ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T05:00:00Z'), created: 1000 }];
        jobLike(1000);
        const svc = service();
        await svc.tick();
        expect(ranges()).toContainEqual(['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']);
        expect(ranges()).toContainEqual(['2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z']);
        expect(ch.dirty).toEqual([]);
        // 8 slices of the whole tick, not one per day of the gap
        expect(recomputed.length).toBeLessThanOrEqual(8);
      });

      it('is crossed over several ticks when the slices are slow: every tick ends further on than the one before', async () => {
        gapped();
        jobLike(8000); // the budget of stats_live (20 s) holds three slices
        const svc = service();
        const marks: number[] = [];
        let ticks = 0;
        do {
          recomputed.length = 0;
          await svc.tick();
          marks.push(ch.watermark as number);
        } while (!ranges().some(([, to]) => to === '2026-10-16T13:00:00Z') && ++ticks < 6);
        // the first tick got past the gap (the watermark is no longer the hour it started from) ...
        expect(marks[0]).toBeGreaterThan(unix('2026-10-01T00:00:00Z'));
        // ... every one after it moved on, and the one that finished the catch-up ran the tail
        expect(marks.length).toBeLessThanOrEqual(3);
        for (let i = 1; i < marks.length; i++) expect(marks[i]).toBeGreaterThan(marks[i - 1]);
        expect(ranges()[ranges().length - 1]).toEqual(['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']);
      });

      it('a failing look for the next ledger fails the job, which starts again from the same watermark', async () => {
        gapped();
        jobLike();
        const real = ch.query.getMockImplementation() as (
          sql: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown[]>;
        ch.query.mockImplementation(async (sql, params) => {
          if (sql.includes('close_time >=')) throw new Error('timeout');
          return real(sql, params);
        });
        const svc = service();
        await svc.tick();
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'stats_live' });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('timeout'));
        expect(ranges()).not.toContainEqual(['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']);
        ch.query.mockImplementation(real);
        recomputed.length = 0;
        await svc.tick();
        expect(ranges()).toContainEqual(['2026-10-16T10:00:00Z', '2026-10-16T13:00:00Z']);
      });
    });

    it('reports how far behind the sweep is, and 0 once it has caught up', async () => {
      ch.watermark = unix('2026-10-13T08:00:00Z');
      ch.closes = [...dailyCloses('2026-10-13T08:30:00Z', 3), NOW_SECONDS - 3];
      jobLike(12_000);
      const svc = service();
      await svc.tick();
      const lags = (): number[] => metrics.aggregatorStatsLagSeconds.set.mock.calls.map(([v]) => v as number);
      // 74 hours from the watermark to the start of the last two hours; two slices of a day were done in the tick
      expect(lags()[0]).toBe(74 * HOUR);
      expect(lags()[lags().length - 1]).toBe(26 * HOUR);

      let last = lags()[lags().length - 1];
      for (let i = 0; i < 4 && last > 0; i++) {
        await svc.tick();
        expect(lags()[lags().length - 1]).toBeLessThan(last); // never further behind than before
        last = lags()[lags().length - 1];
      }
      expect(last).toBe(0);
    });

    it('is 0 when the aggregator is where it should be', async () => {
      ch.watermark = unix('2026-10-16T12:00:00Z');
      ch.latestClose = NOW_SECONDS - 3;
      await service().tick();
      expect(metrics.aggregatorStatsLagSeconds.set.mock.calls.every(([v]) => v === 0)).toBe(true);
      expect(metrics.aggregatorStatsLagSeconds.set).toHaveBeenCalled();
    });

    describe('the watermark', () => {
      it('is looked for from the newest hour backwards in chunks of 100 hours, past the zero rows of vanished hours', async () => {
        const top = unix('2026-10-12T00:00:00Z');
        const zeros = Array.from({ length: 250 }, (_, i) => ({ hour: top - i * HOUR, ledger_count: 0 }));
        const found = { hour: top - 250 * HOUR, ledger_count: 4 };
        const older = Array.from({ length: 300 }, (_, i) => ({ hour: found.hour - (i + 1) * HOUR, ledger_count: 2 }));
        ch.statsRows = [...zeros, found, ...older];
        ch.closes = [NOW_SECONDS - 3];
        await service().tick();

        expect(ranges()[0][0]).toBe(iso(found.hour)); // the catch-up starts at the newest hour that has ledgers
        const reads = ch.sql
          .map((q, i) => [q, ch.params[i]] as const)
          .filter(([q]) => q.includes(`FROM ${Table.StatsHourly}`));
        expect(reads).toHaveLength(3);
        expect(reads.map(([, p]) => p.n)).toEqual([100, 100, 100]);
        // each chunk starts under the oldest hour of the one before
        expect(Number(reads[1][1].before)).toBe(top - 99 * HOUR);
        expect(Number(reads[2][1].before)).toBe(top - 199 * HOUR);
        expect(reads[0][0]).toMatch(/ORDER BY hour DESC, version DESC\s+LIMIT 1 BY hour\s+LIMIT \{n:UInt32\}/);
        expect(reads[0][0]).not.toMatch(/\bmax\(|maxOrNull|FINAL/);
      });

      it('is one read of 100 hours at most when the newest hour has ledgers, however much history there is', async () => {
        ch.statsRows = Array.from({ length: 50_000 }, (_, i) => ({
          hour: unix('2026-10-16T12:00:00Z') - i * HOUR,
          ledger_count: 1,
        }));
        ch.latestClose = NOW_SECONDS - 3;
        await service().tick();
        expect(ch.sql.filter((q) => q.includes(`FROM ${Table.StatsHourly}`))).toHaveLength(1);
      });

      it('is none when no chunk has an hour with ledgers: all zero rows, or no rows', async () => {
        ch.statsRows = Array.from({ length: 150 }, (_, i) => ({
          hour: unix('2026-10-12T00:00:00Z') - i * HOUR,
          ledger_count: 0,
        }));
        ch.closes = [unix('2026-10-14T09:20:00Z'), NOW_SECONDS - 3];
        await service().tick();
        // no watermark: the sweep starts at the first ledger
        expect(ranges()[0][0]).toBe('2026-10-14T09:00:00Z');
        expect(ch.sql.filter((q) => q.includes(`FROM ${Table.StatsHourly}`))).toHaveLength(2);
      });
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

    it('completes the narrowing it began: a shutdown between its INSERT and its DELETE does not leave the old row behind', async () => {
      live();
      ch.dirty = [{ from: unix('2021-01-01T00:00:00Z'), to: unix('2026-01-01T00:00:00Z'), created: 42 }];
      const svc = service();
      recompute.mockImplementation(async () => {
        jest.setSystemTime(Date.now() + 20_000);
        return 1;
      });
      const real = ch.command.getMockImplementation() as (
        sql: string,
        params?: Record<string, unknown>,
      ) => Promise<void>;
      ch.command.mockImplementation(async (sql, params) => {
        await real(sql, params);
        if (sql.startsWith('INSERT')) void svc.stop(); // the shutdown begins right after the narrowed row went in
      });
      await svc.tick();
      expect(ch.command.mock.calls.map(([sql]) => String(sql).split(' ')[0])).toEqual(['INSERT', 'DELETE']);
      expect(ch.dirty).toEqual([{ from: unix('2021-01-02T00:00:00Z'), to: unix('2026-01-01T00:00:00Z'), created: 42 }]);
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

// ---------------------------------------------------------------------------------------------------------------------
// The volume jobs of the aggregator: volume_live, volume_daily (today and yesterday), the dirty hook and volume_backfill.
// The volume functions of the shared package are replaced by fakes that record what they were asked and take fake time;
// what they write is tested against a real ClickHouse (packages/shared/test/volume-job.e2e-spec.ts and
// apps/syncer/test/aggregator.e2e-spec.ts).
// ---------------------------------------------------------------------------------------------------------------------

describe('AggregatorService volume jobs', () => {
  const MARKETS: MarketsConfig = { version: 4, tradeMarkets: [], paymentCurrencies: [] };
  const RATES = { nativeCurrency: 'XRP' } as RatesService;
  const NOW_MS = NOW.getTime();
  /** The first day that is closed at NOW: the day before yesterday (2026-10-14). */
  const NEWEST_CLOSED = '2026-10-14';

  let ch: FakeClickHouse;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
    aggregatorStatsLagSeconds: { set: jest.Mock };
  };
  const created: AggregatorService[] = [];

  /** What happened, in order: `live <metric> <period>`, `daily <metric> <day>`, `stats <from>`. */
  let events: string[];
  interface LiveCall {
    metric: string;
    period: string;
    now: Date;
    signal?: AbortSignal;
    at: number;
  }
  let liveCalls: LiveCall[];
  /** `<metric>:<day>:<config version>` of every daily set the fake wrote. */
  let computed: Set<string>;
  /** How long (fake milliseconds) each kind of work takes. */
  let liveMs: number;
  /** How long a live set that fails takes to fail (a slow failure, such as a timeout). */
  let failMs: number;
  let closedDayMs: number;
  /** How long a daily set of today or of yesterday takes. */
  let currentDayMs: number;
  let statsMs: number;
  let recompute: jest.Mock;
  let liveSet: jest.Mock;
  let dailySet: jest.Mock;
  let daysDone: jest.Mock;
  let liveVersions: jest.Mock;
  let dailyVersions: jest.Mock;
  /** The sets the fakes wrote and when (a counter: the order of the writes), as `volume_live` and `volume_daily` would hold them. */
  let liveWrites: Map<string, number>;
  let dailyWrites: Map<string, number>;
  let writeSeq: number;
  /** A day (or `metric:day`) the daily fake fails on, while it is in the set. */
  let failing: Set<string>;

  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const mark = (from: string, to: string, createdMs = 1000) => ({
    from: unix(from),
    to: unix(to),
    created: createdMs,
  });
  const isClosed = (d: string): boolean => d < '2026-10-15';

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
    };
    events = [];
    liveCalls = [];
    computed = new Set();
    liveWrites = new Map();
    dailyWrites = new Map();
    writeSeq = 0;
    failing = new Set();
    liveMs = 0;
    failMs = 0;
    closedDayMs = 0;
    currentDayMs = 0;
    statsMs = 0;
    recompute = jest.fn(async (_ch: unknown, from: Date, to: Date) => {
      events.push(`stats ${iso(from.getTime() / 1000)}`);
      if (statsMs > 0) jest.setSystemTime(Date.now() + statsMs);
      const f = from.getTime() / 1000;
      const t = to.getTime() / 1000;
      const hours = [...new Set(ch.closes.filter((c) => c >= f && c < t).map((c) => Math.floor(c / HOUR) * HOUR))];
      if (hours.length > 0) ch.watermark = Math.max(ch.watermark ?? 0, ...hours);
      return hours.length;
    });
    liveSet = jest.fn(
      async (
        _ch: unknown,
        _rates: unknown,
        _markets: unknown,
        metric: string,
        period: string,
        now: Date,
        options?: { signal?: AbortSignal },
      ) => {
        events.push(`live ${metric} ${period}`);
        liveCalls.push({ metric, period, now, signal: options?.signal, at: Date.now() });
        if (failing.has(`${metric}/${period}`)) {
          if (failMs > 0) jest.setSystemTime(Date.now() + failMs);
          throw new Error(`DB::Exception: ${metric} ${period}`);
        }
        if (liveMs > 0) jest.setSystemTime(Date.now() + liveMs);
        liveWrites.set(`${metric}/${period}`, ++writeSeq);
        return 0;
      },
    );
    dailySet = jest.fn(async (_ch: unknown, _rates: unknown, markets: MarketsConfig, metric: string, d: Date) => {
      const key = day(d);
      events.push(`daily ${metric} ${key}`);
      const ms = isClosed(key) ? closedDayMs : currentDayMs;
      if (ms > 0) jest.setSystemTime(Date.now() + ms);
      if (failing.has(key) || failing.has(`${metric}:${key}`)) throw new Error(`DB::Exception: ${metric} ${key}`);
      computed.add(`${metric}:${key}:${markets.version}`);
      dailyWrites.set(`${metric}/${key}`, ++writeSeq);
      return 0;
    });
    liveVersions = jest.fn(async () => new Map(liveWrites));
    dailyVersions = jest.fn(async (_ch: unknown, from: Date, to: Date) => {
      const [a, b] = [day(from), day(to)];
      return new Map(
        [...dailyWrites].filter(([k]) => k.slice(k.indexOf('/') + 1) >= a && k.slice(k.indexOf('/') + 1) <= b),
      );
    });
    daysDone = jest.fn(async (_ch: unknown, metric: string, from: Date, until: Date, version: number) => {
      const out = new Set<string>();
      for (let t = from.getTime(); t < until.getTime(); t += DAY * 1000) {
        const key = day(new Date(t));
        if (computed.has(`${metric}:${key}:${version}`)) out.add(key);
      }
      return out;
    });
  });

  afterEach(async () => {
    const stops = created.splice(0).map((svc) => svc.stop());
    await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS);
    await Promise.all(stops);
    jest.useRealTimers();
  });

  function service(options: AggregatorOptions = {}, markets: MarketsConfig = MARKETS): AggregatorService {
    const svc = new AggregatorService(ch.asService(), metrics as never, { register: jest.fn() } as never, {
      logger,
      recompute,
      volumes: { rates: RATES, markets },
      volumeFunctions: {
        computeLiveSet: liveSet,
        computeDailySet: dailySet,
        daysDone,
        liveVersions,
        dailyVersions,
      },
      ...options,
    });
    created.push(svc);
    return svc;
  }

  /** The stats are up to date: the live window is the last slice only. */
  const caughtUp = (): void => {
    ch.watermark = unix('2026-10-16T12:00:00Z');
    ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
  };
  const volumeEvents = (kind: 'live' | 'daily'): string[] => events.filter((e) => e.startsWith(kind));
  const dailyOf = (list: string[]): string[] => list.filter((e) => e.startsWith('daily')).map((e) => e.slice(6));

  describe('the jobs of a tick', () => {
    it('are, with volumes, volume_live, volume_daily, stats_live, stats_dirty, volume_backfill, in this order', async () => {
      caughtUp();
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T03:00:00Z'), created: 1000 }];
      await service().tick();
      expect(metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job)).toEqual([
        'volume_live',
        'volume_daily',
        'stats_live',
        'stats_dirty',
        'volume_backfill',
      ]);
      const firstStats = events.findIndex((e) => e.startsWith('stats'));
      const lastLive = events.lastIndexOf('live payment_volume day');
      const lastCurrent = events.lastIndexOf(`daily payment_volume 2026-10-15`);
      expect(lastLive).toBeLessThan(lastCurrent);
      expect(lastCurrent).toBeLessThan(firstStats);
      // the back-fill is the last thing the tick does
      expect(events[events.length - 1]).toBe('daily payment_volume 2026-10-10');
    });

    it('are without volumes the two jobs of the stats, and nothing is asked of the volume functions', async () => {
      caughtUp();
      await service({ volumes: undefined }).tick();
      expect(metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job)).toEqual([
        'stats_live',
        'stats_dirty',
      ]);
      expect(liveSet).not.toHaveBeenCalled();
      expect(dailySet).not.toHaveBeenCalled();
      expect(daysDone).not.toHaveBeenCalled();
    });
  });

  describe('volume_live', () => {
    it('refreshes the live sets of both metrics at every tick, with the time of the tick: trade hour..30day, payment hour, day', async () => {
      caughtUp();
      const svc = service();
      await svc.tick();
      expect(volumeEvents('live')).toEqual([
        'live trade_volume hour',
        'live trade_volume day',
        'live trade_volume 3day',
        'live trade_volume 7day',
        'live trade_volume 30day',
        'live payment_volume hour',
        'live payment_volume day',
      ]);
      expect(liveCalls.every((c) => c.now.getTime() === NOW_MS)).toBe(true);
      const call = liveSet.mock.calls[0];
      expect(call[0]).toBe(ch);
      expect(call[1]).toBe(RATES);
      expect(call[2]).toBe(MARKETS);

      liveCalls.length = 0;
      jest.setSystemTime(NOW_MS + 60_000);
      await svc.tick();
      expect(liveCalls).toHaveLength(7);
      expect(liveCalls.every((c) => c.now.getTime() === NOW_MS + 60_000)).toBe(true);
    });

    it('hands the shutdown signal to every set', async () => {
      caughtUp();
      await service().tick();
      expect(liveCalls.every((c) => c.signal instanceof AbortSignal && !c.signal.aborted)).toBe(true);
    });

    it('a set that fails is logged and counted, the other sets still run, and it is tried again next tick', async () => {
      caughtUp();
      liveSet.mockRejectedValueOnce(new Error('DB::Exception: rates unavailable'));
      const svc = service();
      await svc.tick();
      expect(volumeEvents('live')).toHaveLength(6);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('volume_live'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('trade_volume hour'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('rates unavailable'));
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'volume_live' });
      // the stats and the other volume jobs ran
      expect(recompute).toHaveBeenCalled();
      expect(dailySet).toHaveBeenCalled();

      liveCalls.length = 0;
      await svc.tick();
      expect(liveCalls).toHaveLength(7);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
    });

    it('gives up after three sets failed in a tick, so that an outage does not log a line per set', async () => {
      caughtUp();
      liveSet.mockRejectedValue(new Error('down'));
      await service().tick();
      expect(liveSet).toHaveBeenCalledTimes(3);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(3);
    });

    it('stops starting sets when its own budget is spent, says so, and does not take the tick from the stats', async () => {
      caughtUp();
      liveMs = 3000;
      await service().tick();
      // 3 s a set: sets start at 0 s and 3 s; at 6 s the 5 s budget is spent
      expect(liveCalls).toHaveLength(2);
      expect(AGGREGATOR_VOLUME_LIVE_BUDGET_MS).toBe(5000);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('volume_live'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('budget'));
      // the stats still ran in the same tick
      expect(recompute).toHaveBeenCalled();
    });

    it('starts nothing after the shutdown began, and a set cut short by it is neither an error nor counted', async () => {
      caughtUp();
      const svc = service();
      liveSet.mockImplementationOnce(async () => {
        void svc.stop();
        throw new VolumeRecomputeAborted();
      });
      await svc.tick();
      expect(liveSet).toHaveBeenCalledTimes(1);
      expect(dailySet).not.toHaveBeenCalled();
      expect(recompute).not.toHaveBeenCalled();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      caughtUp();
      const svc = service();
      liveSet.mockImplementationOnce(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'volume_live' });
    });
  });

  describe('volume_daily: today and yesterday, at every tick', () => {
    it('recomputes the daily sets of both metrics for today and for yesterday (UTC)', async () => {
      caughtUp();
      await service().tick();
      expect(dailyOf(volumeEvents('daily').slice(0, 4))).toEqual([
        'trade_volume 2026-10-16',
        'payment_volume 2026-10-16',
        'trade_volume 2026-10-15',
        'payment_volume 2026-10-15',
      ]);
      const [, , markets, , d, options] = dailySet.mock.calls[0];
      expect(markets).toBe(MARKETS);
      expect(d).toEqual(new Date('2026-10-16T00:00:00Z'));
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('moves on with the UTC midnight', async () => {
      caughtUp();
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-17T00:00:10Z')];
      ch.watermark = unix('2026-10-17T00:00:00Z');
      jest.setSystemTime(new Date('2026-10-17T00:00:30Z'));
      await service().tick();
      expect(dailyOf(volumeEvents('daily').slice(0, 4))).toEqual([
        'trade_volume 2026-10-17',
        'payment_volume 2026-10-17',
        'trade_volume 2026-10-16',
        'payment_volume 2026-10-16',
      ]);
    });

    it('a set that fails is logged and counted, the others go on, and it is tried again next tick', async () => {
      caughtUp();
      failing.add('payment_volume:2026-10-16');
      const svc = service();
      await svc.tick();
      expect(computed.has('trade_volume:2026-10-15:4')).toBe(true);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'volume_daily' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('payment_volume 2026-10-16'));
      failing.clear();
      await svc.tick();
      expect(computed.has('payment_volume:2026-10-16:4')).toBe(true);
    });

    it('has a budget of its own, so that the sets of today cannot take the tick from the stats', async () => {
      caughtUp();
      closedDayMs = 0;
      dailySet.mockImplementation(async (_c: unknown, _r: unknown, _m: unknown, metric: string, d: Date) => {
        events.push(`daily ${metric} ${day(d)}`);
        jest.setSystemTime(Date.now() + 3000);
        return 0;
      });
      await service().tick();
      // sets at 0 s and 3 s (the budget is 4 s), the third would start at 6 s
      expect(AGGREGATOR_VOLUME_DAILY_BUDGET_MS).toBe(4000);
      expect(volumeEvents('daily').slice(0, 2)).toHaveLength(2);
      expect(events.filter((e) => e.startsWith('daily') && !isClosed(e.slice(-10)))).toHaveLength(2);
      expect(recompute).toHaveBeenCalled();
    });
  });

  describe('volume_backfill: the closed days, once per config version, newest first', () => {
    it('computes the closed days from the first ledger up to the day before yesterday, newest first, both metrics', async () => {
      caughtUp();
      await service().tick();
      const closed = dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]));
      expect(closed).toEqual([
        'trade_volume 2026-10-14',
        'payment_volume 2026-10-14',
        'trade_volume 2026-10-13',
        'payment_volume 2026-10-13',
        'trade_volume 2026-10-12',
        'payment_volume 2026-10-12',
        'trade_volume 2026-10-11',
        'payment_volume 2026-10-11',
        'trade_volume 2026-10-10',
        'payment_volume 2026-10-10',
      ]);
      // asked which days of that window are done, for the config version of the markets
      expect(daysDone).toHaveBeenCalledWith(
        ch,
        'trade_volume',
        new Date('2026-10-10T00:00:00Z'),
        new Date('2026-10-15T00:00:00Z'),
        4,
      );
      expect(daysDone).toHaveBeenCalledWith(
        ch,
        'payment_volume',
        new Date('2026-10-10T00:00:00Z'),
        new Date('2026-10-15T00:00:00Z'),
        4,
      );
      expect(NEWEST_CLOSED).toBe('2026-10-14');
    });

    it('computes a closed day once: the next tick has nothing to do but today and yesterday', async () => {
      caughtUp();
      const svc = service();
      await svc.tick();
      dailySet.mockClear();
      await svc.tick();
      expect(dailySet).toHaveBeenCalledTimes(4);
      expect(dailyOf(volumeEvents('daily').slice(-4)).every((e) => !isClosed(e.split(' ')[1]))).toBe(true);
    });

    it('computes the days again for a new config version, and only for it', async () => {
      caughtUp();
      await service().tick();
      dailySet.mockClear();
      await service({}, { ...MARKETS, version: 5 }).tick();
      const closed = dailySet.mock.calls.filter((c) => isClosed(day(c[4])));
      expect(closed).toHaveLength(10);
      expect(closed.every((c) => c[2].version === 5)).toBe(true);
      expect(daysDone).toHaveBeenLastCalledWith(ch, 'payment_volume', expect.any(Date), expect.any(Date), 5);
    });

    it('skips the days that are done, one metric apart from the other', async () => {
      caughtUp();
      computed.add('trade_volume:2026-10-14:4');
      computed.add('trade_volume:2026-10-13:4');
      computed.add('payment_volume:2026-10-12:4');
      await service().tick();
      const closed = dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]));
      expect(closed).toEqual([
        'payment_volume 2026-10-14',
        'payment_volume 2026-10-13',
        'trade_volume 2026-10-12',
        'trade_volume 2026-10-11',
        'payment_volume 2026-10-11',
        'trade_volume 2026-10-10',
        'payment_volume 2026-10-10',
      ]);
    });

    it('does nothing without a ledger, and when the first ledger is younger than the closed days', async () => {
      ch.watermark = unix('2026-10-16T12:00:00Z');
      await service().tick();
      expect(daysDone).not.toHaveBeenCalled();
      ch.closes = [unix('2026-10-15T08:00:00Z'), NOW_SECONDS - 3];
      await service().tick();
      expect(daysDone).not.toHaveBeenCalled();
      expect(dailySet).toHaveBeenCalledTimes(8); // today and yesterday, twice
    });

    it('works under its own budget, a per-tick one, and goes on where it stopped next tick', async () => {
      caughtUp();
      ch.closes = [unix('2026-09-01T08:00:00Z'), NOW_SECONDS - 3];
      closedDayMs = 3000;
      const svc = service();
      await svc.tick();
      // 3 s a set: sets start at 0, 3, 6 and 9 s; at 12 s the 10 s budget is spent
      expect(AGGREGATOR_VOLUME_BACKFILL_BUDGET_MS).toBe(10_000);
      const first = dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]));
      expect(first).toEqual([
        'trade_volume 2026-10-14',
        'payment_volume 2026-10-14',
        'trade_volume 2026-10-13',
        'payment_volume 2026-10-13',
      ]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('volume_backfill'));

      events.length = 0;
      jest.setSystemTime(NOW_MS + 60_000);
      await svc.tick();
      const second = dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]));
      expect(second).toEqual([
        'trade_volume 2026-10-12',
        'payment_volume 2026-10-12',
        'trade_volume 2026-10-11',
        'payment_volume 2026-10-11',
      ]);
    });

    it('never takes the tick from the live work: whatever it has left to do, the tick ends within its budget', async () => {
      caughtUp();
      ch.closes = [unix('2024-01-01T08:00:00Z'), NOW_SECONDS - 3];
      closedDayMs = 2500;
      await service().tick();
      expect(Date.now() - NOW_MS).toBeLessThanOrEqual(AGGREGATOR_TICK_BUDGET_MS + 2500);
    });

    it('a set that fails is logged and counted, the others go on, and it is tried again next tick', async () => {
      caughtUp();
      failing.add('payment_volume:2026-10-13');
      const svc = service();
      await svc.tick();
      expect(computed.has('trade_volume:2026-10-13:4')).toBe(true);
      expect(computed.has('payment_volume:2026-10-13:4')).toBe(false);
      expect(computed.has('trade_volume:2026-10-10:4')).toBe(true);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'volume_backfill' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('payment_volume 2026-10-13'));

      // it is left alone for a while (see the backoff tests), then tried again
      failing.clear();
      events.length = 0;
      await svc.tick();
      expect(dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]))).toEqual([]);
      jest.setSystemTime(NOW_MS + VOLUME_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]))).toEqual([
        'payment_volume 2026-10-13',
      ]);
    });

    it('gives up after three sets failed in a tick', async () => {
      caughtUp();
      for (let d = 10; d <= 14; d++) failing.add(`2026-10-${d}`);
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(3);
    });

    it('says when it starts, and when it is done', async () => {
      caughtUp();
      ch.closes = [unix('2026-10-01T08:00:00Z'), NOW_SECONDS - 3];
      closedDayMs = 3000;
      const svc = service();
      await svc.tick();
      expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/back-fill: \d+ daily sets/i));
      expect(logger.log.mock.calls.map(([m]) => String(m))).toContainEqual(
        expect.stringMatching(/^Volume back-fill: \d+ daily sets to compute, newest day first$/),
      );
      logger.log.mockClear();
      for (let i = 0; i < 20 && !logger.log.mock.calls.some(([m]) => /back-fill is done/i.test(String(m))); i++) {
        jest.setSystemTime(NOW_MS + (i + 1) * 60_000);
        await svc.tick();
      }
      expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/back-fill is done/i));
      // the words of the two messages, the same as before the volume and the AMM back-fills shared the code that says them
      expect(logger.log.mock.calls.map(([m]) => String(m))).toContain(
        'Volume back-fill is done: every closed day has its daily sets',
      );
    });

    it('starts no set after the shutdown began', async () => {
      caughtUp();
      const svc = service();
      dailySet.mockImplementation(async (_c: unknown, _r: unknown, _m: unknown, metric: string, d: Date) => {
        events.push(`daily ${metric} ${day(d)}`);
        if (day(d) === '2026-10-13' && metric === 'payment_volume') void svc.stop();
        return 0;
      });
      await svc.tick();
      const closed = dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]));
      expect(closed[closed.length - 1]).toBe('payment_volume 2026-10-13');
    });
  });

  describe('the days of agg_dirty ranges (the hook of stats_dirty)', () => {
    it('recomputes the daily volumes of the days a slice covers, after its stats, and removes the range', async () => {
      caughtUp();
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      await service().tick();
      const at = events.indexOf('stats 2026-05-01T22:00:00Z');
      expect(events.slice(at, at + 5)).toEqual([
        'stats 2026-05-01T22:00:00Z',
        'daily trade_volume 2026-05-01',
        'daily payment_volume 2026-05-01',
        'daily trade_volume 2026-05-02',
        'daily payment_volume 2026-05-02',
      ]);
      expect(ch.dirty).toEqual([]);
    });

    it('a range of several days: each slice recomputes its own days, a day cut by two slices once more than needed is fine', async () => {
      caughtUp();
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-03T06:00:00Z')];
      await service().tick();
      const days = dailyOf(volumeEvents('daily')).filter((e) => e.split(' ')[1] < '2026-06-01');
      expect([...new Set(days.map((e) => e.split(' ')[1]))]).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
    });

    it('computes a day once for the ranges of one tick, unless the ingest marked it again after that', async () => {
      caughtUp();
      ch.dirty = [
        mark('2026-05-01T01:00:00Z', '2026-05-01T02:00:00Z', 1000),
        mark('2026-05-01T05:00:00Z', '2026-05-01T06:00:00Z', 2000),
      ];
      await service().tick();
      expect(dailyOf(volumeEvents('daily')).filter((e) => e.endsWith('2026-05-01'))).toEqual([
        'trade_volume 2026-05-01',
        'payment_volume 2026-05-01',
      ]);

      // the second range was marked after the day began (the ingest wrote more ledgers meanwhile): the day is done again
      events.length = 0;
      ch.dirty = [
        mark('2026-05-01T01:00:00Z', '2026-05-01T02:00:00Z', 1000),
        mark('2026-05-01T05:00:00Z', '2026-05-01T06:00:00Z', NOW_MS + 5000),
      ];
      await service().tick();
      expect(dailyOf(volumeEvents('daily')).filter((e) => e.endsWith('2026-05-01'))).toHaveLength(4);
    });

    it('a day that fails keeps the range, counts the failure, and the next tick does it again', async () => {
      caughtUp();
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      failing.add('payment_volume:2026-05-02');
      const svc = service();
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'volume_dirty' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('volume_dirty'));

      failing.clear();
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(computed.has('payment_volume:2026-05-02:4')).toBe(true);
    });

    it('does not touch the volumes without the option', async () => {
      caughtUp();
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      await service({ volumes: undefined }).tick();
      expect(dailySet).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('a day cut short by the shutdown is neither an error nor counted, and the range stays', async () => {
      caughtUp();
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      const svc = service();
      dailySet.mockImplementation(async (_c: unknown, _r: unknown, _m: unknown, metric: string, d: Date) => {
        if (day(d) === '2026-05-01') {
          void svc.stop();
          throw new VolumeRecomputeAborted();
        }
        return 0;
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
    });
  });

  describe('the closed days follow the ingest, not the clock', () => {
    const closedOf = (): string[] => dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]));

    it('a day the ingest has not passed is not back-filled: the newest ledger decides (an outage that left the last hours of a day out)', async () => {
      caughtUp();
      // the ingest is behind: the newest ledger closed on the 13th at 00:30, the wall clock is on the 16th
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-13T00:30:00Z')];
      const svc = service();
      await svc.tick();
      // a day is closed when the newest ledger closed an hour after its end: the 12th has not (its end + 1 h is 01:00 of the 13th)
      expect(closedOf()).toEqual([
        'trade_volume 2026-10-11',
        'payment_volume 2026-10-11',
        'trade_volume 2026-10-10',
        'payment_volume 2026-10-10',
      ]);
      expect(daysDone).toHaveBeenCalledWith(
        ch,
        'trade_volume',
        new Date('2026-10-10T00:00:00Z'),
        new Date('2026-10-12T00:00:00Z'),
        4,
      );

      // the ingest catches up: the 12th and the 13th become closed as the ledgers pass them
      events.length = 0;
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-13T01:00:00Z')];
      await svc.tick();
      expect(closedOf()).toEqual(['trade_volume 2026-10-12', 'payment_volume 2026-10-12']);
      events.length = 0;
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-14T20:00:00Z')];
      await svc.tick();
      expect(closedOf()).toEqual(['trade_volume 2026-10-13', 'payment_volume 2026-10-13']);
    });

    it('the end of the day plus the settle time, to the second', async () => {
      expect(VOLUME_DAY_SETTLE_MS).toBe(3_600_000);
      caughtUp();
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-12T00:59:59Z')];
      await service().tick();
      // 10-11 ends at 10-12 00:00; the newest ledger is 59 min 59 s after it
      expect(closedOf()).toEqual(['trade_volume 2026-10-10', 'payment_volume 2026-10-10']);
      events.length = 0;
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-12T01:00:00Z')];
      await service().tick();
      expect(closedOf()).toEqual(['trade_volume 2026-10-11', 'payment_volume 2026-10-11']);
    });

    it('an ingest that started at an old ledger leaves no closed day to back-fill: no sentinel-only set for days not yet ingested', async () => {
      caughtUp();
      // the live runner started at a ledger of the 1st; nothing after it is in yet
      ch.closes = [unix('2026-10-01T09:00:00Z')];
      await service().tick();
      expect(closedOf()).toEqual([]);
      expect(daysDone).not.toHaveBeenCalled();
      // today and yesterday are still written (the stalest first): they are not final
      expect(dailyOf(volumeEvents('daily'))).toHaveLength(4);
    });

    it('the day of the newest ledger is never closed, and a day before the first ledger does not exist', async () => {
      caughtUp();
      ch.closes = [unix('2026-10-12T23:00:00Z'), unix('2026-10-12T23:30:00Z')];
      await service().tick();
      expect(closedOf()).toEqual([]);
    });

    it('yesterday is not closed even when the ingest is far past it', async () => {
      caughtUp();
      ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
      await service().tick();
      expect(closedOf().map((e) => e.split(' ')[1])).not.toContain('2026-10-15');
      expect(closedOf().map((e) => e.split(' ')[1])).toContain('2026-10-14');
    });
  });

  describe('the stalest set first (every set is refreshed in turn under a short budget)', () => {
    const seq = (calls: LiveCall[]): string[] => calls.map((c) => `${c.metric.replace('_volume', '')} ${c.period}`);

    it('live: with a budget for two sets of seven, every set is written within four ticks, and in any four ticks in a row', async () => {
      caughtUp();
      liveMs = 3000; // sets start at 0 s and 3 s; the third would start at 6 s, past the 5 s of the budget
      const svc = service();
      const ticks: string[][] = [];
      for (let i = 0; i < 9; i++) {
        jest.setSystemTime(NOW_MS + i * 60_000);
        liveCalls.length = 0;
        await svc.tick();
        ticks.push(seq(liveCalls));
      }
      expect(ticks.slice(0, 4)).toEqual([
        ['trade hour', 'trade day'],
        ['trade 3day', 'trade 7day'],
        ['trade 30day', 'payment hour'],
        ['payment day', 'trade hour'],
      ]);
      for (let from = 0; from + 4 <= ticks.length; from++) {
        expect(new Set(ticks.slice(from, from + 4).flat()).size).toBe(7);
      }
    });

    it('live: a set that failed keeps its old version, but is tried behind the sets that did not fail (R87)', async () => {
      caughtUp();
      liveMs = 3000;
      failing.add('trade_volume/hour');
      const svc = service();
      await svc.tick();
      expect(seq(liveCalls)).toEqual(['trade hour', 'trade day', 'trade 3day']);
      expect(liveWrites.has('trade_volume/hour')).toBe(false);
      liveCalls.length = 0;
      jest.setSystemTime(NOW_MS + 60_000);
      await svc.tick();
      // the sets never written come first, the one that failed is behind them: with a budget for two it waits its turn
      expect(seq(liveCalls)).toEqual(['trade 7day', 'trade 30day']);
    });

    describe('a set that keeps failing does not keep the healthy ones from running (R87)', () => {
      const HEALTHY = ['trade day', 'trade 3day', 'trade 7day', 'trade 30day', 'payment hour', 'payment day'];
      const tickLive = async (svc: AggregatorService, i: number): Promise<string[]> => {
        jest.setSystemTime(NOW_MS + i * 60_000);
        liveCalls.length = 0;
        await svc.tick();
        return seq(liveCalls);
      };

      it('a set that always fails slowly (longer than the budget) is tried last: the other six are refreshed at every tick', async () => {
        caughtUp();
        failing.add('trade_volume/hour');
        failMs = AGGREGATOR_VOLUME_LIVE_BUDGET_MS + 1000; // the failure alone is over the 5 s of the budget
        const svc = service();
        // the first tick cannot know: the set that was never written is the stalest, so it starts first and uses the budget
        expect(await tickLive(svc, 0)).toEqual(['trade hour']);
        for (let i = 1; i < 6; i++) {
          const calls = await tickLive(svc, i);
          // after that it is behind the sets that did not fail, which are all started (and take no time here) before it
          expect(calls.slice(0, 6).sort()).toEqual([...HEALTHY].sort());
          expect(calls[6]).toBe('trade hour');
          expect(calls).toHaveLength(7);
        }
        // the healthy sets are written again at every tick; the one that fails never is
        expect(liveWrites.has('trade_volume/hour')).toBe(false);
        expect(
          Math.min(...HEALTHY.map((name) => liveWrites.get(`${name.split(' ')[0]}_volume/${name.split(' ')[1]}`) ?? 0)),
        ).toBeGreaterThan(0);
      });

      it('three sets that fail fast do not use up the failures of the tick before the healthy ones are refreshed', async () => {
        caughtUp();
        for (const key of ['trade_volume/hour', 'trade_volume/day', 'trade_volume/3day']) failing.add(key);
        const svc = service();
        await tickLive(svc, 0); // the first tick: they come first, fail three times, and the tick gives up
        expect(liveCalls).toHaveLength(3);
        for (let i = 1; i < 5; i++) {
          const calls = await tickLive(svc, i);
          // the four healthy sets first, then the three that failed (each fails again; the tick gives up at the third)
          expect(calls.slice(0, 4).sort()).toEqual(['payment day', 'payment hour', 'trade 30day', 'trade 7day']);
          expect(calls.slice(4).sort()).toEqual(['trade 3day', 'trade day', 'trade hour']);
        }
        expect(liveWrites.size).toBe(4);
      });

      it('within each group the stalest is first; a set that recovers is back in the order of its version', async () => {
        caughtUp();
        failing.add('trade_volume/hour');
        const svc = service();
        await tickLive(svc, 0);
        expect((await tickLive(svc, 1)).slice(-1)).toEqual(['trade hour']);
        // it works again: it is still behind the others for the attempt in which it succeeds ...
        failing.clear();
        expect((await tickLive(svc, 2)).slice(-1)).toEqual(['trade hour']);
        expect(liveWrites.has('trade_volume/hour')).toBe(true);
        // ... and then it is just a set with a version: make it the stalest and it goes first
        liveWrites.delete('trade_volume/hour');
        expect((await tickLive(svc, 3))[0]).toBe('trade hour');
        // and a healthy set that is the stalest goes before a fresher one, as before
        liveWrites.set('payment_volume/hour', 0.5);
        expect((await tickLive(svc, 4))[0]).toBe('payment hour');
      });

      it('the daily sets: a day that fails is tried behind the others, and the memory goes with the day', async () => {
        caughtUp();
        ch.closes = [unix('2026-10-15T08:00:00Z'), NOW_SECONDS - 3]; // nothing to back-fill
        failing.add('trade_volume:2026-10-16');
        const svc = service();
        const dailyAt = async (at: string): Promise<string[]> => {
          jest.setSystemTime(new Date(at));
          events.length = 0;
          await svc.tick();
          return volumeEvents('daily').map((e) => e.slice(6));
        };
        expect((await dailyAt('2026-10-16T12:00:00Z'))[0]).toBe('trade_volume 2026-10-16');
        const next = await dailyAt('2026-10-16T12:01:00Z');
        expect(next.slice(0, 3)).toEqual([
          'payment_volume 2026-10-16',
          'trade_volume 2026-10-15',
          'payment_volume 2026-10-15',
        ]);
        expect(next[3]).toBe('trade_volume 2026-10-16');
        // the day moves on: the sets of the new day are not behind anything (the old one still fails, as yesterday's set)
        const tomorrow = await dailyAt('2026-10-17T00:00:30Z');
        expect(tomorrow[0]).toBe('trade_volume 2026-10-17');
        expect(tomorrow.slice(-1)).toEqual(['trade_volume 2026-10-16']);
        // two days after the failure the day is not among the sets of the job any more
        await dailyAt('2026-10-18T12:00:00Z');
        // and the memory of the failure is gone with the day (it does not grow by a key a day)
        const memory = (svc as unknown as { failedLast: { volume_daily: Set<string> } }).failedLast.volume_daily;
        expect([...memory]).toEqual([]);
      });
    });

    it('daily: yesterday is finalised after the midnight although the budget fits two of the four sets', async () => {
      caughtUp();
      ch.closes = [unix('2026-10-15T08:00:00Z'), NOW_SECONDS - 3]; // nothing to back-fill
      currentDayMs = 3000; // two sets in the 4 s of the budget
      const svc = service();
      const tickAt = async (at: string): Promise<string[]> => {
        jest.setSystemTime(new Date(at));
        events.length = 0;
        await svc.tick();
        return volumeEvents('daily').map((e) => e.slice(6));
      };
      expect(await tickAt('2026-10-16T12:00:00Z')).toEqual(['trade_volume 2026-10-16', 'payment_volume 2026-10-16']);
      // nothing of yesterday has been written yet: its sets are the stalest
      expect(await tickAt('2026-10-16T12:01:00Z')).toEqual(['trade_volume 2026-10-15', 'payment_volume 2026-10-15']);
      // the midnight: today (the 17th) has no set at all, then yesterday (the 16th), whose last set is the old one
      ch.closes = [unix('2026-10-15T08:00:00Z'), unix('2026-10-17T00:00:10Z')];
      expect(await tickAt('2026-10-17T00:00:30Z')).toEqual(['trade_volume 2026-10-17', 'payment_volume 2026-10-17']);
      expect(await tickAt('2026-10-17T00:01:30Z')).toEqual(['trade_volume 2026-10-16', 'payment_volume 2026-10-16']);
    });

    it('reads the versions once per tick for each job, for today and yesterday only, and for the live sets', async () => {
      caughtUp();
      await service().tick();
      expect(liveVersions).toHaveBeenCalledTimes(1);
      expect(dailyVersions).toHaveBeenCalledTimes(1);
      expect(dailyVersions).toHaveBeenCalledWith(
        ch,
        new Date('2026-10-15T00:00:00Z'),
        new Date('2026-10-16T00:00:00Z'),
      );
    });

    it('when the versions cannot be read the sets go in the default order, and the failure is logged and counted', async () => {
      caughtUp();
      liveVersions.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      dailyVersions.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      await service().tick();
      expect(seq(liveCalls)).toEqual([
        'trade hour',
        'trade day',
        'trade 3day',
        'trade 7day',
        'trade 30day',
        'payment hour',
        'payment day',
      ]);
      expect(volumeEvents('daily').slice(0, 4)).toEqual([
        'daily trade_volume 2026-10-16',
        'daily payment_volume 2026-10-16',
        'daily trade_volume 2026-10-15',
        'daily payment_volume 2026-10-15',
      ]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'volume_live' });
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'volume_daily' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('reading the versions of the sets'));
    });

    it('sets of the same version, or none, keep the order they are listed in', async () => {
      caughtUp();
      liveVersions.mockResolvedValue(
        new Map([
          ['trade_volume/day', 7],
          ['payment_volume/hour', 7],
        ]),
      );
      await service().tick();
      expect(seq(liveCalls)).toEqual([
        'trade hour',
        'trade 3day',
        'trade 7day',
        'trade 30day',
        'payment day',
        'trade day',
        'payment hour',
      ]);
    });
  });

  describe('a closed day that fails every time does not hold the back-fill up', () => {
    const closedOf = (): string[] => dailyOf(volumeEvents('daily')).filter((e) => isClosed(e.split(' ')[1]));
    const tickAt = async (svc: AggregatorService, ms: number): Promise<string[]> => {
      jest.setSystemTime(NOW_MS + ms);
      events.length = 0;
      await svc.tick();
      return closedOf();
    };

    it('the sets that failed are skipped while they wait, so the older days go on; then they are tried again', async () => {
      caughtUp();
      for (const d of ['2026-10-14', '2026-10-13', '2026-10-12']) failing.add(d);
      const svc = service();
      // the newest end fails: three sets and the tick gives up
      expect(await tickAt(svc, 0)).toEqual([
        'trade_volume 2026-10-14',
        'payment_volume 2026-10-14',
        'trade_volume 2026-10-13',
      ]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(3);
      // the next tick leaves those three alone and fails on the next three
      expect(await tickAt(svc, 60_000)).toEqual([
        'payment_volume 2026-10-13',
        'trade_volume 2026-10-12',
        'payment_volume 2026-10-12',
      ]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(6);
      // and the one after that gets to the older days
      expect(await tickAt(svc, 120_000)).toEqual([
        'trade_volume 2026-10-11',
        'payment_volume 2026-10-11',
        'trade_volume 2026-10-10',
        'payment_volume 2026-10-10',
      ]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(6);
      expect(computed.has('payment_volume:2026-10-10:4')).toBe(true);
    });

    it('a failed set is tried again after the wait, which doubles at every failure up to a limit', async () => {
      caughtUp();
      ch.closes = [unix('2026-10-13T08:00:00Z'), NOW_SECONDS - 3]; // one closed day: the 13th and the 14th
      failing.add('trade_volume:2026-10-14');
      const svc = service();
      const attempts = (): number =>
        dailySet.mock.calls.filter((c) => c[3] === 'trade_volume' && day(c[4]) === '2026-10-14').length;
      await tickAt(svc, 0);
      expect(attempts()).toBe(1);
      await tickAt(svc, VOLUME_BACKFILL_RETRY_MS - 1);
      expect(attempts()).toBe(1);
      await tickAt(svc, VOLUME_BACKFILL_RETRY_MS);
      expect(attempts()).toBe(2); // fails again: the wait is doubled, from now
      await tickAt(svc, VOLUME_BACKFILL_RETRY_MS + 2 * VOLUME_BACKFILL_RETRY_MS - 1);
      expect(attempts()).toBe(2);
      await tickAt(svc, 3 * VOLUME_BACKFILL_RETRY_MS);
      expect(attempts()).toBe(3);
      // many failures later the wait stays at its limit
      let at = 3 * VOLUME_BACKFILL_RETRY_MS;
      for (let i = 0; i < 6; i++) {
        at += VOLUME_BACKFILL_MAX_RETRY_MS;
        await tickAt(svc, at);
      }
      const before = attempts();
      await tickAt(svc, at + VOLUME_BACKFILL_MAX_RETRY_MS - 1);
      expect(attempts()).toBe(before);
      await tickAt(svc, at + VOLUME_BACKFILL_MAX_RETRY_MS);
      expect(attempts()).toBe(before + 1);
    });

    it('a set that works after a failure forgets it, and the back-fill is done when nothing waits any more', async () => {
      caughtUp();
      ch.closes = [unix('2026-10-14T08:00:00Z'), NOW_SECONDS - 3];
      ch.closes = [unix('2026-10-13T08:00:00Z'), NOW_SECONDS - 3];
      failing.add('payment_volume:2026-10-13');
      const svc = service();
      await tickAt(svc, 0);
      logger.log.mockClear();
      // while it waits the back-fill is not done, and says nothing of being done
      await tickAt(svc, 60_000);
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringMatching(/back-fill is done/i));
      failing.clear();
      expect(await tickAt(svc, VOLUME_BACKFILL_RETRY_MS)).toEqual(['payment_volume 2026-10-13']);
      expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/back-fill is done/i));
      // nothing is remembered: a later failure of another set starts at the first wait again
      expect(await tickAt(svc, VOLUME_BACKFILL_RETRY_MS + 60_000)).toEqual([]);
    });

    it('the wait is for the config version it failed under: a new version retries the set at once', async () => {
      caughtUp();
      failing.add('2026-10-14');
      const markets = { ...MARKETS };
      const svc = service({}, markets);
      expect(await tickAt(svc, 0)).toEqual(
        [
          'trade_volume 2026-10-14',
          'payment_volume 2026-10-14',
          'trade_volume 2026-10-13',
          'payment_volume 2026-10-13',
          'trade_volume 2026-10-12',
          'payment_volume 2026-10-12',
          'trade_volume 2026-10-11',
          'payment_volume 2026-10-11',
          'trade_volume 2026-10-10',
          'payment_volume 2026-10-10',
        ].slice(0, 10),
      );
      // the two sets of the 14th wait: a minute later they are skipped
      expect((await tickAt(svc, 60_000)).filter((e) => e.endsWith('2026-10-14'))).toEqual([]);
      // the operator changes the config, and the reason of the failure with it: the version is new, the wait does not apply
      failing.clear();
      markets.version = 5;
      const retried = await tickAt(svc, 120_000);
      expect(retried.slice(0, 2)).toEqual(['trade_volume 2026-10-14', 'payment_volume 2026-10-14']);
      expect(computed.has('trade_volume:2026-10-14:5')).toBe(true);
      expect(computed.has('payment_volume:2026-10-14:5')).toBe(true);
    });

    it('does not wait on a set that failed because of the shutdown', async () => {
      caughtUp();
      const svc = service();
      dailySet.mockImplementation(async (_c: unknown, _r: unknown, _m: unknown, metric: string, d: Date) => {
        events.push(`daily ${metric} ${day(d)}`);
        if (isClosed(day(d))) {
          void svc.stop();
          throw new VolumeRecomputeAborted();
        }
        return 0;
      });
      await tickAt(svc, 0);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });
  });

  describe('running out of the budget is said once for a streak of runs', () => {
    const budgetWarnings = (): number =>
      logger.warn.mock.calls.filter(([m]) => /volume_backfill reached its budget/.test(String(m))).length;
    const budgetDebugs = (): number =>
      logger.debug.mock.calls.filter(([m]) => /volume_backfill reached its budget/.test(String(m))).length;

    it('a long back-fill warns the first time, and says it at debug level on the ticks after', async () => {
      caughtUp();
      ch.closes = [unix('2026-09-01T08:00:00Z'), NOW_SECONDS - 3];
      closedDayMs = 3000;
      const svc = service();
      for (let i = 0; i < 4; i++) {
        jest.setSystemTime(NOW_MS + i * 60_000);
        await svc.tick();
      }
      expect(budgetWarnings()).toBe(1);
      expect(budgetDebugs()).toBe(3);
    });

    it('a run that finishes in time ends the streak: the next time it is said again', async () => {
      caughtUp();
      ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
      closedDayMs = 3000; // 10 sets, 4 a tick
      const markets = { ...MARKETS };
      const svc = service({}, markets);
      for (let i = 0; i < 3; i++) {
        jest.setSystemTime(NOW_MS + i * 60_000);
        await svc.tick();
      }
      // two ticks hit the budget (4 + 4 sets), the third did the last two sets in time
      expect(budgetWarnings()).toBe(1);
      expect(budgetDebugs()).toBe(1);

      // a new config version: all the days again, and a new streak
      markets.version = 5;
      for (let i = 3; i < 5; i++) {
        jest.setSystemTime(NOW_MS + i * 60_000);
        await svc.tick();
      }
      expect(budgetWarnings()).toBe(2);
    });

    it('the other volume jobs warn once as well, per job', async () => {
      caughtUp();
      liveMs = 3000;
      const svc = service();
      for (let i = 0; i < 3; i++) {
        jest.setSystemTime(NOW_MS + i * 60_000);
        await svc.tick();
      }
      expect(logger.warn.mock.calls.filter(([m]) => /volume_live reached its budget/.test(String(m)))).toHaveLength(1);
      expect(logger.debug.mock.calls.filter(([m]) => /volume_live reached its budget/.test(String(m)))).toHaveLength(2);
    });
  });

  describe('the budgets of the tick', () => {
    it('the jobs that may run long have a budget: stats_live 20 s, stats_dirty 10 s, the volume jobs 5, 4 and 10 s', () => {
      expect(AGGREGATOR_LIVE_BUDGET_MS).toBe(20_000);
      expect(AGGREGATOR_DIRTY_BUDGET_MS).toBe(10_000);
      expect(AGGREGATOR_VOLUME_LIVE_BUDGET_MS + AGGREGATOR_VOLUME_DAILY_BUDGET_MS).toBeLessThan(
        AGGREGATOR_TICK_BUDGET_MS - AGGREGATOR_LIVE_BUDGET_MS,
      );
    });

    it('stats_dirty has a budget: a backlog of ranges does not take the rest of the tick', async () => {
      caughtUp();
      statsMs = 4000;
      ch.dirty = Array.from({ length: 20 }, (_, i) =>
        mark(
          `2026-04-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
          `2026-04-${String(i + 1).padStart(2, '0')}T05:00:00Z`,
          1000 + i,
        ),
      );
      await service({ volumes: undefined }).tick();
      // the live slice takes 4 s; dirty slices start while the 10 s since the start of the job are not spent: at 4, 8 and 12 s
      const dirtySlices = events.filter((e) => e.startsWith('stats 2026-04'));
      expect(dirtySlices).toHaveLength(3);
      expect(ch.dirty).toHaveLength(17);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stats_dirty'));
    });

    it('a long stats sweep and a dirty backlog cannot starve the live volumes: they are refreshed first, at every tick, with every AMM job registered', async () => {
      // 60 days of stats to catch up, 4 s a slice; 30 dirty ranges of a day, 4 s a slice; 300 closed days of volumes to
      // back-fill, 3 s a set; the AMM pools (3 s a batch, always one more to do) and 225 closed days of amm_daily, 3 s a day,
      // run at every tick here although the days are only meant for every fifth
      ch.watermark = unix('2026-08-17T00:00:00Z');
      ch.closes = Array.from({ length: 61 }, (_, i) => unix('2026-08-17T00:30:00Z') + i * DAY);
      ch.closes.push(NOW_SECONDS - 3);
      ch.dirty = Array.from({ length: 30 }, (_, i) => ({
        from: unix('2026-01-01T00:00:00Z') + i * DAY,
        to: unix('2026-01-02T00:00:00Z') + i * DAY,
        created: 1000 + i,
      }));
      statsMs = 4000;
      closedDayMs = 3000;
      let ledger = 0;
      const ammPoolsFunctions = {
        watermark: jest.fn(async () => 0),
        changedSince: jest.fn(async () => ({ accounts: ['rBusyPool'], upTo: ++ledger })),
        poolsClosedIn: jest.fn(async () => []),
        recompute: jest.fn(async () => {
          events.push('pools');
          jest.setSystemTime(Date.now() + 3000);
          return 1;
        }),
      };
      /** When the sets of the job itself (today, yesterday, the back-fill) started, in the tick that is running. */
      const ammDailyStarts: number[] = [];
      const ammDailyFunctions = {
        // the days of the dirty ranges (January) are quick, the days of the back-fill are not
        compute: jest.fn(async (_c: unknown, _r: unknown, d: Date) => {
          events.push(`amm_daily ${day(d)}`);
          if (day(d) >= '2026-03-01') {
            ammDailyStarts.push(Date.now());
            jest.setSystemTime(Date.now() + 3000);
          }
          return 0;
        }),
        daysDone: jest.fn(async () => new Set<string>()),
        versions: jest.fn(async () => new Map<string, number>()),
        firstDay: jest.fn(async () => unix('2026-03-01T08:00:00Z')),
      };
      const svc = service({
        ammPools: { rates: RATES },
        ammPoolsFunctions,
        ammDaily: { rates: RATES },
        ammDailyFunctions,
        ammDailyEveryTicks: 1,
      });

      const startedAt: number[] = [];
      for (let tickNo = 0; tickNo < 3; tickNo++) {
        const tickStart = NOW_MS + tickNo * 60_000;
        jest.setSystemTime(tickStart);
        startedAt.push(tickStart);
        events.length = 0;
        liveCalls.length = 0;
        ammDailyStarts.length = 0;
        await svc.tick();
        // the seven live sets ran at the very start of the tick, before any stats slice, whatever followed
        expect(liveCalls).toHaveLength(7);
        expect(liveCalls.every((c) => c.at === tickStart)).toBe(true);
        expect(events.slice(0, 7).every((e) => e.startsWith('live'))).toBe(true);
        // and the four daily sets of today and yesterday, so the first stats slice comes after eleven volume sets
        expect(events.findIndex((e) => e.startsWith('stats'))).toBeGreaterThanOrEqual(11);
        // and the tick is over within its budget plus the slice in flight plus the one closed day that the progress floor of
        // amm_daily starts (3 s here) whatever is left of the tick
        expect(Date.now() - tickStart).toBeLessThanOrEqual(AGGREGATOR_TICK_BUDGET_MS + 4000 + 3000);
        // the stats sweep is far from done: the sweep and the backlog are what ran long
        expect(ch.dirty.length).toBeGreaterThan(0);
        // amm_pools ran after the live volumes, and amm_daily after the dirty queue, which is why it never starves them
        expect(events.indexOf('pools')).toBeGreaterThan(10);
        const lastLive = events.lastIndexOf('live payment_volume day');
        expect(events.findIndex((e) => e.startsWith('amm_daily'))).toBeGreaterThan(lastLive);
        // amm_daily had its turn although the sweeps used the tick up: the one closed day of its progress floor started, and
        // any set after that one started within the 4 s of the job
        expect(ammDailyStarts.length).toBeGreaterThanOrEqual(1);
        for (const at of ammDailyStarts.slice(1))
          expect(at - ammDailyStarts[0]).toBeLessThan(AGGREGATOR_AMM_DAILY_BUDGET_MS);
      }
    });

    it('the volume jobs before the stats cannot take more than their budgets even when their sets are slow', async () => {
      caughtUp();
      liveMs = 10_000;
      closedDayMs = 0;
      dailySet.mockImplementation(async (_c: unknown, _r: unknown, _m: unknown, metric: string, d: Date) => {
        events.push(`daily ${metric} ${day(d)}`);
        jest.setSystemTime(Date.now() + 10_000);
        return 0;
      });
      ch.dirty = [{ from: unix('2026-05-01T00:00:00Z'), to: unix('2026-05-01T05:00:00Z'), created: 1000 }];
      await service().tick();
      // one live set (10 s, over its 5 s budget), one daily set (10 s, over its 4 s): the tick is at 20 s, the stats still run
      expect(volumeEvents('live')).toHaveLength(1);
      expect(events.filter((e) => e.startsWith('daily') && !e.includes('2026-05')).length).toBe(1);
      expect(events.some((e) => e.startsWith('stats'))).toBe(true);
    });

    it('can be changed per job, and the live budget option still works', async () => {
      caughtUp();
      liveMs = 1000;
      await service({ budgetsMs: { volume_live: 2500 } }).tick();
      expect(liveCalls).toHaveLength(3);
      liveCalls.length = 0;
      jest.setSystemTime(NOW);
      await service({ liveBudgetMs: 1, budgetsMs: { volume_live: 100_000 } }).tick();
      expect(liveCalls).toHaveLength(7);
    });
  });
});

describe('AggregatorService amm_pools job', () => {
  const RATES = { nativeCurrency: 'XRP' } as RatesService;
  const MARKETS: MarketsConfig = { version: 4, tradeMarkets: [], paymentCurrencies: [] };
  /** The ledger the persistent watermark of the job is at when the process starts. */
  const START_LEDGER = 500;

  let ch: FakeClickHouse;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
    aggregatorStatsLagSeconds: { set: jest.Mock };
  };
  const created: AggregatorService[] = [];
  /** What happened, in order. */
  let events: string[];
  let statsRecompute: jest.Mock;
  let watermark: jest.Mock;
  let changedSince: jest.Mock;
  let closedIn: jest.Mock;
  let recomputePools: jest.Mock;
  /** What `poolsChangedSince` answers for the ledger it is asked from (nothing, and the same ledger, for any other). */
  let pages: Map<number, { accounts: string[]; upTo: number }>;
  /** The pools of the slice that starts at an instant (ISO), for the agg_dirty hook. */
  let slicePools: Map<string, string[]>;
  /** How long (fake milliseconds) the recompute of a batch of pools takes. */
  let poolMs: number;
  /** The pools the fake recompute fails on, whatever batch they are in. */
  let failing: Set<string>;
  /** The pools of the batches that the fake recompute did write, in order. */
  let done: string[];

  const mark = (from: string, to: string, createdMs = 1000) => ({ from: unix(from), to: unix(to), created: createdMs });
  const jobsRun = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const batches = (): string[][] => recomputePools.mock.calls.map(([, , accounts]) => accounts);

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
    };
    events = [];
    pages = new Map();
    slicePools = new Map();
    poolMs = 0;
    failing = new Set();
    done = [];
    statsRecompute = jest.fn(async (_ch: unknown, from: Date) => {
      events.push(`stats ${iso(from.getTime() / 1000)}`);
      return 1;
    });
    watermark = jest.fn(async () => START_LEDGER);
    changedSince = jest.fn(async (_ch: unknown, ledger: number) => {
      events.push(`changed ${ledger}`);
      return pages.get(ledger) ?? { accounts: [], upTo: ledger };
    });
    closedIn = jest.fn(
      async (_ch: unknown, _rates: unknown, from: Date) => slicePools.get(iso(from.getTime() / 1000)) ?? [],
    );
    recomputePools = jest.fn(async (_ch: unknown, _rates: unknown, accounts: string[]) => {
      events.push(`pools ${accounts.join(',')}`);
      if (poolMs > 0) jest.setSystemTime(Date.now() + poolMs);
      const bad = accounts.filter((a) => failing.has(a));
      if (bad.length > 0) throw new Error(`DB::Exception: memory limit on pool ${bad[0]}`);
      done.push(...accounts);
      return accounts.length;
    });
    // the stats are up to date: the live window is the last slice only
    ch.watermark = unix('2026-10-16T12:00:00Z');
    ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
  });

  afterEach(async () => {
    const stops = created.splice(0).map((svc) => svc.stop());
    await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS);
    await Promise.all(stops);
    jest.useRealTimers();
  });

  function service(options: AggregatorOptions = {}): AggregatorService {
    const svc = new AggregatorService(ch.asService(), metrics as never, { register: jest.fn() } as never, {
      logger,
      recompute: statsRecompute,
      ammPools: { rates: RATES },
      ammPoolsFunctions: { watermark, changedSince, poolsClosedIn: closedIn, recompute: recomputePools },
      ...options,
    });
    created.push(svc);
    return svc;
  }

  describe('the job in the tick', () => {
    it('comes after volume_daily and before stats_live, with the volume jobs and without them', async () => {
      const volumeFunctions = {
        computeLiveSet: jest.fn(async () => 0),
        computeDailySet: jest.fn(async () => 0),
        daysDone: jest.fn(async () => new Set<string>()),
        liveVersions: jest.fn(async () => new Map<string, number>()),
        dailyVersions: jest.fn(async () => new Map<string, number>()),
      };
      await service({ volumes: { rates: RATES, markets: MARKETS }, volumeFunctions }).tick();
      expect(jobsRun()).toEqual([
        'volume_live',
        'volume_daily',
        'amm_pools',
        'stats_live',
        'stats_dirty',
        'volume_backfill',
      ]);

      metrics.aggregatorRunsTotal.inc.mockClear();
      await service().tick();
      expect(jobsRun()).toEqual(['amm_pools', 'stats_live', 'stats_dirty']);
    });

    it('is off without the option: nothing is asked of the AMM functions, and a dirty range is only the stats', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      slicePools.set('2026-05-01T00:00:00Z', ['rA']);
      await service({ ammPools: undefined }).tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      for (const fn of [watermark, changedSince, closedIn, recomputePools]) expect(fn).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('has a budget of 3 s, which is not the live or the dirty one', () => {
      expect(AGGREGATOR_AMM_POOLS_BUDGET_MS).toBe(3000);
      expect(AMM_POOLS_BATCH).toBeGreaterThan(0);
    });
  });

  describe('the watermark', () => {
    it('is read once, when the first tick starts, and the job goes on from it', async () => {
      pages.set(500, { accounts: ['rA', 'rB'], upTo: 700 });
      pages.set(700, { accounts: ['rC'], upTo: 900 });
      const svc = service();
      await svc.tick();
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(watermark).toHaveBeenCalledWith(ch);
      expect(changedSince.mock.calls.map(([, ledger, limit]) => [ledger, limit])).toEqual([
        [500, AMM_POOLS_BATCH],
        [700, AMM_POOLS_BATCH],
        [900, AMM_POOLS_BATCH],
      ]);
      expect(batches()).toEqual([['rA', 'rB'], ['rC']]);
      // every recompute gets the database, the rates of the network and the shutdown signal
      expect(recomputePools.mock.calls[0][0]).toBe(ch);
      expect(recomputePools.mock.calls[0][1]).toBe(RATES);
      expect(recomputePools.mock.calls[0][3]).toEqual({ signal: expect.any(AbortSignal) });

      // the next tick starts where this one ended, without reading the watermark again
      pages.set(900, { accounts: ['rD'], upTo: 1000 });
      jest.setSystemTime(NOW_SECONDS * 1000 + 60_000);
      await svc.tick();
      expect(watermark).toHaveBeenCalledTimes(1);
      expect(changedSince.mock.calls.slice(3).map(([, ledger]) => ledger)).toEqual([900, 1000]);
      expect(batches()).toEqual([['rA', 'rB'], ['rC'], ['rD']]);
    });

    it('advances after each batch is written, never before: a batch is recomputed, then the cursor moves', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      pages.set(700, { accounts: ['rB'], upTo: 900 });
      await service().tick();
      expect(events.filter((e) => !e.startsWith('stats'))).toEqual([
        'changed 500',
        'pools rA',
        'changed 700',
        'pools rB',
        'changed 900',
      ]);
    });

    it('does not move when nothing changed, and does not recompute anything', async () => {
      await service().tick();
      expect(changedSince).toHaveBeenCalledTimes(1);
      expect(recomputePools).not.toHaveBeenCalled();
      expect(jobsRun()).toContain('amm_pools');
    });

    it('does not ask for the same pools for ever when an answer does not move the cursor', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 500 });
      await service().tick();
      expect(batches()).toEqual([['rA']]);
      expect(changedSince).toHaveBeenCalledTimes(1);
    });

    it('a failing read of the watermark is a failed job, the stats still run, and the next tick reads it again', async () => {
      watermark.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      const svc = service();
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      expect(recomputePools).not.toHaveBeenCalled();

      await svc.tick();
      expect(watermark).toHaveBeenCalledTimes(2);
      expect(batches()).toEqual([['rA']]);
    });
  });

  describe('failures', () => {
    const POOLS5 = ['rA', 'rB', 'rC', 'rD', 'rE'];
    const errors = (): number => metrics.aggregatorErrorsTotal.inc.mock.calls.length;
    /** A tick `minutes` after the first one. */
    const tickAt = async (svc: AggregatorService, minutes: number): Promise<void> => {
      jest.setSystemTime(NOW_SECONDS * 1000 + minutes * 60_000);
      await svc.tick();
    };

    it('a batch that fails as a whole is the failure of the job: the cursor stays behind it, nothing is set aside, and the next tick does it again', async () => {
      pages.set(500, { accounts: POOLS5, upTo: 700 });
      pages.set(700, { accounts: ['rF'], upTo: 900 });
      // more pools than the isolation takes for a cause of its own
      for (const pool of POOLS5) failing.add(pool);
      expect(POOLS5.length).toBeGreaterThan(MAX_ISOLATED_POOLS_PER_BATCH);
      const svc = service();
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('amm_pools'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      // the jobs after it still ran
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);
      expect(done).toEqual([]);

      failing.clear();
      await tickAt(svc, 1);
      // the batch of 500 is the one done again: the cursor was at 500, and nothing was set aside to wait
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700, 900]);
      expect(done).toEqual([...POOLS5, 'rF']);
      expect(jobsRun()).toContain('amm_pools');
      expect(errors()).toBe(1);
    });

    it('a failing read of what changed is a failure of the job as well', async () => {
      changedSince.mockRejectedValueOnce(new Error('DB::Exception: no such table'));
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no such table'));
    });

    it('moves the cursor over ledgers with nothing to rebuild: an answer without pools still says how far it is complete', async () => {
      pages.set(500, { accounts: [], upTo: 900 });
      pages.set(900, { accounts: ['rA'], upTo: 950 });
      const svc = service();
      await svc.tick();
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);
      expect(recomputePools).not.toHaveBeenCalled();
      await tickAt(svc, 1);
      expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 900, 950]);
      expect(batches()).toEqual([['rA']]);
    });

    describe('one pool that fails every time (Ruling R-A15)', () => {
      it('is found by halving the batch and set aside; the other pools of its batch and the later batches are done', async () => {
        pages.set(500, { accounts: POOLS5, upTo: 700 });
        pages.set(700, { accounts: ['rF'], upTo: 900 });
        failing.add('rC');
        await service().tick();
        // the batch, its first half (three), that half's first half, the pool alone, and the other half of the batch
        expect(batches()).toEqual([POOLS5, ['rA', 'rB', 'rC'], ['rA', 'rB'], ['rC'], ['rD', 'rE'], ['rF']]);
        expect(done).toEqual(['rA', 'rB', 'rD', 'rE', 'rF']);
        // the cursor passed the batch, and the job ran to the end
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700, 900]);
        expect(jobsRun()).toEqual(['amm_pools', 'stats_live', 'stats_dirty']);
        // one error, for the pool, and not one for the batch
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rC'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
      });

      it('is found even when it is the first of the batch, whose halves all fail until the pool is alone', async () => {
        pages.set(500, { accounts: POOLS5, upTo: 700 });
        failing.add('rA');
        await service().tick();
        expect(done).toEqual(['rB', 'rC', 'rD', 'rE']);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);
        expect(errors()).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rA'));
      });

      it('up to three pools of a batch are set aside, a fourth makes it the failure of the job', async () => {
        pages.set(500, { accounts: POOLS5, upTo: 700 });
        for (const pool of ['rA', 'rC', 'rE']) failing.add(pool);
        expect(MAX_ISOLATED_POOLS_PER_BATCH).toBe(3);
        const svc = service();
        await svc.tick();
        expect(done).toEqual(['rB', 'rD']);
        expect(errors()).toBe(3);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);

        // four in a batch: the cursor stays
        pages.set(700, { accounts: ['rF', 'rG', 'rH', 'rI'], upTo: 900 });
        for (const pool of ['rF', 'rG', 'rH', 'rI']) failing.add(pool);
        changedSince.mockClear();
        await tickAt(svc, 1);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([700]);
        expect(done).toEqual(['rB', 'rD']);
        expect(errors()).toBe(4);
      });

      it('is tried again after five minutes, then after twice as long each time up to an hour, and forgotten once it works', async () => {
        pages.set(500, { accounts: ['rA', 'rC'], upTo: 700 });
        failing.add('rC');
        const svc = service();
        const retries = (): number => batches().filter((b) => b.length === 1 && b[0] === 'rC').length;
        await svc.tick();
        expect(retries()).toBe(1);
        expect(errors()).toBe(1);
        expect([AMM_POOL_RETRY_MS, AMM_POOL_MAX_RETRY_MS]).toEqual([5 * 60_000, 60 * 60_000]);

        let at = 0;
        let count = 1;
        for (const waitMinutes of [5, 10, 20, 40, 60, 60]) {
          // a tick a second before the wait is over leaves it alone ...
          jest.setSystemTime(NOW_SECONDS * 1000 + (at + waitMinutes) * 60_000 - 1000);
          await svc.tick();
          expect(retries()).toBe(count);
          // ... and one at the end of it tries again, and fails again: each failure is an error
          await tickAt(svc, at + waitMinutes);
          count++;
          expect(retries()).toBe(count);
          expect(errors()).toBe(count);
          at += waitMinutes;
        }
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rC'));

        // it works at last: rebuilt, and not asked for again
        failing.clear();
        await tickAt(svc, at + 60);
        expect(done).toEqual(['rA', 'rC']);
        const before = recomputePools.mock.calls.length;
        await tickAt(svc, at + 600);
        expect(recomputePools.mock.calls.length).toBe(before);
        expect(errors()).toBe(count);
      });

      it('is left out of the batches that come while it waits, and rebuilt by its retry with everything it has by then', async () => {
        pages.set(500, { accounts: ['rB', 'rC'], upTo: 700 });
        pages.set(700, { accounts: ['rC', 'rD'], upTo: 900 }); // it changed again
        failing.add('rC');
        const svc = service();
        await svc.tick();
        expect(batches()).toEqual([['rB', 'rC'], ['rB'], ['rC'], ['rD']]);
        expect(done).toEqual(['rB', 'rD']);

        failing.clear();
        await tickAt(svc, 5);
        expect(batches().slice(4)).toEqual([['rC']]);
        expect(done).toEqual(['rB', 'rD', 'rC']);
      });

      it('has its retry after the new work of the tick', async () => {
        pages.set(500, { accounts: ['rB', 'rC'], upTo: 700 });
        failing.add('rC');
        const svc = service();
        await svc.tick();
        const first = batches().length;

        failing.clear();
        pages.set(700, { accounts: ['rD'], upTo: 900 });
        await tickAt(svc, 5);
        expect(batches().slice(first)).toEqual([['rD'], ['rC']]);
      });

      it('has its retry in a tick whose live part failed', async () => {
        pages.set(500, { accounts: ['rB', 'rC'], upTo: 700 });
        failing.add('rC');
        const svc = service();
        await svc.tick();
        expect(errors()).toBe(1);

        // when the retry is due, a batch fails as a whole; the pool that was set aside works again
        failing.clear();
        for (const pool of POOLS5) if (pool !== 'rC') failing.add(pool);
        pages.set(700, { accounts: POOLS5.filter((p) => p !== 'rC'), upTo: 900 });
        await tickAt(svc, 5);
        expect(errors()).toBe(2); // the failure of the job
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('memory limit'));
        expect(done).toEqual(['rB', 'rC']);
      });

      it('the retries are under the budget of the job: a slow one uses it up, and the next waits for the next tick', async () => {
        pages.set(500, { accounts: ['rA', 'rC', 'rE'], upTo: 700 });
        failing.add('rC');
        failing.add('rE');
        const svc = service({ budgetsMs: { amm_pools: 1000 } });
        await svc.tick();
        expect(errors()).toBe(2);

        failing.clear();
        poolMs = 1100;
        await tickAt(svc, 5);
        expect(done).toEqual(['rA', 'rC']);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_pools reached its budget'));

        await tickAt(svc, 6);
        expect(done).toEqual(['rA', 'rC', 'rE']);
      });

      it('is not set aside by the shutdown: an aborted batch is neither an error nor a pool to retry', async () => {
        pages.set(500, { accounts: POOLS5, upTo: 700 });
        const svc = service();
        recomputePools.mockImplementation(async () => {
          void svc.stop();
          throw new AmmPoolsRecomputeAborted();
        });
        await svc.tick();
        expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        expect(recomputePools).toHaveBeenCalledTimes(1); // no halving
      });
    });

    describe('a halving that does not fit in the budget of one tick', () => {
      const MANY = Array.from({ length: AMM_POOLS_BATCH }, (_, i) => `r${String(i).padStart(3, '0')}`);

      it('goes on where it stopped at the next ticks, and the cursor moves on once the failing pool is found', async () => {
        pages.set(500, { accounts: MANY, upTo: 700 });
        failing.add('r137');
        poolMs = 2000; // two calls of a tick use the 3 s of the budget
        const svc = service();
        let ticks = 0;
        while (!changedSince.mock.calls.some(([, ledger]) => ledger === 700) && ticks < 40) {
          await tickAt(svc, ticks++);
        }
        // about two recomputes for each of the log2(200) levels, two a tick
        expect(ticks).toBeLessThanOrEqual(12);
        expect(changedSince.mock.calls.filter(([, ledger]) => ledger === 500)).toHaveLength(1);
        // every other pool was rebuilt, once, and the failing one is set aside and counted
        expect([...done].sort()).toEqual(MANY.filter((p) => p !== 'r137'));
        expect(errors()).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool r137'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_pools reached its budget'));
      });

      it('a batch that cannot be halved to a pool because the whole database fails is dropped once four pools fail', async () => {
        pages.set(500, { accounts: MANY, upTo: 700 });
        for (const pool of MANY) failing.add(pool);
        poolMs = 2000;
        const svc = service();
        for (let i = 0; i < 40 && errors() === 0; i++) await tickAt(svc, i);
        expect(errors()).toBe(1);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger).every((ledger) => ledger === 500)).toBe(true);
        expect(done).toEqual([]);
      });
    });

    describe('a batch in which everything fails (the database)', () => {
      it('is the failure of the job, not a reason to set its pools aside: they are, if they fail alone again next time', async () => {
        pages.set(500, { accounts: ['rA', 'rB'], upTo: 700 });
        failing.add('rA');
        failing.add('rB');
        const svc = service();
        await svc.tick();
        expect(batches()).toEqual([['rA', 'rB'], ['rA'], ['rB']]);
        expect(errors()).toBe(1);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500]);

        // the same batch fails the same way: now the pools are set aside, and the cursor goes on
        await tickAt(svc, 1);
        expect(errors()).toBe(3);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700]);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rA'));
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rB'));
      });

      it('when the database comes back the next tick does the batch, and nothing waits for a retry', async () => {
        pages.set(500, { accounts: ['rA'], upTo: 700 });
        failing.add('rA');
        const svc = service();
        await svc.tick();
        expect(errors()).toBe(1);
        expect(done).toEqual([]);

        failing.clear();
        await tickAt(svc, 1);
        expect(done).toEqual(['rA']);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 500, 700]);
        // nothing was set aside: no retry comes
        const calls = recomputePools.mock.calls.length;
        await tickAt(svc, 600);
        expect(recomputePools.mock.calls.length).toBe(calls);
        expect(errors()).toBe(1);
      });

      it('a pool that fails alone while the rest of its batch works is set aside at once', async () => {
        pages.set(500, { accounts: ['rA', 'rB'], upTo: 700 });
        failing.add('rA');
        await service().tick();
        expect(done).toEqual(['rB']);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);
      });
    });

    describe('a batch that fails as a whole although each half works', () => {
      it('is warned about and counted once, and the cursor goes on', async () => {
        pages.set(500, { accounts: ['rA', 'rB', 'rC', 'rD'], upTo: 700 });
        recomputePools.mockImplementation(async (_c: unknown, _r: unknown, accounts: string[]) => {
          if (accounts.length >= 4) throw new Error('DB::Exception: too many pools for the memory limit');
          done.push(...accounts);
          return accounts.length;
        });
        await service().tick();
        expect(done).toEqual(['rA', 'rB', 'rC', 'rD']);
        expect(changedSince.mock.calls.map(([, ledger]) => ledger)).toEqual([500, 700]);
        expect(errors()).toBe(1);
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('as a whole'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('too many pools'));
      });

      it('counts a failure that led to no pool once, and none of those on the way to a pool', async () => {
        pages.set(500, { accounts: ['rA', 'rB', 'rC', 'rD', 'rE', 'rF', 'rG', 'rH'], upTo: 700 });
        failing.add('rH');
        recomputePools.mockImplementation(async (_c: unknown, _r: unknown, accounts: string[]) => {
          if (accounts.includes('rH')) throw new Error('DB::Exception: pool rH');
          if (accounts.length >= 4) throw new Error('DB::Exception: size');
          done.push(...accounts);
          return accounts.length;
        });
        await service().tick();
        // the batch, [E..H] and [G, H] fail on the way to rH; [A..D] fails for its size alone and its halves work
        expect(done).toEqual(['rA', 'rB', 'rC', 'rD', 'rE', 'rF', 'rG']);
        expect(errors()).toBe(2); // the pool, and the size
        expect(logger.warn.mock.calls.filter(([text]) => String(text).includes('as a whole'))).toHaveLength(1);
      });
    });
  });

  describe('the budget', () => {
    it('stops starting batches when the budget of the job is spent, says so, and goes on from the cursor next tick', async () => {
      poolMs = 400;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { accounts: [`r${i}`], upTo: 510 + i * 10 });
      const svc = service({ budgetsMs: { amm_pools: 1000 } });
      await svc.tick();
      // batches start at 0, 400 and 800 ms (inside the 1000 ms) and not at 1200
      expect(batches()).toEqual([['r0'], ['r1'], ['r2']]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_pools reached its budget'));
      // the other jobs of the tick were not held up
      expect(jobsRun()).toEqual(['amm_pools', 'stats_live', 'stats_dirty']);

      jest.setSystemTime(NOW_SECONDS * 1000 + 60_000);
      await svc.tick();
      expect(batches().slice(3)).toEqual([['r3'], ['r4'], ['r5']]);
    });

    it('is 3 s by default: a slow batch uses it up, and the stats still get the rest of the tick', async () => {
      poolMs = 10_000;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { accounts: [`r${i}`], upTo: 510 + i * 10 });
      await service().tick();
      expect(batches()).toEqual([['r0']]);
      expect(events.some((e) => e.startsWith('stats'))).toBe(true);
    });

    it('does not take more than the tick has left either', async () => {
      poolMs = 5000;
      for (let i = 0; i < 10; i++) pages.set(500 + i * 10, { accounts: [`r${i}`], upTo: 510 + i * 10 });
      await service({ tickBudgetMs: 4000, budgetsMs: { amm_pools: 100_000 } }).tick();
      expect(batches()).toEqual([['r0']]);
    });
  });

  describe('the pools of agg_dirty slices (the hook of stats_dirty)', () => {
    it('recomputes the pools with state rows in the slice, after its stats, and removes the range', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      slicePools.set('2026-05-01T22:00:00Z', ['rA', 'rB']);
      await service().tick();
      expect(closedIn).toHaveBeenCalledTimes(1);
      const [chArg, ratesArg, from, to] = closedIn.mock.calls[0];
      expect([chArg, ratesArg]).toEqual([ch, RATES]);
      expect([iso(from.getTime() / 1000), iso(to.getTime() / 1000)]).toEqual([
        '2026-05-01T22:00:00Z',
        '2026-05-02T03:00:00Z',
      ]);
      const at = events.indexOf('stats 2026-05-01T22:00:00Z');
      expect(events.slice(at, at + 2)).toEqual(['stats 2026-05-01T22:00:00Z', 'pools rA,rB']);
      expect(recomputePools.mock.calls.at(-1)?.[3]).toEqual({ signal: expect.any(AbortSignal) });
      expect(ch.dirty).toEqual([]);
    });

    it('a range of several days: each slice has its own pools', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-02T12:00:00Z')];
      slicePools.set('2026-05-01T00:00:00Z', ['rA']);
      slicePools.set('2026-05-02T00:00:00Z', ['rB']);
      await service().tick();
      expect(
        closedIn.mock.calls.map(([, , from, to]) => [iso(from.getTime() / 1000), iso(to.getTime() / 1000)]),
      ).toEqual([
        ['2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z'],
        ['2026-05-02T00:00:00Z', '2026-05-02T12:00:00Z'],
      ]);
      expect(batches()).toEqual([['rA'], ['rB']]);
      expect(ch.dirty).toEqual([]);
    });

    it('a slice with many pools is recomputed in batches', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      const many = Array.from({ length: AMM_POOLS_BATCH * 2 + 50 }, (_, i) => `r${String(i).padStart(4, '0')}`);
      slicePools.set('2026-05-01T00:00:00Z', many);
      await service().tick();
      expect(batches().map((b) => b.length)).toEqual([AMM_POOLS_BATCH, AMM_POOLS_BATCH, 50]);
      expect(batches().flat()).toEqual(many);
    });

    it('a slice without pools recomputes nothing, and the range is removed', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service().tick();
      expect(closedIn).toHaveBeenCalledTimes(1);
      expect(recomputePools).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('a pool that fails is set aside, not the slice: the others are done, the range is removed, and its retry comes later', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      slicePools.set('2026-05-01T22:00:00Z', ['rA', 'rB', 'rC']);
      failing.add('rB');
      const svc = service();
      await svc.tick();
      expect(done.sort()).toEqual(['rA', 'rC']);
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools_dirty' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('amm_pools_dirty'));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rB'));

      // the job of the live pools tries the pool again when its wait is over
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_POOL_RETRY_MS);
      await svc.tick();
      expect(done).toContain('rB');
    });

    it('a slice whose only pool fails is the failure of the slice first, and the pool is set aside when it fails again', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      slicePools.set('2026-05-01T22:00:00Z', ['rA']);
      failing.add('rA');
      const svc = service();
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);

      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('pool rA'));
    });

    it('a slice most of whose pools fail keeps the range, counts the failure, and the next tick does it again', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      slicePools.set('2026-05-01T22:00:00Z', ['rA', 'rB', 'rC', 'rD', 'rE']);
      for (const pool of ['rA', 'rB', 'rC', 'rD', 'rE']) failing.add(pool);
      const svc = service();
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools_dirty' });

      failing.clear();
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(done).toEqual(['rA', 'rB', 'rC', 'rD', 'rE']);
    });

    it('a failure in the middle of a range keeps the progress: the range is narrowed to the slice that failed', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z')];
      slicePools.set('2026-05-01T00:00:00Z', ['rA']);
      const second = ['rB1', 'rB2', 'rB3', 'rB4', 'rB5'];
      slicePools.set('2026-05-02T00:00:00Z', second);
      for (const pool of second) failing.add(pool);
      await service().tick();
      expect(ch.dirty).toEqual([mark('2026-05-02T00:00:00Z', '2026-05-03T00:00:00Z')]);
    });

    it('a lookup of the pools of a slice that fails fails the slice the same way', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      closedIn.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      await service().tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools_dirty' });
      expect(ch.dirty).toHaveLength(1);
    });

    it('does not start a batch after the shutdown began, and the range stays', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      slicePools.set(
        '2026-05-01T00:00:00Z',
        Array.from({ length: AMM_POOLS_BATCH * 2 }, (_, i) => `r${String(i).padStart(4, '0')}`),
      );
      const svc = service();
      recomputePools.mockImplementationOnce(async (_c: unknown, _r: unknown, accounts: string[]) => {
        void svc.stop(); // the shutdown begins during the first batch ...
        return accounts.length;
      });
      await svc.tick();
      expect(recomputePools).toHaveBeenCalledTimes(1); // ... and the second is not started
      expect(ch.dirty).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
    });

    it('a batch cut short by the shutdown is neither an error nor counted, and the range stays', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      slicePools.set('2026-05-01T00:00:00Z', ['rA']);
      const svc = service();
      recomputePools.mockImplementation(async () => {
        void svc.stop();
        throw new AmmPoolsRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
    });
  });

  describe('shutdown', () => {
    it('starts nothing once it has begun: no watermark, no read, no recompute', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      const svc = service();
      await svc.stop();
      await svc.tick();
      for (const fn of [watermark, changedSince, closedIn, recomputePools]) expect(fn).not.toHaveBeenCalled();
    });

    it('hands the signal of the shutdown to the batch in flight and starts no batch after it', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      pages.set(700, { accounts: ['rB'], upTo: 900 });
      let signalOfBatch: AbortSignal | undefined;
      let release!: () => void;
      recomputePools.mockImplementationOnce(
        (_c: unknown, _r: unknown, _a: string[], options?: { signal?: AbortSignal }) =>
          new Promise<number>((resolve) => {
            signalOfBatch = options?.signal;
            release = () => resolve(1);
          }),
      );
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(signalOfBatch?.aborted).toBe(false);

      const stopping = svc.stop();
      expect(signalOfBatch?.aborted).toBe(true);
      release();
      await stopping;
      expect(batches()).toEqual([['rA']]);
      expect(changedSince).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('a batch that was aborted at shutdown is neither an error nor counted', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      const svc = service();
      recomputePools.mockImplementation(async () => {
        void svc.stop();
        throw new AmmPoolsRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      pages.set(500, { accounts: ['rA'], upTo: 700 });
      const svc = service();
      recomputePools.mockImplementation(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_pools' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });
  });
});

describe('AggregatorService amm_daily job', () => {
  const RATES = { nativeCurrency: 'XRP' } as RatesService;
  const MARKETS: MarketsConfig = { version: 4, tradeMarkets: [], paymentCurrencies: [] };
  /** The first UTC day with pool activity: the back-fill starts here. */
  const FIRST_ACTIVITY = unix('2026-10-10T08:00:00Z');
  /** The first day the ingest has passed at NOW, with the day before yesterday on the clock: 2026-10-14. */
  const NEWEST_CLOSED = '2026-10-14';

  let ch: FakeClickHouse;
  let logger: ReturnType<typeof QUIET>;
  let metrics: {
    aggregatorRunsTotal: { inc: jest.Mock };
    aggregatorErrorsTotal: { inc: jest.Mock };
    aggregatorStatsLagSeconds: { set: jest.Mock };
  };
  const created: AggregatorService[] = [];
  /** What happened, in order: `amm_daily <day>`, `stats <from>`. */
  let events: string[];
  let statsRecompute: jest.Mock;
  let compute: jest.Mock;
  let daysDone: jest.Mock;
  let versions: jest.Mock;
  let firstDay: jest.Mock;
  /** How long (fake milliseconds) the set of a day takes: a closed day, and today or yesterday. */
  let closedMs: number;
  let currentMs: number;
  /** The days (`YYYY-MM-DD`) the fake fails on, while they are in the set. */
  let failing: Set<string>;
  /** The days the fake has written a final set for, and the order of its writes (a counter, as the versions of the sets). */
  let finalDays: Set<string>;
  let writes: Map<string, number>;
  let seq: number;

  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const mark = (from: string, to: string, createdMs = 1000) => ({ from: unix(from), to: unix(to), created: createdMs });
  const jobsRun = (): string[] => metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);
  const computed = (): string[] => events.filter((e) => e.startsWith('amm_daily')).map((e) => e.slice(10));
  const isClosed = (d: string): boolean => d < '2026-10-15';
  /** The newest ledger closed at half past midnight: the ingest has not passed yesterday by an hour, so its set is not final. */
  const behindYesterday = (): void => {
    ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-16T00:30:00Z')];
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    ch = new FakeClickHouse();
    logger = QUIET();
    metrics = {
      aggregatorRunsTotal: { inc: jest.fn() },
      aggregatorErrorsTotal: { inc: jest.fn() },
      aggregatorStatsLagSeconds: { set: jest.fn() },
    };
    events = [];
    closedMs = 0;
    currentMs = 0;
    failing = new Set();
    finalDays = new Set();
    writes = new Map();
    seq = 0;
    statsRecompute = jest.fn(async (_ch: unknown, from: Date) => {
      events.push(`stats ${iso(from.getTime() / 1000)}`);
      return 1;
    });
    // the fake job writes a final set when the newest ledger has passed the day by an hour, as the real one does
    compute = jest.fn(async (_ch: unknown, _rates: unknown, d: Date) => {
      const key = day(d);
      events.push(`amm_daily ${key}`);
      const ms = isClosed(key) ? closedMs : currentMs;
      if (ms > 0) jest.setSystemTime(Date.now() + ms);
      if (failing.has(key)) throw new Error(`DB::Exception: amm_daily ${key}`);
      writes.set(key, ++seq);
      const newest = ch.closes[ch.closes.length - 1];
      if (newest !== undefined && newest >= d.getTime() / 1000 + DAY + VOLUME_DAY_SETTLE_MS / 1000) finalDays.add(key);
      else finalDays.delete(key);
      return 0;
    });
    daysDone = jest.fn(async (_ch: unknown, _configVersion: number, days: Date[]) => {
      return new Set(days.map(day).filter((key) => finalDays.has(key)));
    });
    versions = jest.fn(async (_ch: unknown, from: Date, to: Date) => {
      const [a, b] = [day(from), day(to)];
      return new Map([...writes].filter(([k]) => k >= a && k <= b));
    });
    firstDay = jest.fn(async () => FIRST_ACTIVITY);
    // the stats are up to date: the live window is the last slice only
    ch.watermark = unix('2026-10-16T12:00:00Z');
    ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
  });

  afterEach(async () => {
    const stops = created.splice(0).map((svc) => svc.stop());
    await jest.advanceTimersByTimeAsync(AGGREGATOR_SHUTDOWN_WAIT_MS);
    await Promise.all(stops);
    jest.useRealTimers();
  });

  function service(options: AggregatorOptions = {}): AggregatorService {
    const svc = new AggregatorService(ch.asService(), metrics as never, { register: jest.fn() } as never, {
      logger,
      recompute: statsRecompute,
      ammDaily: { rates: RATES },
      ammDailyFunctions: { compute, daysDone, versions, firstDay },
      ...options,
    });
    created.push(svc);
    return svc;
  }

  /** Ticks `n` times, one minute apart, from NOW; the events and the metrics keep adding up. */
  async function ticks(svc: AggregatorService, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      jest.setSystemTime(NOW_SECONDS * 1000 + i * AGGREGATOR_INTERVAL_MS);
      await svc.tick();
    }
  }

  describe('the job in the tick', () => {
    it('comes after stats_dirty and before volume_backfill, with every other job registered', async () => {
      const volumeFunctions = {
        computeLiveSet: jest.fn(async () => 0),
        computeDailySet: jest.fn(async () => 0),
        daysDone: jest.fn(async () => new Set<string>()),
        liveVersions: jest.fn(async () => new Map<string, number>()),
        dailyVersions: jest.fn(async () => new Map<string, number>()),
      };
      const ammPoolsFunctions = {
        watermark: jest.fn(async () => 0),
        changedSince: jest.fn(async (_c: unknown, ledger: number) => ({ accounts: [], upTo: ledger })),
        poolsClosedIn: jest.fn(async () => []),
        recompute: jest.fn(async () => 0),
      };
      await service({
        volumes: { rates: RATES, markets: MARKETS },
        volumeFunctions,
        ammPools: { rates: RATES },
        ammPoolsFunctions,
      }).tick();
      expect(jobsRun()).toEqual([
        'volume_live',
        'volume_daily',
        'amm_pools',
        'stats_live',
        'stats_dirty',
        'amm_daily',
        'volume_backfill',
      ]);
    });

    it('is the job after the stats alone, without the volumes and the pools', async () => {
      await service().tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty', 'amm_daily']);
    });

    it('does its days after the stats of the tick: the live work comes first', async () => {
      await service().tick();
      expect(events.findIndex((e) => e.startsWith('stats'))).toBeLessThan(
        events.findIndex((e) => e.startsWith('amm_daily')),
      );
    });

    it('is off without the option: nothing is asked of the AMM functions, and a dirty range is only the stats', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service({ ammDaily: undefined }).tick();
      expect(jobsRun()).toEqual(['stats_live', 'stats_dirty']);
      for (const fn of [compute, daysDone, versions, firstDay]) expect(fn).not.toHaveBeenCalled();
      expect(ch.dirty).toEqual([]);
    });

    it('has a budget of 4 s of its own and runs every fifth tick', () => {
      expect(AGGREGATOR_AMM_DAILY_BUDGET_MS).toBe(4000);
      expect(AMM_DAILY_EVERY_TICKS).toBe(5);
      expect(AMM_DAILY_BACKFILL_RETRY_MS).toBe(5 * 60_000);
      expect(AMM_DAILY_BACKFILL_MAX_RETRY_MS).toBe(60 * 60_000);
    });

    it('the budget can be changed per job', async () => {
      closedMs = 1000;
      currentMs = 1000;
      await service({ budgetsMs: { amm_daily: 1500 } }).tick();
      // today (1 s), then yesterday starts at 1 s < 1.5 s, then nothing at 2 s but the one closed day of the floor
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14']);
    });
  });

  describe('the cadence: every fifth tick, the first one among them', () => {
    it('runs at the first tick, not at the four after it, and again at the sixth', async () => {
      const svc = service();
      await ticks(svc, 1);
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1);
      await ticks(svc, 5); // ticks 2-6 of the run
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1 + 1);
      expect(statsRecompute).toHaveBeenCalled();
    });

    it('counts a run in the metrics only when it ran, the other jobs at every tick', async () => {
      const svc = service();
      await ticks(svc, 11);
      expect(jobsRun().filter((j) => j === 'amm_daily')).toHaveLength(3); // ticks 1, 6 and 11
      expect(jobsRun().filter((j) => j === 'stats_live')).toHaveLength(11);
    });

    it('reads nothing on the ticks it skips', async () => {
      const svc = service();
      await ticks(svc, 1);
      versions.mockClear();
      firstDay.mockClear();
      daysDone.mockClear();
      compute.mockClear();
      await ticks(svc, 4);
      for (const fn of [versions, firstDay, daysDone, compute]) expect(fn).not.toHaveBeenCalled();
    });

    it('a tick skipped because the previous one was still running does not count towards the five', async () => {
      const svc = service();
      let release!: () => void;
      statsRecompute.mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(1);
          }),
      );
      const first = svc.tick();
      await jest.advanceTimersByTimeAsync(0);
      const skipped = svc.tick(); // overlaps the first: it is the first one's promise, and no run of its own
      release();
      await Promise.all([first, skipped]);
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1);
      // four more ticks are not enough for the next run, the fifth is
      await ticks(svc, 4);
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1);
      await ticks(svc, 1);
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(2);
    });

    it('the number of ticks between runs can be set', async () => {
      const svc = service({ ammDailyEveryTicks: 2 });
      await ticks(svc, 5);
      expect(jobsRun().filter((j) => j === 'amm_daily')).toHaveLength(3); // ticks 1, 3 and 5
      const every = service({ ammDailyEveryTicks: 1 });
      metrics.aggregatorRunsTotal.inc.mockClear();
      await ticks(every, 3);
      expect(jobsRun().filter((j) => j === 'amm_daily')).toHaveLength(3);
    });
  });

  describe('today and yesterday', () => {
    it('are recomputed at each run, both, as the UTC days they are (the start of the day) with the signal of the shutdown', async () => {
      await service().tick();
      const days = compute.mock.calls
        .filter(([, , d]) => !isClosed(day(d)))
        .map(([chArg, ratesArg, d, options]) => [chArg, ratesArg, d.toISOString(), options]);
      expect(days).toHaveLength(2);
      for (const [chArg, ratesArg, , options] of days) {
        expect([chArg, ratesArg]).toEqual([ch, RATES]);
        expect(options).toEqual({ signal: expect.any(AbortSignal) });
      }
      expect(days.map(([, , d]) => d).sort()).toEqual(['2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z']);
    });

    it('moves on with the UTC midnight', async () => {
      jest.setSystemTime(new Date('2026-10-17T00:00:30Z'));
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-17T00:00:20Z')];
      await service().tick();
      expect(
        computed()
          .filter((d) => d >= '2026-10-16')
          .sort(),
      ).toEqual(['2026-10-16', '2026-10-17']);
    });

    it('start with the one written longest ago, and one never written first', async () => {
      behindYesterday(); // yesterday is computed at every run until its set is final
      writes.set('2026-10-16', 5);
      writes.set('2026-10-15', 9);
      await service().tick();
      expect(computed().slice(0, 2)).toEqual(['2026-10-16', '2026-10-15']);

      events.length = 0;
      writes.set('2026-10-16', 20);
      jest.setSystemTime(NOW);
      await ticks(service(), 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);

      events.length = 0;
      writes.delete('2026-10-16');
      writes.set('2026-10-15', 1);
      await ticks(service(), 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-16', '2026-10-15']);
    });

    it('read the versions of the two days once for the run, from yesterday to today', async () => {
      await service().tick();
      expect(versions).toHaveBeenCalledTimes(1);
      const [, from, to] = versions.mock.calls[0];
      expect([day(from), day(to)]).toEqual(['2026-10-15', '2026-10-16']);
    });

    it('go in the default order when the versions cannot be read, and the failure is logged and counted', async () => {
      versions.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      await service().tick();
      expect(computed().slice(0, 2)).toEqual(['2026-10-16', '2026-10-15']);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('reading the versions'));
    });

    it('a day that fails is logged and counted once, under amm_daily; the other day still runs', async () => {
      failing.add('2026-10-16');
      await service().tick();
      expect(computed().slice(0, 2).sort()).toEqual(['2026-10-15', '2026-10-16']);
      const errors = metrics.aggregatorErrorsTotal.inc.mock.calls.filter(([labels]) => labels.job === 'amm_daily');
      expect(errors).toHaveLength(1);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('amm_daily failed in 2026-10-16'));
      expect(jobsRun()).toContain('amm_daily'); // the job itself did not fail: only its day did
    });

    it('a day that failed is tried again at the next run (five ticks later), after the day that did not fail (R87)', async () => {
      // 2026-10-16 is the stalest (never written) but failed last time: it goes behind yesterday
      behindYesterday();
      failing.add('2026-10-16');
      const svc = service();
      await ticks(svc, 1);
      events.length = 0;
      failing.clear();
      await ticks(svc, 4);
      expect(computed()).toEqual([]); // nothing in between
      await ticks(svc, 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
    });

    it('a day that works again goes back in the order of its version: nothing keeps it behind', async () => {
      behindYesterday();
      failing.add('2026-10-16');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1); // 2026-10-16 fails (never written, the stalest), 2026-10-15 is written
      failing.clear();
      events.length = 0;
      await ticks(svc, 1); // behind yesterday because of the failure; it works now
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
      // 2026-10-15 was written longer ago than 2026-10-16 now: the stalest first again
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
      writes.set('2026-10-15', 999);
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-16', '2026-10-15']);
    });

    it('the memory of a failure goes with the day: it does not grow by a key a day', async () => {
      failing.add('2026-10-15');
      const svc = service({ ammDailyEveryTicks: 1 });
      const memory = (svc as unknown as { ammDailyFailedLast: Set<string> }).ammDailyFailedLast;
      await svc.tick();
      expect([...memory]).toEqual(['2026-10-15']);
      // three days on the failed day is neither today nor yesterday
      failing.clear();
      jest.setSystemTime(new Date('2026-10-18T12:00:00Z'));
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-18T11:59:00Z')];
      await svc.tick();
      expect([...memory]).toEqual([]);
    });

    it('a failing run does not use the budget of the next: the wait of a slow failure is part of this run only', async () => {
      failing.add('2026-10-16');
      currentMs = 3000;
      await service().tick();
      // the failure took 3 s of the 4: yesterday starts at 3 s; the back-fill has no time left but for the floor's one day
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14']);
    });
  });

  describe('the back-fill of the closed days', () => {
    it('computes the closed days from the first day with pool activity to the day before yesterday, newest first', async () => {
      await service().tick();
      expect(computed().filter(isClosed)).toEqual([
        '2026-10-14',
        '2026-10-13',
        '2026-10-12',
        '2026-10-11',
        '2026-10-10',
      ]);
    });

    it('asks which of the days are done in one read, for the config version, and does not repeat a final day', async () => {
      const svc = service();
      await ticks(svc, 1);
      // the days done: yesterday (is it final?), and the closed days in one read
      expect(daysDone).toHaveBeenCalledTimes(2);
      const [chArg, configVersion, days] = daysDone.mock.calls[1];
      expect([chArg, configVersion]).toEqual([ch, AMM_DAILY_CONFIG_VERSION]);
      expect((days as Date[]).map(day)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10']);

      events.length = 0;
      await ticks(svc, 5);
      // the next run: every closed day and yesterday are done; only today
      expect(computed()).toEqual(['2026-10-16']);
    });

    it('skips the days that are done, and computes only the others', async () => {
      finalDays.add('2026-10-14');
      finalDays.add('2026-10-12');
      await service().tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-13', '2026-10-11', '2026-10-10']);
    });

    it('starts at the day of the first pool activity, not at the first ledger: the years before the AMM are not worth a set each', async () => {
      ch.closes = [unix('2015-01-01T00:00:00Z'), NOW_SECONDS - 3];
      firstDay.mockResolvedValue(unix('2026-10-12T20:00:00Z'));
      await service().tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);
    });

    it('does nothing for the closed days of a database without any pool activity, and still keeps today and yesterday', async () => {
      firstDay.mockResolvedValue(undefined);
      await service().tick();
      expect(computed().sort()).toEqual(['2026-10-15', '2026-10-16']);
      // only the read about yesterday: no closed days to ask about
      expect(daysDone).toHaveBeenCalledTimes(1);
      expect(daysDone.mock.calls[0][2]).toHaveLength(1);
    });

    it('does nothing without ledgers, and when the first activity is younger than the closed days', async () => {
      ch.closes = [];
      await service().tick();
      expect(computed().filter(isClosed)).toEqual([]);
      firstDay.mockResolvedValue(unix('2026-10-15T08:00:00Z'));
      ch.closes = [unix('2026-10-10T08:00:00Z'), NOW_SECONDS - 3];
      events.length = 0;
      await ticks(service(), 1);
      expect(computed().filter(isClosed)).toEqual([]);
    });

    it('works under the budget of the job, and goes on where it stopped at the next run', async () => {
      closedMs = 1000;
      currentMs = 1000;
      const svc = service();
      await ticks(svc, 1);
      // today 0-1 s, yesterday 1-2 s, then 2026-10-14 at 2 s and 2026-10-13 at 3 s; at 4 s the budget is spent
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13']);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_daily reached its budget'));

      events.length = 0;
      await ticks(svc, 5);
      // the next run: today again (yesterday is final), and the days after the ones that are done: with yesterday left
      // out there is time for three, at 1 s, 2 s and 3 s
      expect(computed().filter((d) => !isClosed(d))).toEqual(['2026-10-16']);
      expect(computed().filter(isClosed)).toEqual(['2026-10-12', '2026-10-11', '2026-10-10']);
    });

    it('never takes the tick from the live work: whatever it has left to do, the tick ends within its budget', async () => {
      closedMs = 3000;
      currentMs = 3000;
      const svc = service();
      const start = Date.now();
      await ticks(svc, 1);
      // 4 s of budget and sets of 3 s: today (3 s), yesterday (starts at 3 s, ends at 6 s), and then the one closed day of the
      // floor (to 9 s) and no more: a run is its budget plus the set in flight plus the one the floor allows
      expect(Date.now() - start).toBeLessThanOrEqual(AGGREGATOR_AMM_DAILY_BUDGET_MS + 3000 + 3000);
      expect(computed().filter(isClosed)).toEqual(['2026-10-14']);
    });

    it('says when it starts, and when it is done: in the run that finishes the last day', async () => {
      closedMs = 1000;
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      // 5 closed days, 1 s each, 4 s of budget (today and yesterday are free here): four days now, one to go
      expect(logger.log).toHaveBeenCalledWith('AMM daily back-fill: 5 days to compute, newest day first');
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill is done'));
      expect(computed().filter(isClosed)).toHaveLength(4);
      logger.log.mockClear();
      await ticks(svc, 1); // the next run does the last day, and says it is done
      expect(computed().filter(isClosed)).toHaveLength(5);
      expect(logger.log).toHaveBeenCalledWith('AMM daily back-fill is done: every closed day has its set');
      logger.log.mockClear();
      await ticks(svc, 2);
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill'));
    });

    it('says it is done when the days that were left have been done meanwhile (the hook of agg_dirty, another run)', async () => {
      closedMs = 1000;
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1); // four of the five closed days
      logger.log.mockClear();
      finalDays.add('2026-10-10'); // the last one is done by something else
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().filter(isClosed)).toEqual([]); // nothing is left to compute
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('AMM daily back-fill is done'));
    });

    it('does not say it is done while a day waits for its retry, and says it when that day works', async () => {
      failing.add('2026-10-12');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('AMM daily back-fill: 5 days to compute'));
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill is done')); // a day failed
      logger.log.mockClear();
      await ticks(svc, 1); // the failed day is waiting: the others are done, and it is not
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill is done'));
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('AMM daily back-fill is done'));
    });

    it('reads which days are wanted although the budget is spent, and starts the one closed day of the floor', async () => {
      currentMs = 5000;
      await service().tick();
      expect(daysDone).toHaveBeenCalledTimes(2); // yesterday, and the closed days
      expect(computed()).toEqual(['2026-10-16', '2026-10-14']);
    });

    it('does the same when today and yesterday used the budget up exactly', async () => {
      currentMs = 2000;
      await service({ budgetsMs: { amm_daily: 4000 } }).tick();
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14']);
    });

    it('starts no day after the shutdown began', async () => {
      const svc = service();
      compute.mockImplementation(async (_c: unknown, _r: unknown, d: Date) => {
        events.push(`amm_daily ${day(d)}`);
        if (day(d) === '2026-10-14') void svc.stop();
        return 0;
      });
      await svc.tick();
      expect(computed()).toEqual(['2026-10-16', '2026-10-15', '2026-10-14']);
    });
  });

  describe('a closed day is final once the ingest has passed it (Ruling R86)', () => {
    it('is back-filled only when the newest ingested ledger closed an hour after the end of the day, whatever the clock says', async () => {
      // an outage: the ingest is on 2026-10-14 at half past midnight, and the clock is two days on
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-14T00:30:00Z')];
      await service().tick();
      // the day of the newest ledger less the hour is 2026-10-13: the days before it are closed
      expect(computed().filter(isClosed)).toEqual(['2026-10-12', '2026-10-11', '2026-10-10']);
    });

    it('the end of the day plus the settle time, to the second', async () => {
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-14T01:00:00Z') - 1];
      await service().tick();
      expect(computed().filter(isClosed)[0]).toBe('2026-10-12');

      events.length = 0;
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-14T01:00:00Z')];
      await ticks(service(), 1);
      expect(computed().filter(isClosed)[0]).toBe('2026-10-13');
    });

    it('a day computed before the ingest had passed it is computed again once it has', async () => {
      // today the ingest is a bit behind: the set for 2026-10-14 would not be final (the fake job knows the rule too)
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-15T00:30:00Z')];
      const svc = service();
      await ticks(svc, 1);
      expect(finalDays.has('2026-10-14')).toBe(false); // the fake wrote it in the today/yesterday pass or not at all
      expect(computed()).not.toContain(NEWEST_CLOSED); // it was not back-filled: the ingest has not passed it
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-15T01:00:00Z')];
      events.length = 0;
      await ticks(svc, 5);
      expect(computed()).toContain(NEWEST_CLOSED);
      expect(finalDays.has(NEWEST_CLOSED)).toBe(true);
    });

    it('yesterday is never a closed day, however far the ingest is past it', async () => {
      await service().tick();
      expect(computed().filter(isClosed)).not.toContain('2026-10-15');
      expect(daysDone.mock.calls[1][2].map(day)).not.toContain('2026-10-15'); // the read of the closed days (the first is yesterday's)
    });

    it('an ingest that started at an old ledger leaves no closed day to back-fill beyond its newest ledger', async () => {
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-10T09:00:00Z')];
      await service().tick();
      expect(computed().filter(isClosed)).toEqual([]);
    });
  });

  describe('a closed day that fails every time does not hold the back-fill up', () => {
    it('is skipped while it waits, so the older days go on; then it is tried again', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      const start = NOW_SECONDS * 1000;
      const closedOf = async (offsetMs: number): Promise<string[]> => {
        jest.setSystemTime(start + offsetMs);
        events.length = 0;
        await svc.tick();
        return computed().filter(isClosed);
      };
      expect(await closedOf(0)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10']);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);

      // within the wait the day is left alone and nothing else is missing
      expect(await closedOf(AMM_DAILY_BACKFILL_RETRY_MS - 1000)).toEqual([]);
      // after it the day is tried again (and works now)
      failing.clear();
      expect(await closedOf(AMM_DAILY_BACKFILL_RETRY_MS)).toEqual(['2026-10-14']);
      expect(await closedOf(AMM_DAILY_BACKFILL_RETRY_MS + 60_000)).toEqual([]);
    });

    it('the wait doubles at every failure, up to an hour', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      let now = NOW_SECONDS * 1000;
      const attempts = async (at: number): Promise<number> => {
        jest.setSystemTime(at);
        events.length = 0;
        await svc.tick();
        return computed().filter((d) => d === '2026-10-14').length;
      };
      const minute = 60_000;
      for (const wait of [5, 10, 20, 40, 60, 60, 60]) {
        expect(await attempts(now)).toBe(1); // fails, and waits
        expect(await attempts(now + wait * minute - 1000)).toBe(0);
        now += wait * minute;
      }
      expect(AMM_DAILY_BACKFILL_RETRY_MS * 2 ** 4).toBeGreaterThan(AMM_DAILY_BACKFILL_MAX_RETRY_MS);
    });

    it('a day that works after a failure forgets it: if it fails again later, the wait starts at five minutes again', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      const start = NOW_SECONDS * 1000;
      const triedAt = async (offsetMs: number): Promise<boolean> => {
        jest.setSystemTime(start + offsetMs);
        events.length = 0;
        await svc.tick();
        return computed().includes('2026-10-14');
      };
      expect(await triedAt(0)).toBe(true); // fails: waits 5 minutes
      failing.clear();
      expect(await triedAt(AMM_DAILY_BACKFILL_RETRY_MS)).toBe(true); // works
      expect(finalDays.has('2026-10-14')).toBe(true);
      expect(await triedAt(AMM_DAILY_BACKFILL_RETRY_MS + 60_000)).toBe(false); // done: nothing to do
      // the day is wanted again (a new computation), and fails again: the wait is the first one, not the second
      finalDays.delete('2026-10-14');
      failing.add('2026-10-14');
      const again = AMM_DAILY_BACKFILL_RETRY_MS + 2 * 60_000;
      expect(await triedAt(again)).toBe(true); // fails
      expect(await triedAt(again + AMM_DAILY_BACKFILL_RETRY_MS - 1000)).toBe(false);
      expect(await triedAt(again + AMM_DAILY_BACKFILL_RETRY_MS)).toBe(true);
    });

    it('gives up after three days failed in a run, so that an outage does not log a line per day', async () => {
      for (const d of ['2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10']) failing.add(d);
      await service().tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(3);
    });

    it('does not wait on a day that failed because of the shutdown', async () => {
      const svc = service({ ammDailyEveryTicks: 1 });
      compute.mockImplementation(async (_c: unknown, _r: unknown, d: Date) => {
        events.push(`amm_daily ${day(d)}`);
        if (day(d) === '2026-10-14') {
          void svc.stop();
          throw new AmmDailyRecomputeAborted();
        }
        return 0;
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      // and no wait is set for the day: a process that stops is not a day that failed
      expect((svc as unknown as { ammDailyBackoff: Map<string, unknown> }).ammDailyBackoff.size).toBe(0);
    });
  });

  describe('the days of agg_dirty ranges (the hook of stats_dirty)', () => {
    it('recomputes the day of a slice, after its stats, and removes the range', async () => {
      ch.dirty = [mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z')];
      await service().tick();
      const at = events.indexOf('stats 2026-05-01T22:00:00Z');
      expect(events.slice(at, at + 2)).toEqual(['stats 2026-05-01T22:00:00Z', 'amm_daily 2026-05-01']);
      // the first slice of the range is the day it starts in, the second the next one
      const dirtyDays = computed().filter((d) => d.startsWith('2026-05'));
      expect(dirtyDays).toEqual(['2026-05-01', '2026-05-02']);
      expect(ch.dirty).toEqual([]);
    });

    it('hands the shutdown signal to every day, like the other jobs', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service().tick();
      const call = compute.mock.calls.find(([, , d]) => day(d) === '2026-05-01');
      expect(call?.[1]).toBe(RATES);
      expect(call?.[3]).toEqual({ signal: expect.any(AbortSignal) });
    });

    it('a range of several days: each slice recomputes its own day, a day cut by two slices once more than needed is fine', async () => {
      ch.dirty = [mark('2026-05-01T12:00:00Z', '2026-05-03T06:00:00Z')];
      await service().tick();
      expect(computed().filter((d) => d.startsWith('2026-05'))).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
      expect(ch.dirty).toEqual([]);
    });

    it('computes a day once for the ranges of one tick, unless the ingest marked it again after that', async () => {
      ch.dirty = [
        mark('2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z', 1000),
        mark('2026-05-01T08:00:00Z', '2026-05-01T09:00:00Z', 1000),
      ];
      await service().tick();
      expect(computed().filter((d) => d === '2026-05-01')).toHaveLength(1);

      events.length = 0;
      ch.dirty = [
        mark('2026-05-02T00:00:00Z', '2026-05-02T05:00:00Z', 1000),
        // marked again after the tick has begun: the day is done again
        mark('2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', Date.now() + 10_000),
      ];
      await ticks(service(), 1);
      expect(computed().filter((d) => d === '2026-05-02')).toHaveLength(2);
    });

    it('a day that fails is counted under amm_daily_dirty and does not keep the range: it is owed to the retries of amm_daily', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z')];
      failing.add('2026-05-01');
      const svc = service({ ammDailyEveryTicks: 1 });
      await svc.tick();
      expect(ch.dirty).toEqual([]);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledTimes(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily_dirty' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('amm_daily_dirty'));

      // the job tries it again when its five minutes are over
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      events.length = 0;
      await svc.tick();
      expect(computed()).toContain('2026-05-01');
    });

    it('does not touch the days without the option', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      await service({ ammDaily: undefined }).tick();
      expect(compute).not.toHaveBeenCalled();
    });

    it('a day cut short by the shutdown is neither an error nor counted, and the range stays', async () => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-01T03:00:00Z')];
      const svc = service();
      compute.mockImplementation(async () => {
        void svc.stop();
        throw new AmmDailyRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(ch.dirty).toHaveLength(1);
    });

    it('starts no day once the shutdown began', async () => {
      // a slice from 22:00 to 03:00 covers two UTC days; the range after it is a third day
      ch.dirty = [
        mark('2026-05-01T22:00:00Z', '2026-05-02T03:00:00Z'),
        mark('2026-05-04T00:00:00Z', '2026-05-04T03:00:00Z', 2000),
      ];
      const svc = service();
      compute.mockImplementationOnce(async () => {
        void svc.stop();
        return 0;
      });
      await svc.tick();
      expect(compute).toHaveBeenCalledTimes(1);
      expect(ch.dirty).toHaveLength(2);
    });

    it('a mark that arrives while a day is being computed makes it be computed again', async () => {
      closedMs = 1000; // the day takes a second
      const begins = NOW_SECONDS * 1000;
      ch.dirty = [
        mark('2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z', 500),
        // marked half a second into it
        mark('2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z', begins + 500),
      ];
      await service().tick();
      expect(computed().filter((d) => d === '2026-05-01')).toHaveLength(2);
    });

    it('a mark made at the very ms the day began does not: the recompute saw it', async () => {
      closedMs = 1000;
      const begins = NOW_SECONDS * 1000;
      ch.dirty = [
        mark('2026-05-01T00:00:00Z', '2026-05-01T05:00:00Z', 500),
        mark('2026-05-01T10:00:00Z', '2026-05-01T11:00:00Z', begins),
      ];
      await service().tick();
      expect(computed().filter((d) => d === '2026-05-01')).toHaveLength(1);
    });
  });

  describe('the cadence is a whole number of ticks (at registration)', () => {
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses ammDailyEveryTicks = %p', (every) => {
      expect(() => service({ ammDailyEveryTicks: every })).toThrow(/every.*tick|ticks/i);
    });

    it('refuses an extra job that wants to run every 0 ticks, however it is written', () => {
      const job: AggregatorJob = { name: 'never', everyTicks: 0, run: async () => undefined };
      expect(() => service({ ammDaily: undefined, extraJobs: [job] })).toThrow(/never/);
    });

    it('accepts 1 and the default', () => {
      expect(() => service({ ammDailyEveryTicks: 1 })).not.toThrow();
      expect(() => service()).not.toThrow();
    });
  });

  describe('yesterday is not computed again once its set is final (Ruling R-A21); today is, at every run', () => {
    const behind = behindYesterday;

    it('computes both at the first run, and only today at the next ones', async () => {
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect(
        computed()
          .filter((d) => !isClosed(d))
          .sort(),
      ).toEqual(['2026-10-15', '2026-10-16']);
      events.length = 0;
      await ticks(svc, 3);
      expect(computed().filter((d) => !isClosed(d))).toEqual(['2026-10-16', '2026-10-16', '2026-10-16']);
    });

    it('asks which of the two is done in one read, for yesterday and the config version of the job', async () => {
      await service().tick();
      const [chArg, configVersion, days] = daysDone.mock.calls[0];
      expect([chArg, configVersion, (days as Date[]).map(day)]).toEqual([ch, AMM_DAILY_CONFIG_VERSION, ['2026-10-15']]);
    });

    it('computes it at every run while its set is not final (the ingest has not passed the day, or the set is of another config)', async () => {
      behind();
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 3);
      expect(computed().filter((d) => d === '2026-10-15')).toHaveLength(3);
    });

    it('computes it again once the ingest has passed the day by an hour, and then leaves it', async () => {
      behind();
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 2);
      ch.closes = [unix('2026-10-10T08:00:00Z'), unix('2026-10-16T01:00:00Z')];
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().filter((d) => d === '2026-10-15')).toHaveLength(1); // the last time, now final
      events.length = 0;
      await ticks(svc, 2);
      expect(computed().filter((d) => d === '2026-10-15')).toHaveLength(0);
    });

    it('a read of the days done that fails is logged and counted, and yesterday is computed', async () => {
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      daysDone.mockRejectedValueOnce(new Error('DB::Exception: timeout'));
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().filter((d) => d === '2026-10-15')).toHaveLength(1);
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('days done'));
    });

    it('a day that failed last time is still tried behind the other when both are due (R87)', async () => {
      behind();
      failing.add('2026-10-16');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      events.length = 0;
      failing.clear();
      await ticks(svc, 1);
      expect(computed().slice(0, 2)).toEqual(['2026-10-15', '2026-10-16']);
    });
  });

  describe('a run whose current days used the budget still moves the back-fill on (the progress floor)', () => {
    it('starts one closed day, the newest, at each run, and goes on at the next runs', async () => {
      currentMs = 5000; // today takes more than the 4 s of the job
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 3);
      expect(computed().filter(isClosed)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);
    });

    it('says what is wanted, although the budget is spent: the log is the days to compute', async () => {
      currentMs = 5000;
      await service().tick();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('AMM daily back-fill: 5 days to compute'));
    });

    it('goes through the budget check of the job after that day: said once, and the job counts as having hit its budget', async () => {
      currentMs = 5000;
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('amm_daily reached its budget'));
      expect(computed().filter(isClosed)).toEqual(['2026-10-14']); // only the one the floor allows
      logger.warn.mockClear();
      await ticks(svc, 1); // a streak of runs that hit the budget is said once
      expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('amm_daily reached its budget'));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('amm_daily reached its budget'));
    });

    it('adds nothing when nothing is wanted: no activity, or every closed day done', async () => {
      currentMs = 5000;
      firstDay.mockResolvedValue(undefined);
      await service().tick();
      expect(computed().filter(isClosed)).toEqual([]);
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill'));

      events.length = 0;
      firstDay.mockResolvedValue(FIRST_ACTIVITY);
      for (const d of ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']) finalDays.add(d);
      await ticks(service(), 1);
      expect(computed().filter(isClosed)).toEqual([]);
    });

    it('a day that waits for its retry is not the one the floor starts: the next wanted day is', async () => {
      failing.add('2026-10-14');
      closedMs = 1500; // 10-14 fails, 10-13 and 10-12 work, and the budget is gone: 10-11 and 10-10 are left
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect(computed().filter(isClosed)).toEqual(['2026-10-14', '2026-10-13', '2026-10-12']);
      currentMs = 5000;
      closedMs = 0;
      events.length = 0;
      await ticks(svc, 1);
      expect(computed().filter(isClosed)).toEqual(['2026-10-11']); // 10-14 waits; the floor takes the next wanted day
    });
  });

  describe('a day that fails on the dirty path does not hold its range (Ruling R-A22)', () => {
    const MIDDLE = '2026-05-02';
    const volumeFunctions = () => ({
      computeLiveSet: jest.fn(async () => 0),
      computeDailySet: jest.fn(async (_c: unknown, _r: unknown, _m: unknown, metric: string, d: Date) => {
        events.push(`volume ${metric} ${day(d)}`);
        return 0;
      }),
      daysDone: jest.fn(async () => new Set<string>()),
      liveVersions: jest.fn(async () => new Map<string, number>()),
      dailyVersions: jest.fn(async () => new Map<string, number>()),
    });
    const poolFunctions = () => ({
      watermark: jest.fn(async () => 0),
      changedSince: jest.fn(async (_c: unknown, ledger: number) => ({ accounts: [], upTo: ledger })),
      poolsClosedIn: jest.fn(async () => ['rA']),
      recompute: jest.fn(async () => {
        events.push('pools rA');
        return 1;
      }),
    });
    const withEverything = (extra: AggregatorOptions = {}): AggregatorOptions => ({
      volumes: { rates: RATES, markets: MARKETS },
      volumeFunctions: volumeFunctions(),
      ammPools: { rates: RATES },
      ammPoolsFunctions: poolFunctions(),
      ...extra,
    });
    const range = (): void => {
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-04T00:00:00Z')];
    };

    it('counts it once, goes on with the later slices (stats, volumes, pools, days), and the range is done', async () => {
      range();
      failing.add(MIDDLE);
      await service(withEverything()).tick();
      for (const d of ['2026-05-01', '2026-05-02', '2026-05-03']) {
        // every slice, in order: its stats, its volumes (two metrics), its pools, its day
        const at = events.indexOf(`stats ${d}T00:00:00Z`);
        expect(at).toBeGreaterThan(-1);
        expect(events.slice(at, at + 5)).toEqual([
          `stats ${d}T00:00:00Z`,
          `volume trade_volume ${d}`,
          `volume payment_volume ${d}`,
          'pools rA',
          `amm_daily ${d}`,
        ]);
      }
      expect(ch.dirty).toEqual([]);
      const errors = metrics.aggregatorErrorsTotal.inc.mock.calls.map(([labels]) => labels.job);
      expect(errors).toEqual(['amm_daily_dirty']);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`amm_daily_dirty failed for ${MIDDLE}`));
    });

    it('does not do the stats of the slice again at the next tick: the range is gone', async () => {
      range();
      failing.add(MIDDLE);
      const svc = service({ ammDailyEveryTicks: 1000 });
      await svc.tick();
      events.length = 0;
      await svc.tick();
      expect(events.filter((e) => e.startsWith('stats 2026-05'))).toEqual([]);
    });

    it('a day that fails in two ranges of one tick is tried once', async () => {
      ch.dirty = [
        mark('2026-05-02T00:00:00Z', '2026-05-02T05:00:00Z', 1000),
        mark('2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', 1001),
      ];
      failing.add(MIDDLE);
      await service({ ammDailyEveryTicks: 1000 }).tick();
      expect(computed().filter((d) => d === MIDDLE)).toHaveLength(1);
      expect(ch.dirty).toEqual([]);
    });

    describe('and is tried again by the amm_daily job, on the back-off of the closed days', () => {
      const run = async (svc: AggregatorService, offsetMs: number): Promise<string[]> => {
        jest.setSystemTime(NOW_SECONDS * 1000 + offsetMs);
        events.length = 0;
        await svc.tick();
        return computed().filter((d) => d === MIDDLE);
      };

      it('after 5 minutes, then 10, 20, ... up to an hour, until it works', async () => {
        range();
        failing.add(MIDDLE);
        const svc = service({ ammDailyEveryTicks: 1 });
        expect(await run(svc, 0)).toHaveLength(1); // the dirty path
        const minute = 60_000;
        let at = 0;
        for (const wait of [5, 10, 20, 40, 60, 60]) {
          expect(await run(svc, at + wait * minute - 1000)).toEqual([]); // not due
          at += wait * minute;
          expect(await run(svc, at)).toHaveLength(1); // due, and fails again
        }
        failing.clear();
        at += 60 * minute;
        expect(await run(svc, at)).toHaveLength(1);
        expect(await run(svc, at + 61 * minute)).toEqual([]); // it worked: forgotten
        expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
      });

      it('and forgets it when the day is computed some other way before', async () => {
        range();
        failing.add(MIDDLE);
        const svc = service({ ammDailyEveryTicks: 1 });
        await run(svc, 0);
        failing.clear();
        // the ingest marks the day again: the dirty path computes it, and it works
        ch.dirty = [mark('2026-05-02T00:00:00Z', '2026-05-02T05:00:00Z', NOW_SECONDS * 1000 + 100_000)];
        expect(await run(svc, 120_000)).toHaveLength(1);
        expect(await run(svc, 6 * 60_000)).toEqual([]); // past the five minutes: nothing is owed any more
      });

      it('the one that has failed fewer times first (R87), whichever is due longer', async () => {
        const minute = 60_000;
        const svc = service({ ammDailyEveryTicks: 1 });
        failing.add('2026-05-01');
        failing.add('2026-05-02');
        // 05-01 fails on the dirty path at 0, and again at 5 minutes (a wait of 10: due at 15)
        ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')];
        await run(svc, 0);
        await run(svc, 5 * minute);
        // 05-02 fails on the dirty path at 12 minutes (a wait of 5: due at 17)
        ch.dirty = [mark('2026-05-02T00:00:00Z', '2026-05-03T00:00:00Z', NOW_SECONDS * 1000 + 12 * minute - 1000)];
        await run(svc, 12 * minute);
        // at 18 both are due; 05-01 has been due longer, but it has failed twice
        events.length = 0;
        jest.setSystemTime(NOW_SECONDS * 1000 + 18 * minute);
        await svc.tick();
        expect(computed().filter((d) => d.startsWith('2026-05'))).toEqual(['2026-05-02', '2026-05-01']);
      });

      it('one day per budget: a day that takes the whole budget leaves the next to the next run', async () => {
        ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-03T00:00:00Z')];
        failing.add('2026-05-01');
        failing.add('2026-05-02');
        const svc = service({ ammDailyEveryTicks: 1, budgetsMs: { amm_daily: 1000 } });
        await run(svc, 0);
        failing.clear();
        closedMs = 1500;
        events.length = 0;
        jest.setSystemTime(NOW_SECONDS * 1000 + 6 * 60_000);
        await svc.tick();
        expect(computed().filter((d) => d.startsWith('2026-05'))).toHaveLength(1);
      });
    });

    it('a closed day that is owed is not taken by the back-fill as well: the retries of the job have it', async () => {
      ch.dirty = [mark('2026-10-12T00:00:00Z', '2026-10-12T05:00:00Z')];
      failing.add('2026-10-12'); // it fails on the dirty path, and is not final: the back-fill wants it too
      const svc = service({ ammDailyEveryTicks: 1 });
      await svc.tick();
      expect(computed().filter((d) => d === '2026-10-12')).toHaveLength(1); // the dirty path only
      expect(computed().filter(isClosed).sort()).toEqual([
        '2026-10-10',
        '2026-10-11',
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
      ]);
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringContaining('back-fill is done')); // a day is owed
      // when its wait is over it is the retries that try it
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      events.length = 0;
      await svc.tick();
      expect(computed().filter((d) => d === '2026-10-12')).toHaveLength(1);
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('back-fill is done'));
    });

    it('an owed day that the job computes with the current days is forgotten, and not tried a second time in that run', async () => {
      ch.dirty = [mark('2026-10-16T00:00:00Z', '2026-10-16T05:00:00Z')];
      failing.add('2026-10-16'); // today fails on the dirty path, and then in the loop of the job
      const svc = service({ ammDailyEveryTicks: 1 });
      const memory = (svc as unknown as { ammDailyBackoff: Map<string, unknown> }).ammDailyBackoff;
      await svc.tick();
      expect([...memory.keys()]).toEqual(['2026-10-16']);
      // its five minutes are over, and it still fails: the loop of the job tries it, and the retries do not try it again
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(computed().filter((d) => d === '2026-10-16')).toHaveLength(1);
      // it works: the loop forgets it
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS + 1000);
      await svc.tick();
      expect(memory.size).toBe(0);
    });

    it('a day that fails on the dirty path again while it waits waits twice as long (the wait is not set afresh)', async () => {
      const minute = 60_000;
      failing.add('2026-05-01');
      const svc = service({ ammDailyEveryTicks: 1 });
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')];
      await svc.tick(); // fails: due in 5 minutes
      // marked again a minute later, and fails again: due in 10 more minutes (at 11), not in 5 (at 6)
      ch.dirty = [mark('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z', NOW_SECONDS * 1000 + minute - 100)];
      jest.setSystemTime(NOW_SECONDS * 1000 + minute);
      await svc.tick();
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + 7 * minute);
      await svc.tick();
      expect(computed().filter((d) => d === '2026-05-01')).toEqual([]);
      jest.setSystemTime(NOW_SECONDS * 1000 + 11 * minute);
      await svc.tick();
      expect(computed().filter((d) => d === '2026-05-01')).toHaveLength(1);
    });

    it('when the budget is spent, the floor of the run takes a due owed day, and that is the only day of the floor (Ruling R-A23)', async () => {
      ch.dirty = [mark('2026-10-12T00:00:00Z', '2026-10-12T05:00:00Z')];
      failing.add('2026-10-12'); // owed
      const svc = service({ ammDailyEveryTicks: 1 });
      await svc.tick();
      // the closed days after it are wanted again, and the owed day is due, with the budget gone
      for (const d of ['2026-10-14', '2026-10-13']) finalDays.delete(d);
      failing.clear();
      currentMs = 5000;
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-12']); // not 2026-10-14 as well
      // the next run has no owed day: the floor takes the newest wanted closed day
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS + 60_000);
      await svc.tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-14']);
    });

    it('an owed day that is due and the budget not spent: it is tried with the others, and the back-fill has no floor of its own', async () => {
      ch.dirty = [mark('2026-10-12T00:00:00Z', '2026-10-12T05:00:00Z')];
      failing.add('2026-10-12');
      const svc = service({ ammDailyEveryTicks: 1, budgetsMs: { amm_daily: 1500 } });
      await svc.tick();
      for (const d of ['2026-10-14', '2026-10-13']) finalDays.delete(d);
      failing.clear();
      currentMs = 1000; // today takes 1 s of the 1.5 s: the owed day starts within the budget, takes 1 s, and the budget is spent
      closedMs = 1000;
      events.length = 0;
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(computed().filter(isClosed)).toEqual(['2026-10-12']);
    });

    it('a day cut short by the shutdown is not owed: it stays in its range as before', async () => {
      range();
      const svc = service({ ammDailyEveryTicks: 1 });
      compute.mockImplementation(async () => {
        void svc.stop();
        throw new AmmDailyRecomputeAborted();
      });
      await svc.tick();
      expect(ch.dirty).toHaveLength(1);
      expect((svc as unknown as { ammDailyBackoff: Map<string, unknown> }).ammDailyBackoff.size).toBe(0);
    });
  });

  describe('the back-off of a closed day (as the volume back-fill)', () => {
    const backoffOf = (svc: AggregatorService): Map<string, unknown> =>
      (svc as unknown as { ammDailyBackoff: Map<string, unknown> }).ammDailyBackoff;

    it('is forgotten when the day is no longer wanted (something else made its set final)', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect([...backoffOf(svc).keys()]).toEqual(['2026-10-14']);
      failing.clear();
      finalDays.add('2026-10-14'); // another process, or the retries of a dirty range, did it
      await ticks(svc, 1);
      expect(backoffOf(svc).size).toBe(0);
    });

    it('is forgotten as soon as the day works, not at the run after', async () => {
      failing.add('2026-10-14');
      const svc = service({ ammDailyEveryTicks: 1 });
      await ticks(svc, 1);
      expect([...backoffOf(svc).keys()]).toEqual(['2026-10-14']);
      failing.clear();
      jest.setSystemTime(NOW_SECONDS * 1000 + AMM_DAILY_BACKFILL_RETRY_MS);
      await svc.tick();
      expect(computed()).toContain('2026-10-14');
      expect(backoffOf(svc).size).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('starts nothing once it has begun', async () => {
      const svc = service();
      await svc.stop();
      await svc.tick();
      for (const fn of [compute, daysDone, versions, firstDay]) expect(fn).not.toHaveBeenCalled();
    });

    it('hands the signal of the shutdown to the day in flight and starts no day after it', async () => {
      let signalOfDay: AbortSignal | undefined;
      let release!: () => void;
      compute.mockImplementationOnce(
        (_c: unknown, _r: unknown, _d: Date, options?: { signal?: AbortSignal }) =>
          new Promise<number>((resolve) => {
            signalOfDay = options?.signal;
            release = () => resolve(0);
          }),
      );
      const svc = service();
      svc.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(0);
      expect(signalOfDay?.aborted).toBe(false);

      const stopping = svc.stop();
      expect(signalOfDay?.aborted).toBe(true);
      release();
      await stopping;
      expect(compute).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('a day that was aborted at shutdown is neither an error nor counted', async () => {
      const svc = service();
      compute.mockImplementation(async () => {
        void svc.stop();
        throw new AmmDailyRecomputeAborted();
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('shutdown'));
    });

    it('a real failure while the shutdown is under way is still an error', async () => {
      const svc = service();
      compute.mockImplementation(async () => {
        void svc.stop();
        throw new Error('DB::Exception: table is read-only');
      });
      await svc.tick();
      expect(metrics.aggregatorErrorsTotal.inc).toHaveBeenCalledWith({ job: 'amm_daily' });
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('read-only'));
    });
  });
});
