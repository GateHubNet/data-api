import { AMM_PARSER_VERSION, computeMarketsSet, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { SAMPLE_ROWS } from '../../../packages/shared/test/sample-rows';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import {
  HandPair,
  handSet,
  MARKETS_ISSUER,
  MARKETS_ISSUER2,
  MARKETS_NOW,
  seedLiveRate,
  seedMarketsWorld,
} from './support/markets-world';
import { explain } from './support/plans';

/**
 * `GET /v2/network/markets` on a real ClickHouse.
 *
 * The first suite runs on the world of `support/markets-world.ts` (read its header for the trades: every number below is
 * worked out from them), with the hour sets and the markets sets of the three periods and the three filters written by the jobs
 * of the syncer at 2020-07-02T10:42:17Z. The world is an order-book world (no swap): its `exclude` set is its `include` set,
 * its `only` set is empty, and the AMM fields are the ones of a window that was parsed with AMM and has no swap, "0.0000" and
 * false. Decoys sit next to the real sets in `markets_live`: an older version of the set of each period and filter, with other
 * numbers and a pair that is gone. A reader that took a wrong version or filter would serve them.
 * The second suite writes sets by hand into an empty database (no set yet, the limits, the AMM fields that are NULL), the third
 * is the world on Xahau, the fourth a world with swaps and a pool (`seedMarketsWorld(..., { amm: true })`: read its header for
 * the numbers), and the fifth the same world with one ledger of an old parser in the window, so that the job writes no AMM field.
 *
 * The periods, at that `now` (t = 10:42:17 today, the day of the sparkline's last entry, 2020-07-02):
 *  - day: from 2020-07-01T10:00:00Z; 11 pairs traded, 112 trades, 243.5 of native volume;
 *  - 7day: from 2020-06-25T10:00:00Z; 11 pairs, 137 trades, 348.4;
 *  - 30day: from 2020-06-02T10:00:00Z; 12 pairs (JPY/XRP traded only in the 30 days), 177 trades, 500.4.
 * USD and ZZZ are worth 2 per native coin in every period; EUR, GBP and BTC have no rate.
 */

const I = MARKETS_ISSUER;
const I2 = MARKETS_ISSUER2;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const p8 = (v: BigNumber.Value): string => new BigNumber(v).toPrecision(8);

/** The 7 days of every sparkline: those that end with the day of `MARKETS_NOW`. */
const SPARK_DAYS = ['06-26', '06-27', '06-28', '06-29', '06-30', '07-01', '07-02'].map((d) => `2020-${d}T00:00:00Z`);
const spark = (closes: (string | null)[]): Json[] =>
  closes.map((close, i) => ({ date: SPARK_DAYS[i], ...(close !== null && { close: p8(close) }) }));

/** What a market has to be, in the numbers of the world. */
interface Want {
  count: number;
  baseVolume: string;
  counterVolume: string;
  /** None for a pair that has no native volume. */
  native?: string;
  open: string;
  high: string;
  low: string;
  last: string;
  change: string;
  openTime: string;
  lastTime: string;
  closes: (string | null)[];
  /** The AMM share and the pool flag; "0.0000" and false (a window without a swap) when missing, left out when `null`. */
  ammShare?: string | null;
  ammPool?: boolean | null;
}

/** The market of the answer, keys in order. `base` and `counter` as `CUR` or `CUR+issuer`. */
function market(base: string, counter: string, w: Want): Json {
  const [baseCurrency, baseIssuer] = base.split('+');
  const [counterCurrency, counterIssuer] = counter.split('+');
  const ammShare = w.ammShare === undefined ? '0.0000' : w.ammShare;
  const ammPool = w.ammPool === undefined ? false : w.ammPool;
  return {
    base_currency: baseCurrency,
    ...(baseIssuer && { base_issuer: baseIssuer }),
    counter_currency: counterCurrency,
    ...(counterIssuer && { counter_issuer: counterIssuer }),
    count: w.count,
    base_volume: w.baseVolume,
    counter_volume: w.counterVolume,
    ...(w.native !== undefined && { native_volume: w.native }),
    open: p8(w.open),
    high: p8(w.high),
    low: p8(w.low),
    last: p8(w.last),
    change: w.change,
    open_time: w.openTime,
    last_time: w.lastTime,
    ...(ammShare !== null && { amm_share: ammShare }),
    ...(ammPool !== null && { amm_pool: ammPool }),
    sparkline: spark(w.closes),
  };
}

/** The same market with `converted_volume` after `native_volume`. */
const withConverted = (m: Json, converted: string): Json =>
  Object.fromEntries(
    Object.entries(m).flatMap(([key, value]) =>
      key === 'native_volume'
        ? [
            [key, value],
            ['converted_volume', converted],
          ]
        : [[key, value]],
    ),
  );

const NONE = [null, null, null, null, null, null];

/** The markets of the day window, by name (`N` is the native currency `n`). */
function dayMarkets(n: string): Record<string, Json> {
  return {
    'USD/N': market(`USD+${I}`, n, {
      count: 13,
      baseVolume: '130',
      counterVolume: '65',
      native: '65',
      open: '0.5',
      high: '0.8',
      low: '0.3',
      last: '0.4',
      change: '-20.00',
      openTime: '2020-07-01T12:00:00Z',
      lastTime: '2020-07-02T10:42:17Z',
      closes: [null, null, '0.525', '0.525', '0.525', '0.5', '0.4'],
    }),
    'USD/ZZZ': market(`USD+${I}`, `ZZZ+${I}`, {
      count: 12,
      baseVolume: '120',
      counterVolume: '240',
      native: '60',
      open: '2',
      high: '2',
      low: '2',
      last: '2',
      change: '0.00',
      openTime: '2020-07-02T04:00:00Z',
      lastTime: '2020-07-02T04:11:00Z',
      closes: [null, '2', '2', '2', '2', '2', '2'],
    }),
    'N/ZZZ': market(n, `ZZZ+${I}`, {
      count: 11,
      baseVolume: '55',
      counterVolume: '110',
      native: '55',
      open: '2',
      high: '2',
      low: '2',
      last: '2',
      change: '0.00',
      openTime: '2020-07-02T03:00:00Z',
      lastTime: '2020-07-02T03:10:00Z',
      closes: [...NONE, '2'],
    }),
    'EUR/USD': market(`EUR+${I}`, `USD+${I}`, {
      count: 10,
      baseVolume: '40',
      counterVolume: '50',
      native: '25',
      open: '1.25',
      high: '1.25',
      low: '1.25',
      last: '1.25',
      change: '0.00',
      openTime: '2020-07-02T05:00:00Z',
      lastTime: '2020-07-02T05:09:00Z',
      closes: [null, null, null, '1.25', '1.25', '1.25', '1.25'],
    }),
    'CHF/N': market(`CHF+${I}`, n, {
      count: 9,
      baseVolume: '90',
      counterVolume: '18',
      native: '18',
      open: '0.2',
      high: '0.2',
      low: '0.2',
      last: '0.2',
      change: '0.00',
      openTime: '2020-07-02T08:00:00Z',
      lastTime: '2020-07-02T08:08:00Z',
      closes: [...NONE, '0.2'],
    }),
    'AUD/N': market(`AUD+${I}`, n, {
      count: 10,
      baseVolume: '40',
      counterVolume: '10',
      native: '10',
      open: '0.25',
      high: '0.25',
      low: '0.25',
      last: '0.25',
      change: '0.00',
      openTime: '2020-07-02T07:00:00Z',
      lastTime: '2020-07-02T07:09:00Z',
      closes: [null, null, null, '0.3', '0.3', '0.3', '0.25'],
    }),
    'CAD/N': market(`CAD+${I}`, n, {
      count: 10,
      baseVolume: '80',
      counterVolume: '10',
      native: '10',
      open: '0.125',
      high: '0.125',
      low: '0.125',
      last: '0.125',
      change: '0.00',
      openTime: '2020-07-02T07:30:00Z',
      lastTime: '2020-07-02T07:39:00Z',
      closes: [...NONE, '0.125'],
    }),
    'NZD/N': market(`NZD+${I}`, n, {
      count: 1,
      baseVolume: '1',
      counterVolume: '0.5',
      native: '0.5',
      open: '0.5',
      high: '0.5',
      low: '0.5',
      last: '0.5',
      change: '0.00',
      openTime: '2020-07-02T08:30:00Z',
      lastTime: '2020-07-02T08:30:00Z',
      closes: [...NONE, '0.5'],
    }),
    'EUR/GBP': market(`EUR+${I}`, `GBP+${I}`, {
      count: 14,
      baseVolume: '28',
      counterVolume: '42',
      open: '1.5',
      high: '1.5',
      low: '1.5',
      last: '1.5',
      change: '0.00',
      openTime: '2020-07-01T17:00:00Z',
      lastTime: '2020-07-01T17:13:00Z',
      closes: [null, null, null, null, null, '1.5', '1.5'],
    }),
    'BTC/EUR': market(`BTC+${I}`, `EUR+${I}`, {
      count: 11,
      baseVolume: '11',
      counterVolume: '220',
      open: '20',
      high: '20',
      low: '20',
      last: '20',
      change: '0.00',
      openTime: '2020-07-01T15:00:00Z',
      lastTime: '2020-07-01T15:10:00Z',
      closes: [null, null, null, null, null, '20', '20'],
    }),
    'BTC/GBP': market(`BTC+${I}`, `GBP+${I}`, {
      count: 11,
      baseVolume: '11',
      counterVolume: '330',
      open: '30',
      high: '30',
      low: '30',
      last: '30',
      change: '0.00',
      openTime: '2020-07-01T16:00:00Z',
      lastTime: '2020-07-01T16:10:00Z',
      closes: [null, null, null, null, null, '30', '30'],
    }),
  };
}

/** The order of the day's markets with `min_trades=1`: by native volume, then the pairs without one by count, then the pair. */
const DAY_ORDER = [
  'USD/N', // 65
  'USD/ZZZ', // 60
  'N/ZZZ', // 55
  'EUR/USD', // 25
  'CHF/N', // 18
  'AUD/N', // 10, and CAD/N has the same: the pair breaks the tie
  'CAD/N', // 10
  'NZD/N', // 0.5
  'EUR/GBP', // none, 14 trades
  'BTC/EUR', // none, 11 trades, and BTC/GBP has as many: the pair
  'BTC/GBP',
];
/** What `min_trades=10` (the default) leaves out: the pairs with 9 trades and 1. */
const BELOW_TEN = ['CHF/N', 'NZD/N'];

/** The markets of the 7 days: those of the day, but for the pairs that traded in days of the week before it too. */
function weekMarkets(n: string): Record<string, Json> {
  const day = dayMarkets(n);
  return {
    ...day,
    'USD/N': market(`USD+${I}`, n, {
      count: 28,
      baseVolume: '280',
      counterVolume: '140',
      native: '140',
      open: '0.45',
      high: '0.8',
      low: '0.3',
      last: '0.4',
      change: '-11.11',
      openTime: '2020-06-28T12:00:00Z',
      lastTime: '2020-07-02T10:42:17Z',
      closes: [null, null, '0.525', '0.525', '0.525', '0.5', '0.4'],
    }),
    'USD/ZZZ': market(`USD+${I}`, `ZZZ+${I}`, {
      count: 15,
      baseVolume: '150',
      counterVolume: '300',
      native: '75',
      open: '2',
      high: '2',
      low: '2',
      last: '2',
      change: '0.00',
      openTime: '2020-06-27T12:00:00Z',
      lastTime: '2020-07-02T04:11:00Z',
      closes: [null, '2', '2', '2', '2', '2', '2'],
    }),
    'EUR/USD': market(`EUR+${I}`, `USD+${I}`, {
      count: 15,
      baseVolume: '60',
      counterVolume: '75',
      native: '37.5',
      open: '1.25',
      high: '1.25',
      low: '1.25',
      last: '1.25',
      change: '0.00',
      openTime: '2020-06-29T12:00:00Z',
      lastTime: '2020-07-02T05:09:00Z',
      closes: [null, null, null, '1.25', '1.25', '1.25', '1.25'],
    }),
    'AUD/N': market(`AUD+${I}`, n, {
      count: 12,
      baseVolume: '48',
      counterVolume: '12.4',
      native: '12.4',
      open: '0.3',
      high: '0.3',
      low: '0.25',
      last: '0.25',
      change: '-16.67',
      openTime: '2020-06-29T14:00:00Z',
      lastTime: '2020-07-02T07:09:00Z',
      closes: [null, null, null, '0.3', '0.3', '0.3', '0.25'],
    }),
  };
}
const WEEK_ORDER = [
  'USD/N', // 140
  'USD/ZZZ', // 75
  'N/ZZZ', // 55
  'EUR/USD', // 37.5
  'CHF/N', // 18
  'AUD/N', // 12.4
  'CAD/N', // 10
  'NZD/N', // 0.5
  'EUR/GBP',
  'BTC/EUR',
  'BTC/GBP',
];

/** The markets of the 30 days: those of the 7, with the days before them. */
function monthMarkets(n: string): Record<string, Json> {
  return {
    ...weekMarkets(n),
    'USD/N': market(`USD+${I}`, n, {
      count: 48,
      baseVolume: '480',
      counterVolume: '240',
      native: '240',
      open: '0.25',
      high: '0.8',
      low: '0.25',
      last: '0.4',
      change: '60.00',
      openTime: '2020-06-10T12:00:00Z',
      lastTime: '2020-07-02T10:42:17Z',
      closes: [null, null, '0.525', '0.525', '0.525', '0.5', '0.4'],
    }),
    'USD/ZZZ': market(`USD+${I}`, `ZZZ+${I}`, {
      count: 20,
      baseVolume: '200',
      counterVolume: '425',
      native: '100',
      open: '2.5',
      high: '2.5',
      low: '2',
      last: '2',
      change: '-20.00',
      openTime: '2020-06-12T12:00:00Z',
      lastTime: '2020-07-02T04:11:00Z',
      closes: [null, '2', '2', '2', '2', '2', '2'],
    }),
    'N/ZZZ': market(n, `ZZZ+${I}`, {
      count: 14,
      baseVolume: '70',
      counterVolume: '140',
      native: '70',
      open: '2',
      high: '2',
      low: '2',
      last: '2',
      change: '0.00',
      openTime: '2020-06-15T12:00:00Z',
      lastTime: '2020-07-02T03:10:00Z',
      closes: [...NONE, '2'],
    }),
    // traded on a day of the 30 only: a sparkline of 7 days without a close
    'JPY/N': market(`JPY+${I}`, n, {
      count: 12,
      baseVolume: '1200',
      counterVolume: '12',
      native: '12',
      open: '0.01',
      high: '0.01',
      low: '0.01',
      last: '0.01',
      change: '0.00',
      openTime: '2020-06-12T14:00:00Z',
      lastTime: '2020-06-12T14:11:00Z',
      closes: [...NONE, null],
    }),
  };
}
const MONTH_ORDER = [
  'USD/N', // 240
  'USD/ZZZ', // 100
  'N/ZZZ', // 70
  'EUR/USD', // 37.5
  'CHF/N', // 18
  'AUD/N', // 12.4
  'JPY/N', // 12
  'CAD/N', // 10
  'NZD/N', // 0.5
  'EUR/GBP',
  'BTC/EUR',
  'BTC/GBP',
];

/** The whole answer of a period: the window, the totals, and the markets of `order` without the names in `without`. */
function answerOf(
  period: string,
  window: [start: string, end: string],
  totals: { pairs_traded: number; count: number; native_volume: string; amm_share?: string },
  all: Record<string, Json>,
  order: string[],
  without: string[] = [],
  amm = 'include',
): Json {
  const listed = order.filter((name) => !without.includes(name)).map((name) => all[name]);
  return {
    result: 'success',
    period,
    amm,
    start_time: window[0],
    end_time: window[1],
    totals: { pairs: listed.length, ...totals },
    count: listed.length,
    markets: listed,
  };
}

const END = '2020-07-02T10:42:17Z';
const dayAnswer = (n = 'XRP', without = BELOW_TEN, amm = 'include'): Json =>
  answerOf(
    'day',
    ['2020-07-01T10:00:00Z', END],
    { pairs_traded: 11, count: 112, native_volume: '243.5', amm_share: '0.0000' },
    dayMarkets(n),
    DAY_ORDER,
    without,
    amm,
  );
const weekAnswer = (without = BELOW_TEN, amm = 'include'): Json =>
  answerOf(
    '7day',
    ['2020-06-25T10:00:00Z', END],
    { pairs_traded: 11, count: 137, native_volume: '348.4', amm_share: '0.0000' },
    weekMarkets('XRP'),
    WEEK_ORDER,
    without,
    amm,
  );
const monthAnswer = (without = BELOW_TEN, amm = 'include'): Json =>
  answerOf(
    '30day',
    ['2020-06-02T10:00:00Z', END],
    { pairs_traded: 12, count: 177, native_volume: '500.4', amm_share: '0.0000' },
    monthMarkets('XRP'),
    MONTH_ORDER,
    without,
    amm,
  );

/** The keys of an answer, its totals and a market, in the order the spec pins. */
const ANSWER_KEYS = ['result', 'period', 'amm', 'start_time', 'end_time', 'totals', 'count', 'markets'];
const TOTALS_KEYS = ['pairs', 'pairs_traded', 'count', 'native_volume', 'amm_share'];
const MARKET_KEYS = [
  'base_currency',
  'base_issuer',
  'counter_currency',
  'count',
  'base_volume',
  'counter_volume',
  'native_volume',
  'open',
  'high',
  'low',
  'last',
  'change',
  'open_time',
  'last_time',
  'amm_share',
  'amm_pool',
  'sparkline',
];

const bad = (message: string): Json => ({ result: 'error', message });

/** The markets of an answer as `BASE/COUNTER`, in the order served. */
const names = (body: Json): string[] =>
  body.markets.map((m: Json) => `${m.base_currency}/${m.counter_currency}`).map((s: string) => s.replace('XRP', 'N'));

// ---------------------------------------------------------------------------------------------------------------------

describe('GET /v2/network/markets on the world of markets-world.ts', () => {
  let h: Harness;
  let api: ApiClient;
  const get = (qs = '') => api.get(`/v2/network/markets${qs ? `?${qs}` : ''}`);
  const ok = async (qs = ''): Promise<Json> =>
    (await api.ok(`/v2/network/markets${qs ? `?${qs}` : ''}`, 'markets')).body;

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT });
    api = await h.api();
    await seedMarketsWorld(h, MARKETS_NOW);
    // the live rate of EUR of I2: 12 trades in the last hour, 20 native coins for 10 EUR: 0.5 EUR a coin
    await seedLiveRate(h, 'XRP', { currency: 'EUR', issuer: I2 }, { native: '20', display: '10' });

    // the decoys: an older version of the set of each period and filter, with other numbers for a pair the set has and a pair
    // that is gone. Merges are stopped so that they stay where the reader can meet them
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.MarketsLive}`);
    const start = Date.parse('2020-07-01T10:00:00Z') / 1000;
    const end = Date.parse(END) / 1000;
    for (const period of ['day', '7day', '30day']) {
      for (const amm of ['include', 'exclude', 'only'] as const) {
        await h.ch.insert(
          Table.MarketsLive,
          handSet({
            period,
            amm,
            version: 1,
            start,
            end,
            pairs: [
              { base: `USD+${I}`, counter: 'XRP', count: 999, native: '999' },
              { base: `GONE+${I}`, counter: 'XRP', count: 500, native: '500' },
            ],
          }),
        );
      }
    }
  }, 600_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('the data is as the tests assume: three sets of the world, and the decoys next to them', async () => {
    const sets = await h.ch.query<{ period: string; filter: string; versions: string; rows: string }>(
      `SELECT period, toString(amm) AS filter, toString(uniqExact(version)) AS versions, toString(count()) AS rows
         FROM ${Table.MarketsLive}
        GROUP BY period, filter
        ORDER BY period, filter`,
    );
    // each set is its pairs and a sentinel, and the decoy under it (two pairs and a sentinel) is an older version: 2 versions
    // and 3 rows more. The world has no swap: `exclude` has the pairs of `include`, and `only` the sentinel alone
    expect(sets).toEqual([
      { period: '30day', filter: 'exclude', versions: '2', rows: '16' }, // 12 pairs and the sentinel, and the 3 of the decoy
      { period: '30day', filter: 'include', versions: '2', rows: '16' },
      { period: '30day', filter: 'only', versions: '2', rows: '4' },
      { period: '7day', filter: 'exclude', versions: '2', rows: '15' }, // 11 pairs and the sentinel
      { period: '7day', filter: 'include', versions: '2', rows: '15' },
      { period: '7day', filter: 'only', versions: '2', rows: '4' },
      { period: 'day', filter: 'exclude', versions: '2', rows: '15' },
      { period: 'day', filter: 'include', versions: '2', rows: '15' },
      { period: 'day', filter: 'only', versions: '2', rows: '4' },
    ]);
  });

  it('period day (default), 7day and 30day read the newest include set', async () => {
    const day = await ok();
    expect(day).toEqual(dayAnswer());
    expect(await ok('period=day')).toEqual(day);
    expect(await ok('period=7day')).toEqual(weekAnswer());
    expect(await ok('period=30day')).toEqual(monthAnswer());
    // the window and the totals are the sentinel's
    expect([day.start_time, day.end_time]).toEqual(['2020-07-01T10:00:00Z', END]);
    // an empty period is the default, as an empty parameter is elsewhere
    expect(await ok('period=')).toEqual(day);
    // not the older version of the sets
    const text = JSON.stringify([day, await ok('period=7day')]);
    expect(text).not.toMatch(/GONE|999/);
    expect(day.totals.count).toBe(112);
  });

  it('serves the keys in the order of the spec, the AMM keys among them', async () => {
    const answer = await ok();
    expect(Object.keys(answer)).toEqual(ANSWER_KEYS);
    expect(Object.keys(answer.totals)).toEqual(TOTALS_KEYS);
    // USD against the native currency: the counter has no issuer
    expect(Object.keys(answer.markets[0])).toEqual(MARKET_KEYS);
    // the pair of two issued currencies has both issuers
    const issued = answer.markets.find((m: Json) => m.counter_issuer !== undefined);
    expect(Object.keys(issued)).toEqual([
      'base_currency',
      'base_issuer',
      'counter_currency',
      'counter_issuer',
      ...MARKET_KEYS.slice(3),
    ]);
    // a pair without a native volume has no native_volume
    const none = answer.markets.find((m: Json) => m.base_currency === 'BTC');
    expect(Object.keys(none)).not.toContain('native_volume');
    // every period and every filter has them
    for (const period of ['day', '7day', '30day']) {
      for (const amm of ['include', 'exclude', 'only']) {
        const body = await ok(`period=${period}&min_trades=1&amm=${amm}`);
        expect(Object.keys(body)).toEqual(ANSWER_KEYS);
        expect(Object.keys(body.totals)).toEqual(TOTALS_KEYS);
        for (const m of body.markets) expect(Object.keys(m)).toEqual(expect.arrayContaining(['amm_share', 'amm_pool']));
      }
    }
    // a sparkline entry is a date, and a close where the day has one
    const sparkline = answer.markets[0].sparkline;
    expect(sparkline.map((s: Json) => Object.keys(s))).toEqual([
      ['date'],
      ['date'],
      ['date', 'close'],
      ['date', 'close'],
      ['date', 'close'],
      ['date', 'close'],
      ['date', 'close'],
    ]);
  });

  it('min_trades 10 by default lists the pairs with count >= min_trades; totals.pairs counts them, listed or not; pairs_traded, count and native_volume are over every traded pair', async () => {
    const ten = await ok();
    expect(names(ten)).toEqual(DAY_ORDER.filter((name) => !BELOW_TEN.includes(name)));
    expect(ten.totals).toEqual({ pairs: 9, pairs_traded: 11, count: 112, native_volume: '243.5', amm_share: '0.0000' });
    expect(ten.markets.every((m: Json) => m.count >= 10)).toBe(true);
    expect(await ok('min_trades=10')).toEqual(ten);

    // the trades of the day's pairs: 14, 13, 12, 11, 11, 11, 10, 10, 10, 9, 1
    const expected: [number, number][] = [
      [1, 11],
      [2, 10],
      [9, 10],
      [10, 9],
      [11, 6],
      [12, 3],
      [13, 2],
      [14, 1],
      [15, 0],
      [1_000_000, 0],
    ];
    for (const [minTrades, pairs] of expected) {
      const body = await ok(`min_trades=${minTrades}`);
      expect([minTrades, body.totals.pairs, body.count, body.markets.length]).toEqual([minTrades, pairs, pairs, pairs]);
      expect(body.markets.every((m: Json) => m.count >= minTrades)).toBe(true);
      // what is left out of the list stays in the totals of the window
      expect(body.totals).toMatchObject({ pairs_traded: 11, count: 112, native_volume: '243.5' });
      expect(body.start_time).toBe('2020-07-01T10:00:00Z');
    }
    // everything: the answer of min_trades=1 has all 11 in the order of the sort
    expect(await ok('min_trades=1')).toEqual(dayAnswer('XRP', []));
    // the limit comes after the count of totals.pairs
    const limited = await ok('min_trades=1&limit=3');
    expect([limited.count, limited.totals.pairs, limited.markets.length]).toEqual([3, 11, 3]);
    expect(names(limited)).toEqual(['USD/N', 'USD/ZZZ', 'N/ZZZ']);
    // the other periods
    expect(await ok('period=7day&min_trades=12')).toMatchObject({ count: 5, totals: { pairs: 5, count: 137 } });
    expect(await ok('period=30day&min_trades=12')).toMatchObject({ count: 7, totals: { pairs: 7, count: 177 } });
    expect(await ok('min_trades=010')).toEqual(await ok('min_trades=10'));
    // a repeated parameter: the first value wins
    expect((await ok('min_trades=11&min_trades=x')).totals.pairs).toBe(6);
  });

  it('sorted by native_volume descending, the pairs without one last by count, then the pair key', async () => {
    expect(names(await ok('min_trades=1'))).toEqual(DAY_ORDER);
    expect(names(await ok('period=7day&min_trades=1'))).toEqual(WEEK_ORDER);
    expect(names(await ok('period=30day&min_trades=1'))).toEqual(MONTH_ORDER);
    // a native volume of 10 twice: AUD before CAD; 11 trades twice, with no native volume: BTC/EUR before BTC/GBP
    const day = await ok('min_trades=1');
    expect(day.markets.map((m: Json) => m.native_volume)).toEqual([
      '65',
      '60',
      '55',
      '25',
      '18',
      '10',
      '10',
      '0.5',
      undefined,
      undefined,
      undefined,
    ]);
    expect(day.markets.slice(8).map((m: Json) => m.count)).toEqual([14, 11, 11]);
  });

  it('exchange_currency adds exchange and exchange_rate after end_time, and converted_volume after native_volume; its errors are those of the volume routes', async () => {
    const eur = `exchange_currency=EUR&exchange_issuer=${I2}`;
    const body = await ok(`min_trades=1&${eur}`);
    expect(Object.keys(body)).toEqual([
      'result',
      'period',
      'amm',
      'start_time',
      'end_time',
      'exchange',
      'exchange_rate',
      'totals',
      'count',
      'markets',
    ]);
    expect(body.exchange).toEqual({ currency: 'EUR', issuer: I2 });
    expect(Object.keys(body.exchange)).toEqual(['currency', 'issuer']);
    // one native coin buys 0.5 of it
    expect(body.exchange_rate).toBe(p8('0.5'));
    expect(Object.keys(body.totals)).toEqual([...TOTALS_KEYS.slice(0, 4), 'converted_volume', 'amm_share']);
    expect(body.totals).toEqual({
      pairs: 11,
      pairs_traded: 11,
      count: 112,
      native_volume: '243.5',
      converted_volume: '121.75',
      amm_share: '0.0000',
    });
    // the native volume times the rate, for the markets that have a native volume
    const day = dayMarkets('XRP');
    const converted: Record<string, string> = {
      'USD/N': '32.5',
      'USD/ZZZ': '30',
      'N/ZZZ': '27.5',
      'EUR/USD': '12.5',
      'CHF/N': '9',
      'AUD/N': '5',
      'CAD/N': '5',
      'NZD/N': '0.25',
    };
    expect(body.markets).toEqual(
      DAY_ORDER.map((name) => (converted[name] === undefined ? day[name] : withConverted(day[name], converted[name]))),
    );
    expect(Object.keys(body.markets[0])).toEqual([
      ...MARKET_KEYS.slice(0, 7),
      'converted_volume',
      ...MARKET_KEYS.slice(7),
    ]);
    expect(Object.keys(body.markets[8])).not.toContain('converted_volume');
    // everything else is the plain answer
    const { exchange, exchange_rate, ...rest } = body;
    expect([exchange, exchange_rate]).toHaveLength(2);
    expect(rest.markets.map((m: Json) => (({ converted_volume, ...others }) => others)(m))).toEqual(
      (await ok('min_trades=1')).markets,
    );
    // the other periods are converted at the same rate
    const week = await ok(`period=7day&${eur}`);
    expect(week.totals.converted_volume).toBe('174.2');
    expect(week.markets[0]).toMatchObject({ native_volume: '140', converted_volume: '70' });

    // the currency is upper-cased, as on the volume routes
    expect(await ok(`min_trades=1&exchange_currency=eur&exchange_issuer=${I2}`)).toEqual(body);
    // the native currency, in any case, adds nothing
    const plain = await ok('min_trades=1');
    expect(await ok('min_trades=1&exchange_currency=XRP')).toEqual(plain);
    expect(await ok('min_trades=1&exchange_currency=xrp')).toEqual(plain);
    expect(await ok('min_trades=1&exchange_currency=')).toEqual(plain);
    // a currency nobody trades against the native one has no rate: 0, and the values are 0
    const none = await ok(`exchange_currency=GBP&exchange_issuer=${I}`);
    expect(none.exchange_rate).toBe('0.0000000');
    expect(none.totals.converted_volume).toBe('0');
    expect(none.markets.map((m: Json) => m.converted_volume)).toEqual([
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      undefined,
      undefined,
      undefined,
    ]);

    // the errors of the volume routes, the messages and the checks, the exchange currency first
    const msg = async (qs: string): Promise<[number, Json]> => {
      const res = await get(qs);
      return [res.status, res.body];
    };
    expect(await msg('exchange_currency=USD')).toEqual([400, bad('exchange currency must have an issuer')]);
    expect(await msg('exchange_currency=usd')).toEqual([400, bad('exchange currency must have an issuer')]);
    expect(await msg(`exchange_issuer=${I2}`)).toEqual([400, bad('XRP cannot have an issuer')]);
    expect(await msg(`exchange_currency=xrp&exchange_issuer=${I2}`)).toEqual([400, bad('XRP cannot have an issuer')]);
    expect(await msg('exchange_currency=USD&exchange_issuer=notanaddress')).toEqual([
      400,
      bad('invalid exchange issuer address'),
    ]);
    expect(await msg('exchange_currency=USD&exchange_issuer=rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59X')).toEqual([
      400,
      bad('invalid exchange issuer address'),
    ]);
    // after period and min_trades
    expect(await msg('period=x&min_trades=x&exchange_currency=USD')).toEqual([
      400,
      bad('invalid period - use: day, 7day, 30day'),
    ]);
    expect(await msg('min_trades=x&exchange_currency=USD')).toEqual([400, bad('invalid min_trades')]);
  });

  it('unknown parameters are ignored, and the Cache-Control is the global one', async () => {
    const plain = await get('min_trades=1');
    const extra = await get('min_trades=1&foo=bar&marker=x&interval=week&start=2020-01-01');
    expect(extra.body).toEqual(plain.body);
    expect(plain.headers['cache-control']).toBe('private, max-age=60');
    expect(extra.headers['cache-control']).toBe('private, max-age=60');
  });

  it('amm=exclude and amm=only serve their sets; the answer echoes amm, include by default', async () => {
    // the default and an empty amm are include, echoed
    const plain = await ok('min_trades=1');
    expect(plain.amm).toBe('include');
    expect(Object.keys(plain).slice(0, 3)).toEqual(['result', 'period', 'amm']);
    for (const qs of ['amm=include', 'amm=', 'amm=include&amm=only', 'amm=&amm=only']) {
      expect([qs, await ok(`min_trades=1&${qs}`)]).toEqual([qs, plain]);
    }

    // the world has no swap: exclude is its include set under another name, and only has no pair
    const answers = {
      day: (without: string[], amm: string) => dayAnswer('XRP', without, amm),
      '7day': weekAnswer,
      '30day': monthAnswer,
    };
    for (const period of ['day', '7day', '30day'] as const) {
      expect(await ok(`period=${period}&amm=exclude`)).toEqual(answers[period](BELOW_TEN, 'exclude'));
      expect(await ok(`period=${period}&min_trades=1&amm=exclude`)).toEqual(answers[period]([], 'exclude'));
      const { start_time } = await ok(`period=${period}`);
      expect(await ok(`period=${period}&min_trades=1&amm=only`)).toEqual({
        result: 'success',
        period,
        amm: 'only',
        start_time,
        end_time: END,
        totals: { pairs: 0, pairs_traded: 0, count: 0, native_volume: '0', amm_share: '0.0000' },
        count: 0,
        markets: [],
      });
    }
    // the first of a repeated parameter counts
    expect((await ok('amm=only&amm=exclude')).amm).toBe('only');
    expect((await ok('amm=exclude&amm=only')).amm).toBe('exclude');
    // the display currency, the limit and the minimum work on the set of the filter
    const eur = `exchange_currency=EUR&exchange_issuer=${I2}`;
    const shown = await ok(`min_trades=1&limit=3&${eur}&amm=exclude`);
    expect(shown).toEqual({ ...(await ok(`min_trades=1&limit=3&${eur}`)), amm: 'exclude' });
    expect(Object.keys(shown)).toEqual([
      'result',
      'period',
      'amm',
      'start_time',
      'end_time',
      'exchange',
      'exchange_rate',
      'totals',
      'count',
      'markets',
    ]);
    const empty = await ok(`${eur}&amm=only`);
    expect(empty.totals).toEqual({
      pairs: 0,
      pairs_traded: 0,
      count: 0,
      native_volume: '0',
      converted_volume: '0',
      amm_share: '0.0000',
    });
    // the older versions of the sets are not what is read, in any filter
    expect(JSON.stringify([await ok('amm=exclude'), await ok('amm=only')])).not.toMatch(/GONE|999/);
  });

  it('an unknown amm is 400 invalid amm filter - use: include, exclude, only, after the display currency checks', async () => {
    const msg = async (qs: string): Promise<[number, Json]> => {
      const res = await get(qs);
      return [res.status, res.body];
    };
    const wrong = bad('invalid amm filter - use: include, exclude, only');
    for (const amm of ['x', 'INCLUDE', 'Only', 'exclude ', ' only', 'all', 'both', 'true', '1', 'includes', 'on']) {
      expect([amm, await msg(`amm=${encodeURIComponent(amm)}`)]).toEqual([amm, [400, wrong]]);
    }
    // the first of a repeated parameter counts
    expect(await msg('amm=x&amm=only')).toEqual([400, wrong]);
    expect((await get('amm=only&amm=x')).status).toBe(200);
    // after period, min_trades and the display currency
    expect(await msg('period=x&amm=x')).toEqual([400, bad('invalid period - use: day, 7day, 30day')]);
    expect(await msg('min_trades=x&amm=x')).toEqual([400, bad('invalid min_trades')]);
    expect(await msg('exchange_currency=USD&amm=x')).toEqual([400, bad('exchange currency must have an issuer')]);
    expect(await msg(`exchange_issuer=${I2}&amm=x`)).toEqual([400, bad('XRP cannot have an issuer')]);
    expect(await msg('exchange_currency=USD&exchange_issuer=notanaddress&amm=x')).toEqual([
      400,
      bad('invalid exchange issuer address'),
    ]);
    expect(await msg(`exchange_currency=USD&exchange_issuer=${I2}&amm=x`)).toEqual([400, wrong]);
    // in any format, and the error never reads a set
    expect((await get('amm=x&format=csv')).body).toEqual(wrong);
    const spy = jest.spyOn(h.ch, 'query');
    await get('amm=x');
    const reads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.MarketsLive}`));
    spy.mockRestore();
    expect(reads).toEqual([]);
  });

  it('a world parsed with AMM and without a swap serves "0.0000" and false in every period and filter', async () => {
    for (const period of ['day', '7day', '30day']) {
      for (const amm of ['include', 'exclude', 'only']) {
        const body = await ok(`period=${period}&min_trades=1&amm=${amm}`);
        expect(body.totals.amm_share).toBe('0.0000');
        for (const m of body.markets) expect([m.amm_share, m.amm_pool]).toEqual(['0.0000', false]);
      }
    }
  });

  it('format=csv is markets.csv with the markets', async () => {
    const res = await get('min_trades=1&format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(csvDisposition('markets'));
    const lines = res.text.split('\n');
    // a header and a line for each of the 11 markets
    expect(lines).toHaveLength(1 + 11);
    const header = lines[0].split(',');
    expect(header.slice(0, 14)).toEqual(
      [
        'base_currency',
        'base_issuer',
        'counter_currency',
        'count',
        'base_volume',
        'counter_volume',
        'native_volume',
        'open',
        'high',
        'low',
        'last',
        'change',
        'open_time',
        'last_time',
      ].map((column) => `"${column}"`),
    );
    // the AMM fields follow last_time, ahead of the sparkline; false is a cell like any other
    expect(header.slice(14, 17)).toEqual(['"amm_share"', '"amm_pool"', '"sparkline[0].date"']);
    expect(lines[1].split(',').slice(14, 16)).toEqual(['"0.0000"', '"false"']);
    expect(header).toContain('"sparkline[0].date"');
    expect(header).toContain('"sparkline[6].close"');
    expect(header).toContain('"counter_issuer"');
    expect(lines[1].split(',').slice(0, 7)).toEqual(['"USD"', `"${I}"`, '"XRP"', '"13"', '"130"', '"65"', '"65"']);
    // the totals and the other keys are not rows; the case of the format does not matter
    expect(header).not.toContain('"totals.pairs"');
    expect((await get('min_trades=1&format=CSV')).text).toBe(res.text);
    // the period decides the rows
    expect((await get('period=30day&format=csv')).text.split('\n')).toHaveLength(1 + 10);
  });

  it('a failing read is 500 unable to retrieve markets', async () => {
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
    const res = await get();
    expect([res.status, res.body]).toEqual([500, bad('unable to retrieve markets')]);
    // the failure of the rate is the same
    jest.restoreAllMocks();
    const query = h.ch.query.bind(h.ch);
    jest.spyOn(h.ch, 'query').mockImplementation(async (sql, params) => {
      if (String(sql).includes(`FROM ${Table.Exchanges}`)) throw new Error('boom');
      return query(sql, params);
    });
    const rate = await get(`exchange_currency=EUR&exchange_issuer=${I2}`);
    expect([rate.status, rate.body]).toEqual([500, bad('unable to retrieve markets')]);
    jest.restoreAllMocks();
    // and it is the same route that answers when the database is back
    expect((await get()).status).toBe(200);
  });

  it('the set read is a key prefix (period, amm) of markets_live, with no FINAL', async () => {
    for (const period of ['day', '7day', '30day']) {
      for (const amm of ['include', 'exclude', 'only']) {
        const spy = jest.spyOn(h.ch, 'query');
        await ok(`period=${period}&amm=${amm}`);
        const reads = spy.mock.calls.filter(([sql]) => String(sql).includes(`FROM ${Table.MarketsLive}`));
        spy.mockRestore();
        // one read of the set (and the newest version in a subquery of it)
        expect(reads).toHaveLength(1);
        const sql = String(reads[0][0]);
        const params = reads[0][1] as Record<string, unknown>;
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(params).toEqual({ period, amm });
        // bound: neither the period nor the filter is in the text
        expect(sql).not.toMatch(new RegExp(`'${period}'|'${amm}'`));
        expect(sql).toContain('WHERE period = {period:String} AND amm = {amm:String}');
        expect(sql).toContain(
          `version = (SELECT max(version) FROM ${Table.MarketsLive} WHERE period = {period:String} AND amm = {amm:String})`,
        );
        // each pair once, in the order of the key
        expect(sql).toMatch(
          /ORDER BY period, amm, base_currency, base_issuer, counter_currency, counter_issuer\s+LIMIT 1 BY base_currency, base_issuer, counter_currency, counter_issuer/,
        );
        // the columns of the AMM are read
        expect(sql).toMatch(/\bamm_share\b/);
        expect(sql).toMatch(/\bamm_pool\b/);
        expect(sql).toMatch(/\btotal_amm_share\b/);
        // the primary key (period, amm, pair) is searched by its first two columns, and the rows are read in the order of the key
        const indexes = await explain(h, 'indexes = 1', sql, params);
        expect(indexes).toMatch(
          /PrimaryKey\s+Keys:\s+period\s+amm\s+Condition: and\(\(amm in \[\d, \d\]\), \(period in \['[^']+', '[^']+'\]\)\)/,
        );
        expect(indexes).toContain('Read type: InOrder');
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('GET /v2/network/markets on a database with no set, then with sets written by hand', () => {
  let h: Harness;
  let api: ApiClient;
  const get = (qs = '') => api.get(`/v2/network/markets${qs ? `?${qs}` : ''}`);

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT });
    api = await h.api();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('a fresh database answers {result, period, amm, count: 0, markets: []}', async () => {
    const res = await get();
    expect([res.status, res.body]).toEqual([
      200,
      { result: 'success', period: 'day', amm: 'include', count: 0, markets: [] },
    ]);
    expect(Object.keys(res.body)).toEqual(['result', 'period', 'amm', 'count', 'markets']);
    for (const period of ['7day', '30day']) {
      expect((await get(`period=${period}`)).body).toEqual({
        result: 'success',
        period,
        amm: 'include',
        count: 0,
        markets: [],
      });
    }
    // the filter is echoed, whichever it is: there is no set of it either
    for (const amm of ['include', 'exclude', 'only']) {
      expect((await get(`period=7day&amm=${amm}`)).body).toEqual({
        result: 'success',
        period: '7day',
        amm,
        count: 0,
        markets: [],
      });
    }
    // the parameters that change nothing for it: the minimum, the limit, and a display currency
    expect((await get('min_trades=1&limit=5')).body).toEqual({
      result: 'success',
      period: 'day',
      amm: 'include',
      count: 0,
      markets: [],
    });
    expect((await get(`exchange_currency=USD&exchange_issuer=${MARKETS_ISSUER}&amm=only`)).body).toEqual({
      result: 'success',
      period: 'day',
      amm: 'only',
      count: 0,
      markets: [],
    });
    // as a CSV there is nothing to list
    const csv = await get('format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toBe(csvDisposition('markets'));
  });

  it('invalid period is 400 invalid period - use: day, 7day, 30day; min_trades must be a whole number from 1 to 1000000, else 400 invalid min_trades', async () => {
    const failure = async (qs: string): Promise<[number, Json]> => {
      const res = await get(qs);
      return [res.status, res.body];
    };
    for (const period of ['week', 'hour', '3day', '1day', 'DAY', 'Day', '7DAY', '30', 'all', ' day', 'day ', '0']) {
      expect([period, await failure(`period=${encodeURIComponent(period)}`)]).toEqual([
        period,
        [400, bad('invalid period - use: day, 7day, 30day')],
      ]);
    }
    // the first of a repeated parameter counts
    expect(await failure('period=week&period=day')).toEqual([400, bad('invalid period - use: day, 7day, 30day')]);
    expect((await get('period=day&period=week')).status).toBe(200);

    for (const minTrades of [
      '0',
      '-1',
      '1.5',
      '10.0',
      'abc',
      '1000001',
      '1e3',
      ' 5',
      '5 ',
      '+5',
      '0x10',
      '99999999999999999999',
      '１０',
    ]) {
      expect([minTrades, await failure(`min_trades=${encodeURIComponent(minTrades)}`)]).toEqual([
        minTrades,
        [400, bad('invalid min_trades')],
      ]);
    }
    for (const minTrades of ['1', '10', '999999', '1000000', '007', '']) {
      expect([minTrades, (await get(`min_trades=${minTrades}`)).status]).toEqual([minTrades, 200]);
    }

    // the period is checked first
    expect(await failure('period=x&min_trades=x')).toEqual([400, bad('invalid period - use: day, 7day, 30day')]);
    expect(await failure('min_trades=x')).toEqual([400, bad('invalid min_trades')]);
    // and the errors are of any format
    expect((await get('period=x&format=csv')).body).toEqual(bad('invalid period - use: day, 7day, 30day'));
  });

  it('sorted by native_volume descending, the pairs without one last by count, then the pair key; limit 1000 by default, 5000 at most', async () => {
    const pad = (i: number): string => String(i).padStart(4, '0');
    const pairs: HandPair[] = [];
    // 4000 pairs with a native volume of their own, from 100000 down: 100000 sorts above 99999 as a number, not as text
    for (let i = 0; i < 4000; i++) {
      pairs.push({ base: `A${pad(i)}+${I}`, counter: 'XRP', count: 10 + (i % 5), native: String(100_000 - i) });
    }
    // 500 with the same native volume: the pair breaks the tie
    for (let i = 0; i < 500; i++) {
      pairs.push({ base: `B${pad(i)}+${I}`, counter: 'XRP', count: 10 + (i % 3), native: '7' });
    }
    // 503 without one: by count, the largest first, then the pair
    for (let i = 0; i < 503; i++) pairs.push({ base: `C${pad(i)}+${I}`, counter: 'XRP', count: 10 + (i % 7) });
    expect(pairs).toHaveLength(5003);
    const start = Date.parse('2020-07-01T10:00:00Z') / 1000;
    // written in an order that is not the one the answer is in
    await h.ch.insert(
      Table.MarketsLive,
      handSet({ period: 'day', version: 7, start, end: start + 86_400, pairs: [...pairs].reverse() }),
    );

    const withoutNative = pairs
      .filter((p) => p.native === undefined)
      .sort((a, b) => b.count - a.count || (a.base < b.base ? -1 : 1));
    const expected = [...pairs.filter((p) => p.native !== undefined), ...withoutNative].map(
      (p) => p.base.split('+')[0],
    );
    const served = (body: Json): string[] => body.markets.map((m: Json) => m.base_currency);

    const byDefault = (await get()).body;
    expect([byDefault.count, byDefault.markets.length]).toEqual([1000, 1000]);
    expect(served(byDefault)).toEqual(expected.slice(0, 1000));
    // totals.pairs counts all of them: the limit comes after
    expect(byDefault.totals).toMatchObject({ pairs: 5003, pairs_traded: 5003 });

    for (const qs of ['limit=5000', 'limit=5001', 'limit=6000', 'limit=99999999999', 'limit=Infinity']) {
      const body = (await get(qs)).body;
      expect([qs, body.count, body.markets.length, body.totals.pairs]).toEqual([qs, 5000, 5000, 5003]);
      expect([qs, served(body)]).toEqual([qs, expected.slice(0, 5000)]);
    }
    // below the maximum it is the limit; a limit that is none is the default
    expect(served((await get('limit=2')).body)).toEqual(expected.slice(0, 2));
    expect(served((await get('limit=2.9')).body)).toEqual(expected.slice(0, 2));
    expect((await get('limit=4500')).body.count).toBe(4500);
    for (const qs of ['limit=0', 'limit=-3', 'limit=abc', 'limit=']) {
      expect([qs, (await get(qs)).body.count]).toEqual([qs, 1000]);
    }
    // a cut across the groups: the last of the pairs with a volume of their own, and the first of those with the same one
    expect(served((await get('limit=4003')).body).slice(3995)).toEqual(expected.slice(3995, 4003));
  }, 120_000);

  it('a set that was stored twice is read once, and a pair that is in two versions is read from the newest', async () => {
    // merges stopped, so that the rows written twice stay twice
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.MarketsLive}`);
    const start = Date.parse('2020-07-01T10:00:00Z') / 1000;
    const set = handSet({
      period: '7day',
      version: 5,
      start,
      end: start + 86_400,
      pairs: [
        { base: `AAA+${I}`, counter: 'XRP', count: 12, native: '30' },
        { base: `BBB+${I}`, counter: 'XRP', count: 11, native: '20' },
      ],
    });
    await h.ch.insert(Table.MarketsLive, set);
    await h.ch.insert(Table.MarketsLive, set);
    const stored = await h.ch.query<{ n: string }>(
      `SELECT toString(count()) AS n FROM ${Table.MarketsLive} WHERE period = '7day' AND version = 5`,
    );
    expect(stored[0].n).toBe('6');

    const answer = (await get('period=7day')).body;
    expect(answer.markets.map((m: Json) => [m.base_currency, m.count])).toEqual([
      ['AAA', 12],
      ['BBB', 11],
    ]);
    expect(answer.totals).toEqual({ pairs: 2, pairs_traded: 2, count: 23, native_volume: '50' });
    expect(answer.count).toBe(2);

    // a newer version of the set has the pairs it has: BBB changed, AAA is gone, CCC is new; nothing of version 5 is left
    await h.ch.insert(
      Table.MarketsLive,
      handSet({
        period: '7day',
        version: 6,
        start,
        end: start + 86_400,
        pairs: [
          { base: `BBB+${I}`, counter: 'XRP', count: 15, native: '8' },
          { base: `CCC+${I}`, counter: 'XRP', count: 14, native: '9' },
        ],
      }),
    );
    const newer = (await get('period=7day')).body;
    expect(newer.markets.map((m: Json) => [m.base_currency, m.count, m.native_volume])).toEqual([
      ['CCC', 14, '9'],
      ['BBB', 15, '8'],
    ]);
    expect(newer.totals).toEqual({ pairs: 2, pairs_traded: 2, count: 29, native_volume: '17' });
  });

  it('each AMM field is served when its column is not NULL and left out when it is: the share, the pool and the total on their own', async () => {
    const start = Date.parse('2020-06-02T10:00:00Z') / 1000;
    const end = Date.parse('2020-07-02T10:42:17Z') / 1000;
    const pairs: HandPair[] = [
      { base: `AAA+${I}`, counter: 'XRP', count: 12, native: '30', ammShare: '0.3400', ammPool: 1 },
      { base: `BBB+${I}`, counter: 'XRP', count: 11, native: '20', ammShare: '0.0000', ammPool: 0 },
      { base: `CCC+${I}`, counter: 'XRP', count: 10, native: '10', ammShare: '1.0000' },
      { base: `DDD+${I}`, counter: 'XRP', count: 10, native: '5', ammPool: 1 },
      { base: `EEE+${I}`, counter: 'XRP', count: 10 },
    ];
    await h.ch.insert(
      Table.MarketsLive,
      handSet({ period: '30day', version: 3, start, end, pairs, totalAmmShare: '0.2000' }),
    );
    const AMM_OF_PAIRS = [
      ['AAA', '0.3400', true],
      ['BBB', '0.0000', false],
      ['CCC', '1.0000', undefined],
      ['DDD', undefined, true],
      ['EEE', undefined, undefined],
    ];
    const body = (await get('period=30day')).body;
    expect(body.markets.map((m: Json) => [m.base_currency, m.amm_share, m.amm_pool])).toEqual(AMM_OF_PAIRS);
    expect(body.totals.amm_share).toBe('0.2000');
    expect(Object.keys(body.totals)).toEqual(['pairs', 'pairs_traded', 'count', 'native_volume', 'amm_share']);
    // each key is there on its own, after last_time and before the sparkline
    const ammKeys = (m: Json): string[] => Object.keys(m).filter((key) => key.startsWith('amm_'));
    expect(body.markets.map(ammKeys)).toEqual([
      ['amm_share', 'amm_pool'],
      ['amm_share', 'amm_pool'],
      ['amm_share'],
      ['amm_pool'],
      [],
    ]);
    expect(Object.keys(body.markets[0]).slice(-4)).toEqual(['last_time', 'amm_share', 'amm_pool', 'sparkline']);
    expect(JSON.stringify(body)).not.toContain('null');

    // a newer version of the set whose total is NULL: the pairs keep theirs, the totals have none
    await h.ch.insert(Table.MarketsLive, handSet({ period: '30day', version: 4, start, end, pairs }));
    const noTotal = (await get('period=30day')).body;
    expect(noTotal.markets.map((m: Json) => [m.base_currency, m.amm_share, m.amm_pool])).toEqual(AMM_OF_PAIRS);
    expect(Object.keys(noTotal.totals)).toEqual(['pairs', 'pairs_traded', 'count', 'native_volume']);

    // and a set of every AMM column NULL, as the job writes it when the parser gate keeps them out: none is served
    await h.ch.insert(
      Table.MarketsLive,
      handSet({
        period: '30day',
        version: 5,
        start,
        end,
        pairs: pairs.map(({ base, counter, count, native }) => ({ base, counter, count, native })),
      }),
    );
    const unknown = (await get('period=30day')).body;
    expect(JSON.stringify(unknown)).not.toMatch(/amm_|null/);
    expect(Object.keys(unknown)).toEqual(ANSWER_KEYS);
    expect(unknown.markets.map(ammKeys)).toEqual([[], [], [], [], []]);

    // each filter is its own set: exclude is read on its own, and only, which has none, answers as no set does
    await h.ch.insert(
      Table.MarketsLive,
      handSet({
        period: '30day',
        amm: 'exclude',
        version: 1,
        start,
        end,
        pairs: [{ base: `AAA+${I}`, counter: 'XRP', count: 5, native: '8', ammShare: '0.3400', ammPool: 1 }],
        totalAmmShare: '0.3400',
      }),
    );
    const exclude = (await get('period=30day&amm=exclude&min_trades=1')).body;
    expect(exclude).toMatchObject({ amm: 'exclude', count: 1, totals: { amm_share: '0.3400', count: 5 } });
    expect(exclude.markets[0]).toMatchObject({ base_currency: 'AAA', amm_share: '0.3400', amm_pool: true });
    expect((await get('period=30day&amm=only')).body).toEqual({
      result: 'success',
      period: '30day',
      amm: 'only',
      count: 0,
      markets: [],
    });
    // the filter include still reads its own newest version
    expect((await get('period=30day')).body.totals).toMatchObject({ count: 53 });
  });

  it('a failing read is 500 unable to retrieve markets', async () => {
    jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
    const res = await get();
    expect([res.status, res.body]).toEqual([500, bad('unable to retrieve markets')]);
    jest.restoreAllMocks();
    expect((await get()).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('GET /v2/network/markets on Xahau', () => {
  let h: Harness;
  let api: ApiClient;
  const get = (qs = '') => api.get(`/v2/network/markets${qs ? `?${qs}` : ''}`);

  beforeAll(async () => {
    h = await startHarness({ network: 'xahau', env: NO_RATE_LIMIT });
    api = await h.api();
    // the same world against XAH; a set for the day only: it reads the days of the sparkline, not the 30
    await seedMarketsWorld(h, MARKETS_NOW, { native: 'XAH', periods: ['day'] });
    await seedLiveRate(h, 'XAH', { currency: 'XRP', issuer: I }, { native: '20', display: '10' });
  }, 600_000);

  afterAll(async () => {
    await h?.close();
  });

  it('Xahau: native volume in XAH, and XAH cannot have an issuer', async () => {
    const res = await get('min_trades=1');
    expect(res.status).toBe(200);
    // the markets are those of the world, the native currency XAH: the native volume is that of the XAH side
    expect(res.body).toEqual(dayAnswer('XAH', []));
    const usd = res.body.markets[0];
    expect([usd.base_currency, usd.counter_currency, usd.native_volume]).toEqual(['USD', 'XAH', '65']);
    expect(Object.keys(usd)).not.toContain('counter_issuer');
    expect(res.body.totals.native_volume).toBe('243.5');
    // there are no swaps and no pools on Xahau: the AMM fields are known, and they say so
    expect(res.body.totals.amm_share).toBe('0.0000');
    for (const m of res.body.markets) expect([m.amm_share, m.amm_pool]).toEqual(['0.0000', false]);
    expect((await get('min_trades=1&amm=exclude')).body).toEqual(dayAnswer('XAH', [], 'exclude'));
    expect((await get('min_trades=1&amm=only')).body).toMatchObject({
      amm: 'only',
      totals: { pairs: 0, pairs_traded: 0, count: 0, native_volume: '0', amm_share: '0.0000' },
      markets: [],
    });

    // the native currency is XAH: it has no issuer, and its messages say so
    expect((await get(`exchange_currency=XAH&exchange_issuer=${I}`)).body).toEqual(bad('XAH cannot have an issuer'));
    expect((await get(`exchange_issuer=${I}`)).body).toEqual(bad('XAH cannot have an issuer'));
    // XRP is an ordinary currency here: it needs an issuer
    expect((await get('exchange_currency=XRP')).body).toEqual(bad('exchange currency must have an issuer'));
    expect((await get('exchange_currency=xah')).body).toEqual((await get()).body);

    // and as a display currency it has a rate: a XAH is worth 0.5 of the XRP of the issuer
    const display = await get(`min_trades=1&exchange_currency=XRP&exchange_issuer=${I}`);
    expect(display.status).toBe(200);
    expect(display.body.exchange).toEqual({ currency: 'XRP', issuer: I });
    expect(display.body.exchange_rate).toBe(p8('0.5'));
    expect(display.body.totals.converted_volume).toBe('121.75');
    expect(display.body.markets[0]).toMatchObject({ native_volume: '65', converted_volume: '32.5' });

    // a period without a set
    expect((await get('period=7day')).body).toEqual({
      result: 'success',
      period: '7day',
      amm: 'include',
      count: 0,
      markets: [],
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

/**
 * The markets of the day window of the world with swaps (`{ amm: true }`), by name: those of the order-book world, which the
 * swaps do not touch, and the two pairs they add. MIX/N is traded on the order book and against `MARKETS_POOL`, SWP/N against
 * `MARKETS_POOL2` only (read the header of `support/markets-world.ts` for the trades). A filter keeps its own trades: `exclude`
 * has no swap, so MIX/N is its order-book trades and SWP/N is no pair of it; `only` has the swaps, MIX/N's and SWP/N's, and no
 * other pair. `amm_share` and `amm_pool` describe the pair, so they are the same in every filter.
 */
function swapMarkets(filter: 'include' | 'exclude' | 'only'): Record<string, Json> {
  const mix: Record<typeof filter, Want> = {
    include: {
      count: 10,
      baseVolume: '100',
      counterVolume: '24',
      native: '24',
      open: '0.2',
      high: '0.3',
      low: '0.2',
      last: '0.3',
      change: '50.00',
      openTime: '2020-07-02T01:00:00Z',
      lastTime: '2020-07-02T01:13:00Z',
      closes: [...NONE, '0.3'],
      ammShare: '0.4000',
      ammPool: true,
    },
    exclude: {
      count: 6,
      baseVolume: '60',
      counterVolume: '12',
      native: '12',
      open: '0.2',
      high: '0.2',
      low: '0.2',
      last: '0.2',
      change: '0.00',
      openTime: '2020-07-02T01:00:00Z',
      lastTime: '2020-07-02T01:05:00Z',
      closes: [...NONE, '0.2'],
      ammShare: '0.4000',
      ammPool: true,
    },
    only: {
      count: 4,
      baseVolume: '40',
      counterVolume: '12',
      native: '12',
      open: '0.3',
      high: '0.3',
      low: '0.3',
      last: '0.3',
      change: '0.00',
      openTime: '2020-07-02T01:10:00Z',
      lastTime: '2020-07-02T01:13:00Z',
      closes: [...NONE, '0.3'],
      ammShare: '0.4000',
      ammPool: true,
    },
  };
  return {
    ...dayMarkets('XRP'),
    'MIX/N': market(`MIX+${I}`, 'XRP', mix[filter]),
    // swaps only, and no row of amm_pools for its pool: a share of 1 and no pool
    'SWP/N': market(`SWP+${I}`, 'XRP', {
      count: 10,
      baseVolume: '50',
      counterVolume: '10',
      native: '10',
      open: '0.2',
      high: '0.2',
      low: '0.2',
      last: '0.2',
      change: '0.00',
      openTime: '2020-07-02T01:20:00Z',
      lastTime: '2020-07-02T01:29:00Z',
      closes: [...NONE, '0.2'],
      ammShare: '1.0000',
      ammPool: false,
    }),
  };
}

/** The order of the markets of each filter with `min_trades=1`: MIX/N sorts by the native volume it has in the filter. */
const SWAP_ORDER = {
  include: [
    'USD/N', // 65
    'USD/ZZZ', // 60
    'N/ZZZ', // 55
    'EUR/USD', // 25
    'MIX/N', // 24
    'CHF/N', // 18
    'AUD/N', // 10, and CAD/N and SWP/N have the same: the pair breaks the tie
    'CAD/N',
    'SWP/N',
    'NZD/N', // 0.5
    'EUR/GBP',
    'BTC/EUR',
    'BTC/GBP',
  ],
  exclude: [
    'USD/N',
    'USD/ZZZ',
    'N/ZZZ',
    'EUR/USD',
    'CHF/N',
    'MIX/N',
    'AUD/N',
    'CAD/N',
    'NZD/N',
    'EUR/GBP',
    'BTC/EUR',
    'BTC/GBP',
  ],
  only: ['MIX/N', 'SWP/N'],
};

/** The totals of each filter: the pairs, the trades and the native volume that are those of the filter; the share is the pairs' */
const SWAP_TOTALS = {
  include: { pairs_traded: 13, count: 132, native_volume: '277.5', amm_share: '0.0706' },
  exclude: { pairs_traded: 12, count: 118, native_volume: '255.5', amm_share: '0.0706' },
  only: { pairs_traded: 2, count: 14, native_volume: '22', amm_share: '0.0706' },
};

/** The answer of the day for a filter, `min_trades=1`, from the markets above. */
const swapAnswer = (filter: 'include' | 'exclude' | 'only'): Json =>
  answerOf(
    'day',
    ['2020-07-01T10:00:00Z', END],
    SWAP_TOTALS[filter],
    swapMarkets(filter),
    SWAP_ORDER[filter],
    [],
    filter,
  );

describe('GET /v2/network/markets on a world with swaps and a pool', () => {
  let h: Harness;
  let api: ApiClient;
  const get = (qs = '') => api.get(`/v2/network/markets${qs ? `?${qs}` : ''}`);
  const ok = async (qs = ''): Promise<Json> =>
    (await api.ok(`/v2/network/markets${qs ? `?${qs}` : ''}`, 'markets')).body;

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT });
    api = await h.api();
    // the day only: it reads the days of the sparkline, not the 30
    await seedMarketsWorld(h, MARKETS_NOW, { periods: ['day'], amm: true });
    // the live rate of EUR of I2: 0.5 EUR a coin
    await seedLiveRate(h, 'XRP', { currency: 'EUR', issuer: I2 }, { native: '20', display: '10' });
  }, 600_000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('a pool pair: amm_share and amm_pool true; only lists the swaps; exclude leaves out a pair of swaps only', async () => {
    const include = await ok('min_trades=1');
    expect(include).toEqual(swapAnswer('include'));
    // MIX/N: 40 of its 100 are swaps, and its pool is in amm_pools; SWP/N is all swaps and its pool has no row
    const mix = include.markets.find((m: Json) => m.base_currency === 'MIX');
    const swp = include.markets.find((m: Json) => m.base_currency === 'SWP');
    expect([mix.amm_share, mix.amm_pool]).toEqual(['0.4000', true]);
    expect([swp.amm_share, swp.amm_pool]).toEqual(['1.0000', false]);
    // the others have no swap: "0.0000", and no pool
    const others = include.markets.filter((m: Json) => !['MIX', 'SWP'].includes(m.base_currency));
    expect(others).toHaveLength(11);
    for (const m of others) expect([m.amm_share, m.amm_pool]).toEqual(['0.0000', false]);
    // the share of the native volume: (24 x 0.4 + 10 x 1) / 277.5
    expect(include.totals.amm_share).toBe('0.0706');

    // exclude: the order book only, so SWP/N (swaps only) is not a pair of it, and MIX/N has its order-book trades
    const exclude = await ok('min_trades=1&amm=exclude');
    expect(exclude).toEqual(swapAnswer('exclude'));
    expect(names(exclude)).not.toContain('SWP/N');
    expect(exclude.markets.find((m: Json) => m.base_currency === 'MIX')).toMatchObject({
      count: 6,
      base_volume: '60',
      native_volume: '12',
    });
    // only: the swaps, and nothing else
    const only = await ok('min_trades=1&amm=only');
    expect(only).toEqual(swapAnswer('only'));
    expect(names(only)).toEqual(['MIX/N', 'SWP/N']);
    expect(only.markets.find((m: Json) => m.base_currency === 'MIX')).toMatchObject({
      count: 4,
      base_volume: '40',
      open: p8('0.3'),
      open_time: '2020-07-02T01:10:00Z',
    });

    // amm_share describes the pair, whichever trades the filter keeps: the same in every filter's set
    for (const amm of ['include', 'exclude', 'only']) {
      const body = await ok(`min_trades=1&amm=${amm}`);
      expect(body.markets.find((m: Json) => m.base_currency === 'MIX')).toMatchObject({
        amm_share: '0.4000',
        amm_pool: true,
      });
      expect(body.totals.amm_share).toBe('0.0706');
    }
  });

  it('the default min_trades lists the pairs of ten trades, and a filter keeps the pairs that reach it with its own trades', async () => {
    // MIX/N has ten trades in all, six of the order book and four swaps; SWP/N ten swaps
    expect(names(await ok())).toContain('MIX/N');
    expect(names(await ok())).toContain('SWP/N');
    expect(names(await ok('amm=exclude'))).not.toContain('MIX/N'); // 6 trades
    expect(names(await ok('amm=exclude'))).not.toContain('SWP/N');
    expect(names(await ok('amm=only'))).toEqual(['SWP/N']); // MIX/N has 4 swaps
    expect((await ok('amm=only')).totals).toEqual({
      pairs: 1,
      ...SWAP_TOTALS.only,
    });
  });

  it('a display currency converts the volumes of the filter, and the share stays last in the totals', async () => {
    const body = await ok(`min_trades=1&amm=only&exchange_currency=EUR&exchange_issuer=${I2}`);
    expect(Object.keys(body.totals)).toEqual([
      'pairs',
      'pairs_traded',
      'count',
      'native_volume',
      'converted_volume',
      'amm_share',
    ]);
    // 22 native coins at 0.5
    expect(body.totals).toEqual({ pairs: 2, ...SWAP_TOTALS.only, converted_volume: '11' });
    expect(body.markets.map((m: Json) => [m.base_currency, m.native_volume, m.converted_volume])).toEqual([
      ['MIX', '12', '6'],
      ['SWP', '10', '5'],
    ]);
    expect(Object.keys(body.markets[0]).slice(-4)).toEqual(['last_time', 'amm_share', 'amm_pool', 'sparkline']);
  });

  it('format=csv has amm_share and amm_pool for the pairs of the filter', async () => {
    const res = await get('min_trades=1&amm=only&format=csv');
    expect(res.status).toBe(200);
    const lines = res.text.split('\n');
    expect(lines).toHaveLength(1 + 2);
    const header = lines[0].split(',');
    const column = (name: string): number => header.indexOf(`"${name}"`);
    expect(column('amm_pool')).toBe(column('amm_share') + 1);
    const cells = (line: string): string[] => line.split(',');
    // MIX/N, then SWP/N
    expect([cells(lines[1])[column('amm_share')], cells(lines[1])[column('amm_pool')]]).toEqual(['"0.4000"', '"true"']);
    expect([cells(lines[2])[column('amm_share')], cells(lines[2])[column('amm_pool')]]).toEqual([
      '"1.0000"',
      '"false"',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('GET /v2/network/markets when a ledger of the window was parsed without AMM', () => {
  let h: Harness;
  let api: ApiClient;
  const ok = async (qs = ''): Promise<Json> =>
    (await api.ok(`/v2/network/markets${qs ? `?${qs}` : ''}`, 'markets')).body;

  beforeAll(async () => {
    h = await startHarness({ env: NO_RATE_LIMIT });
    api = await h.api();
    await seedMarketsWorld(h, MARKETS_NOW, { periods: ['day'], amm: true });
  }, 600_000);

  afterAll(async () => {
    await h?.close();
  });

  it('amm_share, amm_pool and totals.amm_share are served when the set has them, and left out when the parser gate kept them out', async () => {
    // every ledger of the window was written by a parser that knows AMM: the fields are there, in every filter
    const known: Json = {};
    for (const amm of ['include', 'exclude', 'only'] as const) {
      known[amm] = await ok(`min_trades=1&amm=${amm}`);
      expect(known[amm]).toEqual(swapAnswer(amm));
    }

    // one more ledger of the window, of the parser before AMM (the newest, at the close time of the world's last one), and the
    // job writes the day's three sets again
    const closed = Math.floor(MARKETS_NOW.getTime() / 1000);
    await h.ch.insert(Table.Ledgers, [
      {
        ...SAMPLE_ROWS[Table.Ledgers],
        ledger_index: 2_900_000,
        ledger_hash: '2900000'.padStart(64, 'A'),
        close_time: closed,
        parser_version: AMM_PARSER_VERSION - 1,
      },
    ]);
    const outcome = await computeMarketsSet(h.ch, 'XRP', 'day', MARKETS_NOW);
    expect(outcome).toMatchObject({ written: true, ammShareKnown: false });

    for (const amm of ['include', 'exclude', 'only'] as const) {
      const unknown = await ok(`min_trades=1&amm=${amm}`);
      // not one AMM field, and the filter is still echoed
      expect(JSON.stringify(unknown)).not.toMatch(/amm_/);
      expect(JSON.stringify(unknown)).not.toContain('null');
      expect(unknown.amm).toBe(amm);
      expect(Object.keys(unknown)).toEqual(ANSWER_KEYS);
      expect(Object.keys(unknown.totals)).toEqual(TOTALS_KEYS.slice(0, 4));
      // and the rest of the set is what it was: the filter's trades, volumes, prices and closes
      const { amm_share: total, ...totals } = known[amm].totals;
      expect(total).toBeDefined();
      expect(unknown).toEqual({
        ...known[amm],
        totals,
        markets: known[amm].markets.map(({ amm_share, amm_pool, ...rest }: Json) => {
          expect([amm_share, amm_pool]).not.toContain(undefined);
          return rest;
        }),
      });
    }
  });
});
