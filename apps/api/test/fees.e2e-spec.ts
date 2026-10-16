import { FeeStatsRow, LedgersRow, RawLedger, Table } from '@gatehub/data-api-shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { csvDisposition } from './support/csv';
import { fixtureSource } from './support/fixtures';
import { expectBoundedInOrderRead } from './support/plans';

/**
 * `GET /v2/network/fees` and `GET /v2/network/fee_stats` on a real ClickHouse, seeded with the 54 mock ledgers of the
 * original Ripple test suite and, for the fee stats, with that suite's `test/mock/fee-stats.json` (20 snapshots, 5 s
 * apart, 2016-08-24T00:15:00Z to 00:16:35Z, which the original loaded straight into HBase and this spec writes straight
 * into `fee_stats`, with the fees from XRP to drops: "0.005" -> 5000, "0.00001" -> 10).
 *
 * Ported from rippled-historical-database `test/test.network.js`, `describe('network fees')` (10 `it`s) and
 * `describe('network fee stats')` (9 `it`s), same titles, none skipped:
 *  - the fees come from the 54 mock ledgers, as in the original (it aggregated them with `test/aggregationTests/fees.test.js`
 *    from the same files): 54 ledgers, 10 hours, 7 days, 38 between 2015-01-14T18:00 and 2015-02-01;
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`ledger|20131025102710|000002964124`, `raw|20160824001505`: the key of the FIRST row of the next page); the marker of
 *    this API is the key of the LAST row of the page, base64url of a JSON array, like every other list of this API:
 *    `[ledger_index]` for the ledgers, `[start of the hour or day, unix seconds]` for the hours and days,
 *    `[ms]` for the raw snapshots, `[start of the minute, hour or day]` for the sampled ones;
 *  - 'should get fee stats at interval': the original looked up the snapshot taken exactly at each boundary (5 s apart,
 *    there is one at every minute); this API takes the first snapshot at or after each boundary within the bucket, which is
 *    the same row where there is one at the boundary (see "fee_stats sampling" below);
 *  - the three 'should error on ...' `it`s of 'network fee stats' request `/v2/network/fees` in the original (a copy and
 *    paste mistake: they test the other route twice); here they request `/v2/network/fee_stats`, which has the same checks,
 *    and the fees route has its own;
 *  - the expected message of 'should error on invalid interval' is `invalid interval`, what both routes of the original
 *    answer (and what both of its tests assert).
 *
 * Added: an independent port of the original's fee parser and aggregation as an oracle for every ledger, hour and day of
 * the mock ledgers and of the Xahau ledgers; the fee types and units; the window rules (start, end, buckets that begin
 * before the start); empty ledgers, ledgers whose transactions paid nothing, and buckets made of them; pages and markers of
 * every interval; CSV; rows written twice (real duplicates: merges stopped, a second insert); the plan of the queries;
 * failures; Xahau.
 */

// -- helpers ----------------------------------------------------------------------------------------------------

const HOUR = 3600;
const DAY = 86400;
const SIZES: Record<string, number> = { hour: HOUR, day: DAY };

/** `YYYY-MM-DDTHH:mm:ssZ` of unix seconds. */
const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (text: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(text) ? text : `${text}Z`) / 1000;
/** The marker of a row: its key as base64url JSON. */
const markerOf = (...key: (string | number)[]): string =>
  Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
/** `?a=1&b=2`, encoded (a `+` in a time zone has to be `%2B`). */
const qs = (params: Record<string, string | number | boolean>): string =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;

interface FeeRow {
  avg: number;
  min: number;
  max: number;
  total: number;
  tx_count: number;
  date: string;
  ledger_index?: number;
}
interface FeeBody {
  result: string;
  count: number;
  marker?: string;
  rows: FeeRow[];
}
interface StatRow {
  current_ledger_size: number;
  current_queue_size: number;
  date: string;
  expected_ledger_size: number;
  median_fee: number;
  minimum_fee: number;
  open_ledger_fee: number;
  pct_max_queue_size: number;
}
/** The keys of a `/fee_stats` row, in the order the original served them: sorted by name, as the HBase row had them. */
const STAT_KEYS = [
  'current_ledger_size',
  'current_queue_size',
  'date',
  'expected_ledger_size',
  'median_fee',
  'minimum_fee',
  'open_ledger_fee',
  'pct_max_queue_size',
];
interface StatBody {
  result: string;
  count: number;
  marker?: string;
  rows: StatRow[];
}

// -- the oracle: lib/ledgerParser/fees.js and lib/aggregation/fees.js of the original, in floating XRP, as written ------

/** `round(value, decimals)` of `lib/aggregation/fees.js`, through the text of the number, as it was. */
const round = (value: number, decimals: number): number =>
  Number(`${Math.round(Number(`${value}e${decimals}`))}e-${decimals}`);

interface Summary {
  total: number;
  ledger_index: number;
  date: string;
  tx_count: number;
  avg: number;
  max: number;
  min: number;
}

/** `lib/ledgerParser/fees.js`. */
function summarizeFees(ledger: RawLedger): Summary {
  const data: Summary = {
    total: 0,
    ledger_index: ledger.header.ledger_index,
    date: iso(ledger.header.close_time),
    tx_count: ledger.transactions.length,
    avg: 0,
    max: 0,
    min: Infinity,
  };
  if (ledger.transactions.length) {
    for (const t of ledger.transactions) {
      const fee = Number(t.tx.Fee);
      data.total += fee;
      data.max = fee > data.max ? fee : data.max;
      data.min = fee < data.min ? fee : data.min;
    }
    data.max /= 1000000;
    data.min /= 1000000;
    data.total /= 1000000;
    data.avg = data.total / data.tx_count;
    data.avg = Number(data.avg.toPrecision(6));
  } else {
    data.min = 0;
  }
  return data;
}

/** What `addFeeSummary` wrote (and the API served) for a summary: `avg` and `total` through `round(x, 6)`. */
const written = (d: Summary, ledgerIndex?: number): FeeRow => ({
  avg: round(d.avg, 6),
  max: d.max,
  min: d.min,
  total: round(d.total, 6),
  tx_count: d.tx_count,
  date: d.date,
  ...(ledgerIndex !== undefined && { ledger_index: ledgerIndex }),
});

/** The rows of `/v2/network/fees?interval=ledger` for some ledgers, oldest first. */
const ledgerRows = (ledgers: RawLedger[]): FeeRow[] =>
  ledgers.map((l) => written(summarizeFees(l), l.header.ledger_index));

/**
 * The hours or days: `merge()` of `lib/aggregation/fees.js`, the ledgers one after the other (the first sets the bucket,
 * the next add their totals and counts, `avg` is worked out again, `min` only moves for a minimum above zero).
 */
function bucketRows(ledgers: RawLedger[], size: number): FeeRow[] {
  const buckets = new Map<number, Summary>();
  for (const ledger of ledgers) {
    const d = summarizeFees(ledger);
    const start = Math.floor(ledger.header.close_time / size) * size;
    const have = buckets.get(start);
    if (!have) {
      buckets.set(start, { ...d, date: iso(start) });
    } else {
      have.total += d.total;
      have.tx_count += d.tx_count;
      have.avg = have.total / have.tx_count;
      if (d.min && d.min < have.min) have.min = d.min;
      if (d.max > have.max) have.max = d.max;
    }
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, d]) => written(d));
}

const MOCK: RawLedger[] = fixtureSource('ripple-mock').list();
const XAHAU: RawLedger[] = fixtureSource('xahau-recorded').list();

// -- the fee stats mock ---------------------------------------------------------------------------------------------

interface MockFeeStat {
  rowkey: string;
  date: string;
  current_ledger_size: string;
  current_queue_size: string;
  expected_ledger_size: string;
  median_fee: string;
  minimum_fee: string;
  open_ledger_fee: string;
  pct_max_queue_size: string;
}
/** `test/mock/fee-stats.json` of the original (ISC licence), unchanged. */
const FEE_STATS_MOCK = JSON.parse(
  readFileSync(join(__dirname, 'support', 'fee-stats-mock.json'), 'utf8'),
) as MockFeeStat[];

/** XRP as the mock writes it to drops. */
const toDrops = (xrp: string): number => Math.round(Number(xrp) * 1_000_000);

/** A mock snapshot as `fee_stats` stores it. */
function mockRow(r: MockFeeStat): FeeStatsRow {
  return {
    ts: unix(r.date),
    current_ledger_size: Number(r.current_ledger_size),
    expected_ledger_size: Number(r.expected_ledger_size),
    current_queue_size: Number(r.current_queue_size),
    max_queue_size: Number(r.expected_ledger_size) * 20,
    pct_max_queue_size: Number(r.pct_max_queue_size),
    median_fee: toDrops(r.median_fee),
    minimum_fee: toDrops(r.minimum_fee),
    open_ledger_fee: toDrops(r.open_ledger_fee),
  };
}
/** The row of the API for a mock snapshot: the numbers of the mock, fees in XRP. */
const mockStat = (r: MockFeeStat): StatRow => ({
  current_ledger_size: Number(r.current_ledger_size),
  current_queue_size: Number(r.current_queue_size),
  date: r.date,
  expected_ledger_size: Number(r.expected_ledger_size),
  median_fee: Number(r.median_fee),
  minimum_fee: Number(r.minimum_fee),
  open_ledger_fee: Number(r.open_ledger_fee),
  pct_max_queue_size: Number(r.pct_max_queue_size),
});
const MOCK_STATS: StatRow[] = FEE_STATS_MOCK.map(mockStat);
const MOCK_ROWS: FeeStatsRow[] = FEE_STATS_MOCK.map(mockRow);

/** A `fee_stats` row at `at` (a time with milliseconds, UTC) whose ledger size is `size`; the rest follows from it. */
function snapshot(at: string, size: number, over: Partial<FeeStatsRow> = {}): FeeStatsRow {
  return {
    ts: Date.parse(`${at}Z`) / 1000,
    current_ledger_size: size,
    expected_ledger_size: 50,
    current_queue_size: size,
    max_queue_size: 1000,
    pct_max_queue_size: Number(((size / 1000) * 100).toFixed(2)),
    median_fee: 5000,
    minimum_fee: 10,
    open_ledger_fee: 10 + size,
    ...over,
  };
}
/** The row of the API for a `snapshot()`. */
const statOf = (row: FeeStatsRow, date: string): StatRow => ({
  current_ledger_size: row.current_ledger_size,
  current_queue_size: row.current_queue_size,
  date,
  expected_ledger_size: row.expected_ledger_size,
  median_fee: Number(row.median_fee) / 1e6,
  minimum_fee: Number(row.minimum_fee) / 1e6,
  open_ledger_fee: Number(row.open_ledger_fee) / 1e6,
  pct_max_queue_size: row.pct_max_queue_size,
});

