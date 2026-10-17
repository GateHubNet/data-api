import BigNumber from 'bignumber.js';
import { join } from 'node:path';
import {
  AMM_CHUNK,
  AMM_POOL_PAIRS_SQL,
  AMM_POOL_SUMS_SQL,
  AMM_TOUCHED_POOLS_SQL,
  ammPoolVolumes,
} from '../src/aggregate/amm-reads';
import {
  computeDailyVolumeSet,
  computeLiveVolumes,
  computeLiveVolumeSet,
  LIVE_PERIOD_SECONDS,
  LivePeriod,
  TRADE_LIVE_PERIODS,
  VOLUME_DAY_SETTLE_MS,
  volumeDaysDone,
  VolumeRecomputeAborted,
} from '../src/aggregate/volume.job';
import { ClickHouseService } from '../src/clickhouse/clickhouse.service';
import { runMigrations } from '../src/clickhouse/migrate';
import { AmmPoolStatesRow, AmmPoolTouchesRow, ExchangesRow, LedgersRow } from '../src/clickhouse/rows';
import { Table } from '../src/clickhouse/tables';
import { buildLedgerRows } from '../src/ingest/build-rows';
import { FixtureLedgerSource } from '../src/ingest/fixture-ledger-source';
import { LedgerWriter } from '../src/ingest/ledger-writer';
import { getNetworkProfile, MarketsConfig } from '../src/network';
import { parseContextFor } from '../src/parsers/parser.interface';
import { Asset, assetKey } from '../src/query/asset';
import { RatesService } from '../src/query/rates.service';
import { startClickHouse, StartedClickHouse } from './clickhouse-container';
import { SAMPLE_ROWS } from './sample-rows';
import { ammVolumeOracle, ExpectedAmm } from './volume-oracle';

/**
 * The `amm_volume` metric of the volume jobs on a real ClickHouse: the swaps of each pool in a window, converted like the
 * trade components (Rulings R-A18 and R-A19).
 *
 * Part 1 computes the live windows and every UTC day of the real mainnet AMM fixtures (`fixtures/xrpl/amm`, written through the
 * real `LedgerWriter`) and compares each set with an oracle (`ammVolumeOracle`, plain JavaScript over the exchange rows the
 * writer stored, never the job's helpers). Part 2 is a world made by hand, with numbers worked out on paper: every way a pool
 * is converted (its own native leg, the native leg turned round, through the rate of a configured market, through the rate of
 * the pools, through the counter, no rate at all), the dust rule, ties, order-book trades of the same pair, swaps outside the
 * window, ledgers that are not committed. Part 3 is what the readers rely on: the sets (one version, the sentinel, finality),
 * the periods, real duplicate rows, a database without a pool, the abort. Part 4 proves that no read crosses the pairs (Ruling
 * R-A3) on tables of several parts, and that pools are read in chunks.
 */

const SEC = 1000;
const DAY = 86_400;
const HOUR = 3600;

const ctx = parseContextFor(getNetworkProfile('xrpl'));
const AMM_LEDGERS = FixtureLedgerSource.fromDir(join(__dirname, 'fixtures/xrpl/amm')).list();
const AMM_EXCHANGES: ExchangesRow[] = AMM_LEDGERS.map((raw) => buildLedgerRows(raw, ctx)).flatMap((b) => b.exchanges);

const unix = (text: string): number => Date.parse(text) / SEC;
const at = (seconds: number): Date => new Date(seconds * SEC);
const utcDay = (seconds: number): string => new Date(seconds * SEC).toISOString().slice(0, 10);
const hash = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0');

const ISSUER_A = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
const ISSUER_B = 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B';
const ISSUER_C = 'rGm7WCVp9gb4jZHWTEtGUr4dd74z2XuWhE';
const ISSUER_D = 'rpvRJUcmqQqyCHCmYRPW9FXFAGQEcibVz9';
const XRP: Asset = { currency: 'XRP' };
const USD: Asset = { currency: 'USD', issuer: ISSUER_A };
const EUR: Asset = { currency: 'EUR', issuer: ISSUER_B };
const GBP: Asset = { currency: 'GBP', issuer: ISSUER_C };
const AAA: Asset = { currency: 'AAA', issuer: ISSUER_D };
const BBB: Asset = { currency: 'BBB', issuer: ISSUER_D };
const ZED: Asset = { currency: 'ZED', issuer: ISSUER_D };
const ZRO: Asset = { currency: 'ZRO', issuer: ISSUER_D };
const ZZZ: Asset = { currency: 'ZZZ', issuer: ISSUER_D };

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
  start_time?: number;
  end_time?: number;
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
  ...(r.start_time !== undefined && { start_time: Number(r.start_time), end_time: Number(r.end_time) }),
});

async function dailySet(ch: ClickHouseService, day: string): Promise<StoredRow[]> {
  const rows = await ch.query<StoredRow>(
    `SELECT ${COLUMNS} FROM ${Table.VolumeDaily}
      WHERE metric = 'amm_volume' AND day = {day:Date}
        AND version = (SELECT max(version) FROM ${Table.VolumeDaily} WHERE metric = 'amm_volume' AND day = {day:Date})
      ORDER BY component`,
    { day },
  );
  return rows.map(numbers);
}

async function liveSet(ch: ClickHouseService, period: LivePeriod): Promise<StoredRow[]> {
  const rows = await ch.query<StoredRow>(
    `SELECT ${COLUMNS}, toUnixTimestamp(start_time) AS start_time, toUnixTimestamp(end_time) AS end_time
       FROM ${Table.VolumeLive}
      WHERE metric = 'amm_volume' AND period = {period:String}
        AND version = (SELECT max(version) FROM ${Table.VolumeLive} WHERE metric = 'amm_volume' AND period = {period:String})
      ORDER BY component`,
    { period },
  );
  return rows.map(numbers);
}

/** The components of a set (the sentinel is not one), the largest converted amount first like the readers list them. */
const parts = (rows: StoredRow[]): StoredRow[] =>
  rows
    .filter((r) => r.component !== '')
    .sort((a, b) => b.converted_f - a.converted_f || (a.component < b.component ? -1 : 1));

/** Two numbers agree to 12 significant digits (a division, a float sum: not the same last digit everywhere). */
function close(label: string, got: number, want: number): void {
  const tolerance = Math.max(Math.abs(want) * 1e-12, 1e-300);
  if (Math.abs(got - want) > tolerance) throw new Error(`${label}: got ${got}, want ${want}`);
}

