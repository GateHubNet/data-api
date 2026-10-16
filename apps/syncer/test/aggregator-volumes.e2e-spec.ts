import {
  ClickHouseService,
  computeDailyVolumeSet,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  MarketsConfig,
  parseContextFor,
  RatesService,
  runMigrations,
  Table,
  volumeDaysDone,
} from '@gatehub/data-api-shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { SAMPLE_ROWS } from '../../../packages/shared/test/sample-rows';
import { AggregatorOptions, AggregatorService } from '../src/aggregator/aggregator.service';

/**
 * The volume jobs of the `AggregatorService` against a real ClickHouse: the 41 mock ledgers of 2015-01-14 (17:29 - 19:10 UTC),
 * written by the real `LedgerWriter`, preceded by a ledger of 2015-01-08, so that there are closed days to back-fill, and
 * followed by a ledger of 2015-01-15 at 03:00, so that the ingest has passed the 14th (a day is closed, and its set final,
 * when the newest ledger closed an hour after its end). The sets themselves are checked against an oracle in `packages/shared/test/volume-job.e2e-spec.ts`; here it is the job that
 * is on trial: what a tick writes, the back-fill (once per config version, newest first, under a budget), and the hook of
 * `agg_dirty`.
 */

const SHARED_TEST = join(__dirname, '../../../packages/shared/test');
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const day14 = FixtureLedgerSource.fromDir(join(SHARED_TEST, 'fixtures/xrpl/ripple-mock'))
  .list()
  .filter((l) => new Date(l.header.close_time * 1000).toISOString().startsWith('2015-01-14'));
const MARKETS = JSON.parse(
  readFileSync(join(SHARED_TEST, 'fixtures/xrpl/volume-markets.json'), 'utf8'),
) as MarketsConfig;

const unix = (text: string): number => Date.parse(text) / 1000;
const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const SEC = 1000;

interface SetInfo {
  day: string;
  version: number;
  config_version: number;
  components: number;
}

