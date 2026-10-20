import {
  ACCOUNT_PARTITION_ROWS_FLOOR,
  ACCOUNT_ROLLUP_CONFIG_VERSION,
  ClickHouseService,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  pairHourSets,
  parseContextFor,
  partitionSetVersions,
  RatesService,
  rollupStates,
  runMigrations,
  Table,
  validRateDays,
} from '@gatehub/data-api-shared';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { readDirtyRanges } from '../src/aggregator/agg-dirty';
import { defaultAggregateFunctions } from '../src/aggregator/aggregate-job-deps';
import { AggregatorOptions, AggregatorService } from '../src/aggregator/aggregator.service';

/**
 * The account and market jobs of the `AggregatorService` against a real ClickHouse, together with the stats jobs: the 54 mock
 * ledgers of the original Ripple test suite (2013 to 2017; 41 of them on 2015-01-14, 17:29 - 19:10 UTC), written by the real
 * `LedgerWriter`, ticked at `NOW`, the noon after the trades. The sets themselves are checked against oracles in
 * `packages/shared/test`; here it is the registration that is on trial: that the jobs run together and write what they should,
 * that their back-fills go on where they stopped after a restart, and that a range of `agg_dirty` reaches them all.
 *
 * Two things about the world. The newest ledger (2017) closed long after `NOW`, so every hour and day before `NOW` is final.
 * And no account of the mock has the 10,000 balance changes in one partition that the discovery of heavy accounts keeps
 * (`ACCOUNT_PARTITION_ROWS_FLOOR`; `GH_ACCOUNT_ROLLUP_MIN_ROWS` can only raise that bar), so one account with that many is
 * added, on a ledger of 2015-01-14.
 */

const SHARED_TEST = join(__dirname, '../../../packages/shared/test');
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const ledgers = FixtureLedgerSource.fromDir(join(SHARED_TEST, 'fixtures/xrpl/ripple-mock')).list();

const unix = (text: string): number => Date.parse(text) / 1000;
/** The time of the ticks: noon of the day after the trades. */
const NOW = new Date('2015-01-15T12:00:00Z');
/** The account that is heavy, and the ledger (2015-01-14T18:27:10Z) its balance changes are on. */
const HEAVY = 'rHeavyAccount'.padEnd(34, 'x');
const HEAVY_LEDGER = 11_119_600;
const NOOP = (): void => undefined;

/** The metrics of the aggregator and of the account and market jobs, over fakes. */
const fakeMetrics = () => ({
  aggregatorRunsTotal: { inc: jest.fn() },
  aggregatorErrorsTotal: { inc: jest.fn() },
  aggregatorStatsLagSeconds: { set: jest.fn() },
  pairHourlyMissingHours: { set: jest.fn() },
  marketsLiveAgeSeconds: { set: jest.fn() },
  ratesDailyMissingDays: { set: jest.fn() },
  accountRollupsHeavyAccounts: { set: jest.fn() },
  accountRollupsPendingAccounts: { set: jest.fn() },
});
type FakeMetrics = ReturnType<typeof fakeMetrics>;

