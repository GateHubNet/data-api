import { Asset, ExchangesRow, Table } from '@gatehub/data-api-shared';
import BigNumber from 'bignumber.js';
import { bucketExpr, bucketStart, EXCHANGE_INTERVALS } from '../src/exchanges/exchange-intervals';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { FixtureExchange, fixtureExchanges, fixtureSource } from './support/fixtures';
import { expectBoundedInOrderRead, explain, innerRead, tableReads } from './support/plans';

/**
 * `GET /v2/exchanges/:base/:counter` (raw exchanges) and `GET /v2/exchanges` (every pair, a GateHub extra) on a real
 * ClickHouse, seeded with the 54 ledgers of the original Ripple test suite (`ripple-mock`: 158 exchanges in 32 pairs,
 * 5 of them USD+rMwj…/XRP) and with the XRPL ledgers recorded from a public node (`xrpl-recorded`: 20 exchanges, two
 * of them autobridged). The Xahau ledgers recorded from a public node hold no exchange, so the Xahau case seeds
 * synthetic rows.
 *
 * Ported from rippled-historical-database `test/test.exchanges.js`, all 14 `it`s, same titles:
 *  - 'should make sure exchanges handles pagination correctly' walks the pair with `limit=1` and compares each page with
 *    the unpaged list, as the original does; only the marker is this API's;
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`USD|rMwj…|XRP||20150114182720|000011119603|00012|00004`, the first row of the next page); the marker of this API
 *    is `(ledger_index, tx_index, node_index)` of the last row of the page, so the test checks the Link around it and
 *    that the row the original named is the first of the next page;
 *  - the aggregated path (`interval`, `reduce`, Task 23): 'should should reduce exchanges to a single row', 'should
 *    should get aggregate exchanges' (the original's comment says there will be no aggregate: there is one, of the 5
 *    exchanges) and 'should return an error for an invalid interval'.
 * The three missing-issuer / issuer-with-XRP `it`s pass `interval=3weeks` in the original and are ported as they are:
 * the pair is checked before the interval.
 *
 * Added: the Exchange object (key order of the HBase row, types, what is left out), both orientations of every pair of
 * the mock ledgers, the order of the checks, limit, the markers, CSV, the SQL (full-key ORDER BY, plan read in order),
 * rows written twice, the all-pairs list and Xahau. For the aggregated path: candles and reduce of every pair in both
 * orientations against an oracle written from the original (`lib/aggregation/exchanges.js`, `getAlignedTime`,
 * `hbase.getExchanges` reduce and `invertPair`), the native legs of 0.0005 or less, the buckets of the window, the
 * bucket markers, CSV, the SQL and its plan, and the bucket boundaries of every interval on synthetic ledgers.
 */

const byKey = (a: FixtureExchange, b: FixtureExchange): number =>
  a.row.ledger_index - b.row.ledger_index || a.row.tx_index - b.row.tx_index || a.row.node_index - b.row.node_index;
/** Every mock exchange in the order of the all-pairs list, ascending. */
const ALL = [...fixtureExchanges('ripple-mock')].sort(byKey);

const USD = 'USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const USD_ISSUER = 'rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q';
const PAIR = `${USD}/xrp`;

/** The path segment of an asset: `XRP`, `USD+rMwj…`. */
const pathOf = (a: Asset): string => (a.issuer ? `${a.currency}+${a.issuer}` : a.currency);

interface Market {
  base: Asset;
  counter: Asset;
  rows: FixtureExchange[];
}
/** The pairs of a set of exchanges, as stored (canonical orientation), each with its rows in key order. */
function marketsOf(exchanges: FixtureExchange[]): Market[] {
  const markets = new Map<string, Market>();
  for (const e of exchanges) {
    const r = e.row;
    const key = [r.base_currency, r.base_issuer, r.counter_currency, r.counter_issuer].join('|');
    const market = markets.get(key) ?? {
      base: { currency: r.base_currency, ...(r.base_issuer && { issuer: r.base_issuer }) },
      counter: { currency: r.counter_currency, ...(r.counter_issuer && { issuer: r.counter_issuer }) },
      rows: [],
    };
    market.rows.push(e);
    markets.set(key, market);
  }
  return [...markets.values()];
}
const MARKETS = marketsOf(ALL);
const USD_XRP = MARKETS.find((m) => pathOf(m.base) === USD && m.counter.currency === 'XRP') as Market;

/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (iso: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000;
/** The exchanges of the ledgers that closed in `[from, before)`. */
const closedBetween = (rows: FixtureExchange[], from: string, before: string): FixtureExchange[] =>
  rows.filter((e) => e.row.close_time >= unix(from) && e.row.close_time < unix(before));
/** `YYYY-MM-DDTHH:mm:ssZ` of unix seconds. */
const executedTime = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
/** The marker of a row: `(ledger_index, tx_index, node_index)` as base64url JSON. */
const markerOf = (row: ExchangesRow): string =>
  Buffer.from(JSON.stringify([row.ledger_index, row.tx_index, row.node_index]), 'utf8').toString('base64url');

/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

/**
 * The Exchange of a stored row, written out the way the original served it (`getExchanges.js` on the row
 * `lib/hbase/hbase-thrift/data.js` builds): the `d` family of the HBase row first, then the `f` family, each sorted by
 * name, and last the four currency/issuer fields that the route sets. `inverted` is a pair requested the other way
 * round: base and counter, buyer and seller swapped, the rate inverted. The client is not served.
 */
function exchangeOf(row: ExchangesRow, inverted = false): Record<string, unknown> {
  const rate = new BigNumber(row.rate);
  const fields: Record<string, unknown> = {
    base_amount: inverted ? row.counter_amount : row.base_amount,
    counter_amount: inverted ? row.base_amount : row.counter_amount,
    node_index: row.node_index,
    rate: (inverted ? new BigNumber(1).dividedBy(rate) : rate).toPrecision(8),
    tx_index: row.tx_index,
    autobridged_currency: row.autobridged_currency ?? undefined,
    autobridged_issuer: row.autobridged_issuer || undefined,
    buyer: inverted ? row.seller : row.buyer,
    executed_time: executedTime(row.close_time),
    ledger_index: row.ledger_index,
    offer_sequence: row.offer_sequence,
    provider: row.provider,
    seller: inverted ? row.buyer : row.seller,
    taker: row.taker,
    tx_hash: row.tx_hash,
    tx_type: row.tx_type,
    base_currency: inverted ? row.counter_currency : row.base_currency,
    base_issuer: (inverted ? row.counter_issuer : row.base_issuer) || undefined,
    counter_currency: inverted ? row.base_currency : row.counter_currency,
    counter_issuer: (inverted ? row.base_issuer : row.counter_issuer) || undefined,
    // a swap against an AMM pool names the pool, last; an order-book exchange has no such key
    amm_account: row.amm_account || undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}
const exchangesOf = (list: FixtureExchange[], inverted = false): Record<string, unknown>[] =>
  list.map((e) => exchangeOf(e.row, inverted));

interface ListBody {
  result: string;
  count: number;
  marker?: string;
  exchanges: Record<string, unknown>[];
}
const hashesIn = (body: ListBody): unknown[] => body.exchanges.map((e) => e.tx_hash);
const hashesOf = (list: FixtureExchange[]): string[] => list.map((e) => e.row.tx_hash);

/** The columns of the CSV of the raw exchanges, in the order `getExchanges.js` lists them. */
const CSV_COLUMNS = [
  'base_currency',
  'base_issuer',
  'base_amount',
  'counter_amount',
  'counter_currency',
  'counter_issuer',
  'rate',
  'executed_time',
  'ledger_index',
  'buyer',
  'seller',
  'taker',
  'provider',
  'autobridged_currency',
  'autobridged_issuer',
  'offer_sequence',
  'tx_type',
  'tx_index',
  'node_index',
  'tx_hash',
];

// -- the aggregated path: an oracle written from the original ---------------------------------------------------------

/** BigNumber with room for the inverse of a rate far from 1. */
const Wide = BigNumber.clone({ DECIMAL_PLACES: 120 });

/**
 * `utils.getAlignedTime(time, period, multiple)` of the original (moment, UTC), written out on Date: the start of the
 * bucket of `interval` that holds the time. n minutes and n hours are clock-aligned, n days count from 2013-01-01 (in
 * whole hours over 24, as moment's diff did), 7 days are the ISO week from Monday, months and years the calendar ones.
 */
function alignedTime(seconds: number, interval: string): number {
  const m = /^(\d+)(minute|hour|day|month|year)$/.exec(interval === 'week' ? '7day' : interval);
  if (!m) throw new Error(`not an interval: ${interval}`);
  let multiple = Number(m[1]);
  let period = m[2];
  if (period === 'day' && multiple === 7) {
    period = 'week';
    multiple = 1;
  }
  const d = new Date(seconds * 1000);
  switch (period) {
    case 'minute':
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % multiple));
      break;
    case 'hour':
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() - (d.getUTCHours() % multiple));
      break;
    case 'day': {
      const diff = Math.trunc((seconds * 1000 - Date.UTC(2013, 0, 1)) / 3_600_000) / 24;
      const days = multiple === 1 ? 0 : Math.floor(diff) % multiple;
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - days);
      break;
    }
    case 'week':
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      break;
    case 'month':
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(1);
      break;
    default:
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCMonth(0, 1);
  }
  return d.getTime() / 1000;
}

/**
 * The exchanges the original aggregates: one whose native leg is 0.0005 or less ("tiny amounts that exist from rounding
 * errors in XRP") is left out. The native side is the one without an issuer.
 */
const aggregated = (rows: ExchangesRow[]): ExchangesRow[] =>
  rows.filter(
    (r) =>
      !(r.base_issuer === '' && Number(r.base_amount) <= 0.0005) &&
      !(r.counter_issuer === '' && Number(r.counter_amount) <= 0.0005),
  );

const sumOf = (values: string[]): BigNumber => values.reduce((s, v) => s.plus(v), new Wide(0));
const p8 = (x: BigNumber.Value): string => new Wide(x).toPrecision(8);

/**
 * What the original computed from a list of exchanges of one pair, as stored and in the order of the key: open and
 * close are the first and last exchange, high and low the highest and lowest rate (the first of equal ones, as its
 * strict comparisons kept), vwap the counter volume over the base volume, the buy volume the base of the exchanges the
 * taker bought. Inverted (`invertPair`, and the per-row inversion of the reduce path): the rates are 1/rate, so high
 * is 1/low and low 1/high, the volumes swap, and the buy volume is that of the inverted exchanges: the counter of those
 * the taker sold. The volumes are the exact sums of the stored amounts (the original summed floats), written as a
 * number is.
 */
function figuresOf(rows: ExchangesRow[], inverted: boolean) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const rates = rows.map((r) => Number(r.rate));
  const lowest = rows[rates.indexOf(Math.min(...rates))].rate;
  const highest = rows[rates.indexOf(Math.max(...rates))].rate;
  const base = sumOf(rows.map((r) => r.base_amount));
  const counter = sumOf(rows.map((r) => r.counter_amount));
  const inv = (rate: string): BigNumber => new Wide(1).dividedBy(rate);
  const times = { open_time: executedTime(first.close_time), close_time: executedTime(last.close_time) };
  return inverted
    ? {
        open: p8(inv(first.rate)),
        high: p8(inv(lowest)),
        low: p8(inv(highest)),
        close: p8(inv(last.rate)),
        vwap: p8(base.dividedBy(counter)),
        base_volume: counter.toString(),
        counter_volume: base.toString(),
        buy_volume: sumOf(rows.filter((r) => r.seller === r.taker).map((r) => r.counter_amount)).toNumber(),
        count: rows.length,
        ...times,
      }
    : {
        open: p8(first.rate),
        high: p8(highest),
        low: p8(lowest),
        close: p8(last.rate),
        vwap: p8(counter.dividedBy(base)),
        base_volume: base.toString(),
        counter_volume: counter.toString(),
        buy_volume: sumOf(rows.filter((r) => r.buyer === r.taker).map((r) => r.base_amount)).toNumber(),
        count: rows.length,
        ...times,
      };
}

/** The pair fields the route sets: the pair as it was asked for, the native currency without an issuer key. */
function pairFields(m: Market, inverted: boolean): Record<string, string> {
  const [base, counter] = inverted ? [m.counter, m.base] : [m.base, m.counter];
  return {
    base_currency: base.currency,
    ...(base.issuer && { base_issuer: base.issuer }),
    counter_currency: counter.currency,
    ...(counter.issuer && { counter_issuer: counter.issuer }),
  };
}

/**
 * The candles of a pair (rows as stored, in key order): one per bucket that holds an exchange, oldest first, with the
 * keys of the HBase row of `agg_exchanges` (the `d` family sorted by name) and then the pair.
 */
function candlesOf(m: Market, interval: string, inverted: boolean, rows = m.rows.map((e) => e.row)) {
  const buckets = new Map<number, ExchangesRow[]>();
  for (const r of aggregated(rows)) {
    const start = alignedTime(r.close_time, interval);
    buckets.set(start, [...(buckets.get(start) ?? []), r]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, list]) => {
      const f = figuresOf(list, inverted);
      return {
        base_volume: f.base_volume,
        buy_volume: f.buy_volume,
        close: f.close,
        close_time: f.close_time,
        count: f.count,
        counter_volume: f.counter_volume,
        high: f.high,
        low: f.low,
        open: f.open,
        open_time: f.open_time,
        start: executedTime(start),
        vwap: f.vwap,
        ...pairFields(m, inverted),
      };
    });
}

/**
 * The reduced row of a pair: the keys of the literal of the original's `reduce`, then `start` and the pair. Without an
 * exchange it is the original's row of zeros, without open and close time. `start` is the start of the window.
 */
function reducedOf(m: Market, inverted: boolean, start: string, rows = m.rows.map((e) => e.row)) {
  const list = aggregated(rows);
  if (list.length === 0) {
    return {
      open: '0.0000000',
      high: '0.0000000',
      low: '0.0000000',
      close: '0.0000000',
      base_volume: '0',
      counter_volume: '0',
      buy_volume: 0,
      count: 0,
      vwap: '0.0000000',
      start,
      ...pairFields(m, inverted),
    };
  }
  const f = figuresOf(list, inverted);
  return {
    open: f.open,
    high: f.high,
    low: f.low,
    close: f.close,
    base_volume: f.base_volume,
    counter_volume: f.counter_volume,
    buy_volume: f.buy_volume,
    count: f.count,
    open_time: f.open_time,
    close_time: f.close_time,
    vwap: f.vwap,
    start,
    ...pairFields(m, inverted),
  };
}

/**
 * Served aggregates against the oracle: the keys in their order, then every field. The volumes too, exactly: they are
 * the exact sums of the stored amounts.
 */
function expectAggregates(
  label: unknown,
  served: Record<string, unknown>[],
  expected: Record<string, unknown>[],
): void {
  expect([label, served.map((o) => Object.keys(o))]).toEqual([label, expected.map((o) => Object.keys(o))]);
  expect([label, served]).toEqual([label, expected]);
}

/** The columns of the CSV of candles and of the reduced row: the original's list, and the buy volume it left out. */
const AGGREGATE_CSV_COLUMNS = [
  'open',
  'high',
  'low',
  'close',
  'vwap',
  'count',
  'base_currency',
  'base_issuer',
  'base_volume',
  'counter_currency',
  'counter_issuer',
  'counter_volume',
  'open_time',
  'close_time',
  'start',
  'buy_volume',
];

/** The marker of a candle: the unix seconds of the start of its bucket, as base64url JSON. */
const bucketMarker = (iso: string): string => Buffer.from(JSON.stringify([unix(iso)]), 'utf8').toString('base64url');

