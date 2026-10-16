import BigNumber from 'bignumber.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeDailyVolumes,
  computeDailyVolumeSet,
  computeLiveVolumes,
  computeLiveVolumeSet,
  dailySetVersions,
  LivePeriod,
  liveSetVersions,
  PAYMENT_LIVE_PERIODS,
  TRADE_LIVE_PERIODS,
  VOLUME_DAY_SETTLE_MS,
  VOLUME_METRICS,
  volumeDaysDone,
  VolumeMetric,
  VolumeRecomputeAborted,
} from '../src/aggregate/volume.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { ExchangesRow, PaymentsRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile, MarketsConfig } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { Asset, canonicalPair } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';
import { asset, ExpectedComponent, paymentOracle, tradeOracle, tradesOf } from './volume-oracle';

/**
 * The volume jobs (`computeDailyVolumes`, `computeLiveVolumes`) on a real ClickHouse.
 *
 * Part 1 seeds the 54 mock ledgers of the original Ripple test suite through the real `LedgerWriter` and a markets config
 * built from pairs and currencies that are in them (`fixtures/xrpl/volume-markets.json`: native-counter markets, one with
 * the native currency as its base, non-native markets that convert through the base leg, through the counter leg, and one
 * that cannot be converted). An oracle written from the rows the writer stores (plain JavaScript and BigNumber, never the
 * services under test; only the rate a payment is converted with is `RatesService.exchangeRate`, which has its own oracle in
 * `rates.e2e-spec.ts`) says what every set has to hold.
 *
 * Part 2 is a small synthetic world with numbers worked out by hand: every branch of the conversion, the rate a payment
 * is converted with, native dust, trades written twice.
 *
 * Part 3 is what the readers rely on: one version per set, a component that vanishes, the sentinel, real duplicate rows,
 * `volumeDaysDone` and the abort.
 */

const SEC = 1000;
const DAY = 86_400;
const HOUR = 3600;

const profile = getNetworkProfile('xrpl');
const ctx = parseContextFor(profile);
const ledgers = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/ripple-mock')).list();
const built = ledgers.map((l) => buildLedgerRows(l, ctx));
const exchangeRows: ExchangesRow[] = built.flatMap((b) => b.exchanges);
const paymentRows: PaymentsRow[] = built.flatMap((b) => b.payments);
const MARKETS = JSON.parse(readFileSync(join(__dirname, 'fixtures/xrpl/volume-markets.json'), 'utf8')) as MarketsConfig;

const XRP: Asset = { currency: 'XRP' };
const unix = (text: string): number => Date.parse(text) / 1000;
const at = (seconds: number): Date => new Date(seconds * SEC);

// ---------------------------------------------------------------------------------------------------------------------
// What a reader sees: the rows of the newest version of a set.
// ---------------------------------------------------------------------------------------------------------------------

interface StoredRow {
  metric: string;
  component: string;
  base_currency: string;
  base_issuer: string;
  counter_currency: string;
  counter_issuer: string;
  amount: string;
  amount_f: number;
  count: number;
  rate_f: number;
  converted_f: number;
  config_version: number;
  version: number;
  start_time?: number;
  end_time?: number;
}

const COLUMNS = `metric, component, base_currency, base_issuer, counter_currency, counter_issuer, amount, amount_f,
  toUInt64(count) AS count, rate_f, converted_f, config_version, toUInt64(version) AS version`;

function numbers(r: StoredRow): StoredRow {
  return {
    ...r,
    amount_f: Number(r.amount_f),
    count: Number(r.count),
    rate_f: Number(r.rate_f),
    converted_f: Number(r.converted_f),
    config_version: Number(r.config_version),
    version: Number(r.version),
    ...(r.start_time !== undefined && { start_time: Number(r.start_time), end_time: Number(r.end_time) }),
  };
}

async function dailySet(ch: ClickHouseService, metric: VolumeMetric, day: string): Promise<StoredRow[]> {
  const rows = await ch.query<StoredRow>(
    `SELECT ${COLUMNS} FROM ${Table.VolumeDaily}
      WHERE metric = {metric:String} AND day = {day:Date}
        AND version = (SELECT max(version) FROM ${Table.VolumeDaily} WHERE metric = {metric:String} AND day = {day:Date})
      ORDER BY component`,
    { metric, day },
  );
  return rows.map(numbers);
}

async function liveSet(ch: ClickHouseService, metric: VolumeMetric, period: LivePeriod): Promise<StoredRow[]> {
  const rows = await ch.query<StoredRow>(
    `SELECT ${COLUMNS}, toUnixTimestamp(start_time) AS start_time, toUnixTimestamp(end_time) AS end_time
       FROM ${Table.VolumeLive}
      WHERE metric = {metric:String} AND period = {period:String}
        AND version = (SELECT max(version) FROM ${Table.VolumeLive} WHERE metric = {metric:String} AND period = {period:String})
      ORDER BY component`,
    { metric, period },
  );
  return rows.map(numbers);
}

/** The components of a set (the sentinel is not one), the largest converted amount first like the readers list them. */
const parts = (rows: StoredRow[]): StoredRow[] =>
  rows
    .filter((r) => r.component !== '')
    .sort((a, b) => b.converted_f - a.converted_f || (a.component < b.component ? -1 : 1));

/**
 * The sentinel row of a set of a day, as the job writes it, with the version and the config version of the test; `final`
 * is the flag of the set (`rate_f` 1: the ingest had passed the day when it was written).
 */
const setOfSentinel = (metric: string, day: string, version: number, configVersion: number, final = true) => ({
  ...SAMPLE_ROWS[Table.VolumeDaily],
  metric,
  day,
  component: '',
  base_currency: '',
  base_issuer: '',
  counter_currency: '',
  counter_issuer: '',
  amount: '0',
  amount_f: 0,
  count: 0,
  rate_f: final ? 1 : 0,
  converted_f: 0,
  config_version: configVersion,
  version,
});

/** Every row of every version of a (metric, day), oldest first. */
async function allDailyRows(ch: ClickHouseService, metric: VolumeMetric, day: string): Promise<StoredRow[]> {
  const rows = await ch.query<StoredRow>(
    `SELECT ${COLUMNS} FROM ${Table.VolumeDaily} WHERE metric = {metric:String} AND day = {day:Date} ORDER BY version, component`,
    { metric, day },
  );
  return rows.map(numbers);
}

/** Two numbers agree to 12 significant digits (a division, a float sum: not the same last digit everywhere). */
function close(label: string, got: number, want: number): void {
  const tolerance = Math.max(Math.abs(want) * 1e-12, 1e-300);
  if (Math.abs(got - want) > tolerance) throw new Error(`${label}: got ${got}, want ${want}`);
}

/** The components as a reader sees them, compared with the oracle (amounts exactly, the divisions to 12 digits). */
function expectTrades(got: StoredRow[], want: ExpectedComponent[]): void {
  const rows = parts(got).sort((a, b) => b.converted_f - a.converted_f || (a.component < b.component ? -1 : 1));
  expect(rows.map((r) => r.component)).toEqual(want.map((w) => w.component));
  rows.forEach((r, i) => {
    const w = want[i];
    expect([r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer]).toEqual([
      w.base.currency,
      w.base.issuer ?? '',
      w.counter.currency,
      w.counter.issuer ?? '',
    ]);
    expect(new BigNumber(r.amount).toFixed()).toBe(w.amount.toFixed());
    expect(r.count).toBe(w.count);
    close(`${r.component} amount_f`, r.amount_f, w.amount.toNumber());
    close(`${r.component} converted`, r.converted_f, w.converted.toNumber());
    close(`${r.component} rate`, r.rate_f, w.rate.toNumber());
  });
}

