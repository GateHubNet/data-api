import BigNumber from 'bignumber.js';
import { join } from 'node:path';
import { AggregateSetAborted } from '../src/aggregate/aggregate-sets';
import {
  computeRatesDailySet,
  firstNativeTradeDay,
  markRatesStale,
  RATES_DAILY_CONFIG_VERSION,
  validRateDays,
} from '../src/aggregate/rates-daily.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { ExchangesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { Asset, assetKey, canonicalPair } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

/**
 * `RatesService.dailyNativeRatesOfDay` and the `native_rates_daily` sets (`rates-daily.job.ts`) on a real ClickHouse.
 *
 * The world is synthetic trades written straight into `ledgers` and `exchanges` (a ledger for every second that has a
 * trade, as part 2 of `rates.e2e-spec.ts` does), 26 days from 2016-06-01, built so that every edge of the rate of a day is
 * met: a busy pair of more than 50 trades in 15 days with the native currency as the stored counter, one with it as the
 * stored base, quiet pairs that have fewer than 10 kept trades among the newest 50 (rows of native dust do not count),
 * the boundary of 10, native legs of 0.0005 and just above it, a pair whose trades are all before the day, 60 trades in
 * ONE ledger so that the cut at the newest 50 falls inside a ledger, amounts a decimal cannot hold, an issued currency
 * called XRP, a pair without the native currency, a day whose first ledger closes at 00:00:00, and the same on Xahau
 * (the XAH service of the same database must not see the XRP pairs, nor the other way round).
 *
 * `dailyNativeRatesOfDay(D)` has to equal `dailyNativeRates([asset], D, D + 1)` for every asset and day: that is the proof
 * of the new method (and of the sets, which are made of it); an oracle written from the stored rows says which assets
 * have a rate and what the counts are. Then the sets: one version, one insert, the validity of a day, the stale marks.
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

const NOISE = new BigNumber('0.0005');
const Wide = BigNumber.clone({ DECIMAL_PLACES: 200 });

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const issued = (currency: string): Asset => ({ currency, issuer: ISSUER });
const XRP: Asset = { currency: 'XRP' };
const XAH: Asset = { currency: 'XAH' };
const USD = issued('USD'); // busy; the native currency is the stored counter
const ZZZ = issued('ZZZ'); // busy; the native currency is the stored base
const QUT = issued('QUT'); // 14 trades, 6 of them dust: 8 kept
const NIN = issued('NIN'); // 12 trades, 3 of them dust: 9 kept
const YTE = issued('YTE'); // 12 trades, 2 of them dust: 10 kept (the native currency is the stored base)
const TRL = issued('TRL'); // trades on days 2 to 5 only
const TIE = issued('TIE'); // 60 trades in one ledger
const DST = issued('DST'); // amounts a decimal cannot hold
const FAKE = issued('XRP'); // an issued currency called XRP
const EUR = issued('EUR'); // trades against USD only
const FOO = issued('FOO'); // trades against XAH only
const NON = issued('NON'); // never traded

/** The assets the XRP service and the XAH service are asked about: those of their pairs, and some that have none. */
const XRP_ASSETS = [USD, ZZZ, QUT, NIN, YTE, TRL, TIE, DST, FAKE, EUR, FOO, NON];
const XAH_ASSETS = [USD, ZZZ, FOO, QUT, EUR, NON];

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
  const usd: Trade[] = [];
  for (const day of range(0, 25)) {
    if (day >= 17 && day <= 19) continue; // three days without a trade
    [1, 7, 13, 19].forEach((hour, i) => usd.push([at(day, hour * HOUR), '10', String(10 * price(day, i))]));
  }
  usd.push(
    [at(11, DAY - 1), '10', '29'], // the last second of day 11
    [at(12, 0), '10', '31'], // the first ledger of day 12 closes at 00:00:00
    [at(8, 2 * HOUR), '1', '0.0005'], // dust: the native leg is 0.0005 or less
    [at(8, 2 * HOUR + 60), '1', '0.0004'],
    [at(15, 3 * HOUR), '1', '0.00051'], // just above it: kept
    [at(15, 3 * HOUR + 60), '1', '0.0005'],
  );

  const zzz: Trade[] = [];
  for (const day of range(0, 25)) {
    [2, 10, 18].forEach((hour) => zzz.push([at(day, hour * HOUR), String(30 + ((day + hour) % 7)), '10']));
    if (day % 5 === 0) zzz.push([at(day, 5 * HOUR), '3', '0.0005']);
  }

  // the trades at `hours` of each of `days` against the native currency; `dust(day, i)` says which are native dust
  const small = (days: number[], hours: number[], dust: (day: number, i: number) => boolean): Trade[] =>
    days.flatMap((day) =>
      hours.map(
        (hour, i): Trade => [
          at(day, hour * HOUR),
          String(10 + ((day + i) % 3)),
          dust(day, i) ? '0.0005' : String(20 + i + day),
        ],
      ),
    );

  const tie: Trade[] = range(1, 60).map(
    (i): Trade => [at(10, 12 * HOUR), '10', i <= 10 ? '1000' : String(10 + (i % 7))],
  );
  // binary fractions: the float sums are exact whatever the order the rows come in
  const dst: Trade[] = range(1, 12).map((k): Trade => [at(6, k * HOUR), String(k * Math.pow(2, -100)), '10']);

  return [
    { left: USD, right: XRP, trades: usd },
    { left: ZZZ, right: XRP, trades: zzz },
    {
      left: QUT,
      right: XRP,
      trades: small([3, 4, 5, 6, 7, 8, 9], [4, 16], (day, i) => (day <= 5 ? i === 0 : day <= 8 && i === 1)),
    },
    { left: NIN, right: XRP, trades: small([4, 5, 6, 7], [3, 9, 15], (day, i) => day <= 6 && i === 0) },
    { left: YTE, right: XRP, trades: small([4, 5, 6, 7], [3, 9, 15], (day, i) => day <= 5 && i === 0) },
    { left: TRL, right: XRP, trades: small([2, 3, 4, 5], [6, 12, 18], () => false) },
    { left: TIE, right: XRP, trades: tie },
    { left: DST, right: XRP, trades: dst },
    { left: FAKE, right: XRP, trades: small([8, 9], [1, 3, 5, 7, 9, 11], () => false) },
    // no native currency at all, and earlier than every native trade
    {
      left: EUR,
      right: USD,
      trades: [
        [at(-5, HOUR), '5', '6'],
        ...range(0, 25).flatMap((day): Trade[] => [
          [at(day, 3 * HOUR), '4', '5'],
          [at(day, 15 * HOUR), '4', '6'],
        ]),
      ],
    },
    // Xahau: the same asset USD against XAH is another pair, and the first XAH trade closes at 00:00:00
    {
      left: USD,
      right: XAH,
      trades: range(1, 25).flatMap((day): Trade[] =>
        [0, 8, 16].map((hour, i): Trade => [at(day, hour * HOUR), '10', String(5 + ((day + i) % 6))]),
      ),
    },
    {
      left: ZZZ,
      right: XAH,
      trades: range(2, 25).flatMap((day): Trade[] =>
        [5, 13, 21].map((hour, i): Trade => [at(day, hour * HOUR), String(20 + ((day + i) % 5)), '10']),
      ),
    },
    { left: FOO, right: XAH, trades: range(1, 8).map((i): Trade => [at(10, i * HOUR), '10', String(30 + i)]) },
  ];
}