/** A `ledgers` row for the synthetic ledgers: the fee columns are the point, the rest is a plausible ledger. */
function ledgerRow(
  ledger_index: number,
  closeAt: string,
  tx_count: number,
  fees: { total: number; min: number; max: number },
): LedgersRow {
  const close_time = unix(closeAt);
  return {
    ledger_index,
    ledger_hash: ledger_index.toString(16).toUpperCase().padStart(64, '0'),
    parent_hash: (ledger_index - 1).toString(16).toUpperCase().padStart(64, '0'),
    account_hash: '0'.repeat(64),
    transaction_hash: '0'.repeat(64),
    total_coins: '99999999999000000',
    close_time,
    parent_close_time: close_time - 4,
    close_time_resolution: 10,
    close_flags: 0,
    tx_count,
    type_counts: {},
    result_counts: {},
    payments_count: 0,
    exchanges_count: 0,
    accounts_created: 0,
    fee_total: fees.total,
    fee_min: fees.min,
    fee_max: fees.max,
    parser_version: 1,
  };
}

// ===================================================================================================================
// the original's tests
// ===================================================================================================================

describe('network fees and fee stats (the original test.network.js)', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.insert(Table.FeeStats, MOCK_ROWS);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('network fees', () => {
    it('should get ledger fee summaries', async () => {
      const res = await get('/v2/network/fees');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(54);
      for (const r of (res.body as FeeBody).rows) {
        expect(typeof r.avg).toBe('number');
        expect(typeof r.min).toBe('number');
        expect(typeof r.max).toBe('number');
        expect(typeof r.total).toBe('number');
        expect(typeof r.tx_count).toBe('number');
        expect(typeof r.ledger_index).toBe('number');
        expect(Number.isNaN(Date.parse(r.date))).toBe(false);
      }
    });

    it('should restrict by start and end dates', async () => {
      const start = '2015-01-14T18:00:00';
      const end = '2015-02-01';
      const res = await get(`/v2/network/fees${qs({ start, end })}`);
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(38);
      for (const r of (res.body as FeeBody).rows) {
        const date = Date.parse(r.date);
        expect(typeof r.avg).toBe('number');
        expect(typeof r.min).toBe('number');
        expect(typeof r.max).toBe('number');
        expect(typeof r.total).toBe('number');
        expect(typeof r.tx_count).toBe('number');
        expect(Number.isNaN(date)).toBe(false);
        expect(date - Date.parse(`${start}Z`)).toBeGreaterThanOrEqual(0);
        expect(date - Date.parse(`${end}Z`)).toBeLessThanOrEqual(0);
      }
    });

    it('should get fee summaries in decending order', async () => {
      const res = await get('/v2/network/fees?descending=true');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(54);
      let date: number | undefined;
      for (const r of (res.body as FeeBody).rows) {
        if (date !== undefined) expect(date - Date.parse(r.date)).toBeGreaterThanOrEqual(0);
        date = Date.parse(r.date);
      }
    });

    it('should get hourly fee summaries', async () => {
      const res = await get('/v2/network/fees?interval=hour');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(10);
      for (const r of (res.body as FeeBody).rows) {
        expect(typeof r.avg).toBe('number');
        expect(typeof r.min).toBe('number');
        expect(typeof r.max).toBe('number');
        expect(typeof r.total).toBe('number');
        expect(typeof r.tx_count).toBe('number');
        expect(Number.isNaN(Date.parse(r.date))).toBe(false);
      }
    });

    it('should get daily fee summaries', async () => {
      const res = await get('/v2/network/fees?interval=day');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(7);
      for (const r of (res.body as FeeBody).rows) {
        expect(typeof r.avg).toBe('number');
        expect(typeof r.min).toBe('number');
        expect(typeof r.max).toBe('number');
        expect(typeof r.total).toBe('number');
        expect(typeof r.tx_count).toBe('number');
        expect(Number.isNaN(Date.parse(r.date))).toBe(false);
      }
    });

    it('should handle pagination correctly', async () => {
      const path = '/v2/network/fees?interval=hour';
      const ref = await get(`${path}&limit=1000`);
      const pages = await api.pages<FeeBody>(path, 1, 'rows');
      expect(pages).toHaveLength(ref.body.rows.length);
      pages.forEach((body, i) => {
        expect(body.rows.length).toBe(1);
        expect(body.rows[0]).toEqual(ref.body.rows[i]);
      });
    });

    it('should include a link header when marker is present', async () => {
      const res = await get('/v2/network/fees?limit=1');
      expect(res.status).toBe(200);
      // the original's marker was the key of the second ledger (2964124); this API's is the key of the last row returned
      const marker = markerOf(1021029);
      expect(res.body.marker).toBe(marker);
      const origin = new URL(res.request.url).origin;
      expect(res.headers.link).toBe(`<${origin}/v2/network/fees?limit=1&marker=${marker}>; rel="next"`);
    });

    it('should error on invalid start date', async () => {
      const res = await get(`/v2/network/fees${qs({ start: 'x2015-01-14T00:00', end: '2015-01-14T00:00' })}`);
      expect(res.status).toBe(400);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('invalid start date format');
    });

    it('should error on invalid end date', async () => {
      const res = await get(`/v2/network/fees${qs({ start: '2015-01-14T00:00', end: 'x2015-01-14T00:00' })}`);
      expect(res.status).toBe(400);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('invalid end date format');
    });

    it('should error on invalid interval', async () => {
      const res = await get('/v2/network/fees?interval=zzz');
      expect(res.status).toBe(400);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('invalid interval');
    });
  });

  describe('network fee stats', () => {
    const numbers = (r: StatRow): void => {
      expect(typeof r.current_ledger_size).toBe('number');
      expect(typeof r.current_queue_size).toBe('number');
      expect(typeof r.expected_ledger_size).toBe('number');
      expect(typeof r.median_fee).toBe('number');
      expect(typeof r.minimum_fee).toBe('number');
      expect(typeof r.open_ledger_fee).toBe('number');
      expect(typeof r.pct_max_queue_size).toBe('number');
      expect(Number.isNaN(Date.parse(r.date))).toBe(false);
    };

    it('should get fee stats', async () => {
      const res = await get('/v2/network/fee_stats');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(20);
      (res.body as StatBody).rows.forEach(numbers);
      expect(res.body.rows).toEqual(MOCK_STATS);
    });

    it('should restrict by start and end dates', async () => {
      const start = '2016-08-24T00:15:15Z';
      const end = '2016-08-24T00:15:55Z';
      const res = await get(`/v2/network/fee_stats${qs({ start, end })}`);
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(9);
      for (const r of (res.body as StatBody).rows) {
        const date = Date.parse(r.date);
        expect(Number.isNaN(date)).toBe(false);
        expect(date - Date.parse(start)).toBeGreaterThanOrEqual(0);
        expect(date - Date.parse(end)).toBeLessThanOrEqual(0);
      }
    });

    it('should get fee stats in decending order', async () => {
      const res = await get('/v2/network/fee_stats?descending=true');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(20);
      let date: number | undefined;
      for (const r of (res.body as StatBody).rows) {
        if (date !== undefined) expect(date - Date.parse(r.date)).toBeGreaterThanOrEqual(0);
        date = Date.parse(r.date);
      }
    });

    it('should get fee stats at interval', async () => {
      const res = await get('/v2/network/fee_stats?interval=minute&start=2016-08-24T00:15:00Z');
      expect(res.status).toBe(200);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('success');
      expect(res.body.count).toBe(2);
      (res.body as StatBody).rows.forEach(numbers);
      // the snapshots taken at 00:15:00 and 00:16:00
      expect(res.body.rows).toEqual([MOCK_STATS[0], MOCK_STATS[12]]);
    });

    it('should handle pagination correctly', async () => {
      const path = '/v2/network/fee_stats?';
      const ref = await get(`${path}&limit=1000`);
      const pages = await api.pages<StatBody>(path, 1, 'rows');
      expect(pages).toHaveLength(ref.body.rows.length);
      pages.forEach((body, i) => {
        expect(body.rows.length).toBe(1);
        expect(body.rows[0]).toEqual(ref.body.rows[i]);
      });
    });

    it('should include a link header when marker is present', async () => {
      const res = await get('/v2/network/fee_stats?limit=1');
      expect(res.status).toBe(200);
      // the marker of the raw snapshots is the key of the last row returned: its time in unix milliseconds
      const marker = markerOf(unix('2016-08-24T00:15:00Z') * 1000);
      expect(res.body.marker).toBe(marker);
      const origin = new URL(res.request.url).origin;
      expect(res.headers.link).toBe(`<${origin}/v2/network/fee_stats?limit=1&marker=${marker}>; rel="next"`);
    });

    it('should error on invalid start date', async () => {
      const res = await get(`/v2/network/fee_stats${qs({ start: 'x2015-01-14T00:00', end: '2015-01-14T00:00' })}`);
      expect(res.status).toBe(400);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('invalid start date format');
    });

    it('should error on invalid end date', async () => {
      const res = await get(`/v2/network/fee_stats${qs({ start: '2015-01-14T00:00', end: 'x2015-01-14T00:00' })}`);
      expect(res.status).toBe(400);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('invalid end date format');
    });

    it('should error on invalid interval', async () => {
      const res = await get('/v2/network/fee_stats?interval=zzz');
      expect(res.status).toBe(400);
      expect(typeof res.body).toBe('object');
      expect(res.body.result).toBe('error');
      expect(res.body.message).toBe('invalid interval');
    });
  });
});

// ===================================================================================================================
// /v2/network/fees
// ===================================================================================================================

