import {
  ClickHouseService,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  normalizeLedgerResponse,
  parseContextFor,
  RawLedger,
  recomputeStatsHourly,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { deleteDirtyRange, narrowDirtyRange, readDirtyRanges } from '../src/aggregator/agg-dirty';
import { AggregatorService } from '../src/aggregator/aggregator.service';
import { syntheticChain } from './synthetic-chain';

/**
 * The `AggregatorService` against a real ClickHouse, seeded with the 54 mock ledgers of the original Ripple test suite
 * (10 hours between 2013 and 2017; 41 ledgers close on 2015-01-14 between 17:29 and 19:10 UTC): the SQL of the live
 * window and of the `agg_dirty` queue, the lightweight DELETE and its guard, and the narrowing of a range across ticks.
 */

const ctx = parseContextFor(getNetworkProfile('xrpl'));
const ledgers = FixtureLedgerSource.fromDir(
  join(__dirname, '../../../packages/shared/test/fixtures/xrpl/ripple-mock'),
).list();

const unix = (text: string): number => Date.parse(text) / 1000;
/** 2000-01-01T00:00:00Z in unix seconds: the ledgers of a node carry their close time since then. */
const RIPPLE_EPOCH = 946_684_800;

/** 2026-10-16T12:34:56Z: the `now` of the tests that tick a database with the live ledger of `fresh(true)`. */
const NOW_LIVE = new Date('2026-10-16T12:34:56Z');

const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** A ledger of the synthetic chain (13 transactions) that closed at `time`, with an index above every mock ledger. */
const ledgerAt = (n: number, time: string): RawLedger => {
  const [{ json }] = syntheticChain(90_000_000 + n, 1);
  return normalizeLedgerResponse({ ...json, close_time: unix(time) - RIPPLE_EPOCH });
};

interface Hour {
  hour: number;
  ledger_count: number;
  transaction_count: number;
}

describe('AggregatorService (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /**
   * A migrated database of its own. With `mock` (the default) the mock ledgers are in `ledgers`. With `live`, also a ledger that
   * closed a few minutes before the `NOW` of the tests, as the live runner would have written it, and the stats of its hour,
   * as the aggregator would have: the newest stats hour is then the current one, so that the work on old hours is not
   * mistaken for a catch-up (an aggregator with no stats at all starts at the first ledger).
   */
  async function fresh(live = false, mock = true): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_e2e_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    const written = [...(mock ? ledgers : []), ...(live ? [ledgerAt(1, '2026-10-16T12:30:00Z')] : [])];
    if (written.length > 0) await new LedgerWriter(svc, ctx).write(written);
    if (live) await recomputeStatsHourly(svc, new Date('2026-10-16T12:00:00Z'), new Date('2026-10-16T13:00:00Z'));
    return svc;
  }
  /** The stats of the hours of the mock ledgers (all before 2026). */
  const oldStats = async (ch: ClickHouseService): Promise<Hour[]> =>
    (await stats(ch)).filter((h) => h.hour < unix('2026-01-01T00:00:00Z'));

  /** The newest version of every hour of `stats_hourly`, as a reader sees it (ledger_count 0 skipped). */
  async function stats(ch: ClickHouseService): Promise<Hour[]> {
    const rows = await ch.query<Hour>(
      `SELECT toUnixTimestamp(hour) AS hour, ledger_count, transaction_count
         FROM (SELECT * FROM ${Table.StatsHourly} ORDER BY hour ASC, version DESC LIMIT 1 BY hour)
        WHERE ledger_count > 0
        ORDER BY hour`,
    );
    return rows.map((r) => ({
      hour: Number(r.hour),
      ledger_count: Number(r.ledger_count),
      transaction_count: Number(r.transaction_count),
    }));
  }

  /** What `ledgers` holds per hour, added up by ClickHouse itself (FINAL is fine in a test). */
  async function truth(ch: ClickHouseService, from: string, to: string): Promise<Hour[]> {
    const rows = await ch.query<Hour>(
      `SELECT toUnixTimestamp(toStartOfHour(close_time)) AS hour, count() AS ledger_count, sum(tx_count) AS transaction_count
         FROM ${Table.Ledgers} FINAL
        WHERE close_time >= toDateTime({from:UInt32}, 'UTC') AND close_time < toDateTime({to:UInt32}, 'UTC')
        GROUP BY hour
        ORDER BY hour`,
      { from: unix(from), to: unix(to) },
    );
    return rows.map((r) => ({
      hour: Number(r.hour),
      ledger_count: Number(r.ledger_count),
      transaction_count: Number(r.transaction_count),
    }));
  }

  /** Marks a range dirty the way `range-ingest` does. */
  async function mark(ch: ClickHouseService, from: string, to: string, createdMs: number): Promise<void> {
    await ch.command(
      `INSERT INTO ${Table.AggDirty} (from_hour, to_hour, created_at)
       SELECT toDateTime({from:UInt32}, 'UTC'), toDateTime({to:UInt32}, 'UTC'), fromUnixTimestamp64Milli({created:Int64})`,
      { from: unix(from), to: unix(to), created: createdMs },
    );
  }

  const dirty = (ch: ClickHouseService) => readDirtyRanges(ch, 100);
  /** The aggregator on a database; `now` is the clock the tick budget reads. */
  const aggregator = (ch: ClickHouseService, options: ConstructorParameters<typeof AggregatorService>[3] = {}) =>
    new AggregatorService(ch, undefined, undefined, { logger: QUIET, ...options });

  it('recomputes the hours of an agg_dirty range and removes the row', async () => {
    const ch = await fresh(true);
    await mark(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z', 1_760_000_000_123);
    expect(await oldStats(ch)).toEqual([]);

    await aggregator(ch).tick(new Date('2026-10-16T12:34:56Z'));

    const expected = await truth(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z');
    expect(expected.map((h) => h.ledger_count)).toEqual([expect.any(Number), expect.any(Number), expect.any(Number)]);
    expect(expected.reduce((n, h) => n + h.ledger_count, 0)).toBe(41);
    expect(await oldStats(ch)).toEqual(expected);
    expect(await dirty(ch)).toEqual([]);
  });

  it('works the oldest row first and recomputes every row', async () => {
    const ch = await fresh(true);
    await mark(ch, '2015-02-09T00:00:00Z', '2015-02-10T00:00:00Z', 3000);
    await mark(ch, '2013-06-11T00:00:00Z', '2013-06-12T00:00:00Z', 1000);
    await mark(ch, '2015-01-14T00:00:00Z', '2015-01-15T00:00:00Z', 2000);
    const rows = await dirty(ch);
    expect(rows.map((r) => r.created)).toEqual([1000, 2000, 3000]);

    await aggregator(ch).tick(new Date('2026-10-16T12:34:56Z'));
    expect(await dirty(ch)).toEqual([]);
    const expected = [
      ...(await truth(ch, '2013-06-11T00:00:00Z', '2013-06-12T00:00:00Z')),
      ...(await truth(ch, '2015-01-14T00:00:00Z', '2015-01-15T00:00:00Z')),
      ...(await truth(ch, '2015-02-09T00:00:00Z', '2015-02-10T00:00:00Z')),
    ];
    expect(await oldStats(ch)).toEqual(expected);
  });

  it('a second tick changes nothing (idempotent), and a range marked twice is one row', async () => {
    const ch = await fresh(true);
    await mark(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z', 1000);
    await mark(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z', 2000);
    const service = aggregator(ch);
    await service.tick(new Date('2026-10-16T12:34:56Z'));
    const first = await stats(ch);
    expect(first).toHaveLength(4); // the three hours of the range and the current one
    await mark(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z', 3000);
    await service.tick(new Date('2026-10-16T12:35:56Z'));
    expect(await stats(ch)).toEqual(first);
    expect(await dirty(ch)).toEqual([]);
  });

  it('works through a range of days across ticks: the row is narrowed to the progress, with its created_at', async () => {
    const ch = await fresh(true);
    await mark(ch, '2013-06-10T00:00:00Z', '2013-06-14T00:00:00Z', 1_760_000_000_777);
    // The tick budget reads this clock; every slice takes 10 s of it. The first slice of a tick is the live window's.
    let clock = Date.parse('2026-10-16T12:34:56Z');
    const real = recomputeStatsHourly;
    const recompute: typeof recomputeStatsHourly = async (...args) => {
      const written = await real(...args);
      clock += 10_000;
      return written;
    };
    const service = aggregator(ch, { now: () => clock, recompute });

    // live (10 s), then a day of the range: stats_dirty has a budget of its own, 10 s from its start (it used to take the
    // rest of the 30 s of the tick), and a slice is only started inside it
    const days = ['2013-06-11', '2013-06-12', '2013-06-13'];
    await service.tick();
    expect(await dirty(ch)).toEqual([
      { from: unix(`${days[0]}T00:00:00Z`), to: unix('2013-06-14T00:00:00Z'), created: 1_760_000_000_777 },
    ]);
    expect(await oldStats(ch)).toEqual(await truth(ch, '2013-06-10T00:00:00Z', '2013-06-11T00:00:00Z'));

    for (const [i] of days.entries()) {
      clock = Date.parse('2026-10-16T12:35:56Z') + i * 60_000;
      await service.tick();
      const next = days[i + 1];
      expect(await dirty(ch)).toEqual(
        next ? [{ from: unix(`${next}T00:00:00Z`), to: unix('2013-06-14T00:00:00Z'), created: 1_760_000_000_777 }] : [],
      );
      expect(await oldStats(ch)).toEqual(await truth(ch, '2013-06-10T00:00:00Z', `${next ?? '2013-06-14'}T00:00:00Z`));
    }
  });

  it('turns an hour whose ledgers were rewritten away into a zero row, which readers skip', async () => {
    const ch = await fresh(true);
    const service = aggregator(ch);
    await mark(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z', 1000);
    await service.tick(new Date('2026-10-16T12:34:56Z'));
    const before = await oldStats(ch);
    const gone = before.find((h) => h.hour === unix('2015-01-14T19:00:00Z'));
    expect(gone?.ledger_count).toBeGreaterThan(0);

    await ch.command(
      `DELETE FROM ${Table.Ledgers} WHERE close_time >= toDateTime({from:UInt32}, 'UTC') AND close_time < toDateTime({to:UInt32}, 'UTC')`,
      { from: unix('2015-01-14T19:00:00Z'), to: unix('2015-01-14T20:00:00Z') },
      { settings: { lightweight_deletes_sync: '2' } },
    );
    await mark(ch, '2015-01-14T19:00:00Z', '2015-01-14T20:00:00Z', 2000);
    await service.tick(new Date('2026-10-16T12:35:56Z'));

    expect(await oldStats(ch)).toEqual(before.filter((h) => h.hour !== unix('2015-01-14T19:00:00Z')));
    expect(await dirty(ch)).toEqual([]);
  });

  describe('the live window', () => {
    const write = (ch: ClickHouseService, list: RawLedger[]) => new LedgerWriter(ch, ctx).write(list);
    const NOW = new Date('2026-10-16T12:34:56Z');

    it('recomputes the hours from two hours ago to the end of the current hour, and no others', async () => {
      const ch = await fresh(false, false);
      await write(ch, [
        ledgerAt(1, '2026-10-16T09:59:59Z'), // before the window: not touched
        ledgerAt(2, '2026-10-16T10:00:00Z'),
        ledgerAt(3, '2026-10-16T10:30:00Z'),
        ledgerAt(4, '2026-10-16T11:59:00Z'),
        ledgerAt(5, '2026-10-16T12:34:50Z'),
      ]);
      // the aggregator has been running: the newest stats hour is the current one, so there is nothing to catch up on
      await recomputeStatsHourly(ch, new Date('2026-10-16T12:00:00Z'), new Date('2026-10-16T13:00:00Z'));
      await aggregator(ch).tick(NOW);
      expect(await stats(ch)).toEqual([
        { hour: unix('2026-10-16T10:00:00Z'), ledger_count: 2, transaction_count: 26 },
        { hour: unix('2026-10-16T11:00:00Z'), ledger_count: 1, transaction_count: 13 },
        { hour: unix('2026-10-16T12:00:00Z'), ledger_count: 1, transaction_count: 13 },
      ]);
    });

    it('refreshes the current hour as ledgers come in', async () => {
      const ch = await fresh(false, false);
      const service = aggregator(ch);
      await write(ch, [ledgerAt(1, '2026-10-16T12:10:00Z')]);
      await service.tick(new Date('2026-10-16T12:11:00Z'));
      expect(await stats(ch)).toEqual([{ hour: unix('2026-10-16T12:00:00Z'), ledger_count: 1, transaction_count: 13 }]);
      await write(ch, [ledgerAt(2, '2026-10-16T12:12:00Z')]);
      await service.tick(new Date('2026-10-16T12:12:30Z'));
      expect(await stats(ch)).toEqual([{ hour: unix('2026-10-16T12:00:00Z'), ledger_count: 2, transaction_count: 26 }]);
    });

    it('catches up from the newest stats hour after an outage, without any agg_dirty row', async () => {
      const ch = await fresh(false, false);
      await write(ch, [
        ledgerAt(1, '2026-10-13T07:30:00Z'), // before the watermark: the sweep starts at the watermark, this stays out
        ledgerAt(2, '2026-10-13T08:10:00Z'),
        ledgerAt(3, '2026-10-13T08:50:00Z'),
        ledgerAt(4, '2026-10-13T09:30:00Z'),
        ledgerAt(5, '2026-10-14T03:00:00Z'),
        ledgerAt(6, '2026-10-16T11:00:00Z'),
      ]);
      // the aggregator had run up to the hour 2026-10-13 08:00 (one ledger of it was committed after that run) ...
      await recomputeStatsHourly(ch, new Date('2026-10-13T08:00:00Z'), new Date('2026-10-13T09:00:00Z'));
      // ... and comes back three days later: it brings in the hours since then, and nothing before
      await aggregator(ch).tick(NOW);
      expect(await stats(ch)).toEqual([
        { hour: unix('2026-10-13T08:00:00Z'), ledger_count: 2, transaction_count: 26 },
        { hour: unix('2026-10-13T09:00:00Z'), ledger_count: 1, transaction_count: 13 },
        { hour: unix('2026-10-14T03:00:00Z'), ledger_count: 1, transaction_count: 13 },
        { hour: unix('2026-10-16T11:00:00Z'), ledger_count: 1, transaction_count: 13 },
      ]);
      expect(await dirty(ch)).toEqual([]);
    });

    it('with no stats at all, sweeps from the hour of the first ledger: a database the aggregator never saw is brought in', async () => {
      const ch = await fresh(false, false);
      await write(ch, [
        ledgerAt(1, '2026-10-13T07:30:00Z'),
        ledgerAt(2, '2026-10-13T08:10:00Z'),
        ledgerAt(3, '2026-10-14T03:00:00Z'),
        ledgerAt(4, '2026-10-16T11:00:00Z'),
      ]);
      expect(await stats(ch)).toEqual([]);
      await aggregator(ch).tick(NOW);
      expect(await stats(ch)).toEqual([
        { hour: unix('2026-10-13T07:00:00Z'), ledger_count: 1, transaction_count: 13 },
        { hour: unix('2026-10-13T08:00:00Z'), ledger_count: 1, transaction_count: 13 },
        { hour: unix('2026-10-14T03:00:00Z'), ledger_count: 1, transaction_count: 13 },
        { hour: unix('2026-10-16T11:00:00Z'), ledger_count: 1, transaction_count: 13 },
      ]);
    });

    describe('backfill, then a gap of years, then live', () => {
      // the mock ledgers are the backfill (2013 to 2017, with gaps of months and years between its days), the two ledgers
      // of today the live runner; no agg_dirty row: only range-ingest writes those
      const seed = async (): Promise<ClickHouseService> => {
        const ch = await fresh();
        await write(ch, [ledgerAt(1, '2026-10-16T11:30:00Z'), ledgerAt(2, '2026-10-16T12:30:00Z')]);
        return ch;
      };
      const everything = async (ch: ClickHouseService): Promise<Hour[]> => [
        ...(await truth(ch, '2013-01-01T00:00:00Z', '2018-01-01T00:00:00Z')),
        { hour: unix('2026-10-16T11:00:00Z'), ledger_count: 1, transaction_count: 13 },
        { hour: unix('2026-10-16T12:00:00Z'), ledger_count: 1, transaction_count: 13 },
      ];

      it('is all in the stats after one tick, with a handful of slices and not one per day of the gaps', async () => {
        const ch = await seed();
        const calls: [number, number][] = [];
        const recompute: typeof recomputeStatsHourly = async (c, from, to, options) => {
          calls.push([from.getTime() / 1000, to.getTime() / 1000]);
          return recomputeStatsHourly(c, from, to, options);
        };
        await aggregator(ch, { recompute }).tick(NOW);
        expect(await stats(ch)).toEqual(await everything(ch));
        expect((await stats(ch)).length).toBe(12);
        expect(await dirty(ch)).toEqual([]);
        // 4 years are 1,500 days: the sweep read 7 days with ledgers and a slice after each to find the next
        expect(calls.length).toBeLessThanOrEqual(20);
        expect(calls[0][0]).toBe(unix('2013-06-11T20:00:00Z')); // the hour of the first ledger
        expect(calls[calls.length - 1]).toEqual([unix('2026-10-16T10:00:00Z'), unix('2026-10-16T13:00:00Z')]);
      });

      it('is all in the stats after a few ticks when the slices are slow, and each tick starts where the one before ended', async () => {
        const ch = await seed();
        let clock = Date.parse('2026-10-16T12:34:56Z');
        const recompute: typeof recomputeStatsHourly = async (...args) => {
          const written = await recomputeStatsHourly(...args);
          clock += 9000; // the budget of stats_live (20 s) holds three slices
          return written;
        };
        const service = aggregator(ch, { now: () => clock, recompute });
        const watermarks: number[] = [];
        let ticks = 0;
        while (ticks < 12) {
          ticks++;
          await service.tick();
          const hours = await stats(ch);
          watermarks.push(hours[hours.length - 1].hour);
          if (hours.length === 12) break;
        }
        expect(await stats(ch)).toEqual(await everything(ch));
        expect(ticks).toBeGreaterThan(1);
        expect(ticks).toBeLessThanOrEqual(8);
        for (let i = 1; i < watermarks.length; i++) expect(watermarks[i]).toBeGreaterThanOrEqual(watermarks[i - 1]);
      });
    });

    it('skips the empty stretch when the chain stood still: only its last hour and the last two hours are read', async () => {
      const ch = await fresh(false, false);
      await write(ch, [ledgerAt(1, '2026-09-01T05:10:00Z'), ledgerAt(2, '2026-09-01T05:50:00Z')]);
      await recomputeStatsHourly(ch, new Date('2026-09-01T05:00:00Z'), new Date('2026-09-01T06:00:00Z'));
      await write(ch, [ledgerAt(3, '2026-09-01T05:55:00Z')]); // committed after that run
      const calls: [number, number][] = [];
      const recompute: typeof recomputeStatsHourly = async (c, from, to, options) => {
        calls.push([from.getTime() / 1000, to.getTime() / 1000]);
        return recomputeStatsHourly(c, from, to, options);
      };
      await aggregator(ch, { recompute }).tick(NOW);
      expect(calls).toEqual([
        [unix('2026-09-01T05:00:00Z'), unix('2026-09-01T06:00:00Z')],
        [unix('2026-10-16T10:00:00Z'), unix('2026-10-16T13:00:00Z')],
      ]);
      expect(await stats(ch)).toEqual([{ hour: unix('2026-09-01T05:00:00Z'), ledger_count: 3, transaction_count: 39 }]);
    });
  });

  describe('what the queries of the live job read', () => {
    let queryCounter = 0;

    /** Runs a statement as the service ran it and says how many rows ClickHouse read for it (`system.query_log`). */
    async function readRows(
      ch: ClickHouseService,
      sql: string,
      params: Record<string, unknown>,
      settings: Record<string, string | number> = {},
    ): Promise<number> {
      const id = `aggregator-read-rows-${container.config.database}-${++queryCounter}`;
      const result = await ch.raw.query({
        query: sql,
        query_params: params,
        format: 'JSONEachRow',
        query_id: id,
        clickhouse_settings: settings,
      });
      await result.text();
      await ch.command('SYSTEM FLUSH LOGS');
      const rows = await ch.query<{ read_rows: string }>(
        `SELECT read_rows FROM system.query_log WHERE query_id = {id:String} AND type = 'QueryFinish' LIMIT 1`,
        { id },
      );
      return Number(rows[0].read_rows);
    }

    /** The statements a tick sent to `table`, as [sql, params]. */
    async function captured(
      ch: ClickHouseService,
      table: Table,
      run: () => Promise<void>,
    ): Promise<Array<[string, Record<string, unknown>]>> {
      const spy = jest.spyOn(ch, 'query');
      try {
        await run();
        return spy.mock.calls
          .filter(([sql]) => String(sql).includes(`FROM ${table}`))
          .map(([sql, params]) => [String(sql), (params ?? {}) as Record<string, unknown>]);
      } finally {
        spy.mockRestore();
      }
    }

    /**
     * A database with 200,000 hours (23 years) of stats history before the current hour, and the watermark read of a tick on
     * it: the statement and its parameters. The table holds three parts: the live hour of `fresh`, the history, the rows the
     * tick wrote.
     */
    async function withHistory(
      stopMerges: boolean,
    ): Promise<{ ch: ClickHouseService; sql: string; params: Record<string, unknown> }> {
      const ch = await fresh(true, false);
      if (stopMerges) {
        // the layout of production, where the merges lag behind the inserts, held still
        const db = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
        await ch.command(`SYSTEM STOP MERGES ${db}.${Table.StatsHourly}`);
      }
      await ch.command(
        `INSERT INTO ${Table.StatsHourly}
           (hour, transaction_count, payments_count, exchanges_count, accounts_created, ledger_count,
            first_close_time, last_close_time, version)
         SELECT toDateTime(1792152000 - (number + 1) * 3600, 'UTC'), 1, 0, 0, 0, 1,
                toDateTime(1792152000 - (number + 1) * 3600, 'UTC'), toDateTime(1792152000 - (number + 1) * 3600, 'UTC'), 1
           FROM numbers(200000)`,
      );
      const reads = (await captured(ch, Table.StatsHourly, () => aggregator(ch).tick(NOW_LIVE))).filter(([sql]) =>
        /LIMIT \{n:UInt32\}/.test(sql),
      );
      expect(reads).toHaveLength(1); // the newest hour has ledgers: one chunk
      return { ch, sql: reads[0][0], params: reads[0][1] };
    }

    /** The read the watermark query replaces: the whole table, deduped, then the newest. */
    const WHOLE = `SELECT toUnixTimestamp(maxOrNull(hour)) AS hour
                     FROM (SELECT hour, ledger_count FROM ${Table.StatsHourly} ORDER BY hour ASC, version DESC LIMIT 1 BY hour)
                    WHERE ledger_count > 0`;

    it('the watermark: a hundred hours from the newest, not the whole history of stats_hourly (one part)', async () => {
      const { ch, sql, params } = await withHistory(false);
      // One part, as the table is once the background merge has joined the three parts it has now: each part is read for a
      // block, so with several the number of rows read depends on the layout (see the next test), and on when the merge ran.
      await ch.command(`OPTIMIZE TABLE ${Table.StatsHourly} FINAL`);
      // one block of the table read in reverse order (65,000 rows at most), whatever the history
      expect(await readRows(ch, sql, params)).toBeLessThanOrEqual(70_000);

      // the read it replaces (the whole table, deduped, then the newest) reads all of it
      expect(await readRows(ch, WHOLE, {})).toBeGreaterThanOrEqual(200_000);
    });

    it('the watermark in the layout of production, several parts (the merges behind the inserts): every part read in reverse key order, merged without a sort of the table', async () => {
      const { ch, sql, params } = await withHistory(true);
      const parts = await ch.query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {table:String} AND active`,
        { table: Table.StatsHourly },
      );
      expect(parts.length).toBeGreaterThanOrEqual(3); // the live hour, the history, the rows of the tick: not merged
      const total = parts.reduce((sum, p) => sum + Number(p.rows), 0);
      expect(total).toBeGreaterThanOrEqual(200_000);

      // The rows this reads in such a layout are NOT bounded by the parts and their blocks: how many of them it reads before
      // the LIMIT stops the streams depends on the scheduling of the threads (measured with 1 to 16 threads on this table: from
      // 52,548 rows to all 200,004, run after run, and always all of them with one thread). So what is pinned is the shape of
      // the read, which does not depend on it: each part is read from the end of its primary key, the parts are merged in order,
      // the order within an hour is finished on the rows of that hour only and the LIMIT BY works on sorted input. A read of
      // the whole table (the statement it replaces) sorts all of it.
      const plan = (await ch.query<{ explain: string }>(`EXPLAIN PIPELINE ${sql}`, params))
        .map((r) => r.explain)
        .join('\n');
      expect(plan.match(/algorithm: InReverseOrder/g)).toHaveLength(parts.length);
      expect(plan).toMatch(/MergingSortedTransform 3 → 1/);
      expect(plan).toMatch(/FinishSortingTransform/);
      expect(plan).toMatch(/LimitBySortedStreamTransform/);
      expect(plan).not.toMatch(/MergeSortingTransform/);
      const whole = (await ch.query<{ explain: string }>(`EXPLAIN PIPELINE ${WHOLE}`)).map((r) => r.explain).join('\n');
      expect(whole).toMatch(/MergeSortingTransform|FinishSortingTransform/);
      expect(whole).not.toMatch(/algorithm: InReverseOrder/);

      // and it finds the watermark, the newest hour that has ledgers, whatever the layout and the number of rows it reads
      const [newest] = await ch.query<{ hour_start: string; ledger_count: string }>(sql, params);
      expect(Number(newest.hour_start)).toBe(unix('2026-10-16T12:00:00Z'));
      expect(Number(newest.ledger_count)).toBeGreaterThan(0);
      expect(await readRows(ch, sql, params)).toBeLessThanOrEqual(total);
    });

    it('the first, the next and the newest ledger: a read of the primary key that stops at the first row, in a table of a million', async () => {
      // the statements, as a tick with a gap sends them
      const small = await fresh(false, true);
      await new LedgerWriter(small, ctx).write([ledgerAt(1, '2026-10-16T11:30:00Z')]);
      const sent = await captured(small, Table.Ledgers, () => aggregator(small).tick(NOW_LIVE));
      const latest = sent.find(([sql]) => /ORDER BY ledger_index DESC\s+LIMIT 1/.test(sql));
      const first = sent.find(([sql]) => /FROM ledgers\s+ORDER BY ledger_index ASC\s+LIMIT 1/.test(sql));
      const next = sent.find(([sql]) => /close_time >= [^\n]*\s+ORDER BY ledger_index ASC\s+LIMIT 1/.test(sql));
      expect([latest, first, next].every((q) => q !== undefined)).toBe(true);

      const big = await fresh(false, false);
      await big.command(
        `INSERT INTO ${Table.Ledgers} (ledger_index, close_time)
         SELECT number + 1, toDateTime(1400000000 + number * 4, 'UTC') FROM numbers(1000000)`,
      );
      const reads = {
        latest: await readRows(big, ...(latest as [string, Record<string, unknown>])),
        first: await readRows(big, ...(first as [string, Record<string, unknown>])),
        next: await readRows(big, (next as [string, Record<string, unknown>])[0], { from: 1400000000 + 4 * 900_000 }),
      };
      // a granule or a block, where a scan is a million rows
      expect(reads.latest).toBeLessThanOrEqual(10_000); // the last granule's row
      expect(reads.first).toBeLessThanOrEqual(10_000); // the first granule
      expect(reads.next).toBeLessThanOrEqual(70_000); // one block, after the minmax index skipped the granules before it
      const plan = (
        await big.query<{ explain: string }>(`EXPLAIN indexes = 1 ${(next as [string, unknown])[0]}`, {
          from: 1400000000 + 4 * 900_000,
        })
      )
        .map((r) => r.explain)
        .join('\n');
      expect(plan).toMatch(/close_time_mm/);
      expect(plan).toMatch(/Read type: InOrder/);
    });
  });

  describe('agg_dirty SQL', () => {
    it('the delete leaves a mark made after the one that was read, and takes the older ones of its key', async () => {
      const ch = await fresh();
      await mark(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z', 1000);
      await mark(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z', 2000);
      await mark(ch, '2015-01-14T00:00:00Z', '2015-01-14T20:00:00Z', 1500);
      const key = { from: unix('2015-01-14T17:00:00Z'), to: unix('2015-01-14T20:00:00Z') };

      // the row was read when its newest mark was 1000; a newer one came in meanwhile
      await deleteDirtyRange(ch, { ...key, created: 1000 });
      expect(await dirty(ch)).toEqual([
        { from: unix('2015-01-14T00:00:00Z'), to: key.to, created: 1500 },
        { ...key, created: 2000 },
      ]);

      await deleteDirtyRange(ch, { ...key, created: 2000 });
      expect(await dirty(ch)).toEqual([{ from: unix('2015-01-14T00:00:00Z'), to: key.to, created: 1500 }]);
    });

    it('the delete is applied when the call returns', async () => {
      const ch = await fresh();
      await mark(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z', 1000);
      await deleteDirtyRange(ch, {
        from: unix('2015-01-14T17:00:00Z'),
        to: unix('2015-01-14T20:00:00Z'),
        created: 1000,
      });
      const left = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.AggDirty}`);
      expect(Number(left[0].n)).toBe(0);
    });

    it('narrowing keeps the milliseconds of created_at exactly and leaves a re-mark of the old range alone', async () => {
      const ch = await fresh();
      const old = { from: unix('2015-01-10T00:00:00Z'), to: unix('2015-01-14T00:00:00Z'), created: 1_760_000_000_001 };
      await mark(ch, '2015-01-10T00:00:00Z', '2015-01-14T00:00:00Z', old.created);
      await mark(ch, '2015-01-10T00:00:00Z', '2015-01-14T00:00:00Z', old.created + 5000); // marked again meanwhile
      await narrowDirtyRange(ch, old, unix('2015-01-12T00:00:00Z'));
      expect(await dirty(ch)).toEqual([
        { from: unix('2015-01-12T00:00:00Z'), to: old.to, created: old.created },
        { ...old, created: old.created + 5000 },
      ]);
    });

    it('reads the oldest mark first, one row per range, without FINAL', async () => {
      const ch = await fresh();
      // merges stopped and separate inserts: the range marked twice really is two rows
      const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
      await ch.command(`SYSTEM STOP MERGES ${database}.${Table.AggDirty}`);
      await mark(ch, '2015-01-14T00:00:00Z', '2015-01-15T00:00:00Z', 2000);
      await mark(ch, '2015-01-14T00:00:00Z', '2015-01-15T00:00:00Z', 4000);
      await mark(ch, '2013-01-01T00:00:00Z', '2013-01-02T00:00:00Z', 3000);
      const stored = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.AggDirty}`);
      expect(Number(stored[0].n)).toBe(3);
      const rows = await readDirtyRanges(ch, 100);
      expect(rows.map((r) => r.created)).toEqual([3000, 4000]);
      expect(await readDirtyRanges(ch, 1)).toHaveLength(1);
    });
  });

  it('cuts a range of 3 days and 5 hours into slices of at most a day, from its start', async () => {
    const ch = await fresh(true);
    const calls: [number, number][] = [];
    const recompute: typeof recomputeStatsHourly = async (c, from, to, options) => {
      calls.push([from.getTime() / 1000, to.getTime() / 1000]);
      return recomputeStatsHourly(c, from, to, options);
    };
    await mark(ch, '2015-01-12T07:00:00Z', '2015-01-15T12:00:00Z', 1000);
    await aggregator(ch, { recompute }).tick(new Date('2026-10-16T12:34:56Z'));
    const slices = calls.filter(([from]) => from < unix('2026-01-01T00:00:00Z'));
    expect(slices.map(([f, t]) => (t - f) / 3600)).toEqual([24, 24, 24, 5]);
    expect(slices[0][0]).toBe(unix('2015-01-12T07:00:00Z'));
    expect(slices[3][1]).toBe(unix('2015-01-15T12:00:00Z'));
  });
});
