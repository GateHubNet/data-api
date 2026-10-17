import {
  AMM_DAILY_CONFIG_VERSION,
  ammDaysDone,
  ClickHouseService,
  ExchangesRow,
  FixtureLedgerSource,
  getNetworkProfile,
  LedgerWriter,
  parseContextFor,
  RatesService,
  runMigrations,
  Table,
} from '@gatehub/data-api-shared';
import { join } from 'node:path';
import { startClickHouse, StartedClickHouse } from '../../../packages/shared/test/clickhouse-container';
import { AggregatorService } from '../src/aggregator/aggregator.service';

/**
 * The `amm_daily` job of the `AggregatorService` against a real ClickHouse: the whole mainnet ledgers of the AMM fixtures
 * (swaps, deposits, withdrawals, votes, bids, a create and a delete), written by the real `LedgerWriter`. What a day holds is
 * checked against an oracle in `packages/shared/test/amm-daily-job.e2e-spec.ts`; here it is the job that is on trial: the
 * cadence, what a tick writes (today, yesterday, the back-fill of the closed days), that a closed day is computed once and the
 * state survives a restart, and the hook of `agg_dirty`.
 */

const SHARED_TEST = join(__dirname, '../../../packages/shared/test');
const ctx = parseContextFor(getNetworkProfile('xrpl'));
const ALL = FixtureLedgerSource.fromDir(join(SHARED_TEST, 'fixtures/xrpl/amm')).list();
/** The ledgers of the last ten days of the fixtures: the older ones are a year back, which is a few hundred empty days to fill. */
const RECENT = ALL.filter((l) => l.header.close_time >= Date.parse('2026-10-08T00:00:00Z') / 1000);
const QUIET = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

const RLUSD_POOL = 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3';
const NEWEST_CLOSE = Math.max(...ALL.map((l) => l.header.close_time));
/** Two hours after the newest ledger (2026-10-17T08:42:50Z): the stats have nothing to do but jump from ledger to ledger. */
const NOW = new Date((NEWEST_CLOSE + 7200) * 1000);
const TODAY = '2026-10-17';
const YESTERDAY = '2026-10-16';
const MINUTE = 60_000;

interface StoredDay {
  amm_account: string;
  day: string;
  swap_count: number;
  volume_base: string;
  final: number;
  config_version: number;
  version: number;
}

type DayRow = Omit<StoredDay, 'day'> & { day_text: string };

const stored = ({ day_text, ...r }: DayRow): StoredDay => ({
  ...r,
  day: day_text,
  swap_count: Number(r.swap_count),
  version: Number(r.version),
});