describe('exchanges API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'exchanges');
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  // -- test.exchanges.js ----------------------------------------------------------------------------------------

  it('should should get individual exchanges', async () => {
    const res = await get(`/v2/exchanges/${PAIR}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.exchanges.length).toBe(res.body.count);
    expect(res.body.exchanges.length).toBe(5);
    let last = 0;
    for (const ex of (res.body as ListBody).exchanges) {
      expect(typeof ex.base_amount).toBe('string');
      expect(typeof ex.counter_amount).toBe('string');
      expect(typeof ex.rate).toBe('string');
      expect(typeof ex.offer_sequence).toBe('number');
      expect(typeof ex.ledger_index).toBe('number');
      expect(typeof ex.buyer).toBe('string');
      expect(typeof ex.seller).toBe('string');
      expect(typeof ex.taker).toBe('string');
      expect(typeof ex.provider).toBe('string');
      expect(typeof ex.executed_time).toBe('string');
      expect(typeof ex.tx_hash).toBe('string');
      expect(typeof ex.tx_type).toBe('string');

      expect(last).toBeLessThanOrEqual(ex.ledger_index as number);
      last = ex.ledger_index as number;
    }
  });

  it('should should get individual exchanges by date', async () => {
    const start = '2015-01-14T18:28:40Z';
    const end = '2015-01-14T18:51:40Z';
    const res = await get(`/v2/exchanges/${PAIR}${qs({ start, end })}`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.exchanges.length).toBe(res.body.count);
    expect(res.body.exchanges.length).toBe(2);
    for (const ex of (res.body as ListBody).exchanges) {
      const time = Date.parse(ex.executed_time as string);
      expect(Date.parse(start) - time).toBeLessThanOrEqual(0); // executed time less than start time
      expect(Date.parse(end) - time).toBeGreaterThanOrEqual(0); // executed time greater than end time
    }
    // and they are the exchanges of the ledgers that closed in the window
    expect(hashesIn(res.body)).toEqual(
      hashesOf(closedBetween(USD_XRP.rows, '2015-01-14T18:28:40', '2015-01-14T18:51:41')),
    );
  });

  it('should should get exchanges in descending order', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?descending=true`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.exchanges.length).toBe(res.body.count);
    expect(res.body.count).toBe(5);
    let last = Infinity;
    for (const ex of (res.body as ListBody).exchanges) {
      expect(last).toBeGreaterThanOrEqual(ex.ledger_index as number);
      last = ex.ledger_index as number;
    }
  });

  it('should make sure exchanges handles pagination correctly', async () => {
    const url = `/v2/exchanges/${PAIR}?`;
    const ref = await get(url);
    expect(ref.status).toBe(200);
    expect(ref.body.result).toBe('success');
    expect(ref.body.count).toBeGreaterThan(1); // must be at least 2

    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`${url}&limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.exchanges).toHaveLength(1);
      expect(res.body.exchanges[0].base_amount).toBe(ref.body.exchanges[i].base_amount);
      expect(res.body.exchanges[0].tx_hash).toBe(ref.body.exchanges[i].tx_hash);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined();
  });

  it('should invert data when base and counter are inverted', async () => {
    const res1 = await get('/v2/exchanges/xrp/USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q');
    const res2 = await get(`/v2/exchanges/${PAIR}`);
    const exchanges: ListBody['exchanges'] = res1.body.exchanges;
    const inverted: ListBody['exchanges'] = res2.body.exchanges;
    expect(exchanges).toHaveLength(5);
    exchanges.forEach((ex, i) => {
      expect(ex.base_amount === inverted[i].counter_amount).toBe(true); // base and counter not inverted
      expect(ex.counter_amount === inverted[i].base_amount).toBe(true); // counter and base not inverted
    });
  });

  it('should should reduce exchanges to a single row', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?reduce=true`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.exchanges[0].count).toBe(5);
  });

  // the original's comment: "there will not be any aggregates to be found"; there is one, the hour of the 5 exchanges
  it('should should get aggregate exchanges', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?interval=1hour`);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.exchanges.length).toBe(1);
    expect(res.body.exchanges[0].count).toBe(5);
  });

  it('should return an error for an invalid start date', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?start=2015x`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid start date format');
  });

  it('should return an error for an invalid end time', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?end=2015x`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid end date format');
  });

  it('should return an error for an invalid interval', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?interval=3weeks`);
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid interval: 3weeks');
  });

  it('should return an error for an missing base issuer', async () => {
    const res = await get('/v2/exchanges/USD/xrp?interval=3weeks');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('base issuer is required');
  });

  it('should return an error for an missing counter issuer', async () => {
    const res = await get('/v2/exchanges/xrp/USD?interval=3weeks');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('counter issuer is required');
  });

  it('should return an error for issuer with XRP', async () => {
    const res = await get('/v2/exchanges/USD/xrp+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q?interval=3weeks');
    expect(res.status).toBe(400);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('XRP cannot have an issuer');
  });

  it('should include a link header when marker is present', async () => {
    const res = await get(`/v2/exchanges/${PAIR}?limit=1`);
    expect(res.status).toBe(200);
    // the marker of this API is the key of the last row of the page
    const marker = markerOf(USD_XRP.rows[0].row);
    expect(res.body.marker).toBe(marker);
    const origin = new URL(res.request.url).origin;
    expect(res.headers.link).toBe(`<${origin}/v2/exchanges/${PAIR}?limit=1&marker=${marker}>; rel="next"`);
    // the original named the first row of the next page, 11119603 / 12 / 4, and following the Link starts there
    const next = await get(`/v2/exchanges/${PAIR}?limit=1&marker=${marker}`);
    expect(next.body.exchanges[0]).toMatchObject({ ledger_index: 11119603, tx_index: 12, node_index: 4 });
  });

  // -- the brief ----------------------------------------------------------------------------------------------------

  it('reversed pair returns inverted rows with identical tx_hash order', async () => {
    const forward = await get(`/v2/exchanges/${PAIR}`);
    const reversed = await get(`/v2/exchanges/xrp/${USD}`);
    expect(forward.body.count).toBe(5);
    expect(hashesIn(reversed.body)).toEqual(hashesIn(forward.body));
    expect(reversed.body.exchanges).toEqual(exchangesOf(USD_XRP.rows, true));
    reversed.body.exchanges.forEach((ex: Record<string, unknown>, i: number) => {
      const f = forward.body.exchanges[i];
      expect(ex).toMatchObject({
        base_currency: 'XRP',
        counter_currency: 'USD',
        counter_issuer: USD_ISSUER,
        base_amount: f.counter_amount,
        counter_amount: f.base_amount,
        buyer: f.seller,
        seller: f.buyer,
        taker: f.taker,
        provider: f.provider,
        tx_hash: f.tx_hash,
        ledger_index: f.ledger_index,
        executed_time: f.executed_time,
        offer_sequence: f.offer_sequence,
      });
      expect(ex).not.toHaveProperty('base_issuer');
      // 1/rate to 8 significant digits
      expect(ex.rate).toBe(new BigNumber(1).dividedBy(new BigNumber(f.rate as string)).toPrecision(8));
    });
  });

  it('limit=1000 is clamped to 400', async () => {
    const query = jest.spyOn(h.ch, 'query');
    const res = await get(`/v2/exchanges/${PAIR}?limit=1000`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
    const paging = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
    // one more than the page is asked for: the extra row tells whether there is a next page
    expect(paging).toHaveLength(1);
    expect(paging[0][1]).toMatchObject({ distinct_page_limit: 401 });
    // 400 itself and below are kept
    jest.restoreAllMocks();
    const spy = jest.spyOn(h.ch, 'query');
    await get(`/v2/exchanges/${PAIR}?limit=400`);
    await get(`/v2/exchanges/${PAIR}?limit=399`);
    await get(`/v2/exchanges/${PAIR}?limit=401`);
    const fetches = spy.mock.calls
      .filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)))
      .map(([, params]) => (params as { distinct_page_limit: number }).distinct_page_limit);
    expect(fetches).toEqual([401, 400, 401]);
  });

  it('lowercase pair path works', async () => {
    const upper = await get(`/v2/exchanges/${PAIR}`);
    for (const path of [
      `usd+${USD_ISSUER}/xrp`,
      `Usd+${USD_ISSUER}/xRp`,
      `usd.${USD_ISSUER}/xrp`,
      `usd|${USD_ISSUER}/xrp`,
    ]) {
      const res = await get(`/v2/exchanges/${path}`);
      expect([path, res.status, res.body]).toEqual([path, 200, upper.body]);
    }
    const reversed = await get(`/v2/exchanges/xrp/usd+${USD_ISSUER}`);
    expect(reversed.body.exchanges).toEqual(exchangesOf(USD_XRP.rows, true));
  });

  // -- the brief of the aggregated path (Task 23) ---------------------------------------------------------------------

  it('3day buckets align to 2013-01-01', async () => {
    // the bucket expression, run on the ClickHouse of the harness
    const times = [
      '2013-01-01T00:00:00',
      '2013-01-03T23:59:59',
      '2013-01-04T00:00:00',
      '2014-12-31T00:00:00',
      '2015-01-02T23:59:59',
      '2015-01-03T00:00:00',
      '2015-01-14T18:27:20',
    ];
    const rows = await h.ch.query<{ bucket: number }>(
      `SELECT toUnixTimestamp(${bucketExpr('3day')}) AS bucket
         FROM (SELECT arrayJoin({times:Array(UInt32)}) AS t, toDateTime(t, 'UTC') AS close_time) ORDER BY t`,
      { times: times.map(unix) },
    );
    expect(rows.map((r) => executedTime(r.bucket))).toEqual([
      '2013-01-01T00:00:00Z',
      '2013-01-01T00:00:00Z',
      '2013-01-04T00:00:00Z',
      '2014-12-31T00:00:00Z',
      '2014-12-31T00:00:00Z',
      '2015-01-03T00:00:00Z',
      '2015-01-12T00:00:00Z',
    ]);
    // every start is a whole number of 3 days after 2013-01-01
    for (const r of rows) expect((r.bucket - unix('2013-01-01T00:00:00')) % (3 * 86400)).toBe(0);
    // and the 3day candle of the mock exchanges starts on the 12th
    const res = await get(`/v2/exchanges/${PAIR}?interval=3day`);
    expect(res.body.exchanges.map((e: { start: string }) => e.start)).toEqual(['2015-01-12T00:00:00Z']);
  });

  it('bucketExpr in ClickHouse, bucketStart and the alignment of the original agree, for every interval', async () => {
    // times spread over 2013-2030 at an odd step, and for each of them the start of its bucket and the second before;
    // from 2013-01-01 on, when the first ledger closed (before it the n-day expression and the original's alignment
    // both go wrong: integer division and moment's diff round towards zero)
    const samples: number[] = [];
    for (let t = unix('2013-01-01T00:00:00'); t < unix('2031-01-01T00:00:00'); t += 7_919 * 97 + 13) samples.push(t);
    for (const interval of EXCHANGE_INTERVALS) {
      const times = samples
        .flatMap((t) => [t, alignedTime(t, interval), alignedTime(t, interval) - 1])
        .filter((t) => t >= unix('2013-01-01T00:00:00'));
      expect(times.length).toBeGreaterThan(2000);
      const rows = await h.ch.query<{ t: number; bucket: number }>(
        `SELECT t, toUnixTimestamp(${bucketExpr(interval)}) AS bucket
           FROM (SELECT arrayJoin({times:Array(UInt32)}) AS t, toDateTime(t, 'UTC') AS close_time)`,
        { times },
      );
      expect(rows.map((r) => r.t)).toEqual(times);
      const original = times.map((t) => alignedTime(t, interval));
      expect([interval, rows.map((r) => r.bucket)]).toEqual([interval, original]);
      expect([interval, times.map((t) => bucketStart(t, interval))]).toEqual([interval, original]);
    }
  });

  it('week alias equals 7day', async () => {
    expect(bucketExpr('week')).toBe(bucketExpr('7day'));
    for (const path of [
      `/v2/exchanges/${PAIR}`,
      `/v2/exchanges/xrp/${USD}`,
      `/v2/exchanges/${pathOf(MARKETS[0].base)}/${pathOf(MARKETS[0].counter)}`,
    ]) {
      const week = await get(`${path}?interval=week`);
      const seven = await get(`${path}?interval=7day`);
      expect([path, week.status]).toEqual([path, 200]);
      expect([path, week.body]).toEqual([path, seven.body]);
      expect([path, (await get(`${path}?interval=WEEK`)).body]).toEqual([path, seven.body]);
      // the ISO week: 2015-01-14 was a Wednesday, its week starts on Monday the 12th
      expect(week.body.exchanges.map((e: { start: string }) => e.start)).toEqual(['2015-01-12T00:00:00Z']);
      expect(new Date(week.body.exchanges[0].start).getUTCDay()).toBe(1);
    }
  });

  it('reduce returns one row whose count equals raw count', async () => {
    for (const m of MARKETS) {
      for (const [base, counter] of [
        [m.base, m.counter],
        [m.counter, m.base],
      ]) {
        const path = `/v2/exchanges/${pathOf(base)}/${pathOf(counter)}`;
        const raw = await get(`${path}?limit=400`);
        const reduced = await get(`${path}?reduce=true`);
        expect([path, reduced.status, reduced.body.count, reduced.body.exchanges.length]).toEqual([path, 200, 1, 1]);
        // every exchange of the pair, but those whose native leg is 0.0005 or less
        const tiny = raw.body.exchanges.length - aggregated(m.rows.map((e) => e.row)).length;
        expect([path, reduced.body.exchanges[0].count]).toEqual([path, raw.body.count - tiny]);
      }
    }
    // USD/XRP has no tiny leg: all 5
    expect((await get(`/v2/exchanges/${PAIR}?reduce=true`)).body.exchanges[0].count).toBe(
      (await get(`/v2/exchanges/${PAIR}`)).body.count,
    );
    // and over a window
    const window = qs({ start: '2015-01-14T18:28:40Z', end: '2015-01-14T18:51:40Z' });
    const raw = await get(`/v2/exchanges/${PAIR}${window}`);
    const reduced = await get(`/v2/exchanges/${PAIR}${window}&reduce=true`);
    expect(raw.body.count).toBe(2);
    expect(reduced.body.exchanges[0].count).toBe(2);
  });

  // -- the Exchange -----------------------------------------------------------------------------------------------

  describe('the exchange object', () => {
    it('every exchange of every pair is served as the original formats it, in both orientations', async () => {
      expect(MARKETS).toHaveLength(32);
      let total = 0;
      for (const m of MARKETS) {
        const forward = `/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}?limit=400`;
        const reverse = `/v2/exchanges/${pathOf(m.counter)}/${pathOf(m.base)}?limit=400`;
        const f = await get(forward);
        expect([forward, f.status]).toEqual([forward, 200]);
        expect([forward, f.body.exchanges]).toEqual([forward, exchangesOf(m.rows)]);
        total += f.body.count;
        const r = await get(reverse);
        expect([reverse, r.status]).toEqual([reverse, 200]);
        expect([reverse, r.body.exchanges]).toEqual([reverse, exchangesOf(m.rows, true)]);
      }
      expect(total).toBe(158);
    });

    it('has the keys of the HBase row: the d family, the f family, then the currencies and issuers', async () => {
      // the pair with an issuer on both sides, and the pair with the native currency
      const both = MARKETS.find((m) => m.base.issuer && m.counter.issuer) as Market;
      const issued = await get(`/v2/exchanges/${pathOf(both.base)}/${pathOf(both.counter)}?limit=1`);
      expect(Object.keys(issued.body.exchanges[0])).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'buyer',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
      ]);
      const native = await get(`/v2/exchanges/${PAIR}?limit=1`);
      expect(Object.keys(native.body.exchanges[0])).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'buyer',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
        'base_currency',
        'base_issuer',
        'counter_currency',
      ]);
      // key order, not only the keys, for every row of the mock ledgers
      const all = await get(`/v2/exchanges/${pathOf(both.base)}/${pathOf(both.counter)}?limit=400`);
      (all.body as ListBody).exchanges.forEach((ex, i) =>
        expect([i, Object.keys(ex)]).toEqual([i, Object.keys(exchangeOf(both.rows[i].row))]),
      );
    });

    it('amounts, rate and times are strings, the indexes and the offer sequence numbers', async () => {
      for (const m of MARKETS.slice(0, 12)) {
        const res = await get(`/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}?limit=400`);
        for (const ex of (res.body as ListBody).exchanges) {
          for (const field of ['base_amount', 'counter_amount', 'rate', 'executed_time', 'tx_hash', 'tx_type']) {
            expect([field, typeof ex[field]]).toEqual([field, 'string']);
          }
          for (const field of ['ledger_index', 'tx_index', 'node_index', 'offer_sequence']) {
            expect([field, typeof ex[field]]).toEqual([field, 'number']);
          }
          expect(['Payment', 'OfferCreate']).toContain(ex.tx_type);
          // what is stored for the API's own use, or that the original dropped, is not served
          for (const stored of [
            'client',
            'close_time',
            'base_amount_f',
            'counter_amount_f',
            'rate_f',
            'rowkey',
            'time',
          ]) {
            expect(ex).not.toHaveProperty(stored);
          }
        }
      }
    });

    it('rate is the rate to 8 significant digits, as a string, trailing zeros kept', async () => {
      const cnyEur = MARKETS[0];
      expect(pathOf(cnyEur.base)).toBe('CNY+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y');
      expect(cnyEur.rows[0].row.rate).toBe('0.13661202185792351593');
      const forward = await get(`/v2/exchanges/${pathOf(cnyEur.base)}/${pathOf(cnyEur.counter)}?limit=1`);
      expect(forward.body.exchanges[0].rate).toBe('0.13661202');
      // 14.64 CNY for 2 EUR: 7.32 EUR per CNY, written with 8 significant digits
      const reversed = await get(`/v2/exchanges/${pathOf(cnyEur.counter)}/${pathOf(cnyEur.base)}?limit=1`);
      expect(reversed.body.exchanges[0].rate).toBe('7.3200000');
    });

    it('amounts are the exact decimal text that is stored', async () => {
      const res = await get(`/v2/exchanges/${pathOf(MARKETS[0].base)}/${pathOf(MARKETS[0].counter)}?limit=1`);
      expect(res.body.exchanges[0].base_amount).toBe(MARKETS[0].rows[0].row.base_amount);
      expect(res.body.exchanges[0].counter_amount).toBe(MARKETS[0].rows[0].row.counter_amount);
    });

    it('executed_time is the close time of the ledger, YYYY-MM-DDTHH:mm:ssZ', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?limit=1`);
      expect(res.body.exchanges[0].executed_time).toBe('2015-01-14T18:27:20Z');
      expect(res.body.exchanges[0].executed_time).toBe(executedTime(USD_XRP.rows[0].row.close_time));
    });

    it('the native currency has no issuer key, on either side', async () => {
      const res = await get(`/v2/exchanges/${PAIR}`);
      for (const ex of (res.body as ListBody).exchanges) expect(ex).not.toHaveProperty('counter_issuer');
      const inverted = await get(`/v2/exchanges/xrp/${USD}`);
      for (const ex of (inverted.body as ListBody).exchanges) {
        expect(ex).not.toHaveProperty('base_issuer');
        expect(ex.counter_issuer).toBe(USD_ISSUER);
      }
    });

    it('the pair of the answer is the pair of the request, whatever the order the exchanges are stored in', async () => {
      for (const m of MARKETS) {
        for (const [b, c] of [
          [m.base, m.counter],
          [m.counter, m.base],
        ]) {
          const res = await get(`/v2/exchanges/${pathOf(b)}/${pathOf(c)}?limit=1`);
          const ex = res.body.exchanges[0];
          expect([
            pathOf(b),
            pathOf(c),
            ex.base_currency,
            ex.base_issuer,
            ex.counter_currency,
            ex.counter_issuer,
          ]).toEqual([pathOf(b), pathOf(c), b.currency, b.issuer, c.currency, c.issuer]);
        }
      }
    });

    it('autobridged fields are left out when the exchange was not autobridged', async () => {
      const res = await get(`/v2/exchanges/${PAIR}`);
      for (const ex of (res.body as ListBody).exchanges) {
        expect(ex).not.toHaveProperty('autobridged_currency');
        expect(ex).not.toHaveProperty('autobridged_issuer');
      }
    });
  });

  // -- the envelope -------------------------------------------------------------------------------------------------

  describe('the response', () => {
    it('is result, count, marker, exchanges', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?limit=2`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'marker', 'exchanges']);
      const last = await get(`/v2/exchanges/${PAIR}?limit=400`);
      expect(Object.keys(last.body)).toEqual(['result', 'count', 'exchanges']);
    });

    it('is only result, count and exchanges for a pair without exchanges', async () => {
      const res = await get(`/v2/exchanges/USD+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y/XRP`);
      expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, exchanges: [] }]);
    });

    it('has no base or counter at the top, whatever the pair (the original never served them)', async () => {
      const res = await get(`/v2/exchanges/xrp/${USD}`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'exchanges']);
    });
  });

  // -- the pair -------------------------------------------------------------------------------------------------------

  describe('/v2/exchanges/:base/:counter', () => {
    it('lists the exchanges of the pair and no other, oldest first', async () => {
      // the same currency with another issuer, and the same issuer with another currency, are other pairs
      const cnyXrp = MARKETS.find(
        (m) =>
          m.base.currency === 'CNY' &&
          m.base.issuer === 'rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y' &&
          m.counter.currency === 'XRP',
      ) as Market;
      const other = MARKETS.find(
        (m) => m.base.currency === 'CNY' && m.counter.currency === 'XRP' && m !== cnyXrp,
      ) as Market;
      const a = await get(`/v2/exchanges/${pathOf(cnyXrp.base)}/XRP`);
      const b = await get(`/v2/exchanges/${pathOf(other.base)}/XRP`);
      expect(a.body.count).toBe(13);
      expect(hashesIn(a.body)).toEqual(hashesOf(cnyXrp.rows));
      expect(hashesIn(b.body)).toEqual(hashesOf(other.rows));
      expect(hashesIn(a.body).filter((x) => hashesIn(b.body).includes(x))).toEqual([]);
    });

    it('a pair that has no exchanges, or does not exist → count 0', async () => {
      for (const path of [`USD+${USD_ISSUER}/GBP+${USD_ISSUER}`, `ABC+${USD_ISSUER}/XRP`, `XRP/ABC+${USD_ISSUER}`]) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 200, { result: 'success', count: 0, exchanges: [] }]);
      }
    });

    it('the same currency on both sides is a pair of its own, and so is XRP/XRP (both empty)', async () => {
      const res = await get(`/v2/exchanges/XRP/XRP`);
      expect([res.status, res.body]).toEqual([200, { result: 'success', count: 0, exchanges: [] }]);
      const same = await get(`/v2/exchanges/${USD}/${USD}`);
      expect([same.status, same.body.count]).toEqual([200, 0]);
    });

    it('pages exchanges by the whole key of the pair, bound and read in order', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/exchanges/xrp/${USD}?limit=3`);
      expect(res.status).toBe(200);
      const paging = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
      expect(paging).toHaveLength(1);
      const sql = String(paging[0][0]);
      const params = paging[0][1] as Record<string, unknown>;
      // the pair is the stored one (USD before XRP), however it was asked for
      expect(params).toMatchObject({ distinct_page_limit: 4 });
      expect(Object.values(params)).toEqual(expect.arrayContaining(['USD', USD_ISSUER, 'XRP', '']));
      // values are bound, never written into the SQL
      expect(sql).not.toContain(USD_ISSUER);
      expect(sql).toMatch(/base_currency = \{\w+:String\}/);
      expect(sql).toMatch(/counter_issuer = \{\w+:String\}/);
      expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      expect(sql).not.toMatch(/\bFINAL\b/);
      // the whole key, in the order of the table, and a row that was written twice counts once
      const key = 'base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index';
      expect(sql).toContain(
        `ORDER BY ${key
          .split(', ')
          .map((c) => `${c} ASC`)
          .join(', ')}`,
      );
      // read with a plain LIMIT, which stops the read after the page; outside it a row that was written twice counts once
      expect(sql).toMatch(/node_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}\)/);
      expect(sql).toMatch(/LIMIT 1 BY ledger_index, tx_index, node_index\s+LIMIT \{distinct_page_limit:UInt32\}/);
      // a resumed page compares the key after the pair, with its first column on its own for the primary key
      jest.restoreAllMocks();
      const resumed = jest.spyOn(h.ch, 'query');
      await get(`/v2/exchanges/${PAIR}?limit=3&marker=${markerOf(USD_XRP.rows[1].row)}&descending=true`);
      const second = resumed.mock.calls.find(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
      expect(String(second?.[0])).toContain(
        'ledger_index <= {k0:UInt32} AND (ledger_index, tx_index, node_index) < ({k0:UInt32}, {k1:UInt32}, {k2:UInt16})',
      );
      expect(String(second?.[0])).toContain(
        `ORDER BY ${key
          .split(', ')
          .map((c) => `${c} DESC`)
          .join(', ')}`,
      );
    });

    it('reads the table in the order of its primary key, so that a page never sorts the whole range', async () => {
      // the pair is fixed by the query, so this is the order of the key; spelled out in full ClickHouse reads the table
      // in that order and stops after the page. With only `ledger_index, tx_index, node_index` it sorts every row of
      // the pair in the range first, and on the mock ledgers it does for half of the pairs (found in Task 21 for
      // payments_by_currency), so every pair is checked, in both directions and with a marker
      for (const descending of [false, true]) {
        for (const [i, m] of MARKETS.entries()) {
          // the first few also with the autobridged filter
          for (const extra of i < 3 ? ['', '&autobridged=true'] : ['']) {
            const query = jest.spyOn(h.ch, 'query');
            await get(
              `/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}?limit=5&descending=${descending}${extra}&marker=${markerOf(m.rows[0].row)}`,
            );
            const calls = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
            expect(calls).toHaveLength(1);
            jest.restoreAllMocks();

            const [sql, params] = calls[0];
            const where = [pathOf(m.base), pathOf(m.counter), descending, extra];
            // in the order of the key, no sort, and a LIMIT on the read itself: it stops after the page
            await expectBoundedInOrderRead(h, String(sql), params as Record<string, unknown>, descending, where);
          }
        }
      }
    });
  });

  // -- the pair mistakes ----------------------------------------------------------------------------------------------

  describe('a pair that is not valid', () => {
    it('XRP with an issuer → 400, on either side', async () => {
      for (const path of [
        'XRP+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q/USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q',
        `${USD}/xrp.rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q`,
      ]) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([
          path,
          400,
          { result: 'error', message: 'XRP cannot have an issuer' },
        ]);
      }
    });

    it('a currency other than XRP needs an issuer: base first, then counter', async () => {
      const cases: [string, string][] = [
        ['USD/XRP', 'base issuer is required'],
        ['XRP/USD', 'counter issuer is required'],
        ['USD/EUR', 'base issuer is required'],
        [`USD+/XRP`, 'base issuer is required'],
        ['XAH/XRP', 'base issuer is required'],
      ];
      for (const [path, message] of cases) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
      }
    });

    it('a side without a currency → currency is required, base first', async () => {
      const issuer = USD_ISSUER;
      const cases: [string, string][] = [
        [`+${issuer}/XRP`, 'base currency is required'],
        [`XRP/+${issuer}`, 'counter currency is required'],
        [`+${issuer}/+${issuer}`, 'base currency is required'],
      ];
      for (const [path, message] of cases) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
      }
    });

    it('an issuer that is not an address → invalid issuer address (the original answered an empty 200)', async () => {
      for (const [path, message] of [
        ['USD+abc/XRP', 'invalid base issuer address'],
        [`XRP/USD+rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2`, 'invalid counter issuer address'],
        [`USD+${USD_ISSUER}/EUR+0000000000000000000000000000000`, 'invalid counter issuer address'],
      ]) {
        const res = await get(`/v2/exchanges/${path}`);
        expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message }]);
      }
    });

    it('the checks come in the order of the original: pair, start, end, limit, then the marker', async () => {
      const cases: [string, string][] = [
        [`/v2/exchanges/USD/XRP${qs({ start: 'x', end: 'y', limit: 'z', marker: '!' })}`, 'base issuer is required'],
        [`/v2/exchanges/${PAIR}${qs({ start: 'x', end: 'y', limit: 'z', marker: '!' })}`, 'invalid start date format'],
        [`/v2/exchanges/${PAIR}${qs({ end: 'y', limit: 'z', marker: '!' })}`, 'invalid end date format'],
        [`/v2/exchanges/${PAIR}${qs({ limit: 'z', marker: '!' })}`, 'invalid limit: NaN'],
        [`/v2/exchanges/${PAIR}${qs({ marker: '!' })}`, 'invalid marker'],
      ];
      for (const [url, message] of cases) {
        const res = await get(url);
        expect([url, res.status, res.body]).toEqual([url, 400, { result: 'error', message }]);
      }
    });
  });

  // -- the shared list behaviour ---------------------------------------------------------------------------------

  describe('the list', () => {
    it('empty range → count 0', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?start=2030-01-01&end=2030-12-31`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ result: 'success', count: 0, exchanges: [] });
      expect(res.headers.link).toBeUndefined();
    });

    it('a start after the last ledger → count 0; an end before the first → count 0', async () => {
      expect((await get(`/v2/exchanges/${PAIR}?start=2018-01-01`)).body.count).toBe(0);
      expect((await get(`/v2/exchanges/${PAIR}?end=2013-06-01`)).body.count).toBe(0);
    });

    it('marker pages concatenate to unpaged list', async () => {
      // the three busiest pairs of the mock ledgers (38, 30 and 13 exchanges)
      for (const m of [...MARKETS].sort((a, b) => b.rows.length - a.rows.length).slice(0, 3)) {
        const path = `/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}`;
        const unpaged = await get(`${path}?limit=400`);
        expect(unpaged.body.count).toBeGreaterThan(9);
        expect(unpaged.body.marker).toBeUndefined();
        expect(unpaged.headers.link).toBeUndefined();

        const paged = await pages(path, 3);
        expect(paged.slice(0, -1).every((p) => p.count === 3 && p.marker !== undefined)).toBe(true);
        expect(paged[paged.length - 1].marker).toBeUndefined();
        expect([path, paged.flatMap((p) => p.exchanges)]).toEqual([path, unpaged.body.exchanges]);
        // and the same pair the other way round
        const reversed = `/v2/exchanges/${pathOf(m.counter)}/${pathOf(m.base)}`;
        expect((await pages(reversed, 4)).flatMap((p) => p.exchanges)).toEqual(exchangesOf(m.rows, true));
      }
    });

    it('marker pages concatenate inside a window too', async () => {
      const busiest = MARKETS.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
      // from the second close time of the pair to the one before its last: the first and last ledgers are left out
      const times = [...new Set(busiest.rows.map((e) => e.row.close_time))].sort((a, b) => a - b);
      expect(times.length).toBeGreaterThan(4);
      const first = times[1];
      const last = times[times.length - 2];
      const window = `/v2/exchanges/${pathOf(busiest.base)}/${pathOf(busiest.counter)}${qs({
        start: executedTime(first).slice(0, 19),
        end: executedTime(last).slice(0, 19),
      })}`;
      const expected = busiest.rows.filter((e) => e.row.close_time >= first && e.row.close_time <= last);
      expect(expected.length).toBeGreaterThan(5);
      expect(expected.length).toBeLessThan(busiest.rows.length);
      const paged = await pages(window, 4);
      expect(paged.flatMap(hashesIn)).toEqual(hashesOf(expected));
    });

    it('descending reverses order', async () => {
      for (const m of [...MARKETS].sort((a, b) => b.rows.length - a.rows.length).slice(0, 3)) {
        const path = `/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}`;
        const asc = await get(`${path}?limit=400`);
        const desc = await get(`${path}?limit=400&descending=true`);
        expect(asc.body.count).toBeGreaterThan(1);
        expect([path, desc.body.exchanges]).toEqual([path, [...asc.body.exchanges].reverse()]);
        // the markers of a descending list continue downwards
        const pagedDesc = await pages(`${path}?descending=true`, 4);
        expect([path, pagedDesc.flatMap((p) => p.exchanges)]).toEqual([path, desc.body.exchanges]);
      }
    });

    it('descending: false and anything but /true/i is ascending', async () => {
      const asc = await get(`/v2/exchanges/${PAIR}?limit=3`);
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`/v2/exchanges/${PAIR}?limit=3&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get(`/v2/exchanges/${PAIR}?limit=3&descending=true`);
      expect((await get(`/v2/exchanges/${PAIR}?limit=3&descending=TRUE`)).body).toEqual(desc.body);
      expect(hashesIn(desc.body)).toEqual(hashesOf(USD_XRP.rows.slice(-3).reverse()));
    });

    it('unknown params ignored', async () => {
      const plain = await get(`/v2/exchanges/${PAIR}?limit=3`);
      const res = await get(`/v2/exchanges/${PAIR}?limit=3&foo=bar`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?limit=2&limit=50&descending=true&descending=false`);
      expect(res.body.count).toBe(2);
      expect(hashesIn(res.body)).toEqual(hashesOf(USD_XRP.rows.slice(-2).reverse()));
    });

    it('start and end are the ledgers that closed within them; a date with less than a second is the whole period', async () => {
      const cases: [Record<string, string>, string, string][] = [
        [{ start: '2015-01-14', end: '2015-01-14' }, '2015-01-14T00:00:00', '2015-01-15T00:00:00'],
        [{ start: '2015-01-14T18:28', end: '2015-01-14T18:28' }, '2015-01-14T18:28:00', '2015-01-14T18:29:00'],
        [{ start: '2015-01-14T18:28:40Z', end: '2015-01-14T18:28:40Z' }, '2015-01-14T18:28:40', '2015-01-14T18:28:41'],
        [{ start: '2013' }, '2013-01-01T00:00:00', '2100-01-01T00:00:00'],
        [{ end: '2015-01' }, '2000-01-01T00:00:00', '2015-02-01T00:00:00'],
      ];
      for (const [params, from, before] of cases) {
        const expected = closedBetween(USD_XRP.rows, from, before);
        const listed = (await pages(`/v2/exchanges/${PAIR}${qs(params)}`, 100)).flatMap(hashesIn);
        expect([params, listed]).toEqual([params, hashesOf(expected)]);
      }
      expect(closedBetween(USD_XRP.rows, '2015-01-14T18:28:40', '2015-01-14T18:28:41')).toHaveLength(1);
    });

    it('start defaults to 2013-01-01; an empty start is the default, an empty end is invalid', async () => {
      expect((await get(`/v2/exchanges/${PAIR}?start=`)).body.count).toBe(5);
      const res = await get(`/v2/exchanges/${PAIR}?end=`);
      expect([res.status, res.body.message]).toEqual([400, 'invalid end date format']);
      // before the default: nothing is lost, the mock ledgers are all later
      expect((await get(`/v2/exchanges/${PAIR}?start=2012-01-01`)).body.count).toBe(5);
    });

    it('invalid dates in every form the original rejects', async () => {
      for (const start of ['2015-13-01', '2015-02-30', 'yesterday', '12-12-2014', '2015-01-14T25:00:00', '0']) {
        const res = await get(`/v2/exchanges/${PAIR}${qs({ start })}`);
        expect([start, res.status, res.body.message]).toEqual([start, 400, 'invalid start date format']);
      }
    });

    // -- limit --

    it('limit is 200 by default, at most 400; below one is the default, a decimal is cut, NaN is an error', async () => {
      const cases: [string, number][] = [
        ['', 200],
        ['limit=1', 1],
        ['limit=7', 7],
        ['limit=400', 400],
        ['limit=401', 400],
        ['limit=100000', 400],
        ['limit=Infinity', 400],
        ['limit=0', 200],
        ['limit=-5', 200],
        ['limit=', 200],
        ['limit=2.9', 2],
        ['limit=1e2', 100],
      ];
      for (const [query, rows] of cases) {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(`/v2/exchanges/${PAIR}?${query}`);
        // one more than the page is asked for: the extra row tells whether there is a next page
        const paging = spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
        expect([query, res.status, paging[0][1]]).toEqual([
          query,
          200,
          expect.objectContaining({ distinct_page_limit: rows + 1 }),
        ]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, 5)]);
        jest.restoreAllMocks();
      }
      for (const limit of ['abc', 'NaN', '12px', '1,5', '0x', 'one']) {
        const res = await get(`/v2/exchanges/${PAIR}?limit=${limit}`);
        expect([limit, res.status, res.body]).toEqual([limit, 400, { result: 'error', message: 'invalid limit: NaN' }]);
      }
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      const last = await get(`/v2/exchanges/${PAIR}?limit=400`);
      expect(last.body.marker).toBeUndefined();
      expect(last.headers.link).toBeUndefined();

      // exactly as many as the limit: no marker either
      const exact = await get(`/v2/exchanges/${PAIR}?limit=5`);
      expect(exact.body.count).toBe(5);
      expect(exact.body.marker).toBeUndefined();
      expect(exact.headers.link).toBeUndefined();

      const more = await get(`/v2/exchanges/${PAIR}?limit=4`);
      expect(more.body.count).toBe(4);
      expect(more.body.marker).toBe(markerOf(USD_XRP.rows[3].row));
      expect(more.headers.link).toContain(`marker=${more.body.marker}`);
    });

    it('Link keeps the request: the params in their order, the marker in place or at the end', async () => {
      const first = await get(`/v2/exchanges/${USD}/XRP${qs({ limit: 2, start: '2013-01-01T00:00:00+00:00' })}`);
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}/v2/exchanges/${USD}/XRP?limit=2&start=2013-01-01T00:00:00%2B00:00&marker=${first.body.marker}>; rel="next"`,
      );
      const second = await get(`/v2/exchanges/${PAIR}?limit=2&marker=${markerOf(USD_XRP.rows[3].row)}&descending=true`);
      expect(second.headers.link).toBe(
        `<${new URL(second.request.url).origin}/v2/exchanges/${PAIR}?limit=2&marker=${second.body.marker}&descending=true>; rel="next"`,
      );
    });

    // -- marker --

    it('tampered marker → 400 invalid marker', async () => {
      const bad = [
        'USD|rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q|XRP||20150114182720|000011119603|00012|00004',
        '!!!',
        Buffer.from('not json').toString('base64url'),
        Buffer.from('[1]').toString('base64url'),
        Buffer.from('[1,2]').toString('base64url'),
        Buffer.from('[1,2,3,4]').toString('base64url'),
        Buffer.from('["a",1,2]').toString('base64url'),
        Buffer.from('[-1,0,0]').toString('base64url'),
        Buffer.from('[1,2,70000]').toString('base64url'),
        Buffer.from('{"a":1}').toString('base64url'),
        `${markerOf(USD_XRP.rows[3].row)}x!`,
      ];
      for (const path of [`/v2/exchanges/${PAIR}`, '/v2/exchanges']) {
        for (const marker of bad) {
          const res = await get(`${path}?marker=${encodeURIComponent(marker)}`);
          expect([path, marker, res.status, res.body]).toEqual([
            path,
            marker,
            400,
            { result: 'error', message: 'invalid marker' },
          ]);
        }
      }
    });

    it('a marker continues strictly after its row', async () => {
      const rows = USD_XRP.rows;
      const asc = await get(`/v2/exchanges/${PAIR}?limit=2&marker=${markerOf(rows[1].row)}`);
      expect(hashesIn(asc.body)).toEqual(hashesOf(rows.slice(2, 4)));
      const desc = await get(`/v2/exchanges/${PAIR}?limit=2&descending=true&marker=${markerOf(rows[3].row)}`);
      expect(hashesIn(desc.body)).toEqual(hashesOf([rows[2], rows[1]]));
      // a marker beyond the stored history is still a marker
      const beyond = await get(`/v2/exchanges/${PAIR}?marker=${Buffer.from('[999999999,0,0]').toString('base64url')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, exchanges: [] });
      // the node of the row is part of the key: two exchanges of one transaction
      const sameTx = USD_XRP.rows.filter((e) => e.row.ledger_index === 11119603);
      expect(sameTx).toHaveLength(2);
      const nextNode = await get(`/v2/exchanges/${PAIR}?limit=1&marker=${markerOf(sameTx[0].row)}`);
      expect(hashesIn(nextNode.body)).toEqual(hashesOf([sameTx[1]]));
    });

    it('a marker does not matter when the range is empty', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?start=2030-01-01&marker=${markerOf(USD_XRP.rows[1].row)}`);
      expect(res.body).toEqual({ result: 'success', count: 0, exchanges: [] });
    });

    it('is 500 unable to retrieve exchanges when the database fails', async () => {
      for (const path of [`/v2/exchanges/${PAIR}`, '/v2/exchanges']) {
        jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
        const res = await get(path);
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve exchanges' });
      }
    });

    it('is 500 unable to retrieve exchanges when the page fails after the range was found', async () => {
      for (const path of [`/v2/exchanges/${PAIR}`, '/v2/exchanges']) {
        const real = h.ch.query.bind(h.ch);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sql.includes(Table.Exchanges) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([
          path,
          500,
          { result: 'error', message: 'unable to retrieve exchanges' },
        ]);
        jest.restoreAllMocks();
      }
    });
  });

  // -- CSV --------------------------------------------------------------------------------------------------------

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('format=csv → text/csv, one row per exchange, the columns of the original in its order', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('exchanges - USD-XRP'));
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 5);
      expect(rows[0]).toBe(CSV_COLUMNS.map((c) => `"${c}"`).join(','));
      // the first row, cell by cell: what the pair does not have (the issuer of XRP, autobridging) is empty
      const e = USD_XRP.rows[0].row;
      const cells: Record<string, string | number> = {
        base_currency: 'USD',
        base_issuer: USD_ISSUER,
        base_amount: e.base_amount,
        counter_amount: e.counter_amount,
        counter_currency: 'XRP',
        counter_issuer: '',
        rate: new BigNumber(e.rate).toPrecision(8),
        executed_time: executedTime(e.close_time),
        ledger_index: e.ledger_index,
        buyer: e.buyer,
        seller: e.seller,
        taker: e.taker,
        provider: e.provider,
        autobridged_currency: '',
        autobridged_issuer: '',
        offer_sequence: e.offer_sequence,
        tx_type: e.tx_type,
        tx_index: e.tx_index,
        node_index: e.node_index,
        tx_hash: e.tx_hash,
      };
      expect(rows[1]).toBe(CSV_COLUMNS.map((c) => `"${cells[c]}"`).join(','));
    });

    it('is named after the pair as it was asked for: exchanges - BASE-COUNTER', async () => {
      const reversed = await get(`/v2/exchanges/xrp/${USD}?format=csv`);
      expect(reversed.headers['content-disposition']).toBe(csvDisposition('exchanges - XRP-USD'));
      // the first row is the same exchange, the other way round
      const header = lines(reversed.text)[0].split(',');
      expect(header).toEqual(CSV_COLUMNS.map((c) => `"${c}"`));
      const row = lines(reversed.text)[1].split(',');
      expect(row[0]).toBe('"XRP"');
      expect(row[1]).toBe('""');
      expect(row[4]).toBe('"USD"');
      expect(row[5]).toBe(`"${USD_ISSUER}"`);
      expect(row[2]).toBe(`"${USD_XRP.rows[0].row.counter_amount}"`);
    });

    it('has the columns of every row, whatever the first one has', async () => {
      // CNY/EUR has no autobridged exchanges, the pair of the first row may differ from the others in what it holds
      const m = MARKETS[0];
      const res = await get(`/v2/exchanges/${pathOf(m.base)}/${pathOf(m.counter)}?format=csv&limit=400`);
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + m.rows.length);
      for (const row of rows.slice(1)) expect(row.split(',')).toHaveLength(CSV_COLUMNS.length);
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get(`/v2/exchanges/${PAIR}?format=CSV&limit=1`)).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`/v2/exchanges/${PAIR}?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page, and the same rows as the JSON', async () => {
      const csv = await get(`/v2/exchanges/${PAIR}?format=csv&limit=2`);
      const json = await get(`/v2/exchanges/${PAIR}?limit=2`);
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/exchanges/${PAIR}?format=csv&limit=2&marker=${json.body.marker}>; rel="next"`,
      );
      expect(lines(csv.text)).toHaveLength(1 + 2);
      expect((await get(`/v2/exchanges/${PAIR}?format=csv&limit=400`)).headers.link).toBeUndefined();
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get(`/v2/exchanges/${PAIR}?format=csv&start=2030-01-01`);
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get('/v2/exchanges/USD/XRP?format=csv');
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'base issuer is required' });
    });
  });

  // -- the aggregated path: interval and reduce -----------------------------------------------------------------------

  describe('interval and reduce', () => {
    type Candle = Record<string, unknown>;
    const marketOf = (base: string, counter: string): Market =>
      MARKETS.find((m) => pathOf(m.base) === base && pathOf(m.counter) === counter) as Market;
    /** CNY+rnuF…/XRP: two of its four exchanges have an XRP leg of 0.000001. */
    const TINY = marketOf('CNY+rnuF96W4SZoCJmbHYBFoJZpR8eCaxNvekK', 'XRP');
    const startsOf = (body: { exchanges: Candle[] }): unknown[] => body.exchanges.map((c) => c.start);
    const b64 = (text: string): string => Buffer.from(text).toString('base64url');
    const NO_PAIR = `/v2/exchanges/${USD}/EUR+rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B`;
    const exchangesCalls = (spy: jest.SpyInstance): unknown[][] =>
      spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));

    it("candles of every pair, in both orientations and every interval, are the original's aggregation", async () => {
      let candles = 0;
      for (const interval of EXCHANGE_INTERVALS) {
        for (const m of MARKETS) {
          for (const inverted of [false, true]) {
            const [base, counter] = inverted ? [m.counter, m.base] : [m.base, m.counter];
            const path = `/v2/exchanges/${pathOf(base)}/${pathOf(counter)}?interval=${interval}&limit=400`;
            const res = await get(path);
            expect([path, res.status, res.body.result, res.body.count]).toEqual([
              path,
              200,
              'success',
              res.body.exchanges.length,
            ]);
            expect([path, res.body.marker]).toEqual([path, undefined]);
            expectAggregates(path, res.body.exchanges, candlesOf(m, interval, inverted));
            candles += res.body.count;
          }
        }
      }
      // the mock exchanges lie within 25 minutes: one candle per pair for most intervals, more for the minutes
      expect(candles).toBeGreaterThan(EXCHANGE_INTERVALS.length * MARKETS.length * 2);
    });

    it("reduce of every pair, in both orientations, is the original's reduction", async () => {
      for (const m of MARKETS) {
        for (const inverted of [false, true]) {
          const [base, counter] = inverted ? [m.counter, m.base] : [m.base, m.counter];
          const path = `/v2/exchanges/${pathOf(base)}/${pathOf(counter)}?reduce=true`;
          const res = await get(path);
          expect([path, res.status, res.body.result, res.body.count, res.body.marker]).toEqual([
            path,
            200,
            'success',
            1,
            undefined,
          ]);
          expectAggregates(path, res.body.exchanges, [reducedOf(m, inverted, '2013-01-01T00:00:00Z')]);
        }
      }
    });

    it('a candle has the keys of the agg_exchanges row, then the pair; the reduced row those of the reduce literal', async () => {
      const KEYS = [
        'base_volume',
        'buy_volume',
        'close',
        'close_time',
        'count',
        'counter_volume',
        'high',
        'low',
        'open',
        'open_time',
        'start',
        'vwap',
      ];
      const both = MARKETS.find((m) => m.base.issuer && m.counter.issuer) as Market;
      const issued = await get(`/v2/exchanges/${pathOf(both.base)}/${pathOf(both.counter)}?interval=1day`);
      expect(Object.keys(issued.body.exchanges[0])).toEqual([
        ...KEYS,
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
      ]);
      // the native currency has no issuer key, on either side
      const native = await get(`/v2/exchanges/${PAIR}?interval=1day`);
      expect(Object.keys(native.body.exchanges[0])).toEqual([
        ...KEYS,
        'base_currency',
        'base_issuer',
        'counter_currency',
      ]);
      const inverted = await get(`/v2/exchanges/xrp/${USD}?interval=1day`);
      expect(Object.keys(inverted.body.exchanges[0])).toEqual([
        ...KEYS,
        'base_currency',
        'counter_currency',
        'counter_issuer',
      ]);
      const reduced = await get(`/v2/exchanges/${PAIR}?reduce=true`);
      expect(Object.keys(reduced.body.exchanges[0])).toEqual([
        'open',
        'high',
        'low',
        'close',
        'base_volume',
        'counter_volume',
        'buy_volume',
        'count',
        'open_time',
        'close_time',
        'vwap',
        'start',
        'base_currency',
        'base_issuer',
        'counter_currency',
      ]);
      // the response is the list of the raw route
      expect(Object.keys(native.body)).toEqual(['result', 'count', 'exchanges']);
      expect(Object.keys(reduced.body)).toEqual(['result', 'count', 'exchanges']);
    });

    it('prices are 8 significant digits, volumes text, count and buy volume numbers, times YYYY-MM-DDTHH:mm:ssZ', async () => {
      for (const query of ['interval=1minute', 'interval=1month', 'reduce=true']) {
        for (const path of [`/v2/exchanges/${PAIR}`, `/v2/exchanges/xrp/${USD}`]) {
          const res = await get(`${path}?${query}`);
          expect(res.body.exchanges.length).toBeGreaterThan(0);
          for (const c of res.body.exchanges as Candle[]) {
            const where = [path, query];
            for (const k of ['open', 'high', 'low', 'close', 'vwap']) {
              expect([where, k, typeof c[k]]).toEqual([where, k, 'string']);
              expect([where, k, new BigNumber(c[k] as string).toPrecision(8)]).toEqual([where, k, c[k]]);
            }
            expect([where, typeof c.base_volume, typeof c.counter_volume]).toEqual([where, 'string', 'string']);
            expect([where, typeof c.count, typeof c.buy_volume]).toEqual([where, 'number', 'number']);
            for (const k of ['open_time', 'close_time', 'start']) {
              expect([where, k, c[k]]).toEqual([where, k, expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)]);
            }
          }
        }
      }
    });

    it('USD/XRP by hand: the minutes, and the buy volume of either side', async () => {
      const minutes = await get(`/v2/exchanges/${PAIR}?interval=1minute`);
      expect((minutes.body.exchanges as Candle[]).map((c) => [c.start, c.count])).toEqual([
        ['2015-01-14T18:27:00Z', 2],
        ['2015-01-14T18:28:00Z', 1],
        ['2015-01-14T18:51:00Z', 1],
        ['2015-01-14T18:52:00Z', 1],
      ]);
      // 11119603/1/1 and 11119603/12/4, both at 68.16632582, both bought by the taker
      const first = minutes.body.exchanges[0];
      expect(first).toMatchObject({
        open: '68.166326',
        high: '68.166326',
        low: '68.166326',
        close: '68.166326',
        vwap: '68.166326',
        open_time: '2015-01-14T18:27:20Z',
        close_time: '2015-01-14T18:27:20Z',
      });
      // 49.99600000000001 + 0.00399999999999: exactly 50 (the original's float sum said 50.00000000000001 or so)
      expect([first.base_volume, first.counter_volume, first.buy_volume]).toEqual(['50', '3408.316291', 50]);

      // three exchanges bought by the taker (base 72.136…), two sold (counter 9221.21…)
      const forward = (await get(`/v2/exchanges/${PAIR}?reduce=true`)).body.exchanges[0];
      expect(forward).toMatchObject({
        count: 5,
        open: '68.166326',
        close: '68.493151',
        high: '68.493151',
        low: '68.166326',
      });
      expect([forward.base_volume, forward.counter_volume, forward.buy_volume]).toEqual([
        '206.76632937372958',
        '14144.991191',
        72.13661005922958,
      ]);
      const inverted = (await get(`/v2/exchanges/xrp/${USD}?reduce=true`)).body.exchanges[0];
      expect(inverted).toMatchObject({
        count: 5,
        open: p8(new Wide(1).dividedBy('68.16632582')),
        close: p8(new Wide(1).dividedBy('68.49315073184462378893')),
        // high is 1 / the lowest rate, low is 1 / the highest
        high: p8(new Wide(1).dividedBy('68.16632582')),
        low: p8(new Wide(1).dividedBy('68.49315073184462378893')),
        base_currency: 'XRP',
        counter_currency: 'USD',
        counter_issuer: USD_ISSUER,
      });
      expect([inverted.base_volume, inverted.counter_volume, inverted.buy_volume]).toEqual([
        '14144.991191',
        '206.76632937372958',
        9221.213658,
      ]);
      expect(inverted.vwap).toBe(p8(new Wide(1).dividedBy(forward.vwap)));
    });

    it('native legs of 0.0005 or less are left out, the pair asked for either way round', async () => {
      expect(TINY.rows).toHaveLength(4);
      expect(TINY.rows.filter((e) => Number(e.row.counter_amount) <= 0.0005)).toHaveLength(2);
      for (const path of [`/v2/exchanges/${pathOf(TINY.base)}/XRP`, `/v2/exchanges/XRP/${pathOf(TINY.base)}`]) {
        // the raw list keeps them
        expect([path, (await get(path)).body.count]).toEqual([path, 4]);
        expect([path, (await get(`${path}?reduce=true`)).body.exchanges[0].count]).toEqual([path, 2]);
        const minutes = await get(`${path}?interval=1minute`);
        expect([path, (minutes.body.exchanges as Candle[]).map((c) => [c.start, c.count])]).toEqual([
          path,
          [['2015-01-14T18:27:00Z', 2]],
        ]);
      }
      // CNY+rKiC…/XRP: one of 13 has an XRP leg of 0.000001
      const cny = marketOf('CNY+rKiCet8SdvWxPXnAgYarFUXMh1zCPz432Y', 'XRP');
      expect(cny.rows).toHaveLength(13);
      expect((await get(`/v2/exchanges/${pathOf(cny.base)}/XRP?reduce=true`)).body.exchanges[0].count).toBe(12);
    });

    it('reduce aggregates the whole window: neither limit nor marker cuts it, and it has no marker', async () => {
      const busiest = MARKETS.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
      expect(busiest.rows).toHaveLength(38);
      const path = `/v2/exchanges/${pathOf(busiest.base)}/${pathOf(busiest.counter)}`;
      for (const query of [
        'reduce=true&limit=5',
        'reduce=true&limit=1',
        `reduce=true&limit=5&marker=${markerOf(busiest.rows[3].row)}`,
        'reduce=true&limit=5&descending=true',
      ]) {
        const res = await get(`${path}?${query}`);
        expect([query, res.status, res.body.count, res.body.marker, res.headers.link]).toEqual([
          query,
          200,
          1,
          undefined,
          undefined,
        ]);
        expectAggregates(query, res.body.exchanges, [reducedOf(busiest, false, '2013-01-01T00:00:00Z')]);
      }
      // the original reduced the first page of the scan only (200 by default, 400 at most)
      expect((await get(`${path}?reduce=true&limit=5`)).body.exchanges[0].count).toBe(38);
    });

    it('reduce of a window: the exchanges of the ledgers that closed in it; start is the start of the window', async () => {
      const window = qs({ start: '2015-01-14T18:28:40Z', end: '2015-01-14T18:51:40Z' });
      const rows = closedBetween(USD_XRP.rows, '2015-01-14T18:28:40', '2015-01-14T18:51:41').map((e) => e.row);
      expect(rows).toHaveLength(2);
      for (const inverted of [false, true]) {
        const path = inverted ? `/v2/exchanges/xrp/${USD}` : `/v2/exchanges/${PAIR}`;
        const res = await get(`${path}${window}&reduce=true`);
        expectAggregates([path, window], res.body.exchanges, [
          reducedOf(USD_XRP, inverted, '2015-01-14T18:28:40Z', rows),
        ]);
      }
      // start as it was asked for, to the second
      const day = await get(`/v2/exchanges/xrp/${USD}?reduce=true&start=2015-01-14`);
      expectAggregates('day', day.body.exchanges, [reducedOf(USD_XRP, true, '2015-01-14T00:00:00Z')]);
      const empty = await get(`/v2/exchanges/xrp/${USD}?reduce=true&start=`);
      expect(empty.body.exchanges[0].start).toBe('2013-01-01T00:00:00Z');
    });

    it('reduce of an empty window is the row of zeros the original answered', async () => {
      const res = await get(`/v2/exchanges/${PAIR}?reduce=true&start=2030-01-01&end=2030-12-31`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        result: 'success',
        count: 1,
        exchanges: [
          {
            open: '0.0000000',
            high: '0.0000000',
            low: '0.0000000',
            close: '0.0000000',
            base_volume: '0',
            counter_volume: '0',
            buy_volume: 0,
            count: 0,
            vwap: '0.0000000',
            start: '2030-01-01T00:00:00Z',
            base_currency: 'USD',
            base_issuer: USD_ISSUER,
            counter_currency: 'XRP',
          },
        ],
      });
      // ledgers, but no exchange of the pair in them; and a pair that never traded
      for (const path of [`/v2/exchanges/${PAIR}?reduce=true&end=2015-01-14T18:27:10Z`, `${NO_PAIR}?reduce=true`]) {
        const none = await get(path);
        expect([path, none.status, none.body.count]).toEqual([path, 200, 1]);
        expectAggregates(path, none.body.exchanges, [
          reducedOf(
            path.startsWith(NO_PAIR)
              ? { ...USD_XRP, counter: { currency: 'EUR', issuer: 'rvYAfWj5gh67oV6fW32ZzP3Aw4Eubs59B' } }
              : USD_XRP,
            false,
            '2013-01-01T00:00:00Z',
            [],
          ),
        ]);
      }
    });

    it('reduce reads the window to the second, as the candles and the original do', async () => {
      // USD/XRP: 18:27:20 (2), 18:28:40 (11119619), 18:51:40 (11119932), 18:52:10 (11119940)
      const reduced = async (params: Record<string, string>): Promise<Candle> =>
        (await get(`/v2/exchanges/${PAIR}${qs({ ...params, reduce: 'true' })}`)).body.exchanges[0];
      // a start inside the second of a ledger takes that ledger
      expect((await reduced({ start: '2015-01-14T18:28:40.500Z' })).count).toBe(3);
      expect((await reduced({ start: '2015-01-14T18:28:40Z' })).count).toBe(3);
      expect((await reduced({ start: '2015-01-14T18:28:41Z' })).count).toBe(2);
      // an end of …:40.500 is the period up to :40.501, which the original's row keys read as up to :40
      expect((await reduced({ start: '2015-01-14T18:28:40.500Z', end: '2015-01-14T18:51:40.500Z' })).count).toBe(1);
      expect((await reduced({ start: '2015-01-14T18:28:40Z', end: '2015-01-14T18:51:40Z' })).count).toBe(2);
      // start as it was asked for, to the second
      expect((await reduced({ start: '2015-01-14T18:28:40.500Z' })).start).toBe('2015-01-14T18:28:40Z');
      // the candles read the window the same way
      const minutes = await get(
        `/v2/exchanges/${PAIR}${qs({ interval: '1minute', start: '2015-01-14T18:28:00.500Z', end: '2015-01-14T18:51:00.500Z' })}`,
      );
      expect(startsOf(minutes.body)).toEqual(['2015-01-14T18:28:00Z']);
    });

    it('unknown params ignored, with an interval and with reduce', async () => {
      for (const query of ['interval=1minute&limit=2', 'interval=week&descending=true', 'reduce=true']) {
        const plain = await get(`/v2/exchanges/${PAIR}?${query}`);
        const res = await get(`/v2/exchanges/${PAIR}?${query}&foo=bar&intervals=1day&reduced=false`);
        expect([query, res.status, res.body]).toEqual([query, 200, plain.body]);
      }
    });

    it('an interval on an empty window → no rows', async () => {
      for (const path of [
        `/v2/exchanges/${PAIR}?interval=1hour&start=2030-01-01&end=2030-12-31`,
        `/v2/exchanges/${PAIR}?interval=1minute&end=2015-01-14T18:26:59Z`,
        `/v2/exchanges/${PAIR}?interval=1year&start=2015-01-14T18:00:00Z`,
        `${NO_PAIR}?interval=1day`,
      ]) {
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([path, 200, { result: 'success', count: 0, exchanges: [] }]);
        expect([path, res.headers.link]).toEqual([path, undefined]);
      }
    });

    it('the buckets are those that start in the window, each of them whole', async () => {
      // [params, interval, the first bucket start (inclusive), the bucket starts before (exclusive)]
      const cases: [Record<string, string>, string, string, string][] = [
        // a start inside a bucket leaves that bucket out, though it holds exchanges after the start
        [{ start: '2015-01-14T18:27:30Z' }, '5minute', '2015-01-14T18:27:30', '2100-01-01T00:00:00'],
        [{ start: '2015-01-14T18:00:01Z' }, '1hour', '2015-01-14T18:00:01', '2100-01-01T00:00:00'],
        // an end inside a bucket takes it whole, with the exchanges after the end
        [{ end: '2015-01-14T18:30:00Z' }, '1hour', '2013-01-01T00:00:00', '2015-01-14T18:30:01'],
        [{ end: '2015-01-14T18:27:10Z' }, '1minute', '2013-01-01T00:00:00', '2015-01-14T18:27:11'],
        [
          { start: '2015-01-14T18:28', end: '2015-01-14T18:51' },
          '1minute',
          '2015-01-14T18:28:00',
          '2015-01-14T18:52:00',
        ],
        [{ start: '2015-01-14T18', end: '2015-01-14T18' }, '1hour', '2015-01-14T18:00:00', '2015-01-14T19:00:00'],
        [
          { start: '2015-01-14T00:00:00Z', end: '2015-01-14T00:00:00Z' },
          '1day',
          '2015-01-14T00:00:00',
          '2015-01-14T00:00:01',
        ],
        [{ start: '2015-01-14T00:00:01Z' }, '1day', '2015-01-14T00:00:01', '2100-01-01T00:00:00'],
        [
          { start: '2015-01-14T18:25:00Z', end: '2015-01-14T18:50:00Z' },
          '5minute',
          '2015-01-14T18:25:00',
          '2015-01-14T18:50:01',
        ],
        // the original read the start and the end to the second
        [{ start: '2015-01-14T18:25:00.900Z' }, '5minute', '2015-01-14T18:25:00', '2100-01-01T00:00:00'],
        [{ end: '2015-01-14T18:50:00.500Z' }, '5minute', '2013-01-01T00:00:00', '2015-01-14T18:50:00'],
      ];
      for (const [params, interval, from, before] of cases) {
        for (const inverted of [false, true]) {
          for (const descending of [false, true]) {
            const expected = candlesOf(USD_XRP, interval, inverted).filter(
              (c) => unix(c.start) >= unix(from) && unix(c.start) < unix(before),
            );
            if (descending) expected.reverse();
            const path = `${inverted ? `/v2/exchanges/xrp/${USD}` : `/v2/exchanges/${PAIR}`}${qs({
              ...params,
              interval,
              ...(descending && { descending: 'true' }),
            })}`;
            const res = await get(path);
            expect([path, res.status]).toEqual([path, 200]);
            expectAggregates(path, res.body.exchanges, expected);
          }
        }
      }
      // the cases are not trivial: by hand
      const counts = async (query: string): Promise<unknown[]> =>
        ((await get(`/v2/exchanges/${PAIR}?${query}`)).body.exchanges as Candle[]).map((c) => [c.start, c.count]);
      expect(await counts('interval=5minute')).toEqual([
        ['2015-01-14T18:25:00Z', 3],
        ['2015-01-14T18:50:00Z', 2],
      ]);
      expect(await counts('interval=5minute&start=2015-01-14T18:27:30Z')).toEqual([['2015-01-14T18:50:00Z', 2]]);
      expect(await counts('interval=1hour&end=2015-01-14T18:30:00Z')).toEqual([['2015-01-14T18:00:00Z', 5]]);
      expect(await counts('interval=1minute&end=2015-01-14T18:27:10Z')).toEqual([['2015-01-14T18:27:00Z', 2]]);
    });

    it('candle pages: the marker is the start of the last bucket of the page; the pages make up the list', async () => {
      for (const path of [`/v2/exchanges/${PAIR}`, `/v2/exchanges/xrp/${USD}`]) {
        const unpaged = await get(`${path}?interval=1minute`);
        expect(unpaged.body.count).toBe(4);
        expect(unpaged.body.marker).toBeUndefined();
        for (const limit of [1, 2, 3]) {
          const paged = await pages(`${path}?interval=1minute`, limit);
          expect([path, limit, paged.flatMap((p) => p.exchanges)]).toEqual([path, limit, unpaged.body.exchanges]);
          expect(paged.slice(0, -1).every((p) => p.count === limit && p.marker !== undefined)).toBe(true);
        }
        // descending reverses, and its markers continue downwards
        const desc = await get(`${path}?interval=1minute&descending=true`);
        expect(desc.body.exchanges).toEqual([...unpaged.body.exchanges].reverse());
        const pagedDesc = await pages(`${path}?interval=1minute&descending=true`, 3);
        expect(pagedDesc.flatMap((p) => p.exchanges)).toEqual(desc.body.exchanges);
      }
      const first = await get(`/v2/exchanges/${PAIR}?interval=1minute&limit=1`);
      expect(first.body.marker).toBe(bucketMarker('2015-01-14T18:27:00'));
      const origin = new URL(first.request.url).origin;
      expect(first.headers.link).toBe(
        `<${origin}/v2/exchanges/${PAIR}?interval=1minute&limit=1&marker=${first.body.marker}>; rel="next"`,
      );
      // exactly as many as the limit: no marker
      const exact = await get(`/v2/exchanges/${PAIR}?interval=1minute&limit=4`);
      expect([exact.body.count, exact.body.marker, exact.headers.link]).toEqual([4, undefined, undefined]);
    });

    it('a candle marker continues strictly after its bucket, whatever time it holds', async () => {
      const starts = async (query: string): Promise<unknown[]> =>
        startsOf((await get(`/v2/exchanges/${PAIR}?interval=1minute&${query}`)).body);
      expect(await starts(`marker=${bucketMarker('2015-01-14T18:28:00')}`)).toEqual([
        '2015-01-14T18:51:00Z',
        '2015-01-14T18:52:00Z',
      ]);
      expect(await starts(`marker=${bucketMarker('2015-01-14T18:28:00')}&descending=true`)).toEqual([
        '2015-01-14T18:27:00Z',
      ]);
      // a time inside a bucket (the marker of another interval): the buckets that start after it, or before it
      expect(await starts(`marker=${bucketMarker('2015-01-14T18:28:30')}`)).toEqual([
        '2015-01-14T18:51:00Z',
        '2015-01-14T18:52:00Z',
      ]);
      expect(await starts(`marker=${bucketMarker('2015-01-14T18:28:30')}&descending=true`)).toEqual([
        '2015-01-14T18:28:00Z',
        '2015-01-14T18:27:00Z',
      ]);
      // the window still bounds the list
      expect(await starts(`end=2015-01-14T18:51:00Z&marker=${bucketMarker('2015-01-14T18:27:00')}`)).toEqual([
        '2015-01-14T18:28:00Z',
        '2015-01-14T18:51:00Z',
      ]);
      // a marker beyond the history is still a marker
      const beyond = await get(`/v2/exchanges/${PAIR}?interval=1minute&marker=${bucketMarker('2030-01-01T00:00:00')}`);
      expect(beyond.body).toEqual({ result: 'success', count: 0, exchanges: [] });
    });

    it('tampered candle marker → 400 invalid marker; the markers of the raw list and of candles do not mix', async () => {
      const bad = [
        '!!!',
        b64('not json'),
        b64('[]'),
        b64('[1,2]'),
        b64('[-1]'),
        b64('[1.5]'),
        b64('["2015-01-14T18:27:00Z"]'),
        b64('[4294967296]'),
        b64('{"a":1}'),
        markerOf(USD_XRP.rows[1].row),
      ];
      for (const query of ['interval=1hour', 'interval=1minute&descending=true']) {
        for (const marker of bad) {
          const res = await get(`/v2/exchanges/${PAIR}?${query}&marker=${encodeURIComponent(marker)}`);
          expect([query, marker, res.status, res.body]).toEqual([
            query,
            marker,
            400,
            { result: 'error', message: 'invalid marker' },
          ]);
        }
      }
      const raw = await get(`/v2/exchanges/${PAIR}?marker=${bucketMarker('2015-01-14T18:27:00')}`);
      expect([raw.status, raw.body.message]).toEqual([400, 'invalid marker']);
      // a marker does not matter when the window is empty (as in the raw list)
      const empty = await get(
        `/v2/exchanges/${PAIR}?interval=1hour&start=2030-01-01&marker=${bucketMarker('2015-01-14T18:00:00')}`,
      );
      expect(empty.body).toEqual({ result: 'success', count: 0, exchanges: [] });
    });

    it('limit: 200 candles by default, at most 400; below one is the default; NaN is an error', async () => {
      const cases: [string, number][] = [
        ['', 200],
        ['limit=1', 1],
        ['limit=400', 400],
        ['limit=401', 400],
        ['limit=100000', 400],
        ['limit=0', 200],
        ['limit=2.9', 2],
      ];
      for (const [query, rows] of cases) {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(`/v2/exchanges/${PAIR}?interval=1minute&${query}`);
        const calls = exchangesCalls(spy);
        // the buckets of the page and the one after it, then their aggregation
        expect([query, res.status, calls.length, calls[0][1]]).toEqual([
          query,
          200,
          2,
          expect.objectContaining({ fetch: rows + 1 }),
        ]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, 4)]);
        jest.restoreAllMocks();
      }
      const nan = await get(`/v2/exchanges/${PAIR}?interval=1minute&limit=abc`);
      expect([nan.status, nan.body]).toEqual([400, { result: 'error', message: 'invalid limit: NaN' }]);
    });

    it('the checks come in the order of the original: pair, start, end, limit, reduce with interval, interval, marker', async () => {
      const bad = { interval: 'bogus', reduce: 'true', marker: '!' };
      const cases: [string, string][] = [
        [`/v2/exchanges/USD/XRP${qs({ start: 'x', end: 'y', limit: 'z', ...bad })}`, 'base issuer is required'],
        [`/v2/exchanges/${PAIR}${qs({ start: 'x', end: 'y', limit: 'z', ...bad })}`, 'invalid start date format'],
        [`/v2/exchanges/${PAIR}${qs({ end: 'y', limit: 'z', ...bad })}`, 'invalid end date format'],
        [`/v2/exchanges/${PAIR}${qs({ limit: 'z', ...bad })}`, 'invalid limit: NaN'],
        [`/v2/exchanges/${PAIR}${qs(bad)}`, 'cannot use reduce with interval'],
        [`/v2/exchanges/${PAIR}${qs({ interval: 'bogus', marker: '!' })}`, 'invalid interval: bogus'],
        [`/v2/exchanges/${PAIR}${qs({ interval: '1hour', marker: '!' })}`, 'invalid marker'],
      ];
      for (const [url, message] of cases) {
        const res = await get(url);
        expect([url, res.status, res.body]).toEqual([url, 400, { result: 'error', message }]);
      }
    });

    it('reduce with an interval → 400 cannot use reduce with interval, whatever the interval', async () => {
      for (const query of [
        'reduce=true&interval=1hour',
        'reduce=TRUE&interval=week',
        'interval=1day&reduce=xtruex',
        'reduce=true&interval=3weeks',
      ]) {
        const res = await get(`/v2/exchanges/${PAIR}?${query}`);
        expect([query, res.status, res.body]).toEqual([
          query,
          400,
          { result: 'error', message: 'cannot use reduce with interval' },
        ]);
      }
      // an empty interval is no interval
      const empty = await get(`/v2/exchanges/${PAIR}?reduce=true&interval=`);
      expect([empty.status, empty.body.exchanges[0].count]).toEqual([200, 5]);
    });

    it('an invalid interval is 400 with any limit (the original skipped the check above 400 and failed with a 500)', async () => {
      for (const limit of ['1000', '401', '400', '1', '']) {
        const res = await get(`/v2/exchanges/${PAIR}?interval=bogus&limit=${limit}`);
        expect([limit, res.status, res.body]).toEqual([
          limit,
          400,
          { result: 'error', message: 'invalid interval: bogus' },
        ]);
      }
    });

    it('interval is read in any case, its message lowercased; an empty interval is the raw list; the first one wins', async () => {
      const hour = await get(`/v2/exchanges/${PAIR}?interval=1hour`);
      expect((await get(`/v2/exchanges/${PAIR}?interval=1HOUR`)).body).toEqual(hour.body);
      expect((await get(`/v2/exchanges/${PAIR}?interval=1Hour`)).body).toEqual(hour.body);
      for (const [interval, message] of [
        ['3WEEKS', 'invalid interval: 3weeks'],
        ['Week2', 'invalid interval: week2'],
        ['1 hour', 'invalid interval: 1 hour'],
        ['2day', 'invalid interval: 2day'],
        ['3month', 'invalid interval: 3month'],
        ['1week', 'invalid interval: 1week'],
        ['hour', 'invalid interval: hour'],
      ]) {
        const res = await get(`/v2/exchanges/${PAIR}${qs({ interval })}`);
        expect([interval, res.status, res.body]).toEqual([interval, 400, { result: 'error', message }]);
      }
      const raw = await get(`/v2/exchanges/${PAIR}`);
      expect((await get(`/v2/exchanges/${PAIR}?interval=`)).body).toEqual(raw.body);
      expect((await get(`/v2/exchanges/${PAIR}?interval=1hour&interval=bogus`)).body).toEqual(hour.body);
    });

    it('reduce is /true/i; anything else is the raw list', async () => {
      const raw = await get(`/v2/exchanges/${PAIR}`);
      for (const flag of ['false', '1', '0', '']) {
        expect([flag, (await get(`/v2/exchanges/${PAIR}?reduce=${flag}`)).body]).toEqual([flag, raw.body]);
      }
      const reduced = await get(`/v2/exchanges/${PAIR}?reduce=true`);
      for (const flag of ['TRUE', 'True', 'xtruex']) {
        expect([flag, (await get(`/v2/exchanges/${PAIR}?reduce=${flag}`)).body]).toEqual([flag, reduced.body]);
      }
    });

    it('candles: two queries on the key range of the pair, the buckets of the page, then their aggregation; values bound', async () => {
      const key = 'base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index';
      const order = (direction: string): string =>
        `ORDER BY ${key
          .split(', ')
          .map((c) => `${c} ${direction}`)
          .join(', ')}`;
      const queries = async (path: string): Promise<{ sql: string; params: Record<string, unknown> }[]> => {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(path);
        expect([path, res.status]).toEqual([path, 200]);
        const calls = exchangesCalls(spy).map(([sql, params]) => ({
          sql: String(sql),
          params: params as Record<string, unknown>,
        }));
        jest.restoreAllMocks();
        return calls;
      };

      // USD/XRP: 18:27 (ledger 11119603), 18:28 (11119619), 18:51 (11119932), 18:52 (11119940)
      const asc = await queries(
        `/v2/exchanges/xrp/${USD}?interval=1minute&limit=1&marker=${bucketMarker('2015-01-14T18:20:00')}`,
      );
      expect(asc).toHaveLength(2);
      for (const { sql, params } of asc) {
        // the pair is the stored one (USD before XRP), bound
        expect(Object.values(params)).toEqual(expect.arrayContaining(['USD', USD_ISSUER, 'XRP', '']));
        expect(sql).not.toContain(USD_ISSUER);
        expect(sql).toMatch(/base_currency = \{\w+:String\}/);
        expect(sql).toMatch(/counter_issuer = \{\w+:String\}/);
        expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(sql).toContain(bucketExpr('1minute'));
        // XRP is the stored counter: its leg of 0.0005 or less is left out by the query
        expect(sql).toContain('counter_amount_f > 0.0005');
        expect(sql).not.toContain('base_amount_f > 0.0005');
        expect(sql).toContain(order('ASC'));
      }
      const [probe, aggregation] = asc;
      // the exchanges in the order of the key, a plain LIMIT on the read; grouped by bucket outside it (the first
      // ledger of each), cut after the bucket that follows the page
      expect(probe.sql).toMatch(
        /LIMIT \{cap:UInt32\}\)\s+GROUP BY bucket\s+ORDER BY bucket ASC\s+LIMIT \{fetch:UInt32\}/,
      );
      expect(probe.sql).toContain('min(ledger_index) AS ledger_index');
      expect(probe.sql).not.toContain('LIMIT 1 BY');
      expect(probe.params).toMatchObject({ fetch: 2, cap: 2 + 2048 });
      // the ledgers before the first one of the next bucket, each exchange once
      expect(aggregation.sql).toContain(`LIMIT 1 BY ${key}`);
      expect(aggregation.sql).toMatch(/GROUP BY bucket\s+ORDER BY bucket ASC/);
      expect(aggregation.params).toMatchObject({ max: 11119618 });

      // descending: the probe reads the key backwards; the page starts after the last ledger of the next bucket
      const desc = await queries(`/v2/exchanges/${PAIR}?interval=1minute&limit=1&descending=true`);
      expect(desc).toHaveLength(2);
      expect(desc[0].sql).toContain(order('DESC'));
      expect(desc[0].sql).toContain('max(ledger_index) AS ledger_index');
      expect(desc[1].sql).toContain(order('ASC'));
      expect(desc[1].sql).toMatch(/ORDER BY bucket DESC/);
      expect(desc[1].params).toMatchObject({ min: 11119933 });

      // the last page aggregates what is left of the range; no bucket, no aggregation
      const [{ latest }] = await h.ch.query<{ latest: number }>(
        `SELECT max(ledger_index) AS latest FROM ${Table.Ledgers}`,
      );
      const last = await queries(
        `/v2/exchanges/${PAIR}?interval=1minute&marker=${bucketMarker('2015-01-14T18:28:00')}`,
      );
      expect(last).toHaveLength(2);
      expect(last[1].params).toMatchObject({ max: latest });
      expect(
        await queries(`/v2/exchanges/${PAIR}?interval=1minute&marker=${bucketMarker('2015-01-14T18:52:00')}`),
      ).toHaveLength(1);

      // reduce: one query, the whole window, no buckets
      const reduce = await queries(`/v2/exchanges/${PAIR}?reduce=true`);
      expect(reduce).toHaveLength(1);
      expect(reduce[0].sql).not.toContain('GROUP BY');
      expect(reduce[0].sql).toContain(`LIMIT 1 BY ${key}`);
      expect(reduce[0].sql).toContain(order('ASC'));
      expect(reduce[0].params).toMatchObject({ max: latest });
    });

    it('reads the exchanges of the pair in the order of the primary key, never sorting them', async () => {
      for (const [i, m] of MARKETS.entries()) {
        const queries =
          i < 4
            ? [
                'interval=1minute',
                'interval=1minute&limit=1',
                'reduce=true',
                'interval=1month&descending=true',
                'interval=1minute&descending=true&limit=1',
                `interval=5minute&marker=${bucketMarker('2015-01-14T18:25:00')}`,
                'interval=1day&autobridged=true',
              ]
            : ['interval=1hour'];
        for (const query of queries) {
          for (const [base, counter] of [
            [m.base, m.counter],
            [m.counter, m.base],
          ]) {
            const spy = jest.spyOn(h.ch, 'query');
            await get(`/v2/exchanges/${pathOf(base)}/${pathOf(counter)}?${query}`);
            const calls = exchangesCalls(spy);
            jest.restoreAllMocks();
            // the probe (when there is a bucket, the aggregation after it), or the reduction
            const kinds = query.startsWith('reduce') ? ['reduce'] : ['probe', 'aggregation'];
            expect(calls.length).toBeGreaterThan(0);
            expect(calls.length).toBeLessThanOrEqual(kinds.length);
            for (const [j, [sql, params]] of calls.entries()) {
              const where = [pathOf(base), pathOf(counter), query, kinds[j]];
              const backwards = kinds[j] === 'probe' && query.includes('descending=true');
              // the read of the probe is its inner SELECT: the exchanges of the pair with a plain LIMIT (the buckets are
              // grouped and sorted above it, a few rows); the aggregation and the reduction read below their LIMIT BY
              const probeRead = /FROM \((SELECT [\s\S]*?LIMIT \{cap:UInt32\})\)/.exec(String(sql))?.[1];
              const pipeline = await explain(
                h,
                'PIPELINE',
                kinds[j] === 'probe' ? (probeRead as string) : String(sql),
                params as Record<string, unknown>,
              );
              const read = kinds[j] === 'probe' ? pipeline : pipeline.slice(pipeline.lastIndexOf('(LimitBy)'));
              // the rows of the pair read in key order (backwards for the probe of a descending list), never sorted
              expect([where, read]).toEqual([where, expect.stringContaining('ReadPoolInOrder')]);
              expect([where, read.includes(backwards ? 'algorithm: InReverseOrder' : 'algorithm: InOrder')]).toEqual([
                where,
                true,
              ]);
              expect([where, /SortingTransform/.test(read)]).toEqual([where, false]);
              if (kinds[j] === 'probe') {
                // and it stops after its cap: the LIMIT is on the read itself (Ruling R106)
                expect([where, await tableReads(h, String(sql), params as Record<string, unknown>)]).toEqual([
                  where,
                  [
                    {
                      readType: backwards ? 'InReverseOrder' : 'InOrder',
                      prefixSorted: true,
                      limit: (params as { cap: number }).cap,
                    },
                  ],
                ]);
              }
            }
          }
        }
      }
    });

    it('format=csv: candles and the reduced row in the columns of the original, the buy volume last', async () => {
      const res = await get(`/v2/exchanges/xrp/${USD}?interval=1minute&format=csv`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('exchanges - XRP-USD'));
      const rows = res.text.split('\n');
      expect(rows).toHaveLength(1 + 4);
      expect(rows[0]).toBe(AGGREGATE_CSV_COLUMNS.map((c) => `"${c}"`).join(','));
      const json = (await get(`/v2/exchanges/xrp/${USD}?interval=1minute`)).body.exchanges as Candle[];
      json.forEach((c, i) =>
        expect(rows[1 + i]).toBe(
          AGGREGATE_CSV_COLUMNS.map((k) => `"${(c[k] as string | number | undefined) ?? ''}"`).join(','),
        ),
      );
      // the reduced row
      const reduced = await get(`/v2/exchanges/${PAIR}?reduce=true&format=csv`);
      expect(reduced.headers['content-disposition']).toBe(csvDisposition('exchanges - USD-XRP'));
      const lines = reduced.text.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(AGGREGATE_CSV_COLUMNS.map((c) => `"${c}"`).join(','));
      const one = (await get(`/v2/exchanges/${PAIR}?reduce=true`)).body.exchanges[0] as Candle;
      expect(lines[1]).toBe(
        AGGREGATE_CSV_COLUMNS.map((k) => `"${(one[k] as string | number | undefined) ?? ''}"`).join(','),
      );
      // the Link of a page, and the empty list
      const paged = await get(`/v2/exchanges/${PAIR}?interval=1minute&format=csv&limit=2`);
      expect(paged.headers.link).toContain(`marker=${bucketMarker('2015-01-14T18:28:00')}`);
      expect(paged.text.split('\n')).toHaveLength(1 + 2);
      const empty = await get(`/v2/exchanges/${PAIR}?interval=1hour&format=csv&start=2030-01-01`);
      expect([empty.status, empty.text]).toEqual([200, '']);
      const error = await get(`/v2/exchanges/${PAIR}?interval=bogus&format=csv`);
      expect([error.status, error.body]).toEqual([400, { result: 'error', message: 'invalid interval: bogus' }]);
    });

    it('is 500 unable to retrieve exchanges when the database fails', async () => {
      for (const query of ['interval=1hour', 'reduce=true']) {
        jest.spyOn(h.ch, 'query').mockRejectedValueOnce(new Error('boom'));
        const first = await get(`/v2/exchanges/${PAIR}?${query}`);
        expect([query, first.status, first.body]).toEqual([
          query,
          500,
          { result: 'error', message: 'unable to retrieve exchanges' },
        ]);
        jest.restoreAllMocks();
        // the aggregation fails after the range was found
        const real = h.ch.query.bind(h.ch);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(h.ch, 'query').mockImplementation(((sql: string, ...rest: any[]) =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sql.includes(Table.Exchanges) ? Promise.reject(new Error('boom')) : (real as any)(sql, ...rest)) as never);
        const second = await get(`/v2/exchanges/${PAIR}?${query}`);
        expect([query, second.status, second.body]).toEqual([
          query,
          500,
          { result: 'error', message: 'unable to retrieve exchanges' },
        ]);
        jest.restoreAllMocks();
      }
    });
  });

  // -- every pair --------------------------------------------------------------------------------------------------

  describe('/v2/exchanges (all pairs)', () => {
    it('lists every exchange of the stored ledgers, oldest first, as stored (never inverted)', async () => {
      const res = await get('/v2/exchanges?limit=400');
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(158);
      expect(res.body.marker).toBeUndefined();
      expect(res.body.exchanges).toEqual(exchangesOf(ALL));
      // the order is the one of the ledger, not that of the pairs
      const keys = (res.body as ListBody).exchanges.map((e) => [e.ledger_index, e.tx_index, e.node_index] as number[]);
      expect(keys).toEqual([...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
      expect(
        new Set((res.body as ListBody).exchanges.map((e) => `${e.base_currency}/${e.counter_currency}`)).size,
      ).toBeGreaterThan(10);
    });

    it('serves each exchange with the pair it is stored under: base and counter in canonical order', async () => {
      const res = await get('/v2/exchanges?limit=400');
      for (const [i, ex] of (res.body as ListBody).exchanges.entries()) {
        expect([i, ex.base_currency, ex.base_issuer, ex.counter_currency, ex.counter_issuer]).toEqual([
          i,
          ALL[i].row.base_currency,
          ALL[i].row.base_issuer || undefined,
          ALL[i].row.counter_currency,
          ALL[i].row.counter_issuer || undefined,
        ]);
      }
    });

    it('is result, count, marker, exchanges; the default page is 200', async () => {
      const first = await get('/v2/exchanges');
      expect(first.body.count).toBe(158);
      expect(Object.keys(first.body)).toEqual(['result', 'count', 'exchanges']);
      const paged = await get('/v2/exchanges?limit=10');
      expect(Object.keys(paged.body)).toEqual(['result', 'count', 'marker', 'exchanges']);
    });

    it('limit is 200 by default, at most 400; NaN is an error', async () => {
      for (const [query, rows] of [
        ['', 200],
        ['limit=7', 7],
        ['limit=1000', 400],
        ['limit=0', 200],
      ] as [string, number][]) {
        const spy = jest.spyOn(h.ch, 'query');
        const res = await get(`/v2/exchanges?${query}`);
        const paging = spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
        // the first window has room for one more than the page (it tells whether there is a next page), and as many
        // duplicates, at least 16
        const want = rows + 1;
        expect([query, res.status, paging[0][1]]).toEqual([
          query,
          200,
          expect.objectContaining({ cap: want + Math.max(want, 16) }),
        ]);
        expect([query, res.body.count]).toEqual([query, Math.min(rows, ALL.length)]);
        jest.restoreAllMocks();
      }
      const bad = await get('/v2/exchanges?limit=abc');
      expect([bad.status, bad.body]).toEqual([400, { result: 'error', message: 'invalid limit: NaN' }]);
    });

    it('marker pages concatenate to unpaged list', async () => {
      const unpaged = await get('/v2/exchanges?limit=400');
      const paged = await pages('/v2/exchanges', 7);
      expect(paged.slice(0, -1).every((p) => p.count === 7 && p.marker !== undefined)).toBe(true);
      expect(paged[paged.length - 1].marker).toBeUndefined();
      expect(paged.flatMap((p) => p.exchanges)).toEqual(unpaged.body.exchanges);
      // the marker is the key of the last row of the page
      expect(paged[0].marker).toBe(markerOf(ALL[6].row));
    });

    it('descending reverses order, and its markers continue downwards', async () => {
      const asc = await get('/v2/exchanges?limit=400');
      const desc = await get('/v2/exchanges?limit=400&descending=true');
      expect(desc.body.exchanges).toEqual([...asc.body.exchanges].reverse());
      const paged = await pages('/v2/exchanges?descending=true', 9);
      expect(paged.flatMap((p) => p.exchanges)).toEqual(desc.body.exchanges);
    });

    it('start and end select the ledgers that closed within them; empty range → count 0', async () => {
      const window = { start: '2015-01-14T18:28:40Z', end: '2015-01-14T18:51:40Z' };
      const res = await get(`/v2/exchanges${qs({ ...window, limit: 400 })}`);
      const expected = closedBetween(ALL, '2015-01-14T18:28:40', '2015-01-14T18:51:41');
      expect(expected.length).toBeGreaterThan(5);
      expect(expected.length).toBeLessThan(ALL.length);
      expect(hashesIn(res.body)).toEqual(hashesOf(expected));
      expect((await pages(`/v2/exchanges${qs(window)}`, 5)).flatMap(hashesIn)).toEqual(hashesOf(expected));
      const none = await get('/v2/exchanges?start=2030-01-01&end=2030-12-31');
      expect(none.body).toEqual({ result: 'success', count: 0, exchanges: [] });
    });

    it('the checks: start, end, limit, then the marker; unknown params ignored', async () => {
      const cases: [string, string][] = [
        [`/v2/exchanges${qs({ start: 'x', end: 'y', limit: 'z', marker: '!' })}`, 'invalid start date format'],
        [`/v2/exchanges${qs({ end: 'y', limit: 'z', marker: '!' })}`, 'invalid end date format'],
        [`/v2/exchanges${qs({ limit: 'z', marker: '!' })}`, 'invalid limit: NaN'],
        [`/v2/exchanges${qs({ marker: '!' })}`, 'invalid marker'],
      ];
      for (const [url, message] of cases) {
        const res = await get(url);
        expect([url, res.status, res.body]).toEqual([url, 400, { result: 'error', message }]);
      }
      const plain = await get('/v2/exchanges?limit=5');
      expect((await get('/v2/exchanges?limit=5&foo=bar')).body).toEqual(plain.body);
    });

    /** The exchanges of each ledger of the mock ledgers, ascending: what `ledgers.exchanges_count` holds. */
    const perLedger = (): [number, number][] => {
      const counts = new Map<number, number>();
      for (const e of ALL) counts.set(e.row.ledger_index, (counts.get(e.row.ledger_index) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => a[0] - b[0]);
    };
    /** The first ledger from `from` on (back from it, descending) by which the ledgers hold `count` exchanges. */
    const edgeOf = (from: number, count: number, descending: boolean): number => {
      const ledgers = perLedger().filter(([l]) => (descending ? l <= from : l >= from));
      if (descending) ledgers.reverse();
      let total = 0;
      for (const [ledger, n] of ledgers) {
        total += n;
        if (total >= count) return ledger;
      }
      throw new Error('fewer exchanges than asked for');
    };
    const exchangesCalls = (spy: jest.SpyInstance) =>
      spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));
    const edgeCalls = (spy: jest.SpyInstance) =>
      spy.mock.calls.filter(([q]) =>
        new RegExp(`FROM ${Table.Ledgers}\\b[\\s\\S]*exchanges_count > 0`).test(String(q)),
      );

    it('reads one window of ledgers from the marker on, as long as their exchanges_count says the page needs (R107)', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/exchanges?limit=3&marker=${markerOf(ALL[10].row)}`);
      expect(hashesIn(res.body)).toEqual(hashesOf(ALL.slice(11, 14)));
      // where the window ends: the ledgers of the marker on, until they hold the page and one more (4)
      const [[edgeSql, edgeParams]] = edgeCalls(query);
      expect(String(edgeSql)).toMatch(/ORDER BY ledger_index ASC\s+LIMIT \{count:UInt32\}/);
      expect(edgeParams).toMatchObject({ lo: ALL[10].row.ledger_index, count: 4 });
      const paging = exchangesCalls(query);
      const edge = edgeOf(ALL[10].row.ledger_index, 4, false);
      expect(paging.map(([, p]) => p)).toEqual([expect.objectContaining({ lo: ALL[10].row.ledger_index, hi: edge })]);
      const [q, params] = paging[0];
      const sql = String(q);
      expect(sql).toMatch(/ledger_index BETWEEN \{lo:UInt32\} AND \{hi:UInt32\}/);
      expect(sql).toContain('ledger_index >= {k0:UInt32} AND (ledger_index, tx_index, node_index) > (');
      expect(sql).toMatch(/ORDER BY ledger_index ASC, tx_index ASC, node_index ASC\s+LIMIT \{cap:UInt32\}/);
      // no LIMIT BY: a row written twice is dropped in code, so the sort of a window stops at the cap
      expect(sql).not.toContain('LIMIT 1 BY');
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(sql).not.toMatch(/base_currency =/);
      expect(params).toMatchObject({ k0: ALL[10].row.ledger_index });
    });

    it('descending: the window runs back from the marker (R107)', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/exchanges?limit=3&descending=true&marker=${markerOf(ALL[100].row)}`);
      expect(hashesIn(res.body)).toEqual(hashesOf(ALL.slice(97, 100).reverse()));
      expect(String(edgeCalls(query)[0][0])).toMatch(/ORDER BY ledger_index DESC\s+LIMIT \{count:UInt32\}/);
      const windows = exchangesCalls(query).map(([, p]) => p as { lo: number; hi: number });
      expect(windows[0]).toMatchObject({
        hi: ALL[100].row.ledger_index,
        lo: edgeOf(ALL[100].row.ledger_index, 4, true),
      });
      windows.slice(1).forEach((w, i) => expect(w.hi).toBe(windows[i].lo - 1));
    });

    it('the first page of the default window: one read of the ledgers and one of the exchanges, wherever they start (R107)', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get('/v2/exchanges?limit=3');
      expect(hashesIn(res.body)).toEqual(hashesOf(ALL.slice(0, 3)));
      expect(edgeCalls(query)).toHaveLength(1);
      const [[, params]] = exchangesCalls(query);
      expect(exchangesCalls(query)).toHaveLength(1);
      // from the first ledger of the range (2013-01-01 on) to the ledger by which the page is in
      expect(params).toMatchObject({ hi: edgeOf(0, 4, false) });
      expect((params as { lo: number }).lo).toBeLessThanOrEqual(ALL[0].row.ledger_index);
    });

    it('a window that holds fewer than its ledgers count is followed by one sized for twice as many (R107)', async () => {
      // the marker is the last exchange of the busiest ledger: its exchanges_count covers the page, but the marker
      // leaves none of them, so the next window is sized for twice the page
      const [busiest] = [...perLedger()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      expect(busiest[1]).toBeGreaterThanOrEqual(4);
      const last = ALL.filter((e) => e.row.ledger_index === busiest[0]).pop() as FixtureExchange;
      const after = ALL.slice(ALL.indexOf(last) + 1, ALL.indexOf(last) + 4);
      const query = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/exchanges?limit=3&marker=${markerOf(last.row)}`);
      expect(hashesIn(res.body)).toEqual(hashesOf(after));
      const counts = edgeCalls(query).map(([, p]) => (p as { count: number }).count);
      expect(counts.slice(0, 2)).toEqual([4, 8]);
      const windows = exchangesCalls(query).map(([, p]) => p as { lo: number; hi: number });
      expect(windows[0]).toMatchObject({ lo: busiest[0], hi: busiest[0] });
      expect(windows[1].lo).toBe(busiest[0] + 1);
    });

    it('a window sorts to the page and its room only, however many exchanges it holds (R107)', async () => {
      const query = jest.spyOn(h.ch, 'query');
      await get(`/v2/exchanges?limit=3&marker=${markerOf(ALL[30].row)}`);
      const paging = exchangesCalls(query);
      expect(paging).toHaveLength(1);
      expect(paging[0][1]).toMatchObject({ cap: 4 + 16 });
    });

    it('format=csv gives the same columns, named exchanges.csv', async () => {
      const res = await get('/v2/exchanges?format=csv&limit=400');
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('exchanges'));
      const rows = res.text.split('\n');
      expect(rows).toHaveLength(1 + 158);
      expect(rows[0]).toBe(CSV_COLUMNS.map((c) => `"${c}"`).join(','));
      const paged = await get('/v2/exchanges?format=csv&limit=3');
      expect(paged.headers.link).toBe(
        `<${new URL(paged.request.url).origin}/v2/exchanges?format=csv&limit=3&marker=${markerOf(ALL[2].row)}>; rel="next"`,
      );
    });
  });
});