/** The `exchanges` row of every trade of the markets, in the stored orientation of the pair. */
function exchangeRowsOf(markets: Market[], ledgerOf: Map<number, number>): ExchangesRow[] {
  const rows: ExchangesRow[] = [];
  for (const m of markets) {
    const stored = canonicalPair(m.left, m.right);
    m.trades.forEach(([close, left, right], i) => {
      const [baseAmount, counterAmount] = stored.inverted ? [right, left] : [left, right];
      const rate = new Wide(counterAmount).dividedBy(baseAmount);
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
  return rows;
}

/** Writes a ledger for every second that has a trade and the trades; returns the rows of the exchanges. */
async function seedWorld(ch: ClickHouseService, markets: Market[] = worldMarkets()): Promise<ExchangesRow[]> {
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
  const rows = exchangeRowsOf(markets, ledgerOf);
  await ch.insert(Table.Exchanges, rows);
  return rows;
}

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: what the stored rows say, in plain JavaScript.
// ---------------------------------------------------------------------------------------------------------------------

const byKey = (a: ExchangesRow, b: ExchangesRow): number =>
  a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index;

/** The rows of the pair of an asset against the native currency (the stored orientation, wherever the native side is). */
function pairRows(rows: ExchangesRow[], native: Asset, asset: Asset): { rows: ExchangesRow[]; nativeIsBase: boolean } {
  const stored = canonicalPair(native, asset);
  return {
    nativeIsBase: !stored.inverted,
    rows: rows.filter(
      (r) =>
        r.base_currency === stored.base.currency &&
        r.base_issuer === (stored.base.issuer ?? '') &&
        r.counter_currency === stored.counter.currency &&
        r.counter_issuer === (stored.counter.issuer ?? ''),
    ),
  };
}

/** The kept trades (native leg above 0.0005) of the day, and among the newest 50 rows of the 14 days up to its end. */
function oracleCounts(pair: { rows: ExchangesRow[]; nativeIsBase: boolean }, day: number) {
  const kept = (r: ExchangesRow): boolean =>
    new BigNumber(pair.nativeIsBase ? r.base_amount : r.counter_amount).gt(NOISE);
  const window = pair.rows.filter((r) => r.close_time >= at(day - 14) && r.close_time < at(day + 1)).sort(byKey);
  return {
    dailyCount: window.filter((r) => r.close_time >= at(day) && kept(r)).length,
    latestCount: window.slice(-50).filter(kept).length,
  };
}

const wide = (a: BigNumber.Value, b: BigNumber.Value): BigNumber => new BigNumber(new Wide(a).dividedBy(b));

// ---------------------------------------------------------------------------------------------------------------------

describe('daily native rates of a day and the rates_daily sets (e2e)', () => {
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

  /** A migrated database of its own. */
  async function freshService(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `rates_daily_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** `fn` over `items`, 8 at a time, so that a test of hundreds of rates does not run them one by one. */
  async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    for (let i = 0; i < items.length; i += 8) await Promise.all(items.slice(i, i + 8).map(fn));
  }

  /** Keeps the parts of a table as they are written, so that rows of older versions stay where the test can see them. */
  async function stopMerges(ch: ClickHouseService, table: Table): Promise<void> {
    const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
    await ch.command(`SYSTEM STOP MERGES ${database}.${table}`);
  }

  /**
   * For every day, `dailyNativeRatesOfDay(D)` against `dailyNativeRates([asset], D, D + 1)` of every asset: an asset has an
   * entry exactly when its rate is above 0, and then the same rate, to the last digit. Returns how many (day, asset) cases
   * had a rate and how many had none, so that a test can see it compared something.
   */
  async function expectSameRates(
    rates: RatesService,
    assets: Asset[],
    days: Date[],
  ): Promise<{ withRate: number; without: number }> {
    const known = new Set(assets.map(assetKey));
    const tally = { withRate: 0, without: 0 };
    await inBatches(days, async (day) => {
      const text = day.toISOString().slice(0, 10);
      const got = await rates.dailyNativeRatesOfDay(day);
      expect([text, [...got.keys()].filter((key) => !known.has(key))]).toEqual([text, []]);
      for (const asset of assets) {
        const old = await rates.dailyNativeRates([asset], day, new Date(day.getTime() + DAY * SEC));
        const want = (old.get(assetKey(asset)) as Map<string, BigNumber>).get(text) as BigNumber;
        const have = got.get(assetKey(asset));
        expect([text, assetKey(asset), have?.rate.toFixed() ?? '0']).toEqual([text, assetKey(asset), want.toFixed()]);
        if (have) expect(have.asset).toEqual(asset);
        if (want.gt(0)) tally.withRate++;
        else tally.without++;
      }
    });
    return tally;
  }

  // -------------------------------------------------------------------------------------------------------------------
  describe('dailyNativeRatesOfDay on synthetic trades', () => {
    let ch: ClickHouseService;
    let rates: RatesService;
    let xah: RatesService;
    let rows: ExchangesRow[];

    /** Before every ledger, the first days, all of the tails, and long after them. */
    const DAYS = [-5, -3, ...range(0, 40), 80];

    beforeAll(async () => {
      ch = await freshService();
      rows = await seedWorld(ch);
      rates = new RatesService(ch, 'XRP');
      xah = new RatesService(ch, 'XAH');
    });

    /** The days on which an asset has a rate, as the new method says. */
    async function daysWithRate(service: RatesService, asset: Asset, days = DAYS): Promise<number[]> {
      const out: number[] = [];
      await inBatches(days, async (day) => {
        if ((await service.dailyNativeRatesOfDay(dateOf(day))).has(assetKey(asset))) out.push(day);
      });
      return out.sort((a, b) => a - b);
    }

    it('the world has the shape the tests rely on', async () => {
      const pair = (asset: Asset, native = XRP) => pairRows(rows, native, asset);
      expect(pair(USD).nativeIsBase).toBe(false);
      expect(pair(ZZZ).nativeIsBase).toBe(true);
      expect(pair(YTE).nativeIsBase).toBe(true);
      expect(pair(USD, XAH).nativeIsBase).toBe(false);
      // more than 50 kept trades in the 15 days of a day
      expect(pair(USD).rows.filter((r) => r.close_time >= at(10) && r.close_time < at(25)).length).toBeGreaterThan(50);
      // rows and kept trades of the quiet pairs and the boundary of 10
      const kept = (asset: Asset): [number, number] => {
        const p = pair(asset);
        const keptRows = p.rows.filter((r) =>
          new BigNumber(p.nativeIsBase ? r.base_amount : r.counter_amount).gt(NOISE),
        );
        return [p.rows.length, keptRows.length];
      };
      expect([QUT, NIN, YTE, TRL, TIE, FAKE, DST].map(kept)).toEqual([
        [14, 8],
        [12, 9],
        [12, 10],
        [12, 12],
        [60, 60],
        [12, 12],
        [12, 12],
      ]);
      // dust of exactly 0.0005 and just above it
      expect(pair(USD).rows.filter((r) => r.counter_amount === '0.0005')).toHaveLength(2);
      expect(pair(USD).rows.filter((r) => r.counter_amount === '0.00051')).toHaveLength(1);
      // 60 trades in one ledger
      expect(new Set(pair(TIE).rows.map((r) => r.ledger_index)).size).toBe(1);
      // the first ledger of day 12 closes at 00:00:00, and the one before it on the last second of day 11
      const [first] = await ch.query<{ closed: string }>(
        `SELECT toUnixTimestamp(min(close_time)) AS closed FROM ledgers WHERE close_time >= toDateTime({secs:UInt32}, 'UTC')
            AND close_time < toDateTime({next:UInt32}, 'UTC')`,
        { secs: at(12), next: at(13) },
      );
      expect(Number(first.closed)).toBe(at(12));
      // a pair with the native currency on its other side, and a pair that has none
      expect(pair(USD, XAH).rows.length).toBeGreaterThan(50);
      expect(pairRows(rows, XRP, EUR).rows).toHaveLength(0);
    });

    it('dailyNativeRatesOfDay(D) equals dailyNativeRates([asset], D, D + 1) for every asset', async () => {
      const tally = await expectSameRates(rates, XRP_ASSETS, DAYS.map(dateOf));
      // a comparison of zeros would prove nothing, and neither would one without a zero
      expect(tally.withRate).toBeGreaterThan(100);
      expect(tally.without).toBeGreaterThan(100);
    });

    it('dailyNativeRatesOfDay(D) equals dailyNativeRates([asset], D, D + 1) for every asset on Xahau (XAH)', async () => {
      const tally = await expectSameRates(xah, XAH_ASSETS, DAYS.map(dateOf));
      expect(tally.withRate).toBeGreaterThan(40);
      expect(tally.without).toBeGreaterThan(40);
      // the same asset against XRP is another pair: the two services do not see each other's
      const xrpUsd = (await rates.dailyNativeRatesOfDay(dateOf(12))).get(assetKey(USD));
      const xahUsd = (await xah.dailyNativeRatesOfDay(dateOf(12))).get(assetKey(USD));
      expect(xrpUsd?.rate.toFixed()).not.toBe(xahUsd?.rate.toFixed());
      expect((await xah.dailyNativeRatesOfDay(dateOf(7))).has(assetKey(QUT))).toBe(false);
    });

    it('which assets have a rate on which days: 10 kept trades among the newest 50 of the 14 days, dust not counted', async () => {
      // 9 kept trades are not enough, 8 are not; 10 are, for as long as the window holds them
      expect(await daysWithRate(rates, QUT)).toEqual([]);
      expect(await daysWithRate(rates, NIN)).toEqual([]);
      expect(await daysWithRate(rates, YTE)).toEqual(range(7, 18));
      // trades only in the days before: no trade today, and the rate stays until the first of them leaves the window
      expect(await daysWithRate(rates, TRL)).toEqual(range(5, 16));
      expect(await daysWithRate(rates, TIE)).toEqual(range(10, 24));
      expect(await daysWithRate(rates, FAKE)).toEqual(range(9, 22));
      expect(await daysWithRate(rates, DST)).toEqual(range(6, 20));
      // the pair of the other network, a pair without the native currency, an asset that never traded
      expect(await daysWithRate(rates, FOO)).toEqual([]);
      expect(await daysWithRate(rates, EUR)).toEqual([]);
      expect(await daysWithRate(rates, NON)).toEqual([]);
      expect((await daysWithRate(rates, USD)).slice(0, 3)).toEqual([2, 3, 4]);
      // the quiet pair traded today and still has none: 8 kept trades, whatever the daily rate says
      expect((await rates.vwap(QUT, XRP, dateOf(5), dateOf(6))).count).toBeGreaterThan(0);
      expect((await rates.dailyNativeRatesOfDay(dateOf(5))).has(assetKey(QUT))).toBe(false);
    });

    it('a day before every ledger, one without a native pair in its 15 days, and one long after, have no rate', async () => {
      // day -5 holds the EUR/USD trade, a ledger but no native pair
      for (const day of [-30, -5, -3, 80]) {
        expect((await rates.dailyNativeRatesOfDay(dateOf(day))).size).toBe(0);
        expect((await xah.dailyNativeRatesOfDay(dateOf(day))).size).toBe(0);
      }
    });

    it('the day is a UTC day whatever time of it the date has', async () => {
      const noon = new Date((at(12) + 12 * HOUR) * SEC);
      const lastSecond = new Date((at(12) + DAY - 1) * SEC);
      const expected = await rates.dailyNativeRatesOfDay(dateOf(12));
      expect(expected.size).toBeGreaterThan(2);
      for (const date of [noon, lastSecond]) {
        const got = await rates.dailyNativeRatesOfDay(date);
        expect([...got.entries()].map(([key, v]) => [key, v.rate.toFixed(), v.dailyCount, v.latestCount])).toEqual(
          [...expected.entries()].map(([key, v]) => [key, v.rate.toFixed(), v.dailyCount, v.latestCount]),
        );
      }
      await expect(rates.dailyNativeRatesOfDay(new Date(NaN))).rejects.toThrow(RangeError);
    });

    it('dailyCount and latestCount are the kept trades of the day and among the newest 50', async () => {
      let checked = 0;
      await inBatches(DAYS, async (day) => {
        const got = await rates.dailyNativeRatesOfDay(dateOf(day));
        for (const asset of XRP_ASSETS) {
          const counts = oracleCounts(pairRows(rows, XRP, asset), day);
          const have = got.get(assetKey(asset));
          if (have) {
            expect([day, assetKey(asset), have.dailyCount, have.latestCount]).toEqual([
              day,
              assetKey(asset),
              counts.dailyCount,
              counts.latestCount,
            ]);
            expect(have.latestCount).toBeGreaterThanOrEqual(10);
            checked++;
          } else {
            // no entry: fewer than 10 kept trades among the newest 50 (the daily rate cannot make one)
            expect([day, assetKey(asset), counts.latestCount < 10]).toEqual([day, assetKey(asset), true]);
          }
        }
      });
      expect(checked).toBeGreaterThan(100);

      // by hand: day 10 holds the 60 trades of TIE in one ledger. All 60 are the daily trades, the newest 50 are
      // those of tx 11 to 60 (the cut falls inside the ledger, by the transaction index): they pay 10 + tx % 7 XRP for 10
      // TIE each, 651 XRP in all; the first ten paid 1000 each, 10651 XRP for 600 TIE in all.
      const tie = (await rates.dailyNativeRatesOfDay(dateOf(10))).get(assetKey(TIE));
      expect(tie).toBeDefined();
      expect([tie?.dailyCount, tie?.latestCount]).toEqual([60, 50]);
      expect(tie?.rate.toFixed()).toBe(wide(600, 10651).plus(wide(500, 651)).times('0.5').toFixed());
      // YTE's 12 trades hold 2 of dust: 10 kept, all of them among the newest 50
      expect((await rates.dailyNativeRatesOfDay(dateOf(7))).get(assetKey(YTE))).toMatchObject({
        dailyCount: 3,
        latestCount: 10,
      });
    });

    it('reads the exchanges twice (the native pairs, then their rows), and binds every value', async () => {
      const spy = jest.spyOn(ch, 'query');
      await rates.dailyNativeRatesOfDay(dateOf(10));
      const calls = spy.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));
      const onExchanges = calls.filter(({ sql }) => sql.includes('FROM exchanges'));
      expect(onExchanges).toHaveLength(2);
      for (const { sql } of calls) expect(sql).not.toMatch(/\bFINAL\b|2016/);
      // each row once, the newest 50 numbered over those
      expect(onExchanges[1].sql).toMatch(/LIMIT 1 BY/);
      expect(onExchanges[1].sql).toMatch(/row_number\(\) OVER/);
      expect(onExchanges[0].params).toMatchObject({ native: 'XRP' });
      // the second read asks for the pairs of the XRP service only: the pairs against XAH are none of its business
      const asked = onExchanges[1].params as Record<'pair0' | 'pair2', string[]>;
      expect([...asked.pair0, ...asked.pair2]).toContain('XRP');
      expect([...asked.pair0, ...asked.pair2]).not.toContain('XAH');

      // no ledger in the 15 days: no read of the exchanges; no native pair in them: the first read only
      spy.mockClear();
      await rates.dailyNativeRatesOfDay(dateOf(80));
      expect(spy.mock.calls.filter(([sql]) => String(sql).includes('FROM exchanges'))).toHaveLength(0);
      spy.mockClear();
      await rates.dailyNativeRatesOfDay(dateOf(-3));
      expect(spy.mock.calls.filter(([sql]) => String(sql).includes('FROM exchanges'))).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('rows written twice (a second insert without deduplication, the merges stopped)', () => {
    // `exchanges` is a ReplacingMergeTree and the rates never use FINAL, so until a merge a row can be there twice (the
    // syncer re-writes a ledger it is not sure about). Half of the ledgers are copied, so that the copies change the sums.
    it('dailyNativeRatesOfDay counts each exchange once: the rates and counts of the table written once, and dailyNativeRates', async () => {
      const once = await freshService();
      await seedWorld(once);
      const twice = await freshService();
      await seedWorld(twice);
      const count = async (ch: ClickHouseService): Promise<number> =>
        Number((await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.Exchanges}`))[0].n);
      const before = await count(twice);
      await stopMerges(twice, Table.Exchanges);
      await twice.command(
        `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges} WHERE ledger_index % 2 = 0`,
        {},
        { settings: { insert_deduplicate: 0 } },
      );
      expect(await count(twice)).toBeGreaterThan(before + 100);

      const onceRates = new RatesService(once, 'XRP');
      const twiceRates = new RatesService(twice, 'XRP');
      const days = [2, 5, 9, 10, 12, 13, 17, 24, 30, 38];
      for (const day of days) {
        const mine = await twiceRates.dailyNativeRatesOfDay(dateOf(day));
        const theirs = await onceRates.dailyNativeRatesOfDay(dateOf(day));
        const flat = (map: typeof mine) =>
          [...map.entries()].map(([key, v]) => [key, v.rate.toFixed(), v.dailyCount, v.latestCount]);
        expect([day, flat(mine)]).toEqual([day, flat(theirs)]);
      }
      const tally = await expectSameRates(twiceRates, XRP_ASSETS, days.map(dateOf));
      expect(tally.withRate).toBeGreaterThan(20);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('on the mock ledgers of the original Ripple API, written by the LedgerWriter', () => {
    it('dailyNativeRatesOfDay(D) equals dailyNativeRates([asset], D, D + 1) for every asset of the mock pairs', async () => {
      const ctx = parseContextFor(getNetworkProfile('xrpl'));
      const ledgers = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/ripple-mock')).list();
      const mockRows = ledgers.flatMap((ledger) => buildLedgerRows(ledger, ctx).exchanges);
      const ch = await freshService();
      await new LedgerWriter(ch, ctx).write(ledgers);
      const rates = new RatesService(ch, 'XRP');

      const assets = new Map<string, Asset>();
      for (const r of mockRows) {
        const [base, counter]: Asset[] = [
          { currency: r.base_currency, ...(r.base_issuer && { issuer: r.base_issuer }) },
          { currency: r.counter_currency, ...(r.counter_issuer && { issuer: r.counter_issuer }) },
        ];
        if (!base.issuer && base.currency === 'XRP') assets.set(assetKey(counter), counter);
        else if (!counter.issuer && counter.currency === 'XRP') assets.set(assetKey(base), base);
      }
      expect(assets.size).toBeGreaterThan(10);
      const days = [
        '2015-01-13',
        '2015-01-14',
        '2015-01-15',
        '2015-01-16',
        '2015-01-28',
        '2015-01-29',
        '2016-03-27',
        '2016-03-28',
        '2016-03-29',
        '2016-04-11',
        '2016-04-12',
      ].map((text) => new Date(`${text}T00:00:00Z`));
      const tally = await expectSameRates(rates, [...assets.values(), NON], days);
      // CNY against XRP has 13 trades on 2015-01-14: some rates exist, most pairs have too few trades
      expect(tally.withRate).toBeGreaterThan(0);
      expect(tally.without).toBeGreaterThan(tally.withRate);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the rates_daily sets', () => {
    let ch: ClickHouseService;
    let rates: RatesService;

    beforeEach(async () => {
      ch = await freshService();
      await seedWorld(ch);
      rates = new RatesService(ch, 'XRP');
    });

    interface StoredRow {
      currency: string;
      issuer: string;
      day: string;
      rate: string;
      rate_f: number;
      daily_count: number;
      latest_count: number;
      config_version: number;
      stale: number;
      version: number | string;
    }

    /** Every row of the table with these conditions (all of them without), the sentinel (empty currency) first. */
    async function storedRows(where = '1', params: Record<string, unknown> = {}): Promise<StoredRow[]> {
      const stored = await ch.query<Omit<StoredRow, 'day'> & { day_text: string }>(
        `SELECT currency, issuer, toString(day) AS day_text, rate, rate_f, daily_count, latest_count, config_version, stale,
                toUInt64(version) AS version
           FROM ${Table.NativeRatesDaily} WHERE ${where} ORDER BY version, day, currency, issuer`,
        params,
      );
      return stored.map(({ day_text, ...r }) => ({ ...r, day: day_text, version: Number(r.version) }));
    }

    /** A sentinel the way a test writes one by hand. */
    const sentinelOf = (day: string, version: number, configVersion: number, stale: number) => ({
      ...SAMPLE_ROWS[Table.NativeRatesDaily],
      currency: '',
      issuer: '',
      day,
      rate: '0',
      rate_f: 0,
      daily_count: 0,
      latest_count: 0,
      config_version: configVersion,
      stale,
      version,
    });

    it('a set is the assets with a rate above 0 and the sentinel, one insert, one version', async () => {
      const wanted = await rates.dailyNativeRatesOfDay(dateOf(10));
      expect(wanted.size).toBeGreaterThan(3);
      const inserts = jest.spyOn(ch, 'insert');
      const before = Date.now();

      expect(await computeRatesDailySet(ch, rates, dateOf(10))).toBe(wanted.size);

      expect(inserts).toHaveBeenCalledTimes(1);
      expect(inserts.mock.calls[0][0]).toBe(Table.NativeRatesDaily);
      const stored = await storedRows();
      expect(stored).toHaveLength(wanted.size + 1);
      // the sentinel: the empty currency and issuer, the config version, not stale
      expect(stored[0]).toMatchObject({
        currency: '',
        issuer: '',
        day: dayText(10),
        rate: '0',
        rate_f: 0,
        daily_count: 0,
        latest_count: 0,
        config_version: 1,
        stale: 0,
      });
      expect(RATES_DAILY_CONFIG_VERSION).toBe(1);
      // one version for the whole set: the ClickHouse clock in milliseconds
      expect(new Set(stored.map((r) => r.version)).size).toBe(1);
      expect(Math.abs((stored[0].version as number) - before)).toBeLessThan(5 * 60_000);
      // one row per asset with a rate
      const assets = stored.slice(1);
      expect(assets.map((r) => (r.issuer ? `${r.currency}.${r.issuer}` : r.currency)).sort()).toEqual(
        [...wanted.keys()].sort(),
      );
      for (const r of assets) {
        const want = wanted.get(r.issuer ? `${r.currency}.${r.issuer}` : r.currency) as NonNullable<
          ReturnType<typeof wanted.get>
        >;
        expect(r).toMatchObject({
          day: dayText(10),
          rate: want.rate.toString(),
          rate_f: want.rate.toNumber(),
          daily_count: want.dailyCount,
          latest_count: want.latestCount,
          config_version: 1,
          stale: 0,
        });
        expect(want.rate.gt(0)).toBe(true);
      }
      // one part: a reader sees all of the set or none of it
      const parts = await ch.query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {table:String} AND active`,
        { table: Table.NativeRatesDaily },
      );
      expect(parts.map((p) => Number(p.rows))).toEqual([wanted.size + 1]);
    });

    it('a day with no rate is the sentinel only, and a day with no ledger at all is too', async () => {
      expect(await computeRatesDailySet(ch, rates, dateOf(-3))).toBe(0);
      expect(await computeRatesDailySet(ch, rates, dateOf(80))).toBe(0);
      const stored = await storedRows();
      expect(stored.map((r) => [r.currency, r.issuer, r.day, r.stale, r.config_version])).toEqual([
        ['', '', dayText(-3), 0, 1],
        ['', '', dayText(80), 0, 1],
      ]);
      expect([...(await validRateDays(ch, dayText(-10), dayText(90))).keys()]).toEqual([dayText(-3), dayText(80)]);
    });

    it('the day is the UTC day of the date, and a date that is none is a RangeError', async () => {
      const lastSecond = new Date((at(10) + DAY - 1) * SEC);
      await computeRatesDailySet(ch, rates, lastSecond);
      expect([...new Set((await storedRows()).map((r) => r.day))]).toEqual([dayText(10)]);
      await expect(computeRatesDailySet(ch, rates, new Date(NaN))).rejects.toThrow(RangeError);
    });

    it('a recompute is a newer version, and validRateDays reports it', async () => {
      await stopMerges(ch, Table.NativeRatesDaily);
      await computeRatesDailySet(ch, rates, dateOf(10));
      const first = await validRateDays(ch, dayText(0), dayText(30));
      expect([...first.keys()]).toEqual([dayText(10)]);

      await computeRatesDailySet(ch, rates, dateOf(10));
      await computeRatesDailySet(ch, rates, dateOf(11));
      const second = await validRateDays(ch, dayText(0), dayText(30));
      expect([...second.keys()]).toEqual([dayText(10), dayText(11)]);
      expect(second.get(dayText(10))).toBeGreaterThan(first.get(dayText(10)) as number);
      // both sets of day 10 are in the table until a merge: the rule of the reader, not FINAL, picks the newest
      const versions = await ch.query<{ version: string; n: string }>(
        `SELECT toUInt64(version) AS version, count() AS n FROM ${Table.NativeRatesDaily} WHERE day = {day:Date}
          GROUP BY version ORDER BY version`,
        { day: dayText(10) },
      );
      expect(versions.map((v) => Number(v.version))).toEqual([first.get(dayText(10)), second.get(dayText(10))]);
      expect(versions[0].n).toBe(versions[1].n);

      // the window is [from, through]: both days are in
      expect([...(await validRateDays(ch, dayText(10), dayText(10))).keys()]).toEqual([dayText(10)]);
      expect([...(await validRateDays(ch, dayText(11), dayText(11))).keys()]).toEqual([dayText(11)]);
      expect((await validRateDays(ch, dayText(12), dayText(30))).size).toBe(0);
      expect((await validRateDays(ch, dayText(0), dayText(9))).size).toBe(0);

      // a version only goes up: a set from the future is beaten
      const future = Date.now() + 3_600_000;
      await ch.insert(Table.NativeRatesDaily, [sentinelOf(dayText(12), future, 1, 0)]);
      await computeRatesDailySet(ch, rates, dateOf(12));
      expect((await validRateDays(ch, dayText(12), dayText(12))).get(dayText(12))).toBe(future + 1);
    });

    it('markRatesStale writes a sentinel-only stale mark on a valid day, and nothing on a day without a set', async () => {
      await computeRatesDailySet(ch, rates, dateOf(10));
      await computeRatesDailySet(ch, rates, dateOf(11));
      const setVersion = (await validRateDays(ch, dayText(10), dayText(10))).get(dayText(10)) as number;
      const inserts = jest.spyOn(ch, 'insert');

      // day 12 has no set; day 10 is named twice
      expect(await markRatesStale(ch, [dayText(10), dayText(12), dayText(10)])).toBe(1);
      expect(inserts).toHaveBeenCalledTimes(1);
      expect(inserts.mock.calls[0][0]).toBe(Table.NativeRatesDaily);

      expect([...(await validRateDays(ch, dayText(0), dayText(30))).keys()]).toEqual([dayText(11)]);
      const marks = await storedRows('stale = 1');
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({
        currency: '',
        issuer: '',
        day: dayText(10),
        rate: '0',
        rate_f: 0,
        daily_count: 0,
        latest_count: 0,
        config_version: RATES_DAILY_CONFIG_VERSION,
        stale: 1,
      });
      expect(marks[0].version).toBeGreaterThan(setVersion);
      // nothing was written for the day without a set, and the rows of the set are still there for a reader of an older mark
      expect(await storedRows('day = {day:Date}', { day: dayText(12) })).toEqual([]);
      expect((await storedRows('day = {day:Date} AND stale = 0', { day: dayText(10) })).length).toBeGreaterThan(2);

      // a stale day is not valid, so marking it again marks nothing and writes nothing
      inserts.mockClear();
      expect(await markRatesStale(ch, [dayText(10)])).toBe(0);
      expect(inserts).not.toHaveBeenCalled();

      // computed again it is valid, under a newer version than the mark
      await computeRatesDailySet(ch, rates, dateOf(10));
      expect((await validRateDays(ch, dayText(10), dayText(10))).get(dayText(10))).toBeGreaterThan(
        marks[0].version as number,
      );

      // several days are one insert, and the count is the days marked
      inserts.mockClear();
      expect(await markRatesStale(ch, [dayText(9), dayText(10), dayText(11), dayText(13)])).toBe(2);
      expect(inserts).toHaveBeenCalledTimes(1);
      expect((inserts.mock.calls[0][1] as unknown[]).length).toBe(2);
      expect((await validRateDays(ch, dayText(0), dayText(30))).size).toBe(0);
    });

    it('markRatesStale of no day does not read', async () => {
      const queries = jest.spyOn(ch, 'query');
      expect(await markRatesStale(ch, [])).toBe(0);
      expect(queries).not.toHaveBeenCalled();
    });

    it('validRateDays ignores a set of another config version, and counts a set written twice once', async () => {
      await computeRatesDailySet(ch, rates, dateOf(10));
      await computeRatesDailySet(ch, rates, dateOf(11));
      await computeRatesDailySet(ch, rates, dateOf(12));
      expect((await validRateDays(ch, dayText(0), dayText(30))).size).toBe(3);

      // a newer sentinel of another config version un-does day 10: it is computed again after a config change
      await ch.insert(Table.NativeRatesDaily, [sentinelOf(dayText(10), Date.now() + 10_000, 2, 0)]);
      // and an older set of another version does not make a day valid that has none of the current one
      await ch.insert(Table.NativeRatesDaily, [sentinelOf(dayText(14), 5, 2, 0)]);
      expect([...(await validRateDays(ch, dayText(0), dayText(30))).keys()]).toEqual([dayText(11), dayText(12)]);

      await stopMerges(ch, Table.NativeRatesDaily);
      const rows = async (): Promise<number> =>
        Number((await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.NativeRatesDaily}`))[0].n);
      const before = await rows();
      await ch.command(
        `INSERT INTO ${Table.NativeRatesDaily} SELECT * FROM ${Table.NativeRatesDaily}`,
        {},
        { settings: { insert_deduplicate: 0 } },
      );
      // (a block collapses the rows of one key, so the older sentinels of a day are not copied: not exactly twice the rows)
      expect(await rows()).toBeGreaterThan(before + 20);
      const valid = await validRateDays(ch, dayText(0), dayText(30));
      expect([...valid.keys()]).toEqual([dayText(11), dayText(12)]);
      // the version of a day is that of its newest sentinel, copies or not
      for (const day of [dayText(11), dayText(12)]) {
        const [newest] = await ch.query<{ version: string }>(
          `SELECT toUInt64(max(version)) AS version FROM ${Table.NativeRatesDaily} WHERE currency = '' AND day = {day:Date}`,
          { day },
        );
        expect(Number(newest.version)).toBe(valid.get(day));
      }
    });

    it('firstNativeTradeDay is the UTC day of the first trade against the native currency', async () => {
      // XRP: day 0 (EUR against USD traded on day -5, and does not count); XAH: day 1, whose first trade closes at 00:00:00
      expect(await firstNativeTradeDay(ch, 'XRP')).toBe(dayText(0));
      expect(await firstNativeTradeDay(ch, 'XAH')).toBe(dayText(1));
      expect(await firstNativeTradeDay(ch, 'ABC')).toBeUndefined();
      expect(await firstNativeTradeDay(await freshService(), 'XRP')).toBeUndefined();
    });

    it('an aborted set writes nothing', async () => {
      const aborted = new AbortController();
      aborted.abort();
      await computeRatesDailySet(ch, rates, dateOf(11));
      const inserts = jest.spyOn(ch, 'insert');
      const queries = jest.spyOn(ch, 'query');

      // before the work: no read, no insert
      await expect(computeRatesDailySet(ch, rates, dateOf(10), { signal: aborted.signal })).rejects.toBeInstanceOf(
        AggregateSetAborted,
      );
      await expect(markRatesStale(ch, [dayText(11)], { signal: aborted.signal })).rejects.toBeInstanceOf(
        AggregateSetAborted,
      );
      expect(queries).not.toHaveBeenCalled();
      expect(inserts).not.toHaveBeenCalled();
      queries.mockRestore();

      // aborted while the set is read: the check is made again right before the insert
      const original = ch.query.bind(ch);
      const live = new AbortController();
      const spy = jest.spyOn(ch, 'query').mockImplementation(async (sql, params, settings) => {
        const rows = await original(sql, params, settings);
        if (String(sql).includes('max(version)')) live.abort();
        return rows;
      });
      await expect(computeRatesDailySet(ch, rates, dateOf(10), { signal: live.signal })).rejects.toBeInstanceOf(
        AggregateSetAborted,
      );
      expect(inserts).not.toHaveBeenCalled();
      expect(await storedRows('day = {day:Date}', { day: dayText(10) })).toEqual([]);

      // and so is a mark
      const liveMark = new AbortController();
      spy.mockImplementation(async (sql, params, settings) => {
        const rows = await original(sql, params, settings);
        if (String(sql).includes('max(version)')) liveMark.abort();
        return rows;
      });
      await expect(markRatesStale(ch, [dayText(11)], { signal: liveMark.signal })).rejects.toBeInstanceOf(
        AggregateSetAborted,
      );
      expect(inserts).not.toHaveBeenCalled();
      spy.mockRestore();
      expect((await validRateDays(ch, dayText(11), dayText(11))).has(dayText(11))).toBe(true);
    });

    it('binds every value, names tables from the Table enum, and uses no FINAL', async () => {
      const queries = jest.spyOn(ch, 'query');
      await computeRatesDailySet(ch, rates, dateOf(10));
      await markRatesStale(ch, [dayText(10)]);
      await validRateDays(ch, dayText(1), dayText(30));
      await firstNativeTradeDay(ch, 'XRP');
      const calls = queries.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));
      expect(calls.length).toBeGreaterThan(8);
      for (const { sql } of calls) expect(sql).not.toMatch(/\bFINAL\b|2016|'XRP'/);
      // the last read of the valid days is the explicit one
      const reads = calls.filter(({ sql }) => sql.includes('LIMIT 1 BY day'));
      const valid = reads[reads.length - 1];
      expect(valid?.sql).toMatch(/ORDER BY currency, issuer, day, version DESC/);
      expect(valid?.params).toMatchObject({ from: dayText(1), through: dayText(30), configVersion: 1 });
    });
  });
});