describe('AggregatorService amm_daily job (e2e)', () => {
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

  /** A migrated database with ledgers in it. */
  async function fresh(ledgers = RECENT): Promise<ClickHouseService> {
    const config = { ...container.config, database: `aggregator_amm_daily_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    await new LedgerWriter(svc, ctx).write(ledgers);
    return svc;
  }

  /**
   * An aggregator that has the `amm_daily` job and, of the stats, only the walk from ledger to ledger (the stats have their own
   * tests), with the budgets of a test: all of the back-fill in one run, which the real one spreads over many.
   */
  function aggregator(ch: ClickHouseService, ammDailyEveryTicks?: number): AggregatorService {
    const svc = new AggregatorService(ch, undefined, undefined, {
      logger: QUIET,
      ammDaily: { rates: new RatesService(ch, 'XRP') },
      ammDailyEveryTicks,
      recompute: async () => 0,
      tickBudgetMs: 10 * MINUTE,
      budgetsMs: { amm_daily: 10 * MINUTE },
    });
    aggregators.push(svc);
    return svc;
  }

  /** The newest sentinel of each day: its version, config version and finality. */
  async function sentinels(ch: ClickHouseService): Promise<Map<string, StoredDay>> {
    const rows = await ch.query<DayRow>(
      `SELECT toString(day) AS day_text, amm_account, swap_count, volume_base, final, config_version, toUInt64(version) AS version
         FROM ${Table.AmmDaily}
        WHERE amm_account = ''
        ORDER BY day, version DESC
        LIMIT 1 BY day`,
    );
    return new Map(rows.map((r) => [r.day_text, stored(r)]));
  }

  /** The pool rows of the set of a day, as a reader reads them: the version of the sentinel. */
  async function pools(ch: ClickHouseService, day: string): Promise<Map<string, StoredDay>> {
    const sentinel = (await sentinels(ch)).get(day);
    if (!sentinel) return new Map();
    const rows = await ch.query<DayRow>(
      `SELECT toString(day) AS day_text, amm_account, swap_count, volume_base, final, config_version, toUInt64(version) AS version
         FROM ${Table.AmmDaily}
        WHERE amm_account != '' AND day = {day:Date} AND version = {version:UInt64}`,
      { day, version: sentinel.version },
    );
    return new Map(rows.map((r) => [r.amm_account, stored(r)]));
  }

  const rowCount = async (ch: ClickHouseService): Promise<number> =>
    Number((await ch.queryOne<{ n: string | number }>(`SELECT count() AS n FROM ${Table.AmmDaily}`))?.n);

  const daysBetween = (first: string, last: string): string[] => {
    const out: string[] = [];
    for (let t = Date.parse(first); t <= Date.parse(last); t += 86_400_000)
      out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  };

  it('the first tick writes today, yesterday and every closed day since the first pool activity, the closed days final', async () => {
    const ch = await fresh();
    expect(await rowCount(ch)).toBe(0);
    await aggregator(ch).tick(NOW);
    const days = await sentinels(ch);

    expect([...days.keys()]).toEqual(daysBetween('2026-10-08', TODAY));
    for (const [day, sentinel] of days) {
      expect({ day, final: sentinel.final, config: sentinel.config_version }).toEqual({
        day,
        final: day < TODAY ? 1 : 0, // the newest ledger is in today
        config: AMM_DAILY_CONFIG_VERSION,
      });
    }
    const yesterday = await pools(ch, YESTERDAY);
    expect(yesterday.size).toBe(11);
    expect(yesterday.get(RLUSD_POOL)).toMatchObject({ swap_count: 3, volume_base: '543.870850376' });
    expect([...(await pools(ch, TODAY)).keys()]).toEqual([RLUSD_POOL]);
    // the days without a pool touched are sentinels alone
    expect((await pools(ch, '2026-10-09')).size).toBe(0);
    expect((await pools(ch, '2026-10-12')).size).toBe(4);
  });

  it('runs at the first tick and then at every fifth: the four between write nothing', async () => {
    const ch = await fresh();
    const svc = aggregator(ch);
    await svc.tick(NOW);
    const written = await rowCount(ch);
    const first = await sentinels(ch);

    for (let i = 0; i < 4; i++) await svc.tick(NOW);
    expect(await rowCount(ch)).toBe(written);

    await svc.tick(NOW); // the sixth tick
    const second = await sentinels(ch);
    // today and yesterday are written again under a newer version ...
    for (const day of [TODAY, YESTERDAY]) {
      expect(second.get(day)?.version).toBeGreaterThan(first.get(day)?.version as number);
    }
    // ... and a closed day, which is final, is not
    for (const [day, sentinel] of first) if (day < YESTERDAY) expect(second.get(day)?.version).toBe(sentinel.version);
    expect(await rowCount(ch)).toBeGreaterThan(written);
  });

  it('a restarted aggregator finds the closed days done in the tables, and writes today and yesterday only', async () => {
    const ch = await fresh();
    await aggregator(ch).tick(NOW);
    const before = await sentinels(ch);

    await aggregator(ch).tick(NOW);
    const after = await sentinels(ch);
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [day, sentinel] of before) {
      if (day < YESTERDAY) expect(after.get(day)).toEqual(sentinel);
      else expect(after.get(day)?.version).toBeGreaterThan(sentinel.version);
    }
    expect(
      await ammDaysDone(
        ch,
        AMM_DAILY_CONFIG_VERSION,
        daysBetween('2026-10-08', '2026-10-15').map((d) => new Date(`${d}T00:00:00Z`)),
      ),
    ).toEqual(new Set(daysBetween('2026-10-08', '2026-10-15')));
  });

  it('a day computed while the ingest was behind it is computed again once the ingest has passed it', async () => {
    const ch = await fresh(RECENT.filter((l) => l.header.close_time < Date.parse('2026-10-16T14:00:00Z') / 1000));
    const svc = aggregator(ch, 1);
    // the newest ledger is the one of 2026-10-16 at 12:13, and the clock is on the 17th: yesterday is not final yet
    await svc.tick(NOW);
    expect((await sentinels(ch)).get(YESTERDAY)?.final).toBe(0);
    expect((await sentinels(ch)).get('2026-10-15')?.final).toBe(1);

    // the rest of the ledgers arrive (the live ingest goes on)
    await new LedgerWriter(ch, ctx).write(
      RECENT.filter((l) => l.header.close_time >= Date.parse('2026-10-16T14:00:00Z') / 1000),
    );
    await svc.tick(NOW);
    expect((await sentinels(ch)).get(YESTERDAY)?.final).toBe(1);
    expect((await pools(ch, YESTERDAY)).size).toBe(11);
  });

  it('a closed day with a changed config version is computed again', async () => {
    const ch = await fresh();
    const svc = aggregator(ch, 1);
    await svc.tick(NOW);
    const before = (await sentinels(ch)).get('2026-10-13') as StoredDay;
    // the sets of the day were made by an older computation
    await ch.command(
      `INSERT INTO ${Table.AmmDaily} (amm_account, day, base_currency, base_issuer, counter_currency, counter_issuer, swap_count,
         volume_base, volume_counter, fees_base_est, fees_counter_est, deposit_count, withdraw_count, liquidity_in_base,
         liquidity_in_counter, liquidity_out_base, liquidity_out_counter, final, config_version, version)
       SELECT '', day, '', '', '', '', 0, '0', '0', '0', '0', 0, 0, '0', '0', '0', '0', 1, config_version + 7, version + 1000
         FROM ${Table.AmmDaily} WHERE amm_account = '' AND day = {day:Date} LIMIT 1`,
      { day: '2026-10-13' },
    );
    expect((await sentinels(ch)).get('2026-10-13')?.config_version).toBe(AMM_DAILY_CONFIG_VERSION + 7);
    await svc.tick(NOW);
    const after = (await sentinels(ch)).get('2026-10-13') as StoredDay;
    expect(after.config_version).toBe(AMM_DAILY_CONFIG_VERSION);
    expect(after.version).toBeGreaterThan(before.version + 1000);
    expect((await pools(ch, '2026-10-13')).size).toBe(19);
  });

  it('the days of an agg_dirty range are recomputed although they are done, and only those', async () => {
    const ch = await fresh();
    const svc = aggregator(ch, 1000); // the job runs at the first tick only: the rest is the hook of the dirty queue
    await svc.tick(NOW);
    const before = await sentinels(ch);
    const poolsBefore = await pools(ch, '2026-10-13');

    // a ledger of the 13th was written again behind the aggregator: one more swap of a pool of that day, and its range marked
    const [account] = [...poolsBefore.keys()];
    const template = (await ch.queryOne<ExchangesRow>(
      `SELECT * FROM ${Table.Exchanges} WHERE amm_account = {account:String} AND toDate(close_time) = '2026-10-13' LIMIT 1`,
      { account },
    )) as ExchangesRow;
    await ch.insert(Table.Exchanges, [{ ...template, tx_index: 9999, tx_hash: 'AB'.repeat(32) }]);
    const closeTime = Number(
      (
        await ch.queryOne<{ t: string }>(
          `SELECT toUnixTimestamp(close_time) AS t FROM ${Table.Ledgers} WHERE ledger_index = {l:UInt32}`,
          {
            l: template.ledger_index,
          },
        )
      )?.t,
    );
    const hour = Math.floor(closeTime / 3600) * 3600;
    await ch.command(
      `INSERT INTO ${Table.AggDirty} (from_hour, to_hour, created_at)
       SELECT toDateTime({from:UInt32}, 'UTC'), toDateTime({to:UInt32}, 'UTC'), fromUnixTimestamp64Milli({created:Int64})`,
      { from: hour, to: hour + 3600, created: Date.now() - 5000 },
    );
    await svc.tick(NOW); // job off the cadence: the hook alone

    const after = await sentinels(ch);
    expect(after.get('2026-10-13')?.version).toBeGreaterThan(before.get('2026-10-13')?.version as number);
    expect((await pools(ch, '2026-10-13')).get(account)?.swap_count).toBe(
      (poolsBefore.get(account)?.swap_count as number) + 1,
    );
    for (const [day, sentinel] of before) if (day !== '2026-10-13') expect(after.get(day)).toEqual(sentinel);
    expect(await ch.query(`SELECT * FROM ${Table.AggDirty}`)).toEqual([]);
  });

  it('over the whole fixtures, from January 2025: every closed day since the first pool is final, the days without a pool sentinels', async () => {
    const ch = await fresh(ALL);
    await aggregator(ch).tick(NOW);
    const days = await sentinels(ch);
    expect([...days.keys()]).toEqual(daysBetween('2025-01-24', TODAY));
    expect([...days.values()].filter((s) => s.final === 1)).toHaveLength(days.size - 1);
    expect((await pools(ch, '2025-01-24')).size).toBe(12);
    expect((await pools(ch, '2025-11-11')).size).toBe(15);
    const withPools = (
      await ch.query<{ day: string }>(
        `SELECT DISTINCT toString(day) AS day FROM ${Table.AmmDaily} WHERE amm_account != '' ORDER BY day`,
      )
    ).map((r) => r.day);
    expect(withPools).toEqual([
      '2025-01-24',
      '2025-11-11',
      '2026-02-12',
      '2026-06-29',
      '2026-08-05',
      '2026-10-08',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-16',
      '2026-10-17',
    ]);
  });
});