describe('exchanges API endpoint when a ledger was written twice', () => {
  // The tables are ReplacingMergeTree and the lists never use FINAL, so until a merge a row can be there twice (the
  // syncer re-writes a ledger it is not sure about).
  const counts = new Map<number, number>();
  for (const e of ALL) counts.set(e.row.ledger_index, (counts.get(e.row.ledger_index) ?? 0) + 1);
  const LEDGER = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const written = ALL.filter((e) => e.row.ledger_index === LEDGER);
  const closeTime = written[0].row.close_time;
  const second = new Date(closeTime * 1000).toISOString().slice(0, 19);
  const window = `?start=${second}&end=${second}`;
  const inWindow = closedBetween(ALL, second, new Date(closeTime * 1000 + 1000).toISOString().slice(0, 19));
  // the pair with the most exchanges in that ledger
  const pairCounts = marketsOf(written).sort((a, b) => b.rows.length - a.rows.length)[0];
  const market = MARKETS.find(
    (m) => pathOf(m.base) === pathOf(pairCounts.base) && pathOf(m.counter) === pathOf(pairCounts.counter),
  ) as Market;

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'exchanges');
  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.Exchanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.Exchanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
    );
    expect(Number(n)).toBe(written.length * 2);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every exchange of a pair once', async () => {
    expect(market.rows.filter((e) => e.row.ledger_index === LEDGER).length).toBeGreaterThan(1);
    const path = `/v2/exchanges/${pathOf(market.base)}/${pathOf(market.counter)}`;
    const unpaged = await get(`${path}?limit=400`);
    expect(unpaged.body.exchanges).toEqual(exchangesOf(market.rows));
    // and a page cut inside the duplicates neither repeats nor skips a row
    for (const limit of [1, 2, 3]) {
      const paged = (await pages(path, limit)).flatMap(hashesIn);
      expect([limit, paged]).toEqual([limit, hashesOf(market.rows)]);
    }
    const desc = await pages(`${path}?descending=true`, 2);
    expect(desc.flatMap(hashesIn)).toEqual(hashesOf(market.rows).reverse());
    // the other way round too
    const inverted = await get(`/v2/exchanges/${pathOf(market.counter)}/${pathOf(market.base)}?limit=400`);
    expect(inverted.body.exchanges).toEqual(exchangesOf(market.rows, true));
  });

  it('lists every exchange of the window once, in all pairs', async () => {
    expect(written.length).toBeGreaterThan(2);
    const unpaged = await get(`/v2/exchanges${window}&limit=400`);
    expect(unpaged.body.exchanges).toEqual(exchangesOf(inWindow));
    for (const limit of [1, 2, 3, 5]) {
      const paged = (await pages(`/v2/exchanges${window}`, limit)).flatMap(hashesIn);
      expect([limit, paged]).toEqual([limit, hashesOf(inWindow)]);
    }
  });

  it('counts every exchange once in the whole list', async () => {
    const res = await get('/v2/exchanges?limit=400');
    expect(res.body.count).toBe(158);
    expect(hashesIn(res.body)).toEqual(hashesOf(ALL));
  });

  it('aggregates every exchange once: candles and reduce', async () => {
    for (const inverted of [false, true]) {
      const [base, counter] = inverted ? [market.counter, market.base] : [market.base, market.counter];
      const path = `/v2/exchanges/${pathOf(base)}/${pathOf(counter)}`;
      for (const interval of ['1minute', '1day']) {
        const res = await get(`${path}?interval=${interval}`);
        expectAggregates([path, interval], res.body.exchanges, candlesOf(market, interval, inverted));
      }
      const reduced = await get(`${path}?reduce=true`);
      expectAggregates([path, 'reduce'], reduced.body.exchanges, [reducedOf(market, inverted, '2013-01-01T00:00:00Z')]);
      // and in pages of one candle
      const paged = (await pages(`${path}?interval=1minute`, 1)).flatMap((p) => p.exchanges);
      expect(paged).toEqual((await get(`${path}?interval=1minute`)).body.exchanges);
    }
  });
});

