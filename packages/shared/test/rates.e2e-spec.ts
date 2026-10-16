import BigNumber from 'bignumber.js';
import { join } from 'node:path';
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
import { RATE_PERIODS, RatePeriod, RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';

/**
 * `RatesService` on a real ClickHouse.
 *
 * Part 1 seeds the 54 mock ledgers of the original Ripple test suite through the real `LedgerWriter` (158 exchanges in
 * 32 pairs, all but 4 of them on 2015-01-14 between 18:27 and 19:10) and compares every pair, in both orientations,
 * with an oracle written from `hbase.getExchangeRate`: the daily vwap, the vwap of the last 50 trades of 14 days, the
 * 10 trades of strict mode, the rolling periods and the native legs of 0.0005 or less.
 *
 * Part 2 writes synthetic trades straight into `ledgers` and `exchanges` (one ledger per second that has a trade) so
 * that the edges of every window sit on a second: the oldest second of the 14 days, the start of the day, the date
 * itself, the second after it; more than 50 trades in the window; noise in the newest 50; amounts a
 * 30-place decimal cannot hold; and Xahau's native currency. The expected values of the small market are worked out
 * by hand. Half of the trades of a second database are written twice (a second insert without deduplication, with the
 * merges stopped: ClickHouse collapses a row inserted twice in one insert, so that would test nothing) and every read
 * has to count them once.
 *
 * Part 3 is `dailyNativeRates` (against `exchangeRate` of each day) and `normalize`; part 4 is the SQL (bound values,
 * the newest 50 read in reverse key order without a sort).
 */

const SEC = 1000;
const HOUR = 3600;
const DAY = 86_400;

const Wide = BigNumber.clone({ DECIMAL_PLACES: 200 });
const NOISE = new BigNumber('0.0005');

/** A trade as it is stored: the amounts are those of the stored base and counter. */
interface Trade {
  ledger: number;
  tx: number;
  node: number;
  /** Unix seconds. */
  close: number;
  base: string;
  counter: string;
}

interface Market {
  base: Asset;
  counter: Asset;
  trades: Trade[];
}

const native = (a: Asset, nativeCurrency: string): boolean => a.currency === nativeCurrency && !a.issuer;

// ---------------------------------------------------------------------------------------------------------------------
// The oracle: `hbase.getExchangeRate` of the original, on a list of trades in key order.
// ---------------------------------------------------------------------------------------------------------------------

interface OracleOptions {
  date: Date;
  endExclusive?: Date;
  strict?: boolean;
  live?: boolean;
  period?: RatePeriod;
}

const PERIOD_SECONDS: Record<RatePeriod, number> = {
  hour: HOUR,
  day: DAY,
  '3day': 3 * DAY,
  '7day': 7 * DAY,
  '30day': 30 * DAY,
};

function sum(values: string[]): BigNumber {
  return values.reduce((total, v) => total.plus(v), new BigNumber(0));
}

/** The vwap of some trades of a market, the pair as asked for: the trades whose native leg is 0.0005 or less are out. */
function oracleVwap(m: Market, nativeCurrency: string, trades: Trade[], inverted: boolean) {
  const kept = trades.filter(
    (t) =>
      (!native(m.base, nativeCurrency) || new BigNumber(t.base).gt(NOISE)) &&
      (!native(m.counter, nativeCurrency) || new BigNumber(t.counter).gt(NOISE)),
  );
  const stored = { base: sum(kept.map((t) => t.base)), counter: sum(kept.map((t) => t.counter)) };
  const [baseVolume, counterVolume] = inverted ? [stored.counter, stored.base] : [stored.base, stored.counter];
  return {
    vwap: baseVolume.isZero() ? new BigNumber(0) : new Wide(counterVolume).dividedBy(baseVolume),
    count: kept.length,
    baseVolume,
    counterVolume,
  };
}

/** `[from, to)` in unix seconds of the trades closed in it. */
const closedIn = (trades: Trade[], from: number, to: number): Trade[] =>
  trades.filter((t) => t.close >= from && t.close < to);

function oracleRate(m: Market, nativeCurrency: string, inverted: boolean, o: OracleOptions): BigNumber {
  const second = Math.floor(o.date.getTime() / SEC);
  if (o.period) {
    return oracleVwap(m, nativeCurrency, closedIn(m.trades, second - 1 - PERIOD_SECONDS[o.period], second), inverted)
      .vwap;
  }
  const until = o.endExclusive ? Math.floor(o.endExclusive.getTime() / SEC) : second + 1;
  const dayStart = Math.floor(second / DAY) * DAY;
  const daily = o.live
    ? new BigNumber(0)
    : oracleVwap(m, nativeCurrency, closedIn(m.trades, dayStart, Math.min(until, dayStart + DAY)), inverted).vwap;
  // the newest 50 of the window first, then the noise out of them
  const newest = closedIn(m.trades, second - 14 * DAY, until).slice(-50);
  const last = oracleVwap(m, nativeCurrency, newest, inverted);
  const latest = o.strict === false || last.count >= 10 ? last.vwap : new BigNumber(0);
  return daily.gt(0) && latest.gt(0) ? daily.plus(latest).times('0.5') : latest;
}

/** Compares exact decimals as text, so a failure shows both, under a label that says which case it was. */
function expectSame(label: unknown, got: BigNumber, want: BigNumber): void {
  expect([label, got.toFixed()]).toEqual([label, want.toFixed()]);
}
const iso = (seconds: number): Date => new Date(seconds * SEC);

// ---------------------------------------------------------------------------------------------------------------------

describe('RatesService (e2e)', () => {
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
    const config = { ...container.config, database: `rates_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  /** `fn` over `items`, 8 at a time, so that a test of hundreds of rates does not run them one by one. */
  async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
    for (let i = 0; i < items.length; i += 8) await Promise.all(items.slice(i, i + 8).map(fn));
  }

  // -------------------------------------------------------------------------------------------------------------------
  describe('on the mock ledgers of the original Ripple API, written by the LedgerWriter', () => {
    const profile = getNetworkProfile('xrpl');
    const ctx = parseContextFor(profile);
    const ledgers = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/ripple-mock')).list();
    const rows: ExchangesRow[] = ledgers.flatMap((ledger) => buildLedgerRows(ledger, ctx).exchanges);

    const markets: Market[] = [];
    for (const row of rows) {
      const base = { currency: row.base_currency, ...(row.base_issuer && { issuer: row.base_issuer }) };
      const counter = { currency: row.counter_currency, ...(row.counter_issuer && { issuer: row.counter_issuer }) };
      let market = markets.find(
        (m) => assetKey(m.base) === assetKey(base) && assetKey(m.counter) === assetKey(counter),
      );
      if (!market) markets.push((market = { base, counter, trades: [] }));
      market.trades.push({
        ledger: row.ledger_index,
        tx: row.tx_index,
        node: row.node_index,
        close: row.close_time,
        base: row.base_amount,
        counter: row.counter_amount,
      });
    }
    for (const m of markets) m.trades.sort((a, b) => a.ledger - b.ledger || a.tx - b.tx || a.node - b.node);

    let ch: ClickHouseService;
    let rates: RatesService;

    beforeAll(async () => {
      ch = await freshService();
      await new LedgerWriter(ch, ctx).write(ledgers);
      rates = new RatesService(ch, 'XRP');
    });

    /** Both orientations of every market. */
    const orientations = markets.flatMap((m) => [
      { m, inverted: false, base: m.base, counter: m.counter },
      { m, inverted: true, base: m.counter, counter: m.base },
    ]);
    const label = (b: Asset, c: Asset): string => `${assetKey(b)}/${assetKey(c)}`;

    it('the mock ledgers hold 32 pairs, 158 exchanges', () => {
      expect([markets.length, rows.length]).toEqual([32, 158]);
    });

    it('same asset is 1, with a period too, and needs no trade', async () => {
      const usd = { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' };
      for (const asset of [usd, { currency: 'XRP' }]) {
        expect((await rates.exchangeRate(asset, { ...asset }, { date: iso(1_421_260_000) })).toFixed()).toBe('1');
        expect((await rates.exchangeRate(asset, { ...asset }, { period: 'hour' })).toFixed()).toBe('1');
      }
    });

    it('a pair without a trade, or a window without a ledger, is 0', async () => {
      const eur = { currency: 'EUR', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' };
      const usd = { currency: 'USD', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' };
      const when = new Date('2015-01-14T19:30:00Z');
      expect((await rates.exchangeRate(eur, usd, { date: when, strict: false })).toFixed()).toBe('0');
      expect((await rates.exchangeRate(eur, usd, { period: 'day', date: when })).toFixed()).toBe('0');
      // before the first ledger, and after the year 2106 (a close time is a UInt32)
      const [first, last] = [new Date('2001-01-01T00:00:00Z'), new Date('2999-01-01T00:00:00Z')];
      for (const date of [first, last]) {
        expect((await rates.exchangeRate(markets[0].base, markets[0].counter, { date, strict: false })).toFixed()).toBe(
          '0',
        );
      }
    });

    const DATES: { name: string; date: string; endExclusive?: string }[] = [
      { name: 'in the middle of the activity', date: '2015-01-14T18:28:40Z' },
      { name: 'after the 2015 trades', date: '2015-01-14T19:30:00Z' },
      { name: 'a day: the day, to its end', date: '2015-01-14T00:00:00Z', endExclusive: '2015-01-15T00:00:00Z' },
      { name: 'the second of the last trades of 2016', date: '2016-03-28T18:24:21Z' },
      { name: 'before every trade', date: '2014-12-31T00:00:00Z' },
    ];

    describe.each(DATES)('as of $name', ({ date, endExclusive }) => {
      const base = { date: new Date(date), ...(endExclusive && { endExclusive: new Date(endExclusive) }) };

      it.each([
        ['strict', {}],
        ['strict=false', { strict: false }],
        ['live', { live: true }],
        ['live, strict=false', { live: true, strict: false }],
      ])('every pair, both orientations, %s', async (_name, extra) => {
        const o = { ...base, ...extra };
        await inBatches(orientations, async ({ m, inverted, base: b, counter: c }) => {
          expectSame(label(b, c), await rates.exchangeRate(b, c, o), oracleRate(m, 'XRP', inverted, o));
        });
      });

      it.each(RATE_PERIODS)('every pair, both orientations, period=%s', async (period) => {
        const o = { ...base, period };
        await inBatches(orientations, async ({ m, inverted, base: b, counter: c }) => {
          expectSame(label(b, c), await rates.exchangeRate(b, c, o), oracleRate(m, 'XRP', inverted, o));
        });
      });
    });

    it('the rates are not all 0: the oracle sees trades in these windows', async () => {
      // a comparison of zeros with zeros would prove nothing
      const at = { date: new Date('2015-01-14T19:30:00Z') };
      const lax = orientations.filter(({ m, inverted }) =>
        oracleRate(m, 'XRP', inverted, { ...at, strict: false }).gt(0),
      );
      const strict = orientations.filter(({ m, inverted }) => oracleRate(m, 'XRP', inverted, at).gt(0));
      // every pair but the one that only has trades in 2016 (USD+rhub8 against XRP), both ways round
      expect(lax).toHaveLength(orientations.length - 2);
      // in strict mode only the pairs with 10 trades or more have a rate
      expect(strict.length).toBeGreaterThan(0);
      expect(strict.length).toBeLessThan(lax.length);
      expect(strict.every(({ m }) => m.trades.length >= 10)).toBe(true);
    });

    it('strict mode: a pair of fewer than 10 trades has no rate, however many the day has; strict=false has', async () => {
      const usd = { currency: 'USD', issuer: 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q' };
      const xrp = { currency: 'XRP' };
      const m = markets.find((x) => assetKey(x.base) === assetKey(usd) && x.counter.currency === 'XRP') as Market;
      expect(m.trades).toHaveLength(5);
      const date = new Date('2015-01-14T19:30:00Z');
      const strict = await rates.exchangeRate(usd, xrp, { date });
      expect(strict.toFixed()).toBe('0');
      const lax = await rates.exchangeRate(usd, xrp, { date, strict: false });
      const all = oracleVwap(m, 'XRP', m.trades, false);
      expect(all.count).toBe(5);
      // the day and the last trades are the same five trades: the average of two equal rates
      expect(lax.gt(0)).toBe(true);
      expectSame('strict=false', lax, all.vwap);
    });

    it('a pair of 10 trades or more has its latest rate in strict mode', async () => {
      const m = markets.find((x) => x.trades.length === 38) as Market;
      const date = new Date('2015-01-14T19:30:00Z');
      const got = await rates.exchangeRate(m.base, m.counter, { date });
      expect(got.gt(0)).toBe(true);
      expectSame('strict, 38 trades', got, oracleVwap(m, 'XRP', m.trades, false).vwap);
    });

    it('vwap(): count and volumes of a window, the pair as asked for; native legs of 0.0005 or less are out', async () => {
      const cny = markets.find((x) => x.counter.currency === 'XRP' && x.trades.length === 13) as Market;
      // 13 exchanges: 2 of them have a native leg of 0.0005 or less
      const from = new Date('2015-01-14T00:00:00Z');
      const to = new Date('2015-01-15T00:00:00Z');
      const direct = await rates.vwap(cny.base, cny.counter, from, to);
      const reverse = await rates.vwap(cny.counter, cny.base, from, to);
      const want = oracleVwap(cny, 'XRP', cny.trades, false);
      expect(want.count).toBeLessThan(13);
      expect([
        direct.count,
        direct.baseVolume.toFixed(),
        direct.counterVolume.toFixed(),
        direct.vwap.toFixed(),
      ]).toEqual([want.count, want.baseVolume.toFixed(), want.counterVolume.toFixed(), want.vwap.toFixed()]);
      // the other way round: the volumes swap, the vwap is counter over base of that orientation
      expect([reverse.count, reverse.baseVolume.toFixed(), reverse.counterVolume.toFixed()]).toEqual([
        want.count,
        want.counterVolume.toFixed(),
        want.baseVolume.toFixed(),
      ]);
      expect(reverse.vwap.toFixed()).toBe(new Wide(want.baseVolume).dividedBy(want.counterVolume).toFixed());
      // the window is [from, toExclusive) to the second: the last trade closed 18:28:40 (this pair)
      const cut = await rates.vwap(cny.base, cny.counter, from, new Date('2015-01-14T18:28:40Z'));
      const cutWant = oracleVwap(
        cny,
        'XRP',
        cny.trades.filter((t) => t.close < Date.parse('2015-01-14T18:28:40Z') / SEC),
        false,
      );
      expect([cut.count, cut.vwap.toFixed()]).toEqual([cutWant.count, cutWant.vwap.toFixed()]);
      const none = await rates.vwap(
        cny.base,
        cny.counter,
        new Date('2020-01-01T00:00:00Z'),
        new Date('2020-01-02T00:00:00Z'),
      );
      expect([none.count, none.vwap.toFixed(), none.baseVolume.toFixed(), none.counterVolume.toFixed()]).toEqual([
        0,
        '0',
        '0',
        '0',
      ]);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('on synthetic trades', () => {
    const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
    const BUYER = 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD';
    const SELLER = 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7';
    /** The date of most tests: noon on 2016-06-15, in unix seconds. */
    const D = Date.UTC(2016, 5, 15, 12, 0, 0) / SEC;

    /** A market named by its requested pair; the stored pair is the canonical order of it. */
    function marketOf(base: Asset, counter: Asset): { stored: { base: Asset; counter: Asset; inverted: boolean } } {
      return { stored: canonicalPair(base, counter) };
    }

    type Spec = [offset: number, base: string, counter: string];
    interface Pending {
      asset: Asset;
      nativeCurrency: string;
      specs: Spec[];
    }

    /** The row of a trade of a stored pair, at a ledger. */
    function exchangeRow(
      stored: { base: Asset; counter: Asset },
      ledger: number,
      close: number,
      spec: Spec,
      k: number,
    ): ExchangesRow {
      const [, baseAmount, counterAmount] = spec;
      const rate = new Wide(counterAmount).dividedBy(baseAmount);
      return {
        base_currency: stored.base.currency,
        base_issuer: stored.base.issuer ?? '',
        counter_currency: stored.counter.currency,
        counter_issuer: stored.counter.issuer ?? '',
        ledger_index: ledger,
        tx_index: 1 + (k % 5),
        node_index: 1 + (k % 3),
        tx_hash: `${k}`.padStart(64, 'E'),
        close_time: close,
        base_amount: baseAmount,
        counter_amount: counterAmount,
        base_amount_f: Number(baseAmount),
        counter_amount_f: Number(counterAmount),
        rate: rate.isFinite() ? rate.toString() : '0',
        rate_f: Number(rate),
        buyer: BUYER,
        seller: SELLER,
        taker: SELLER,
        provider: BUYER,
        offer_sequence: 7,
        autobridged_currency: null,
        autobridged_issuer: null,
        tx_type: 'OfferCreate',
        client: null,
      };
    }

    /**
     * Writes the ledgers (one per distinct close second, in the order of time) and the exchanges of the markets, and
     * returns each market as the oracle wants it: the trades of the stored pair, in key order.
     */
    async function seed(ch: ClickHouseService, pending: Pending[]): Promise<Map<string, Market>> {
      const closes = [...new Set(pending.flatMap((p) => p.specs.map(([offset]) => D + offset)))].sort((a, b) => a - b);
      const ledgerOf = new Map(closes.map((close, i) => [close, 5000 + i * 3]));
      await ch.insert(
        Table.Ledgers,
        closes.map((close) => ({
          ledger_index: ledgerOf.get(close),
          ledger_hash: `${ledgerOf.get(close)}`.padStart(64, 'C'),
          close_time: close,
        })),
      );
      const markets = new Map<string, Market>();
      const written: ExchangesRow[] = [];
      let k = 0;
      for (const p of pending) {
        const stored = canonicalPair(p.asset, { currency: p.nativeCurrency });
        const market: Market = { base: stored.base, counter: stored.counter, trades: [] };
        for (const spec of p.specs) {
          const close = D + spec[0];
          const row = exchangeRow(stored, ledgerOf.get(close) as number, close, spec, k++);
          written.push(row);
          market.trades.push({
            ledger: row.ledger_index,
            tx: row.tx_index,
            node: row.node_index,
            close,
            base: spec[1],
            counter: spec[2],
          });
        }
        market.trades.sort((a, b) => a.ledger - b.ledger || a.tx - b.tx || a.node - b.node);
        markets.set(`${p.nativeCurrency}:${assetKey(p.asset)}`, market);
      }
      await ch.insert(Table.Exchanges, written);
      return markets;
    }

    const USD: Asset = { currency: 'USD', issuer: ISSUER };
    const ZZZ: Asset = { currency: 'ZZZ', issuer: ISSUER };
    const XRP: Asset = { currency: 'XRP' };
    const XAH: Asset = { currency: 'XAH' };

    // USD against XRP: the XRP is the stored counter. 67 trades in the 14 days up to D (more than 50), some before them,
    // some after, and two with an XRP leg of 0.0005 or less among the newest.
    const usdSpecs: Spec[] = [
      [-20 * DAY, '5', '10'],
      [-16 * DAY, '5', '10'],
      [-15 * DAY, '5', '10'],
      [-14 * DAY - 1, '7', '7'], // the second before the 14 days
      [-14 * DAY, '2', '3'], // the first second of them
      ...Array.from({ length: 60 }, (_, i): Spec => {
        const usd = 1 + (i % 4);
        return [-13 * DAY + i * 5 * HOUR, String(usd), String((usd * (10 + (i % 9))) / 10)];
      }),
      [-12 * HOUR, '10', '20'], // 00:00:00 on the day of D
      [-6 * HOUR, '30', '45'],
      [-3 * HOUR, '1', '0.0005'], // noise
      [-2 * HOUR, '1', '0.0004'], // noise
      [-1, '5', '12'],
      [0, '4', '10'], // D itself
      [1, '9', '90'],
      [8 * HOUR, '9', '90'],
      [DAY, '9', '90'],
    ];
    // XRP against ZZZ: the XRP is the stored base. 10 trades at 3 ZZZ per XRP, then 2 today (4 and 2 ZZZ per XRP).
    const zzzSpecs: Spec[] = [
      ...Array.from({ length: 10 }, (_, i): Spec => [-10 * DAY + i * HOUR, '10', '30']),
      [-5 * HOUR, '10', '40'],
      [-2 * HOUR, '30', '60'],
    ];

    let ch: ClickHouseService;
    let rates: RatesService;
    let markets: Map<string, Market>;
    let usd: Market;
    let zzz: Market;

    beforeAll(async () => {
      ch = await freshService();
      markets = await seed(ch, [
        { asset: USD, nativeCurrency: 'XRP', specs: usdSpecs },
        { asset: ZZZ, nativeCurrency: 'XRP', specs: zzzSpecs },
        // the same trades under Xahau's native currency: the service of XAH must see XAH as the native side
        { asset: USD, nativeCurrency: 'XAH', specs: usdSpecs.slice(-14) },
        // amounts a 30-place decimal cannot hold whole
        {
          asset: { currency: 'DST', issuer: ISSUER },
          nativeCurrency: 'XRP',
          specs: [
            [-3 * HOUR, '1e-35', '2'],
            [-2 * HOUR, '1.234567890123456e-25', '3'],
          ],
        },
        // amounts of 1e36 or more
        {
          asset: { currency: 'BIG', issuer: ISSUER },
          nativeCurrency: 'XRP',
          specs: [
            [-3 * HOUR, '2e+40', '5'],
            [-2 * HOUR, '1e+40', '7'],
          ],
        },
      ]);
      rates = new RatesService(ch, 'XRP');
      usd = markets.get(`XRP:${assetKey(USD)}`) as Market;
      zzz = markets.get(`XRP:${assetKey(ZZZ)}`) as Market;
    });

    const at = (offset: number): Date => iso(D + offset);

    it('the market has the shape the tests rely on', () => {
      const inWindow = closedIn(usd.trades, D - 14 * DAY, D + 1);
      expect(inWindow).toHaveLength(67);
      expect(closedIn(usd.trades, D - 12 * HOUR, D + 1)).toHaveLength(6);
      // the newest 50 of the window hold both noise trades
      expect(inWindow.slice(-50).filter((t) => new BigNumber(t.counter).lte(NOISE))).toHaveLength(2);
      expect(usd.base.currency).toBe('USD');
      expect(usd.counter.currency).toBe('XRP');
      expect(zzz.base.currency).toBe('XRP');
      expect(zzz.counter.currency).toBe('ZZZ');
    });

    /** Seconds from D: the edges of the windows, one second each side. */
    const OFFSETS = [
      -20 * DAY,
      -14 * DAY - 1,
      -14 * DAY,
      -14 * DAY + 1,
      -13 * DAY,
      -DAY,
      -12 * HOUR - 1,
      -12 * HOUR,
      -12 * HOUR + 1,
      -3 * HOUR,
      -1,
      0,
      1,
      8 * HOUR,
      DAY - 1,
      DAY,
      2 * DAY,
      15 * DAY,
      40 * DAY,
    ];

    describe('the hand-worked market: XRP against ZZZ', () => {
      // the day of D: 10 XRP for 40 ZZZ and 30 XRP for 60: 100 ZZZ for 40 XRP, 2.5. Last trades: those two and the 10 of
      // 3 ZZZ per XRP (100 XRP, 300 ZZZ): 400 ZZZ for 140 XRP. The rate is the average of the two.
      const DAILY = new BigNumber('2.5');
      const LATEST = new Wide(400).dividedBy(140);

      it('rate = (daily + latest) / 2', async () => {
        const rate = await rates.exchangeRate(XRP, ZZZ, { date: at(0) });
        expect(rate.toFixed()).toBe(DAILY.plus(LATEST).times('0.5').toFixed());
        expect(rate.toPrecision(8)).toBe('2.6785714');
      });

      it('the pair the other way round is the inverse volumes, not the inverse of the rate', async () => {
        // ZZZ -> XRP: the day 40 XRP for 100 ZZZ, the last trades 140 XRP for 400 ZZZ
        const rate = await rates.exchangeRate(ZZZ, XRP, { date: at(0) });
        const daily = new Wide(40).dividedBy(100);
        const latest = new Wide(140).dividedBy(400);
        expect(rate.toFixed()).toBe(daily.plus(latest).times('0.5').toFixed());
      });

      it('live skips the daily rate: only the latest trades', async () => {
        const rate = await rates.exchangeRate(XRP, ZZZ, { date: at(0), live: true });
        expect(rate.toFixed()).toBe(LATEST.toFixed());
      });

      it('with fewer than 10 trades the latest rate is 0 in strict mode, and so is the rate', async () => {
        // 9 trades of 3 ZZZ per XRP by 8 hours into the first day: the day has 9 trades, the last trades are those 9
        const date = at(-10 * DAY + 8 * HOUR);
        const strict = await rates.exchangeRate(XRP, ZZZ, { date });
        expect(strict.toFixed()).toBe('0');
        const lax = await rates.exchangeRate(XRP, ZZZ, { date, strict: false });
        expect(lax.toFixed()).toBe('3');
        // the tenth trade makes it 10, enough
        const ten = await rates.exchangeRate(XRP, ZZZ, { date: at(-10 * DAY + 9 * HOUR) });
        expect(ten.toFixed()).toBe('3');
      });

      it('a day with no trade has only the latest rate', async () => {
        // the 12th of June: the ten trades of the 5th are 7 days back, within the 14 days; the day itself has none
        const date = at(-3 * DAY);
        const rate = await rates.exchangeRate(XRP, ZZZ, { date });
        expect(rate.toFixed()).toBe('3');
      });

      it('the date is inclusive to the second: the trade at D counts, the one a second later does not', async () => {
        // two trades 10 XRP for 40 ZZZ at -5h and ... use usd instead: trade at 0 and trade at +1
        const before = await rates.exchangeRate(USD, XRP, { date: at(-1), live: true, strict: false });
        const exact = await rates.exchangeRate(USD, XRP, { date: at(0), live: true, strict: false });
        const after = await rates.exchangeRate(USD, XRP, { date: at(1), live: true, strict: false });
        expect(new Set([before.toFixed(), exact.toFixed(), after.toFixed()]).size).toBe(3);
      });
    });

    describe('the windows, against the oracle', () => {
      it.each([
        ['strict', {}],
        ['strict=false', { strict: false }],
        ['live', { live: true }],
        ['live, strict=false', { live: true, strict: false }],
      ])('USD/XRP and XRP/USD at every edge, %s', async (_name, extra) => {
        const cases = OFFSETS.flatMap((offset) => [false, true].map((inverted) => ({ offset, inverted })));
        await inBatches(cases, async ({ offset, inverted }) => {
          const o = { date: at(offset), ...extra };
          const [b, c] = inverted ? [XRP, USD] : [USD, XRP];
          expectSame([offset, inverted], await rates.exchangeRate(b, c, o), oracleRate(usd, 'XRP', inverted, o));
        });
      });

      it.each(RATE_PERIODS)('period=%s: the window ends a second before the date, at every edge', async (period) => {
        const length = PERIOD_SECONDS[period];
        // each edge of the window [D - 1 - length, D): one second inside and one outside, on trades placed there
        const offsets = [-length - 2, -length - 1, -length, -1, 0, 1, 8 * HOUR, DAY];
        await inBatches(
          offsets.flatMap((offset) => [false, true].map((inverted) => ({ offset, inverted }))),
          async ({ offset, inverted }) => {
            const o = { date: at(offset), period };
            const [b, c] = inverted ? [XRP, USD] : [USD, XRP];
            expectSame(
              [period, offset, inverted],
              await rates.exchangeRate(b, c, o),
              oracleRate(usd, 'XRP', inverted, o),
            );
          },
        );
      });

      it('period=hour by hand: the trades of the hour before D - 1s, noise out', async () => {
        // [D - 1h - 1s, D): the trades at -1 (5 USD for 12 XRP) and no other: 12/5
        const rate = await rates.exchangeRate(USD, XRP, { date: at(0), period: 'hour' });
        expect(rate.toFixed()).toBe('2.4');
        // D itself is outside the window of a date at D, inside that of a date a second later: 9 trade at +1 is not yet
        const next = await rates.exchangeRate(USD, XRP, { date: at(1), period: 'hour' });
        expect(next.toFixed()).toBe(new Wide(22).dividedBy(9).toFixed());
      });

      it('period ignores strict and live, and a period of the same asset is 1', async () => {
        const plain = await rates.exchangeRate(USD, XRP, { date: at(0), period: 'day' });
        const flags = await rates.exchangeRate(USD, XRP, { date: at(0), period: 'day', strict: false, live: true });
        expect(flags.toFixed()).toBe(plain.toFixed());
        expect((await rates.exchangeRate(USD, USD, { date: at(0), period: 'day' })).toFixed()).toBe('1');
      });

      it('the last 50 trades, not the 14 days: 67 trades in the window, only the newest 50 are read', async () => {
        const o = { date: at(0), live: true };
        const got = await rates.exchangeRate(USD, XRP, o);
        const all = oracleVwap(usd, 'XRP', closedIn(usd.trades, D - 14 * DAY, D + 1), false).vwap;
        // the newest 50 first and then the noise out of them: 48 trades
        const newest = oracleVwap(usd, 'XRP', closedIn(usd.trades, D - 14 * DAY, D + 1).slice(-50), false);
        expect(newest.count).toBe(48);
        expectSame('newest 50', got, newest.vwap);
        expect(got.toFixed()).not.toBe(all.toFixed());
      });

      it('noise (a native leg of 0.0005 or less) is out of every volume, 0.0005 itself too', async () => {
        const w = await rates.vwap(USD, XRP, at(-4 * HOUR), at(0));
        // -3h: 0.0005 and -2h: 0.0004 are out; -1: 5 USD for 12 XRP is in
        expect([w.count, w.baseVolume.toFixed(), w.counterVolume.toFixed()]).toEqual([1, '5', '12']);
        const both = await rates.vwap(USD, XRP, at(-4 * HOUR), at(1));
        expect([both.count, both.baseVolume.toFixed(), both.counterVolume.toFixed()]).toEqual([2, '9', '22']);
      });

      it('vwap() reads [from, toExclusive) to the second', async () => {
        const second = await rates.vwap(USD, XRP, at(-1), at(0));
        expect(second.count).toBe(1);
        const ms = await rates.vwap(USD, XRP, new Date(at(-1).getTime() + 500), new Date(at(0).getTime() + 500));
        // both bounds are cut to the second: [-1s, 0s) again
        expect([ms.count, ms.vwap.toFixed()]).toEqual([1, second.vwap.toFixed()]);
        const empty = await rates.vwap(USD, XRP, at(0), at(0));
        expect(empty.count).toBe(0);
      });

      it('Xahau: the native currency of the service decides what is native, XAH has no issuer', async () => {
        const xah = new RatesService(ch, 'XAH');
        const xahMarket = markets.get(`XAH:${assetKey(USD)}`) as Market;
        const o = { date: at(0), strict: false };
        const got = await xah.exchangeRate(USD, XAH, o);
        const want = oracleRate(xahMarket, 'XAH', false, o);
        expect(want.gt(0)).toBe(true);
        expectSame('XAH', got, want);
      });
    });

    describe('amounts and rows', () => {
      const DST: Asset = { currency: 'DST', issuer: ISSUER };
      const BIG: Asset = { currency: 'BIG', issuer: ISSUER };

      it('amounts below 1e-30 or past 30 places are not 0: the sums fall back to floats', async () => {
        const w = await rates.vwap(DST, XRP, at(-4 * HOUR), at(0));
        expect(w.count).toBe(2);
        expect(w.baseVolume.gt(0)).toBe(true);
        expect(w.baseVolume.toNumber()).toBe(1e-35 + 1.234567890123456e-25);
        expect(w.counterVolume.toNumber()).toBe(5);
        expect(w.vwap.isFinite() && w.vwap.gt(0)).toBe(true);
        expect(
          w.vwap
            .dividedBy(5 / (1e-35 + 1.234567890123456e-25))
            .minus(1)
            .abs()
            .lt('1e-12'),
        ).toBe(true);
        const rate = await rates.exchangeRate(DST, XRP, { date: at(0), strict: false });
        expect(rate.gt(0)).toBe(true);
        // and the other way round: tiny rates stay positive too
        const back = await rates.exchangeRate(XRP, DST, { date: at(0), strict: false });
        expect(back.gt(0) && back.lt('1e-24')).toBe(true);
      });

      it('amounts of 1e36 or more are summed as floats, not wrapped', async () => {
        const w = await rates.vwap(BIG, XRP, at(-4 * HOUR), at(0));
        expect(w.count).toBe(2);
        expect(w.baseVolume.toNumber()).toBe(3e40);
        expect(w.counterVolume.toNumber()).toBe(12);
        expect(w.vwap.toNumber()).toBeCloseTo(12 / 3e40, 50);
      });
    });

    describe('rows written twice (a second insert without deduplication, the merges stopped)', () => {
      // `exchanges` is a ReplacingMergeTree and the rates never use FINAL, so until a merge a row can be there twice (the
      // syncer re-writes a ledger it is not sure about). Two copies in one insert would be collapsed by ClickHouse on the
      // way in (`optimize_on_insert`), so the copies are a second insert. Half of the ledgers are copied, so the copies
      // change the sums (not only their count) wherever a read does not count each exchange once.
      let twice: ClickHouseService;
      let twiceRates: RatesService;
      let distinct: Map<string, Market>;
      let once: number;

      const countRows = async (): Promise<number> =>
        Number((await twice.query<{ n: string }>(`SELECT count() AS n FROM ${Table.Exchanges}`))[0].n);

      beforeAll(async () => {
        twice = await freshService();
        distinct = await seed(twice, [
          { asset: USD, nativeCurrency: 'XRP', specs: usdSpecs },
          { asset: ZZZ, nativeCurrency: 'XRP', specs: zzzSpecs },
        ]);
        once = await countRows();
        await twice.command(`SYSTEM STOP MERGES ${Table.Exchanges}`);
        await twice.command(
          `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges} WHERE ledger_index % 2 = 0`,
          {},
          { settings: { insert_deduplicate: 0 } },
        );
        twiceRates = new RatesService(twice, 'XRP');
      });

      it('the table really holds some exchanges twice', async () => {
        const copies = (await countRows()) - once;
        expect(copies).toBeGreaterThan(20);
        expect(copies).toBeLessThan(once);
        const [{ n }] = await twice.query<{ n: string }>(
          `SELECT count() AS n FROM (SELECT 1 FROM ${Table.Exchanges}
            GROUP BY base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index)`,
        );
        expect(Number(n)).toBe(once);
      });

      it('vwap() counts each exchange once: count and volumes', async () => {
        const m = distinct.get(`XRP:${assetKey(USD)}`) as Market;
        const window = closedIn(m.trades, D - 20 * DAY, D + 2 * DAY);
        const want = oracleVwap(m, 'XRP', window, false);
        const got = await twiceRates.vwap(USD, XRP, at(-20 * DAY), at(2 * DAY));
        expect([got.count, got.baseVolume.toFixed(), got.counterVolume.toFixed()]).toEqual([
          want.count,
          want.baseVolume.toFixed(),
          want.counterVolume.toFixed(),
        ]);
        expectSame('vwap', got.vwap, want.vwap);
      });

      it.each([
        ['strict', {}],
        ['strict=false', { strict: false }],
        ['live', { live: true }],
      ])(
        'exchangeRate() at every edge counts each exchange once, %s: the newest 50 are 50 distinct ones',
        async (_name, extra) => {
          const m = distinct.get(`XRP:${assetKey(USD)}`) as Market;
          const cases = OFFSETS.flatMap((offset) => [false, true].map((inverted) => ({ offset, inverted })));
          await inBatches(cases, async ({ offset, inverted }) => {
            const o = { date: at(offset), ...extra };
            const [b, c] = inverted ? [XRP, USD] : [USD, XRP];
            expectSame([offset, inverted], await twiceRates.exchangeRate(b, c, o), oracleRate(m, 'XRP', inverted, o));
          });
        },
      );

      it('exchangeRate() counts the trades of strict mode once: 9 trades, some of them stored twice, are 9', async () => {
        const m = distinct.get(`XRP:${assetKey(ZZZ)}`) as Market;
        const date = at(-10 * DAY + 8 * HOUR);
        expect(closedIn(m.trades, 0, D)).toHaveLength(12);
        // 9 trades closed by then, and the table holds more than 9 rows of them: 10 would be enough in strict mode
        const [{ n }] = await twice.query<{ n: string }>(
          `SELECT count() AS n FROM ${Table.Exchanges}
            WHERE base_currency = 'XRP' AND counter_currency = 'ZZZ' AND close_time <= toDateTime({at:UInt32}, 'UTC')`,
          { at: Math.floor(date.getTime() / SEC) },
        );
        expect(closedIn(m.trades, 0, Math.floor(date.getTime() / SEC) + 1)).toHaveLength(9);
        expect(Number(n)).toBeGreaterThanOrEqual(10);
        expectSame('strict', await twiceRates.exchangeRate(XRP, ZZZ, { date }), new BigNumber(0));
        expectSame(
          'lax',
          await twiceRates.exchangeRate(XRP, ZZZ, { date, strict: false }),
          oracleRate(m, 'XRP', false, { date, strict: false }),
        );
      });

      it('dailyNativeRates() counts each exchange once: the same rates as the database written once, and as exchangeRate()', async () => {
        const from = at(-20 * DAY);
        const to = at(2 * DAY);
        const got = await twiceRates.dailyNativeRates([USD, ZZZ], from, to);
        // `rates` reads the other database, which holds the same trades once
        const reference = await rates.dailyNativeRates([USD, ZZZ], from, to);
        let nonZero = 0;
        for (const asset of [USD, ZZZ]) {
          const mine = got.get(assetKey(asset)) as Map<string, BigNumber>;
          const theirs = reference.get(assetKey(asset)) as Map<string, BigNumber>;
          expect([...mine.keys()]).toEqual([...theirs.keys()]);
          for (const [day, rate] of mine) {
            expectSame([assetKey(asset), day], rate, theirs.get(day) as BigNumber);
            if (rate.gt(0)) nonZero++;
          }
        }
        // a comparison of zeros would prove nothing
        expect(nonZero).toBeGreaterThan(10);
        const day = new Date('2016-06-15T00:00:00Z');
        const exact = await twiceRates.exchangeRate(XRP, USD, {
          date: day,
          endExclusive: new Date(day.getTime() + DAY * SEC),
        });
        expectSame(
          '2016-06-15',
          (got.get(assetKey(USD)) as Map<string, BigNumber>).get('2016-06-15') as BigNumber,
          exact,
        );
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('dailyNativeRates and normalize', () => {
    const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
    const AAA: Asset = { currency: 'AAA', issuer: ISSUER }; // sorts before XRP: the native currency is the stored counter
    const ZZZ: Asset = { currency: 'ZZZ', issuer: ISSUER }; // sorts after: the native currency is the stored base
    const THIN: Asset = { currency: 'THN', issuer: ISSUER };
    const NONE: Asset = { currency: 'NON', issuer: ISSUER };
    const XRP: Asset = { currency: 'XRP' };
    const FIRST = Date.UTC(2016, 0, 1) / SEC;

    let ch: ClickHouseService;
    let rates: RatesService;

    beforeAll(async () => {
      ch = await freshService();
      // 60 days from 2016-01-01. AAA and ZZZ trade a few times a day (busy: more than 50 trades in 14 days, so the last
      // 50 move with the days), THIN trades on 3 days only.
      const rows: ExchangesRow[] = [];
      const closes = new Set<number>();
      const stored = (asset: Asset): { base: Asset; counter: Asset } => canonicalPair(asset, XRP);
      let k = 0;
      const push = (asset: Asset, close: number, assetAmount: string, xrpAmount: string): void => {
        const s = stored(asset);
        const [baseAmount, counterAmount] = s.base.issuer ? [assetAmount, xrpAmount] : [xrpAmount, assetAmount];
        rows.push({
          base_currency: s.base.currency,
          base_issuer: s.base.issuer ?? '',
          counter_currency: s.counter.currency,
          counter_issuer: s.counter.issuer ?? '',
          ledger_index: 0,
          tx_index: 1,
          node_index: 1 + (k % 3),
          tx_hash: `${k++}`.padStart(64, 'F'),
          close_time: close,
          base_amount: baseAmount,
          counter_amount: counterAmount,
          base_amount_f: Number(baseAmount),
          counter_amount_f: Number(counterAmount),
          rate: new Wide(counterAmount).dividedBy(baseAmount).toString(),
          rate_f: Number(counterAmount) / Number(baseAmount),
          buyer: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
          seller: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
          taker: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
          provider: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
          offer_sequence: 1,
          autobridged_currency: null,
          autobridged_issuer: null,
          tx_type: 'OfferCreate',
          client: null,
        });
        closes.add(close);
      };
      for (let day = 0; day < 60; day++) {
        for (const [i, hour] of [3, 9, 15, 21].entries()) {
          const close = FIRST + day * DAY + hour * HOUR + (day % 7) * 60;
          // a different price every day and trade; XRP per unit of the asset (AAA, ZZZ: 1 unit buys 'price' XRP)
          const price = 2 + ((day * 7 + i * 3) % 11) / 4;
          push(AAA, close, '10', String(10 * price));
          push(ZZZ, close + 1, '20', String(20 * (price + 0.5)));
        }
        if ([5, 6, 40].includes(day)) {
          for (let i = 0; i < 4; i++) push(THIN, FIRST + day * DAY + (i + 1) * HOUR, '5', String(5 * (1 + i)));
        }
      }
      const ordered = [...closes].sort((a, b) => a - b);
      const ledgerOf = new Map(ordered.map((close, i) => [close, 9000 + i * 2]));
      await ch.insert(
        Table.Ledgers,
        ordered.map((close) => ({
          ledger_index: ledgerOf.get(close),
          ledger_hash: `${ledgerOf.get(close)}`.padStart(64, 'C'),
          close_time: close,
        })),
      );
      await ch.insert(
        Table.Exchanges,
        rows.map((row) => ({ ...row, ledger_index: ledgerOf.get(row.close_time) as number })),
      );
      rates = new RatesService(ch, 'XRP');
    });

    const dayStart = (n: number): Date => iso(FIRST + n * DAY);
    const dayKey = (n: number): string => dayStart(n).toISOString().slice(0, 10);

    it('is the rate of each day: exchangeRate(native, asset) with a date that names the day', async () => {
      const days = 60;
      const all = await rates.dailyNativeRates([AAA, ZZZ, THIN, NONE, XRP], dayStart(0), dayStart(days));
      expect([...all.keys()].sort()).toEqual([AAA, ZZZ, THIN, NONE, XRP].map(assetKey).sort());
      for (const asset of [AAA, ZZZ, THIN]) {
        const mine = all.get(assetKey(asset)) as Map<string, BigNumber>;
        expect([...mine.keys()]).toEqual(Array.from({ length: days }, (_, n) => dayKey(n)));
        await inBatches(
          Array.from({ length: days }, (_, n) => n),
          async (n) => {
            const want = await rates.exchangeRate(XRP, asset, {
              date: dayStart(n),
              endExclusive: dayStart(n + 1),
            });
            expectSame([assetKey(asset), n], mine.get(dayKey(n)) as BigNumber, want);
          },
        );
      }
      // an asset nobody trades is 0 every day, the native currency 1
      expect([...(all.get(assetKey(NONE)) as Map<string, BigNumber>).values()].every((r) => r.isZero())).toBe(true);
      expect([...(all.get(assetKey(XRP)) as Map<string, BigNumber>).values()].every((r) => r.isEqualTo(1))).toBe(true);
    });

    it('busy assets have a rate from the third day on, one that moves; a thin asset never has 10 trades, so it has none', async () => {
      const all = await rates.dailyNativeRates([AAA, THIN], dayStart(0), dayStart(60));
      const aaa = [...(all.get(assetKey(AAA)) as Map<string, BigNumber>).values()];
      // the first days have fewer than 10 trades in the window: 0 (strict); from the third day on, 12 and more
      expect(aaa.slice(0, 2).every((r) => r.isZero())).toBe(true);
      expect(aaa.slice(2).every((r) => r.gt(0))).toBe(true);
      expect(new Set(aaa.map((r) => r.toFixed())).size).toBeGreaterThan(10);
      // THIN: 4 trades on each of 3 days: never 10 trades in 14 days before day 6 (8 trades on days 5 and 6), so 0; days 40
      // and the few after it are the same
      const thin = all.get(assetKey(THIN)) as Map<string, BigNumber>;
      expect([...thin.values()].every((r) => r.isZero())).toBe(true);
    });

    it('the range is days: the first is cut to its midnight, the end is exclusive, an empty range is empty', async () => {
      const mid = new Date(dayStart(10).getTime() + 5 * HOUR * SEC);
      const some = await rates.dailyNativeRates([AAA], mid, dayStart(13));
      expect([...(some.get(assetKey(AAA)) as Map<string, BigNumber>).keys()]).toEqual([
        dayKey(10),
        dayKey(11),
        dayKey(12),
      ]);
      const none = await rates.dailyNativeRates([AAA, XRP], dayStart(5), dayStart(5));
      expect([...none.keys()]).toEqual([assetKey(AAA), assetKey(XRP)]);
      expect((none.get(assetKey(AAA)) as Map<string, BigNumber>).size).toBe(0);
      await expect(rates.dailyNativeRates([AAA], dayStart(0), new Date('2100-01-01T00:00:00Z'))).rejects.toThrow(
        RangeError,
      );
      await expect(rates.dailyNativeRates([AAA], new Date(NaN), dayStart(1))).rejects.toThrow(RangeError);
    });

    it('a handful of queries for 60 days: one grouped read per asset, and only the last-50 windows that differ', async () => {
      const spy = jest.spyOn(ch, 'query');
      const lookups = jest.spyOn(ch, 'queryOne');
      await rates.dailyNativeRates([THIN], dayStart(0), dayStart(60));
      // THIN: one grouped read, and the windows (3 days of trades, 15 days of window each) give few distinct ledger spans
      const exchangeReads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`));
      expect(exchangeReads.length).toBeGreaterThanOrEqual(1);
      expect(exchangeReads.length).toBeLessThanOrEqual(1 + 6);
      expect(lookups.mock.calls.length).toBe(2);
    });

    describe('normalize', () => {
      const date = new Date(dayStart(30).getTime() + 12 * HOUR * SEC);

      it('is rate(from -> native) / rate(to -> native), converted = amount * rate', async () => {
        const rateAAA = await rates.exchangeRate(AAA, XRP, { date });
        const rateZZZ = await rates.exchangeRate(ZZZ, XRP, { date });
        expect(rateAAA.gt(0) && rateZZZ.gt(0)).toBe(true);
        const n = await rates.normalize(new BigNumber(10), AAA, ZZZ, { date });
        expect(n.rate.toFixed()).toBe(new Wide(rateAAA).dividedBy(rateZZZ).toFixed());
        expect(n.converted.toFixed()).toBe(new BigNumber(10).times(n.rate).toFixed());
      });

      it('to the native currency, from it, and between two assets in both directions', async () => {
        const rateAAA = await rates.exchangeRate(AAA, XRP, { date });
        const toNative = await rates.normalize(new BigNumber(10), AAA, XRP, { date });
        expect(toNative.rate.toFixed()).toBe(rateAAA.toFixed());
        expect(toNative.converted.toFixed()).toBe(rateAAA.times(10).toFixed());
        const fromNative = await rates.normalize(new BigNumber(10), XRP, AAA, { date });
        expect(fromNative.rate.toFixed()).toBe(new Wide(1).dividedBy(rateAAA).toFixed());
        const there = await rates.normalize(new BigNumber(3), AAA, ZZZ, { date });
        const back = await rates.normalize(new BigNumber(3), ZZZ, AAA, { date });
        expect(there.rate.times(back.rate).minus(1).abs().lt('1e-150')).toBe(true);
      });

      it('the same asset is rate 1 and the amount, even with no rate; native to native too', async () => {
        for (const asset of [AAA, NONE, XRP]) {
          const r = await rates.normalize(new BigNumber('12.5'), asset, { ...asset }, { date });
          expect([r.rate.toFixed(), r.converted.toFixed()]).toEqual(['1', '12.5']);
        }
      });

      it('a currency without a rate is 0: as the source or as the target', async () => {
        const noFrom = await rates.normalize(new BigNumber(10), NONE, AAA, { date });
        expect([noFrom.rate.toFixed(), noFrom.converted.toFixed()]).toEqual(['0', '0']);
        const noTo = await rates.normalize(new BigNumber(10), AAA, NONE, { date });
        expect([noTo.rate.toFixed(), noTo.converted.toFixed()]).toEqual(['0', '0']);
      });

      it('strict decides whether a currency has a rate', async () => {
        // THIN has 4 trades a day: no rate in strict mode, a rate with strict=false
        const d = new Date(dayStart(5).getTime() + 12 * HOUR * SEC);
        expect((await rates.normalize(new BigNumber(1), THIN, XRP, { date: d })).rate.toFixed()).toBe('0');
        const lax = await rates.normalize(new BigNumber(1), THIN, XRP, { date: d, strict: false });
        expect(lax.rate.gt(0)).toBe(true);
        expect(lax.rate.toFixed()).toBe((await rates.exchangeRate(THIN, XRP, { date: d, strict: false })).toFixed());
      });

      it('the date names a period: endExclusive reaches to its end', async () => {
        const day = dayStart(30);
        const wholeDay = await rates.normalize(new BigNumber(1), AAA, XRP, { date: day, endExclusive: dayStart(31) });
        const midnight = await rates.normalize(new BigNumber(1), AAA, XRP, { date: day });
        expect(wholeDay.rate.toFixed()).not.toBe(midnight.rate.toFixed());
        expect(wholeDay.rate.toFixed()).toBe(
          (await rates.exchangeRate(AAA, XRP, { date: day, endExclusive: dayStart(31) })).toFixed(),
        );
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the SQL', () => {
    const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
    const USD: Asset = { currency: 'USD', issuer: ISSUER };
    const XRP: Asset = { currency: 'XRP' };
    const FIRST = Date.UTC(2016, 0, 1) / SEC;
    let ch: ClickHouseService;
    let rates: RatesService;

    beforeAll(async () => {
      ch = await freshService();
      // 400 trades of USD/XRP, one ledger each, a minute apart, so the 14 days hold far more than 50
      const rows = Array.from({ length: 400 }, (_, i) => ({
        base_currency: 'USD',
        base_issuer: ISSUER,
        counter_currency: 'XRP',
        counter_issuer: '',
        ledger_index: 20_000 + i,
        tx_index: 1,
        node_index: 1,
        tx_hash: `${i}`.padStart(64, 'A'),
        close_time: FIRST + i * 60,
        base_amount: '10',
        counter_amount: String(20 + (i % 7)),
        base_amount_f: 10,
        counter_amount_f: 20 + (i % 7),
        rate: String((20 + (i % 7)) / 10),
        rate_f: (20 + (i % 7)) / 10,
        buyer: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
        seller: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
        taker: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
        provider: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
        offer_sequence: 1,
        autobridged_currency: null,
        autobridged_issuer: null,
        tx_type: 'OfferCreate',
        client: null,
      }));
      await ch.insert(
        Table.Ledgers,
        rows.map((r) => ({
          ledger_index: r.ledger_index,
          ledger_hash: `${r.ledger_index}`.padStart(64, 'C'),
          close_time: r.close_time,
        })),
      );
      await ch.insert(Table.Exchanges, rows);
      rates = new RatesService(ch, 'XRP');
    });

    /** The queries a call sent to the exchanges, with their bound values. */
    async function exchangeQueries(
      run: () => Promise<unknown>,
    ): Promise<{ sql: string; params: Record<string, unknown> }[]> {
      const spy = jest.spyOn(ch, 'query');
      await run();
      const calls = spy.mock.calls
        .filter(([sql]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(sql)))
        .map(([sql, params]) => ({ sql: String(sql), params: (params ?? {}) as Record<string, unknown> }));
      spy.mockRestore();
      return calls;
    }

    const pipelineOf = async (q: { sql: string; params: Record<string, unknown> }): Promise<string> =>
      (await ch.query<{ explain: string }>(`EXPLAIN PIPELINE ${q.sql}`, q.params)).map((r) => r.explain).join('\n');

    const date = new Date((FIRST + 399 * 60) * SEC);

    it('a rate is two queries on the exchanges, everything bound, the table from the Table enum', async () => {
      const queries = await exchangeQueries(() => rates.exchangeRate(USD, XRP, { date }));
      expect(queries).toHaveLength(2);
      for (const { sql, params } of queries) {
        // no value written into the text: the pair and the ledgers are parameters
        expect(sql).not.toContain(ISSUER);
        expect(sql).toContain('{pair0:String}');
        expect(sql).toContain('ledger_index BETWEEN {min:UInt32} AND {max:UInt32}');
        expect(params).toMatchObject({ pair0: 'USD', pair1: ISSUER, pair2: 'XRP', pair3: '' });
        expect(sql).toContain('LIMIT 1 BY base_currency, base_issuer, counter_currency, counter_issuer, ledger_index');
      }
    });

    it('the last 50 are read in reverse key order, stop after 50, and are never sorted', async () => {
      const queries = await exchangeQueries(() => rates.exchangeRate(USD, XRP, { date, live: true }));
      expect(queries).toHaveLength(1);
      const [latest] = queries;
      expect(latest.params.newest).toBe(50);
      expect(latest.sql).toContain('LIMIT {newest:UInt32}');
      // the whole key, descending, so that ClickHouse can read the primary key backwards
      expect(latest.sql).toContain(
        'ORDER BY base_currency DESC, base_issuer DESC, counter_currency DESC, counter_issuer DESC, ledger_index DESC, tx_index DESC, node_index DESC',
      );
      const pipeline = await pipelineOf(latest);
      const read = pipeline.slice(pipeline.lastIndexOf('(LimitBy)'));
      expect(read).toContain('ReadPoolInOrder');
      expect(read).toContain('algorithm: InReverseOrder');
      expect(/SortingTransform/.test(pipeline)).toBe(false);
    });

    it('the daily rate is read in key order too (the key range of the day), and the noise filter sits inside', async () => {
      const queries = await exchangeQueries(() => rates.exchangeRate(USD, XRP, { date }));
      const daily = queries.find((q) => q.params.newest === undefined) as {
        sql: string;
        params: Record<string, unknown>;
      };
      expect(daily.sql).toContain('counter_amount_f > 0.0005');
      expect(daily.sql).not.toContain('base_amount_f > 0.0005');
      const pipeline = await pipelineOf(daily);
      expect(pipeline).toContain('ReadPoolInOrder');
      expect(/SortingTransform/.test(pipeline)).toBe(false);
    });

    it('a window with no ledger sends no query on the exchanges', async () => {
      const queries = await exchangeQueries(() =>
        rates.exchangeRate(USD, XRP, { date: new Date('2001-01-01T00:00:00Z') }),
      );
      expect(queries).toHaveLength(0);
    });

    it('all the periods and the vwap send one query', async () => {
      for (const period of RATE_PERIODS) {
        const queries = await exchangeQueries(() => rates.exchangeRate(USD, XRP, { date, period }));
        expect([period, queries.length]).toEqual([period, 1]);
      }
      expect(await exchangeQueries(() => rates.vwap(USD, XRP, new Date(FIRST * SEC), date))).toHaveLength(1);
    });
  });
});