function expectPayments(got: StoredRow[], want: Awaited<ReturnType<typeof paymentOracle>>): void {
  const rows = parts(got).sort((a, b) => b.converted_f - a.converted_f || (a.component < b.component ? -1 : 1));
  expect(rows.map((r) => r.component)).toEqual(want.map((w) => w.component));
  rows.forEach((r, i) => {
    const w = want[i];
    expect([r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer]).toEqual([
      w.asset.currency,
      w.asset.issuer ?? '',
      '',
      '',
    ]);
    expect(new BigNumber(r.amount).toFixed()).toBe(w.amount.toFixed());
    expect(r.count).toBe(w.count);
    close(`${r.component} converted`, r.converted_f, w.converted.toNumber());
    close(`${r.component} rate`, r.rate_f, w.rate.toNumber());
  });
}

// ---------------------------------------------------------------------------------------------------------------------

describe('volume jobs (e2e)', () => {
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

  async function freshService(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `volume_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  // -------------------------------------------------------------------------------------------------------------------
  describe('on the mock ledgers of the original Ripple API', () => {
    let ch: ClickHouseService;
    let rates: RatesService;

    beforeAll(async () => {
      ch = await freshService();
      await new LedgerWriter(ch, ctx).write(ledgers);
      rates = new RatesService(ch, 'XRP');
    });

    it('the config has what the tests rely on: native markets, a native base, both conversion branches, no rate', () => {
      const day = tradeOracle(MARKETS, exchangeRows, unix('2015-01-14T00:00:00Z'), unix('2015-01-15T00:00:00Z'));
      const keys = day.map((c) => c.component);
      expect(keys).toEqual(expect.arrayContaining(['CNY.rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y/XRP']));
      // the market that has the native currency as its base is normalised: BTC against XRP
      expect(keys).toContain('BTC.rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q/XRP');
      // through the base leg
      expect(keys).toContain('CNY.rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y/JPY.rMAz5ZnK73nyNUL4foAvaxdreczCkG3vA6');
      // through the counter leg: FMM has no native market, STR has; base and counter swap
      const swapped = day.find((c) => c.component.startsWith('FMM.'));
      expect(swapped?.base.currency).toBe('STR');
      expect(swapped?.counter.currency).toBe('FMM');
      // no rate for either leg: dropped (the JPY pair has trades)
      expect(keys.some((k) => k.startsWith('JPY.r94s8'))).toBe(false);
      expect(
        tradesOf(
          exchangeRows,
          asset(MARKETS.tradeMarkets[12].base),
          asset(MARKETS.tradeMarkets[12].counter),
          0,
          2 ** 32,
        ).count,
      ).toBe(2);
      // the market with trades only in 2016 has none on that day
      expect(keys.some((k) => k.startsWith('USD.rhub8'))).toBe(false);
    });

    describe('trade_volume of a day', () => {
      it('2015-01-14: every component is what the oracle says, sorted by converted amount, count and total', async () => {
        await computeDailyVolumes(ch, rates, MARKETS, new Date('2015-01-14T00:00:00Z'));
        const set = await dailySet(ch, 'trade_volume', '2015-01-14');
        const want = tradeOracle(MARKETS, exchangeRows, unix('2015-01-14T00:00:00Z'), unix('2015-01-15T00:00:00Z'));
        expect(want.length).toBeGreaterThan(8);
        expectTrades(set, want);
        // every row of the set carries the config version
        expect(new Set(set.map((r) => r.config_version))).toEqual(new Set([MARKETS.version]));
      });

      it('2016-03-28: the market with trades in 2016 only', async () => {
        await computeDailyVolumes(ch, rates, MARKETS, new Date('2016-03-28T00:00:00Z'));
        const set = await dailySet(ch, 'trade_volume', '2016-03-28');
        const want = tradeOracle(MARKETS, exchangeRows, unix('2016-03-28T00:00:00Z'), unix('2016-03-29T00:00:00Z'));
        expect(want.map((w) => w.component)).toEqual(['USD.rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq/XRP']);
        expectTrades(set, want);
      });

      it('a day with ledgers but no trade, and a day with no ledger at all, hold the sentinel only: final, the ingest is past them', async () => {
        for (const day of ['2013-06-11', '2014-06-01']) {
          await computeDailyVolumes(ch, rates, MARKETS, new Date(`${day}T00:00:00Z`));
          const set = await dailySet(ch, 'trade_volume', day);
          expect(set).toHaveLength(1);
          expect(set[0]).toMatchObject({
            component: '',
            count: 0,
            amount: '0',
            converted_f: 0,
            rate_f: 1,
            config_version: 7,
          });
        }
      });

      it('the last day of the ledgers is not final: the ingest has not passed it', async () => {
        // the newest mock ledger closed on 2017-05-12
        await computeDailyVolumes(ch, rates, MARKETS, new Date('2017-05-12T00:00:00Z'));
        for (const metric of VOLUME_METRICS) {
          expect((await dailySet(ch, metric, '2017-05-12'))[0]).toMatchObject({ component: '', rate_f: 0 });
        }
      });

      it('the day is a UTC day whatever time of it the date has', async () => {
        await computeDailyVolumes(ch, rates, MARKETS, new Date('2015-01-14T18:44:12.345Z'));
        const set = await dailySet(ch, 'trade_volume', '2015-01-14');
        expectTrades(
          set,
          tradeOracle(MARKETS, exchangeRows, unix('2015-01-14T00:00:00Z'), unix('2015-01-15T00:00:00Z')),
        );
      });
    });

    describe('payment_volume of a day', () => {
      it('2015-01-14: native and every configured currency that has payments, the rate as of the start of the day', async () => {
        await computeDailyVolumes(ch, rates, MARKETS, new Date('2015-01-14T00:00:00Z'));
        const set = await dailySet(ch, 'payment_volume', '2015-01-14');
        const from = unix('2015-01-14T00:00:00Z');
        const want = await paymentOracle(MARKETS, rates, paymentRows, from, from + DAY, from);
        // 144 payments that day, in the native currency and in five configured currencies
        expect(want.reduce((n, w) => n + w.count, 0)).toBe(144);
        expect(want.length).toBe(6);
        expectPayments(set, want);
        // nothing traded before the start of that day: only the native currency has a rate, the others are counted
        // (their payments are in the count) but have no converted amount
        expect(want.filter((w) => w.converted.gt(0)).map((w) => w.component)).toEqual(['XRP']);
        expect(parts(set).filter((r) => r.converted_f === 0).length).toBe(5);
      });

      it('a day with payments in the native currency only', async () => {
        await computeDailyVolumes(ch, rates, MARKETS, new Date('2013-06-11T00:00:00Z'));
        const set = await dailySet(ch, 'payment_volume', '2013-06-11');
        const from = unix('2013-06-11T00:00:00Z');
        const want = await paymentOracle(MARKETS, rates, paymentRows, from, from + DAY, from);
        expect(want.map((w) => w.component)).toEqual(['XRP']);
        expectPayments(set, want);
        expect(parts(set)[0]).toMatchObject({
          base_currency: 'XRP',
          base_issuer: '',
          counter_currency: '',
          counter_issuer: '',
        });
        expect(parts(set)[0].rate_f).toBe(1);
      });

      it('a currency that is not in the config is not a component', async () => {
        // CCK has payments on 2015-02-09; leave it out of the config: only the native currency is left
        const without = {
          ...MARKETS,
          paymentCurrencies: MARKETS.paymentCurrencies.filter((c) => c.currency !== 'CCK'),
        };
        await computeDailyVolumes(ch, rates, without, new Date('2015-02-09T00:00:00Z'));
        expect(parts(await dailySet(ch, 'payment_volume', '2015-02-09')).map((r) => r.component)).toEqual(['XRP']);
        await computeDailyVolumes(ch, rates, MARKETS, new Date('2015-02-09T00:00:00Z'));
        expect(
          parts(await dailySet(ch, 'payment_volume', '2015-02-09'))
            .map((r) => r.component)
            .sort(),
        ).toEqual(['CCK.rp2PaYDxVwDvaZVLEQv7bHhoFQEyX1mEx7', 'XRP']);
      });
    });

    describe('the live sets', () => {
      const NOW = new Date('2015-01-14T19:30:00Z');

      it('trade_volume: hour, day, 3day, 7day, 30day, each [now - period, now)', async () => {
        await computeLiveVolumes(ch, rates, MARKETS, NOW);
        const seconds: Record<LivePeriod, number> = {
          hour: HOUR,
          day: DAY,
          '3day': 3 * DAY,
          '7day': 7 * DAY,
          '30day': 30 * DAY,
        };
        for (const period of TRADE_LIVE_PERIODS) {
          const set = await liveSet(ch, 'trade_volume', period);
          const end = NOW.getTime() / SEC;
          expect(set.length).toBeGreaterThan(0);
          for (const r of set) expect([period, r.start_time, r.end_time]).toEqual([period, end - seconds[period], end]);
          expectTrades(set, tradeOracle(MARKETS, exchangeRows, end - seconds[period], end));
        }
        // the hour is a sub-set of the day: not the same volume
        const hour = parts(await liveSet(ch, 'trade_volume', 'hour')).reduce((n, r) => n + r.count, 0);
        const day = parts(await liveSet(ch, 'trade_volume', 'day')).reduce((n, r) => n + r.count, 0);
        expect(hour).toBeGreaterThan(0);
        expect(hour).toBeLessThan(day);
      });

      it('payment_volume: hour and day only', async () => {
        await computeLiveVolumes(ch, rates, MARKETS, NOW);
        expect(PAYMENT_LIVE_PERIODS).toEqual(['hour', 'day']);
        for (const [period, length] of [
          ['hour', HOUR],
          ['day', DAY],
        ] as const) {
          const set = await liveSet(ch, 'payment_volume', period);
          const end = NOW.getTime() / SEC;
          expect(set.length).toBeGreaterThan(0);
          for (const r of set) expect([period, r.start_time, r.end_time]).toEqual([period, end - length, end]);
          expectPayments(set, await paymentOracle(MARKETS, rates, paymentRows, end - length, end, end - length));
        }
        // no 3day set for payments
        expect(await liveSet(ch, 'payment_volume', '3day')).toEqual([]);
      });

      it('writes the sets of both metrics and nothing else: 5 + 2 sets', async () => {
        const ch2 = await freshService();
        await new LedgerWriter(ch2, ctx).write(ledgers);
        await computeLiveVolumes(ch2, new RatesService(ch2, 'XRP'), MARKETS, NOW);
        const sets = await ch2.query<{ metric: string; period: string }>(
          `SELECT metric, period FROM ${Table.VolumeLive} GROUP BY metric, period ORDER BY metric, period`,
        );
        expect(sets).toEqual([
          { metric: 'payment_volume', period: 'day' },
          { metric: 'payment_volume', period: 'hour' },
          { metric: 'trade_volume', period: '30day' },
          { metric: 'trade_volume', period: '3day' },
          { metric: 'trade_volume', period: '7day' },
          { metric: 'trade_volume', period: 'day' },
          { metric: 'trade_volume', period: 'hour' },
        ]);
      });

      it('a set whose window holds no ledger is the sentinel, with its times', async () => {
        const now = new Date('2020-06-01T12:00:00Z');
        await computeLiveVolumes(ch, rates, MARKETS, now);
        for (const metric of VOLUME_METRICS) {
          const set = await liveSet(ch, metric, 'day');
          expect(set).toHaveLength(1);
          expect(set[0]).toMatchObject({
            component: '',
            count: 0,
            start_time: now.getTime() / SEC - DAY,
            end_time: now.getTime() / SEC,
          });
        }
      });

      it('now keeps its seconds and drops the milliseconds', async () => {
        await computeLiveVolumes(ch, rates, MARKETS, new Date('2020-06-01T12:00:00.987Z'));
        expect((await liveSet(ch, 'trade_volume', 'hour'))[0].end_time).toBe(unix('2020-06-01T12:00:00Z'));
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('on a small synthetic world (numbers worked out by hand)', () => {
    const I1 = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
    const USD: Asset = { currency: 'USD', issuer: I1 };
    const EUR: Asset = { currency: 'EUR', issuer: I1 };
    const FOO: Asset = { currency: 'FOO', issuer: I1 };
    const BAR: Asset = { currency: 'BAR', issuer: I1 };
    const BAZ: Asset = { currency: 'BAZ', issuer: I1 };
    const ZZZ: Asset = { currency: 'ZZZ', issuer: I1 };
    const D = unix('2026-03-10T00:00:00Z');
    const D_MINUS = D - DAY;

    interface Event {
      close: number;
      exchange?: ExchangesRow;
      payment?: { asset: Asset; amount: string };
    }

    /** The rows of a world: one ledger per distinct close time, in the order of the close times. */
    class World {
      private readonly events: Event[] = [];

      trade(close: number, a: Asset, aAmount: string, b: Asset, bAmount: string): this {
        const stored = canonicalPair(a, b);
        const [baseAmount, counterAmount] = stored.inverted ? [bAmount, aAmount] : [aAmount, bAmount];
        this.events.push({
          close,
          exchange: {
            ...SAMPLE_ROWS[Table.Exchanges],
            base_currency: stored.base.currency,
            base_issuer: stored.base.issuer ?? '',
            counter_currency: stored.counter.currency,
            counter_issuer: stored.counter.issuer ?? '',
            base_amount: baseAmount,
            counter_amount: counterAmount,
            base_amount_f: Number(baseAmount),
            counter_amount_f: Number(counterAmount),
            close_time: close,
          },
        });
        return this;
      }

      pay(close: number, a: Asset, amount: string): this {
        this.events.push({ close, payment: { asset: a, amount } });
        return this;
      }

      async write(ch: ClickHouseService): Promise<void> {
        const closes = [...new Set(this.events.map((e) => e.close))].sort((a, b) => a - b);
        const index = new Map(closes.map((c, i) => [c, 70_000_000 + i]));
        const used = new Map<number, number>();
        const exchanges: ExchangesRow[] = [];
        const payments: PaymentsRow[] = [];
        for (const e of this.events) {
          const ledger = index.get(e.close) as number;
          const tx = used.get(ledger) ?? 0;
          used.set(ledger, tx + 1);
          if (e.exchange) exchanges.push({ ...e.exchange, ledger_index: ledger, tx_index: tx });
          if (e.payment) {
            payments.push({
              ...SAMPLE_ROWS[Table.Payments],
              ledger_index: ledger,
              tx_index: tx,
              close_time: e.close,
              currency: e.payment.asset.currency,
              issuer: e.payment.asset.issuer ?? '',
              delivered_amount: e.payment.amount,
              delivered_amount_f: Number(e.payment.amount),
            });
          }
        }
        await ch.insert(
          Table.Ledgers,
          closes.map((c) => ({
            ...SAMPLE_ROWS[Table.Ledgers],
            ledger_index: index.get(c) as number,
            ledger_hash: String(index.get(c)).padStart(64, 'C'),
            close_time: c,
          })),
        );
        await ch.insert(Table.Exchanges, exchanges);
        await ch.insert(Table.Payments, payments);
        await ch.insert(
          Table.PaymentsByCurrency,
          payments.map((p) => ({
            currency: p.currency,
            issuer: p.issuer,
            ledger_index: p.ledger_index,
            tx_index: p.tx_index,
          })),
        );
      }
    }

    const config = (extra: Partial<MarketsConfig> = {}): MarketsConfig => ({
      version: 3,
      tradeMarkets: [
        { base: USD, counter: XRP },
        { base: EUR, counter: XRP },
        { base: EUR, counter: USD },
        { base: FOO, counter: USD },
        { base: BAR, counter: BAZ },
      ],
      paymentCurrencies: [USD, EUR, ZZZ],
      ...extra,
    });

    /** The world: rates from the day before D, then the trades and payments of D. */
    function world(): World {
      const w = new World();
      // D-1: 12 trades of 10 USD for 20 XRP (2 XRP a dollar) and 12 of 5 EUR for 20 XRP, a second apart each
      for (let i = 0; i < 12; i++) {
        w.trade(D_MINUS + 43_200 + i, USD, '10', XRP, '20');
        w.trade(D_MINUS + 50_000 + i, EUR, '5', XRP, '20');
      }
      // D: three trades of 10 USD for 30 XRP, two of 4 EUR for 20 XRP
      for (let i = 0; i < 3; i++) w.trade(D + 3600 + i * 60, USD, '10', XRP, '30');
      for (let i = 0; i < 2; i++) w.trade(D + 7200 + i * 60, EUR, '4', XRP, '20');
      // two trades of 3 EUR for 6 USD; one of 100 FOO for 10 USD; one of BAR for BAZ that nothing can convert
      w.trade(D + 9000, EUR, '3', USD, '6').trade(D + 9060, EUR, '3', USD, '6');
      w.trade(D + 9100, FOO, '100', USD, '10');
      w.trade(D + 9200, BAR, '8', BAZ, '9');
      // payments of D: 10.5 XRP in all, 10 USD, 10 EUR and 2 of a currency that has no market
      for (const [i, amount] of ['1.5', '2.5', '6', '0.5'].entries()) w.pay(D + 1000 + i, XRP, amount);
      for (const [i, amount] of ['1.5', '2.5', '6'].entries()) w.pay(D + 2000 + i, USD, amount);
      for (const [i, amount] of ['7', '3'].entries()) w.pay(D + 3000 + i, EUR, amount);
      for (const [i, amount] of ['4', '5'].entries()) w.pay(D + 4000 + i, ZZZ, amount);
      return w;
    }

    let ch: ClickHouseService;
    let rates: RatesService;

    beforeAll(async () => {
      ch = await freshService();
      await world().write(ch);
      rates = new RatesService(ch, 'XRP');
      await computeDailyVolumes(ch, rates, config(), at(D));
    });

    it('trade_volume: native markets, the base leg, the counter leg with a swap, and the market no rate can convert', async () => {
      const rows = parts(await dailySet(ch, 'trade_volume', '2026-03-10'));
      const brief = rows.map((r) => ({
        component: r.component,
        base: r.base_currency,
        counter: r.counter_currency,
        amount: r.amount,
        count: r.count,
      }));
      expect(brief).toEqual([
        // 3 trades, 30 USD for 90 XRP: converted 90, rate 1/vwap = 30/90
        { component: `USD.${I1}/XRP`, base: 'USD', counter: 'XRP', amount: '30', count: 3 },
        // 2 trades, 8 EUR for 40 XRP
        { component: `EUR.${I1}/XRP`, base: 'EUR', counter: 'XRP', amount: '8', count: 2 },
        // EUR/USD: the base leg has a rate (8/40 = 0.2 EUR a coin): 6 EUR / 0.2 = 30 coins
        { component: `EUR.${I1}/USD.${I1}`, base: 'EUR', counter: 'USD', amount: '6', count: 2 },
        // FOO/USD: FOO has none, USD has (1/3): the amount is the USD side, 10 USD / (1/3) = 30 coins, swapped
        { component: `FOO.${I1}/USD.${I1}`, base: 'USD', counter: 'FOO', amount: '10', count: 1 },
      ]);
      const [usd, eur, eurUsd, fooUsd] = rows;
      close('usd converted', usd.converted_f, 90);
      close('usd rate', usd.rate_f, 30 / 90);
      close('eur converted', eur.converted_f, 40);
      close('eur rate', eur.rate_f, 0.2);
      close('eur/usd converted', eurUsd.converted_f, 30);
      close('eur/usd rate', eurUsd.rate_f, 0.2);
      close('foo/usd converted', fooUsd.converted_f, 30);
      close('foo/usd rate', fooUsd.rate_f, 1 / 3);
      // converted = amount / rate, whatever the branch
      for (const r of rows) close(`${r.component} amount / rate`, r.amount_f / r.rate_f, r.converted_f);
    });

    it('payment_volume: the native currency, the currencies with a rate, and the count of the ones without', async () => {
      const set = await dailySet(ch, 'payment_volume', '2026-03-10');
      const rows = parts(set);
      const brief = rows.map((r) => ({ component: r.component, amount: r.amount, count: r.count }));
      expect(brief).toEqual([
        // 10 EUR at 0.25 EUR a coin = 40; 10 USD at 0.5 = 20; 10.5 coins; ZZZ has no rate
        { component: `EUR.${I1}`, amount: '10', count: 2 },
        { component: `USD.${I1}`, amount: '10', count: 3 },
        { component: 'XRP', amount: '10.5', count: 4 },
        { component: `ZZZ.${I1}`, amount: '9', count: 2 },
      ]);
      expect(rows.map((r) => r.converted_f)).toEqual([40, 20, 10.5, 0]);
      expect(rows.map((r) => r.rate_f)).toEqual([0.25, 0.5, 1, 0]);
      // 2 + 3 + 4 + 2 payments, the payments of the currency without a rate included
      expect(rows.reduce((n, r) => n + r.count, 0)).toBe(11);
    });

    it('the native currency is a component of the payments whether the config lists it or not', async () => {
      const other = await freshService();
      await world().write(other);
      await computeDailyVolumeSet(
        other,
        new RatesService(other, 'XRP'),
        config({ paymentCurrencies: [] }),
        'payment_volume',
        at(D),
      );
      expect(parts(await dailySet(other, 'payment_volume', '2026-03-10')).map((r) => r.component)).toEqual(['XRP']);
    });

    it('native dust (a native leg of 0.0005 or less) is not a trade', async () => {
      const other = await freshService();
      await world()
        .trade(D + 20_000, USD, '5', XRP, '0.0005')
        .trade(D + 20_001, USD, '0.0001', XRP, '0.0004')
        .trade(D + 20_002, USD, '1', XRP, '0.001')
        .write(other);
      await computeDailyVolumeSet(other, new RatesService(other, 'XRP'), config(), 'trade_volume', at(D));
      const usd = parts(await dailySet(other, 'trade_volume', '2026-03-10')).find(
        (r) => r.component === `USD.${I1}/XRP`,
      );
      // the three trades of the world and the one dust-free extra
      expect([usd?.count, usd?.amount]).toEqual([4, '31']);
      close('converted', usd?.converted_f ?? 0, 90.001);
    });

    it('a market listed twice, or the other way round, counts once; a market with the native base is the same as its reverse', async () => {
      const other = await freshService();
      await world().write(other);
      const dup = config({
        tradeMarkets: [
          { base: USD, counter: XRP },
          { base: XRP, counter: USD },
          { base: USD, counter: XRP },
          { base: EUR, counter: XRP },
          { base: USD, counter: EUR },
          { base: EUR, counter: USD },
        ],
      });
      await computeDailyVolumeSet(other, new RatesService(other, 'XRP'), dup, 'trade_volume', at(D));
      const rows = parts(await dailySet(other, 'trade_volume', '2026-03-10'));
      expect(rows.map((r) => [r.component, r.count])).toEqual([
        [`USD.${I1}/XRP`, 3],
        [`EUR.${I1}/XRP`, 2],
        [`USD.${I1}/EUR.${I1}`, 2],
      ]);
      // the first listing of the market wins, USD against EUR: its base leg, the dollar (1/3 of a dollar a coin), converts
      // the 12 dollars of the two trades to 36 coins (the other orientation would have converted 6 euros at 0.2: 30)
      expect([rows[2].base_currency, rows[2].amount]).toEqual(['USD', '12']);
      close('converted', rows[2].converted_f, 36);
    });

    it('exchanges, payments and their index rows written twice (merges stopped, a second insert without deduplication) count once', async () => {
      const other = await freshService();
      await world().write(other);
      const rows = async (table: Table): Promise<number> =>
        Number((await other.query<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0].n);
      const before = [await rows(Table.Exchanges), await rows(Table.Payments), await rows(Table.PaymentsByCurrency)];
      const database = (await other.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
      for (const table of [Table.Exchanges, Table.Payments, Table.PaymentsByCurrency]) {
        await other.command(`SYSTEM STOP MERGES ${database}.${table}`);
        await other.command(`INSERT INTO ${table} SELECT * FROM ${table}`, {}, { settings: { insert_deduplicate: 0 } });
      }
      expect([await rows(Table.Exchanges), await rows(Table.Payments), await rows(Table.PaymentsByCurrency)]).toEqual(
        before.map((n) => 2 * n),
      );

      await computeDailyVolumes(other, new RatesService(other, 'XRP'), config(), at(D));
      const strip = (list: StoredRow[]) => list.map(({ version: _version, ...rest }) => rest);
      for (const metric of VOLUME_METRICS) {
        expect(strip(await dailySet(other, metric, '2026-03-10'))).toEqual(
          strip(await dailySet(ch, metric, '2026-03-10')),
        );
      }
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('what the readers rely on', () => {
    const FEE_ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
    const USD: Asset = { currency: 'USD', issuer: FEE_ISSUER };
    const EUR: Asset = { currency: 'EUR', issuer: FEE_ISSUER };
    let ch: ClickHouseService;
    let rates: RatesService;

    const config = (
      version = 5,
      markets: MarketsConfig['tradeMarkets'] = [
        { base: USD, counter: XRP },
        { base: EUR, counter: XRP },
      ],
    ): MarketsConfig => ({
      version,
      tradeMarkets: markets,
      paymentCurrencies: [],
    });
    const DAY_KEY = '2015-01-14';
    const THE_DAY = new Date('2015-01-14T00:00:00Z');

    beforeEach(async () => {
      ch = await freshService();
      await new LedgerWriter(ch, ctx).write(ledgers);
      rates = new RatesService(ch, 'XRP');
    });

    const nativeMarkets: MarketsConfig['tradeMarkets'] = [
      { base: { currency: 'CNY', issuer: 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y' }, counter: XRP },
      { base: { currency: 'KRW', issuer: 'rUkMKjQitpgAM5WTGk79xpjT38DEJY283d' }, counter: XRP },
      { base: { currency: 'USD', issuer: 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q' }, counter: XRP },
    ];

    /** Keeps the parts of a table as they are written, so that rows of older versions stay where the test can see them. */
    async function stopMerges(table: Table): Promise<void> {
      const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
      await ch.command(`SYSTEM STOP MERGES ${database}.${table}`);
    }

    it('daily job idempotent: a second run leaves the same set for a reader, under a newer version', async () => {
      await stopMerges(Table.VolumeDaily);
      const cfg = config(5, nativeMarkets);
      await computeDailyVolumes(ch, rates, cfg, THE_DAY);
      const first = await dailySet(ch, 'trade_volume', DAY_KEY);
      expect(parts(first).length).toBe(3);
      await computeDailyVolumes(ch, rates, cfg, THE_DAY);
      const second = await dailySet(ch, 'trade_volume', DAY_KEY);
      const strip = (list: StoredRow[]) => list.map(({ version: _version, ...rest }) => rest);
      expect(strip(second)).toEqual(strip(first));
      expect(second[0].version).toBeGreaterThan(first[0].version);
      // both versions are in the table until a merge: the reader's rule, not FINAL, picks the newest
      expect((await allDailyRows(ch, 'trade_volume', DAY_KEY)).length).toBeGreaterThanOrEqual(2 * first.length);
      expect(new Set((await allDailyRows(ch, 'trade_volume', DAY_KEY)).map((r) => r.version)).size).toBe(2);
    });

    it('the whole set has ONE version, the sentinel (component empty, count 0) included; sets do not share one', async () => {
      await computeDailyVolumes(ch, rates, config(5, nativeMarkets), THE_DAY);
      const trade = await dailySet(ch, 'trade_volume', DAY_KEY);
      const payment = await dailySet(ch, 'payment_volume', DAY_KEY);
      expect(trade[0]).toMatchObject({ component: '', count: 0 });
      expect(payment[0]).toMatchObject({ component: '', count: 0 });
      expect(new Set(trade.map((r) => r.version)).size).toBe(1);
      expect(new Set(payment.map((r) => r.version)).size).toBe(1);
      // the version is the time of the write in milliseconds
      expect(Math.abs(trade[0].version - Date.now())).toBeLessThan(5 * 60_000);

      await computeLiveVolumes(ch, rates, config(5, nativeMarkets), new Date('2015-01-14T19:30:00Z'));
      for (const period of TRADE_LIVE_PERIODS) {
        const set = await liveSet(ch, 'trade_volume', period);
        expect(set[0]).toMatchObject({ component: '', count: 0 });
        expect(new Set(set.map((r) => r.version)).size).toBe(1);
      }
    });

    it('a set is one insert (one part: a reader sees all of it or none of it)', async () => {
      const spy = jest.spyOn(ch, 'insert');
      await computeDailyVolumeSet(ch, rates, config(5, nativeMarkets), 'trade_volume', THE_DAY);
      expect(spy).toHaveBeenCalledTimes(1);
      const [table, written] = spy.mock.calls[0] as [Table, StoredRow[]];
      expect(table).toBe(Table.VolumeDaily);
      expect(written[0].component).toBe('');
      expect(written.length).toBe(1 + parts(await dailySet(ch, 'trade_volume', DAY_KEY)).length);
      spy.mockClear();
      await computeLiveVolumeSet(
        ch,
        rates,
        config(5, nativeMarkets),
        'trade_volume',
        'day',
        new Date('2015-01-14T19:30:00Z'),
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toBe(Table.VolumeLive);
      spy.mockRestore();
    });

    it('a version only goes up: a clock that stepped back, or a set from the future, is beaten', async () => {
      const cfg = config(5, nativeMarkets);
      const future = Date.now() + 3_600_000;
      await ch.insert(Table.VolumeDaily, [
        {
          ...SAMPLE_ROWS[Table.VolumeDaily],
          metric: 'trade_volume',
          day: DAY_KEY,
          component: '',
          amount: '0',
          amount_f: 0,
          count: 0,
          rate_f: 0,
          converted_f: 0,
          version: future,
        },
      ]);
      await computeDailyVolumeSet(ch, rates, cfg, 'trade_volume', THE_DAY);
      let set = await dailySet(ch, 'trade_volume', DAY_KEY);
      expect(set[0].version).toBe(future + 1);
      expect(parts(set).length).toBe(3);
      await computeDailyVolumeSet(ch, rates, cfg, 'trade_volume', THE_DAY);
      set = await dailySet(ch, 'trade_volume', DAY_KEY);
      expect(set[0].version).toBe(future + 2);

      const livePeriod = 'hour';
      const liveFuture = Date.now() + 3_600_000;
      await ch.insert(Table.VolumeLive, [
        {
          ...SAMPLE_ROWS[Table.VolumeLive],
          metric: 'trade_volume',
          period: livePeriod,
          component: '',
          version: liveFuture,
        },
      ]);
      await computeLiveVolumeSet(ch, rates, cfg, 'trade_volume', livePeriod, new Date('2015-01-14T19:30:00Z'));
      expect((await liveSet(ch, 'trade_volume', livePeriod))[0].version).toBe(liveFuture + 1);
    });

    it('vanished component: a market removed from the config is not in the next set, though its old rows are still stored', async () => {
      await stopMerges(Table.VolumeDaily);
      await computeDailyVolumes(ch, rates, config(5, nativeMarkets), THE_DAY);
      const before = parts(await dailySet(ch, 'trade_volume', DAY_KEY)).map((r) => r.component);
      expect(before).toContain('KRW.rUkMKjQitpgAM5WTGk79xpjT38DEJY283d/XRP');

      await computeDailyVolumes(
        ch,
        rates,
        config(
          6,
          nativeMarkets.filter((m) => m.base.currency !== 'KRW'),
        ),
        THE_DAY,
      );
      const after = parts(await dailySet(ch, 'trade_volume', DAY_KEY)).map((r) => r.component);
      expect(after).toEqual(before.filter((c) => !c.startsWith('KRW')));
      // the old row is still there (older version): only the version rule hides it
      const all = await allDailyRows(ch, 'trade_volume', DAY_KEY);
      expect(all.some((r) => r.component.startsWith('KRW') && r.config_version === 5)).toBe(true);
      expect(new Set((await dailySet(ch, 'trade_volume', DAY_KEY)).map((r) => r.config_version))).toEqual(new Set([6]));
    });

    it('a component that has no volume any more (rate gone, trades gone) vanishes the same way, on a live set', async () => {
      await stopMerges(Table.VolumeLive);
      const now = new Date('2015-01-14T19:30:00Z');
      await computeLiveVolumeSet(ch, rates, config(5, nativeMarkets), 'trade_volume', 'day', now);
      expect(parts(await liveSet(ch, 'trade_volume', 'day')).length).toBe(3);
      // an hour of the next day: none of these markets traded
      await computeLiveVolumeSet(
        ch,
        rates,
        config(5, nativeMarkets),
        'trade_volume',
        'day',
        new Date('2015-01-16T12:00:00Z'),
      );
      expect(await liveSet(ch, 'trade_volume', 'day')).toHaveLength(1);
      const stored = await ch.query<{ n: string }>(
        `SELECT count() AS n FROM ${Table.VolumeLive} WHERE component != ''`,
      );
      expect(Number(stored[0].n)).toBe(3);
    });

    describe('volumeDaysDone: the days whose newest set has the current config version', () => {
      it('is the days that have a set of that version, the sentinel-only days included', async () => {
        const cfg = config(5, nativeMarkets);
        for (const day of ['2015-01-14', '2014-06-01', '2013-06-11']) {
          await computeDailyVolumeSet(ch, rates, cfg, 'trade_volume', new Date(`${day}T00:00:00Z`));
        }
        const from = new Date('2013-01-01T00:00:00Z');
        const to = new Date('2016-01-01T00:00:00Z');
        expect([...(await volumeDaysDone(ch, 'trade_volume', from, to, 5))].sort()).toEqual([
          '2013-06-11',
          '2014-06-01',
          '2015-01-14',
        ]);
        // another metric has none of them
        expect((await volumeDaysDone(ch, 'payment_volume', from, to, 5)).size).toBe(0);
        // a config version change makes them all not done
        expect((await volumeDaysDone(ch, 'trade_volume', from, to, 6)).size).toBe(0);
        // the window is [from, to): the day of `to` is out, the day of `from` is in
        expect([
          ...(await volumeDaysDone(
            ch,
            'trade_volume',
            new Date('2014-06-01T00:00:00Z'),
            new Date('2015-01-14T00:00:00Z'),
            5,
          )),
        ]).toEqual(['2014-06-01']);
      });

      it('goes by the NEWEST set of a day: recomputed under a new version, the day is done for the new one only', async () => {
        await computeDailyVolumeSet(ch, rates, config(5, nativeMarkets), 'trade_volume', THE_DAY);
        await computeDailyVolumeSet(ch, rates, config(6, nativeMarkets), 'trade_volume', THE_DAY);
        const range: [Date, Date] = [new Date('2015-01-01T00:00:00Z'), new Date('2015-02-01T00:00:00Z')];
        expect((await volumeDaysDone(ch, 'trade_volume', ...range, 6)).has(DAY_KEY)).toBe(true);
        expect((await volumeDaysDone(ch, 'trade_volume', ...range, 5)).has(DAY_KEY)).toBe(false);
      });

      it('counts a set written twice (merges stopped, a second insert without deduplication) once', async () => {
        await computeDailyVolumeSet(ch, rates, config(5, nativeMarkets), 'trade_volume', THE_DAY);
        const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
        await ch.command(`SYSTEM STOP MERGES ${database}.${Table.VolumeDaily}`);
        await ch.command(
          `INSERT INTO ${Table.VolumeDaily} SELECT * FROM ${Table.VolumeDaily}`,
          {},
          { settings: { insert_deduplicate: 0 } },
        );
        const rows = Number((await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.VolumeDaily}`))[0].n);
        expect(rows).toBe(2 * 4);
        const done = await volumeDaysDone(
          ch,
          'trade_volume',
          new Date('2015-01-01T00:00:00Z'),
          new Date('2015-02-01T00:00:00Z'),
          5,
        );
        expect([...done]).toEqual([DAY_KEY]);
      });

      it('only a final set makes a day done: the same config version with the flag off is not enough', async () => {
        const window: [Date, Date] = [new Date('2015-01-01T00:00:00Z'), new Date('2015-02-01T00:00:00Z')];
        await ch.insert(Table.VolumeDaily, [
          setOfSentinel('trade_volume', '2015-01-10', 1000, 5, true),
          setOfSentinel('trade_volume', '2015-01-11', 1000, 5, false),
          setOfSentinel('payment_volume', '2015-01-11', 1000, 5, true),
        ]);
        expect([...(await volumeDaysDone(ch, 'trade_volume', ...window, 5))]).toEqual(['2015-01-10']);
        expect([...(await volumeDaysDone(ch, 'payment_volume', ...window, 5))]).toEqual(['2015-01-11']);
      });

      it('goes by the newest set of the day: a newer set that is not final, or of another config version, un-does the day', async () => {
        const window: [Date, Date] = [new Date('2015-01-10T00:00:00Z'), new Date('2015-01-11T00:00:00Z')];
        await ch.insert(Table.VolumeDaily, [setOfSentinel('trade_volume', '2015-01-10', 1000, 5, true)]);
        expect((await volumeDaysDone(ch, 'trade_volume', ...window, 5)).size).toBe(1);
        // a newer set made before the ingest had passed the day (a rewind of the ingest, a restore): the day is not done
        await ch.insert(Table.VolumeDaily, [setOfSentinel('trade_volume', '2015-01-10', 2000, 5, false)]);
        expect((await volumeDaysDone(ch, 'trade_volume', ...window, 5)).size).toBe(0);
        // a newer final set of another config version: not done for 5, done for 6
        await ch.insert(Table.VolumeDaily, [setOfSentinel('trade_volume', '2015-01-10', 3000, 6, true)]);
        expect((await volumeDaysDone(ch, 'trade_volume', ...window, 5)).size).toBe(0);
        expect((await volumeDaysDone(ch, 'trade_volume', ...window, 6)).size).toBe(1);
      });

      it('is empty for an empty or reversed window, with no query', async () => {
        const spy = jest.spyOn(ch, 'query');
        expect((await volumeDaysDone(ch, 'trade_volume', THE_DAY, THE_DAY, 5)).size).toBe(0);
        expect((await volumeDaysDone(ch, 'trade_volume', new Date('2016-01-01T00:00:00Z'), THE_DAY, 5)).size).toBe(0);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });

    describe('the versions of the sets (the aggregator starts with the stalest)', () => {
      it('liveSetVersions: the newest version of every live set that exists, keyed metric/period', async () => {
        expect((await liveSetVersions(ch)).size).toBe(0);
        const before = Date.now();
        await computeLiveVolumes(ch, rates, config(5, nativeMarkets), new Date('2015-01-14T19:30:00Z'));
        const versions = await liveSetVersions(ch);
        expect([...versions.keys()].sort()).toEqual([
          'payment_volume/day',
          'payment_volume/hour',
          'trade_volume/30day',
          'trade_volume/3day',
          'trade_volume/7day',
          'trade_volume/day',
          'trade_volume/hour',
        ]);
        for (const version of versions.values()) expect(version).toBeGreaterThanOrEqual(before - 5000);
        // a set written again has a newer version; one that was not is as it was
        const hour = versions.get('trade_volume/hour') as number;
        const day = versions.get('trade_volume/day') as number;
        await computeLiveVolumeSet(
          ch,
          rates,
          config(5, nativeMarkets),
          'trade_volume',
          'hour',
          new Date('2015-01-14T19:31:00Z'),
        );
        const after = await liveSetVersions(ch);
        expect(after.get('trade_volume/hour')).toBeGreaterThan(hour);
        expect(after.get('trade_volume/day')).toBe(day);
      });

      it('dailySetVersions: the sets of the days of the window only, keyed metric/day', async () => {
        const cfg = config(5, nativeMarkets);
        await computeDailyVolumeSet(ch, rates, cfg, 'trade_volume', new Date('2015-01-14T00:00:00Z'));
        await computeDailyVolumeSet(ch, rates, cfg, 'payment_volume', new Date('2015-01-14T00:00:00Z'));
        await computeDailyVolumeSet(ch, rates, cfg, 'trade_volume', new Date('2015-01-13T00:00:00Z'));
        await computeDailyVolumeSet(ch, rates, cfg, 'trade_volume', new Date('2015-01-10T00:00:00Z'));
        const versions = await dailySetVersions(ch, new Date('2015-01-13T05:00:00Z'), new Date('2015-01-14T23:00:00Z'));
        expect([...versions.keys()].sort()).toEqual([
          'payment_volume/2015-01-14',
          'trade_volume/2015-01-13',
          'trade_volume/2015-01-14',
        ]);
        expect(
          (await dailySetVersions(ch, new Date('2015-01-15T00:00:00Z'), new Date('2015-01-20T00:00:00Z'))).size,
        ).toBe(0);
        expect(
          (await dailySetVersions(ch, new Date('2015-01-20T00:00:00Z'), new Date('2015-01-15T00:00:00Z'))).size,
        ).toBe(0);
      });

      it('take the newest of the versions a set has, and bind their values', async () => {
        await ch.insert(Table.VolumeLive, [
          { ...SAMPLE_ROWS[Table.VolumeLive], metric: 'trade_volume', period: 'hour', component: '', version: 5 },
          { ...SAMPLE_ROWS[Table.VolumeLive], metric: 'trade_volume', period: 'hour', component: 'x', version: 9 },
        ]);
        const spy = jest.spyOn(ch, 'query');
        expect((await liveSetVersions(ch)).get('trade_volume/hour')).toBe(9);
        await dailySetVersions(ch, new Date('2015-01-13T00:00:00Z'), new Date('2015-01-14T00:00:00Z'));
        const texts = spy.mock.calls.map(([sql]) => String(sql));
        spy.mockRestore();
        for (const text of texts) expect(text).not.toMatch(/\bFINAL\b|2015/);
      });
    });

    describe('abort (the shutdown of the syncer)', () => {
      it('an aborted signal writes nothing and throws VolumeRecomputeAborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const spy = jest.spyOn(ch, 'insert');
        await expect(
          computeDailyVolumeSet(ch, rates, config(5, nativeMarkets), 'trade_volume', THE_DAY, {
            signal: controller.signal,
          }),
        ).rejects.toBeInstanceOf(VolumeRecomputeAborted);
        await expect(
          computeLiveVolumes(ch, rates, config(5, nativeMarkets), new Date('2015-01-14T19:30:00Z'), {
            signal: controller.signal,
          }),
        ).rejects.toBeInstanceOf(VolumeRecomputeAborted);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });

      it('a signal aborted while the set is read writes nothing: the check is made again right before the insert', async () => {
        const controller = new AbortController();
        const original = ch.query.bind(ch);
        const queries = jest.spyOn(ch, 'query').mockImplementation(async (sql, params, settings) => {
          const rows = await original(sql, params, settings);
          if (String(sql).includes('max(version)')) controller.abort();
          return rows;
        });
        const inserts = jest.spyOn(ch, 'insert');
        await expect(
          computeDailyVolumeSet(ch, rates, config(5, nativeMarkets), 'trade_volume', THE_DAY, {
            signal: controller.signal,
          }),
        ).rejects.toBeInstanceOf(VolumeRecomputeAborted);
        expect(inserts).not.toHaveBeenCalled();
        queries.mockRestore();
        inserts.mockRestore();
        expect(await dailySet(ch, 'trade_volume', DAY_KEY)).toEqual([]);
      });
    });

    describe('the SQL', () => {
      it('binds every value, names tables from the Table enum, uses no FINAL, and reads payments through the narrow index', async () => {
        const spy = jest.spyOn(ch, 'query');
        const cfg: MarketsConfig = {
          ...config(5, nativeMarkets),
          paymentCurrencies: [{ currency: 'CNY', issuer: 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y' }],
        };
        await computeDailyVolumes(ch, rates, cfg, THE_DAY);
        const calls = spy.mock.calls.map(([text, params]) => ({
          text: String(text),
          params: (params ?? {}) as Record<string, unknown>,
        }));
        const sql = calls.map((c) => c.text);
        spy.mockRestore();
        expect(sql.length).toBeGreaterThan(4);
        for (const text of sql) {
          expect(text).not.toMatch(/\bFINAL\b/);
          expect(text).not.toContain('rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y');
          expect(text).not.toContain('2015-01-14');
        }
        const payments = sql.find((text) => text.includes(`FROM ${Table.PaymentsByCurrency}`));
        expect(payments).toBeDefined();
        expect(payments).toContain('LIMIT 1 BY ledger_index, tx_index');
        expect(payments).toContain('ORDER BY currency, issuer, ledger_index, tx_index');
        expect(payments).toContain('ledger_index BETWEEN {min:UInt32} AND {max:UInt32}');
        // the narrow index is read by its primary key: the currencies, then the ledgers
        const call = calls.find((c) => c.text === payments) as { text: string; params: Record<string, unknown> };
        expect(call.params).toMatchObject({
          currencies: ['CNY', 'XRP'],
          issuers: ['rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y', ''],
        });
        const explain = async (text: string): Promise<string> =>
          (await ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${text}`, call.params))
            .map((r) => r.explain)
            .join('\n');
        // the index table: a range of the primary key per currency, in the ledgers of the window
        const inner =
          /SELECT ledger_index, tx_index\s+FROM payments_by_currency[\s\S]*?ORDER BY currency, issuer, ledger_index, tx_index/.exec(
            call.text,
          );
        expect(inner).not.toBeNull();
        expect(await explain(inner?.[0] as string)).toMatch(
          /PrimaryKey\s+Keys:\s+currency\s+issuer\s+ledger_index[\s\S]*\(currency, issuer\) in 2-element set/,
        );
        // the wide table: the payments of those transactions, found by its primary key
        expect(await explain(call.text)).toMatch(
          /PrimaryKey\s+Keys:\s+ledger_index\s+tx_index[\s\S]*\(ledger_index, tx_index\) in \d+-element set/,
        );
      });
    });

    describe('an empty config (Xahau before its markets are filled in)', () => {
      it('trade_volume is the sentinel only; payment_volume has the native currency, XAH', async () => {
        const xahau = await freshService();
        const day = unix('2025-05-05T00:00:00Z');
        await xahau.insert(
          Table.Ledgers,
          [day + 10, day + 20].map((close, i) => ({
            ...SAMPLE_ROWS[Table.Ledgers],
            ledger_index: 81_000_000 + i,
            ledger_hash: String(i).padStart(64, 'D'),
            close_time: close,
          })),
        );
        await xahau.insert(
          Table.Payments,
          [day + 10, day + 20].map((close, i) => ({
            ...SAMPLE_ROWS[Table.Payments],
            ledger_index: 81_000_000 + i,
            tx_index: 0,
            close_time: close,
            currency: 'XAH',
            issuer: '',
            delivered_amount: i === 0 ? '12.5' : '7.5',
            delivered_amount_f: i === 0 ? 12.5 : 7.5,
          })),
        );
        await xahau.insert(
          Table.PaymentsByCurrency,
          [0, 1].map((i) => ({ currency: 'XAH', issuer: '', ledger_index: 81_000_000 + i, tx_index: 0 })),
        );
        const empty: MarketsConfig = { version: 1, tradeMarkets: [], paymentCurrencies: [] };
        await computeDailyVolumes(xahau, new RatesService(xahau, 'XAH'), empty, new Date(day * SEC));
        const trade = await dailySet(xahau, 'trade_volume', '2025-05-05');
        expect(trade.map((r) => r.component)).toEqual(['']);
        const payment = await dailySet(xahau, 'payment_volume', '2025-05-05');
        expect(parts(payment).map((r) => [r.component, r.amount, r.count, r.converted_f, r.rate_f])).toEqual([
          ['XAH', '20', 2, 20, 1],
        ]);
        await computeLiveVolumes(xahau, new RatesService(xahau, 'XAH'), empty, new Date((day + 100) * SEC));
        expect(await liveSet(xahau, 'trade_volume', 'day')).toHaveLength(1);
        expect(parts(await liveSet(xahau, 'payment_volume', 'day')).map((r) => r.component)).toEqual(['XAH']);
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the final flag of a daily set: the ledger time of the ingest against the end of the day (times relative to the real clock)', () => {
    // The set of a day is the final one when the newest ledger closed VOLUME_DAY_SETTLE_MS after the end of the day. The
    // wall clock has nothing to do with it, so these tests run with the days ten days before the real today and ledgers
    // placed around the end of that day: a rule that went by the version (the time of the write, which is now, long after
    // the day) would call every set final.
    const SETTLE = VOLUME_DAY_SETTLE_MS / SEC;
    const today = Math.floor(Date.now() / SEC / DAY) * DAY;
    const D = today - 10 * DAY;
    const END = D + DAY;
    const dayText = new Date(D * SEC).toISOString().slice(0, 10);
    const window: [Date, Date] = [at(D - DAY), at(END + DAY)];
    let ch: ClickHouseService;
    let rates: RatesService;
    let nextLedger: number;

    beforeEach(async () => {
      ch = await freshService();
      rates = new RatesService(ch, 'XRP');
      nextLedger = 5000;
    });

    /** A ledger that closed at `close` (a later one than every ledger before it). */
    const ledger = async (close: number): Promise<void> => {
      const index = nextLedger++;
      await ch.insert(Table.Ledgers, [
        {
          ...SAMPLE_ROWS[Table.Ledgers],
          ledger_index: index,
          ledger_hash: String(index).padStart(64, 'A'),
          close_time: close,
        },
      ]);
    };
    const flagOf = async (metric: VolumeMetric = 'trade_volume'): Promise<number> => {
      await computeDailyVolumeSet(ch, rates, MARKETS, metric, at(D));
      return (await dailySet(ch, metric, dayText))[0].rate_f;
    };

    it('is on from the settle time after the end of the day, to the second, in ledger time', async () => {
      expect(await flagOf()).toBe(0); // no ledger at all
      const seen: [number, number][] = [];
      for (const close of [END - 1, END, END + SETTLE - 1, END + SETTLE, END + 2 * DAY]) {
        await ledger(close);
        seen.push([close - END, await flagOf()]);
      }
      expect(seen).toEqual([
        [-1, 0],
        [0, 0],
        [SETTLE - 1, 0],
        [SETTLE, 1],
        [2 * DAY, 1],
      ]);
    });

    it('both metrics carry the flag, and the days that are not over carry none', async () => {
      await ledger(END + SETTLE);
      for (const metric of VOLUME_METRICS) expect(await flagOf(metric)).toBe(1);
      // the day of the newest ledger itself, and the day after it
      await computeDailyVolumeSet(ch, rates, MARKETS, 'trade_volume', at(END));
      await computeDailyVolumeSet(ch, rates, MARKETS, 'trade_volume', at(END + DAY));
      expect((await dailySet(ch, 'trade_volume', new Date(END * SEC).toISOString().slice(0, 10)))[0].rate_f).toBe(0);
      expect(
        (await dailySet(ch, 'trade_volume', new Date((END + DAY) * SEC).toISOString().slice(0, 10)))[0].rate_f,
      ).toBe(0);
    });

    it('a day the ingest has not reached is not done (the ingest started at an old ledger), and is once it has', async () => {
      await ledger(D - 100 * DAY); // the ingest is 100 days behind that day
      expect(await flagOf()).toBe(0);
      expect((await volumeDaysDone(ch, 'trade_volume', ...window, MARKETS.version)).size).toBe(0);
      // the set is there: a sentinel with nothing in it, which is NOT a final one
      expect((await dailySet(ch, 'trade_volume', dayText)).map((r) => r.component)).toEqual(['']);

      await ledger(D + 3 * 3600); // it reaches the day, but not its end
      expect(await flagOf()).toBe(0);
      await ledger(END + SETTLE); // and passes it
      expect(await flagOf()).toBe(1);
      expect([...(await volumeDaysDone(ch, 'trade_volume', ...window, MARKETS.version))]).toEqual([dayText]);
    });

    it('a day computed while its last hour was missing (an outage) is not done, and is recomputed once the ledgers are in', async () => {
      // 20 hours of the day are in: the newest ledger closed at 20:00
      await ledger(D + 20 * 3600);
      expect(await flagOf('payment_volume')).toBe(0);
      expect((await volumeDaysDone(ch, 'payment_volume', ...window, MARKETS.version)).size).toBe(0);
      // the rest of the day and an hour of the next arrive
      await ledger(D + 23 * 3600 + 1800);
      await ledger(END + 3600);
      expect(await flagOf('payment_volume')).toBe(1);
      expect([...(await volumeDaysDone(ch, 'payment_volume', ...window, MARKETS.version))]).toEqual([dayText]);
    });

    it('reads the newest ledger BEFORE the trades and the payments, so that what it counted is at least what the flag says', async () => {
      await ledger(END + SETTLE);
      const spy = jest.spyOn(ch, 'query');
      await computeDailyVolumeSet(ch, rates, MARKETS, 'payment_volume', at(D));
      const texts = spy.mock.calls.map(([sql]) => String(sql));
      spy.mockRestore();
      const newest = texts.findIndex((t) => /FROM ledgers\s+ORDER BY ledger_index DESC\s+LIMIT 1/.test(t));
      expect(newest).toBe(0);
      expect(texts.findIndex((t) => /close_time >=/.test(t))).toBeGreaterThan(newest);
    });
  });
});