describe('exchanges API endpoint on the xrpl-recorded ledgers (autobridged exchanges)', () => {
  const seed = 'xrpl-recorded';
  const all = [...fixtureExchanges(seed)].sort(byKey);
  const markets = marketsOf(all);
  const autobridged = all.filter((e) => e.row.autobridged_currency !== null);
  // the pair that has both kinds
  const mixed = markets.find(
    (m) =>
      m.rows.some((e) => e.row.autobridged_currency !== null) &&
      m.rows.some((e) => e.row.autobridged_currency === null),
  ) as Market;
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'exchanges');
  beforeAll(async () => {
    h = await startHarness({ seed, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the recorded ledgers hold 20 order-book exchanges, two of them autobridged, and 34 swaps against AMM pools', () => {
    // The ledgers are from after the AMM amendment: swaps through pools are exchanges too (amm_account is the pool).
    expect(all.filter((e) => e.row.amm_account === '')).toHaveLength(20);
    expect(all.filter((e) => e.row.amm_account !== '')).toHaveLength(34);
    expect(all).toHaveLength(54);
    expect(autobridged).toHaveLength(2);
    expect(mixed.rows.length).toBeGreaterThan(2);
  });

  it('serves the autobridged currency and issuer, in the place of the f family', async () => {
    const path = `/v2/exchanges/${pathOf(mixed.base)}/${pathOf(mixed.counter)}?limit=400`;
    const res = await get(path);
    expect(res.body.exchanges).toEqual(exchangesOf(mixed.rows));
    const bridged = (res.body as ListBody).exchanges.filter((e) => 'autobridged_currency' in e);
    expect(bridged).toHaveLength(1);
    expect(Object.keys(bridged[0]).slice(5, 8)).toEqual(['autobridged_currency', 'autobridged_issuer', 'buyer']);
    expect(bridged[0].autobridged_currency).toBe(
      mixed.rows.find((e) => e.row.autobridged_currency !== null)?.row.autobridged_currency,
    );
  });

  it('autobridged=true keeps only the exchanges that have an autobridged currency', async () => {
    const path = `/v2/exchanges/${pathOf(mixed.base)}/${pathOf(mixed.counter)}`;
    const on = await get(`${path}?autobridged=true`);
    const expected = mixed.rows.filter((e) => e.row.autobridged_currency !== null);
    expect(expected).toHaveLength(1);
    expect(on.body.exchanges).toEqual(exchangesOf(expected));
    // /true/i, like the other flags; anything else leaves them all
    expect((await get(`${path}?autobridged=TRUE`)).body.exchanges).toEqual(exchangesOf(expected));
    for (const flag of ['false', '1', '']) {
      expect([flag, (await get(`${path}?autobridged=${flag}`)).body.count]).toEqual([flag, mixed.rows.length]);
    }
    // inverted, and a pair without autobridged exchanges is empty
    expect(
      (await get(`/v2/exchanges/${pathOf(mixed.counter)}/${pathOf(mixed.base)}?autobridged=true`)).body.exchanges,
    ).toEqual(exchangesOf(expected, true));
    const plain = markets.find((m) => m.rows.every((e) => e.row.autobridged_currency === null)) as Market;
    const none = await get(`/v2/exchanges/${pathOf(plain.base)}/${pathOf(plain.counter)}?autobridged=true`);
    expect(none.body).toEqual({ result: 'success', count: 0, exchanges: [] });
  });

  it('/v2/exchanges?autobridged=true walks every autobridged exchange, page by page, however its windows are sized (R107)', async () => {
    for (const limit of [1, 2]) {
      const walked = (await pages('/v2/exchanges?autobridged=true', limit)).flatMap((p) =>
        p.exchanges.map((e) => e.tx_hash),
      );
      expect([limit, walked]).toEqual([limit, autobridged.map((e) => e.row.tx_hash)]);
    }
  });

  it('autobridged=true pages: the marker continues inside the filtered rows', async () => {
    const both = (await pages('/v2/exchanges?autobridged=true', 1)).flatMap(hashesIn);
    expect(both).toEqual(hashesOf(autobridged));
    expect((await get('/v2/exchanges?autobridged=true&limit=400')).body.exchanges).toEqual(exchangesOf(autobridged));
  });

  it('the CSV has the autobridged columns filled for those rows only', async () => {
    const res = await get('/v2/exchanges?autobridged=true&format=csv');
    const rows = res.text.split('\n');
    expect(rows).toHaveLength(1 + 2);
    const header = rows[0].split(',');
    const at = header.indexOf('"autobridged_currency"');
    for (const [i, e] of autobridged.entries()) {
      const cells = rows[1 + i].split(',');
      expect(cells[at]).toBe(`"${e.row.autobridged_currency}"`);
      expect(cells[at + 1]).toBe(`"${e.row.autobridged_issuer}"`);
    }
  });

  it('hex currency codes are served as stored and found in any case', async () => {
    const hex = markets.find((m) => m.base.currency.length === 40) as Market;
    const path = `/v2/exchanges/${pathOf(hex.base)}/XRP?limit=400`;
    const res = await get(path);
    expect(res.body.exchanges).toEqual(exchangesOf(hex.rows));
    const lower = await get(`/v2/exchanges/${hex.base.currency.toLowerCase()}+${hex.base.issuer}/xrp?limit=400`);
    expect(lower.body.exchanges).toEqual(exchangesOf(hex.rows));
    // an issued currency that is called XAH is an ordinary currency on the XRP ledger
    const xah = await get(`/v2/exchanges/XAH+rswh1fvyLqHizBS2awu1vs6QcmwTBd9qiv/XRP`);
    expect(xah.body.count).toBe(1);
  });

  it('candles and reduce of every recorded pair (hex currencies, tiny XRP legs), in both orientations', async () => {
    // 4245415200…/XRP traded 0.0001 XRP: left out of the aggregates
    const tiny = all.filter((e) => e.row.counter_issuer === '' && Number(e.row.counter_amount) <= 0.0005);
    expect(tiny).toHaveLength(1);
    for (const m of markets) {
      for (const inverted of [false, true]) {
        const [base, counter] = inverted ? [m.counter, m.base] : [m.base, m.counter];
        const path = `/v2/exchanges/${pathOf(base)}/${pathOf(counter)}`;
        for (const interval of ['1minute', '1hour', '1year']) {
          const res = await get(`${path}?interval=${interval}`);
          expectAggregates([path, interval], res.body.exchanges, candlesOf(m, interval, inverted));
        }
        const reduced = await get(`${path}?reduce=true`);
        expectAggregates([path, 'reduce'], reduced.body.exchanges, [reducedOf(m, inverted, '2013-01-01T00:00:00Z')]);
      }
    }
  });

  it("autobridged=true aggregates the autobridged exchanges only (the original's candles came back empty)", async () => {
    const path = `/v2/exchanges/${pathOf(mixed.base)}/${pathOf(mixed.counter)}`;
    const bridged = mixed.rows.filter((e) => e.row.autobridged_currency !== null).map((e) => e.row);
    expect(bridged).toHaveLength(1);
    const reduced = await get(`${path}?reduce=true&autobridged=true`);
    expectAggregates('reduce', reduced.body.exchanges, [reducedOf(mixed, false, '2013-01-01T00:00:00Z', bridged)]);
    expect(reduced.body.exchanges[0].count).toBe(1);
    const candles = await get(`${path}?interval=1hour&autobridged=true`);
    expectAggregates('1hour', candles.body.exchanges, candlesOf(mixed, '1hour', false, bridged));
    const inverted = await get(
      `/v2/exchanges/${pathOf(mixed.counter)}/${pathOf(mixed.base)}?interval=1day&autobridged=TRUE`,
    );
    expectAggregates('inverted', inverted.body.exchanges, candlesOf(mixed, '1day', true, bridged));
    // without the flag, all of them
    const every = await get(`${path}?reduce=true&autobridged=false`);
    expect(every.body.exchanges[0].count).toBe(aggregated(mixed.rows.map((e) => e.row)).length);
  });
});

describe('exchanges API endpoint: swaps against AMM pools (amm_account and the amm filter)', () => {
  // The mock ledgers of the original (158 order-book exchanges, 2013 to 2016) next to the recorded AMM ledgers (39
  // order-book exchanges and 138 swaps against pools, 2025 and 2026): swaps are exchanges too, `amm_account` is the pool.
  const SEED = 'ripple-mock+amm';
  const MODES = ['include', 'exclude', 'only'] as const;
  type Mode = (typeof MODES)[number];
  const MESSAGE = 'invalid amm filter - use: include, exclude, only';
  const MIXED = [...fixtureExchanges(SEED)].sort(byKey);
  const isSwap = (e: FixtureExchange): boolean => e.row.amm_account !== '';
  /** What the filter keeps; no `amm` is `include`. */
  const kept = (list: FixtureExchange[], mode?: Mode): FixtureExchange[] =>
    mode === 'exclude' ? list.filter((e) => !isSwap(e)) : mode === 'only' ? list.filter(isSwap) : list;
  const biggest = (list: Market[]): Market => [...list].sort((a, b) => b.rows.length - a.rows.length)[0];
  const markets = marketsOf(MIXED);
  /** A pair that has both kinds of exchange, one that has swaps only and one that has order-book exchanges only. */
  const mixed = biggest(markets.filter((m) => m.rows.some(isSwap) && m.rows.some((e) => !isSwap(e))));
  const swapsOnly = biggest(markets.filter((m) => m.rows.every(isSwap)));
  const bookOnly = biggest(markets.filter((m) => m.rows.every((e) => !isSwap(e))));
  /** A pair that has autobridged exchanges of both kinds. */
  const bridgedBoth = markets.find(
    (m) =>
      m.rows.some((e) => isSwap(e) && e.row.autobridged_currency !== null) &&
      m.rows.some((e) => !isSwap(e) && e.row.autobridged_currency !== null),
  ) as Market;
  const pairPath = (m: Market, inverted = false): string =>
    inverted ? `${pathOf(m.counter)}/${pathOf(m.base)}` : `${pathOf(m.base)}/${pathOf(m.counter)}`;
  const ammQuery = (mode?: string): string => (mode === undefined ? '' : `amm=${mode}`);
  /** `path` with the params (the empty ones left out) joined to what it has. */
  const url = (path: string, ...params: string[]): string => {
    const kept = params.filter((p) => p !== '');
    return kept.length === 0 ? path : `${path}${path.includes('?') ? '&' : '?'}${kept.join('&')}`;
  };

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'exchanges');
  const exchangesCalls = (spy: jest.SpyInstance): unknown[][] =>
    spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Exchanges}\\b`).test(String(q)));

  beforeAll(async () => {
    h = await startHarness({ seed: SEED, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  it('the data is as the tests assume: both kinds of exchange in one pair, and pairs of one kind', () => {
    expect(MIXED).toHaveLength(158 + 39 + 138);
    expect(MIXED.filter(isSwap)).toHaveLength(138);
    // a pair of both kinds, one of swaps only, one of order-book exchanges only
    expect([mixed.rows.filter(isSwap).length, mixed.rows.filter((e) => !isSwap(e)).length]).toEqual([4, 14]);
    expect(swapsOnly.rows.length).toBeGreaterThanOrEqual(6);
    expect(bookOnly.rows.length).toBeGreaterThanOrEqual(30);
    // a swap's provider is the pool, and there is no offer behind it
    for (const e of MIXED.filter(isSwap))
      expect([e.row.provider, e.row.offer_sequence]).toEqual([e.row.amm_account, 0]);
  });

  describe('the exchanges of a pair (raw)', () => {
    it('amm unset, include, exclude and only give the exchanges, the order-book ones and the swaps, both ways round', async () => {
      for (const m of [mixed, swapsOnly, bookOnly]) {
        for (const inverted of [false, true]) {
          for (const mode of [undefined, ...MODES]) {
            const path = url(`/v2/exchanges/${pairPath(m, inverted)}`, 'limit=400', ammQuery(mode));
            const want = kept(m.rows, mode);
            const res = await get(path);
            expect([path, res.status, res.body.count]).toEqual([path, 200, want.length]);
            expect([path, res.body.exchanges]).toEqual([path, exchangesOf(want, inverted)]);
          }
        }
      }
      // the three sets are not the same: the filter does something on the pair that has both
      const sets = MODES.map((mode) => kept(mixed.rows, mode).length);
      expect(sets[0]).toBe(sets[1] + sets[2]);
      expect(sets[1]).toBeGreaterThan(0);
      expect(sets[2]).toBeGreaterThan(0);
    });

    it('an empty set is the usual empty answer: only on a pair of order-book exchanges, exclude on a pair of swaps', async () => {
      const none = await get(`/v2/exchanges/${pairPath(bookOnly)}?amm=only`);
      expect(none.body).toEqual({ result: 'success', count: 0, exchanges: [] });
      const noneLeft = await get(`/v2/exchanges/${pairPath(swapsOnly)}?amm=exclude`);
      expect(noneLeft.body).toEqual({ result: 'success', count: 0, exchanges: [] });
    });

    it('is include when amm is missing or empty; the rest of the query is as before', async () => {
      const path = `/v2/exchanges/${pairPath(mixed)}`;
      const plain = await get(`${path}?limit=400`);
      for (const amm of ['amm=', 'amm=include']) {
        const res = await get(`${path}?limit=400&${amm}`);
        expect([amm, res.body]).toEqual([amm, plain.body]);
      }
      // a repeated param: the first value wins; other params and other values of it are ignored
      expect((await get(`${path}?limit=400&amm=only&amm=exclude`)).body.exchanges).toEqual(
        exchangesOf(kept(mixed.rows, 'only')),
      );
      expect((await get(`${path}?limit=400&amm=exclude&amm=nonsense`)).body.exchanges).toEqual(
        exchangesOf(kept(mixed.rows, 'exclude')),
      );
    });

    it('the filter composes with the window, autobridged, descending and the pages', async () => {
      const path = `/v2/exchanges/${pairPath(mixed)}`;
      // the day of the first swap of the pair: its book and swap exchanges are both in the window
      const swaps = kept(mixed.rows, 'only');
      const day = executedTime(swaps[0].row.close_time).slice(0, 10);
      const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 19);
      const within = closedBetween(mixed.rows, `${day}T00:00:00`, nextDay);
      expect(within.some(isSwap)).toBe(true);
      for (const mode of MODES) {
        const res = await get(url(path, `start=${day}`, `end=${day}`, `amm=${mode}`));
        expect([mode, res.body.exchanges]).toEqual([mode, exchangesOf(kept(within, mode))]);
      }
      // autobridged=true with amm: a pair that has autobridged exchanges of both kinds
      const autobridged = (e: FixtureExchange): boolean => e.row.autobridged_currency !== null;
      expect(bridgedBoth.rows.some((e) => isSwap(e) && autobridged(e))).toBe(true);
      expect(bridgedBoth.rows.some((e) => !isSwap(e) && autobridged(e))).toBe(true);
      for (const mode of MODES) {
        const bridgedPath = `/v2/exchanges/${pairPath(bridgedBoth)}`;
        const res = await get(url(bridgedPath, 'limit=400', 'autobridged=true', ammQuery(mode)));
        const want = kept(bridgedBoth.rows.filter(autobridged), mode);
        expect([mode, res.body.exchanges]).toEqual([mode, exchangesOf(want)]);
        expect(want.length).toBeGreaterThan(0);
      }
      // pages, ascending and descending: the marker continues inside the filtered rows
      for (const mode of MODES) {
        const want = hashesOf(kept(mixed.rows, mode));
        for (const limit of [1, 3]) {
          const walked = (await pages(url(path, `amm=${mode}`), limit)).flatMap(hashesIn);
          expect([mode, limit, walked]).toEqual([mode, limit, want]);
        }
        const back = (await pages(url(path, `amm=${mode}`, 'descending=true'), 2)).flatMap(hashesIn);
        expect([mode, 'descending', back]).toEqual([mode, 'descending', [...want].reverse()]);
      }
    });

    it('a marker of an order-book row continues in the swaps after it', async () => {
      const path = `/v2/exchanges/${pairPath(mixed)}`;
      // the marker of a book row, in the middle of the pair: the swaps after it
      const middle = mixed.rows.filter((e) => !isSwap(e))[5];
      const after = mixed.rows.filter((e) => isSwap(e) && byKey(e, middle) > 0);
      expect(after.length).toBeGreaterThan(0);
      const res = await get(url(path, 'limit=400', 'amm=only', `marker=${markerOf(middle.row)}`));
      expect(res.body.exchanges).toEqual(exchangesOf(after));
    });

    it('the Link header keeps the filter, so the next page is of the same list', async () => {
      const res = await get(`/v2/exchanges/${pairPath(mixed)}?limit=1&amm=only`);
      const first = kept(mixed.rows, 'only')[0];
      expect(res.headers.link).toBe(
        `<${new URL(res.request.url).origin}/v2/exchanges/${pairPath(mixed)}?limit=1&amm=only&marker=${markerOf(first.row)}>; rel="next"`,
      );
    });
  });

  describe('the exchange object', () => {
    // the keys of the HBase row, in the order of the original, and amm_account last
    const D_FAMILY = ['base_amount', 'counter_amount', 'node_index', 'rate', 'tx_index'];
    const F_FAMILY = [
      'buyer',
      'executed_time',
      'ledger_index',
      'offer_sequence',
      'provider',
      'seller',
      'taker',
      'tx_hash',
      'tx_type',
    ];
    /** The keys of an exchange of a market, whichever way round: what it has of the optional ones, in the original's order. */
    const keysFor = (m: Market, e: FixtureExchange, inverted: boolean): string[] => {
      const [base, counter] = inverted ? [m.counter, m.base] : [m.base, m.counter];
      return [
        ...D_FAMILY,
        ...(e.row.autobridged_currency !== null ? ['autobridged_currency'] : []),
        ...(e.row.autobridged_issuer ? ['autobridged_issuer'] : []),
        ...F_FAMILY,
        'base_currency',
        ...(base.issuer ? ['base_issuer'] : []),
        'counter_currency',
        ...(counter.issuer ? ['counter_issuer'] : []),
        ...(isSwap(e) ? ['amm_account'] : []),
      ];
    };
    const swapOf = (m: Market): FixtureExchange => m.rows.find(isSwap) as FixtureExchange;

    it('a swap has amm_account as its last key; an order-book exchange of the same pair has no such key', async () => {
      const res = await get(`/v2/exchanges/${pairPath(mixed)}?limit=400`);
      const body = res.body as ListBody;
      expect(body.exchanges).toHaveLength(mixed.rows.length);
      mixed.rows.forEach((e, i) => {
        const keys = Object.keys(body.exchanges[i]);
        expect([i, isSwap(e), keys]).toEqual([i, isSwap(e), keysFor(mixed, e, false)]);
        expect(keys.includes('amm_account')).toBe(isSwap(e));
        if (isSwap(e)) expect(body.exchanges[i].amm_account).toBe(e.row.amm_account);
      });
      // pinned: a swap against a pool of an issued currency and the native one
      expect(Object.keys(body.exchanges[mixed.rows.indexOf(swapOf(mixed))])).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'buyer',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
        'base_currency',
        'base_issuer',
        'counter_currency',
        'amm_account',
      ]);
    });

    it('is last whatever else the exchange has: an issuer on both sides, an autobridged currency, either way round', async () => {
      const both = markets.find((m) => m.base.issuer && m.counter.issuer && m.rows.some(isSwap)) as Market;
      const bridged = markets.find((m) =>
        m.rows.some((e) => isSwap(e) && e.row.autobridged_currency !== null),
      ) as Market;
      expect(both).toBeDefined();
      expect(bridged).toBeDefined();
      for (const m of [both, bridged]) {
        for (const inverted of [false, true]) {
          const res = await get(`/v2/exchanges/${pairPath(m, inverted)}?limit=400`);
          const served = (res.body as ListBody).exchanges;
          expect(served).toHaveLength(m.rows.length);
          served.forEach((ex, i) => {
            const label = [pairPath(m, inverted), i];
            expect([...label, Object.keys(ex)]).toEqual([...label, keysFor(m, m.rows[i], inverted)]);
          });
        }
      }
      // pinned: an issued currency on both sides
      const issued = await get(`/v2/exchanges/${pairPath(both)}?limit=400&amm=only`);
      expect(Object.keys(issued.body.exchanges[0])).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'buyer',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
        'base_currency',
        'base_issuer',
        'counter_currency',
        'counter_issuer',
        'amm_account',
      ]);
      // pinned: an autobridged swap, the autobridged currency and issuer in the place of the f family
      const swaps = kept(bridged.rows, 'only');
      const at = swaps.findIndex((e) => e.row.autobridged_currency !== null);
      const autobridged = await get(`/v2/exchanges/${pairPath(bridged)}?limit=400&amm=only`);
      expect(Object.keys(autobridged.body.exchanges[at])).toEqual([
        'base_amount',
        'counter_amount',
        'node_index',
        'rate',
        'tx_index',
        'autobridged_currency',
        'autobridged_issuer',
        'buyer',
        'executed_time',
        'ledger_index',
        'offer_sequence',
        'provider',
        'seller',
        'taker',
        'tx_hash',
        'tx_type',
        'base_currency',
        'base_issuer',
        'counter_currency',
        ...(bridged.counter.issuer ? ['counter_issuer'] : []),
        'amm_account',
      ]);
    });

    it('the pool is the same account whichever way round the pair is asked, and is the provider of the swap', async () => {
      for (const inverted of [false, true]) {
        const res = await get(`/v2/exchanges/${pairPath(mixed, inverted)}?limit=400&amm=only`);
        for (const [i, e] of kept(mixed.rows, 'only').entries()) {
          const ex = (res.body as ListBody).exchanges[i];
          expect([inverted, i, ex.amm_account, ex.provider, ex.offer_sequence]).toEqual([
            inverted,
            i,
            e.row.amm_account,
            e.row.amm_account,
            0,
          ]);
        }
      }
    });

    it('amm=exclude serves the pair exactly as before AMM: no object has the key', async () => {
      for (const m of markets) {
        const res = await get(`/v2/exchanges/${pairPath(m)}?limit=400&amm=exclude`);
        for (const ex of (res.body as ListBody).exchanges) expect(Object.keys(ex)).not.toContain('amm_account');
      }
    });
  });

  describe('interval and reduce', () => {
    const rowsOf = (m: Market, mode?: Mode): ExchangesRow[] => kept(m.rows, mode).map((e) => e.row);

    it('the candles and the reduced row of each mode are the aggregation of the exchanges it keeps, both ways round', async () => {
      let candles = 0;
      for (const m of [mixed, swapsOnly, bookOnly]) {
        for (const inverted of [false, true]) {
          const path = `/v2/exchanges/${pairPath(m, inverted)}`;
          for (const mode of [undefined, ...MODES]) {
            for (const interval of ['1hour', '1day', '1year']) {
              const res = await get(url(path, `interval=${interval}`, ammQuery(mode)));
              const want = candlesOf(m, interval, inverted, rowsOf(m, mode));
              expectAggregates([path, interval, mode], res.body.exchanges, want);
              candles += want.length;
            }
            const reduced = await get(url(path, 'reduce=true', ammQuery(mode)));
            expectAggregates([path, 'reduce', mode], reduced.body.exchanges, [
              reducedOf(m, inverted, '2013-01-01T00:00:00Z', rowsOf(m, mode)),
            ]);
          }
        }
      }
      expect(candles).toBeGreaterThan(40);
    });

    it('the reduced row counts what the filter keeps: include is exclude and only added up', async () => {
      const count = async (mode: Mode): Promise<number> =>
        (await get(`/v2/exchanges/${pairPath(mixed)}?reduce=true&amm=${mode}`)).body.exchanges[0].count;
      const [include, exclude, only] = [await count('include'), await count('exclude'), await count('only')];
      expect([include, exclude, only]).toEqual([
        aggregated(rowsOf(mixed)).length,
        aggregated(rowsOf(mixed, 'exclude')).length,
        aggregated(rowsOf(mixed, 'only')).length,
      ]);
      expect(include).toBe(exclude + only);
      expect(only).toBeGreaterThan(0);
      expect(exclude).toBeGreaterThan(0);
    });

    it('a pair without exchanges of the kind: no candles, the row of zeros', async () => {
      const none = await get(`/v2/exchanges/${pairPath(bookOnly)}?interval=1day&amm=only`);
      expect(none.body).toEqual({ result: 'success', count: 0, exchanges: [] });
      const zeros = await get(`/v2/exchanges/${pairPath(bookOnly)}?reduce=true&amm=only`);
      expect(zeros.body.exchanges[0]).toMatchObject({ count: 0, base_volume: '0', counter_volume: '0' });
    });

    it('a swap whose native leg is 0.0005 or less is listed, and left out of the candles and the reduced row, as an order-book exchange is', async () => {
      const tiny = (e: FixtureExchange): boolean => aggregated([e.row]).length === 0;
      const dust = markets.filter((m) => m.rows.some((e) => isSwap(e) && tiny(e)));
      expect(dust.length).toBeGreaterThanOrEqual(3);
      for (const m of dust) {
        const swaps = kept(m.rows, 'only');
        for (const inverted of [false, true]) {
          const path = `/v2/exchanges/${pairPath(m, inverted)}`;
          // listed: the raw list has every swap, the dust ones too
          const raw = await get(`${path}?limit=400&amm=only`);
          expect([path, raw.body.exchanges]).toEqual([path, exchangesOf(swaps, inverted)]);
          // aggregated: the dust ones are out of it
          const reduced = await get(`${path}?reduce=true&amm=only`);
          const want = reducedOf(m, inverted, '2013-01-01T00:00:00Z', rowsOf(m, 'only'));
          expectAggregates([path, 'reduce'], reduced.body.exchanges, [want]);
          expect(reduced.body.exchanges[0].count).toBe(aggregated(rowsOf(m, 'only')).length);
          expect(reduced.body.exchanges[0].count).toBeLessThan(swaps.length);
          const candles = await get(`${path}?interval=1day&amm=only`);
          expectAggregates([path, '1day'], candles.body.exchanges, candlesOf(m, '1day', inverted, rowsOf(m, 'only')));
        }
      }
    });

    it('candle pages hold the candles of the filtered exchanges, in both directions', async () => {
      for (const mode of MODES) {
        const path = `/v2/exchanges/${pairPath(mixed)}?interval=1hour&amm=${mode}`;
        const whole = await get(path);
        expectAggregates([path], whole.body.exchanges, candlesOf(mixed, '1hour', false, rowsOf(mixed, mode)));
        for (const descending of [false, true]) {
          const walked = (await pages(`${path}&descending=${descending}`, 1)).flatMap((p) => p.exchanges);
          expect([mode, descending, walked]).toEqual([
            mode,
            descending,
            descending ? [...whole.body.exchanges].reverse() : whole.body.exchanges,
          ]);
        }
      }
    });

    it('autobridged=true and amm together aggregate the autobridged exchanges of the kind', async () => {
      const autobridged = bridgedBoth.rows.filter((e) => e.row.autobridged_currency !== null);
      for (const mode of MODES) {
        const rows = kept(autobridged, mode).map((e) => e.row);
        expect(rows.length).toBeGreaterThan(0);
        const reduced = await get(`/v2/exchanges/${pairPath(bridgedBoth)}?reduce=true&autobridged=true&amm=${mode}`);
        expectAggregates(['reduce', mode], reduced.body.exchanges, [
          reducedOf(bridgedBoth, false, '2013-01-01T00:00:00Z', rows),
        ]);
      }
    });

    it('format=csv: the candles of swaps in the columns of the original', async () => {
      const res = await get(`/v2/exchanges/${pairPath(mixed)}?interval=1day&amm=only&format=csv`);
      const lines = res.text.split('\n');
      expect(lines[0]).toBe(AGGREGATE_CSV_COLUMNS.map((c) => `"${c}"`).join(','));
      expect(lines).toHaveLength(1 + candlesOf(mixed, '1day', false, rowsOf(mixed, 'only')).length);
    });
  });

  describe('/v2/exchanges (all pairs)', () => {
    it('amm unset, include, exclude and only list every exchange, the order-book ones and the swaps, oldest first', async () => {
      for (const mode of [undefined, ...MODES]) {
        const path = url('/v2/exchanges', 'limit=400', ammQuery(mode));
        const want = kept(MIXED, mode);
        const res = await get(path);
        expect([path, res.body.count, res.body.marker]).toEqual([path, want.length, undefined]);
        expect([path, res.body.exchanges]).toEqual([path, exchangesOf(want)]);
      }
      expect(kept(MIXED, 'only')).toHaveLength(138);
      expect(kept(MIXED, 'exclude')).toHaveLength(197);
    });

    it('walks each list page by page, ascending and descending, whatever the size of the page', async () => {
      for (const [mode, limits] of [
        ['include', [60]],
        ['exclude', [7, 50]],
        ['only', [1, 7, 50]],
      ] as const) {
        const want = hashesOf(kept(MIXED, mode));
        for (const limit of limits) {
          const walked = (await pages(`/v2/exchanges?amm=${mode}`, limit)).flatMap(hashesIn);
          expect([mode, limit, walked]).toEqual([mode, limit, want]);
        }
        const back = (await pages(`/v2/exchanges?amm=${mode}&descending=true`, 9)).flatMap(hashesIn);
        expect([mode, 'descending', back]).toEqual([mode, 'descending', [...want].reverse()]);
      }
    });

    it('a window of dates, and a marker in the middle of the swaps', async () => {
      const from = '2026-10-16T00:00:00';
      const before = '2026-10-17T00:00:00';
      const day = closedBetween(MIXED, from, before);
      expect(day.filter(isSwap).length).toBeGreaterThan(3);
      expect(day.filter((e) => !isSwap(e)).length).toBeGreaterThan(3);
      for (const mode of MODES) {
        const res = await get(
          url('/v2/exchanges', 'limit=400', `start=${from}`, 'end=2026-10-16T23:59:59', `amm=${mode}`),
        );
        expect([mode, res.body.exchanges]).toEqual([mode, exchangesOf(kept(day, mode))]);
      }
      const swaps = kept(MIXED, 'only');
      const from3 = swaps[3];
      const res = await get(`/v2/exchanges?amm=only&limit=400&marker=${markerOf(from3.row)}`);
      expect(res.body.exchanges).toEqual(exchangesOf(swaps.slice(4)));
      const back = await get(`/v2/exchanges?amm=only&limit=400&descending=true&marker=${markerOf(from3.row)}`);
      expect(back.body.exchanges).toEqual(exchangesOf(swaps.slice(0, 3).reverse()));
    });

    it('autobridged=true and amm=only: the autobridged swaps', async () => {
      const want = MIXED.filter((e) => isSwap(e) && e.row.autobridged_currency !== null);
      expect(want).toHaveLength(2);
      const res = await get('/v2/exchanges?autobridged=true&amm=only&limit=400');
      expect(res.body.exchanges).toEqual(exchangesOf(want));
      const none = await get('/v2/exchanges?autobridged=true&amm=exclude&limit=400');
      expect(none.body.exchanges).toEqual(
        exchangesOf(MIXED.filter((e) => !isSwap(e) && e.row.autobridged_currency !== null)),
      );
    });

    it('format=csv: amm_account is a last column when a swap is on the page, and the usual columns when none is', async () => {
      const book = await get('/v2/exchanges?format=csv&limit=400&amm=exclude');
      const lines = book.text.split('\n');
      // byte for byte the header of before AMM
      expect(lines[0]).toBe(CSV_COLUMNS.map((c) => `"${c}"`).join(','));
      expect(lines).toHaveLength(1 + 197);

      const swaps = await get('/v2/exchanges?format=csv&limit=400&amm=only');
      const rows = swaps.text.split('\n');
      expect(rows[0]).toBe([...CSV_COLUMNS, 'amm_account'].map((c) => `"${c}"`).join(','));
      expect(rows).toHaveLength(1 + 138);
      const pools = kept(MIXED, 'only').map((e) => `"${e.row.amm_account}"`);
      expect(rows.slice(1).map((row) => row.split(',').at(-1))).toEqual(pools);

      // a page of both: the column is there, empty for the order-book rows
      const both = await get('/v2/exchanges?format=csv&limit=400');
      const all = both.text.split('\n');
      expect(all[0]).toBe([...CSV_COLUMNS, 'amm_account'].map((c) => `"${c}"`).join(','));
      all.slice(1).forEach((row, i) => {
        const e = MIXED[i];
        expect([i, row.split(',').at(-1)]).toEqual([i, isSwap(e) ? `"${e.row.amm_account}"` : '""']);
      });
    });

    it('the pair route has the column too, and is named as before', async () => {
      const res = await get(`/v2/exchanges/${pairPath(mixed)}?format=csv&limit=400&amm=only`);
      expect(res.headers['content-disposition']).toBe(
        csvDisposition(`exchanges - ${mixed.base.currency}-${mixed.counter.currency}`),
      );
      expect(res.text.split('\n')[0].endsWith(',"amm_account"')).toBe(true);
    });
  });

  describe('an amm that is none of the three', () => {
    const PAIR_PATH = `/v2/exchanges/${pairPath(mixed)}`;
    const routes = [
      PAIR_PATH,
      `${PAIR_PATH}?interval=1day`,
      `${PAIR_PATH}?reduce=true`,
      `${PAIR_PATH}?format=csv`,
      '/v2/exchanges',
      '/v2/exchanges?format=csv',
    ];

    it('is 400 invalid amm filter - use: include, exclude, only, on every route that takes it', async () => {
      for (const route of routes) {
        for (const amm of ['nonsense', 'ONLY', 'Exclude', 'true', '1', 'none', '%20only']) {
          const path = url(route, `amm=${amm}`);
          const res = await get(path);
          expect([path, res.status, res.body]).toEqual([path, 400, { result: 'error', message: MESSAGE }]);
        }
      }
    });

    it('is the first value that counts: a bad one first is an error, a good one first is not', async () => {
      expect((await get(`${PAIR_PATH}?amm=nope&amm=only`)).status).toBe(400);
      expect((await get(`${PAIR_PATH}?amm=only&amm=nope`)).status).toBe(200);
    });

    it('is checked after the pair, start, end and limit, and before the interval and reduce and the marker', async () => {
      const bad = (extra: string): string => `${extra}&amm=nonsense`;
      const message = async (path: string): Promise<unknown> => (await get(path)).body.message;
      expect(await message(`/v2/exchanges/USD/XRP?${bad('limit=abc')}`)).toBe('base issuer is required');
      expect(await message(`${PAIR_PATH}?${bad('start=2015x')}`)).toBe('invalid start date format');
      expect(await message(`${PAIR_PATH}?${bad('end=2015x')}`)).toBe('invalid end date format');
      expect(await message(`${PAIR_PATH}?${bad('limit=abc')}`)).toBe('invalid limit: NaN');
      expect(await message(`${PAIR_PATH}?${bad('reduce=true&interval=1day')}`)).toBe(MESSAGE);
      expect(await message(`${PAIR_PATH}?${bad('interval=3weeks')}`)).toBe(MESSAGE);
      expect(await message(`${PAIR_PATH}?${bad('marker=garbage')}`)).toBe(MESSAGE);
      // a good filter changes none of the other answers
      expect(await message(`${PAIR_PATH}?amm=only&marker=garbage`)).toBe('invalid marker');
      expect(await message(`${PAIR_PATH}?amm=only&interval=3weeks`)).toBe('invalid interval: 3weeks');
      expect(await message(`${PAIR_PATH}?amm=only&reduce=true&interval=1day`)).toBe('cannot use reduce with interval');
      expect(await message('/v2/exchanges?amm=only&limit=abc')).toBe('invalid limit: NaN');
      expect(await message('/v2/exchanges?limit=abc&amm=nonsense')).toBe('invalid limit: NaN');
      expect(await message('/v2/exchanges?amm=nonsense&marker=garbage')).toBe(MESSAGE);
    });
  });

  describe('the SQL', () => {
    /** The text of the read of `exchanges` inside the capped inner select of a page. */
    const inner = (sql: string): string => innerRead(sql);

    it('the condition is inside the read that is capped, never after the page: amm=only and amm=exclude, bound and in order', async () => {
      for (const [mode, condition] of [
        ['only', "amm_account != ''"],
        ['exclude', "amm_account = ''"],
      ] as const) {
        for (const descending of [false, true]) {
          for (const m of [mixed, swapsOnly]) {
            const query = jest.spyOn(h.ch, 'query');
            await get(
              `/v2/exchanges/${pairPath(m)}?limit=3&amm=${mode}&descending=${descending}&marker=${markerOf(m.rows[1].row)}`,
            );
            const calls = exchangesCalls(query);
            jest.restoreAllMocks();
            expect(calls).toHaveLength(1);
            const [sql, params] = calls[0] as [string, Record<string, unknown>];
            const where = [mode, descending, pairPath(m)];
            expect([...where, inner(sql).includes(condition)]).toEqual([...where, true]);
            // not once more outside the read: the page is cut by the LIMIT of the read, and the filter is what it counts
            expect([...where, sql.split(condition).length - 1]).toEqual([...where, 1]);
            expect(sql).not.toMatch(/\bFINAL\b/);
            await expectBoundedInOrderRead(h, sql, params, descending, where);
          }
        }
      }
    });

    it('include adds no condition: amm=include reads what no amm reads', async () => {
      const readOf = async (query: string): Promise<string> => {
        const spy = jest.spyOn(h.ch, 'query');
        await get(`/v2/exchanges/${pairPath(mixed)}?limit=3${query}`);
        const calls = exchangesCalls(spy);
        jest.restoreAllMocks();
        expect(calls).toHaveLength(1);
        return String(calls[0][0]);
      };
      const include = await readOf('&amm=include');
      // the column is read (it is in the object of a swap), but nothing is asked of it
      expect(include).not.toMatch(/amm_account\s*(!=|=)/);
      expect(await readOf('')).toBe(include);
    });

    it('interval and reduce: every read of exchanges has the condition, the buckets of the page and their aggregation', async () => {
      for (const [mode, condition] of [
        ['only', "amm_account != ''"],
        ['exclude', "amm_account = ''"],
      ] as const) {
        const query = jest.spyOn(h.ch, 'query');
        await get(`/v2/exchanges/${pairPath(mixed)}?interval=1hour&limit=2&amm=${mode}`);
        const candles = exchangesCalls(query).map(([sql]) => String(sql));
        jest.restoreAllMocks();
        expect(candles).toHaveLength(2);
        for (const sql of candles) expect([mode, sql.includes(condition)]).toEqual([mode, true]);

        const reduce = jest.spyOn(h.ch, 'query');
        await get(`/v2/exchanges/${pairPath(mixed)}?reduce=true&amm=${mode}`);
        const reads = exchangesCalls(reduce).map(([sql]) => String(sql));
        jest.restoreAllMocks();
        expect(reads).toHaveLength(1);
        expect([mode, reads[0].includes(condition)]).toEqual([mode, true]);
      }
    });

    it('/v2/exchanges: the condition is in the read of the exchanges of the window', async () => {
      for (const [mode, condition] of [
        ['only', "amm_account != ''"],
        ['exclude', "amm_account = ''"],
      ] as const) {
        const query = jest.spyOn(h.ch, 'query');
        await get(`/v2/exchanges?limit=3&amm=${mode}`);
        const reads = exchangesCalls(query).map(([sql]) => String(sql));
        jest.restoreAllMocks();
        expect(reads.length).toBeGreaterThan(0);
        for (const sql of reads) expect([mode, sql.includes(condition)]).toEqual([mode, true]);
      }
    });

    it('/v2/exchanges?amm=only reads the range once: the ledgers count the order-book exchanges too, so they size no window', async () => {
      const query = jest.spyOn(h.ch, 'query');
      const res = await get('/v2/exchanges?limit=3&amm=only');
      expect(hashesIn(res.body)).toEqual(hashesOf(kept(MIXED, 'only').slice(0, 3)));
      expect(exchangesCalls(query)).toHaveLength(1);
      const ledgers = query.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.Ledgers}\\b`).test(String(q)));
      // the range of the dates (one read of the ledgers), no window edge
      expect(ledgers.every(([q]) => !String(q).includes('exchanges_count'))).toBe(true);
    });
  });
});

