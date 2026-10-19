import BigNumber from 'bignumber.js';
import { computeRatesDailySet, markRatesStale, validRateDays } from '../src/aggregate/rates-daily.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { ExchangesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { Asset, assetKey, canonicalPair } from '../src/query/asset';
import { DailyRates, newestValidRateDay, RateCache } from '../src/query/daily-rates';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

/**
 * `DailyRates` and `newestValidRateDay` on a real ClickHouse: the rates of assets for days, from the `native_rates_daily`
 * sets where the day has a valid one and computed on read where it has not, have to be the rates `dailyNativeRates` gives
 * for every asset and day, whichever of the two a day comes from.
 *
 * The world is synthetic trades written straight into `ledgers` and `exchanges` (a ledger for every second that has a
 * trade), 26 days from 2016-06-01: two busy pairs (the native currency stored as counter in one and as base in the other),
 * a quiet pair that has a rate on some days only, a pair without the native currency, and an asset that never traded.
 */

const SEC = 1000;
const HOUR = 3600;
const DAY = 86_400;

/** Day 0 of the world: 2016-06-01 00:00:00 UTC. */
const BASE = Date.UTC(2016, 5, 1) / SEC;
const at = (day: number, seconds = 0): number => BASE + day * DAY + seconds;
const dateOf = (day: number): Date => new Date(at(day) * SEC);
const dayText = (day: number): string => dateOf(day).toISOString().slice(0, 10);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const issued = (currency: string): Asset => ({ currency, issuer: ISSUER });
const XRP: Asset = { currency: 'XRP' };
const USD = issued('USD'); // busy; the native currency is the stored counter
const ZZZ = issued('ZZZ'); // busy; the native currency is the stored base
const QUT = issued('QUT'); // 12 trades on days 4 to 7: a rate on some days only
const EUR = issued('EUR'); // trades against USD only: never a rate
const NON = issued('NON'); // never traded

const ASSETS = [XRP, USD, ZZZ, QUT, EUR, NON];
const ISSUED = ASSETS.filter((asset) => asset.issuer);
/** Before the first ledger, the world, and long after the last trade. */
const DAYS = range(-2, 30);

/** A trade: the close time in unix seconds, then the amounts of the left and the right asset of the market. */
type Trade = [close: number, left: string, right: string];
interface Market {
  left: Asset;
  right: Asset;
  trades: Trade[];
}

/** XRP per USD: a different price on every day and trade, in quarters. */
const price = (day: number, i: number): number => 2 + ((day * 7 + i * 3) % 11) / 4;

function worldMarkets(): Market[] {
  const usd = range(0, 25)
    .filter((day) => day < 17 || day > 19) // three days without a trade
    .flatMap((day) => [1, 7, 13, 19].map((hour, i): Trade => [at(day, hour * HOUR), '10', String(10 * price(day, i))]));
  const zzz = range(0, 25).flatMap((day) =>
    [2, 10, 18].map((hour): Trade => [at(day, hour * HOUR), String(30 + ((day + hour) % 7)), '10']),
  );
  const qut = range(4, 7).flatMap((day) =>
    [4, 12, 20].map((hour, i): Trade => [at(day, hour * HOUR), '10', String(20 + day + i)]),
  );
  const eur = range(0, 25).flatMap((day): Trade[] => [
    [at(day, 3 * HOUR), '4', '5'],
    [at(day, 15 * HOUR), '4', '6'],
  ]);
  return [
    { left: USD, right: XRP, trades: usd },
    { left: ZZZ, right: XRP, trades: zzz },
    { left: QUT, right: XRP, trades: qut },
    { left: EUR, right: USD, trades: eur },
  ];
}