describe('GET /v2/network/fees', () => {
  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<FeeBody[]> => api.pages<FeeBody>(path, limit, 'rows');

  const ORACLE: Record<string, FeeRow[]> = {
    ledger: ledgerRows(MOCK),
    hour: bucketRows(MOCK, HOUR),
    day: bucketRows(MOCK, DAY),
  };

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the rows', () => {
    it('every ledger, hour and day of the mock ledgers is what the original parser and aggregation made of them', async () => {
      for (const interval of ['ledger', 'hour', 'day']) {
        const res = await get(`/v2/network/fees?interval=${interval}&limit=1000`);
        expect([interval, res.body.rows]).toEqual([interval, ORACLE[interval]]);
        expect(res.body.rows.length).toBe(interval === 'ledger' ? 54 : interval === 'hour' ? 10 : 7);
      }
    });

    it('a ledger row is {avg, max, min, total, tx_count, date, ledger_index} in that order, fees in XRP as JSON numbers', async () => {
      const res = await get('/v2/network/fees?limit=3');
      expect(res.body).toEqual({
        result: 'success',
        count: 3,
        marker: markerOf(11118827),
        rows: [
          // 12 transactions that paid 10 drops each
          {
            avg: 0.00001,
            max: 0.00001,
            min: 0.00001,
            total: 0.00012,
            tx_count: 12,
            date: '2013-06-11T20:01:20Z',
            ledger_index: 1021029,
          },
          // 775 drops over 5 transactions
          {
            avg: 0.000155,
            max: 0.00025,
            min: 0.00001,
            total: 0.000775,
            tx_count: 5,
            date: '2013-10-25T10:27:10Z',
            ledger_index: 2964124,
          },
          // 138000 drops over 13 transactions: 0.0106153846 to six digits is 0.0106154, and to a drop 0.010615
          {
            avg: 0.010615,
            max: 0.011,
            min: 0.01,
            total: 0.138,
            tx_count: 13,
            date: '2015-01-14T17:29:10Z',
            ledger_index: 11118827,
          },
        ],
      });
      expect(Object.keys(res.body.rows[0])).toEqual(['avg', 'max', 'min', 'total', 'tx_count', 'date', 'ledger_index']);
    });

    it('R71: the keys of a row, in JSON and in the CSV header, are in the order HBase served the columns: sorted by name, the numbers before date and ledger_index', async () => {
      const ledger = ['avg', 'max', 'min', 'total', 'tx_count', 'date', 'ledger_index'];
      const bucket = ['avg', 'max', 'min', 'total', 'tx_count', 'date'];
      for (const [interval, keys] of [
        ['ledger', ledger],
        ['hour', bucket],
        ['day', bucket],
      ] as const) {
        const json = await get(`/v2/network/fees?interval=${interval}&limit=1000`);
        for (const row of json.body.rows as FeeRow[]) expect([interval, Object.keys(row)]).toEqual([interval, keys]);
        const csv = await get(`/v2/network/fees?interval=${interval}&format=csv&limit=2`);
        expect([interval, csv.text.split('\n')[0]]).toEqual([interval, keys.map((k) => `"${k}"`).join(',')]);
      }
    });

    it('an hour or a day has no ledger_index, and its date is the start of the bucket', async () => {
      for (const interval of ['hour', 'day']) {
        const res = await get(`/v2/network/fees?interval=${interval}&limit=1000`);
        for (const r of res.body.rows as FeeRow[]) {
          expect(r).not.toHaveProperty('ledger_index');
          expect(Object.keys(r)).toEqual(['avg', 'max', 'min', 'total', 'tx_count', 'date']);
          expect(unix(r.date) % SIZES[interval]).toBe(0);
        }
      }
    });

    it('an hour adds up its ledgers: 35 ledgers closed between 18:00 and 19:00 on 2015-01-14', async () => {
      const res = await get('/v2/network/fees?interval=hour&start=2015-01-14T18:00:00&end=2015-01-14T18:00:00');
      const inHour = MOCK.filter(
        (l) => l.header.close_time >= unix('2015-01-14T18:00:00') && l.header.close_time < unix('2015-01-14T19:00:00'),
      );
      expect(inHour).toHaveLength(35);
      const drops = inHour.flatMap((l) => l.transactions.map((t) => Number(t.tx.Fee)));
      const [row] = res.body.rows as FeeRow[];
      expect(res.body.count).toBe(1);
      expect(row.date).toBe('2015-01-14T18:00:00Z');
      expect(row.tx_count).toBe(drops.length);
      expect(row.total).toBe(drops.reduce((a, b) => a + b, 0) / 1e6);
      expect(row.min).toBe(Math.min(...drops) / 1e6);
      expect(row.max).toBe(Math.max(...drops) / 1e6);
      expect(row.avg).toBe(Math.round(drops.reduce((a, b) => a + b, 0) / drops.length) / 1e6);
    });

    it('a day adds up its hours: the sums of the day are the sums of the hours', async () => {
      const hours = (await get('/v2/network/fees?interval=hour&limit=1000')).body.rows as FeeRow[];
      const days = (await get('/v2/network/fees?interval=day&limit=1000')).body.rows as FeeRow[];
      for (const day of days) {
        const mine = hours.filter((r) => r.date.slice(0, 10) === day.date.slice(0, 10));
        expect(mine.reduce((a, r) => a + r.tx_count, 0)).toBe(day.tx_count);
        expect(Math.round(mine.reduce((a, r) => a + r.total, 0) * 1e6)).toBe(Math.round(day.total * 1e6));
        expect(Math.min(...mine.map((r) => r.min))).toBe(day.min);
        expect(Math.max(...mine.map((r) => r.max))).toBe(day.max);
      }
    });

    it('interval defaults to ledger; an empty interval is the default; it is case sensitive; the first of a repeated one wins', async () => {
      const ledger = await get('/v2/network/fees?limit=5');
      expect((await get('/v2/network/fees?interval=ledger&limit=5')).body).toEqual(ledger.body);
      expect((await get('/v2/network/fees?interval=&limit=5')).body).toEqual(ledger.body);
      const hour = await get('/v2/network/fees?interval=hour&limit=5');
      expect((await get('/v2/network/fees?interval=hour&interval=day&limit=5')).body).toEqual(hour.body);
      for (const bad of ['Hour', 'DAY', 'minute', 'week', ' hour', 'hour ', 'raw']) {
        const res = await get(`/v2/network/fees${qs({ interval: bad })}`);
        expect([bad, res.status, res.body]).toEqual([bad, 400, { result: 'error', message: 'invalid interval' }]);
      }
    });
  });

  describe('the window', () => {
    it('start and end bound the close time of a ledger; a date with less than a second is the whole period', async () => {
      const cases: [Record<string, string>, string, string][] = [
        [{ start: '2015-01-14', end: '2015-01-14' }, '2015-01-14T00:00:00', '2015-01-15T00:00:00'],
        [{ start: '2015-01-14T18:28', end: '2015-01-14T18:28' }, '2015-01-14T18:28:00', '2015-01-14T18:29:00'],
        [{ start: '2015-01-14T18:28:10', end: '2015-01-14T18:28:10' }, '2015-01-14T18:28:10', '2015-01-14T18:28:11'],
        [{ start: '2015-02', end: '2015-02' }, '2015-02-01T00:00:00', '2015-03-01T00:00:00'],
        [{ start: '2013', end: '2013' }, '2013-01-01T00:00:00', '2014-01-01T00:00:00'],
        [
          { start: '2013-10-25T10:27:10Z', end: '2013-10-25T10:27:10.000Z' },
          '2013-10-25T10:27:10',
          '2013-10-25T10:27:10.001',
        ],
      ];
      for (const [params, from, before] of cases) {
        const res = await get(`/v2/network/fees${qs({ ...params, limit: 1000 })}`);
        const expected = ORACLE.ledger.filter((r) => unix(r.date) >= unix(from) && unix(r.date) < unix(before));
        expect([params, res.body.rows]).toEqual([params, expected]);
      }
    });

    it('start defaults to 2013-01-01, and end to the newest ledger', async () => {
      expect((await get('/v2/network/fees?limit=1000')).body.count).toBe(54);
      expect((await get('/v2/network/fees?start=2013-01-01&limit=1000')).body.count).toBe(54);
      expect((await get('/v2/network/fees?start=&limit=1000')).body.count).toBe(54);
      expect((await get('/v2/network/fees?start=2017-05-12T14:48:52&limit=1000')).body.count).toBe(1);
    });

    it('an hour or a day is served when it STARTS inside the window: the one that began before start is not', async () => {
      // 18:00 began before 18:30; 19:00 starts inside
      const res = await get('/v2/network/fees?interval=hour&start=2015-01-14T18:30:00&end=2015-01-14T19:00:00');
      expect(res.body.rows.map((r: FeeRow) => r.date)).toEqual(['2015-01-14T19:00:00Z']);
      // start exactly on the boundary: that bucket is in
      const on = await get('/v2/network/fees?interval=hour&start=2015-01-14T18:00:00&end=2015-01-14T18:59:59');
      expect(on.body.rows.map((r: FeeRow) => r.date)).toEqual(['2015-01-14T18:00:00Z']);
      // a day whose midnight is before start
      const days = await get('/v2/network/fees?interval=day&start=2015-01-14T00:00:01&limit=1000');
      expect(days.body.rows.map((r: FeeRow) => r.date)).toEqual(ORACLE.day.slice(3).map((r) => r.date));
    });

    it('a bucket that starts inside the window is served whole, also its ledgers after end', async () => {
      // end is the first second of the hour: the bucket starting at 18:00 is in, with all 35 of its ledgers
      const res = await get('/v2/network/fees?interval=hour&start=2015-01-14T18:00:00&end=2015-01-14T18:00:00');
      expect(res.body.rows).toEqual([ORACLE.hour[3]]);
      expect(res.body.rows[0].tx_count).toBe(ORACLE.hour[3].tx_count);
    });

    it('end as an hour or a day covers that hour or day, so a bucket in it is in; a bucket starting at the excluded end is not', async () => {
      // end=2015-01-14T18 is the hour 18:00-19:00: buckets starting before 19:00
      const hour = await get('/v2/network/fees?interval=hour&start=2015-01-14&end=2015-01-14T18');
      expect(hour.body.rows.map((r: FeeRow) => r.date)).toEqual(['2015-01-14T17:00:00Z', '2015-01-14T18:00:00Z']);
      // end=2015-01-14 is the day: the hours of 2015-01-14 up to 19:00 exist in the mock
      const day = await get('/v2/network/fees?interval=day&end=2015-01-14');
      expect(day.body.rows.map((r: FeeRow) => r.date)).toEqual([
        '2013-06-11T00:00:00Z',
        '2013-10-25T00:00:00Z',
        '2015-01-14T00:00:00Z',
      ]);
      const none = await get('/v2/network/fees?interval=day&end=2015-01-13T23:59:59');
      expect(none.body.rows.map((r: FeeRow) => r.date)).toEqual(['2013-06-11T00:00:00Z', '2013-10-25T00:00:00Z']);
    });

    it('a start before 1970 and an end after 2106 are the whole history, for every interval', async () => {
      for (const interval of ['ledger', 'hour', 'day']) {
        const res = await get(`/v2/network/fees?interval=${interval}&start=0001-01-01&end=9999-12-31&limit=1000`);
        expect([interval, res.status, res.body.rows]).toEqual([interval, 200, ORACLE[interval]]);
        const desc = await get(`/v2/network/fees?interval=${interval}&start=0001&end=9999&descending=true&limit=1000`);
        expect([interval, desc.body.rows]).toEqual([interval, [...ORACLE[interval]].reverse()]);
      }
    });

    it('empty range → count 0, for every interval', async () => {
      for (const interval of ['ledger', 'hour', 'day']) {
        const res = await get(`/v2/network/fees?interval=${interval}&start=2030-01-01&end=2030-12-31`);
        expect([interval, res.status, res.body]).toEqual([interval, 200, { result: 'success', count: 0, rows: [] }]);
        expect(res.headers.link).toBeUndefined();
        const before = await get(`/v2/network/fees?interval=${interval}&end=2013-01-01`);
        expect([interval, before.body.count]).toEqual([interval, 0]);
        const reversed = await get(`/v2/network/fees?interval=${interval}&start=2015-01-01&end=2014-01-01`);
        expect([interval, reversed.body.count]).toEqual([interval, 0]);
      }
    });

    it('the checks come in the order of the original: start, end, interval, then the marker', async () => {
      const both = await get('/v2/network/fees?start=x&end=y&interval=zzz&marker=!!');
      expect(both.body.message).toBe('invalid start date format');
      const end = await get('/v2/network/fees?end=y&interval=zzz&marker=!!');
      expect(end.body.message).toBe('invalid end date format');
      const interval = await get('/v2/network/fees?interval=zzz&marker=!!');
      expect(interval.body.message).toBe('invalid interval');
      const marker = await get('/v2/network/fees?marker=!!');
      expect(marker.body).toEqual({ result: 'error', message: 'invalid marker' });
      expect((await get('/v2/network/fees?end=')).body.message).toBe('invalid end date format');
    });
  });

  describe('the list', () => {
    it('marker pages concatenate to unpaged list', async () => {
      for (const interval of ['ledger', 'hour', 'day']) {
        const unpaged = await get(`/v2/network/fees?interval=${interval}&limit=1000`);
        expect(unpaged.body.marker).toBeUndefined();
        expect(unpaged.headers.link).toBeUndefined();
        for (const limit of [1, 2, 3, 5, 7]) {
          const paged = await pages(`/v2/network/fees?interval=${interval}`, limit);
          expect(paged.slice(0, -1).every((p) => p.count === limit && p.marker !== undefined)).toBe(true);
          expect(paged[paged.length - 1].marker).toBeUndefined();
          expect([interval, limit, paged.flatMap((p) => p.rows)]).toEqual([interval, limit, ORACLE[interval]]);
        }
      }
    });

    it('marker pages concatenate inside a window too', async () => {
      const window = '/v2/network/fees?interval=hour&start=2013-12-01&end=2016-12-31';
      const unpaged = await get(`${window}&limit=1000`);
      expect(unpaged.body.count).toBe(6);
      expect((await pages(window, 4)).flatMap((p) => p.rows)).toEqual(unpaged.body.rows);
    });

    it('descending reverses order', async () => {
      for (const interval of ['ledger', 'hour', 'day']) {
        const asc = await get(`/v2/network/fees?interval=${interval}&limit=1000`);
        const desc = await get(`/v2/network/fees?interval=${interval}&limit=1000&descending=true`);
        expect([interval, desc.body.rows]).toEqual([interval, [...asc.body.rows].reverse()]);
        for (const limit of [1, 4]) {
          const paged = await pages(`/v2/network/fees?interval=${interval}&descending=true`, limit);
          expect([interval, limit, paged.flatMap((p) => p.rows)]).toEqual([interval, limit, desc.body.rows]);
        }
      }
    });

    it('descending is only /true/i', async () => {
      const asc = await get('/v2/network/fees?limit=5');
      for (const flag of ['false', '1', '0', '']) {
        expect((await get(`/v2/network/fees?limit=5&descending=${flag}`)).body).toEqual(asc.body);
      }
      const desc = await get('/v2/network/fees?limit=5&descending=true');
      expect((await get('/v2/network/fees?limit=5&descending=TRUE')).body).toEqual(desc.body);
      expect(desc.body.rows.map((r: FeeRow) => r.ledger_index)).toEqual(
        ORACLE.ledger
          .slice(-5)
          .reverse()
          .map((r) => r.ledger_index),
      );
    });

    it('unknown params ignored', async () => {
      const plain = await get('/v2/network/fees?interval=hour&limit=5');
      const res = await get('/v2/network/fees?interval=hour&limit=5&foo=bar&reduce=true&exchange_currency=USD');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get('/v2/network/fees?limit=3&limit=50&descending=true&descending=false&start=2015&start=2013');
      expect(res.body.count).toBe(3);
      expect(res.body.rows.map((r: FeeRow) => r.ledger_index)).toEqual([29709909, 29136413, 20005122]);
    });

    it('limit is 200 by default and at most 1000; below one or not a number it is the default; a fraction is cut', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const fetched = async (limit: string): Promise<unknown> => {
        spy.mockClear();
        await get(`/v2/network/fees?interval=ledger${limit}`);
        const call = spy.mock.calls.find(
          ([q]) => /FROM ledgers\b/.test(String(q)) && /distinct_page_limit/.test(String(q)),
        );
        return (call?.[1] as { distinct_page_limit?: number } | undefined)?.distinct_page_limit;
      };
      expect(await fetched('')).toBe(201);
      expect(await fetched('&limit=abc')).toBe(201);
      expect(await fetched('&limit=0')).toBe(201);
      expect(await fetched('&limit=-5')).toBe(201);
      expect(await fetched('&limit=5000')).toBe(1001);
      expect(await fetched('&limit=1000')).toBe(1001);
      expect(await fetched('&limit=7.9')).toBe(8);
      expect((await get('/v2/network/fees?limit=2')).body.count).toBe(2);
    });

    it('the last page has no marker and no Link header; a page that is not the last has both', async () => {
      for (const interval of ['ledger', 'hour', 'day']) {
        const all = ORACLE[interval];
        const exact = await get(`/v2/network/fees?interval=${interval}&limit=${all.length}`);
        expect([interval, exact.body.count, exact.body.marker, exact.headers.link]).toEqual([
          interval,
          all.length,
          undefined,
          undefined,
        ]);
        const more = await get(`/v2/network/fees?interval=${interval}&limit=${all.length - 1}`);
        const last = all[all.length - 2];
        expect(more.body.marker).toBe(
          interval === 'ledger' ? markerOf(last.ledger_index as number) : markerOf(unix(last.date)),
        );
        const origin = new URL(more.request.url).origin;
        expect(more.headers.link).toBe(
          `<${origin}/v2/network/fees?interval=${interval}&limit=${all.length - 1}&marker=${more.body.marker}>; rel="next"`,
        );
        const rest = await get(`/v2/network/fees?interval=${interval}&limit=${all.length}&marker=${more.body.marker}`);
        expect(rest.body.rows).toEqual(all.slice(-1));
      }
    });

    it('a marker continues strictly after (before, descending) its row', async () => {
      for (const i of [0, 20, 52]) {
        const asc = await get(
          `/v2/network/fees?limit=1000&marker=${markerOf(ORACLE.ledger[i].ledger_index as number)}`,
        );
        expect([i, asc.body.rows]).toEqual([i, ORACLE.ledger.slice(i + 1)]);
        const desc = await get(
          `/v2/network/fees?limit=1000&descending=true&marker=${markerOf(ORACLE.ledger[i].ledger_index as number)}`,
        );
        expect([i, desc.body.rows]).toEqual([i, ORACLE.ledger.slice(0, i).reverse()]);
      }
      for (const i of [0, 3, 8]) {
        const marker = markerOf(unix(ORACLE.hour[i].date));
        expect((await get(`/v2/network/fees?interval=hour&limit=1000&marker=${marker}`)).body.rows).toEqual(
          ORACLE.hour.slice(i + 1),
        );
        expect(
          (await get(`/v2/network/fees?interval=hour&limit=1000&descending=true&marker=${marker}`)).body.rows,
        ).toEqual(ORACLE.hour.slice(0, i).reverse());
      }
    });

    it('a marker that is none of the list is 400 invalid marker, also when the range is empty', async () => {
      const bad = [
        'x',
        '!!',
        markerOf(),
        markerOf(1, 2),
        markerOf('a'),
        markerOf(-1),
        markerOf(1.5),
        Buffer.from('not json').toString('base64url'),
      ];
      for (const marker of bad) {
        for (const interval of ['ledger', 'hour']) {
          const res = await get(`/v2/network/fees?interval=${interval}&marker=${marker}`);
          expect([interval, marker, res.status, res.body]).toEqual([
            interval,
            marker,
            400,
            { result: 'error', message: 'invalid marker' },
          ]);
        }
      }
      const empty = await get(`/v2/network/fees?start=2030-01-01&marker=${markerOf(1, 2)}`);
      expect(empty.status).toBe(400);
    });

    it('a marker of the hours is the start of the last hour, and carries over to the days', async () => {
      const hours = await get('/v2/network/fees?interval=hour&limit=2');
      expect(hours.body.marker).toBe(markerOf(unix('2013-10-25T10:00:00')));
      // an hour boundary that is no day boundary: the days after it are the days that start after it
      const days = await get(`/v2/network/fees?interval=day&limit=1000&marker=${hours.body.marker}`);
      expect(days.body.rows).toEqual(ORACLE.day.slice(2));
    });

    it('is 500 unable to retrieve fee summary(s) when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      for (const interval of ['ledger', 'hour']) {
        const res = await get(`/v2/network/fees?interval=${interval}`);
        expect([interval, res.status, res.body]).toEqual([
          interval,
          500,
          { result: 'error', message: 'unable to retrieve fee summary(s)' },
        ]);
      }
    });
  });

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('format=csv → text/csv, network fees.csv, one row per ledger', async () => {
      const res = await get('/v2/network/fees?format=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('network fees'));
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 54);
      expect(rows[0].split(',')).toEqual([
        '"avg"',
        '"max"',
        '"min"',
        '"total"',
        '"tx_count"',
        '"date"',
        '"ledger_index"',
      ]);
      expect(rows[1]).toBe('"0.00001","0.00001","0.00001","0.00012","12","2013-06-11T20:01:20Z","1021029"');
    });

    it('an hour has no ledger_index column', async () => {
      const res = await get('/v2/network/fees?format=csv&interval=hour');
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 10);
      expect(rows[0].split(',')).toEqual(['"avg"', '"max"', '"min"', '"total"', '"tx_count"', '"date"']);
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get('/v2/network/fees?format=CSV&limit=1')).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`/v2/network/fees?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page, and the same rows as the JSON', async () => {
      const csv = await get('/v2/network/fees?format=csv&limit=3');
      const json = await get('/v2/network/fees?limit=3');
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/network/fees?format=csv&limit=3&marker=${json.body.marker}>; rel="next"`,
      );
      expect(lines(csv.text)).toHaveLength(1 + 3);
      expect((await get('/v2/network/fees?format=csv&limit=1000')).headers.link).toBeUndefined();
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get('/v2/network/fees?format=csv&start=2030-01-01');
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get('/v2/network/fees?format=csv&interval=zzz');
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'invalid interval' });
    });
  });

  describe('the query', () => {
    const ledgersSql = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(
          ([q]) =>
            new RegExp(`FROM ${Table.Ledgers}\\b`).test(String(q)) && /fetch|distinct_page_limit/.test(String(q)),
        )
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);
    const planOf = async (sql: string, params: Record<string, unknown>, kind = 'PIPELINE'): Promise<string> =>
      (await h.ch.query<{ explain: string }>(`EXPLAIN ${kind} ${sql}`, params)).map((r) => r.explain).join('\n');

    it('pages a ledger by ledger_index range with the key in the ORDER BY and the cursor, and dedupes by it', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get(`/v2/network/fees?limit=4&marker=${markerOf(11118861)}`);
      expect(res.body.count).toBe(4);
      const [[sql, params]] = ledgersSql(spy);
      expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
      expect(sql).toMatch(/\(ledger_index\) > \(\{k0:UInt32\}\)/);
      // read in the order of the key with a plain LIMIT, which stops the read after the page (Ruling R106) ...
      expect(sql).toMatch(/ORDER BY ledger_index ASC\s+LIMIT \{distinct_page_cap:UInt32\}/);
      // ... and a ledger that was written twice counts once, outside it
      expect(sql).toMatch(/LIMIT 1 BY ledger_index\s+LIMIT \{distinct_page_limit:UInt32\}/);
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(params).toMatchObject({ min: 1021029, max: 29709909, k0: 11118861, distinct_page_limit: 5 });
      expect(Object.keys(params).sort()).toEqual(['distinct_page_cap', 'distinct_page_limit', 'k0', 'max', 'min']);
    });

    it('reads the ledgers in the order of their primary key, so that a page never sorts the whole range', async () => {
      for (const descending of [false, true]) {
        for (const variant of [
          'limit=5',
          `limit=5&marker=${markerOf(11119600)}`,
          'limit=5&start=2013-06-11&end=2015-12-31',
        ]) {
          const spy = jest.spyOn(h.ch, 'query');
          await get(`/v2/network/fees?${variant}&descending=${descending}`);
          const [[sql, params]] = ledgersSql(spy);
          jest.restoreAllMocks();
          // in the order of the key, no sort, and a LIMIT on the read itself: it stops after the page
          await expectBoundedInOrderRead(h, sql, params, descending, [descending, variant]);
        }
      }
    });

    it('groups an hour or a day from the ledgers of the page only: ledger_index range, close_time window, no FINAL', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get('/v2/network/fees?interval=hour&limit=3');
      const calls = ledgersSql(spy);
      expect(calls.length).toBeGreaterThan(0);
      for (const [sql, params] of calls) {
        expect(sql).toMatch(/ledger_index BETWEEN \{min:UInt32\} AND \{max:UInt32\}/);
        expect(sql).toMatch(/close_time >= toDateTime\(\{lo:UInt32\}, 'UTC'\)/);
        expect(sql).toMatch(/close_time < toDateTime\(\{hi:UInt32\}, 'UTC'\)/);
        // the ledgers are deduped before they are added up
        expect(sql).toMatch(/LIMIT 1 BY ledger_index/);
        expect(sql).toMatch(/GROUP BY bucket\s+ORDER BY bucket ASC\s+LIMIT \{fetch:UInt32\}/);
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(params).toMatchObject({ size: 3600 });
        expect(Number(params.hi) - Number(params.lo)).toBeGreaterThan(0);
      }
      // the windows start at the first hour with a ledger, not at the start of the range: 3 hours of 4 years of
      // history need a handful of queries, not one per hour
      expect(calls.length).toBeLessThan(16);
    });

    it('uses the primary key on ledger_index and the minmax index on close_time for an hour', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get('/v2/network/fees?interval=day&limit=2');
      const [[sql, params]] = ledgersSql(spy);
      jest.restoreAllMocks();
      const indexes = await planOf(sql, params, 'indexes = 1');
      expect(indexes).toContain('PrimaryKey');
      expect(indexes).toMatch(/Keys:\s*\n\s*ledger_index/);
      expect(indexes).toContain('close_time_mm');
    });
  });
});

