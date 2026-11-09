import BigNumber from 'bignumber.js';
import { computePairHourSets } from '../src/aggregate/pair-hourly.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { ExchangesRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { RatesService } from '../src/query/rates.service';
import { dexHistoryPartition, dexHoursFromPairHourly, dexThrough, nextDexPartition } from '../src/token-history/build/dex';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';

const HOUR = 3_600;
/** Four whole hours that end two hours ago: inside `pair_hourly`'s 45 days. */
const H0 = Math.floor(Date.now() / 1000 / HOUR) * HOUR - 6 * HOUR;
const at = (h: number, minute: number): number => H0 + h * HOUR + minute * 60;

const USD = { currency: 'USD', issuer: 'rUsdIssuer' };
const EUR = { currency: 'EUR', issuer: 'rEurIssuer' };
const BTC = { currency: 'BTC', issuer: 'rBtcIssuer' };
const XRP = { currency: 'XRP', issuer: '' };
type Side = typeof USD;

interface Trade {
  base: Side;
  counter: Side;
  close: number;
  baseAmount: string;
  counterAmount: string;
  pool?: string;
}

/**
 * Hour 0: USD/EUR trades and a swap, XRP/USD with a native leg of dust (left out, as pair_hourly leaves it out). Hour 1: no trade
 * at all. Hour 2: BTC/USD with 1e40 and an amount of 31 places, which the decimal cannot hold. Hour 3: one EUR/XRP trade.
 */
const TRADES: Trade[] = [
  { base: USD, counter: EUR, close: at(0, 5), baseAmount: '10.5', counterAmount: '9' },
  { base: USD, counter: EUR, close: at(0, 10), baseAmount: '0.1', counterAmount: '0.2' },
  { base: USD, counter: EUR, close: at(0, 15), baseAmount: '3', counterAmount: '2.5', pool: 'rPool' },
  { base: XRP, counter: USD, close: at(0, 20), baseAmount: '100', counterAmount: '50' },
  { base: XRP, counter: USD, close: at(0, 25), baseAmount: '0.0004', counterAmount: '7' },
  { base: BTC, counter: USD, close: at(2, 5), baseAmount: '1e+40', counterAmount: '5' },
  { base: BTC, counter: USD, close: at(2, 25), baseAmount: '2', counterAmount: `0.${'0'.repeat(30)}1` },
  { base: EUR, counter: XRP, close: at(3, 30), baseAmount: '4', counterAmount: '8' },
];

/** One ledger per trade (and one every 20 minutes besides, so hour 1 and the end of hour 3 have ledgers), from ledger 50,000,100. */
function ledgerCloses(): number[] {
  const closes = new Set(TRADES.map((t) => t.close));
  for (let m = 0; m < 4 * 60 + 40; m += 20) closes.add(H0 + m * 60);
  return [...closes].sort((a, b) => a - b);
}

async function seed(ch: ClickHouseService): Promise<Map<number, number>> {
  const closes = ledgerCloses();
  const ledgerOf = new Map(closes.map((c, i) => [c, 50_000_100 + i]));
  await ch.insert(
    Table.Ledgers,
    closes.map((c) => ({
      ...SAMPLE_ROWS[Table.Ledgers],
      ledger_index: ledgerOf.get(c)!,
      ledger_hash: String(ledgerOf.get(c)).padStart(64, 'C'),
      close_time: c,
    })),
  );
  const rows: ExchangesRow[] = TRADES.map((t, i) => ({
    ...SAMPLE_ROWS[Table.Exchanges],
    base_currency: t.base.currency,
    base_issuer: t.base.issuer,
    counter_currency: t.counter.currency,
    counter_issuer: t.counter.issuer,
    ledger_index: ledgerOf.get(t.close)!,
    tx_index: 0,
    node_index: i,
    tx_hash: String(i).padStart(64, 'E'),
    close_time: t.close,
    base_amount: t.baseAmount,
    counter_amount: t.counterAmount,
    base_amount_f: Number(t.baseAmount),
    counter_amount_f: Number(t.counterAmount),
    rate: '1',
    rate_f: 1,
    amm_account: t.pool ?? '',
  }));
  await ch.insert(Table.Exchanges, rows);
  return ledgerOf;
}

/** The brute force: each token's amounts and trades in each hour, over the trades whose native legs are above the dust. */
function bruteForce(): Map<string, { exchanged: string; trades: number }> {
  const out = new Map<string, { exchanged: BigNumber; trades: number }>();
  for (const t of TRADES) {
    const dust = (s: Side, amount: string) => s.issuer === '' && Number(amount) <= 0.0005;
    if (dust(t.base, t.baseAmount) || dust(t.counter, t.counterAmount)) continue;
    const hour = Math.floor(t.close / HOUR) * HOUR;
    for (const [side, amount] of [
      [t.base, t.baseAmount],
      [t.counter, t.counterAmount],
    ] as const) {
      if (side.issuer === '') continue;
      const key = `${hour} ${side.issuer} ${side.currency}`;
      const v = out.get(key) ?? { exchanged: new BigNumber(0), trades: 0 };
      out.set(key, { exchanged: v.exchanged.plus(amount), trades: v.trades + 1 });
    }
  }
  return new Map([...out].map(([k, v]) => [k, { exchanged: v.exchanged.toFixed(), trades: v.trades }]));
}

