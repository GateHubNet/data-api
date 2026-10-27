import BigNumber from 'bignumber.js';
import { RATES_DAILY_CONFIG_VERSION } from '../src/aggregate/rates-daily.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { NativeRatesDailyRow, NftSalesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { Asset, canonicalPair } from '../src/query/asset';
import { DailyRates } from '../src/query/daily-rates';
import { convertedSalePrices, nftSalesNativeSql, SaleKey, SqlPart } from '../src/query/nft-prices';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

/**
 * `nftSalesNativeSql` and `convertedSalePrices` on a real ClickHouse: the price of a sale in the native currency, the one
 * conversion of the collections job, the `nft_volume` metric, `/stats` and the sales lists (spec 3.3).
 *
 * The rows of `nft_sales` are made by hand (their transactions say `synthetic-…`), and so are the `native_rates_daily` sets,
 * in the shape the `rates_daily` job writes them: a sentinel, then a row for each asset that has a rate. One test has a day
 * without a set, whose rate is computed on read from trades written straight into `exchanges`.
 */

const SEC = 1000;
const DAY = 86_400;
/** Day 0 of the world: 2026-01-10 00:00:00 UTC. */
const BASE = Date.UTC(2026, 0, 10) / SEC;
const at = (day: number, seconds = 0): number => BASE + day * DAY + seconds;
const dayText = (day: number): string => new Date(at(day) * SEC).toISOString().slice(0, 10);

const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const COLLECTION = 'rSyntheticCollectionIssuer';
const USD: Asset = { currency: 'USD', issuer: ISSUER };
const EUR: Asset = { currency: 'EUR', issuer: ISSUER };
const HEX_CODE = '0158415500000000C1F76FF6ECB0BAC600000000';
const HEX: Asset = { currency: HEX_CODE, issuer: ISSUER };

/** A sale made by hand. The key is (ledger, 1, 0) unless said. */
function sale(ledger: number, over: Partial<NftSalesRow> = {}): NftSalesRow {
  return {
    ...SAMPLE_ROWS[Table.NftSales],
    nft_id: ledger.toString(16).toUpperCase().padStart(64, '0'),
    ledger_index: ledger,
    tx_index: 1,
    event_index: 0,
    tx_hash: `synthetic-sale-${ledger}`,
    close_time: at(0, 3600),
    issuer: COLLECTION,
    ...over,
  };
}

/** A sale priced in an amount of an asset (the native currency when it has no issuer). */
function priced(ledger: number, amount: string, asset: Asset | 'XRP', over: Partial<NftSalesRow> = {}): NftSalesRow {
  return sale(ledger, {
    amount,
    amount_f: Number(amount),
    currency: asset === 'XRP' ? 'XRP' : asset.currency,
    amount_issuer: asset === 'XRP' ? '' : (asset.issuer as string),
    ...over,
  });
}

/** The set of a day of `native_rates_daily` as the job writes it: a sentinel and the assets with a rate (units per native coin). */
function ratesSet(day: number, rates: Array<[Asset, string]>, version = 1): NativeRatesDailyRow[] {
  const row = (currency: string, issuer: string, rate: string): NativeRatesDailyRow => ({
    currency,
    issuer,
    day: dayText(day),
    rate,
    rate_f: Number(rate),
    daily_count: 0,
    latest_count: 0,
    config_version: RATES_DAILY_CONFIG_VERSION,
    stale: 0,
    version,
  });
  return [row('', '', '0'), ...rates.map(([asset, rate]) => row(asset.currency, asset.issuer as string, rate))];
}

const SALES_OF_TABLE: SqlPart = {
  sql: `SELECT * FROM ${Table.NftSales} ORDER BY ledger_index, tx_index, event_index LIMIT 1 BY ledger_index, tx_index, event_index`,
  params: {},
};

interface Converted {
  ledger_index: number;
  text: string | null;
  float: number | null;
}