describe('exchanges API endpoint: swaps that were written twice (the amm filter)', () => {
  // The tables are ReplacingMergeTree and no list uses FINAL: until a merge a row can be there twice. The swaps of one
  // ledger are written a second time (a real duplicate: merges stopped, a separate insert, no insert deduplication).
  const SEED = 'ripple-mock+amm';
  const MIXED = [...fixtureExchanges(SEED)].sort(byKey);
  const isSwap = (e: FixtureExchange): boolean => e.row.amm_account !== '';
  const markets = marketsOf(MIXED);
  const swapCounts = new Map<number, number>();
  for (const e of MIXED.filter(isSwap))
    swapCounts.set(e.row.ledger_index, (swapCounts.get(e.row.ledger_index) ?? 0) + 1);
  const LEDGER = [...swapCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const written = MIXED.filter((e) => e.row.ledger_index === LEDGER);
  // the pair with the most swaps in that ledger
  const market = marketsOf(written.filter(isSwap)).sort((a, b) => b.rows.length - a.rows.length)[0];
  const full = markets.find(
    (m) => pathOf(m.base) === pathOf(market.base) && pathOf(m.counter) === pathOf(market.counter),
  ) as Market;
  const path = `/v2/exchanges/${pathOf(full.base)}/${pathOf(full.counter)}`;

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (p: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(p, limit, 'exchanges');

  beforeAll(async () => {
    h = await startHarness({ seed: SEED, env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.Exchanges}`);
    await h.ch.command(
      `INSERT INTO ${Table.Exchanges} SELECT * FROM ${Table.Exchanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
      { settings: { insert_deduplicate: 0 } },
    );
    const [{ n }] = await h.ch.query<{ n: string }>(
      `SELECT count() AS n FROM ${Table.Exchanges} WHERE ledger_index = {index:UInt32}`,
      { index: LEDGER },
    );
    expect(Number(n)).toBe(written.length * 2);
    const [{ swaps }] = await h.ch.query<{ swaps: string }>(
      `SELECT count() AS swaps FROM ${Table.Exchanges} WHERE ledger_index = {index:UInt32} AND amm_account != ''`,
      { index: LEDGER },
    );
    expect(Number(swaps)).toBe(written.filter(isSwap).length * 2);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists the swaps of a pair once, each mode, page by page', async () => {
    expect(full.rows.filter((e) => e.row.ledger_index === LEDGER && isSwap(e)).length).toBeGreaterThan(0);
    for (const mode of ['include', 'exclude', 'only'] as const) {
      const want =
        mode === 'exclude'
          ? full.rows.filter((e) => !isSwap(e))
          : mode === 'only'
            ? full.rows.filter(isSwap)
            : full.rows;
      const unpaged = await get(`${path}?limit=400&amm=${mode}`);
      expect([mode, unpaged.body.exchanges]).toEqual([mode, exchangesOf(want)]);
      for (const limit of [1, 2, 3]) {
        const walked = (await pages(`${path}?amm=${mode}`, limit)).flatMap(hashesIn);
        expect([mode, limit, walked]).toEqual([mode, limit, hashesOf(want)]);
      }
    }
  });

  it('lists the swaps of the whole range once', async () => {
    const want = MIXED.filter(isSwap);
    const unpaged = await get('/v2/exchanges?amm=only&limit=400');
    expect(unpaged.body.exchanges).toEqual(exchangesOf(want));
    for (const limit of [1, 5]) {
      const walked = (await pages('/v2/exchanges?amm=only', limit)).flatMap(hashesIn);
      expect([limit, walked]).toEqual([limit, hashesOf(want)]);
    }
  });

  it('aggregates the swaps once: candles and reduce', async () => {
    for (const mode of ['include', 'only'] as const) {
      const rows = (mode === 'only' ? full.rows.filter(isSwap) : full.rows).map((e) => e.row);
      for (const inverted of [false, true]) {
        const p = inverted ? `/v2/exchanges/${pathOf(full.counter)}/${pathOf(full.base)}` : path;
        const candles = await get(`${p}?interval=1day&amm=${mode}`);
        expectAggregates([p, mode], candles.body.exchanges, candlesOf(full, '1day', inverted, rows));
        const reduced = await get(`${p}?reduce=true&amm=${mode}`);
        expectAggregates([p, mode], reduced.body.exchanges, [reducedOf(full, inverted, '2013-01-01T00:00:00Z', rows)]);
      }
    }
  });
});

describe('exchanges API endpoint on Xahau (synthetic rows: the recorded ledgers hold no exchange)', () => {
  const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
  const ledgers = fixtureSource('xahau-recorded').list();
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const rows: ExchangesRow[] = [];

  /** An exchange of USD+ISSUER (base) for XAH (counter), the canonical order: 'usd…' sorts before 'xahundefined'. */
  function row(ledgerPos: number, txIndex: number, over: Partial<ExchangesRow> = {}): ExchangesRow {
    const ledger = ledgers[ledgerPos];
    return {
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XAH',
      counter_issuer: '',
      ledger_index: ledger.header.ledger_index,
      tx_index: txIndex,
      node_index: 2,
      tx_hash: `${txIndex}`.padStart(64, 'A'),
      close_time: ledger.header.close_time,
      base_amount: '10',
      counter_amount: '25',
      base_amount_f: 10,
      counter_amount_f: 25,
      rate: '2.5',
      rate_f: 2.5,
      buyer: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
      seller: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
      taker: 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7',
      provider: 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD',
      offer_sequence: 12,
      amm_account: '',
      autobridged_currency: null,
      autobridged_issuer: null,
      tx_type: 'OfferCreate',
      client: null,
      ...over,
    };
  }

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    rows.push(
      row(1, 3),
      row(1, 9, { rate: '4', base_amount: '5', counter_amount: '20' }),
      row(3, 1, { rate: '0.5', counter_amount: '5' }),
    );
    await h.ch.insert(Table.Exchanges, rows);
    // what the LedgerWriter would have written with them: the exchanges of each ledger in its `ledgers` row, which the
    // list of every pair sizes its windows by
    for (const [ledger, n] of rows.reduce(
      (m, r) => m.set(r.ledger_index, (m.get(r.ledger_index) ?? 0) + 1),
      new Map<number, number>(),
    )) {
      await h.ch.command(
        `ALTER TABLE ${Table.Ledgers} UPDATE exchanges_count = {n:UInt32} WHERE ledger_index = {ledger:UInt32}`,
        { n, ledger },
        { settings: { mutations_sync: '2' } },
      );
    }
  });
  afterAll(async () => {
    await h?.close();
  });

  it('XAH is the native currency of the pair: no issuer on it, and the reversed pair is inverted', async () => {
    const res = await api.ok<ListBody>(`/v2/exchanges/USD+${ISSUER}/XAH`, 'exchanges');
    expect(res.body.count).toBe(3);
    expect(hashesIn(res.body)).toEqual(rows.map((r) => r.tx_hash));
    expect(res.body.exchanges[0]).toMatchObject({
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XAH',
      base_amount: '10',
      counter_amount: '25',
      rate: '2.5000000',
    });
    expect(res.body.exchanges[0]).not.toHaveProperty('counter_issuer');
    const reversed = await api.ok<ListBody>(`/v2/exchanges/xah/USD+${ISSUER}`, 'exchanges');
    expect(hashesIn(reversed.body)).toEqual(rows.map((r) => r.tx_hash));
    expect(reversed.body.exchanges[0]).toMatchObject({
      base_currency: 'XAH',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
      base_amount: '25',
      counter_amount: '10',
      buyer: rows[0].seller,
      seller: rows[0].buyer,
      rate: '0.40000000',
    });
    expect(reversed.body.exchanges[0]).not.toHaveProperty('base_issuer');
    expect(reversed.body.exchanges[1].rate).toBe('0.25000000');
    expect(reversed.body.exchanges[2].rate).toBe('2.0000000');
  });

  it('XAH takes the place of XRP: XRP needs an issuer, XAH cannot have one', async () => {
    const xrp = await get(`/v2/exchanges/USD+${ISSUER}/XRP`);
    expect([xrp.status, xrp.body]).toEqual([400, { result: 'error', message: 'counter issuer is required' }]);
    const withIssuer = await get(`/v2/exchanges/USD+${ISSUER}/XAH+${ISSUER}`);
    expect([withIssuer.status, withIssuer.body]).toEqual([
      400,
      { result: 'error', message: 'XAH cannot have an issuer' },
    ]);
    // an issued currency that is called XRP on Xahau is an ordinary (empty) market
    const issued = await get(`/v2/exchanges/USD+${ISSUER}/XRP+${ISSUER}`);
    expect([issued.status, issued.body.count]).toEqual([200, 0]);
  });

  it('a window of the recorded ledgers, the markers, the all-pairs list', async () => {
    const mid = rows[2].close_time;
    const from = executedTime(mid).slice(0, 19);
    const window = await get(`/v2/exchanges/USD+${ISSUER}/XAH?start=${from}`);
    expect(window.body.exchanges.map((e: { tx_hash: string }) => e.tx_hash)).toEqual([rows[2].tx_hash]);
    const paged = await api.pages<ListBody>(`/v2/exchanges/USD+${ISSUER}/XAH`, 1, 'exchanges');
    expect(paged.flatMap(hashesIn)).toEqual(rows.map((r) => r.tx_hash));
    const all = await get('/v2/exchanges');
    expect(all.body.count).toBe(3);
    expect(all.body.exchanges[0]).toMatchObject({ base_currency: 'USD', counter_currency: 'XAH' });
    expect((await get('/v2/exchanges?start=2030-01-01')).body.count).toBe(0);
  });

  it('aggregates with XAH as the native currency: no issuer key on it, either way round', async () => {
    const reduced = await api.ok<ListBody>(`/v2/exchanges/USD+${ISSUER}/XAH?reduce=true`, 'exchanges');
    expect(reduced.body.exchanges[0]).toMatchObject({
      count: 3,
      open: '2.5000000',
      close: '0.50000000',
      base_currency: 'USD',
      base_issuer: ISSUER,
      counter_currency: 'XAH',
    });
    expect(reduced.body.exchanges[0]).not.toHaveProperty('counter_issuer');
    const day = await api.ok<ListBody>(`/v2/exchanges/xah/USD+${ISSUER}?interval=1day`, 'exchanges');
    expect(day.body.count).toBe(1);
    expect(day.body.exchanges[0]).toMatchObject({
      count: 3,
      open: '0.40000000',
      close: '2.0000000',
      base_currency: 'XAH',
      counter_currency: 'USD',
      counter_issuer: ISSUER,
    });
    expect(day.body.exchanges[0]).not.toHaveProperty('base_issuer');
  });

  it('format=csv is named after the pair', async () => {
    const res = await get(`/v2/exchanges/xah/USD+${ISSUER}?format=csv`);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(csvDisposition('exchanges - XAH-USD'));
    expect(res.text.split('\n')).toHaveLength(1 + 3);
  });
});

describe.each([
  ['xrpl', 'XRP'],
  ['xahau', 'XAH'],
] as const)('exchanges API endpoint, interval and reduce on synthetic ledgers (%s)', (network, NATIVE) => {
  const ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De';
  const BUYER = 'rBun4BLewDvTfLHQLqWuAnqucTzwaoPXoD';
  const SELLER = 'rnCEEqDnCuSjDsHiJrca4VYUqaMyi4vGF7';
  /** One ledger at each time: the edges of the buckets of every interval. */
  const TIMES = [
    '2013-01-02T00:00:00', // a Wednesday: its ISO week began in 2012
    '2014-12-31T23:59:59',
    '2015-01-01T00:00:00',
    '2015-01-02T23:59:59',
    '2015-01-03T00:00:00', // 3 days after 2014-12-31, 732 days after 2013-01-01
    '2015-01-04T23:59:59', // a Sunday
    '2015-01-05T00:00:00', // a Monday
    '2015-01-31T23:59:59',
    '2015-02-01T00:00:00',
    '2016-02-29T12:00:00', // a leap day, a Monday
    '2016-03-01T03:59:59',
    '2016-03-01T04:00:00',
    '2016-03-01T10:04:59',
    '2016-03-01T10:05:00',
    '2016-03-01T10:29:59',
    '2016-03-01T10:30:00',
  ];
  const LEDGERS = TIMES.map((iso, i) => ({
    ledger_index: 1000 + i * 10,
    ledger_hash: `${i}`.padStart(64, 'C'),
    close_time: unix(iso),
  }));
  const USD_M: Market = { base: { currency: 'USD', issuer: ISSUER }, counter: { currency: NATIVE }, rows: [] };
  // the native currency sorts before ZAR, so it is the stored base of this pair
  const ZAR_M: Market = { base: { currency: NATIVE }, counter: { currency: 'ZAR', issuer: ISSUER }, rows: [] };

  function exchange(
    m: Market,
    ledger: number,
    txIndex: number,
    nodeIndex: number,
    baseAmount: string,
    counterAmount: string,
    takerBuys: boolean,
  ): ExchangesRow {
    const rate = new BigNumber(counterAmount).dividedBy(baseAmount).toString();
    return {
      base_currency: m.base.currency,
      base_issuer: m.base.issuer ?? '',
      counter_currency: m.counter.currency,
      counter_issuer: m.counter.issuer ?? '',
      ledger_index: LEDGERS[ledger].ledger_index,
      tx_index: txIndex,
      node_index: nodeIndex,
      tx_hash: `${ledger * 100 + txIndex}`.padStart(64, 'D'),
      close_time: LEDGERS[ledger].close_time,
      base_amount: baseAmount,
      counter_amount: counterAmount,
      base_amount_f: Number(baseAmount),
      counter_amount_f: Number(counterAmount),
      rate,
      rate_f: Number(rate),
      buyer: BUYER,
      seller: SELLER,
      taker: takerBuys ? BUYER : SELLER,
      provider: takerBuys ? SELLER : BUYER,
      offer_sequence: 7,
      amm_account: '',
      autobridged_currency: null,
      autobridged_issuer: null,
      tx_type: 'OfferCreate',
      client: null,
    };
  }
  const inKeyOrder = (rows: ExchangesRow[]): ExchangesRow[] =>
    [...rows].sort((a, b) => a.ledger_index - b.ledger_index || a.tx_index - b.tx_index || a.node_index - b.node_index);

  // two exchanges in every ledger, the one with the lower key written second; rates differ all over
  const USD_ROWS = TIMES.flatMap((_, i) => {
    const big = new BigNumber(3 + i);
    const small = new BigNumber('1.5');
    return [
      exchange(USD_M, i, 7, 1, big.toString(), big.times(2 + i / 4).toString(), i % 2 === 0),
      exchange(USD_M, i, 2, 4, small.toString(), small.times(1.9 + i / 4).toString(), i % 3 === 0),
    ];
  });
  // an amount of 1e36 or more cannot be summed exactly: the aggregations that hold one use the float sums
  const BIG_M: Market = { base: { currency: 'BIG', issuer: ISSUER }, counter: { currency: NATIVE }, rows: [] };
  const BIG_ROWS = [
    exchange(BIG_M, 2, 1, 1, '2e+40', '5', true),
    exchange(BIG_M, 3, 1, 1, '1e+40', '7', false),
    exchange(BIG_M, 9, 1, 1, '0.1', '0.2', true),
    exchange(BIG_M, 10, 1, 1, '0.2', '0.4', true),
  ];
  // amounts a 30-place decimal cannot hold whole: dust far below 1e-30, digits past 30 places (a stored amount is the
  // difference of two ledger amounts), on a native pair and between two issued currencies
  const DUST_M: Market = { base: { currency: 'DST', issuer: ISSUER }, counter: { currency: NATIVE }, rows: [] };
  const IOU_M: Market = {
    base: { currency: 'AAA', issuer: ISSUER },
    counter: { currency: 'ZZZ', issuer: BUYER },
    rows: [],
  };
  const LONG = '0.99999999999999999998765432109876544'; // about 1, with 35 decimal places
  const DUST_ROWS = [
    exchange(DUST_M, 2, 1, 1, LONG, '3', true),
    exchange(DUST_M, 9, 1, 1, '0.1', '0.2', true),
    exchange(DUST_M, 9, 2, 1, '0.2', '0.4', false),
    exchange(DUST_M, 12, 1, 1, '1e-35', '2', true),
    exchange(DUST_M, 13, 1, 1, '1.234567890123456e-25', '3', false),
  ];
  const IOU_ROWS = [
    exchange(IOU_M, 12, 1, 1, '1e-35', '1e-34', true),
    exchange(IOU_M, 13, 1, 1, '1.234567890123456e-25', '5e-25', true),
  ];
  // a zero side: the parser keeps an exchange whose rate is in the book directory
  const NIL_M: Market = { base: { currency: 'NIL', issuer: ISSUER }, counter: { currency: NATIVE }, rows: [] };
  const NIL_ROWS = [{ ...exchange(NIL_M, 2, 1, 1, '1', '1', true), base_amount: '0', base_amount_f: 0 }];
  // native amounts around 0.0005: 0.0005, 0.0004 and 0.000001 are left out of the aggregates
  const ZAR_ROWS = (
    [
      [2, '0.0005'],
      [3, '0.0004'],
      [4, '0.0005001'],
      [9, '2'],
      [10, '0.000001'],
      [11, '3.5'],
    ] as const
  ).map(([ledger, amount], k) => exchange(ZAR_M, ledger, 3, 2, amount, `${k + 1}`, k % 2 === 0));

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<ListBody[]> => api.pages<ListBody>(path, limit, 'exchanges');
  beforeAll(async () => {
    h = await startHarness({ network, seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.insert(Table.Ledgers, LEDGERS);
    await h.ch.insert(Table.Exchanges, [...USD_ROWS, ...ZAR_ROWS, ...BIG_ROWS, ...DUST_ROWS, ...IOU_ROWS, ...NIL_ROWS]);
  });
  afterAll(async () => {
    await h?.close();
  });

  const USD_PATH = `/v2/exchanges/USD+${ISSUER}/${NATIVE}`;
  const counts = async (query: string, path = USD_PATH): Promise<unknown[]> => {
    const res = await api.ok<ListBody>(`${path}?${query}`, 'exchanges');
    return (res.body.exchanges as Record<string, unknown>[]).map((c) => [String(c.start).slice(0, 19), c.count]);
  };

  it('every interval, both orientations: the buckets of the original', async () => {
    expect(USD_ROWS).toHaveLength(32);
    for (const interval of EXCHANGE_INTERVALS) {
      for (const inverted of [false, true]) {
        const path = `${inverted ? `/v2/exchanges/${NATIVE}/USD+${ISSUER}` : USD_PATH}?interval=${interval}&start=2012-01-01&limit=400`;
        const res = await get(path);
        expect([path, res.status]).toEqual([path, 200]);
        expectAggregates(path, res.body.exchanges, candlesOf(USD_M, interval, inverted, inKeyOrder(USD_ROWS)));
      }
    }
  });

  it('3day buckets align to 2013-01-01', async () => {
    expect(await counts('interval=3day')).toEqual([
      ['2013-01-01T00:00:00', 2],
      ['2014-12-31T00:00:00', 6],
      ['2015-01-03T00:00:00', 6],
      ['2015-01-30T00:00:00', 4],
      ['2016-02-27T00:00:00', 2],
      ['2016-03-01T00:00:00', 12],
    ]);
    // a start inside a bucket leaves it out: the first 3 days that start in 2015 begin on the 3rd
    expect(await counts('interval=3day&start=2015-01-01')).toEqual([
      ['2015-01-03T00:00:00', 6],
      ['2015-01-30T00:00:00', 4],
      ['2016-02-27T00:00:00', 2],
      ['2016-03-01T00:00:00', 12],
    ]);
  });

  it('week is 7day, the ISO week from Monday; the default start leaves out the week that began in 2012', async () => {
    const weeks = [
      ['2014-12-29T00:00:00', 10],
      ['2015-01-05T00:00:00', 2],
      ['2015-01-26T00:00:00', 4],
      ['2016-02-29T00:00:00', 14],
    ];
    expect(await counts('interval=week')).toEqual(weeks);
    expect(await counts('interval=7day')).toEqual(weeks);
    expect(await counts('interval=week&start=2012-12-31')).toEqual([['2012-12-31T00:00:00', 2], ...weeks]);
    for (const [start] of weeks) expect(new Date(`${start}Z`).getUTCDay()).toBe(1);
    expect((await get(`${USD_PATH}?interval=week&start=2012-01-01`)).body).toEqual(
      (await get(`${USD_PATH}?interval=7day&start=2012-01-01`)).body,
    );
  });

  it('months and years are the calendar ones; a window takes the buckets that start in it, whole', async () => {
    expect(await counts('interval=1month')).toEqual([
      ['2013-01-01T00:00:00', 2],
      ['2014-12-01T00:00:00', 2],
      ['2015-01-01T00:00:00', 12],
      ['2015-02-01T00:00:00', 2],
      ['2016-02-01T00:00:00', 2],
      ['2016-03-01T00:00:00', 12],
    ]);
    expect(await counts('interval=1year')).toEqual([
      ['2013-01-01T00:00:00', 2],
      ['2014-01-01T00:00:00', 2],
      ['2015-01-01T00:00:00', 14],
      ['2016-01-01T00:00:00', 14],
    ]);
    // January 2015 starts before the window, though its last exchange is after the start
    expect(await counts('interval=1month&start=2015-01-15')).toEqual([
      ['2015-02-01T00:00:00', 2],
      ['2016-02-01T00:00:00', 2],
      ['2016-03-01T00:00:00', 12],
    ]);
    // January 2015 starts in the window: all of it, the exchanges after the end too
    expect(await counts('interval=1month&end=2015-01-15')).toEqual([
      ['2013-01-01T00:00:00', 2],
      ['2014-12-01T00:00:00', 2],
      ['2015-01-01T00:00:00', 12],
    ]);
    expect(await counts('interval=1year&start=2015-06-01')).toEqual([['2016-01-01T00:00:00', 14]]);
    expect(await counts('interval=1year&end=2015-06-01&descending=true')).toEqual([
      ['2015-01-01T00:00:00', 14],
      ['2014-01-01T00:00:00', 2],
      ['2013-01-01T00:00:00', 2],
    ]);
    expect(await counts('interval=1day&start=2015-01-31&end=2015-02-01')).toEqual([
      ['2015-01-31T00:00:00', 2],
      ['2015-02-01T00:00:00', 2],
    ]);
  });

  it('n minutes and n hours are clock-aligned', async () => {
    expect(await counts('interval=4hour&start=2016-03-01')).toEqual([
      ['2016-03-01T00:00:00', 2],
      ['2016-03-01T04:00:00', 2],
      ['2016-03-01T08:00:00', 8],
    ]);
    expect(await counts('interval=5minute&start=2016-03-01T10:00')).toEqual([
      ['2016-03-01T10:00:00', 2],
      ['2016-03-01T10:05:00', 2],
      ['2016-03-01T10:25:00', 2],
      ['2016-03-01T10:30:00', 2],
    ]);
    expect(await counts('interval=15minute&start=2016-03-01T10:00')).toEqual([
      ['2016-03-01T10:00:00', 4],
      ['2016-03-01T10:15:00', 2],
      ['2016-03-01T10:30:00', 2],
    ]);
    expect(await counts('interval=30minute&start=2016-03-01T10:00')).toEqual([
      ['2016-03-01T10:00:00', 6],
      ['2016-03-01T10:30:00', 2],
    ]);
  });

  it('open and close follow the key of the exchange, not the order it was written in', async () => {
    const [day] = (await api.ok<ListBody>(`${USD_PATH}?interval=1day&start=2015-01-01&end=2015-01-01`, 'exchanges'))
      .body.exchanges;
    // ledger 2: tx 2 (rate 2.4) comes before tx 7 (rate 2.5)
    expect(day).toMatchObject({ count: 2, open: '2.4000000', close: '2.5000000', high: '2.5000000', low: '2.4000000' });
  });

  it('candle pages over the years: the pages make up the list, both ways', async () => {
    const unpaged = await get(`${USD_PATH}?interval=1month`);
    expect(unpaged.body.count).toBe(6);
    for (const limit of [1, 2, 4]) {
      expect((await pages(`${USD_PATH}?interval=1month`, limit)).flatMap((p) => p.exchanges)).toEqual(
        unpaged.body.exchanges,
      );
      expect((await pages(`${USD_PATH}?interval=1month&descending=true`, limit)).flatMap((p) => p.exchanges)).toEqual(
        [...unpaged.body.exchanges].reverse(),
      );
    }
    const first = await get(`${USD_PATH}?interval=1month&limit=2`);
    expect(first.body.marker).toBe(bucketMarker('2014-12-01T00:00:00'));
  });

  it(`native legs of 0.0005 or less are left out when ${NATIVE} is the stored base too`, async () => {
    for (const path of [`/v2/exchanges/${NATIVE}/ZAR+${ISSUER}`, `/v2/exchanges/ZAR+${ISSUER}/${NATIVE}`]) {
      const inverted = path.includes(`ZAR+${ISSUER}/`);
      // the raw list keeps them
      expect([path, (await get(path)).body.count]).toEqual([path, 6]);
      const reduced = await get(`${path}?reduce=true`);
      expect([path, reduced.body.exchanges[0].count]).toEqual([path, 3]);
      expectAggregates(path, reduced.body.exchanges, [
        reducedOf(ZAR_M, inverted, '2013-01-01T00:00:00Z', inKeyOrder(ZAR_ROWS)),
      ]);
      expect(await counts('interval=1year', path)).toEqual([
        ['2015-01-01T00:00:00', 1],
        ['2016-01-01T00:00:00', 2],
      ]);
      const years = await get(`${path}?interval=1year`);
      expectAggregates(path, years.body.exchanges, candlesOf(ZAR_M, '1year', inverted, inKeyOrder(ZAR_ROWS)));
    }
    // 0.0005 itself is left out, 0.0005001 is kept
    const [y2015] = (
      await api.ok<ListBody>(`/v2/exchanges/${NATIVE}/ZAR+${ISSUER}?interval=1year&end=2015`, 'exchanges')
    ).body.exchanges;
    expect(y2015).toMatchObject({ count: 1, base_volume: '0.0005001', counter_volume: '3' });
  });

  it('volumes are exact; a bucket with an amount of 1e36 or more has the float sums of the original instead', async () => {
    const path = `/v2/exchanges/BIG+${ISSUER}/${NATIVE}`;
    const years = await api.ok<ListBody>(`${path}?interval=1year`, 'exchanges');
    expect(years.body.exchanges).toMatchObject([
      // 2e40 + 1e40, 5 + 7: as floats
      { start: '2015-01-01T00:00:00Z', count: 2, base_volume: '3e+40', counter_volume: '12', buy_volume: 2e40 },
      // 0.1 + 0.2 is 0.3 (as floats it would be 0.30000000000000004)
      { start: '2016-01-01T00:00:00Z', count: 2, base_volume: '0.3', counter_volume: '0.6', buy_volume: 0.3 },
    ]);
    const reduced = await api.ok<ListBody>(`${path}?reduce=true`, 'exchanges');
    expect(reduced.body.exchanges[0]).toMatchObject({ count: 4, base_volume: String(2e40 + 1e40 + 0.1 + 0.2) });
    const inverted = await api.ok<ListBody>(
      `/v2/exchanges/${NATIVE}/BIG+${ISSUER}?interval=1year&start=2016`,
      'exchanges',
    );
    expect(inverted.body.exchanges).toMatchObject([{ base_volume: '0.6', counter_volume: '0.3', buy_volume: 0 }]);
  });

  it('amounts a 30-place decimal cannot hold whole are summed as floats, never as 0; the vwap stays finite', async () => {
    const months = await api.ok<ListBody>(`/v2/exchanges/DST+${ISSUER}/${NATIVE}?interval=1month`, 'exchanges');
    const base = 1e-35 + 1.234567890123456e-25;
    expect(months.body.exchanges).toMatchObject([
      // 35 decimal places: the float of the amount (1)
      { start: '2015-01-01T00:00:00Z', count: 1, base_volume: String(Number(LONG)), counter_volume: '3' },
      // a month of amounts that fit is exact: 0.1 + 0.2 is 0.3
      { start: '2016-02-01T00:00:00Z', count: 2, base_volume: '0.3', counter_volume: '0.6', vwap: '2.0000000' },
      // 1e-35 (35 places) and 1.234567890123456e-25 (40): not 0 and 0.000000000000000000000000123456
      { start: '2016-03-01T00:00:00Z', count: 2, base_volume: String(base), counter_volume: '5' },
    ]);
    const dust = months.body.exchanges[2];
    expect(dust.vwap).toBe(p8(new Wide(5).dividedBy(String(base))));
    expect(Number(dust.vwap)).toBeGreaterThan(4e25);
    expect(Number.isFinite(Number(dust.vwap))).toBe(true);
    // the other way round: 1 / 4.05e25
    const inverted = await api.ok<ListBody>(
      `/v2/exchanges/${NATIVE}/DST+${ISSUER}?interval=1month&start=2016-03-01`,
      'exchanges',
    );
    expect(inverted.body.exchanges).toMatchObject([
      { count: 2, base_volume: '5', counter_volume: String(base), vwap: p8(new Wide(String(base)).dividedBy(5)) },
    ]);

    // two issued currencies, dust on both sides
    const counter = 1e-34 + 5e-25;
    for (const [path, inv] of [
      [`/v2/exchanges/AAA+${ISSUER}/ZZZ+${BUYER}`, false],
      [`/v2/exchanges/ZZZ+${BUYER}/AAA+${ISSUER}`, true],
    ] as const) {
      const [reduced] = (await api.ok<ListBody>(`${path}?reduce=true`, 'exchanges')).body.exchanges;
      const [b, c] = inv ? [counter, base] : [base, counter];
      expect([path, reduced.count, reduced.base_volume, reduced.counter_volume]).toEqual([
        path,
        2,
        String(b),
        String(c),
      ]);
      expect([path, reduced.vwap]).toEqual([path, p8(new Wide(String(c)).dividedBy(String(b)))]);
      expect([path, Number.isFinite(Number(reduced.vwap)) && Number(reduced.vwap) > 0]).toEqual([path, true]);
    }
  });

  it('a base volume of 0 (an exchange with a zero side) has a vwap of 0, not Infinity', async () => {
    const forward = await api.ok<ListBody>(`/v2/exchanges/NIL+${ISSUER}/${NATIVE}?reduce=true`, 'exchanges');
    expect(forward.body.exchanges[0]).toMatchObject({
      count: 1,
      open: '1.0000000',
      base_volume: '0',
      counter_volume: '1',
      vwap: '0.0000000',
    });
    const inverted = await api.ok<ListBody>(`/v2/exchanges/${NATIVE}/NIL+${ISSUER}?interval=1year`, 'exchanges');
    expect(inverted.body.exchanges).toMatchObject([
      { count: 1, base_volume: '1', counter_volume: '0', vwap: '0.0000000' },
    ]);
  });
});