interface DexRead {
  hour: number;
  issuer: string;
  currency: string;
  exchanged: string;
  trades: number;
}

const rowsOf = (ch: ClickHouseService) =>
  ch.query<DexRead>(
    `SELECT toUnixTimestamp(hour) AS hour, issuer, currency, exchanged, trades
       FROM ${Table.TokenHourlyDex}
      ORDER BY issuer, currency, hour, version DESC
      LIMIT 1 BY issuer, currency, hour`,
  );
const tokenRows = async (ch: ClickHouseService) => (await rowsOf(ch)).filter((r) => r.issuer !== '');
const sentinelHours = async (ch: ClickHouseService) =>
  (await rowsOf(ch)).filter((r) => r.issuer === '' && r.currency === '').map((r) => r.hour);

describe('DEX hours of the token history (e2e)', () => {
  let container: StartedClickHouse;
  const services: ClickHouseService[] = [];
  /** The live path: pair_hourly's final sets of the four hours, then the DEX hours from them. */
  let live: ClickHouseService;
  /** The history path: no pair_hourly, the scan of the exchanges partition. */
  let history: ClickHouseService;

  async function fresh(name: string): Promise<ClickHouseService> {
    const config = { ...container.config, database: name };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  beforeAll(async () => {
    container = await startClickHouse();
    live = await fresh('token_history_dex_live');
    history = await fresh('token_history_dex_history');
    await seed(live);
    await seed(history);
    expect(await computePairHourSets(live, new RatesService(live, 'XRP'), H0, H0 + 4 * HOUR)).toBe(4);
    for (let h = 0; h < 4; h++) expect(await dexHoursFromPairHourly(live, new Date((H0 + h * HOUR) * 1000))).toBe('written');
    expect(await nextDexPartition(history)).toBe(5);
    // hours 0 to 3: hour 4 holds the newest ledger, so it is not final yet
    expect(await dexHistoryPartition(history, 5)).toEqual({ hours: 4 });
  }, 180_000);

  afterAll(async () => {
    for (const s of services) await s.close();
    await container?.container.stop();
  });

  it("a token's hour exchanged equals the brute-force sum of its base and counter amounts", async () => {
    const want = bruteForce();
    for (const ch of [live, history]) {
      const got = new Map((await tokenRows(ch)).map((r) => [`${r.hour} ${r.issuer} ${r.currency}`, { exchanged: r.exchanged, trades: r.trades }]));
      expect(got).toEqual(want);
    }
    // USD in hour 0: 10.5 + 0.1 + 3 as the base, 50 as the counter of XRP/USD (the trade of 0.0004 XRP is dust)
    expect(want.get(`${H0} ${USD.issuer} USD`)).toEqual({ exchanged: '63.6', trades: 4 });
  });

  it('pair_hourly and the exchanges scan give the same rows for the same hour', async () => {
    expect(await tokenRows(history)).toEqual(await tokenRows(live));
  });

  it('an unfit pair-hour is summed exactly', async () => {
    const btc = (await tokenRows(live)).find((r) => r.issuer === BTC.issuer && r.hour === H0 + 2 * HOUR);
    expect(btc?.exchanged).toBe(new BigNumber('1e40').plus(2).toFixed());
    const usd = (await tokenRows(history)).find((r) => r.issuer === USD.issuer && r.hour === H0 + 2 * HOUR);
    expect(usd?.exchanged).toBe(new BigNumber(5).plus(`1e-31`).toFixed());
  });

  it('an hour with no trades has a sentinel and no row', async () => {
    for (const ch of [live, history]) {
      expect(await sentinelHours(ch)).toEqual(expect.arrayContaining([H0, H0 + HOUR, H0 + 2 * HOUR, H0 + 3 * HOUR]));
      expect((await tokenRows(ch)).some((r) => r.hour === H0 + HOUR)).toBe(false);
    }
  });

  it('the native currency is no token', async () => {
    for (const ch of [live, history]) expect((await rowsOf(ch)).some((r) => r.currency === 'XRP')).toBe(false);
  });

  it('a pair_hourly set that is not final gives no DEX hour', async () => {
    const ch = await fresh('token_history_dex_not_final');
    await seed(ch);
    // the newest ledger closes inside hour 4, so hour 4's set is not final
    await computePairHourSets(ch, new RatesService(ch, 'XRP'), H0 + 4 * HOUR, H0 + 5 * HOUR);
    expect(await dexHoursFromPairHourly(ch, new Date((H0 + 4 * HOUR) * 1000))).toBe('not_final');
    expect(await dexHoursFromPairHourly(ch, new Date((H0 + 9 * HOUR) * 1000))).toBe('not_final');
    expect(await rowsOf(ch)).toEqual([]);
  });

  it('dexThrough is the end of the newest run of sentinels, and the history stops below pair_hourly', async () => {
    expect(await dexThrough(live)).toEqual(new Date((H0 + 4 * HOUR) * 1000));
    expect(await dexThrough(await fresh('token_history_dex_empty'))).toBeUndefined();
    // with the live hours in pair_hourly, the scan has no hour left below the oldest final one but hour 0's predecessors
    expect(await nextDexPartition(live)).toBeUndefined();
    expect(await nextDexPartition(history)).toBeUndefined();
  });
});