describe('AggregatorService account and market jobs (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  const aggregators: AggregatorService[] = [];
  let dbCounter = 0;

  beforeAll(async () => {
    container = await startClickHouse();
  });

  afterAll(async () => {
    for (const svc of aggregators) await svc.stop();
    for (const svc of services) await svc.onModuleDestroy();
    await container?.container.stop();
  });

  /** The 54 mock ledgers, and the heavy account, in a migrated database of its own. */
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_aggregates_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    // The ledgers are of 2015 and the server's clock is real: a TTL merge would drop the pair_hourly rows (45 days) as they come.
    await svc.command(`SYSTEM STOP TTL MERGES ${config.database}.${Table.PairHourly}`);
    // A merge keeps the newest version of a key only; the tests compare a set with the one it replaced.
    for (const table of [Table.PairHourly, Table.NativeRatesDaily, Table.AccountRollupDays]) {
      await svc.command(`SYSTEM STOP MERGES ${config.database}.${table}`);
    }
    await new LedgerWriter(svc, ctx).write(ledgers);
    await svc.command(
      `INSERT INTO ${Table.BalanceChanges}
         (account, ledger_index, tx_index, node_index, close_time, currency, counterparty, amount_change, final_balance, final_balance_f, change_type)
       SELECT {account:String}, {ledger:UInt32}, toUInt32(number), 0, toDateTime('2015-01-14 18:27:10', 'UTC'),
              'USD', 'rIssuer', '1', toString(number), toFloat64(number), 'payment_destination'
         FROM numbers({n:UInt64})`,
      { account: HEAVY, ledger: HEAVY_LEDGER, n: ACCOUNT_PARTITION_ROWS_FLOOR },
    );
    return svc;
  }

  /**
   * An aggregator with the account and market jobs (and the stats jobs; the volume jobs have their own e2e), with `aggregates`
   * over the mock's rates and 5 as the size of a heavy account. Its errors are collected in `errors`.
   */
  function aggregator(
    ch: ClickHouseService,
    metrics: FakeMetrics,
    options: AggregatorOptions = {},
  ): { svc: AggregatorService; errors: jest.Mock } {
    const errors = jest.fn();
    const svc = new AggregatorService(ch, metrics as never, undefined, {
      logger: { log: NOOP, warn: NOOP, debug: NOOP, error: errors },
      aggregates: { rates: new RatesService(ch, 'XRP'), accountRollupMinRows: 5 },
      ...options,
    });
    aggregators.push(svc);
    return { svc, errors };
  }

  /** Budgets that are never the limit of a tick or of a job (a slow machine must not make a test of what is written flaky). */
  const GENEROUS: AggregatorOptions = {
    tickBudgetMs: 10 * 60_000,
    budgetsMs: {
      pair_hourly: 5 * 60_000,
      markets_live: 5 * 60_000,
      rates_daily: 5 * 60_000,
      account_rollups: 5 * 60_000,
    },
  };

  const runs = (metrics: FakeMetrics): string[] =>
    metrics.aggregatorRunsTotal.inc.mock.calls.map(([labels]) => labels.job);

  /** The hours (`YYYY-MM-DD HH:mm:ss`) that have a set in `pair_hourly`: the sentinels, the empty pair. */
  async function pairHours(ch: ClickHouseService): Promise<string[]> {
    const rows = await ch.query<{ hour: string }>(
      `SELECT DISTINCT toString(hour) AS hour FROM ${Table.PairHourly}
        WHERE base_currency = '' AND counter_currency = '' ORDER BY hour`,
    );
    return rows.map((r) => r.hour);
  }

  /** `[version, stale]` of every sentinel written for a day of `native_rates_daily`, oldest first (merges are stopped). */
  async function rateSentinels(ch: ClickHouseService, day: string): Promise<Array<[number, number]>> {
    const rows = await ch.query<{ version: number | string; stale: number | string }>(
      `SELECT toUInt64(version) AS version, stale FROM ${Table.NativeRatesDaily}
        WHERE currency = '' AND issuer = '' AND day = {day:Date} ORDER BY version`,
      { day },
    );
    return rows.map((r): [number, number] => [Number(r.version), Number(r.stale)]);
  }

  /** The versions of the sentinels of an (account, day) rollup set, oldest first (merges are stopped). */
  async function rollupSentinels(ch: ClickHouseService, account: string, day: string): Promise<number[]> {
    const rows = await ch.query<{ version: number | string }>(
      `SELECT toUInt64(version) AS version FROM ${Table.AccountRollupDays}
        WHERE account = {account:String} AND day = {day:Date} ORDER BY version`,
      { account, day },
    );
    return rows.map((r) => Number(r.version));
  }

  const versionsOfHours = async (ch: ClickHouseService, from: string, to: string): Promise<Map<number, number>> =>
    new Map([...(await pairHourSets(ch, unix(from), unix(to)))].map(([hour, set]) => [hour, set.version]));

  it('the jobs run together within the tick', async () => {
    const ch = await fresh();
    const metrics = fakeMetrics();
    const { svc, errors } = aggregator(ch, metrics, GENEROUS);
    await svc.tick(NOW);

    // every job ran to its end, and none failed
    expect(runs(metrics)).toEqual([
      'pair_hourly',
      'markets_live',
      'stats_live',
      'stats_dirty',
      'rates_daily',
      'account_rollups',
    ]);
    expect(errors).not.toHaveBeenCalled();
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();

    // pair_hourly: every hour of the last 31 days, this one included, and the trades of the 14th in the hours they were made in
    const hours = await pairHours(ch);
    expect(hours).toHaveLength(31 * 24 + 1);
    expect(hours[0]).toBe('2014-12-15 12:00:00');
    expect(hours[hours.length - 1]).toBe('2015-01-15 12:00:00');
    const traded = await ch.query<{ hour: string }>(
      `SELECT DISTINCT toString(hour) AS hour FROM ${Table.PairHourly} WHERE base_currency != '' ORDER BY hour`,
    );
    expect(traded.map((r) => r.hour)).toEqual(['2015-01-14 18:00:00', '2015-01-14 19:00:00']);
    expect(metrics.pairHourlyMissingHours.set).toHaveBeenLastCalledWith(0);

    // markets_live: the day set (the first run of the job is a long one: all three periods), made of those hours
    const markets = await ch.query<{ period: string; amm: string; pairs: number | string }>(
      `SELECT period, amm, pairs_traded AS pairs FROM ${Table.MarketsLive} WHERE base_currency = '' ORDER BY period`,
    );
    expect(markets.map((r) => `${r.period}/${r.amm}`)).toEqual(['30day/include', '7day/include', 'day/include']);
    expect(Number(markets.find((r) => r.period === 'day')?.pairs)).toBeGreaterThan(0);

    // rates_daily: the days with trades against the native currency, from the first one to the newest final day (the 14th)
    const rateDays = await ch.query<{ day: string }>(
      `SELECT DISTINCT toString(day) AS day FROM ${Table.NativeRatesDaily} WHERE currency = '' AND issuer = ''`,
    );
    expect(rateDays.map((r) => r.day)).toEqual(['2015-01-14']);
    expect(metrics.ratesDailyMissingDays.set).toHaveBeenLastCalledWith(0);

    // account_rollups: the set of each partition of balance_changes (the mock's ledgers are in 0, 1 and 2), the account that is
    // heavy in the partition of the 14th, and its day
    const partitions = await ch.query<{ partition: number; account: string; rows: number | string }>(
      `SELECT partition, account, rows FROM ${Table.AccountPartitionRows} ORDER BY partition, account`,
    );
    expect(partitions.map((r) => `${r.partition}/${r.account === '' ? '-' : r.account}`)).toEqual([
      '0/-',
      '1/-',
      `1/${HEAVY}`,
      '2/-',
    ]);
    expect(Number(partitions[2].rows)).toBe(ACCOUNT_PARTITION_ROWS_FLOOR);
    expect([...(await rollupStates(ch)).values()]).toEqual([
      {
        account: HEAVY,
        rows: ACCOUNT_PARTITION_ROWS_FLOOR,
        firstDay: '2015-01-14',
        rolledFrom: '2015-01-14',
        rolledThrough: '2015-01-14',
        configVersion: ACCOUNT_ROLLUP_CONFIG_VERSION,
      },
    ]);
    expect(await rollupSentinels(ch, HEAVY, '2015-01-14')).toHaveLength(1);
    expect(metrics.accountRollupsHeavyAccounts.set).toHaveBeenLastCalledWith(1);
    expect(metrics.accountRollupsPendingAccounts.set).toHaveBeenLastCalledWith(0);
  });

  it('the back-fills resume after a restart', async () => {
    // 27 days to compute the rates of (the 14th of January to the 9th of February) and the hours of 31 days to compute, with budgets
    // that allow a few sets a tick: the clock of the aggregator is a fake that moves a second for every set that is written (and
    // 15 ms for every slice of a partition's recount, about a second for its 58), so that how many sets a tick makes does not
    // depend on how fast the machine is.
    const later = new Date('2015-02-10T12:00:00Z');
    const ch = await fresh();
    let clock = later.getTime();
    const real = defaultAggregateFunctions();
    const aggregatorOf = (): AggregatorService =>
      aggregator(ch, fakeMetrics(), {
        now: () => clock,
        budgetsMs: { pair_hourly: 3500, rates_daily: 2500, account_rollups: 2500 },
        aggregateFunctions: {
          computePairHourSets: async (...args) => {
            const written = await real.computePairHourSets(...args);
            clock += 1000;
            return written;
          },
          computeRatesDailySet: async (...args) => {
            const written = await real.computeRatesDailySet(...args);
            clock += 1000;
            return written;
          },
          countPartitionSlice: async (...args) => {
            const counted = await real.countPartitionSlice(...args);
            clock += 15;
            return counted;
          },
        },
      }).svc;
    const hourFrom = unix('2015-01-10T12:00:00Z');
    const hourTo = unix('2015-02-10T13:00:00Z');
    /** The days of the rates still to compute, and the hours of the last 31 days that have no set. */
    const missing = async (): Promise<{ days: number; hours: number }> => ({
      days: 27 - (await validRateDays(ch, '2015-01-14', '2015-02-09')).size,
      hours: 31 * 24 + 1 - (await pairHourSets(ch, hourFrom, hourTo)).size,
    });
    const tickTwice = async (svc: AggregatorService): Promise<void> => {
      for (let i = 0; i < 2; i++) {
        await svc.tick(later);
        clock += 60_000;
      }
    };

    const first = aggregatorOf();
    await first.tick(later);
    clock += 60_000;
    // the first tick counted partitions 2 and 1 and the first slices of 0 (2.5 s); the second goes on with the slices of 0
    expect([...(await partitionSetVersions(ch)).keys()].sort()).toEqual([1, 2]);
    await first.tick(later);
    clock += 60_000;
    await first.stop();
    const afterFirst = await missing();
    expect(afterFirst.days).toBeLessThan(27);
    expect(afterFirst.hours).toBeLessThan(31 * 24 + 1);
    const ratesDone = await validRateDays(ch, '2015-01-14', '2015-02-09');
    const hoursDone = await pairHourSets(ch, hourFrom, hourTo);
    const partitionsDone = await partitionSetVersions(ch);
    expect([...partitionsDone.keys()].sort()).toEqual([0, 1, 2]);

    // a new aggregator, with nothing in memory, goes on from what the database holds
    const second = aggregatorOf();
    await tickTwice(second);
    const afterSecond = await missing();
    expect(afterSecond.days).toBeLessThan(afterFirst.days);
    expect(afterSecond.hours).toBeLessThan(afterFirst.hours);

    // and does not do again what is done: no day of the rates, no hour but the current one (the live hour is written at every
    // tick) and no partition has a new version
    const ratesNow = await validRateDays(ch, '2015-01-14', '2015-02-09');
    for (const [day, version] of ratesDone) expect({ day, version: ratesNow.get(day) }).toEqual({ day, version });
    const hoursNow = await pairHourSets(ch, hourFrom, hourTo);
    const current = unix('2015-02-10T12:00:00Z');
    for (const [hour, set] of hoursDone) {
      if (hour !== current)
        expect({ hour, version: hoursNow.get(hour)?.version }).toEqual({ hour, version: set.version });
    }
    expect(await partitionSetVersions(ch)).toEqual(partitionsDone);
  });

  it('an agg_dirty range marks rates stale and recomputes hours and heavy-account days', async () => {
    const ch = await fresh();
    const metrics = fakeMetrics();
    const { svc, errors } = aggregator(ch, metrics, GENEROUS);
    // everything is computed: rates for the 14th, the hours of the last 31 days, the heavy account's 14th
    await svc.tick(NOW);
    const ratesBefore = await validRateDays(ch, '2015-01-14', '2015-01-28');
    const hoursBefore = await versionsOfHours(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z');
    const rollupBefore = await rollupSentinels(ch, HEAVY, '2015-01-14');
    // (only the days that have a valid set are marked: of the 14th to the 28th, the 14th is the one that is over)
    expect([...ratesBefore.keys()]).toEqual(['2015-01-14']);
    expect(hoursBefore.size).toBe(3);
    expect(rollupBefore).toHaveLength(1);

    // the ingest rewrote the ledgers of the 14th between 18:00 and 19:00, as range-ingest marks them; and ledgers of 2013, which
    // are outside the last 31 days
    const marked = (from: string, to: string) => ({
      from_hour: unix(from),
      to_hour: unix(to),
      created_at: Date.now() / 1000,
    });
    await ch.insert(Table.AggDirty, [
      marked('2015-01-14T18:00:00Z', '2015-01-14T19:00:00Z'),
      marked('2013-06-11T20:00:00Z', '2013-06-11T21:00:00Z'),
    ]);
    metrics.aggregatorRunsTotal.inc.mockClear();
    await svc.tick(NOW);
    expect(errors).not.toHaveBeenCalled();
    expect(metrics.aggregatorErrorsTotal.inc).not.toHaveBeenCalled();

    // the rates of the days it touched (the 14th to the 28th): marked stale, then computed again by rates_daily, a newer set each.
    // A day without a set (the 15th to the 28th are not over) is not marked: it has no sentinel at all.
    expect(
      await ch.query(
        `SELECT day FROM ${Table.NativeRatesDaily} WHERE day >= '2015-01-15' AND day <= '2015-01-28' LIMIT 1`,
      ),
    ).toEqual([]);
    for (const [day, version] of ratesBefore) {
      const sentinels = await rateSentinels(ch, day);
      expect(sentinels.map(([, stale]) => stale)).toEqual([0, 1, 0]);
      expect(sentinels[0][0]).toBe(version);
      expect(sentinels[1][0]).toBeGreaterThan(sentinels[0][0]);
      expect(sentinels[2][0]).toBeGreaterThan(sentinels[1][0]);
    }
    expect([...(await validRateDays(ch, '2015-01-14', '2015-01-28')).keys()]).toEqual(['2015-01-14']);

    // the hours of the range are computed again, the hours next to it are not, and an hour of 2013 is not made
    const hoursAfter = await versionsOfHours(ch, '2015-01-14T17:00:00Z', '2015-01-14T20:00:00Z');
    const [h17, h18, h19] = ['17', '18', '19'].map((h) => unix(`2015-01-14T${h}:00:00Z`));
    expect(hoursAfter.get(h18)).toBeGreaterThan(hoursBefore.get(h18) as number);
    expect(hoursAfter.get(h17)).toBe(hoursBefore.get(h17));
    expect(hoursAfter.get(h19)).toBe(hoursBefore.get(h19));
    expect(await pairHours(ch)).not.toContain('2013-06-11 20:00:00');

    // the day of the heavy account: a newer sentinel
    const rollupAfter = await rollupSentinels(ch, HEAVY, '2015-01-14');
    expect(rollupAfter).toHaveLength(2);
    expect(rollupAfter[1]).toBeGreaterThan(rollupBefore[0]);

    // and the ranges are gone
    expect(await readDirtyRanges(ch, 10)).toEqual([]);
  });
});