// ===================================================================================================================
// ledgers with nothing to add up
// ===================================================================================================================

describe('GET /v2/network/fees on ledgers without fees', () => {
  // The mock ledgers have no empty ledger and no transaction that paid nothing. An empty ledger has min 0, and so has a
  // ledger of pseudo transactions (Fee 0): a bucket's min is the smallest of the minimums above zero (the original kept
  // a bucket's min at 0 when the first ledger it saw was empty, and divided 0 by 0 in avg).
  let h: Harness;
  let get: ApiClient['get'];
  const SYNTHETIC = [
    ledgerRow(40000001, '2018-03-05T10:00:10', 0, { total: 0, min: 0, max: 0 }), // empty, first of its hour
    ledgerRow(40000002, '2018-03-05T10:20:00', 4, { total: 80, min: 10, max: 30 }),
    ledgerRow(40000003, '2018-03-05T11:00:00', 0, { total: 0, min: 0, max: 0 }), // empty, on the boundary
    ledgerRow(40000004, '2018-03-05T11:30:00', 2, { total: 0, min: 0, max: 0 }), // two pseudo transactions, Fee 0
    ledgerRow(40000005, '2018-03-06T00:00:00', 1, { total: 12, min: 12, max: 12 }), // on a day boundary
    // 100 transactions that paid 10500.46 drops each on average: to six digits that is 10500.5, to a drop 10501
    ledgerRow(40000006, '2019-05-05T05:05:05', 100, { total: 1_050_046, min: 10_000, max: 11_000 }), // alone in its hour
    ledgerRow(40000007, '2019-05-05T07:01:00', 100, { total: 1_050_046, min: 10_000, max: 11_000 }), // two in theirs
    ledgerRow(40000008, '2019-05-05T07:02:00', 100, { total: 1_050_046, min: 10_000, max: 11_000 }),
  ];

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
    await h.ch.insert(Table.Ledgers, SYNTHETIC);
  });
  afterAll(async () => {
    await h?.close();
  });

  const window = (interval: string, start: string, end: string): string =>
    `/v2/network/fees?interval=${interval}&start=${start}&end=${end}&limit=1000`;

  it('an empty ledger: min 0, max 0, total 0, avg 0, tx_count 0 (numbers, not NaN or null)', async () => {
    const res = await get(window('ledger', '2018-03-05', '2018-03-05'));
    expect(res.body.rows).toEqual([
      { avg: 0, max: 0, min: 0, total: 0, tx_count: 0, date: '2018-03-05T10:00:10Z', ledger_index: 40000001 },
      {
        avg: 0.00002,
        max: 0.00003,
        min: 0.00001,
        total: 0.00008,
        tx_count: 4,
        date: '2018-03-05T10:20:00Z',
        ledger_index: 40000002,
      },
      { avg: 0, max: 0, min: 0, total: 0, tx_count: 0, date: '2018-03-05T11:00:00Z', ledger_index: 40000003 },
      { avg: 0, max: 0, min: 0, total: 0, tx_count: 2, date: '2018-03-05T11:30:00Z', ledger_index: 40000004 },
    ]);
  });

  it('an hour whose first ledger is empty still has the minimum of the others', async () => {
    const res = await get(window('hour', '2018-03-05', '2018-03-05'));
    expect(res.body.rows).toEqual([
      // 4 transactions over 80 drops; the empty ledger neither holds min at 0 nor counts
      { avg: 0.00002, max: 0.00003, min: 0.00001, total: 0.00008, tx_count: 4, date: '2018-03-05T10:00:00Z' },
      // an empty ledger and a ledger of free transactions: nothing paid
      { avg: 0, max: 0, min: 0, total: 0, tx_count: 2, date: '2018-03-05T11:00:00Z' },
    ]);
  });

  it('a day takes the minimum above zero of its ledgers and averages over all its transactions', async () => {
    const res = await get(window('day', '2018-03-05', '2018-03-06'));
    expect(res.body.rows).toEqual([
      // 80 drops over 6 transactions: 13.33 drops, 13 to a drop
      { avg: 0.000013, max: 0.00003, min: 0.00001, total: 0.00008, tx_count: 6, date: '2018-03-05T00:00:00Z' },
      // one ledger with one 12 drop transaction: its own row, avg 0.000012
      { avg: 0.000012, max: 0.000012, min: 0.000012, total: 0.000012, tx_count: 1, date: '2018-03-06T00:00:00Z' },
    ]);
  });

  it('a bucket of one ledger has the avg of that ledger, a bucket of two is worked out from its totals', async () => {
    const ledgers = await get(window('ledger', '2019-05-05', '2019-05-05'));
    expect(ledgers.body.rows.map((r: FeeRow) => r.avg)).toEqual([0.010501, 0.010501, 0.010501]);
    const hours = await get(window('hour', '2019-05-05', '2019-05-05'));
    expect(hours.body.rows).toEqual([
      // the original set a bucket from the first ledger it saw and worked avg out again only from the second
      { avg: 0.010501, max: 0.011, min: 0.01, total: 1.050046, tx_count: 100, date: '2019-05-05T05:00:00Z' },
      // 2100092 drops over 200 transactions: 10500.46 drops
      { avg: 0.0105, max: 0.011, min: 0.01, total: 2.100092, tx_count: 200, date: '2019-05-05T07:00:00Z' },
    ]);
  });

  it('paging across the empty buckets loses nothing', async () => {
    const path = '/v2/network/fees?interval=hour&start=2018-03-05&end=2018-03-06';
    const unpaged = await get(`${path}&limit=1000`);
    expect(unpaged.body.count).toBe(3);
    const walked: FeeRow[] = [];
    let marker: string | undefined;
    do {
      const res = await get(`${path}&limit=1${marker ? `&marker=${marker}` : ''}`);
      walked.push(...res.body.rows);
      marker = res.body.marker;
    } while (marker);
    expect(walked).toEqual(unpaged.body.rows);
  });
});

