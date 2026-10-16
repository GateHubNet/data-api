import {
  ClickHouseService,
  MarketsConfig,
  RatesService,
  StatsRecomputeAborted,
  Table,
  VOLUME_DAY_SETTLE_MS,
  VolumeRecomputeAborted,
} from '@gatehub/data-api-shared';
import {
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
        if (failing.has(`${metric}/${period}`)) throw new Error(`DB::Exception: ${metric} ${period}`);
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
      logger.log.mockClear();
      for (let i = 0; i < 20 && !logger.log.mock.calls.some(([m]) => /back-fill is done/i.test(String(m))); i++) {
        jest.setSystemTime(NOW_MS + (i + 1) * 60_000);
        await svc.tick();
      }
      expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/back-fill is done/i));
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

    it('live: a set that failed has the old version still, so it is the first to be tried again', async () => {
      caughtUp();
      liveMs = 3000;
      failing.add('trade_volume/hour');
      const svc = service();
      await svc.tick();
      expect(seq(liveCalls)).toEqual(['trade hour', 'trade day', 'trade 3day']);
      liveCalls.length = 0;
      jest.setSystemTime(NOW_MS + 60_000);
      await svc.tick();
      expect(seq(liveCalls)[0]).toBe('trade hour');
      // and once it works it goes to the back of the line
      failing.clear();
      liveCalls.length = 0;
      jest.setSystemTime(NOW_MS + 120_000);
      await svc.tick();
      expect(seq(liveCalls)[0]).toBe('trade hour');
      liveCalls.length = 0;
      jest.setSystemTime(NOW_MS + 180_000);
      await svc.tick();
      expect(seq(liveCalls)).not.toContain('trade hour');
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

    it('a long stats sweep and a dirty backlog cannot starve the live volumes: they are refreshed first, at every tick', async () => {
      // 60 days of stats to catch up, 4 s a slice; 30 dirty ranges of a day, 4 s a slice; 300 closed days of volumes to
      // back-fill, 3 s a set
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
      const svc = service();

      const startedAt: number[] = [];
      for (let tickNo = 0; tickNo < 3; tickNo++) {
        const tickStart = NOW_MS + tickNo * 60_000;
        jest.setSystemTime(tickStart);
        startedAt.push(tickStart);
        events.length = 0;
        liveCalls.length = 0;
        await svc.tick();
        // the seven live sets ran at the very start of the tick, before any stats slice, whatever followed
        expect(liveCalls).toHaveLength(7);
        expect(liveCalls.every((c) => c.at === tickStart)).toBe(true);
        expect(events.slice(0, 7).every((e) => e.startsWith('live'))).toBe(true);
        // and the four daily sets of today and yesterday, so the first stats slice comes after eleven volume sets
        expect(events.findIndex((e) => e.startsWith('stats'))).toBeGreaterThanOrEqual(11);
        // and the tick is over within its budget plus the slice in flight
        expect(Date.now() - tickStart).toBeLessThanOrEqual(AGGREGATOR_TICK_BUDGET_MS + 4000);
        // the stats sweep is far from done: the sweep and the backlog are what ran long
        expect(ch.dirty.length).toBeGreaterThan(0);
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