/** The components as a reader sees them, compared with the oracle (amounts and counts exactly, the divisions to 12 digits). */
function expectAmm(got: StoredRow[], want: ExpectedAmm[]): void {
  const rows = parts(got);
  expect(rows.map((r) => r.component)).toEqual(want.map((w) => w.component));
  rows.forEach((r, i) => {
    const w = want[i];
    expect(r.metric).toBe('amm_volume');
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

// ---------------------------------------------------------------------------------------------------------------------
// Rows made by hand
// ---------------------------------------------------------------------------------------------------------------------

interface PoolDef {
  account: string;
  base: Asset;
  counter: Asset;
}

const pool = (account: string, base: Asset, counter: Asset): PoolDef => ({
  account: account.padEnd(33, '0').slice(0, 33),
  base,
  counter,
});

/** The close time of every committed ledger of the hand-made world (unix seconds). */
const CLOSES = new Map<number, number>();

function exchangeRow(
  pair: { base: Asset; counter: Asset },
  ledger: number,
  tx: number,
  baseAmount: string,
  counterAmount: string,
  amm: string,
): ExchangesRow {
  return {
    ...SAMPLE_ROWS[Table.Exchanges],
    base_currency: pair.base.currency,
    base_issuer: pair.base.issuer ?? '',
    counter_currency: pair.counter.currency,
    counter_issuer: pair.counter.issuer ?? '',
    ledger_index: ledger,
    tx_index: tx,
    node_index: 3,
    tx_hash: hash(ledger * 1000 + tx),
    close_time: ledgerClose(ledger),
    base_amount: baseAmount,
    counter_amount: counterAmount,
    base_amount_f: Number(baseAmount),
    counter_amount_f: Number(counterAmount),
    rate: '1',
    rate_f: 1,
    buyer: amm || 'rTakerOfAnOffer0000000000000000',
    seller: amm ? 'rTakerOfASwap00000000000000000000' : 'rMakerOfAnOffer00000000000000000',
    taker: 'rTakerOfASwap00000000000000000000',
    provider: amm || 'rMakerOfAnOffer00000000000000000',
    offer_sequence: amm ? 0 : 77,
    amm_account: amm,
    autobridged_currency: null,
    autobridged_issuer: null,
    tx_type: amm ? 'Payment' : 'OfferCreate',
    client: null,
  };
}

/** Ledgers that are not committed have no `ledgers` row; their swaps still close at a time of their own. */
const UNCOMMITTED = new Map<number, number>();
const ledgerClose = (ledger: number): number => (CLOSES.get(ledger) ?? UNCOMMITTED.get(ledger)) as number;

function stateRow(p: PoolDef, ledger: number, tx: number): AmmPoolStatesRow {
  return {
    ...SAMPLE_ROWS[Table.AmmPoolStates],
    amm_account: p.account,
    ledger_index: ledger,
    tx_index: tx,
    tx_hash: hash(ledger * 1000 + tx),
    close_time: ledgerClose(ledger),
    tx_type: 'Payment',
    base_currency: p.base.currency,
    base_issuer: p.base.issuer ?? '',
    counter_currency: p.counter.currency,
    counter_issuer: p.counter.issuer ?? '',
  };
}

const ledgerRow = (ledger: number): LedgersRow => ({
  ...SAMPLE_ROWS[Table.Ledgers],
  ledger_index: ledger,
  ledger_hash: String(ledger).padStart(64, 'C'),
  close_time: CLOSES.get(ledger) as number,
});

// ---------------------------------------------------------------------------------------------------------------------
// The hand-made world: 2026-03-09 (day 0), 2026-03-10 (day 1: the day under test), the day after it
// ---------------------------------------------------------------------------------------------------------------------

const D0 = Date.UTC(2026, 2, 9) / SEC;
const D1 = D0 + DAY;
const D2 = D1 + DAY;
const D1_KEY = utcDay(D1);

/** Ledgers: 900 on day 0; 1000-1004 on day 1 (1002 closes at exactly 06:00); 1100 and 1101 on day 2 (day 1 is final). */
const LEDGER_CLOSES: Array<[number, number]> = [
  [900, D0 + 10 * HOUR],
  [1000, D1 + HOUR],
  [1001, D1 + 5 * HOUR],
  [1002, D1 + 6 * HOUR],
  [1003, D1 + 12 * HOUR],
  [1004, D1 + 23 * HOUR + 1800],
  [1100, D2 + 1800],
  [1101, D2 + 2 * HOUR],
];
for (const [ledger, close] of LEDGER_CLOSES) CLOSES.set(ledger, close);
// written, but not committed: the ledger above the newest one has no `ledgers` row yet (the ledger writer puts it last), whatever
// the time of its rows says
UNCOMMITTED.set(1102, D2 + 2 * HOUR + 1800);

const P1 = pool('rPoolOne', USD, XRP);
const P2 = pool('rPoolTwo', USD, XRP); // the same pair as P1: its swaps are its own
const P3 = pool('rPoolThree', EUR, USD); // no rate for EUR: through the rate of USD, swapped
const P4 = pool('rPoolFour', GBP, XRP); // no market: the rate of GBP is the pools'
const P4B = pool('rPoolFourB', GBP, XRP);
const P15 = pool('rPoolFifteen', GBP, XRP); // converts to the same amount as P4: the account breaks the tie
const P5 = pool('rPoolFive', GBP, USD); // through the rate of its base GBP, which only the pools give
const P6 = pool('rPoolSix', AAA, BBB); // no rate on either side: dropped
const P7 = pool('rPoolSeven', XRP, ZED); // the native currency is its base: turned round
const P8 = pool('rPoolEight', USD, ZED); // through the rate of its base USD, which a market gives
const P9 = pool('rPoolNine', USD, XRP); // swaps on day 0 only
const P10 = pool('rPoolTen', USD, XRP); // swaps on day 2 only
const P12 = pool('rPoolTwelve', USD, XRP); // native dust only
const P13 = pool('rPoolThirteen', EUR, XRP); // swaps, but nothing in amm_pool_touches says so

/** Swaps of pools, `[pool, ledger, base amount, counter amount]` as stored (the canonical pair of the pool). */
const SWAPS: Array<[PoolDef, number, string, string]> = [
  [P9, 900, '77', '7'],
  [P1, 900, '1000', '1000'],
  [P1, 1000, '100', '50'],
  [P2, 1000, '30', '20'],
  [P3, 1000, '10', '5'],
  [P1, 1001, '20', '10'],
  [P4, 1001, '200', '40'],
  [P7, 1001, '25', '100'],
  [P4B, 1002, '100', '30'],
  [P1, 1002, '1', '0.0005'], // 0.0005 is dust: out
  [P12, 1002, '1', '0.0005'],
  [P5, 1002, '60', '12'],
  [P1, 1003, '1', '0.0006'], // just above the dust: in
  [P8, 1003, '8', '32'],
  [P15, 1003, '200', '40'],
  [P6, 1003, '5', '5'],
  [P3, 1004, '10', '5'],
  [P1, 1100, '500', '500'],
  [P10, 1100, '7', '7'],
  [P1, 1102, '9000', '9000'], // ledger 1102 is above the newest committed ledger (1101): not committed
];
/** Order-book trades of USD/XRP (no pool): they count for the rate of the market, and for no pool. */
const BOOK: Array<[number, string, string]> = [
  [1000, '40', '20'],
  [1003, '60', '30'],
];

interface World {
  exchanges: ExchangesRow[];
  states: AmmPoolStatesRow[];
  touches: AmmPoolTouchesRow[];
  ledgers: LedgersRow[];
}

function handMadeWorld(): World {
  const next = new Map<number, number>();
  const tx = (ledger: number): number => {
    const n = next.get(ledger) ?? 0;
    next.set(ledger, n + 1);
    return n;
  };
  const exchanges: ExchangesRow[] = [];
  const states: AmmPoolStatesRow[] = [];
  const touches: AmmPoolTouchesRow[] = [];
  for (const [p, ledger, base, counter] of SWAPS) {
    const t = tx(ledger);
    exchanges.push(exchangeRow(p, ledger, t, base, counter, p.account));
    states.push(stateRow(p, ledger, t));
    touches.push({ ledger_index: ledger, tx_index: t, amm_account: p.account });
  }
  for (const [ledger, base, counter] of BOOK)
    exchanges.push(exchangeRow(USD_XRP, ledger, tx(ledger), base, counter, ''));
  // a swap of P13 with no touch and no state row: the pools of a window are the ones the touches name
  exchanges.push(exchangeRow(P13, 1001, tx(1001), '999', '999', P13.account));
  return { exchanges, states, touches, ledgers: [...CLOSES.keys()].map(ledgerRow) };
}
const USD_XRP = { base: USD, counter: XRP };

const HAND_MARKETS: MarketsConfig = {
  version: 5,
  tradeMarkets: [{ base: { currency: 'USD', issuer: ISSUER_A }, counter: { currency: 'XRP' } }],
  paymentCurrencies: [],
};

/**
 * The rows the oracle sees: the ones in committed ledgers, in the order they were written, and not the swaps of the pool that
 * no touch names (the pools of a window are the ones the touches say were touched: Ruling R-A18).
 */
const committed = (rows: ExchangesRow[]): ExchangesRow[] =>
  rows.filter((r) => CLOSES.has(r.ledger_index) && r.amm_account !== P13.account);

describe('the amm_volume metric of the volume jobs (e2e)', () => {
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
  async function fresh(): Promise<ClickHouseService> {
    const config = { ...container.config, database: `amm_volume_job_${++dbCounter}` };
    await runMigrations({ config, log: () => undefined });
    const svc = new ClickHouseService(config);
    services.push(svc);
    return svc;
  }

  async function seedHandMade(ch: ClickHouseService): Promise<World> {
    const world = handMadeWorld();
    await ch.insert(Table.Exchanges, world.exchanges);
    await ch.insert(Table.AmmPoolStates, world.states);
    await ch.insert(Table.AmmPoolTouches, world.touches);
    await ch.insert(Table.Ledgers, world.ledgers);
    return world;
  }

  const rates = (ch: ClickHouseService): RatesService => new RatesService(ch, 'XRP');

  // -------------------------------------------------------------------------------------------------------------------
  describe('the pools of the real AMM fixtures', () => {
    const MARKETS: MarketsConfig = {
      version: 3,
      tradeMarkets: [
        // RLUSD, GateHub USD and 666 have order-book trades next to their pools in these ledgers
        { base: { currency: '524C555344000000000000000000000000000000', issuer: ISSUER_A }, counter: XRP },
        { base: { currency: 'USD', issuer: 'rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq' }, counter: XRP },
        { base: { currency: '666', issuer: 'rhvf9fe6PP3GC8Bku2Ug7iQPjPDxYZfrxN' }, counter: XRP },
      ],
      paymentCurrencies: [],
    };
    let ch: ClickHouseService;
    const days = [...new Set(AMM_LEDGERS.map((l) => utcDay(l.header.close_time)))].sort();

    beforeAll(async () => {
      ch = await fresh();
      await new LedgerWriter(ch, ctx).write(AMM_LEDGERS);
    });

    it('the fixtures are as the tests assume: 138 swaps against 97 pools in 11 UTC days, order-book trades beside them', () => {
      const swaps = AMM_EXCHANGES.filter((e) => e.amm_account !== '');
      expect(swaps).toHaveLength(138);
      expect(new Set(swaps.map((e) => e.amm_account)).size).toBe(97);
      expect(days).toHaveLength(11);
      expect(AMM_EXCHANGES.length - swaps.length).toBeGreaterThan(30);
    });

    it.each(days)('the daily set of %s is what the oracle says', async (day) => {
      await computeDailyVolumeSet(ch, rates(ch), MARKETS, 'amm_volume', at(unix(`${day}T00:00:00Z`)));
      const set = await dailySet(ch, day);
      const from = unix(`${day}T00:00:00Z`);
      const want = ammVolumeOracle(MARKETS, AMM_EXCHANGES, from, from + DAY);
      expectAmm(set, want);
      // every row carries the config version of the markets, the sentinel is there once
      expect(new Set(set.map((r) => r.config_version))).toEqual(new Set([MARKETS.version]));
      expect(set.filter((r) => r.component === '')).toHaveLength(1);
    });

    it('most days have components; 2026-06-29 has none, though its pools swapped: no pool of it has a rate on either side', () => {
      const from = (day: string): number => unix(`${day}T00:00:00Z`);
      const counts: Array<[string, number]> = days.map((day) => [
        day,
        ammVolumeOracle(MARKETS, AMM_EXCHANGES, from(day), from(day) + DAY).length,
      ]);
      expect(counts.filter(([, n]) => n === 0)).toEqual([['2026-06-29', 0]]);
      expect(counts.reduce((sum, [, n]) => sum + n, 0)).toBeGreaterThan(50);
      const swapped = AMM_EXCHANGES.filter(
        (e) => e.amm_account !== '' && e.close_time >= from('2026-06-29') && e.close_time < from('2026-06-29') + DAY,
      );
      expect(swapped.length).toBe(20);
    });

    describe.each(['2026-10-17T09:00:00Z', '2026-10-14T12:00:00Z', '2025-02-01T00:00:00Z'])(
      'the live sets at %s',
      (nowText) => {
        const now = at(unix(nowText));
        beforeAll(async () => {
          await computeLiveVolumes(ch, rates(ch), MARKETS, now);
        });

        it.each(TRADE_LIVE_PERIODS)(
          '%s is the window [now - period, now) of the oracle, with its times',
          async (period) => {
            const end = unix(nowText);
            const start = end - LIVE_PERIOD_SECONDS[period];
            const set = await liveSet(ch, period);
            expectAmm(set, ammVolumeOracle(MARKETS, AMM_EXCHANGES, start, end));
            expect(set.every((r) => r.start_time === start && r.end_time === end)).toBe(true);
            expect(set.filter((r) => r.component === '')).toHaveLength(1);
          },
        );
      },
    );

    it('the live sets are not empty where the fixtures have swaps (the comparisons above are not vacuous)', async () => {
      const end = unix('2026-10-17T09:00:00Z');
      await computeLiveVolumes(ch, rates(ch), MARKETS, at(end));
      expect(parts(await liveSet(ch, '30day')).length).toBeGreaterThan(20);
      // the hour from 08:00 holds the swap of the ledger that closed at 08:42:50, and only that
      expect(parts(await liveSet(ch, 'hour')).map((r) => r.component)).toEqual(['rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3']);
      expect(ammVolumeOracle(MARKETS, AMM_EXCHANGES, end - HOUR, end)).toHaveLength(1);
    });

    it('2026-10-16: the RLUSD/XRP pool is a native pool, its amount is its base volume and its converted amount its native volume', async () => {
      const set = parts(await dailySet(ch, '2026-10-16'));
      const rlusd = set.find((r) => r.component === 'rhWTXC2m2gGGA9WozUaoMm6kLAVPb1tcS3') as StoredRow;
      // 179.448166793 + 1 + 543.870850376 of RLUSD for 134 + 0.766153 + 417.277515 XRP, in three swaps
      expect(rlusd).toMatchObject({
        base_currency: '524C555344000000000000000000000000000000',
        base_issuer: ISSUER_A,
        counter_currency: 'XRP',
        counter_issuer: '',
        amount: '724.319017169',
        count: 3,
      });
      expect(rlusd.converted_f).toBeCloseTo(552.043668, 9);
      expect(rlusd.rate_f).toBeCloseTo(724.319017169 / 552.043668, 9);
    });

    it('the fixtures exercise a pool converted through its base, one through its counter, and one without a rate', () => {
      const converted = (day: string) => {
        const from = unix(`${day}T00:00:00Z`);
        return ammVolumeOracle(MARKETS, AMM_EXCHANGES, from, from + DAY);
      };
      const swapsOf = (day: string): ExchangesRow[] =>
        AMM_EXCHANGES.filter(
          (e) =>
            e.amm_account !== '' &&
            e.close_time >= unix(`${day}T00:00:00Z`) &&
            e.close_time < unix(`${day}T00:00:00Z`) + DAY,
        );
      // 2026-10-13: Camel (M1BJ) / PUPPET: Camel has a pool against XRP, so the pool is converted through its base
      const camel = converted('2026-10-13').find(
        (c) => c.component === 'rEYueMLwtvmVqY4r7qVe4RRZBDFcbnG8rq',
      ) as ExpectedAmm;
      expect(camel.base.currency).toBe('2443616D656C546F650000000000000000000000');
      expect(camel.amount.toFixed()).toBe('13022.72607303');
      // 2026-10-16: USDC (rGm7W) / USDC.axl: USDC has no rate, USDC.axl has one: through the counter, swapped
      const axl = converted('2026-10-16').find(
        (c) => c.component === 'rY8kkFFQ9PYwNZnDjWJmsc5im2Xe9mypC',
      ) as ExpectedAmm;
      expect(axl.base.currency).toBe('555344432E61786C000000000000000000000000');
      expect(axl.counter.currency).toBe('5553444300000000000000000000000000000000');
      // 2026-10-16: USDV / WGTS: no rate for either side: dropped, though it swapped
      expect(swapsOf('2026-10-16').some((e) => e.amm_account === 'r9jBi69nTXhrxcZBFSkpa1WnioGt552mky')).toBe(true);
      expect(converted('2026-10-16').some((c) => c.component === 'r9jBi69nTXhrxcZBFSkpa1WnioGt552mky')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a world made by hand', () => {
    let ch: ClickHouseService;
    let world: World;
    const dayWant = (): ExpectedAmm[] => ammVolumeOracle(HAND_MARKETS, committed(world.exchanges), D1, D2);

    beforeAll(async () => {
      ch = await fresh();
      world = await seedHandMade(ch);
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
    });

    it('the day is what the oracle says', async () => {
      expectAmm(await dailySet(ch, D1_KEY), dayWant());
    });

    it('and what was worked out on paper: the order, the amounts, the counts, the converted amounts and the rates', async () => {
      // USD buys 251 / 130.0006 per XRP in the market (the order-book trades and the swaps of the pools of the pair together)
      const usdPerNative = 251 / 130.0006;
      // GBP buys 500 / 110 per XRP in the pools (P4 + P4B + P15 against the native currency)
      const gbpPerNative = 500 / 110;
      const set = parts(await dailySet(ch, D1_KEY));
      const row = (p: PoolDef): StoredRow => set.find((r) => r.component === p.account) as StoredRow;
      expect(set.map((r) => r.component)).toEqual([P1, P15, P4, P4B, P7, P2, P5, P3, P8].map((p) => p.account));

      // P1: three swaps counted (the dust one is out, the one above the dust is in); native counter: its own ratio
      expect(row(P1)).toMatchObject({ amount: '121', count: 3, base_currency: 'USD', counter_currency: 'XRP' });
      close('P1 converted', row(P1).converted_f, 60.0006);
      close('P1 rate', row(P1).rate_f, 121 / 60.0006);
      // not the rate of the market: that one has the order-book trades and the other pools in it
      expect(Math.abs(row(P1).rate_f - usdPerNative)).toBeGreaterThan(0.01);

      // P2: the same pair, its own swap only
      expect(row(P2)).toMatchObject({ amount: '30', count: 1 });
      close('P2 converted', row(P2).converted_f, 20);
      close('P2 rate', row(P2).rate_f, 1.5);

      // P4, P15: the same converted amount, the account orders them; P4B after them
      expect(row(P4)).toMatchObject({ amount: '200', count: 1, base_currency: 'GBP', counter_currency: 'XRP' });
      expect(row(P15)).toMatchObject({ amount: '200', count: 1 });
      expect(row(P15).converted_f).toBe(row(P4).converted_f);
      close('P4 converted', row(P4).converted_f, 40);
      close('P4 rate', row(P4).rate_f, 5);
      close('P4B converted', row(P4B).converted_f, 30);
      close('P4B rate', row(P4B).rate_f, 100 / 30);

      // P7: XRP/ZED, the native currency is the base: turned round, ZED is the base and the amount is the ZED volume
      expect(row(P7)).toMatchObject({
        base_currency: 'ZED',
        base_issuer: ISSUER_D,
        counter_currency: 'XRP',
        counter_issuer: '',
        amount: '100',
        count: 1,
      });
      close('P7 converted', row(P7).converted_f, 25);
      close('P7 rate', row(P7).rate_f, 4);

      // P5: GBP/USD through the rate of GBP, which only the pools give: 60 / (500/110)
      expect(row(P5)).toMatchObject({ amount: '60', count: 1, base_currency: 'GBP', counter_currency: 'USD' });
      close('P5 converted', row(P5).converted_f, 60 / gbpPerNative);
      close('P5 rate', row(P5).rate_f, gbpPerNative);

      // P3: EUR/USD: EUR has no rate, USD has the market's: swapped, the amount is the USD volume (two swaps of 5)
      expect(row(P3)).toMatchObject({
        amount: '10',
        count: 2,
        base_currency: 'USD',
        counter_currency: 'EUR',
      });
      close('P3 converted', row(P3).converted_f, 10 / usdPerNative);
      close('P3 rate', row(P3).rate_f, usdPerNative);

      // P8: USD/ZED through the rate of USD (the market's), not the pools': 8 / (251 / 130.0006)
      expect(row(P8)).toMatchObject({ amount: '8', count: 1, base_currency: 'USD', counter_currency: 'ZED' });
      close('P8 converted', row(P8).converted_f, 8 / usdPerNative);
      close('P8 rate', row(P8).rate_f, usdPerNative);
    });

    it('a pool without a rate on either side (P6), a pool with dust only (P12), swaps of other days (P9, P10), swaps with no touch (P13) are not there', async () => {
      const accounts = (await dailySet(ch, D1_KEY)).map((r) => r.component);
      for (const p of [P6, P12, P9, P10, P13]) expect(accounts).not.toContain(p.account);
      expect(accounts).toContain('');
    });

    it('the swaps of day 0 and day 2 do not count: P1 holds three swaps of day 1, not the 1000 of day 0, the 500 of day 2 or the 9000 above the head', async () => {
      const p1 = (await dailySet(ch, D1_KEY)).find((r) => r.component === P1.account) as StoredRow;
      expect(p1.amount).toBe('121');
    });

    it('the counts of the components are the swaps of the pools that were listed: the pool without a rate is in no count', async () => {
      const set = await dailySet(ch, D1_KEY);
      const listed = parts(set);
      expect(listed.reduce((n, r) => n + r.count, 0)).toBe(3 + 1 + 1 + 1 + 1 + 1 + 1 + 2 + 1);
      expect(set.find((r) => r.component === '')).toMatchObject({ count: 0, amount: '0', converted_f: 0 });
    });

    it('a swap against an offer in the same pair (amm_account empty) counts for the market rate and for no pool', async () => {
      const set = parts(await dailySet(ch, D1_KEY));
      expect(set.every((r) => r.component !== '' && r.component.startsWith('rPool'))).toBe(true);
      // without the order-book trades the rate of USD would be 151/80.0006 and P8 would convert to something else
      const withoutBook = ammVolumeOracle(
        HAND_MARKETS,
        committed(world.exchanges).filter((r) => r.amm_account !== ''),
        D1,
        D2,
      );
      const p8 = (list: { component: string; converted: BigNumber }[]) =>
        list.find((c) => c.component === P8.account)?.converted.toNumber() as number;
      expect(p8(withoutBook)).not.toBeCloseTo(p8(dayWant()), 6);
    });

    describe('the live windows', () => {
      const live = async (period: LivePeriod, now: number): Promise<StoredRow[]> => {
        await computeLiveVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', period, at(now));
        return liveSet(ch, period);
      };

      it('hour: a ledger that closed exactly at the start is in, one that closed exactly at the end is out', async () => {
        // [05:00, 06:00): ledger 1001 closed at 05:00:00, ledger 1002 at 06:00:00
        const set = await live('hour', D1 + 6 * HOUR);
        expectAmm(set, ammVolumeOracle(HAND_MARKETS, committed(world.exchanges), D1 + 5 * HOUR, D1 + 6 * HOUR));
        // 40, 25 and 10 XRP: GBP/XRP, the turned-round XRP/ZED, USD/XRP
        expect(parts(set).map((r) => r.component)).toEqual([P4.account, P7.account, P1.account]);
      });

      it.each([
        ['day', D1 + 13 * HOUR],
        ['3day', D2 + 3 * HOUR],
        ['7day', D2 + 5 * HOUR],
        ['30day', D2 + 5 * HOUR],
        ['hour', D2 + 3 * HOUR],
        ['day', D0 + 11 * HOUR],
      ])('%s at %s is the oracle over its window', async (period, now) => {
        const set = await live(period as LivePeriod, now);
        const end = now;
        expectAmm(
          set,
          ammVolumeOracle(
            HAND_MARKETS,
            committed(world.exchanges),
            end - LIVE_PERIOD_SECONDS[period as LivePeriod],
            end,
          ),
        );
      });

      it('a window that reaches past the newest committed ledger reads no further: the swap of the uncommitted ledger 1102 is not in', async () => {
        // 1102 closed at 02:30 of day 2 and is inside [day 1 + 3h, day 2 + 3h), but the newest ledger is 1101 (02:00), and a row
        // above it may belong to a ledger whose other rows are not in yet: P1 holds 20 (1001), 1 (1003) and 500 (1100)
        const set = await live('day', D2 + 3 * HOUR);
        const p1 = set.find((r) => r.component === P1.account) as StoredRow;
        expect(p1).toMatchObject({ amount: '521', count: 3 });
      });
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('the sets', () => {
    let ch: ClickHouseService;

    beforeEach(async () => {
      ch = await fresh();
      await seedHandMade(ch);
    });

    it('a daily set is the sentinel and the components under one version, in one insert, with the config version', async () => {
      const written = await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
      expect(written).toBe(9);
      const rows = await ch.query<{ version: string; config_version: number; n: string }>(
        `SELECT toUInt64(version) AS version, config_version, count() AS n FROM ${Table.VolumeDaily}
          WHERE metric = 'amm_volume' GROUP BY version, config_version`,
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].n)).toBe(10);
      expect(rows[0].config_version).toBe(5);
      expect(Number(rows[0].version)).toBeGreaterThan(Date.now() - 60_000);
    });

    it('the day is final once the newest ledger closed an hour after it, and volumeDaysDone counts exactly those', async () => {
      // the newest ledger of the world, 1101, closed at 02:00 of day 2: more than the settle time past day 1
      expect(VOLUME_DAY_SETTLE_MS).toBe(HOUR * SEC);
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D2));
      const sentinel = async (day: string) => (await dailySet(ch, day)).find((r) => r.component === '') as StoredRow;
      expect((await sentinel(D1_KEY)).rate_f).toBe(1);
      expect((await sentinel(utcDay(D2))).rate_f).toBe(0);
      expect(await volumeDaysDone(ch, 'amm_volume', at(D0), at(D2 + DAY), 5)).toEqual(new Set([D1_KEY]));
      expect(await volumeDaysDone(ch, 'amm_volume', at(D0), at(D2 + DAY), 6)).toEqual(new Set());
      // the other metrics of the day are not computed: nothing of them is done
      expect(await volumeDaysDone(ch, 'trade_volume', at(D0), at(D2 + DAY), 5)).toEqual(new Set());
    });

    it('a pool that no longer has volume leaves the newest version: only the pools of the set are shown', async () => {
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
      const before = parts(await dailySet(ch, D1_KEY)).map((r) => r.component);
      expect(before).toContain(P2.account);
      // the swap of P2 is re-ingested away
      await ch.command(
        `ALTER TABLE ${Table.Exchanges} DELETE WHERE amm_account = {a:String}`,
        { a: P2.account },
        { settings: { mutations_sync: '2' } },
      );
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
      const after = parts(await dailySet(ch, D1_KEY)).map((r) => r.component);
      expect(after).not.toContain(P2.account);
      expect(after).toHaveLength(before.length - 1);
    });

    it('a live set has its window times on every row, and a sentinel when the window holds no swap', async () => {
      // a day without any ledger: only the sentinel
      await computeLiveVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', 'day', at(unix('2030-01-01T00:00:00Z')));
      const set = await liveSet(ch, 'day');
      expect(set).toHaveLength(1);
      expect(set[0]).toMatchObject({
        component: '',
        count: 0,
        amount: '0',
        converted_f: 0,
        start_time: unix('2030-01-01T00:00:00Z') - DAY,
        end_time: unix('2030-01-01T00:00:00Z'),
        config_version: 5,
      });
      // a window with ledgers but no swap of a pool: the same
      await computeLiveVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', 'hour', at(D2 + 2 * HOUR + 600));
      expect(await liveSet(ch, 'hour')).toHaveLength(1);
    });

    it('amm_volume has the live periods of the trade volume, and no other', async () => {
      expect(TRADE_LIVE_PERIODS).toEqual(['hour', 'day', '3day', '7day', '30day']);
      await computeLiveVolumes(ch, rates(ch), HAND_MARKETS, at(D1 + 13 * HOUR));
      const periods = await ch.query<{ period: string }>(
        `SELECT DISTINCT period FROM ${Table.VolumeLive} WHERE metric = 'amm_volume' ORDER BY period`,
      );
      expect(periods.map((p) => p.period)).toEqual(['30day', '3day', '7day', 'day', 'hour']);
      const metrics = await ch.query<{ metric: string }>(
        `SELECT DISTINCT metric FROM ${Table.VolumeLive} ORDER BY metric`,
      );
      expect(metrics.map((m) => m.metric)).toEqual(['amm_volume', 'payment_volume', 'trade_volume']);
    });

    it('an aborted signal writes nothing and throws VolumeRecomputeAborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1), { signal: controller.signal }),
      ).rejects.toThrow(VolumeRecomputeAborted);
      const [row] = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.VolumeDaily}`);
      expect(Number(row.n)).toBe(0);
    });

    it('a signal aborted while the set is read writes nothing: the check is made again right before the insert', async () => {
      const controller = new AbortController();
      const real = ch.query.bind(ch);
      const spy = jest.spyOn(ch, 'query').mockImplementation(async (sql, params, settings) => {
        const rows = await real(sql, params, settings);
        // the last read of the set is the version of the day
        if (String(sql).includes(`FROM ${Table.VolumeDaily}`)) controller.abort();
        return rows;
      });
      await expect(
        computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1), { signal: controller.signal }),
      ).rejects.toThrow(VolumeRecomputeAborted);
      spy.mockRestore();
      const [row] = await ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.VolumeDaily}`);
      expect(Number(row.n)).toBe(0);
    });

    it('a database without a pool (Xahau has none) gives the sentinel only, and reads no exchange at all, markets or not', async () => {
      const other = await fresh();
      await other.insert(Table.Ledgers, [...CLOSES.keys()].map(ledgerRow));
      const xah = new RatesService(other, 'XAH');
      // a market that has trades to read: the trade volume would read the exchanges for it
      const markets: MarketsConfig = {
        version: 3,
        tradeMarkets: [{ base: { currency: 'USD', issuer: ISSUER_A }, counter: { currency: 'XAH' } }],
        paymentCurrencies: [],
      };
      const spy = jest.spyOn(other, 'query');
      await computeDailyVolumeSet(other, xah, markets, 'amm_volume', at(D1));
      await computeLiveVolumeSet(other, xah, markets, 'amm_volume', 'day', at(D1 + 13 * HOUR));
      const exchangeReads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.Exchanges}`));
      spy.mockRestore();
      expect(exchangeReads).toHaveLength(0);
      expect(await dailySet(other, D1_KEY)).toHaveLength(1);
      expect(await liveSet(other, 'day')).toHaveLength(1);
      expect((await dailySet(other, D1_KEY))[0]).toMatchObject({ component: '', count: 0, config_version: 3 });
    });

    it('the SQL binds every value, names tables from the Table enum, and uses no FINAL', async () => {
      const spy = jest.spyOn(ch, 'query');
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
      const sqls = spy.mock.calls.map(([sql]) => String(sql));
      spy.mockRestore();
      for (const sql of [AMM_TOUCHED_POOLS_SQL, AMM_POOL_PAIRS_SQL, AMM_POOL_SUMS_SQL]) {
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(sql).not.toMatch(/\b(1000|1004|rPool|USD)\b/);
        expect(sql).toMatch(/\{[a-z_0-9]+:[A-Za-z0-9()]+\}/);
        expect(sqls).toContain(sql);
      }
      expect(AMM_TOUCHED_POOLS_SQL).toContain(Table.AmmPoolTouches);
      expect(AMM_POOL_PAIRS_SQL).toContain(Table.AmmPoolStates);
      expect(AMM_POOL_SUMS_SQL).toContain(Table.Exchanges);
    });

    it('a swap row written twice (a real duplicate) counts once, in the pairs, the touches and the swaps', async () => {
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
      const first = await dailySet(ch, D1_KEY);
      const strip = (list: StoredRow[]) => list.map(({ version: _version, ...rest }) => rest);
      const rows = async (table: Table): Promise<number> =>
        Number((await ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0].n);
      const before = [await rows(Table.Exchanges), await rows(Table.AmmPoolStates), await rows(Table.AmmPoolTouches)];
      const database = (await ch.query<{ db: string }>('SELECT currentDatabase() AS db'))[0].db;
      for (const table of [Table.Exchanges, Table.AmmPoolStates, Table.AmmPoolTouches]) {
        await ch.command(`SYSTEM STOP MERGES ${database}.${table}`);
        await ch.command(`INSERT INTO ${table} SELECT * FROM ${table}`, {}, { settings: { insert_deduplicate: 0 } });
      }
      expect([await rows(Table.Exchanges), await rows(Table.AmmPoolStates), await rows(Table.AmmPoolTouches)]).toEqual(
        before.map((n) => 2 * n),
      );
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
      expect(strip(await dailySet(ch, D1_KEY))).toEqual(strip(first));
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('pools are read in chunks of AMM_CHUNK', () => {
    const POOLS = 450;
    let ch: ClickHouseService;
    const chunkPool = (n: number): PoolDef =>
      pool(
        `rChunkPool${String(n).padStart(4, '0')}`,
        { currency: `Q${String(n).padStart(3, '0')}`, issuer: ISSUER_A },
        XRP,
      );

    beforeAll(async () => {
      ch = await fresh();
      await ch.insert(Table.Ledgers, [...CLOSES.keys()].map(ledgerRow));
      // 450 pools of 450 pairs, one swap each in the ledgers of day 1: 2 of the asset for 1 XRP (a native pool, converted to 1)
      const pools = Array.from({ length: POOLS }, (_, n) => chunkPool(n));
      const ledgerOf = (n: number): number => 1000 + (n % 4);
      await ch.insert(
        Table.Exchanges,
        pools.map((p, n) => exchangeRow(p, ledgerOf(n), n, '2', '1', p.account)),
      );
      await ch.insert(
        Table.AmmPoolStates,
        pools.map((p, n) => stateRow(p, ledgerOf(n), n)),
      );
      await ch.insert(
        Table.AmmPoolTouches,
        pools.map((p, n) => ({ ledger_index: ledgerOf(n), tx_index: n, amm_account: p.account })),
      );
    });

    it('450 pools are three chunks of 200, 200 and 50 pools: three reads of the pairs and three of the swaps', async () => {
      expect(AMM_CHUNK).toBe(200);
      const spy = jest.spyOn(ch, 'query');
      const volumes = await ammPoolVolumes(ch, { min: 1000, max: 1004 });
      const calls = spy.mock.calls;
      spy.mockRestore();
      const lengths = (sql: string): number[] =>
        calls.filter(([q]) => q === sql).map(([, p]) => ((p as { accounts: string[] }).accounts ?? []).length);
      expect(calls.filter(([q]) => q === AMM_TOUCHED_POOLS_SQL)).toHaveLength(1);
      expect(lengths(AMM_POOL_PAIRS_SQL)).toEqual([200, 200, 50]);
      expect(lengths(AMM_POOL_SUMS_SQL)).toEqual([200, 200, 50]);
      expect(volumes).toHaveLength(POOLS);
      expect(volumes.every((v) => v.count === 1 && v.baseVolume.eq(2) && v.counterVolume.eq(1))).toBe(true);
      expect(new Set(volumes.map((v) => v.account)).size).toBe(POOLS);
      // in the order of the accounts, whatever order the groups came in
      expect(volumes.map((v) => v.account)).toEqual(volumes.map((v) => v.account).sort());
      // each pool carries its own pair
      const v = volumes.find((x) => x.account === chunkPool(123).account) as (typeof volumes)[number];
      expect(assetKey(v.base)).toBe(`Q123.${ISSUER_A}`);
      expect(assetKey(v.counter)).toBe('XRP');
    });

    it('the set of the day lists the 450 pools, each converted to its native volume', async () => {
      await computeDailyVolumeSet(
        ch,
        rates(ch),
        { version: 1, tradeMarkets: [], paymentCurrencies: [] },
        'amm_volume',
        at(D1),
      );
      const set = await dailySet(ch, D1_KEY);
      expect(set).toHaveLength(POOLS + 1);
      expect(parts(set).every((r) => r.count === 1 && r.converted_f === 1 && r.rate_f === 2)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('a rate of 0 is no rate', () => {
    // 1 XRP swapped for 0 ZRO (a rate of 0 units of ZRO a coin): the pool is a native pool, converted to its native volume; no
    // other pool is converted through that rate (it would divide by 0). ZZZ against XRP has a real rate.
    const Z1 = pool('rPoolZeroNative', XRP, ZRO);
    const Z2 = pool('rPoolZeroCounter', AAA, ZRO); // AAA has no rate and the rate of ZRO is 0: dropped
    const Z3 = pool('rPoolZeroBase', ZRO, ZZZ); // the rate of ZRO is 0: through the rate of ZZZ, swapped
    const Z4 = pool('rPoolRated', XRP, ZZZ);
    const NO_MARKETS: MarketsConfig = { version: 1, tradeMarkets: [], paymentCurrencies: [] };
    const swaps: Array<[PoolDef, string, string]> = [
      [Z1, '1', '0'],
      [Z2, '3', '4'],
      [Z3, '7', '6'],
      [Z4, '5', '10'],
    ];
    const rows = (): ExchangesRow[] =>
      swaps.map(([p, base, counter], i) => exchangeRow(p, 1000, i, base, counter, p.account));

    it('is not used to convert a pool, on either side', async () => {
      const ch = await fresh();
      await ch.insert(Table.Ledgers, [...CLOSES.keys()].map(ledgerRow));
      await ch.insert(Table.Exchanges, rows());
      await ch.insert(
        Table.AmmPoolStates,
        swaps.map(([p], i) => stateRow(p, 1000, i)),
      );
      await ch.insert(
        Table.AmmPoolTouches,
        swaps.map(([p], i) => ({ ledger_index: 1000, tx_index: i, amm_account: p.account })),
      );
      await computeDailyVolumeSet(ch, rates(ch), NO_MARKETS, 'amm_volume', at(D1));
      const set = parts(await dailySet(ch, D1_KEY));
      expect(set.map((r) => r.component)).toEqual([Z4.account, Z3.account, Z1.account]);
      // XRP/ZZZ: 5 XRP for 10 ZZZ, turned round: the amount is the 10 ZZZ, a rate of 2
      expect(set[0]).toMatchObject({
        base_currency: 'ZZZ',
        counter_currency: 'XRP',
        amount: '10',
        count: 1,
        converted_f: 5,
        rate_f: 2,
      });
      // ZRO/ZZZ: 7 ZRO for 6 ZZZ, through the rate of ZZZ (ZRO has none): the amount is the 6 ZZZ, converted 3
      expect(set[1]).toMatchObject({
        base_currency: 'ZZZ',
        counter_currency: 'ZRO',
        amount: '6',
        converted_f: 3,
        rate_f: 2,
      });
      // XRP/ZRO: 1 XRP for nothing of ZRO
      expect(set[2]).toMatchObject({
        base_currency: 'ZRO',
        counter_currency: 'XRP',
        amount: '0',
        count: 1,
        converted_f: 1,
        rate_f: 0,
      });
      expectAmm(await dailySet(ch, D1_KEY), ammVolumeOracle(NO_MARKETS, rows(), D1, D2));
    });
  });

  // -------------------------------------------------------------------------------------------------------------------
  describe('no read crosses the pairs (Ruling R-A3), on tables of several parts', () => {
    const PAIRS = 5;
    const PER_PAIR = 60_000;
    const OTHER_POOLS = 200_000;
    const GRANULE = 8192;
    let ch: ClickHouseService;

    const totalRows = async (table: Table): Promise<number> =>
      Number((await ch.queryOne<{ n: string }>(`SELECT count() AS n FROM ${table}`))?.n);

    /** What `system.query_log` says the SELECTs on a table read while `run` ran. */
    async function readsOf(
      table: Table,
      run: () => Promise<unknown>,
    ): Promise<Array<{ query: string; read_rows: number }>> {
      const [{ t }] = await ch.query<{ t: string }>('SELECT now64(6) AS t');
      await run();
      await ch.command('SYSTEM FLUSH LOGS');
      const db = ((await ch.queryOne<{ db: string }>('SELECT currentDatabase() AS db')) as { db: string }).db;
      const rows = await ch.query<{ query: string; read_rows: string }>(
        `SELECT query, read_rows FROM system.query_log
          WHERE current_database = {db:String} AND type = 'QueryFinish' AND query_kind = 'Select'
            AND query_start_time_microseconds >= {t:DateTime64(6)} AND has(tables, {table:String})
          ORDER BY query_start_time_microseconds`,
        { db, t, table: `${db}.${table}` },
      );
      return rows.map((x) => ({ query: x.query, read_rows: Number(x.read_rows) }));
    }

    const explain = async (sql: string, params: Record<string, unknown>): Promise<string[]> =>
      (await ch.query<{ explain: string }>(`EXPLAIN indexes = 1 ${sql}`, params)).map((x) => x.explain.trim());

    /** The `Granules: a/b` of the stage that starts at the line `at`. */
    function granules(lines: string[], from: number): [number, number] {
      const line = lines.slice(from).find((l) => l.startsWith('Granules:')) as string;
      const [a, b] = line.slice('Granules:'.length).trim().split('/');
      return [Number(a), Number(b)];
    }

    const condition = (lines: string[]): string => {
      const key = lines.indexOf('PrimaryKey');
      expect(key).toBeGreaterThan(-1);
      return lines.slice(key).find((l) => l.startsWith('Condition:')) as string;
    };

    /** The parameters of the reads of the hand-made world: the pairs of its pools, its pools, the ledgers of day 1. */
    const sumParams = (): Record<string, unknown> => ({
      accounts: [P1.account, P4.account],
      base_currencies: ['USD', 'GBP'],
      base_issuers: [ISSUER_A, ISSUER_C],
      counter_currencies: ['XRP', 'XRP'],
      counter_issuers: ['', ''],
      first: 1000,
      last: 1004,
    });

    beforeAll(async () => {
      ch = await fresh();
      await seedHandMade(ch);
      for (const table of [Table.Exchanges, Table.AmmPoolStates, Table.AmmPoolTouches]) {
        await ch.command(`SYSTEM STOP MERGES ${table}`);
      }
      // other pairs: a part each, in the ledgers of the day under test (1000..1004), swaps of pools of their own
      for (let pair = 0; pair < PAIRS; pair++) {
        await ch.command(
          `INSERT INTO ${Table.Exchanges}
           SELECT tpl.* REPLACE (
                    concat('B', toString({pair:UInt32})) AS base_currency,
                    toUInt32(1000 + n.number % 4) AS ledger_index,
                    toUInt32(intDiv(n.number, 4) + 100) AS tx_index,
                    concat('rOtherPool', leftPad(toString(n.number % 100), 3, '0')) AS amm_account
                  )
             FROM (SELECT * FROM ${Table.Exchanges} WHERE amm_account = {pool:String} LIMIT 1) AS tpl
            CROSS JOIN numbers({rows:UInt32}) AS n`,
          { pair, pool: P1.account, rows: PER_PAIR },
          { settings: { insert_deduplicate: 0 } },
        );
      }
      // other pools: states in the very ledgers of the window (the ledger range cannot tell them from the pools' own, only the
      // key of the pool can), and touches far from the day (a range of the primary key of the touches)
      await ch.command(
        `INSERT INTO ${Table.AmmPoolStates}
         SELECT tpl.* REPLACE (
                  concat('rOtherPool', leftPad(toString(n.number % 100), 3, '0')) AS amm_account,
                  toUInt32(1000 + n.number % 5) AS ledger_index,
                  toUInt32(intDiv(n.number, 5)) AS tx_index
                )
           FROM (SELECT * FROM ${Table.AmmPoolStates} WHERE amm_account = {pool:String} LIMIT 1) AS tpl
          CROSS JOIN numbers({rows:UInt32}) AS n`,
        { pool: P1.account, rows: OTHER_POOLS },
        { settings: { insert_deduplicate: 0 } },
      );
      await ch.command(
        `INSERT INTO ${Table.AmmPoolTouches}
         SELECT toUInt32(2000 + intDiv(n.number, 100)) AS ledger_index, toUInt32(n.number % 100) AS tx_index,
                concat('rOtherPool', leftPad(toString(n.number % 100), 3, '0')) AS amm_account
           FROM numbers({rows:UInt32}) AS n`,
        { rows: OTHER_POOLS },
        { settings: { insert_deduplicate: 0 } },
      );
    });

    it('the exchanges are several parts of other pairs with the swaps of the day among them', async () => {
      const parts = await ch.query<{ rows: string }>(
        `SELECT rows FROM system.parts WHERE database = currentDatabase() AND table = {t:String} AND active`,
        { t: Table.Exchanges },
      );
      expect(parts.length).toBeGreaterThanOrEqual(PAIRS + 1);
      expect(await totalRows(Table.Exchanges)).toBeGreaterThan(PAIRS * PER_PAIR);
      expect(await totalRows(Table.AmmPoolStates)).toBeGreaterThan(OTHER_POOLS);
      expect(await totalRows(Table.AmmPoolTouches)).toBeGreaterThan(OTHER_POOLS);
    });

    it('EXPLAIN: the swaps are read through the pair key and the ledger range, a few granules of the table', async () => {
      const lines = await explain(AMM_POOL_SUMS_SQL, sumParams());
      const cond = condition(lines);
      for (const column of ['base_currency', 'base_issuer', 'counter_currency', 'counter_issuer', 'ledger_index']) {
        expect(cond).toContain(column);
      }
      const [selected, total] = granules(lines, lines.indexOf('PrimaryKey'));
      expect(total).toBeGreaterThan(30);
      expect(selected).toBeLessThanOrEqual(4);
      // and the skip index on amm_account is there for the granules of other pools of a pair
      expect(lines).toContain('Name: amm_account_set');
    });

    it('EXPLAIN: the pools of the window are a range of the primary key of the touches', async () => {
      const lines = await explain(AMM_TOUCHED_POOLS_SQL, { first: 1000, last: 1004 });
      expect(condition(lines)).toContain('ledger_index');
      const [selected] = granules(lines, lines.indexOf('PrimaryKey'));
      expect(selected).toBeLessThanOrEqual(2);
    });

    it('EXPLAIN: the pair of a pool is read by the pool key (a prefix of the primary key of the states) and the ledger range', async () => {
      const lines = await explain(AMM_POOL_PAIRS_SQL, { accounts: [P1.account, P4.account], first: 1000, last: 1004 });
      const cond = condition(lines);
      expect(cond).toContain('amm_account');
      expect(cond).toContain('ledger_index');
      const [selected, total] = granules(lines, lines.indexOf('PrimaryKey'));
      expect(total).toBeGreaterThan(20);
      expect(selected).toBeLessThanOrEqual(2);
    });

    it('read_rows: the swaps of the pools cost the granules of their own pairs, not the table (control: the range alone)', async () => {
      const reads = await readsOf(Table.Exchanges, () =>
        computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1)),
      );
      // the swaps of the pools, and the read of the configured market for its rate: both by the pair key
      expect(reads.length).toBeGreaterThanOrEqual(1);
      expect(reads.length).toBeLessThanOrEqual(2);
      for (const read of reads) expect(read.read_rows).toBeLessThanOrEqual(2 * GRANULE);
      const control = await readsOf(Table.Exchanges, () =>
        ch.query(
          `SELECT max(length(tx_hash)) FROM ${Table.Exchanges} WHERE ledger_index BETWEEN {first:UInt32} AND {last:UInt32}`,
          sumParams(),
        ),
      );
      expect(control[0].read_rows).toBeGreaterThan(PAIRS * PER_PAIR);
    });

    it('read_rows: without the skip index the pair key alone still bounds the swaps to the pairs', async () => {
      const reads = await readsOf(Table.Exchanges, () =>
        ch.query(AMM_POOL_SUMS_SQL, sumParams(), { use_skip_indexes: 0 }),
      );
      expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('read_rows: the pools of the window are a range of the touches, not the 200,000 touches of other pools', async () => {
      const reads = await readsOf(Table.AmmPoolTouches, () =>
        computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1)),
      );
      expect(reads).toHaveLength(1);
      expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('read_rows: the pairs of the pools are their own state rows, not the 200,000 rows of other pools', async () => {
      const reads = await readsOf(Table.AmmPoolStates, () =>
        computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1)),
      );
      expect(reads).toHaveLength(1);
      expect(reads[0].read_rows).toBeLessThanOrEqual(2 * GRANULE);
    });

    it('still gives the right pools: the other pairs and pools add nothing to the day', async () => {
      await computeDailyVolumeSet(ch, rates(ch), HAND_MARKETS, 'amm_volume', at(D1));
      const world = handMadeWorld();
      expectAmm(
        await dailySet(ch, D1_KEY),
        ammVolumeOracle(
          HAND_MARKETS,
          world.exchanges.filter((r) => CLOSES.has(r.ledger_index) && r.amm_account !== P13.account),
          D1,
          D2,
        ),
      );
    });
  });
});