// ===================================================================================================================
// rows written twice
// ===================================================================================================================

describe('GET /v2/network/fees and /fee_stats when rows were written twice', () => {
  // `ledgers` is a ReplacingMergeTree, `fee_stats` a MergeTree, and the lists never use FINAL, so until a merge a row can
  // be there twice (the syncer re-writes a ledger it is not sure about; a retry can insert a snapshot twice). Merges are
  // stopped and a SECOND insert (a duplicate inside one insert would be collapsed on the way in) puts every row there twice.
  let h: Harness;
  let get: ApiClient['get'];

  const count = async (table: Table): Promise<number> =>
    Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${table}`))[0].n);

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
    await h.ch.insert(Table.FeeStats, MOCK_ROWS);
    for (const table of [Table.Ledgers, Table.FeeStats]) {
      await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${table}`);
      await h.ch.command(`INSERT INTO ${table} SELECT * FROM ${table}`, {}, { settings: { insert_deduplicate: 0 } });
    }
    expect(await count(Table.Ledgers)).toBe(108);
    expect(await count(Table.FeeStats)).toBe(40);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('lists every ledger once, and a page cut anywhere neither repeats nor skips one', async () => {
    const unpaged = await get('/v2/network/fees?limit=1000');
    expect(unpaged.body.count).toBe(54);
    expect(unpaged.body.rows).toEqual(ledgerRows(MOCK));
    for (const limit of [1, 2, 5]) {
      const walked = (await (await h.api()).pages<FeeBody>('/v2/network/fees', limit, 'rows')).flatMap((p) => p.rows);
      expect([limit, walked]).toEqual([limit, ledgerRows(MOCK)]);
    }
    const desc = await get('/v2/network/fees?limit=1000&descending=true');
    expect(desc.body.rows).toEqual(ledgerRows(MOCK).reverse());
  });

  it('adds up every ledger of an hour or a day once', async () => {
    expect((await get('/v2/network/fees?interval=hour&limit=1000')).body.rows).toEqual(bucketRows(MOCK, HOUR));
    expect((await get('/v2/network/fees?interval=day&limit=1000')).body.rows).toEqual(bucketRows(MOCK, DAY));
  });

  it('lists every snapshot once', async () => {
    const unpaged = await get('/v2/network/fee_stats?limit=1000');
    expect(unpaged.body.count).toBe(20);
    expect(unpaged.body.rows).toEqual(MOCK_STATS);
    for (const limit of [1, 3, 7]) {
      const walked = (await (await h.api()).pages<StatBody>('/v2/network/fee_stats', limit, 'rows')).flatMap(
        (p) => p.rows,
      );
      expect([limit, walked]).toEqual([limit, MOCK_STATS]);
    }
    expect((await get('/v2/network/fee_stats?limit=1000&descending=true')).body.rows).toEqual(
      [...MOCK_STATS].reverse(),
    );
  });

  it('samples a minute once', async () => {
    const res = await get('/v2/network/fee_stats?interval=minute&start=2016-08-24T00:15:00Z');
    expect(res.body.rows).toEqual([MOCK_STATS[0], MOCK_STATS[12]]);
  });
});

