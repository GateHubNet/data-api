import { RATES_DAILY_CONFIG_VERSION } from '../src/aggregate/rates-daily.job';
import {
  computeDailyVolumeSet,
  computeLiveVolumes,
  computeLiveVolumeSet,
  configVersionOf,
  LivePeriod,
  NFT_LIVE_PERIODS,
  NFT_VOLUME_CONFIG_VERSION,
  volumeDaysDone,
} from '../src/aggregate/volume.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { NativeRatesDailyRow, NftSalesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { MarketsConfig } from '../src/network';
import { Asset } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

/**
 * The `nft_volume` metric of the volume jobs on a real ClickHouse (spec 3.3): the sales of each collection in a window,
 * converted to the native currency by `nftSalesNativeSql`, a component per collection with a converted sale.
 *
 * The world is made by hand: sales (`synthetic-…` transactions), the `ledgers` that commit them, and the `native_rates_daily`
 * sets of the days they were made on, with the numbers worked out on paper. What a reader relies on is checked on the rows
 * as stored: the newest version of a set, the sentinel (its count is every sale of the window), the component ids and the
 * config version of the metric.
 */

const SEC = 1000;
const HOUR = 3600;
const DAY = 86_400;

/** 2026-01-20 12:00:00 UTC. */
const NOW = Date.UTC(2026, 0, 20, 12) / SEC;
const at = (seconds: number): Date => new Date(seconds * SEC);
const dayText = (seconds: number): string => at(seconds).toISOString().slice(0, 10);
const midnight = (seconds: number): number => Math.floor(seconds / DAY) * DAY;

const ISSUER_A = 'rSyntheticCollectionA';
const ISSUER_B = 'rSyntheticCollectionB';
const ISSUER_C = 'rSyntheticCollectionC';
const ISSUER_D = 'rSyntheticCollectionD';
const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const USD: Asset = { currency: 'USD', issuer: ISSUER };
const EUR: Asset = { currency: 'EUR', issuer: ISSUER };

const config = (version = 1): MarketsConfig => ({ version, tradeMarkets: [], paymentCurrencies: [] });

/** A sale made by hand: the ledger it is in (its own, with its own close time) and the collection. */
interface Sale {
  ledger: number;
  close: number;
  issuer: string;
  /** `null` is the taxon of a URIToken. */
  taxon: number | null;
  amount: string;
  /** The currency: `XRP` or `XAH` (the native currency), else an issued asset. */
  price: 'XRP' | 'XAH' | Asset;
  tx?: number;
  event?: number;
}

const rowOf = (s: Sale): NftSalesRow => ({
  ...SAMPLE_ROWS[Table.NftSales],
  nft_id: s.ledger.toString(16).toUpperCase().padStart(64, '0'),
  ledger_index: s.ledger,
  tx_index: s.tx ?? 1,
  event_index: s.event ?? 0,
  tx_hash: `synthetic-sale-${s.ledger}-${s.tx ?? 1}-${s.event ?? 0}`,
  close_time: s.close,
  kind: s.taxon === null ? 'uritoken' : 'nftoken',
  issuer: s.issuer,
  taxon: s.taxon,
  taxon_key: s.taxon ?? 0,
  amount: s.amount,
  amount_f: Number(s.amount),
  currency: typeof s.price === 'string' ? s.price : s.price.currency,
  amount_issuer: typeof s.price === 'string' ? '' : (s.price.issuer as string),
});

/** The `ledgers` rows that commit the ledgers: one per ledger index, closed when its first sale did. */
const ledgersOf = (sales: Sale[], extra: Array<[ledger: number, close: number]> = []) =>
  [...new Map([...sales.map((s): [number, number] => [s.ledger, s.close]), ...extra]).entries()].map(
    ([ledger_index, close_time]) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index,
      ledger_hash: `${ledger_index}`.padStart(64, 'C'),
      close_time,
    }),
  );