describe('NFT prices in the native currency (e2e)', () => {
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

  /** A migrated database of its own. */
  async function freshWorld(): Promise<{ ch: ClickHouseService; rates: RatesService; daily: DailyRates }> {
    const config = { ...container.config, database: `nft_prices_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const ch = new ClickHouseService(config);
    services.push(ch);
    const rates = new RatesService(ch, 'XRP');
    return { ch, rates, daily: new DailyRates(ch, rates) };
  }

  /** The converted price of every sale of `nft_sales`, by ledger index: its text, and its Float64 shadow. */
  async function convertedOf(ch: ClickHouseService, daily: DailyRates, sales = SALES_OF_TABLE): Promise<Converted[]> {
    const native = await nftSalesNativeSql(ch, daily, sales);
    const rows = await ch.query<{ ledger_index: number; text: string | null; float: number | null }>(
      `SELECT ledger_index, toString(converted_native) AS text, converted_native_f AS float
         FROM (${native.sql}) ORDER BY ledger_index`,
      native.params,
    );
    return rows.map((r) => ({ ledger_index: Number(r.ledger_index), text: r.text, float: r.float }));
  }

  /** The converted prices as numbers' text: ClickHouse's own text of a Decimal is not what is pinned here, `convertedSalePrices` is. */
  const textsOf = (rows: Converted[]): Array<string | null> =>
    rows.map((r) => (r.text === null ? null : new BigNumber(r.text).toFixed()));

  it('a native price is itself', async () => {
    const { ch, daily } = await freshWorld();
    await ch.insert(Table.NftSales, [
      priced(1, '1250', 'XRP'),
      priced(2, '61.25', 'XRP'),
      priced(3, '0.000001', 'XRP'),
      priced(4, '0', 'XRP'),
    ]);

    const rows = await convertedOf(ch, daily);

    expect(textsOf(rows)).toEqual(['1250', '61.25', '0.000001', '0']);
    expect(rows.map((r) => r.float)).toEqual([1250, 61.25, 0.000001, 0]);
    // and as the text the readers show: no trailing zeros, no exponent
    const keys = [1, 2, 3, 4].map((ledger_index): SaleKey => ({ ledger_index, tx_index: 1, event_index: 0 }));
    expect([...(await convertedSalePrices(ch, daily, keys))]).toEqual([
      ['1:1:0', '1250'],
      ['2:1:0', '61.25'],
      ['3:1:0', '0.000001'],
      ['4:1:0', '0'],
    ]);
  });

  it('a native price needs no rate and no set: it is the same on a day that has none', async () => {
    const { ch, daily } = await freshWorld();
    await ch.insert(Table.NftSales, [priced(1, '7.5', 'XRP', { close_time: at(400) })]);
    expect(textsOf(await convertedOf(ch, daily))).toEqual(['7.5']);
  });

  it("an issued price is divided by its day's rate, to 6 decimals", async () => {
    const { ch, daily } = await freshWorld();
    await ch.insert(Table.NativeRatesDaily, [
      ...ratesSet(0, [
        [USD, '2.5'],
        [EUR, '3'],
      ]),
      ...ratesSet(1, [[USD, '4']]),
    ]);
    await ch.insert(Table.NftSales, [
      priced(1, '100', USD), // 100 / 2.5
      priced(2, '1', EUR), // 1 / 3, to six places
      priced(3, '2', EUR), // 2 / 3, rounded to the nearest
      priced(4, '100', USD, { close_time: at(1, 10) }), // the rate of its own day
      priced(5, '0.000001', USD, { close_time: at(1, 10) }), // 0.00000025, below the sixth place
      priced(6, '123456789.123456', USD), // a large price keeps its places
    ]);

    const rows = await convertedOf(ch, daily);

    expect(textsOf(rows)).toEqual(['40', '0.333333', '0.666667', '25', '0', '49382715.649382']);
    expect(rows.map((r) => r.float)).toEqual([40, 0.333333, 0.666667, 25, 0, 49382715.649382]);
    const keys = [1, 2, 3, 4, 5, 6].map((ledger_index): SaleKey => ({ ledger_index, tx_index: 1, event_index: 0 }));
    expect([...(await convertedSalePrices(ch, daily, keys))]).toEqual([
      ['1:1:0', '40'],
      ['2:1:0', '0.333333'],
      ['3:1:0', '0.666667'],
      ['4:1:0', '25'],
      ['5:1:0', '0'],
      ['6:1:0', '49382715.649382'],
    ]);
  });

  it('an issued price on a day whose set is stale or of another config version is converted on read, like any other', async () => {
    const { ch, rates, daily } = await freshWorld();
    // the set of day 0 is stale, the set of day 1 is of another config version: neither is read, both are computed
    // (from no trade at all: no rate), where the set of day 2 is valid
    const stale = ratesSet(0, [[USD, '2.5']]).map((r) => ({ ...r, stale: 1 }));
    const other = ratesSet(1, [[USD, '2.5']]).map((r) => ({ ...r, config_version: RATES_DAILY_CONFIG_VERSION + 1 }));
    await ch.insert(Table.NativeRatesDaily, [...stale, ...other, ...ratesSet(2, [[USD, '2.5']])]);
    await ch.insert(Table.NftSales, [
      priced(1, '100', USD),
      priced(2, '100', USD, { close_time: at(1, 10) }),
      priced(3, '100', USD, { close_time: at(2, 10) }),
    ]);
    expect(await rates.dailyNativeRates([USD], new Date(at(0) * SEC), new Date(at(2) * SEC))).toEqual(
      new Map([
        [
          'USD.' + ISSUER,
          new Map([
            [dayText(0), new BigNumber(0)],
            [dayText(1), new BigNumber(0)],
          ]),
        ],
      ]),
    );

    expect(textsOf(await convertedOf(ch, daily))).toEqual([null, null, '40']);
  });

  it('an issued price on a day with no set is converted at the rate computed on read', async () => {
    const { ch, rates, daily } = await freshWorld();
    // day 0 has a set; day 1 has none and 10 trades (the least that make a rate) of USD against XRP at 0.25 XRP, so 4 USD buy 1 XRP
    await ch.insert(Table.NativeRatesDaily, ratesSet(0, [[USD, '2.5']]));
    const stored = canonicalPair(USD, { currency: 'XRP' });
    const closes = Array.from({ length: 10 }, (_, i) => at(1, 100 + i * 10));
    await ch.insert(
      Table.Ledgers,
      closes.map((close, i) => ({
        ...SAMPLE_ROWS[Table.Ledgers],
        ledger_index: 500 + i,
        ledger_hash: `${500 + i}`.padStart(64, 'C'),
        close_time: close,
      })),
    );
    await ch.insert(
      Table.Exchanges,
      closes.map((close, i) => {
        const [baseAmount, counterAmount] = stored.inverted ? ['2.5', '10'] : ['10', '2.5'];
        return {
          ...SAMPLE_ROWS[Table.Exchanges],
          base_currency: stored.base.currency,
          base_issuer: stored.base.issuer ?? '',
          counter_currency: stored.counter.currency,
          counter_issuer: stored.counter.issuer ?? '',
          ledger_index: 500 + i,
          tx_index: 1,
          node_index: 1,
          tx_hash: `synthetic-trade-${i}`,
          close_time: close,
          base_amount: baseAmount,
          counter_amount: counterAmount,
          base_amount_f: Number(baseAmount),
          counter_amount_f: Number(counterAmount),
          rate: new BigNumber(counterAmount).dividedBy(baseAmount).toString(),
          rate_f: Number(counterAmount) / Number(baseAmount),
        };
      }),
    );
    const onRead = (await rates.dailyNativeRates([USD], new Date(at(1) * SEC), new Date(at(2) * SEC))).get(
      'USD.' + ISSUER,
    );
    expect(onRead?.get(dayText(1))?.toFixed()).toBe('4');
    await ch.insert(Table.NftSales, [
      priced(1, '100', USD), // the stored set of day 0
      priced(2, '100', USD, { close_time: at(1, 10) }), // computed on read
    ]);

    // both kinds of day in one answer
    expect(textsOf(await convertedOf(ch, daily))).toEqual(['40', '25']);
  });

  it('a price without a rate that day has none', async () => {
    const { ch, daily } = await freshWorld();
    // day 0 has a set without EUR; day 1 has no set and no trade; a price with a rate sits next to them
    await ch.insert(Table.NativeRatesDaily, ratesSet(0, [[USD, '2.5']]));
    await ch.insert(Table.NftSales, [
      priced(1, '100', USD),
      priced(2, '100', EUR),
      priced(3, '100', USD, { close_time: at(1, 10) }),
      priced(4, '5', 'XRP'),
    ]);

    const rows = await convertedOf(ch, daily);

    expect(textsOf(rows)).toEqual(['40', null, null, '5']);
    expect(rows.map((r) => r.float)).toEqual([40, null, null, 5]);
  });

  it('a price too large to hold has none, and does not fail the others', async () => {
    const { ch, daily } = await freshWorld();
    await ch.insert(
      Table.NativeRatesDaily,
      ratesSet(0, [
        [USD, '2.5'],
        [EUR, '1e-30'],
      ]),
    );
    await ch.insert(Table.NftSales, [
      priced(1, '100', USD),
      priced(2, '1e40', USD, { amount: '10000000000000000000000000000000000000000' }), // 4e39 native coins
      priced(3, '100', EUR), // 1e32 native coins: a rate that small is a worthless token
      priced(4, '99', EUR), // 9.9e31
      priced(5, '1000000000000', USD), // 4e11, which fits
      priced(6, '5', 'XRP'),
    ]);

    const rows = await convertedOf(ch, daily);

    expect(textsOf(rows)).toEqual(['40', null, null, null, '400000000000', '5']);
    expect(
      [
        ...(await convertedSalePrices(
          ch,
          daily,
          [1, 2, 3, 4, 5, 6].map((ledger_index) => ({ ledger_index, tx_index: 1, event_index: 0 })),
        )),
      ].map(([key]) => key),
    ).toEqual(['1:1:0', '5:1:0', '6:1:0']);
  });

  it('a 40-hex currency code converts like a three-letter one', async () => {
    const { ch, daily } = await freshWorld();
    await ch.insert(
      Table.NativeRatesDaily,
      ratesSet(0, [
        [USD, '2.5'],
        [HEX, '8'],
      ]),
    );
    await ch.insert(Table.NftSales, [
      priced(1, '100', USD),
      priced(2, '100', HEX),
      priced(3, '100', HEX, { close_time: at(5) }),
    ]);

    const rows = await convertedOf(ch, daily);

    expect(textsOf(rows)).toEqual(['40', '12.5', null]);
    expect(await convertedSalePrices(ch, daily, [{ ledger_index: 2, tx_index: 1, event_index: 0 }])).toEqual(
      new Map([['2:1:0', '12.5']]),
    );
  });

  it('answers every column of the sales it was given, in front of the converted price', async () => {
    const { ch, daily } = await freshWorld();
    await ch.insert(Table.NativeRatesDaily, ratesSet(0, [[USD, '2.5']]));
    await ch.insert(Table.NftSales, [priced(7, '100', USD, { taxon: null, taxon_key: 0 })]);

    const native = await nftSalesNativeSql(ch, daily, SALES_OF_TABLE);
    const [row] = await ch.query<Record<string, unknown>>(native.sql, native.params);
    const [sales] = await ch.query<Record<string, unknown>>(SALES_OF_TABLE.sql);

    expect(Object.keys(row)).toEqual([...Object.keys(sales), 'converted_native', 'converted_native_f']);
    expect(row).toMatchObject({ ledger_index: 7, nft_id: sales.nft_id, taxon: null, currency: 'USD', amount: '100' });
  });

  it('keeps the parameters of the sales it was given next to its own, and reads only what they select', async () => {
    const { ch, daily } = await freshWorld();
    await ch.insert(Table.NativeRatesDaily, ratesSet(0, [[USD, '2.5']]));
    await ch.insert(Table.NftSales, [priced(1, '100', USD), priced(2, '100', USD), priced(3, '5', 'XRP')]);
    const only: SqlPart = {
      sql: `SELECT * FROM ${Table.NftSales} WHERE ledger_index = {only:UInt32}`,
      params: { only: 2 },
    };

    const rows = await convertedOf(ch, daily, only);

    expect(rows.map((r) => r.ledger_index)).toEqual([2]);
    expect(textsOf(rows)).toEqual(['40']);
  });

  it('gives no row for no sale, and asks nothing of the rates', async () => {
    const { ch, daily } = await freshWorld();
    const asked = jest.spyOn(daily, 'rateRowsSql');
    expect(await convertedOf(ch, daily)).toEqual([]);
    expect(await convertedSalePrices(ch, daily, [])).toEqual(new Map());
    expect(await convertedSalePrices(ch, daily, [{ ledger_index: 9, tx_index: 1, event_index: 0 }])).toEqual(new Map());
    // the first and the third are asked, with no issued price to find a rate for
    for (const [pairs] of asked.mock.calls) expect(pairs).toEqual([]);
  });

  it('convertedSalePrices keys each sale and leaves out the unrated', async () => {
    const { ch, daily } = await freshWorld();
    await ch.insert(Table.NativeRatesDaily, ratesSet(0, [[USD, '2.5']]));
    await ch.insert(Table.NftSales, [
      priced(10, '100', USD, { tx_index: 3, event_index: 1 }), // rated: 40
      priced(10, '12.5', 'XRP', { tx_index: 3, event_index: 2 }), // the same transaction, another sale: native
      priced(11, '100', EUR), // no rate: left out
      priced(12, '1', USD), // not asked for
      priced(13, '100', USD, { close_time: at(3) }), // no set that day, no trade: left out
    ]);
    const key = (ledger_index: number, tx_index: number, event_index: number): SaleKey => ({
      ledger_index,
      tx_index,
      event_index,
    });

    const prices = await convertedSalePrices(ch, daily, [
      key(10, 3, 1),
      key(10, 3, 2),
      key(11, 1, 0),
      key(13, 1, 0),
      key(14, 1, 0), // a sale there is none of
      key(10, 3, 1), // asked twice
    ]);

    expect(prices).toEqual(
      new Map([
        ['10:3:1', '40'],
        ['10:3:2', '12.5'],
      ]),
    );
  });

  it('a sale that was written twice, before a merge, has one price (the subquery of the caller reads it once)', async () => {
    const { ch, daily } = await freshWorld();
    const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
    await ch.command(`SYSTEM STOP MERGES ${database}.${Table.NftSales}`);
    await ch.insert(Table.NativeRatesDaily, ratesSet(0, [[USD, '2.5']]));
    const row = priced(1, '100', USD);
    await ch.insert(Table.NftSales, [row]);
    await ch.command(
      `INSERT INTO ${Table.NftSales} SELECT * FROM ${Table.NftSales}`,
      {},
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await ch.query<{ n: number | string }>(`SELECT count() AS n FROM ${Table.NftSales}`);
    expect(Number(n)).toBe(2);

    expect(textsOf(await convertedOf(ch, daily))).toEqual(['40']);
    expect(await convertedSalePrices(ch, daily, [{ ledger_index: 1, tx_index: 1, event_index: 0 }])).toEqual(
      new Map([['1:1:0', '40']]),
    );
  });
});