/** Writes a ledger for every second that has a trade and the trades, in the stored orientation of each pair. */
async function seedWorld(ch: ClickHouseService): Promise<void> {
  const markets = worldMarkets();
  const closes = [...new Set(markets.flatMap((m) => m.trades.map(([close]) => close)))].sort((a, b) => a - b);
  const ledgerOf = new Map(closes.map((close, i) => [close, 2000 + i * 3]));
  await ch.insert(
    Table.Ledgers,
    closes.map((close) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: ledgerOf.get(close) as number,
      ledger_hash: `${ledgerOf.get(close)}`.padStart(64, 'C'),
      close_time: close,
    })),
  );
  const rows: ExchangesRow[] = [];
  for (const m of markets) {
    const stored = canonicalPair(m.left, m.right);
    m.trades.forEach(([close, left, right], i) => {
      const [baseAmount, counterAmount] = stored.inverted ? [right, left] : [left, right];
      const rate = new BigNumber(counterAmount).dividedBy(baseAmount);
      rows.push({
        ...SAMPLE_ROWS[Table.Exchanges],
        base_currency: stored.base.currency,
        base_issuer: stored.base.issuer ?? '',
        counter_currency: stored.counter.currency,
        counter_issuer: stored.counter.issuer ?? '',
        ledger_index: ledgerOf.get(close) as number,
        tx_index: 1 + i,
        node_index: 1 + (i % 3),
        tx_hash: `${rows.length}`.padStart(64, 'E'),
        close_time: close,
        base_amount: baseAmount,
        counter_amount: counterAmount,
        base_amount_f: Number(baseAmount),
        counter_amount_f: Number(counterAmount),
        rate: rate.isFinite() ? rate.toString() : '0',
        rate_f: Number(rate),
      });
    });
  }
  await ch.insert(Table.Exchanges, rows);
}

/** The shape of `CacheService`, on a clock the test moves. */
class FakeCache implements RateCache {
  now = 1_000_000;
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  get(key: string): unknown {
    const entry = this.entries.get(key);
    return entry && entry.expiresAt > this.now ? entry.value : undefined;
  }
  set(key: string, value: unknown, ttlMs: number): void {
    this.entries.set(key, { value, expiresAt: this.now + ttlMs });
  }
}