/** The set of a day of `native_rates_daily` as the job writes it: a sentinel and the assets with a rate (units per native coin). */
function ratesSet(seconds: number, rates: Array<[Asset, string]>): NativeRatesDailyRow[] {
  const row = (currency: string, issuer: string, rate: string): NativeRatesDailyRow => ({
    currency,
    issuer,
    day: dayText(seconds),
    rate,
    rate_f: Number(rate),
    daily_count: 0,
    latest_count: 0,
    config_version: RATES_DAILY_CONFIG_VERSION,
    stale: 0,
    version: 1,
  });
  return [row('', '', '0'), ...rates.map(([asset, rate]) => row(asset.currency, asset.issuer as string, rate))];
}

// ---------------------------------------------------------------------------------------------------------------------
// What a reader sees: the rows of the newest version of a set
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
}

const COLUMNS = `metric, component, base_currency, base_issuer, counter_currency, counter_issuer, amount, amount_f,
  toUInt64(count) AS count, rate_f, converted_f, config_version, toUInt64(version) AS version`;

const numbers = (r: StoredRow): StoredRow => ({
  ...r,
  amount_f: Number(r.amount_f),
  count: Number(r.count),
  rate_f: Number(r.rate_f),
  converted_f: Number(r.converted_f),
  config_version: Number(r.config_version),
  version: Number(r.version),
});

/** The newest version of a daily set, the sentinel first and then the components as a reader lists them. */
async function dailySet(ch: ClickHouseService, seconds: number): Promise<StoredRow[]> {
  const rows = await ch.query<StoredRow>(
    `SELECT ${COLUMNS} FROM ${Table.VolumeDaily}
      WHERE metric = 'nft_volume' AND day = {day:Date}
        AND version = (SELECT max(version) FROM ${Table.VolumeDaily} WHERE metric = 'nft_volume' AND day = {day:Date})
      ORDER BY component = '' DESC, converted_f DESC, component`,
    { day: dayText(seconds) },
  );
  return rows.map(numbers);
}

/** The newest version of a live set, the sentinel first and then the components as a reader lists them. */
async function liveSet(ch: ClickHouseService, period: LivePeriod): Promise<StoredRow[]> {
  const rows = await ch.query<StoredRow>(
    `SELECT ${COLUMNS} FROM ${Table.VolumeLive}
      WHERE metric = 'nft_volume' AND period = {period:String}
        AND version = (SELECT max(version) FROM ${Table.VolumeLive} WHERE metric = 'nft_volume' AND period = {period:String})
      ORDER BY component = '' DESC, converted_f DESC, component`,
    { period },
  );
  return rows.map(numbers);
}

/** What a component of the metric looks like when it is `amount` native coins in `count` sales. */
const component = (id: string, native: string, amount: string, count: number) => ({
  metric: 'nft_volume',
  component: id,
  base_currency: native,
  base_issuer: '',
  counter_currency: '',
  counter_issuer: '',
  amount,
  amount_f: Number(amount),
  count,
  rate_f: 1,
  converted_f: Number(amount),
  config_version: NFT_VOLUME_CONFIG_VERSION,
});

const sentinel = (count: number, final = 0) => ({
  metric: 'nft_volume',
  component: '',
  base_currency: '',
  base_issuer: '',
  counter_currency: '',
  counter_issuer: '',
  amount: '0',
  amount_f: 0,
  count,
  rate_f: final,
  converted_f: 0,
  config_version: NFT_VOLUME_CONFIG_VERSION,
});

/** The stored rows without their version. */
const withoutVersion = (rows: StoredRow[]) => rows.map(({ version: _version, ...rest }) => rest);