// ===================================================================================================================
// /v2/network/fee_stats
// ===================================================================================================================

describe('GET /v2/network/fee_stats', () => {
  // Snapshots of a made-up history: four in one minute (two of them in the same second), one exactly on a minute
  // boundary, one just before a boundary, one an hour and a day on, and two far apart in 2019 and 2021.
  const ROWS = [
    snapshot('2019-07-01T09:10:11.000', 5),
    snapshot('2020-01-01T12:00:07.250', 10), // first at or after 12:00:00 in its minute, hour and day
    snapshot('2020-01-01T12:00:07.750', 11), // the same second
    snapshot('2020-01-01T12:00:12.250', 20),
    snapshot('2020-01-01T12:00:17.250', 30),
    snapshot('2020-01-01T12:01:00.000', 40), // exactly on the boundary
    snapshot('2020-01-01T12:01:30.000', 50),
    snapshot('2020-01-01T12:05:59.999', 60), // just before 12:06
    snapshot('2020-01-01T13:00:10.000', 70), // first of 13:00
    snapshot('2020-01-01T13:30:00.000', 80),
    snapshot('2020-01-01T13:59:59.000', 90),
    snapshot('2020-01-02T00:00:03.000', 100), // first of 2020-01-02
    snapshot('2020-01-02T23:59:59.000', 110),
    snapshot('2021-06-15T08:00:00.500', 120),
  ];
  const BY_SIZE = new Map(ROWS.map((r) => [r.current_ledger_size, r]));
  /** The API row of the snapshot of ledger size `size`. */
  const row = (size: number): StatRow => {
    const r = BY_SIZE.get(size) as FeeStatsRow;
    return statOf(r, iso(Math.floor(Number(r.ts))));
  };

  let h: Harness;
  let api: ApiClient;
  let get: ApiClient['get'];
  const pages = (path: string, limit: number): Promise<StatBody[]> => api.pages<StatBody>(path, limit, 'rows');
  const sizes = (body: StatBody): number[] => body.rows.map((r) => r.current_ledger_size);

  beforeAll(async () => {
    h = await startHarness({ seed: 'none', env: NO_RATE_LIMIT });
    api = await h.api();
    get = api.get;
    await h.ch.insert(Table.FeeStats, ROWS);
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the rows', () => {
    it('a snapshot is {current_ledger_size, current_queue_size, date, expected_ledger_size, median_fee, minimum_fee, open_ledger_fee, pct_max_queue_size}', async () => {
      const res = await get('/v2/network/fee_stats?start=2020-01-01T12:00:07&limit=1');
      expect(res.body.rows).toEqual([
        {
          current_ledger_size: 10,
          current_queue_size: 10,
          date: '2020-01-01T12:00:07Z',
          expected_ledger_size: 50,
          median_fee: 0.005,
          minimum_fee: 0.00001,
          open_ledger_fee: 0.00002,
          pct_max_queue_size: 1,
        },
      ]);
      expect(Object.keys(res.body.rows[0])).toEqual(STAT_KEYS);
    });

    it('R71: the keys of a row, in JSON and in the CSV header, are the columns of the HBase row sorted by name, raw and sampled', async () => {
      for (const interval of ['', 'minute', 'hour', 'day']) {
        const json = await get(`/v2/network/fee_stats?interval=${interval}&limit=1000`);
        expect(json.body.rows.length).toBeGreaterThan(0);
        for (const row of json.body.rows as StatRow[])
          expect([interval, Object.keys(row)]).toEqual([interval, STAT_KEYS]);
        const csv = await get(`/v2/network/fee_stats?interval=${interval}&format=csv&limit=2`);
        expect([interval, csv.text.split('\n')[0]]).toEqual([interval, STAT_KEYS.map((k) => `"${k}"`).join(',')]);
      }
    });

    it('is all numbers (fees in the native unit) but the date, which is the second the snapshot was taken in', async () => {
      const res = await get('/v2/network/fee_stats?limit=1000');
      expect(res.body.count).toBe(ROWS.length);
      for (const r of (res.body as StatBody).rows) {
        for (const [key, value] of Object.entries(r)) expect(typeof value).toBe(key === 'date' ? 'string' : 'number');
        expect(r.date).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      }
      expect(res.body.rows[7].date).toBe('2020-01-01T12:05:59Z'); // taken at .999
    });

    it('the start defaults to 2016-07-01: nothing before it is served', async () => {
      await h.ch.insert(Table.FeeStats, [
        snapshot('2016-06-30T23:59:59.000', 1),
        snapshot('2016-07-01T00:00:00.000', 2),
      ]);
      try {
        const res = await get('/v2/network/fee_stats?end=2017&limit=1000');
        expect(sizes(res.body)).toEqual([2]);
        expect(sizes((await get('/v2/network/fee_stats?start=2016-06-01&end=2017&limit=1000')).body)).toEqual([1, 2]);
        expect(sizes((await get('/v2/network/fee_stats?start=&end=2017&limit=1000')).body)).toEqual([2]);
      } finally {
        await h.ch.command(
          `ALTER TABLE ${Table.FeeStats} DELETE WHERE current_ledger_size IN (1, 2) SETTINGS mutations_sync = 2`,
        );
      }
    });

    it('two snapshots in one second are both served, in order, and a page can end between them', async () => {
      const res = await get('/v2/network/fee_stats?start=2020-01-01T12:00:07&end=2020-01-01T12:00:07');
      expect(sizes(res.body)).toEqual([10, 11]);
      const walked = await pages('/v2/network/fee_stats?start=2020-01-01T12:00:07&end=2020-01-01T12:00:12', 1);
      expect(walked.flatMap(sizes)).toEqual([10, 11, 20]);
      expect(walked[0].marker).toBe(markerOf(Date.parse('2020-01-01T12:00:07.250Z')));
    });
  });

  describe('fee_stats sampling (interval=minute|hour|day)', () => {
    // The original looked up, for each boundary, the row stored under exactly that second (the importer ran at second 0, 5,
    // 10, ...). A snapshot is taken whenever the poller's tick falls, and may be missing, so each bucket serves the FIRST
    // snapshot at or after its boundary (argMin by time within [boundary, boundary + interval)). Where there is a snapshot at
    // the boundary it is that one, the original's row.
    it('takes the first snapshot of the minute: three snapshots in one minute, the first is served', async () => {
      const res = await get('/v2/network/fee_stats?interval=minute&start=2020-01-01T12:00:00&end=2020-01-01T12:01:00');
      expect(res.body.rows).toEqual([row(10)]);
      expect(res.body.rows[0].date).toBe('2020-01-01T12:00:07Z');
    });

    it('a snapshot exactly on the boundary is the one served; a snapshot just before the next boundary is served for its minute', async () => {
      const res = await get(
        '/v2/network/fee_stats?interval=minute&start=2020-01-01T12:00:00&end=2020-01-01T12:10:00&limit=1000',
      );
      // 12:00 -> 10, 12:01 -> 40 (on the boundary, not the 50 after it), 12:05 -> 60 (at .999)
      expect(sizes(res.body)).toEqual([10, 40, 60]);
    });

    it('serves the first snapshot of every hour and of every day', async () => {
      const hours = await get('/v2/network/fee_stats?interval=hour&start=2020-01-01&end=2020-01-03&limit=1000');
      expect(sizes(hours.body)).toEqual([10, 70, 100, 110]);
      const days = await get('/v2/network/fee_stats?interval=day&start=2020-01-01&end=2020-01-03&limit=1000');
      expect(sizes(days.body)).toEqual([10, 100]);
    });

    it('a bucket without a snapshot has no row, however long the gap: the history is not walked a bucket at a time', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get('/v2/network/fee_stats?interval=hour&limit=1000');
      expect(sizes(res.body)).toEqual([5, 10, 70, 100, 110, 120]);
      const feeStats = spy.mock.calls.filter(([q]) => new RegExp(`FROM ${Table.FeeStats}\\b`).test(String(q)));
      // 2 years of hours would be 17000 point lookups; the windows double across a gap
      expect(feeStats.length).toBeLessThan(40);
      const days = await get('/v2/network/fee_stats?interval=day&limit=1000');
      expect(sizes(days.body)).toEqual([5, 10, 100, 120]);
    });

    it('a bucket that began before the start is not served (the first boundary at or after start is the first row)', async () => {
      const mid = await get('/v2/network/fee_stats?interval=minute&start=2020-01-01T12:00:01&limit=1000');
      expect(sizes(mid.body)).toEqual([40, 60, 70, 80, 90, 100, 110, 120]);
      const on = await get('/v2/network/fee_stats?interval=minute&start=2020-01-01T12:00:00&limit=1000');
      expect(sizes(on.body)).toEqual([10, 40, 60, 70, 80, 90, 100, 110, 120]);
      const hour = await get('/v2/network/fee_stats?interval=hour&start=2020-01-01T12:00:01&limit=1000');
      expect(sizes(hour.body)).toEqual([70, 100, 110, 120]);
    });

    it('end is the instant before which a bucket must start: a bucket starting at end is not served, end is not widened to its period', async () => {
      expect(
        sizes(
          (await get('/v2/network/fee_stats?interval=minute&start=2020-01-01&end=2020-01-01T12:01:00&limit=1000')).body,
        ),
      ).toEqual([10]);
      expect(
        sizes(
          (await get('/v2/network/fee_stats?interval=minute&start=2020-01-01&end=2020-01-01T12:01:01&limit=1000')).body,
        ),
      ).toEqual([10, 40]);
      // a date as end is its first instant: no hour of that day
      expect(
        sizes((await get('/v2/network/fee_stats?interval=hour&start=2020-01-01&end=2020-01-02&limit=1000')).body),
      ).toEqual([10, 70]);
      // while the raw snapshots take the whole second, minute, ... of end
      expect(
        sizes((await get('/v2/network/fee_stats?start=2020-01-01T13:00:10&end=2020-01-01T13:00:10')).body),
      ).toEqual([70]);
    });

    it('marker pages concatenate to the unpaged list, and descending reverses it', async () => {
      for (const interval of ['minute', 'hour', 'day']) {
        const path = `/v2/network/fee_stats?interval=${interval}`;
        const unpaged = await get(`${path}&limit=1000`);
        const desc = await get(`${path}&limit=1000&descending=true`);
        expect([interval, sizes(desc.body)]).toEqual([interval, sizes(unpaged.body).reverse()]);
        for (const limit of [1, 2, 3]) {
          const walked = await pages(path, limit);
          expect([interval, limit, walked.flatMap(sizes)]).toEqual([interval, limit, sizes(unpaged.body)]);
          const walkedDesc = await pages(`${path}&descending=true`, limit);
          expect([interval, limit, walkedDesc.flatMap(sizes)]).toEqual([interval, limit, sizes(desc.body)]);
        }
      }
    });

    it('the marker is the start of the bucket of the last row, and a page continues with the buckets after it', async () => {
      const first = await get('/v2/network/fee_stats?interval=minute&limit=2');
      expect(sizes(first.body)).toEqual([5, 10]);
      expect(first.body.marker).toBe(markerOf(unix('2020-01-01T12:00:00')));
      const next = await get(`/v2/network/fee_stats?interval=minute&limit=2&marker=${first.body.marker}`);
      expect(sizes(next.body)).toEqual([40, 60]);
      expect(next.body.marker).toBe(markerOf(unix('2020-01-01T12:05:00')));
      const back = await get(
        `/v2/network/fee_stats?interval=minute&descending=true&limit=2&marker=${next.body.marker}`,
      );
      expect(sizes(back.body)).toEqual([40, 10]);
      expect(back.body.marker).toBe(markerOf(unix('2020-01-01T12:00:00')));
    });

    it('interval=raw is the raw list (the original listed it as valid, and answered with the start repeated)', async () => {
      const raw = await get('/v2/network/fee_stats?limit=1000');
      expect((await get('/v2/network/fee_stats?interval=raw&limit=1000')).body).toEqual(raw.body);
      expect((await get('/v2/network/fee_stats?interval=&limit=1000')).body).toEqual(raw.body);
    });

    it('the interval is case sensitive, anything else is 400 invalid interval; the first of a repeated one wins', async () => {
      for (const bad of ['Minute', 'HOUR', 'week', 'second', 'ledger', ' hour']) {
        const res = await get(`/v2/network/fee_stats${qs({ interval: bad })}`);
        expect([bad, res.status, res.body]).toEqual([bad, 400, { result: 'error', message: 'invalid interval' }]);
      }
      const day = await get('/v2/network/fee_stats?interval=day&limit=10');
      expect((await get('/v2/network/fee_stats?interval=day&interval=minute&limit=10')).body).toEqual(day.body);
    });

    it('a start before 1970 and an end after 2106 are the whole history, a marker at the end of time is the end of the list', async () => {
      for (const interval of ['', 'minute', 'hour', 'day']) {
        const all = await get(`/v2/network/fee_stats?interval=${interval}&limit=1000`);
        const wide = await get(`/v2/network/fee_stats?interval=${interval}&start=0001-01-01&end=9999-12-31&limit=1000`);
        expect([interval, wide.status, sizes(wide.body)]).toEqual([interval, 200, sizes(all.body)]);
        // the start defaults to 2016, so the snapshot of 2019 is in `all` too
        expect(sizes(wide.body)[0]).toBe(5);
        const end = interval === '' ? markerOf(Number.MAX_SAFE_INTEGER) : markerOf(4_294_967_295);
        expect(sizes((await get(`/v2/network/fee_stats?interval=${interval}&limit=1000&marker=${end}`)).body)).toEqual(
          [],
        );
        expect(
          sizes(
            (await get(`/v2/network/fee_stats?interval=${interval}&limit=1000&descending=true&marker=${end}`)).body,
          ),
        ).toEqual(sizes(all.body).reverse());
      }
    });

    it('empty range → count 0', async () => {
      for (const interval of ['', 'minute', 'hour', 'day']) {
        const res = await get(`/v2/network/fee_stats?interval=${interval}&start=2030-01-01&end=2030-12-31`);
        expect([interval, res.status, res.body]).toEqual([interval, 200, { result: 'success', count: 0, rows: [] }]);
        expect((await get(`/v2/network/fee_stats?interval=${interval}&start=2022-01-01`)).body.count).toBe(0);
        expect(
          (await get(`/v2/network/fee_stats?interval=${interval}&start=2021-01-01&end=2020-01-01`)).body.count,
        ).toBe(0);
      }
    });
  });

  describe('the list', () => {
    it('marker pages concatenate to unpaged list', async () => {
      const unpaged = await get('/v2/network/fee_stats?limit=1000');
      expect(unpaged.body.count).toBe(ROWS.length);
      for (const limit of [1, 2, 3, 5]) {
        const walked = await pages('/v2/network/fee_stats', limit);
        expect(walked.slice(0, -1).every((p) => p.count === limit && p.marker !== undefined)).toBe(true);
        expect(walked[walked.length - 1].marker).toBeUndefined();
        expect([limit, walked.flatMap((p) => p.rows)]).toEqual([limit, unpaged.body.rows]);
      }
    });

    it('descending reverses order', async () => {
      const asc = await get('/v2/network/fee_stats?limit=1000');
      const desc = await get('/v2/network/fee_stats?limit=1000&descending=true');
      expect(desc.body.rows).toEqual([...asc.body.rows].reverse());
      for (const limit of [1, 4]) {
        expect((await pages('/v2/network/fee_stats?descending=true', limit)).flatMap((p) => p.rows)).toEqual(
          desc.body.rows,
        );
      }
    });

    it('descending is only /true/i', async () => {
      const asc = await get('/v2/network/fee_stats?limit=3');
      for (const flag of ['false', '1', '']) {
        expect((await get(`/v2/network/fee_stats?limit=3&descending=${flag}`)).body).toEqual(asc.body);
      }
      expect(sizes((await get('/v2/network/fee_stats?limit=3&descending=TRUE')).body)).toEqual([120, 110, 100]);
    });

    it('unknown params ignored', async () => {
      const plain = await get('/v2/network/fee_stats?limit=5');
      const res = await get('/v2/network/fee_stats?limit=5&foo=bar&reduce=true&currency=USD');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(plain.body);
    });

    it('a repeated param: the first value wins', async () => {
      const res = await get('/v2/network/fee_stats?limit=3&limit=50&descending=true&descending=false');
      expect(sizes(res.body)).toEqual([120, 110, 100]);
    });

    it('a marker continues strictly after (before, descending) its row, to the millisecond', async () => {
      const marker = markerOf(Date.parse('2020-01-01T12:00:07.250Z'));
      expect(sizes((await get(`/v2/network/fee_stats?limit=2&marker=${marker}`)).body)).toEqual([11, 20]);
      expect(sizes((await get(`/v2/network/fee_stats?limit=2&descending=true&marker=${marker}`)).body)).toEqual([5]);
    });

    it('a marker that is none of the list is 400 invalid marker, also when the range is empty', async () => {
      for (const marker of ['x', '!!', markerOf(), markerOf(1, 2), markerOf('a'), markerOf(-1), markerOf(1.5)]) {
        for (const interval of ['', 'hour']) {
          const res = await get(`/v2/network/fee_stats?interval=${interval}&marker=${marker}`);
          expect([interval, marker, res.status, res.body]).toEqual([
            interval,
            marker,
            400,
            { result: 'error', message: 'invalid marker' },
          ]);
        }
      }
      expect((await get(`/v2/network/fee_stats?start=2030-01-01&marker=${markerOf(1, 2)}`)).status).toBe(400);
    });

    it('limit is 200 by default and at most 1000; below one or not a number it is the default', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const fetched = async (limit: string): Promise<unknown> => {
        spy.mockClear();
        await get(`/v2/network/fee_stats?${limit}`);
        const call = spy.mock.calls.find(([q]) => new RegExp(`FROM ${Table.FeeStats}\\b`).test(String(q)));
        return (call?.[1] as { distinct_page_limit?: number } | undefined)?.distinct_page_limit;
      };
      expect(await fetched('')).toBe(201);
      expect(await fetched('limit=abc')).toBe(201);
      expect(await fetched('limit=0')).toBe(201);
      expect(await fetched('limit=-1')).toBe(201);
      expect(await fetched('limit=99999')).toBe(1001);
      expect(await fetched('limit=3.7')).toBe(4);
    });

    it('the Link header keeps the query and puts the marker last; the last page has none', async () => {
      const res = await get('/v2/network/fee_stats?interval=hour&limit=2&descending=true');
      const origin = new URL(res.request.url).origin;
      expect(res.headers.link).toBe(
        `<${origin}/v2/network/fee_stats?interval=hour&limit=2&descending=true&marker=${res.body.marker}>; rel="next"`,
      );
      const last = await get('/v2/network/fee_stats?limit=1000');
      expect(last.body.marker).toBeUndefined();
      expect(last.headers.link).toBeUndefined();
    });

    it('the checks come in the order of the original: start, end, interval, then the marker', async () => {
      expect((await get('/v2/network/fee_stats?start=x&end=y&interval=zzz&marker=!!')).body.message).toBe(
        'invalid start date format',
      );
      expect((await get('/v2/network/fee_stats?end=y&interval=zzz&marker=!!')).body.message).toBe(
        'invalid end date format',
      );
      expect((await get('/v2/network/fee_stats?interval=zzz&marker=!!')).body.message).toBe('invalid interval');
      expect((await get('/v2/network/fee_stats?marker=!!')).body.message).toBe('invalid marker');
    });

    it('is 500 unable to retrieve fee summary(s) when the database fails', async () => {
      jest.spyOn(h.ch, 'query').mockRejectedValue(new Error('boom'));
      for (const interval of ['', 'minute']) {
        const res = await get(`/v2/network/fee_stats?interval=${interval}`);
        expect([interval, res.status, res.body]).toEqual([
          interval,
          500,
          { result: 'error', message: 'unable to retrieve fee summary(s)' },
        ]);
      }
    });
  });

  describe('format=csv', () => {
    it('format=csv → text/csv, network fee stats.csv, one row per snapshot', async () => {
      const res = await get('/v2/network/fee_stats?format=csv&limit=1000');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe(csvDisposition('network fee stats'));
      const rows = res.text.split('\n');
      expect(rows).toHaveLength(1 + ROWS.length);
      expect(rows[0].split(',')).toEqual(STAT_KEYS.map((key) => `"${key}"`));
      expect(rows[1]).toBe('"5","5","2019-07-01T09:10:11Z","50","0.005","0.00001","0.000015","0.5"');
    });

    it('goes with the interval, has the Link header on a next page, and an empty range is an empty CSV', async () => {
      const hours = await get('/v2/network/fee_stats?format=csv&interval=hour&limit=2');
      expect(hours.text.split('\n')).toHaveLength(1 + 2);
      expect(hours.headers.link).toBeDefined();
      const empty = await get('/v2/network/fee_stats?format=csv&start=2030-01-01');
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      expect((await get('/v2/network/fee_stats?format=csv&interval=zzz')).body).toEqual({
        result: 'error',
        message: 'invalid interval',
      });
    });
  });

  describe('the query', () => {
    const feeSql = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => new RegExp(`FROM ${Table.FeeStats}\\b`).test(String(q)))
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);
    const planOf = async (sql: string, params: Record<string, unknown>, kind = 'PIPELINE'): Promise<string> =>
      (await h.ch.query<{ explain: string }>(`EXPLAIN ${kind} ${sql}`, params)).map((r) => r.explain).join('\n');

    it('pages the raw snapshots by time with bound values, the cursor on ts, and dedupes by ts', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const marker = markerOf(Date.parse('2020-01-01T12:00:12.250Z'));
      const res = await get(`/v2/network/fee_stats?limit=3&start=2020-01-01&end=2020-01-03&marker=${marker}`);
      expect(sizes(res.body)).toEqual([30, 40, 50]);
      const [[sql, params]] = feeSql(spy);
      expect(sql).toMatch(/ts >= fromUnixTimestamp64Milli\(\{from:Int64\}, 'UTC'\)/);
      expect(sql).toMatch(/ts < fromUnixTimestamp64Milli\(\{until:Int64\}, 'UTC'\)/);
      expect(sql).toMatch(/ts > fromUnixTimestamp64Milli\(toInt64\(\{k0:UInt64\}\), 'UTC'\)/);
      // read in the order of the key with a plain LIMIT, which stops the read after the page (Ruling R106) ...
      expect(sql).toMatch(/ORDER BY ts ASC\s+LIMIT \{distinct_page_cap:UInt32\}/);
      // ... and a snapshot that was written twice counts once, outside it
      expect(sql).toMatch(/LIMIT 1 BY ms\s+LIMIT \{distinct_page_limit:UInt32\}/);
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(params).toMatchObject({
        from: Date.parse('2020-01-01T00:00:00Z'),
        k0: Date.parse('2020-01-01T12:00:12.250Z'),
        distinct_page_limit: 4,
      });
    });

    it('reads the raw snapshots in the order of the primary key, so that a page never sorts the whole range', async () => {
      const marker = markerOf(Date.parse('2020-01-01T12:00:12.250Z'));
      for (const descending of [false, true]) {
        for (const variant of ['limit=5', `limit=5&marker=${marker}`, 'limit=5&start=2020-01-01&end=2020-12-31']) {
          const spy = jest.spyOn(h.ch, 'query');
          await get(`/v2/network/fee_stats?${variant}&descending=${descending}`);
          const [[sql, params]] = feeSql(spy);
          jest.restoreAllMocks();
          // in the order of the key, no sort, and a LIMIT on the read itself: it stops after the page
          await expectBoundedInOrderRead(h, sql, params, descending, [descending, variant]);
        }
      }
    });

    it('samples a bucket with argMin over the time window only: the primary key on ts bounds what is read', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get('/v2/network/fee_stats?interval=hour&start=2020-01-01&limit=2');
      // (besides the two reads that find where the snapshots of the range begin and end)
      const calls = feeSql(spy).filter(([sql]) => /GROUP BY/.test(sql));
      expect(calls.length).toBeGreaterThan(0);
      for (const [sql, params] of calls) {
        expect(sql).toMatch(/argMin\(/);
        expect(sql).toMatch(/GROUP BY bucket\s+ORDER BY bucket ASC\s+LIMIT \{fetch:UInt32\}/);
        expect(sql).toMatch(/ts >= fromUnixTimestamp64Milli\(\{lo:Int64\}, 'UTC'\)/);
        expect(sql).toMatch(/ts < fromUnixTimestamp64Milli\(\{hi:Int64\}, 'UTC'\)/);
        expect(sql).not.toMatch(/\bFINAL\b/);
        expect(params).toMatchObject({ size: 3600 });
      }
      const [sql, params] = calls[0];
      jest.restoreAllMocks();
      const indexes = await planOf(sql, params, 'indexes = 1');
      expect(indexes).toContain('PrimaryKey');
      expect(indexes).toMatch(/Keys:\s*\n\s*ts/);
    });
  });
});