describe('DailyRates (e2e)', () => {
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

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A migrated database of its own, with the world in it. */
  async function freshWorld(): Promise<{ ch: ClickHouseService; rates: RatesService }> {
    const config = { ...container.config, database: `daily_rates_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const ch = new ClickHouseService(config);
    services.push(ch);
    await seedWorld(ch);
    return { ch, rates: new RatesService(ch, 'XRP') };
  }

  /** Keeps the parts of the table as they are written, so that rows of older versions and copies stay where they are. */
  async function stopMerges(ch: ClickHouseService): Promise<void> {
    const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
    await ch.command(`SYSTEM STOP MERGES ${database}.${Table.NativeRatesDaily}`);
  }

  const readsOfTheTable = (spy: jest.SpyInstance): string[] =>
    spy.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes(`FROM ${Table.NativeRatesDaily}`));

  /**
   * `DailyRates.rates(ASSETS, DAYS)` against `dailyNativeRates(ASSETS, first, last + 1)`, for every asset and day to the
   * last digit. Returns how many (asset, day) cases had a rate and how many had none, so that a test can see it compared
   * something of both.
   */
  async function expectSameAsDailyNativeRates(
    daily: DailyRates,
    rates: RatesService,
  ): Promise<{ withRate: number; without: number }> {
    const want = await rates.dailyNativeRates(ASSETS, dateOf(DAYS[0]), dateOf(DAYS[DAYS.length - 1] + 1));
    const got = await daily.rates(ASSETS, DAYS.map(dayText));
    const tally = { withRate: 0, without: 0 };
    expect([...got.keys()]).toEqual(ASSETS.map(assetKey));
    for (const asset of ASSETS) {
      const mine = got.get(assetKey(asset)) as Map<string, BigNumber>;
      const theirs = want.get(assetKey(asset)) as Map<string, BigNumber>;
      expect([...mine.keys()]).toEqual(DAYS.map(dayText));
      for (const day of DAYS.map(dayText)) {
        expect([assetKey(asset), day, (mine.get(day) as BigNumber).toFixed()]).toEqual([
          assetKey(asset),
          day,
          (theirs.get(day) as BigNumber).toFixed(),
        ]);
        if ((theirs.get(day) as BigNumber).gt(0)) tally.withRate++;
        else tally.without++;
      }
    }
    return tally;
  }

  describe('rates(assets, days) equals dailyNativeRates(assets, first, last + 1)', () => {
    it('with the table empty: every day is computed on read, and counted', async () => {
      const { ch, rates } = await freshWorld();
      const onRead = jest.fn();
      const computed = jest.spyOn(rates, 'dailyNativeRates');
      const spy = jest.spyOn(ch, 'query');

      const tally = await expectSameAsDailyNativeRates(new DailyRates(ch, rates, { onRead }), rates);

      // a comparison of zeros would prove nothing, and neither would one without a zero
      expect(tally.withRate).toBeGreaterThan(80);
      expect(tally.without).toBeGreaterThan(80);
      expect(onRead).toHaveBeenCalledTimes(1);
      expect(onRead).toHaveBeenCalledWith(ISSUED.length * DAYS.length);
      // the one run of 33 days of each issued asset, and the valid days of the range: none, so no read of the rows
      expect(computed.mock.calls.filter(([assets]) => assets.length === 1)).toHaveLength(ISSUED.length);
      expect(readsOfTheTable(spy)).toHaveLength(1);
    });

    it('with the table full: every day comes from it, with no rate computed', async () => {
      const { ch, rates } = await freshWorld();
      for (const day of DAYS) await computeRatesDailySet(ch, rates, dateOf(day));
      expect(await validRateDays(ch, dayText(DAYS[0]), dayText(DAYS[DAYS.length - 1]))).toHaveProperty(
        'size',
        DAYS.length,
      );

      // the answer to compare with, before any spy is set
      const want = await rates.dailyNativeRates(ASSETS, dateOf(DAYS[0]), dateOf(DAYS[DAYS.length - 1] + 1));
      const onRead = jest.fn();
      const computed = jest.spyOn(rates, 'dailyNativeRates');
      const spy = jest.spyOn(ch, 'query');
      const daily = new DailyRates(ch, rates, { onRead });

      const got = await daily.rates(ASSETS, DAYS.map(dayText));

      let withRate = 0;
      for (const asset of ASSETS) {
        for (const day of DAYS.map(dayText)) {
          const mine = (got.get(assetKey(asset)) as Map<string, BigNumber>).get(day) as BigNumber;
          const theirs = (want.get(assetKey(asset)) as Map<string, BigNumber>).get(day) as BigNumber;
          expect([assetKey(asset), day, mine.toFixed()]).toEqual([assetKey(asset), day, theirs.toFixed()]);
          if (mine.gt(0)) withRate++;
        }
      }
      expect(withRate).toBeGreaterThan(80);
      expect(computed).not.toHaveBeenCalled();
      expect(onRead).not.toHaveBeenCalled();
      // the valid days, then the rows: two reads of the table
      expect(readsOfTheTable(spy)).toHaveLength(2);
    });

    it('with part of the table stale, of another config version, missing, or written more than once', async () => {
      const { ch, rates } = await freshWorld();
      await stopMerges(ch); // the rows of older versions and the copies stay where they were written
      for (const day of range(-2, 20)) await computeRatesDailySet(ch, rates, dateOf(day));
      expect(await markRatesStale(ch, [3, 4, 12].map(dayText))).toBe(3);

      // day 8: valid first, then a newer sentinel of another config version
      const [sentinel8] = await ch.query<{ version: string }>(
        `SELECT toUInt64(max(version)) AS version FROM ${Table.NativeRatesDaily} WHERE day = {day:Date}`,
        { day: dayText(8) },
      );
      await ch.insert(Table.NativeRatesDaily, [
        {
          ...SAMPLE_ROWS[Table.NativeRatesDaily],
          currency: '',
          issuer: '',
          day: dayText(8),
          rate: '0',
          rate_f: 0,
          daily_count: 0,
          latest_count: 0,
          config_version: 2,
          stale: 0,
          version: Number(sentinel8.version) + 1,
        },
      ]);

      // day 5 is valid; rows of an older version and of a version that has no sentinel have to be ignored
      const sentinel5 = (await validRateDays(ch, dayText(5), dayText(5))).get(dayText(5)) as number;
      const usd = (rate: string, version: number) => ({
        ...SAMPLE_ROWS[Table.NativeRatesDaily],
        currency: USD.currency,
        issuer: ISSUER,
        day: dayText(5),
        rate,
        rate_f: Number(rate),
        daily_count: 1,
        latest_count: 1,
        config_version: 1,
        stale: 0,
        version,
      });
      await ch.insert(Table.NativeRatesDaily, [usd('999', sentinel5 - 1), usd('888', sentinel5 + 1000)]);

      // day 6 written twice: its rows are in the table two times
      const rowsBefore = Number(
        (await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.NativeRatesDaily}`))[0].n,
      );
      await ch.command(
        `INSERT INTO ${Table.NativeRatesDaily} SELECT * FROM ${Table.NativeRatesDaily} WHERE day = {day:Date}`,
        { day: dayText(6) },
        { settings: { insert_deduplicate: 0 } },
      );
      const rowsAfter = Number(
        (await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.NativeRatesDaily}`))[0].n,
      );
      expect(rowsAfter).toBeGreaterThan(rowsBefore + 2);

      // days 3, 4, 8, 12 and 21 to 30 are not valid; the other 19 days are
      const valid = await validRateDays(ch, dayText(DAYS[0]), dayText(DAYS[DAYS.length - 1]));
      expect([...valid.keys()]).toEqual(
        range(-2, 20)
          .filter((day) => ![3, 4, 8, 12].includes(day))
          .map(dayText),
      );

      const onRead = jest.fn();
      const tally = await expectSameAsDailyNativeRates(new DailyRates(ch, rates, { onRead }), rates);

      expect(tally.withRate).toBeGreaterThan(80);
      expect(tally.without).toBeGreaterThan(80);
      expect(onRead).toHaveBeenCalledTimes(1);
      expect(onRead).toHaveBeenCalledWith(ISSUED.length * (DAYS.length - valid.size));
    });

    it('keeps what it computes on read for 60 s: the rates of a repeated call are the same, and not computed again', async () => {
      const { ch, rates } = await freshWorld();
      for (const day of range(-2, 9)) await computeRatesDailySet(ch, rates, dateOf(day));
      const cache = new FakeCache();
      const onRead = jest.fn();
      const daily = new DailyRates(ch, rates, { cache, onRead });
      const days = range(8, 12).map(dayText); // two valid days and three that are not
      const want = await rates.dailyNativeRates([USD, ZZZ], dateOf(8), dateOf(13));

      const first = await daily.rates([USD, ZZZ], days);
      expect(onRead).toHaveBeenCalledTimes(1);
      expect(onRead).toHaveBeenLastCalledWith(2 * 3);

      const computed = jest.spyOn(rates, 'dailyNativeRates');
      const again = await daily.rates([USD, ZZZ], days);
      expect(computed).not.toHaveBeenCalled();
      expect(onRead).toHaveBeenCalledTimes(1);
      for (const asset of [USD, ZZZ]) {
        const mine = again.get(assetKey(asset)) as Map<string, BigNumber>;
        const flat = (perDay: Map<string, BigNumber>) =>
          [...perDay.entries()].map(([day, rate]) => [day, rate.toFixed()]);
        expect(flat(mine)).toEqual(flat(first.get(assetKey(asset)) as Map<string, BigNumber>));
        expect(flat(mine)).toEqual(flat(want.get(assetKey(asset)) as Map<string, BigNumber>));
        expect([...mine.values()].every((rate) => rate.gt(0))).toBe(true);
      }
    });
  });

  describe('newestValidRateDay', () => {
    it('is undefined with no valid set, and skips stale days and days of another config version', async () => {
      const { ch, rates } = await freshWorld();
      await stopMerges(ch);
      expect(await newestValidRateDay(ch, '2030-01-01')).toBeUndefined();

      for (const day of range(0, 10)) await computeRatesDailySet(ch, rates, dateOf(day));
      const versions = await validRateDays(ch, dayText(0), dayText(10));
      expect(versions.size).toBe(11);

      // the newest valid day at or before the day asked about, with the version of its set
      expect(await newestValidRateDay(ch, dayText(10))).toEqual({
        day: dayText(10),
        version: versions.get(dayText(10)),
      });
      expect(await newestValidRateDay(ch, dayText(6))).toEqual({ day: dayText(6), version: versions.get(dayText(6)) });
      expect(await newestValidRateDay(ch, '2030-01-01')).toEqual({
        day: dayText(10),
        version: versions.get(dayText(10)),
      });
      expect(await newestValidRateDay(ch, dayText(-1))).toBeUndefined();

      // stale: days 10 and 9 are passed over
      expect(await markRatesStale(ch, [10, 9].map(dayText))).toBe(2);
      expect(await newestValidRateDay(ch, dayText(10))).toEqual({ day: dayText(8), version: versions.get(dayText(8)) });
      expect(await newestValidRateDay(ch, dayText(9))).toEqual({ day: dayText(8), version: versions.get(dayText(8)) });

      // another config version: a newer sentinel of day 8 and a day 11 of version 2 are passed over
      const anotherConfig = (day: number, version: number) => ({
        ...SAMPLE_ROWS[Table.NativeRatesDaily],
        currency: '',
        issuer: '',
        day: dayText(day),
        rate: '0',
        rate_f: 0,
        daily_count: 0,
        latest_count: 0,
        config_version: 2,
        stale: 0,
        version,
      });
      await ch.insert(Table.NativeRatesDaily, [
        anotherConfig(8, (versions.get(dayText(8)) as number) + 1),
        anotherConfig(11, (versions.get(dayText(10)) as number) + 5),
      ]);
      expect(await newestValidRateDay(ch, '2030-01-01')).toEqual({
        day: dayText(7),
        version: versions.get(dayText(7)),
      });

      // a day computed again is valid again, under a newer version
      await computeRatesDailySet(ch, rates, dateOf(10));
      const recomputed = await newestValidRateDay(ch, '2030-01-01');
      expect(recomputed?.day).toBe(dayText(10));
      expect(recomputed?.version).toBeGreaterThan(versions.get(dayText(10)) as number);
      expect(recomputed?.version).toBe((await validRateDays(ch, dayText(10), dayText(10))).get(dayText(10)));
    });

    it('counts a set written twice once, and reads the sentinels only', async () => {
      const { ch, rates } = await freshWorld();
      await stopMerges(ch);
      await computeRatesDailySet(ch, rates, dateOf(5));
      await ch.command(
        `INSERT INTO ${Table.NativeRatesDaily} SELECT * FROM ${Table.NativeRatesDaily}`,
        {},
        { settings: { insert_deduplicate: 0 } },
      );
      const version = (await validRateDays(ch, dayText(5), dayText(5))).get(dayText(5));
      const spy = jest.spyOn(ch, 'query');
      expect(await newestValidRateDay(ch, dayText(9))).toEqual({ day: dayText(5), version });
      const [sql, ...others] = readsOfTheTable(spy);
      expect(others).toEqual([]);
      expect(sql).toContain("currency = '' AND issuer = ''");
      expect(sql).not.toMatch(/\bFINAL\b/);
    });
  });
});