describe('the nft_volume metric (e2e)', () => {
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

  /** A migrated database of its own with the sales, their ledgers and the rate sets in it. */
  async function world(
    sales: Sale[],
    options: {
      rates?: NativeRatesDailyRow[];
      native?: 'XRP' | 'XAH';
      /** More ledgers that are committed: their index and close time. */
      ledgers?: Array<[number, number]>;
      /** Ledgers that have sales and are not committed (the writer has not written their `ledgers` row yet). */
      uncommitted?: number[];
    } = {},
  ): Promise<{ ch: ClickHouseService; rates: RatesService }> {
    const dbConfig = { ...container.config, database: `nft_volume_${++dbCounter}` };
    await runMigrations({ config: dbConfig, log: () => undefined });
    const ch = new ClickHouseService(dbConfig);
    services.push(ch);
    await ch.insert(
      Table.Ledgers,
      ledgersOf(sales, options.ledgers).filter((l) => !options.uncommitted?.includes(l.ledger_index)),
    );
    await ch.insert(Table.NftSales, sales.map(rowOf));
    await ch.insert(Table.NativeRatesDaily, options.rates ?? []);
    return { ch, rates: new RatesService(ch, options.native ?? 'XRP') };
  }

  const xrp = (ledger: number, close: number, issuer: string, taxon: number | null, amount: string, tx = 1): Sale => ({
    ledger,
    close,
    issuer,
    taxon,
    amount,
    price: 'XRP',
    tx,
  });

  it('writes a live day set: a component per collection with converted sales, by converted amount', async () => {
    const rate = ratesSet(NOW, [[USD, '2']]);
    const sales: Sale[] = [
      xrp(100, NOW - 5 * HOUR, ISSUER_A, 1, '10'),
      xrp(101, NOW - 4 * HOUR, ISSUER_B, 2, '40'),
      xrp(102, NOW - 3 * HOUR, ISSUER_A, 1, '5'),
      { ledger: 103, close: NOW - 2 * HOUR, issuer: ISSUER_C, taxon: 3, amount: '2', price: USD }, // 2 USD at 2 USD per XRP
      xrp(104, NOW - 1 * HOUR, ISSUER_A, 9, '0.5'), // the same issuer, another taxon: another collection
    ];
    const { ch, rates } = await world(sales, { rates: rate });

    const written = await computeLiveVolumeSet(ch, rates, config(), 'nft_volume', 'day', at(NOW));

    expect(written).toBe(4);
    const rows = await liveSet(ch, 'day');
    expect(withoutVersion(rows)).toEqual([
      sentinel(5),
      component(`${ISSUER_B}/2`, 'XRP', '40', 1),
      component(`${ISSUER_A}/1`, 'XRP', '15', 2),
      component(`${ISSUER_C}/3`, 'XRP', '1', 1),
      component(`${ISSUER_A}/9`, 'XRP', '0.5', 1),
    ]);
    // one set, one version
    expect(new Set(rows.map((r) => r.version)).size).toBe(1);
    // a live row says nothing of its own about its start and end here: its window is the period's
    const [{ start_time, end_time }] = await ch.query<{ start_time: number; end_time: number }>(
      `SELECT toUnixTimestamp(start_time) AS start_time, toUnixTimestamp(end_time) AS end_time
         FROM ${Table.VolumeLive} WHERE metric = 'nft_volume' AND period = 'day' LIMIT 1`,
    );
    expect([Number(start_time), Number(end_time)]).toEqual([NOW - DAY, NOW]);
  });

  it('leaves a sale without a rate out of the components but in the row count', async () => {
    const sales: Sale[] = [
      xrp(100, NOW - 5 * HOUR, ISSUER_A, 1, '10'),
      { ledger: 101, close: NOW - 4 * HOUR, issuer: ISSUER_A, taxon: 1, amount: '7', price: EUR }, // a rate of none
      { ledger: 102, close: NOW - 3 * HOUR, issuer: ISSUER_D, taxon: 4, amount: '3', price: EUR }, // a collection of that alone
      { ledger: 103, close: NOW - 2 * HOUR, issuer: ISSUER_B, taxon: 2, amount: '8', price: USD }, // 8 USD at 2
    ];
    const { ch, rates } = await world(sales, { rates: ratesSet(NOW, [[USD, '2']]) });

    const written = await computeLiveVolumeSet(ch, rates, config(), 'nft_volume', 'day', at(NOW));

    expect(written).toBe(2);
    expect(withoutVersion(await liveSet(ch, 'day'))).toEqual([
      // all four sales, the rated ones or not
      sentinel(4),
      component(`${ISSUER_A}/1`, 'XRP', '10', 1),
      component(`${ISSUER_B}/2`, 'XRP', '4', 1),
    ]);
  });

  it('names a component issuer/taxon on XRPL and issuer on Xahau', async () => {
    const xrpl = await world([
      xrp(100, NOW - 5 * HOUR, ISSUER_A, 7, '10'),
      xrp(101, NOW - 4 * HOUR, ISSUER_A, 0, '20'), // taxon 0 is a taxon
      xrp(102, NOW - 3 * HOUR, ISSUER_A, 7, '1'),
    ]);
    await computeLiveVolumeSet(xrpl.ch, xrpl.rates, config(), 'nft_volume', 'day', at(NOW));
    expect(withoutVersion(await liveSet(xrpl.ch, 'day'))).toEqual([
      sentinel(3),
      component(`${ISSUER_A}/0`, 'XRP', '20', 1),
      component(`${ISSUER_A}/7`, 'XRP', '11', 2),
    ]);

    // URITokens have no taxon: one component per issuer, in the native currency of the network
    const xahau = await world(
      [
        { ...xrp(100, NOW - 5 * HOUR, ISSUER_A, null, '10'), price: 'XAH' },
        { ...xrp(101, NOW - 4 * HOUR, ISSUER_B, null, '30'), price: 'XAH' },
        { ...xrp(102, NOW - 3 * HOUR, ISSUER_A, null, '5'), price: 'XAH' },
      ],
      { native: 'XAH' },
    );
    await computeLiveVolumeSet(xahau.ch, xahau.rates, config(), 'nft_volume', 'day', at(NOW));
    expect(withoutVersion(await liveSet(xahau.ch, 'day'))).toEqual([
      sentinel(3),
      component(ISSUER_B, 'XAH', '30', 1),
      component(ISSUER_A, 'XAH', '15', 2),
    ]);
  });

  it('has the exact sum of the converted prices of a component, not the sum of floats', async () => {
    const { ch, rates } = await world(
      [
        xrp(100, NOW - 5 * HOUR, ISSUER_A, 1, '0.1'),
        xrp(101, NOW - 4 * HOUR, ISSUER_A, 1, '0.2'),
        xrp(102, NOW - 3 * HOUR, ISSUER_A, 1, '0.000001'),
        // 1 / 3 to six places, three times: 0.999999 (not 1)
        ...[103, 104, 105].map((ledger) => ({
          ledger,
          close: NOW - 2 * HOUR,
          issuer: ISSUER_B,
          taxon: 2,
          amount: '1',
          price: USD,
        })),
      ],
      { rates: ratesSet(NOW, [[USD, '3']]) },
    );

    await computeLiveVolumeSet(ch, rates, config(), 'nft_volume', 'day', at(NOW));

    expect(withoutVersion(await liveSet(ch, 'day'))).toEqual([
      sentinel(6),
      component(`${ISSUER_B}/2`, 'XRP', '0.999999', 3),
      component(`${ISSUER_A}/1`, 'XRP', '0.300001', 3),
    ]);
  });

  it('reads the sales of the window, by the committed ledgers that closed in it, and only those', async () => {
    const sales: Sale[] = [
      xrp(100, NOW - 40 * DAY, ISSUER_A, 1, '1000'), // before every window
      xrp(101, NOW - 10 * DAY, ISSUER_A, 1, '100'), // the 30day window only
      xrp(102, NOW - 3 * DAY, ISSUER_A, 1, '10'), // the 7day and the 30day windows
      xrp(103, NOW - 2 * HOUR, ISSUER_A, 1, '1'), // every window
      xrp(104, NOW - HOUR, ISSUER_B, 2, '4'), // in a ledger that is not committed (no row of `ledgers`)
      xrp(105, NOW + 5 * HOUR, ISSUER_A, 1, '1000000'), // after now
    ];
    const { ch, rates } = await world(sales, { uncommitted: [104] });

    await computeLiveVolumes(ch, rates, config(), at(NOW));

    for (const [period, amount, count] of [
      ['day', '1', 1],
      ['7day', '11', 2],
      ['30day', '111', 3],
    ] as const) {
      // the sentinel counts the sales of the window as the components do: the one of the uncommitted ledger is in neither
      expect(withoutVersion(await liveSet(ch, period))).toEqual([
        sentinel(count),
        component(`${ISSUER_A}/1`, 'XRP', amount, count),
      ]);
    }
  });

  it('writes the live sets of day, 7day and 30day only', async () => {
    const { ch, rates } = await world([xrp(100, NOW - HOUR, ISSUER_A, 1, '1')]);

    await computeLiveVolumes(ch, rates, config(), at(NOW));

    const periods = await ch.query<{ period: string }>(
      `SELECT DISTINCT period FROM ${Table.VolumeLive} WHERE metric = 'nft_volume' ORDER BY period`,
    );
    expect(periods.map((r) => r.period)).toEqual([...NFT_LIVE_PERIODS].sort());
    await expect(computeLiveVolumeSet(ch, rates, config(), 'nft_volume', 'hour', at(NOW))).rejects.toThrow(
      'nft_volume has no live period hour',
    );
  });

  it('writes a set with only its sentinel for a window without sales, and for a database without ledgers', async () => {
    const { ch, rates } = await world([xrp(100, NOW - 40 * DAY, ISSUER_A, 1, '5')], { ledgers: [[200, NOW - HOUR]] });
    await computeLiveVolumeSet(ch, rates, config(), 'nft_volume', 'day', at(NOW));
    expect(withoutVersion(await liveSet(ch, 'day'))).toEqual([sentinel(0)]);

    const empty = await world([]);
    await computeLiveVolumeSet(empty.ch, empty.rates, config(), 'nft_volume', 'day', at(NOW));
    expect(withoutVersion(await liveSet(empty.ch, 'day'))).toEqual([sentinel(0)]);
  });

  describe('the daily sets', () => {
    const D = midnight(NOW) - 3 * DAY;

    it('writes the sales of the UTC day, final once the ingest is an hour past it', async () => {
      const sales: Sale[] = [
        xrp(100, D - HOUR, ISSUER_A, 1, '1000'), // the day before
        xrp(101, D, ISSUER_A, 1, '10'), // the first second of the day
        { ledger: 102, close: D + 2 * HOUR, issuer: ISSUER_C, taxon: 3, amount: '1', price: EUR }, // no rate
        xrp(103, D + 13 * HOUR, ISSUER_B, 2, '30'),
        xrp(104, D + DAY - 1, ISSUER_A, 1, '5'), // the last
        xrp(105, D + DAY, ISSUER_A, 1, '2000'), // the day after
      ];
      const { ch, rates } = await world(sales, { ledgers: [[300, D + DAY + HOUR]] });

      const written = await computeDailyVolumeSet(ch, rates, config(), 'nft_volume', at(D + 5 * HOUR));

      expect(written).toBe(2);
      expect(withoutVersion(await dailySet(ch, D))).toEqual([
        sentinel(4, 1),
        component(`${ISSUER_B}/2`, 'XRP', '30', 1),
        component(`${ISSUER_A}/1`, 'XRP', '15', 2),
      ]);
    });

    it('is not final while the ingest has not passed the day by an hour', async () => {
      const { ch, rates } = await world([xrp(101, D + HOUR, ISSUER_A, 1, '10')], {
        ledgers: [[300, D + DAY + HOUR - 1]],
      });
      await computeDailyVolumeSet(ch, rates, config(), 'nft_volume', at(D));
      expect(withoutVersion(await dailySet(ch, D))).toEqual([
        sentinel(1, 0),
        component(`${ISSUER_A}/1`, 'XRP', '10', 1),
      ]);
    });

    it('writes daily sets that a markets config change does not make stale', async () => {
      const { ch, rates } = await world([xrp(101, D + HOUR, ISSUER_A, 1, '10')], { ledgers: [[300, D + DAY + HOUR]] });
      const [from, to] = [at(D), at(D + DAY)];

      await computeDailyVolumeSet(ch, rates, config(1), 'nft_volume', at(D));
      await computeDailyVolumeSet(ch, rates, config(1), 'trade_volume', at(D));

      // the markets config moves to version 7: the trade volume of the day is stale, the nft volume is not
      const done = (metric: 'nft_volume' | 'trade_volume', version: number) =>
        volumeDaysDone(ch, metric, from, to, configVersionOf(metric, config(version)));
      expect(await done('trade_volume', 1)).toEqual(new Set([dayText(D)]));
      expect(await done('trade_volume', 7)).toEqual(new Set());
      expect(await done('nft_volume', 1)).toEqual(new Set([dayText(D)]));
      expect(await done('nft_volume', 7)).toEqual(new Set([dayText(D)]));
    });

    it('writes its own config version whatever the markets config says', async () => {
      const { ch, rates } = await world([xrp(101, D + HOUR, ISSUER_A, 1, '10')], { ledgers: [[300, D + DAY + HOUR]] });

      await computeDailyVolumeSet(ch, rates, config(7), 'nft_volume', at(D));
      await computeLiveVolumeSet(ch, rates, config(7), 'nft_volume', 'day', at(NOW));

      for (const rows of [await dailySet(ch, D), await liveSet(ch, 'day')]) {
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.config_version))).toEqual(new Set([NFT_VOLUME_CONFIG_VERSION]));
      }
    });

    it('is computed again with a newer version, and a reader keeps the newest set', async () => {
      const { ch, rates } = await world([xrp(101, D + HOUR, ISSUER_A, 1, '10')], { ledgers: [[300, D + DAY + HOUR]] });
      await computeDailyVolumeSet(ch, rates, config(), 'nft_volume', at(D));
      const first = (await dailySet(ch, D))[0].version;
      await ch.insert(Table.NftSales, [rowOf(xrp(102, D + 2 * HOUR, ISSUER_A, 1, '5'))]);
      await ch.insert(Table.Ledgers, ledgersOf([xrp(102, D + 2 * HOUR, ISSUER_A, 1, '5')]));

      await computeDailyVolumeSet(ch, rates, config(), 'nft_volume', at(D));

      const rows = await dailySet(ch, D);
      expect(rows[0].version).toBeGreaterThan(first);
      expect(withoutVersion(rows)).toEqual([sentinel(2, 1), component(`${ISSUER_A}/1`, 'XRP', '15', 2)]);
    });
  });

  it('reads each sale once before a merge', async () => {
    const sales: Sale[] = [
      xrp(100, NOW - 5 * HOUR, ISSUER_A, 1, '10'),
      xrp(101, NOW - 4 * HOUR, ISSUER_B, 2, '40'),
      { ledger: 102, close: NOW - 3 * HOUR, issuer: ISSUER_B, taxon: 2, amount: '8', price: USD },
    ];
    const { ch, rates } = await world(sales, { rates: ratesSet(NOW, [[USD, '2']]) });
    const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
    await ch.command(`SYSTEM STOP MERGES ${database}.${Table.NftSales}`);
    // a real duplicate: every sale is in the table twice, as its own part
    await ch.command(
      `INSERT INTO ${Table.NftSales} SELECT * FROM ${Table.NftSales}`,
      {},
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await ch.query<{ n: number | string }>(`SELECT count() AS n FROM ${Table.NftSales}`);
    expect(Number(n)).toBe(6);

    await computeLiveVolumeSet(ch, rates, config(), 'nft_volume', 'day', at(NOW));

    expect(withoutVersion(await liveSet(ch, 'day'))).toEqual([
      sentinel(3),
      component(`${ISSUER_B}/2`, 'XRP', '44', 2),
      component(`${ISSUER_A}/1`, 'XRP', '10', 1),
    ]);
  });
});