describe('AggregatorService volume jobs (e2e)', () => {
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

  /** A migrated database, empty. */
  async function empty(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_volumes_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** A ledger row that closed at `close`; the indexes of the tests are above the mock ledgers' for the later ones. */
  const ledgerRow = (index: number, close: string) => ({
    ...SAMPLE_ROWS[Table.Ledgers],
    ledger_index: index,
    ledger_hash: String(index).padStart(64, 'E'),
    close_time: unix(close),
  });
  const FIRST_LEDGER = ledgerRow(11_000_000, '2015-01-08T09:00:00Z');
  /** The ledger that has the ingest pass the 14th. */
  const LAST_LEDGER = ledgerRow(11_200_000, '2015-01-15T03:00:00Z');

  /** A migrated database with the ledgers of 2015-01-14, a first ledger on 2015-01-08 and a last one on the 15th. */
  async function fresh(): Promise<ClickHouseService> {
    const svc = await empty();
    await svc.insert(Table.Ledgers, [FIRST_LEDGER]);
    await new LedgerWriter(svc, ctx).write(day14);
    await svc.insert(Table.Ledgers, [LAST_LEDGER]);
    return svc;
  }

  /** The days whose newest daily set of `metric` is final (the flag of its sentinel), as `YYYY-MM-DD`. */
  async function finalDays(ch: ClickHouseService, metric: string): Promise<string[]> {
    const rows = await ch.query<{ day: string }>(
      `SELECT toString(day) AS day
         FROM (SELECT day, rate_f FROM ${Table.VolumeDaily} WHERE metric = {metric:String} AND component = ''
                ORDER BY day, version DESC LIMIT 1 BY day)
        WHERE rate_f = 1
        ORDER BY day`,
      { metric },
    );
    return rows.map((r) => r.day);
  }

  function aggregator(
    ch: ClickHouseService,
    options: AggregatorOptions = {},
    markets: MarketsConfig = MARKETS,
  ): AggregatorService {
    return new AggregatorService(ch, undefined, undefined, {
      logger: QUIET,
      volumes: { rates: new RatesService(ch, 'XRP'), markets },
      ...options,
    });
  }

  /** Newest set of every day of a metric: its version, config version and how many components it holds. */
  async function daily(ch: ClickHouseService, metric: string): Promise<SetInfo[]> {
    const rows = await ch.query<SetInfo>(
      `SELECT toString(d.day) AS day, d.newest AS version, any(v.config_version) AS config_version,
              countIf(v.component != '') AS components
         FROM (SELECT day, max(version) AS newest FROM ${Table.VolumeDaily} WHERE metric = {metric:String} GROUP BY day) AS d
        INNER JOIN (SELECT day, component, version, config_version FROM ${Table.VolumeDaily} WHERE metric = {metric:String}) AS v
                ON v.day = d.day AND v.version = d.newest
        GROUP BY d.day, d.newest
        ORDER BY d.day`,
      { metric },
    );
    return rows.map((r) => ({
      ...r,
      version: Number(r.version),
      config_version: Number(r.config_version),
      components: Number(r.components),
    }));
  }

  const days = (sets: SetInfo[]): string[] => sets.map((s) => s.day);

  it('a tick writes the seven live sets for its time and the daily sets of today and of yesterday', async () => {
    const ch = await fresh();
    const now = new Date('2015-01-14T19:30:00Z');
    await aggregator(ch).tick(now);

    const live = await ch.query<{ metric: string; period: string; start: number; end: number; components: number }>(
      `SELECT metric, period, toUnixTimestamp(any(start_time)) AS start, toUnixTimestamp(any(end_time)) AS end,
              countIf(component != '') AS components
         FROM ${Table.VolumeLive}
        GROUP BY metric, period
        ORDER BY metric, period`,
    );
    expect(live.map((s) => `${s.metric} ${s.period}`)).toEqual([
      'payment_volume day',
      'payment_volume hour',
      'trade_volume 30day',
      'trade_volume 3day',
      'trade_volume 7day',
      'trade_volume day',
      'trade_volume hour',
    ]);
    expect(live.every((s) => Number(s.end) === now.getTime() / SEC)).toBe(true);
    const tradeDay = live.find((s) => s.metric === 'trade_volume' && s.period === 'day');
    expect(Number(tradeDay?.components)).toBeGreaterThan(8);

    // today is 2015-01-14, yesterday the 13th (a day without ledgers: only the sentinel)
    const trade = await daily(ch, 'trade_volume');
    expect(days(trade).filter((d) => d >= '2015-01-13')).toEqual(['2015-01-13', '2015-01-14']);
    expect(trade.find((s) => s.day === '2015-01-14')?.components).toBeGreaterThan(8);
    expect(trade.find((s) => s.day === '2015-01-13')?.components).toBe(0);
    expect((await daily(ch, 'payment_volume')).find((s) => s.day === '2015-01-14')?.components).toBe(6);
  });

  it('back-fills the closed days from the first ledger, both metrics, and a second tick leaves them alone', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(new Date('2015-01-14T19:30:00Z'));
    // closed days: before yesterday (the 13th), from the day of the first ledger (the 8th)
    for (const metric of ['trade_volume', 'payment_volume']) {
      expect(days(await daily(ch, metric))).toEqual([
        '2015-01-08',
        '2015-01-09',
        '2015-01-10',
        '2015-01-11',
        '2015-01-12',
        '2015-01-13',
        '2015-01-14',
      ]);
    }
    // a day with the first ledger but no volume has the sentinel and counts as done
    expect(
      [
        ...(await volumeDaysDone(
          ch,
          'trade_volume',
          new Date('2015-01-08T00:00:00Z'),
          new Date('2015-01-13T00:00:00Z'),
          MARKETS.version,
        )),
      ].sort(),
    ).toEqual(['2015-01-08', '2015-01-09', '2015-01-10', '2015-01-11', '2015-01-12']);

    const before = await daily(ch, 'trade_volume');
    await svc.tick(new Date('2015-01-14T19:31:00Z'));
    const after = await daily(ch, 'trade_volume');
    // the closed days were not written again; today and yesterday were
    for (const d of ['2015-01-08', '2015-01-09', '2015-01-10', '2015-01-11', '2015-01-12']) {
      expect(after.find((s) => s.day === d)?.version).toBe(before.find((s) => s.day === d)?.version);
    }
    for (const d of ['2015-01-13', '2015-01-14']) {
      expect(after.find((s) => s.day === d)?.version).toBeGreaterThan(before.find((s) => s.day === d)?.version ?? 0);
    }
  });

  it('computes the closed days again when the version of the config changes, and only then', async () => {
    const ch = await fresh();
    await aggregator(ch).tick(new Date('2015-01-14T19:30:00Z'));
    const first = await daily(ch, 'trade_volume');
    expect(new Set(first.map((s) => s.config_version))).toEqual(new Set([MARKETS.version]));

    await aggregator(ch, {}, { ...MARKETS, version: MARKETS.version + 1 }).tick(new Date('2015-01-14T19:32:00Z'));
    const second = await daily(ch, 'trade_volume');
    expect(new Set(second.map((s) => s.config_version))).toEqual(new Set([MARKETS.version + 1]));
    for (const s of second) expect(s.version).toBeGreaterThan(first.find((f) => f.day === s.day)?.version ?? 0);
  });

  it('works through the back-fill under its budget, newest day first, across ticks', async () => {
    const ch = await fresh();
    // a fake clock, advanced by 4 s for every closed day computed: the budget of the back-fill is 10 s
    let clock = Date.parse('2015-01-14T19:30:00Z');
    const svc = aggregator(ch, {
      now: () => clock,
      volumeFunctions: {
        computeDailySet: async (...args) => {
          const [, , , , dayDate] = args;
          if (dayDate.getTime() < Date.parse('2015-01-13T00:00:00Z')) clock += 4000;
          return computeDailyVolumeSet(...args);
        },
      },
    });
    await svc.tick(new Date(clock));
    // 4 s a set: sets start at 0, 4 and 8 s; at 12 s the 10 s are spent. Both metrics of the 12th, then the 11th (trade)
    expect(days(await daily(ch, 'trade_volume')).filter((d) => d < '2015-01-13')).toEqual(['2015-01-11', '2015-01-12']);
    expect(days(await daily(ch, 'payment_volume')).filter((d) => d < '2015-01-13')).toEqual(['2015-01-12']);

    for (let i = 0; i < 10; i++) {
      clock += 60_000;
      await svc.tick(new Date(clock));
    }
    for (const metric of ['trade_volume', 'payment_volume']) {
      expect(days(await daily(ch, metric)).filter((d) => d < '2015-01-13')).toEqual([
        '2015-01-08',
        '2015-01-09',
        '2015-01-10',
        '2015-01-11',
        '2015-01-12',
      ]);
    }
  });

  it('recomputes the daily volumes of a day that agg_dirty marks, and only then', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    // the 14th is a closed day two days later: the back-fill computes it, once
    const later = new Date('2015-01-16T12:00:00Z');
    await svc.tick(later);
    const first = await daily(ch, 'trade_volume');
    const sets = first.find((s) => s.day === '2015-01-14') as SetInfo;
    expect(sets.components).toBeGreaterThan(8);
    await svc.tick(later);
    expect((await daily(ch, 'trade_volume')).map((s) => s.version)).toEqual(
      first.map((s) => (s.day >= '2015-01-15' ? expect.any(Number) : s.version)),
    );

    // the ingest rewrote ledgers of the 14th: the range is marked
    await ch.command(
      `INSERT INTO ${Table.AggDirty} (from_hour, to_hour, created_at)
       SELECT toDateTime({from:UInt32}, 'UTC'), toDateTime({to:UInt32}, 'UTC'), fromUnixTimestamp64Milli({created:Int64})`,
      { from: unix('2015-01-14T17:00:00Z'), to: unix('2015-01-14T20:00:00Z'), created: Date.now() - 5000 },
    );
    const beforeDirty = await daily(ch, 'trade_volume');
    await svc.tick(later);
    const afterDirty = await daily(ch, 'trade_volume');
    const of = (list: SetInfo[], d: string): SetInfo => list.find((s) => s.day === d) as SetInfo;
    expect(of(afterDirty, '2015-01-14').version).toBeGreaterThan(of(beforeDirty, '2015-01-14').version);
    expect(of(afterDirty, '2015-01-14').components).toBe(sets.components);
    // both metrics, and no other closed day was touched
    expect((await daily(ch, 'payment_volume')).find((s) => s.day === '2015-01-14')?.version).toBeGreaterThan(
      sets.version,
    );
    for (const d of ['2015-01-08', '2015-01-10', '2015-01-12', '2015-01-13']) {
      expect(of(afterDirty, d).version).toBe(of(beforeDirty, d).version);
    }
    expect(await ch.query(`SELECT * FROM ${Table.AggDirty}`)).toEqual([]);
  });

  it('with an empty config (Xahau before its markets are filled in) the sets are there, empty', async () => {
    const ch = await fresh();
    const empty: MarketsConfig = { version: 1, tradeMarkets: [], paymentCurrencies: [] };
    await aggregator(ch, {}, empty).tick(new Date('2015-01-14T19:30:00Z'));
    const trade = await daily(ch, 'trade_volume');
    expect(trade.length).toBe(7);
    expect(trade.every((s) => s.components === 0)).toBe(true);
    // the native currency is always there
    expect((await daily(ch, 'payment_volume')).find((s) => s.day === '2015-01-14')?.components).toBe(1);
    const live = await ch.query<{ n: string }>(`SELECT countIf(component = '') AS n FROM ${Table.VolumeLive}`);
    expect(Number(live[0].n)).toBe(7);
  });

  describe('the ingest decides which days are closed and final, not the clock', () => {
    /** The components of the newest set of a day: [component, amount, count], by component. */
    async function setOf(ch: ClickHouseService, metric: string, day: string): Promise<[string, string, number][]> {
      const rows = await ch.query<{ component: string; amount: string; count: string }>(
        `SELECT component, amount, toUInt64(count) AS count
           FROM ${Table.VolumeDaily}
          WHERE metric = {metric:String} AND day = {day:Date} AND component != ''
            AND version = (SELECT max(version) FROM ${Table.VolumeDaily} WHERE metric = {metric:String} AND day = {day:Date})
          ORDER BY component`,
        { metric, day },
      );
      return rows.map((r) => [r.component, r.amount, Number(r.count)]);
    }

    it('outage resume: a day whose last hour has not been ingested is not back-filled, and a set made meanwhile is recomputed once the ledgers arrive', async () => {
      const ch = await empty();
      const cutoff = unix('2015-01-14T18:30:00Z');
      const early = day14.filter((l) => l.header.close_time <= cutoff);
      const late = day14.filter((l) => l.header.close_time > cutoff);
      expect(early.length).toBeGreaterThan(5);
      expect(late.length).toBeGreaterThan(5);
      await ch.insert(Table.Ledgers, [FIRST_LEDGER]);
      await new LedgerWriter(ch, ctx).write(early);
      const svc = aggregator(ch);

      // the aggregator runs while the day goes on: the set of today is a snapshot of what is in
      await svc.tick(new Date('2015-01-14T18:31:00Z'));
      const snapshot = await setOf(ch, 'trade_volume', '2015-01-14');
      expect(snapshot.length).toBeGreaterThan(0);
      expect(await finalDays(ch, 'trade_volume')).not.toContain('2015-01-14');

      // three days later the wall clock says that the 14th is over, the ledgers say that the ingest is still in the middle of it
      await svc.tick(new Date('2015-01-17T12:00:00Z'));
      expect(await setOf(ch, 'trade_volume', '2015-01-14')).toEqual(snapshot);
      expect(await finalDays(ch, 'trade_volume')).toEqual([
        '2015-01-08',
        '2015-01-09',
        '2015-01-10',
        '2015-01-11',
        '2015-01-12',
        '2015-01-13',
      ]);
      expect(await finalDays(ch, 'payment_volume')).not.toContain('2015-01-14');

      // the rest of the day and the next hours are ingested
      await new LedgerWriter(ch, ctx).write(late);
      await ch.insert(Table.Ledgers, [LAST_LEDGER]);
      await svc.tick(new Date('2015-01-17T12:01:00Z'));
      expect(await finalDays(ch, 'trade_volume')).toContain('2015-01-14');
      expect(await finalDays(ch, 'payment_volume')).toContain('2015-01-14');

      // the set is the one of a database that was never behind
      const control = await fresh();
      await aggregator(control).tick(new Date('2015-01-17T12:01:00Z'));
      for (const metric of ['trade_volume', 'payment_volume']) {
        expect(await setOf(ch, metric, '2015-01-14')).toEqual(await setOf(control, metric, '2015-01-14'));
      }
      expect(await setOf(ch, 'trade_volume', '2015-01-14')).not.toEqual(snapshot);
    });

    it('an ingest that started at an old ledger leaves no final set, sentinel-only or not, for the days it has not reached', async () => {
      const ch = await empty();
      await ch.insert(Table.Ledgers, [FIRST_LEDGER]);
      await aggregator(ch).tick(new Date('2015-01-17T12:00:00Z'));
      for (const metric of ['trade_volume', 'payment_volume']) {
        // only today and yesterday have a set (the stalest first, whatever the day), and neither is final
        expect((await daily(ch, metric)).map((d) => d.day)).toEqual(['2015-01-16', '2015-01-17']);
        expect(await finalDays(ch, metric)).toEqual([]);
        expect(
          (
            await volumeDaysDone(
              ch,
              metric as 'trade_volume',
              new Date('2015-01-01T00:00:00Z'),
              new Date('2015-02-01T00:00:00Z'),
              MARKETS.version,
            )
          ).size,
        ).toBe(0);
      }
    });

    it('a day is closed an hour after its end in LEDGER time, whatever the real clock says (ledgers placed relative to the real today)', async () => {
      const DAY = 86_400;
      const base = Math.floor(Date.now() / 1000 / DAY) * DAY;
      const text = (offset: number): string => new Date((base + offset) * 1000).toISOString().slice(0, 10);
      const ledgerAt = (index: number, offset: number) => ({
        ...SAMPLE_ROWS[Table.Ledgers],
        ledger_index: index,
        ledger_hash: String(index).padStart(64, 'D'),
        close_time: base + offset,
      });
      const ch = await empty();
      // the ingest started 6 days ago and is two days behind the clock: the newest ledger closed 30 minutes into the day that
      // began two days ago, so the day before it (three days ago) is over by less than the hour
      await ch.insert(Table.Ledgers, [
        ledgerAt(100, -6 * DAY + 10 * 3600),
        ledgerAt(101, -3 * DAY + 12 * 3600),
        ledgerAt(102, -2 * DAY + 1800),
      ]);
      const svc = aggregator(ch);
      await svc.tick();
      expect(await finalDays(ch, 'trade_volume')).toEqual([text(-6 * DAY), text(-5 * DAY), text(-4 * DAY)]);
      expect((await daily(ch, 'trade_volume')).map((d) => d.day)).toEqual([
        text(-6 * DAY),
        text(-5 * DAY),
        text(-4 * DAY),
        text(-DAY),
        text(0),
      ]);

      // the ingest gets an hour into that day: the day three days ago is closed now, and the one two days ago is not
      await ch.insert(Table.Ledgers, [ledgerAt(103, -2 * DAY + 3600)]);
      await svc.tick();
      expect(await finalDays(ch, 'trade_volume')).toEqual([
        text(-6 * DAY),
        text(-5 * DAY),
        text(-4 * DAY),
        text(-3 * DAY),
      ]);
      expect(await finalDays(ch, 'payment_volume')).toEqual([
        text(-6 * DAY),
        text(-5 * DAY),
        text(-4 * DAY),
        text(-3 * DAY),
      ]);
    });
  });
});