// ===================================================================================================================
// Xahau
// ===================================================================================================================

describe('GET /v2/network/fees and /fee_stats on Xahau', () => {
  // The recorded Xahau ledgers are real: 6 ledgers within an hour or two, with fees from 10 to 18088 drops and a
  // GenesisMint of Fee 0 (a ledger whose min is 0 though it has transactions). Fees are in XAH: a million drops to the unit.
  let h: Harness;
  let get: ApiClient['get'];

  beforeAll(async () => {
    h = await startHarness({ seed: 'xahau-recorded', env: NO_RATE_LIMIT });
    get = (await h.api()).get;
    await h.ch.insert(Table.FeeStats, [
      snapshot('2026-10-15T12:25:00.100', 12, { median_fee: 10, minimum_fee: 10, open_ledger_fee: 7056 }),
      snapshot('2026-10-15T12:25:05.100', 13, { median_fee: 10, minimum_fee: 10, open_ledger_fee: 18088 }),
    ]);
  });
  afterAll(async () => {
    await h?.close();
  });

  it('every ledger, hour and day is what the original parser and aggregation made of the Xahau ledgers, in XAH', async () => {
    expect(XAHAU).toHaveLength(6);
    const ledger = await get('/v2/network/fees?limit=1000');
    expect(ledger.body.rows).toEqual(ledgerRows(XAHAU));
    expect((await get('/v2/network/fees?interval=hour&limit=1000')).body.rows).toEqual(bucketRows(XAHAU, HOUR));
    expect((await get('/v2/network/fees?interval=day&limit=1000')).body.rows).toEqual(bucketRows(XAHAU, DAY));
    // a million drops to the XAH
    const fees = XAHAU[0].transactions.map((t) => Number(t.tx.Fee));
    expect(ledger.body.rows[0]).toMatchObject({
      ledger_index: 26540187,
      tx_count: fees.length,
      total: fees.reduce((a, b) => a + b, 0) / 1e6,
      max: Math.max(...fees) / 1e6,
      min: Math.min(...fees) / 1e6,
    });
  });

  it('a ledger with a transaction that paid nothing has min 0, its hour the smallest fee above zero', async () => {
    const ledgers = (await get('/v2/network/fees?limit=1000')).body.rows as FeeRow[];
    const genesis = ledgers.find((r) => r.ledger_index === 26540188) as FeeRow;
    expect(genesis).toMatchObject({ min: 0, tx_count: 4 });
    const hours = (await get('/v2/network/fees?interval=hour&limit=1000')).body.rows as FeeRow[];
    const first = hours[0];
    expect(first.min).toBe(0.00001);
    expect(hours.reduce((a, r) => a + r.tx_count, 0)).toBe(XAHAU.reduce((a, l) => a + l.transactions.length, 0));
  });

  it('lists, pages and reverses as on XRPL', async () => {
    const unpaged = await get('/v2/network/fees?limit=1000');
    const walked = (await (await h.api()).pages<FeeBody>('/v2/network/fees', 2, 'rows')).flatMap((p) => p.rows);
    expect(walked).toEqual(unpaged.body.rows);
    expect((await get('/v2/network/fees?descending=true&limit=1000')).body.rows).toEqual(
      [...unpaged.body.rows].reverse(),
    );
    expect((await get('/v2/network/fees?start=2030-01-01')).body.count).toBe(0);
    expect((await get('/v2/network/fees?format=csv')).headers['content-disposition']).toBe(
      csvDisposition('network fees'),
    );
  });

  it('serves the fee stats in XAH too', async () => {
    const res = await get('/v2/network/fee_stats?start=2026-01-01');
    expect(res.body.rows).toEqual([
      {
        current_ledger_size: 12,
        current_queue_size: 12,
        date: '2026-10-15T12:25:00Z',
        expected_ledger_size: 50,
        median_fee: 0.00001,
        minimum_fee: 0.00001,
        open_ledger_fee: 0.007056,
        pct_max_queue_size: 1.2,
      },
      expect.objectContaining({ current_ledger_size: 13, open_ledger_fee: 0.018088 }),
    ]);
    const minute = await get('/v2/network/fee_stats?interval=minute&start=2026-01-01');
    expect(minute.body.rows).toHaveLength(1);
    expect(minute.body.rows[0].current_ledger_size).toBe(12);
  });
});
