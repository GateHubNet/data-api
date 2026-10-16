import {
  buildLedgerRows,
  getNetworkProfile,
  NetworkName,
  parseContextFor,
  RawLedger,
  StatsHourlyRow,
  Table,
} from '@gatehub/data-api-shared';
import { ApiClient, Harness, NO_RATE_LIMIT, startHarness } from './harness';
import { fixtureSource, SeedName } from './support/fixtures';

/**
 * `GET /v2/stats[/{family}[/{metric}]]` on a real ClickHouse, seeded with the 54 mock ledgers of the original Ripple test
 * suite through the `LedgerWriter`; the harness then rolls them up into `stats_hourly` with `recomputeStatsHourly`.
 *
 * Ported from rippled-historical-database `test/test.stats.js` (12 `it`s: the 11 below and 'should make sure stats handles
 * pagination correctly'), same titles, none skipped: every expected value derives from the mock ledgers (7 days, 10 hours).
 * The two that differ from the original:
 *  - 'should include a link header when marker is present' expected the HBase row key as the marker
 *    (`day|20131025000000`: the key of the FIRST row of the next page); the marker of this API is the key of the LAST row of
 *    the page, base64url of a JSON array holding the start of its bucket in unix seconds, like every other list of this API;
 *  - the original's pagination check compares `date` and `type.Payment` of each page with the unpaged list; so does this one.
 *
 * Added: an oracle that adds the raw ledgers up per hour, day and week as the original's aggregation did (a port of what
 * `lib/aggregation/stats.js` counted: transactions, their types and results, payments, exchanges, created accounts, ledgers,
 * `tx_per_ledger` and `ledger_interval` to five significant digits) for every interval, family and metric; the exact keys and
 * their order (the original served the HBase row: columns sorted by name, `date` after them in a family, `date` first in a
 * nested row); zero values omitted; the window rules (a bucket is served when it STARTS inside start and end); pages,
 * markers, descending, CSV and its file names; every message of the original and `invalid interval` (a bug fix: the original
 * scanned for a row key that cannot exist and answered an empty list); rows written twice (real duplicates), newer versions
 * and zero rows; the plan of the query; a failing database; Xahau.
 */

// -- helpers ----------------------------------------------------------------------------------------------------

const HOUR = 3600;
const DAY = 86_400;
const SIZES = { hour: HOUR, day: DAY } as const;
type Interval = 'hour' | 'day' | 'week';
const INTERVALS: Interval[] = ['hour', 'day', 'week'];

/** `YYYY-MM-DDTHH:mm:ssZ` of unix seconds. */
const iso = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
/** Unix seconds of a time without a zone, which is UTC (`Date.parse` would read it as local time). */
const unix = (text: string): number => Date.parse(/(Z|[+-]\d\d:\d\d)$/.test(text) ? text : `${text}Z`) / 1000;
/** The marker of a row: the start of its bucket as base64url JSON. */
const markerOf = (...key: (string | number)[]): string =>
  Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');

interface Stats {
  date: string;
  type: Record<string, number>;
  result: Record<string, number>;
  metric: Record<string, number>;
}
type Flat = Record<string, number | string>;
interface Body<T> {
  result: string;
  count: number;
  marker?: string;
  stats: T[];
}

// -- the oracle -------------------------------------------------------------------------------------------------

interface Bucket {
  start: number;
  transactions: number;
  payments: number;
  exchanges: number;
  accounts: number;
  ledgers: number;
  lastClose: number;
  types: Record<string, number>;
  results: Record<string, number>;
}

/** The start of the Monday on or before a time, worked out with the calendar and not with arithmetic. */
function mondayOf(seconds: number): number {
  const d = new Date(seconds * 1000);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday) / 1000;
}

function bucketStart(interval: Interval, seconds: number): number {
  if (interval === 'week') return mondayOf(seconds);
  return Math.floor(seconds / SIZES[interval]) * SIZES[interval];
}

/** The ledgers added up per bucket, ascending. What `lib/aggregation/stats.js` counted, from the raw ledgers. */
function oracle(ledgers: RawLedger[], interval: Interval, network: NetworkName = 'xrpl'): Bucket[] {
  const ctx = parseContextFor(getNetworkProfile(network));
  const buckets = new Map<number, Bucket>();
  for (const ledger of ledgers) {
    const row = buildLedgerRows(ledger, ctx).ledger;
    const start = bucketStart(interval, ledger.header.close_time);
    let b = buckets.get(start);
    if (!b) {
      b = {
        start,
        transactions: 0,
        payments: 0,
        exchanges: 0,
        accounts: 0,
        ledgers: 0,
        lastClose: 0,
        types: {},
        results: {},
      };
      buckets.set(start, b);
    }
    b.transactions += ledger.transactions.length;
    b.payments += row.payments_count;
    b.exchanges += row.exchanges_count;
    b.accounts += row.accounts_created;
    b.ledgers += 1;
    b.lastClose = Math.max(b.lastClose, ledger.header.close_time);
    for (const t of ledger.transactions) {
      const type = String(t.tx.TransactionType);
      const result = String(t.meta.TransactionResult);
      b.types[type] = (b.types[type] ?? 0) + 1;
      b.results[result] = (b.results[result] ?? 0) + 1;
    }
  }
  return [...buckets.values()].sort((a, b) => a.start - b.start);
}

const sorted = (o: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const fiveDigits = (x: number): number => Number(x.toPrecision(5));

/** The columns the aggregation stored for a bucket, by name; zero is not stored. */
function metricsOf(b: Bucket): Record<string, number> {
  const all: Record<string, number> = {
    accounts_created: b.accounts,
    exchanges_count: b.exchanges,
    ledger_count: b.ledgers,
    ledger_interval: fiveDigits((b.lastClose - b.start) / b.ledgers),
    payments_count: b.payments,
    transaction_count: b.transactions,
    tx_per_ledger: fiveDigits(b.transactions / b.ledgers),
  };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v !== 0));
}

/** A row of the list without a family. */
const nested = (b: Bucket): Stats => ({
  date: iso(b.start),
  type: sorted(b.types),
  result: sorted(b.results),
  metric: metricsOf(b),
});

/** A row of the list of a family (and of some of its metrics): the columns in sorted order, then `date`. */
function flat(b: Bucket, family: 'type' | 'result' | 'metric', names?: string[]): Flat | undefined {
  const columns = { type: b.types, result: b.results, metric: metricsOf(b) }[family];
  const picked = Object.fromEntries(
    Object.entries(sorted(columns)).filter(([name]) => names === undefined || names.includes(name)),
  );
  return Object.keys(picked).length === 0 ? undefined : { ...picked, date: iso(b.start) };
}

const flats = (buckets: Bucket[], family: 'type' | 'result' | 'metric', names?: string[]): Flat[] =>
  buckets.flatMap((b) => {
    const row = flat(b, family, names);
    return row === undefined ? [] : [row];
  });

const MOCK: RawLedger[] = fixtureSource('ripple-mock').list();
const HOURS = oracle(MOCK, 'hour');
const DAYS = oracle(MOCK, 'day');
const WEEKS = oracle(MOCK, 'week');
const BY_INTERVAL: Record<Interval, Bucket[]> = { hour: HOURS, day: DAYS, week: WEEKS };

// ===================================================================================================================
// the parity tests
// ===================================================================================================================

describe('stats API endpoint', () => {
  let h: Harness;
  let api: ApiClient;
  const get = (path: string) => api.get(path);

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('should get stats', async () => {
    let date = new Date('2013-01-01T00:00:00Z').getTime();
    const res = await get('/v2/stats');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body.result).toBe('success');
    expect(res.body.stats.length).toBe(res.body.count);
    expect(res.body.stats.length).toBe(7);
    for (const s of res.body.stats as Stats[]) {
      expect(typeof s.date).toBe('string');
      expect(typeof s.type).toBe('object');
      expect(typeof s.result).toBe('object');
      expect(typeof s.metric).toBe('object');
      expect(date - Date.parse(s.date)).toBeLessThanOrEqual(0); // 'date not greater than previous date'
      date = Date.parse(s.date);
    }
  });

  it('should get stats by time', async () => {
    const start = new Date('2013-01-01T00:00:00Z').getTime();
    const end = new Date('2014-01-01T00:00:00Z').getTime();
    const res = await get('/v2/stats?start=2013-01-01T00:00:00Z&end=2014-01-01T00:00:00Z');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.stats.length).toBe(res.body.count);
    expect(res.body.stats.length).toBe(2);
    for (const s of res.body.stats as Stats[]) {
      expect(start - Date.parse(s.date)).toBeLessThanOrEqual(0); // 'executed time less than start time'
      expect(end - Date.parse(s.date)).toBeGreaterThanOrEqual(0); // 'executed time greater than end time'
    }
  });

  it('should get stats by time in descending order', async () => {
    let date = new Date('9999-12-31T00:00:00Z').getTime();
    const res = await get('/v2/stats?descending=true');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.stats.length).toBe(res.body.count);
    expect(res.body.stats.length).toBe(7);
    for (const s of res.body.stats as Stats[]) {
      expect(date - Date.parse(s.date)).toBeGreaterThanOrEqual(0); // 'date not less than previous date'
      date = Date.parse(s.date);
    }
  });

  it('should make sure stats handles pagination correctly', async () => {
    // utils.checkPagination: the unpaged list, then every page of `limit=1` against the same position of it
    const ref = await get('/v2/stats');
    expect(ref.body.count).toBeGreaterThan(1);
    let marker: string | undefined;
    for (let i = 0; i < ref.body.count; i++) {
      const res = await get(`/v2/stats?limit=1${marker ? `&marker=${marker}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.result).toBe('success');
      expect(res.body.stats.length).toBe(1);
      expect(res.body.stats[0].date).toEqual(ref.body.stats[i].date);
      expect(res.body.stats[0].type.Payment).toEqual(ref.body.stats[i].type.Payment);
      marker = res.body.marker;
    }
    expect(marker).toBeUndefined();
  });

  it('should get stats by family', async () => {
    const res = await get('/v2/stats/metric');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.stats.length).toBe(7);
    for (const s of res.body.stats as Flat[]) {
      expect(typeof s.date).toBe('string');
      expect(typeof s.ledger_count).toBe('number');
      expect(typeof s.tx_per_ledger).toBe('number');
    }
  });

  it('should get stats by family and metric', async () => {
    const res = await get('/v2/stats/metric/ledger_count');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.stats.length).toBe(7);
    for (const s of res.body.stats as Flat[]) {
      expect(typeof s.date).toBe('string');
      expect(typeof s.ledger_count).toBe('number');
    }
  });

  it('should give an error for invalid family', async () => {
    const res = await get('/v2/stats/metricz/ledger_count');
    expect(res.status).toBe(400);
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid family, use: type, result, metric');
  });

  it('should give an empty result for a non-existent stat', async () => {
    const res = await get('/v2/stats/metric/ledger_countz');
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('success');
    expect(res.body.stats.length).toBe(0);
  });

  it('should return an error for an invalid start date', async () => {
    const res = await get('/v2/stats?start=2015x');
    expect(res.status).toBe(400);
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid start date format');
  });

  it('should return an error for an invalid end date', async () => {
    const res = await get('/v2/stats?end=2015x');
    expect(res.status).toBe(400);
    expect(res.body.result).toBe('error');
    expect(res.body.message).toBe('invalid end date format');
  });

  it('should include a link header when marker is present', async () => {
    const res = await get('/v2/stats?limit=1');
    expect(res.status).toBe(200);
    // the original's marker was the key of the second row (day|20131025000000); this API's is the key of the last row returned
    const marker = markerOf(unix('2013-06-11T00:00:00Z'));
    expect(res.body.marker).toBe(marker);
    const origin = new URL(res.request.url).origin;
    expect(res.headers.link).toBe(`<${origin}/v2/stats?limit=1&marker=${marker}>; rel="next"`);
  });
});

// ===================================================================================================================
// the numbers
// ===================================================================================================================

describe('GET /v2/stats against the mock ledgers', () => {
  let h: Harness;
  let api: ApiClient;
  const get = (path: string) => api.get(path);

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('the mock ledgers fall in 10 hours, 7 days and 7 weeks', () => {
    expect([HOURS.length, DAYS.length, WEEKS.length]).toEqual([10, 7, 7]);
    expect(DAYS.reduce((n, b) => n + b.ledgers, 0)).toBe(54);
  });

  describe.each(INTERVALS)('interval=%s', (interval) => {
    const buckets = BY_INTERVAL[interval];
    const q = `interval=${interval}&limit=1000`;

    it('serves every bucket as the oracle adds it up, with the keys in the order of the original', async () => {
      const res = await get(`/v2/stats?${q}`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(buckets.length);
      expect(res.body.stats).toEqual(buckets.map(nested));
      for (const row of res.body.stats as Stats[]) {
        expect(Object.keys(row)).toEqual(['date', 'type', 'result', 'metric']);
        expect(Object.keys(row.type)).toEqual(Object.keys(row.type).slice().sort());
        expect(Object.keys(row.result)).toEqual(Object.keys(row.result).slice().sort());
        expect(Object.keys(row.metric)).toEqual(Object.keys(row.metric).slice().sort());
      }
    });

    it('the body is {result, count, marker?, stats} and nothing else', async () => {
      const res = await get(`/v2/stats?${q}`);
      expect(Object.keys(res.body)).toEqual(['result', 'count', 'stats']);
      const paged = await get(`/v2/stats?interval=${interval}&limit=1`);
      expect(Object.keys(paged.body)).toEqual(['result', 'count', 'marker', 'stats']);
    });

    it.each(['type', 'result', 'metric'] as const)(
      'family %s: the columns of the family, sorted, and the date last',
      async (family) => {
        const res = await get(`/v2/stats/${family}?${q}`);
        expect(res.body.stats).toEqual(flats(buckets, family));
        for (const row of res.body.stats as Flat[]) {
          const keys = Object.keys(row);
          expect(keys[keys.length - 1]).toBe('date');
          expect(keys.slice(0, -1)).toEqual(keys.slice(0, -1).sort());
          for (const [key, value] of Object.entries(row)) if (key !== 'date') expect(typeof value).toBe('number');
        }
      },
    );

    it('family metric, one metric at a time: the path form and the metrics= form', async () => {
      for (const metric of [
        'accounts_created',
        'exchanges_count',
        'ledger_count',
        'ledger_interval',
        'payments_count',
        'transaction_count',
        'tx_per_ledger',
      ]) {
        const expected = flats(buckets, 'metric', [metric]);
        expect([metric, (await get(`/v2/stats/metric/${metric}?${q}`)).body.stats]).toEqual([metric, expected]);
        expect([metric, (await get(`/v2/stats/metric?${q}&metrics=${metric}`)).body.stats]).toEqual([metric, expected]);
        expect([metric, (await get(`/v2/stats?${q}&family=metric&metrics=${metric}`)).body.stats]).toEqual([
          metric,
          expected,
        ]);
      }
    });

    it('several metrics: sorted by name whatever the order asked, and only the rows that have one of them', async () => {
      const res = await get(`/v2/stats/metric?${q}&metrics=tx_per_ledger,ledger_count,exchanges_count`);
      expect(res.body.stats).toEqual(flats(buckets, 'metric', ['tx_per_ledger', 'ledger_count', 'exchanges_count']));
      expect(Object.keys(res.body.stats[0])).toEqual(['ledger_count', 'tx_per_ledger', 'date']);
    });

    it('transaction types and results by name', async () => {
      const types = [...new Set(buckets.flatMap((b) => Object.keys(b.types)))];
      expect(types).toContain('Payment');
      for (const type of types) {
        expect([type, (await get(`/v2/stats/type/${type}?${q}`)).body.stats]).toEqual([
          type,
          flats(buckets, 'type', [type]),
        ]);
      }
      const results = [...new Set(buckets.flatMap((b) => Object.keys(b.results)))];
      expect(results.length).toBeGreaterThan(1);
      for (const result of results) {
        expect([result, (await get(`/v2/stats/result/${result}?${q}`)).body.stats]).toEqual([
          result,
          flats(buckets, 'result', [result]),
        ]);
      }
      const two = await get(`/v2/stats/type?${q}&metrics=Payment,OfferCreate`);
      expect(two.body.stats).toEqual(flats(buckets, 'type', ['Payment', 'OfferCreate']));
    });

    it('omits what is zero: a bucket has no key for a type, result or metric that did not happen in it', async () => {
      const res = await get(`/v2/stats?${q}`);
      for (const row of res.body.stats as Stats[]) {
        for (const group of [row.type, row.result, row.metric]) {
          for (const value of Object.values(group)) expect(value).toBeGreaterThan(0);
        }
      }
      // the mock ledgers: some buckets have no payments, some no exchanges, some no created accounts
      const metrics = (res.body.stats as Stats[]).map((r) => Object.keys(r.metric));
      expect(metrics.some((m) => !m.includes('exchanges_count'))).toBe(true);
      expect(metrics.some((m) => m.includes('exchanges_count'))).toBe(true);
    });
  });

  it('a day is the sum of its hours and a week the sum of its days', async () => {
    const sumOf = (rows: Stats[], key: string) => rows.reduce((n, r) => n + (r.metric[key] ?? 0), 0);
    const hours = (await get('/v2/stats?interval=hour&limit=1000')).body.stats as Stats[];
    const days = (await get('/v2/stats?interval=day&limit=1000')).body.stats as Stats[];
    const weeks = (await get('/v2/stats?interval=week&limit=1000')).body.stats as Stats[];
    for (const key of ['ledger_count', 'transaction_count', 'payments_count', 'exchanges_count', 'accounts_created']) {
      expect([key, sumOf(days, key)]).toEqual([key, sumOf(hours, key)]);
      expect([key, sumOf(weeks, key)]).toEqual([key, sumOf(days, key)]);
    }
    for (const day of days) {
      const inDay = hours.filter((r) => r.date.slice(0, 10) === day.date.slice(0, 10));
      for (const type of Object.keys(day.type)) {
        expect([day.date, type, inDay.reduce((n, r) => n + (r.type[type] ?? 0), 0)]).toEqual([
          day.date,
          type,
          day.type[type],
        ]);
      }
    }
  });

  it('weeks start on Monday, UTC', async () => {
    const weeks = (await get('/v2/stats?interval=week&limit=1000')).body.stats as Stats[];
    for (const w of weeks) expect(new Date(w.date).getUTCDay()).toBe(1);
    // 2015-01-14 is a Wednesday, 2015-02-09 a Monday
    expect(weeks.map((w) => w.date)).toContain('2015-01-12T00:00:00Z');
    expect(weeks.map((w) => w.date)).toContain('2015-02-09T00:00:00Z');
    expect(weeks.map((w) => w.date)).not.toContain('2015-01-14T00:00:00Z');
    const monday = weeks.find((w) => w.date === '2015-01-12T00:00:00Z') as Stats;
    expect(monday.metric.ledger_count).toBe(41);
    // the interval is from the start of the bucket, here the Monday, to the last ledger of it
    const week = WEEKS.find((w) => w.start === unix('2015-01-12T00:00:00Z')) as Bucket;
    expect(week.lastClose).toBeGreaterThan(unix('2015-01-14T19:00:00Z'));
    expect(monday.metric.ledger_interval).toBe(fiveDigits((week.lastClose - week.start) / 41));
  });

  it('tx_per_ledger and ledger_interval are numbers of five significant digits', async () => {
    const res = await get('/v2/stats/metric?interval=day&limit=1000');
    for (const row of res.body.stats as Flat[]) {
      for (const key of ['tx_per_ledger', 'ledger_interval']) {
        expect([key, row[key]]).toEqual([key, Number((row[key] as number).toPrecision(5))]);
      }
    }
    const day = DAYS.find((b) => b.start === unix('2015-01-14T00:00:00Z')) as Bucket;
    const served = (res.body.stats as Flat[]).find((r) => r.date === '2015-01-14T00:00:00Z') as Flat;
    expect(served.ledger_count).toBe(41);
    expect(served.tx_per_ledger).toBe(Number((day.transactions / 41).toPrecision(5)));
  });

  it('the hours of the busy day are the three hours the ledgers closed in', async () => {
    const res = await get('/v2/stats/metric/ledger_count?interval=hour&start=2015-01-14&end=2015-01-14T23');
    expect(res.body.stats.map((r: Flat) => [r.date, r.ledger_count])).toEqual([
      ['2015-01-14T17:00:00Z', expect.any(Number)],
      ['2015-01-14T18:00:00Z', expect.any(Number)],
      ['2015-01-14T19:00:00Z', expect.any(Number)],
    ]);
    expect(res.body.stats.reduce((n: number, r: Flat) => n + (r.ledger_count as number), 0)).toBe(41);
  });

  describe('the window', () => {
    it('serves a bucket when it starts at or after start', async () => {
      const day = (q: string) =>
        get(`/v2/stats/metric/ledger_count?${q}`).then((r) => r.body.stats.map((s: Flat) => s.date));
      expect(await day('start=2015-01-14T00:00:00Z&end=2015-01-14T00:00:00Z')).toEqual(['2015-01-14T00:00:00Z']);
      // the day began before start: it is not served, though its ledgers closed after it
      expect(await day('start=2015-01-14T00:00:01Z&end=2015-01-14')).toEqual([]);
      expect(await day('start=2015-01-14T00:00:01Z&end=2015-02-09')).toEqual(['2015-02-09T00:00:00Z']);
      const hours = (q: string) =>
        get(`/v2/stats/metric/ledger_count?interval=hour&${q}`).then((r) => r.body.stats.map((s: Flat) => s.date));
      expect(await hours('start=2015-01-14T18:00:00Z&end=2015-01-14T19:59:59Z')).toEqual([
        '2015-01-14T18:00:00Z',
        '2015-01-14T19:00:00Z',
      ]);
      expect(await hours('start=2015-01-14T18:00:01Z&end=2015-01-14T19:59:59Z')).toEqual(['2015-01-14T19:00:00Z']);
    });

    it('an end names the period it is written to: end=2015-01-14 reaches the end of that day, end=2015-01 the end of the month', async () => {
      const days = (q: string) =>
        get(`/v2/stats/metric/ledger_count?${q}`).then((r) => r.body.stats.map((s: Flat) => s.date));
      expect(await days('start=2015-01-01&end=2015-01-14')).toEqual(['2015-01-14T00:00:00Z']);
      expect(await days('start=2015-01-01&end=2015-01-13')).toEqual([]);
      expect(await days('start=2015-01-01&end=2015-01')).toEqual(['2015-01-14T00:00:00Z']);
      expect(await days('start=2015-02-01&end=2015-02')).toEqual(['2015-02-09T00:00:00Z']);
      expect(await days('start=2015&end=2015')).toEqual(['2015-01-14T00:00:00Z', '2015-02-09T00:00:00Z']);
      expect((await days('start=2013&end=2017')).length).toBe(7);
    });

    it('start defaults to 2013-01-01 and end to now', async () => {
      expect((await get('/v2/stats?start=2013-01-01')).body.stats).toEqual((await get('/v2/stats')).body.stats);
      expect((await get('/v2/stats?end=2999-01-01')).body.stats).toEqual((await get('/v2/stats')).body.stats);
      expect((await get('/v2/stats?start=')).body.stats).toEqual((await get('/v2/stats')).body.stats);
      expect((await get('/v2/stats?start=2017-04-18')).body.count).toBe(2);
      expect((await get('/v2/stats?start=2012-01-01')).body.count).toBe(7);
    });

    it('an empty range is count 0 and an empty list, not an error', async () => {
      for (const interval of INTERVALS) {
        const res = await get(`/v2/stats?interval=${interval}&start=2030-01-01&end=2031-01-01`);
        expect([interval, res.status, res.body]).toEqual([interval, 200, { result: 'success', count: 0, stats: [] }]);
      }
      const reversed = await get('/v2/stats?start=2017-01-01&end=2015-01-01');
      expect(reversed.body).toEqual({ result: 'success', count: 0, stats: [] });
      expect((await get('/v2/stats/metric/ledger_count?start=2030-01-01')).body.stats).toEqual([]);
    });

    it('a start before every row and an end after every row, in any format of the original', async () => {
      for (const [start, end] of [
        ['2013', '2018'],
        ['2013-01', '2017-12'],
        ['2013-01-01T00', '2017-12-31T23'],
        ['2013-01-01T00:00', '2017-12-31T23:59'],
        ['20130101000000', '20171231235959'],
        ['2013-01-01T00:00:00+00:00', '2017-12-31T23:59:59.999Z'],
      ]) {
        const res = await get(`/v2/stats?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
        expect([start, end, res.body.count]).toEqual([start, end, 7]);
      }
    });
  });

  describe('pages', () => {
    it.each(INTERVALS)(
      'interval=%s: marker pages concatenate to the unpaged list, ascending and descending',
      async (interval) => {
        for (const descending of [false, true]) {
          const unpaged = await get(`/v2/stats?interval=${interval}&limit=1000&descending=${descending}`);
          expect(unpaged.body.marker).toBeUndefined();
          for (const limit of [1, 2, 3]) {
            const walked = (
              await api.pages<Body<Stats>>(`/v2/stats?interval=${interval}&descending=${descending}`, limit, 'stats')
            ).flatMap((p) => p.stats);
            expect([interval, descending, limit, walked]).toEqual([interval, descending, limit, unpaged.body.stats]);
          }
        }
      },
    );

    it('every page but the last has a marker, which is the bucket start of its last row', async () => {
      const pages = await api.pages<Body<Stats>>('/v2/stats?interval=hour', 3, 'stats');
      expect(pages.map((p) => p.count)).toEqual([3, 3, 3, 1]);
      for (const page of pages.slice(0, -1)) {
        expect(page.marker).toBe(markerOf(unix(page.stats[page.stats.length - 1].date)));
      }
      expect(pages[pages.length - 1].marker).toBeUndefined();
    });

    it('descending lists the same buckets in the reverse order', async () => {
      for (const interval of INTERVALS) {
        const asc = (await get(`/v2/stats?interval=${interval}&limit=1000`)).body.stats;
        const desc = (await get(`/v2/stats?interval=${interval}&limit=1000&descending=true`)).body.stats;
        expect(desc).toEqual([...asc].reverse());
        expect((await get(`/v2/stats?interval=${interval}&limit=1000&descending=TRUE`)).body.stats).toEqual(desc);
        expect((await get(`/v2/stats?interval=${interval}&limit=1000&descending=false`)).body.stats).toEqual(asc);
      }
    });

    it('family pages walk the rows that have the family, and a page is always full when there are more', async () => {
      // a family, a metric: the rows without any of the columns are not rows, so that they never take up a place in a page
      for (const path of [
        '/v2/stats/type',
        '/v2/stats/result',
        '/v2/stats/metric/exchanges_count',
        '/v2/stats/type/OfferCreate',
      ]) {
        for (const interval of INTERVALS) {
          const unpaged = await get(`${path}?interval=${interval}&limit=1000`);
          const pages = await api.pages<Body<Flat>>(`${path}?interval=${interval}`, 2, 'stats');
          expect([path, interval, pages.flatMap((p) => p.stats)]).toEqual([path, interval, unpaged.body.stats]);
          for (const page of pages.slice(0, -1)) expect(page.count).toBe(2);
        }
      }
    });

    it('a marker can come from another interval and still lands after its bucket', async () => {
      const m = markerOf(unix('2015-01-14T19:00:00Z'));
      const res = await get(`/v2/stats/metric/ledger_count?interval=day&limit=1000&marker=${m}`);
      expect(res.body.stats.map((s: Flat) => s.date)).toEqual([
        '2015-02-09T00:00:00Z',
        '2016-03-28T00:00:00Z',
        '2017-04-18T00:00:00Z',
        '2017-05-12T00:00:00Z',
      ]);
      const back = await get(`/v2/stats/metric/ledger_count?interval=day&limit=1000&descending=true&marker=${m}`);
      // the day the marker is in was served already, in either direction
      expect(back.body.stats.map((s: Flat) => s.date)).toEqual(['2013-10-25T00:00:00Z', '2013-06-11T00:00:00Z']);
    });

    it('answers 400 `invalid marker` for a marker that is not one of ours', async () => {
      for (const marker of [
        'day|20131025000000',
        '!!',
        markerOf('x'),
        markerOf(1, 2),
        markerOf(-1),
        Buffer.from('{}').toString('base64url'),
      ]) {
        const res = await get(`/v2/stats?marker=${encodeURIComponent(marker)}`);
        expect([marker, res.status, res.body]).toEqual([marker, 400, { result: 'error', message: 'invalid marker' }]);
      }
    });

    it('limit: 200 by default, 1000 at most; below one or not a number is the default', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const fetched = async (query: string): Promise<unknown[]> => {
        spy.mockClear();
        await get(`/v2/stats?${query}`);
        return spy.mock.calls
          .filter(([sql]) => String(sql).includes(`FROM ${Table.StatsHourly}`) && /LIMIT \{fetch/.test(String(sql)))
          .map(([, p]) => (p as { fetch: number }).fetch);
      };
      expect((await fetched(''))[0]).toBe(201);
      for (const limit of ['0', '-5', 'abc', '1.5x', '']) {
        expect([limit, (await fetched(`limit=${limit}`))[0]]).toEqual([limit, 201]);
      }
      expect((await fetched('limit=5000'))[0]).toBe(1001);
      expect((await fetched('limit=1000'))[0]).toBe(1001);
      expect((await fetched('limit=7'))[0]).toBe(8);
      expect((await fetched('limit=3.9'))[0]).toBe(4);
      spy.mockRestore();
    });

    it('unknown params are ignored, and the first value of a repeated one wins', async () => {
      const plain = await get('/v2/stats?limit=1000');
      expect((await get('/v2/stats?limit=1000&foo=bar&baz=1')).body).toEqual(plain.body);
      const repeated = await get('/v2/stats?interval=hour&interval=week&limit=1000');
      expect(repeated.body.stats).toEqual((await get('/v2/stats?interval=hour&limit=1000')).body.stats);
      const family = await get('/v2/stats?family=type&family=metric&limit=1000');
      expect(family.body.stats).toEqual((await get('/v2/stats?family=type&limit=1000')).body.stats);
    });
  });

  describe('family and metrics', () => {
    it('the family is in the path or in family=, in any case; the path wins', async () => {
      const metric = (await get('/v2/stats/metric?limit=1000')).body.stats;
      for (const path of [
        '/v2/stats?family=metric',
        '/v2/stats?family=METRIC',
        '/v2/stats/Metric',
        '/v2/stats/METRIC?family=type',
      ]) {
        expect([path, (await get(`${path}${path.includes('?') ? '&' : '?'}limit=1000`)).body.stats]).toEqual([
          path,
          metric,
        ]);
      }
    });

    it('the metric of the path is not lower-cased', async () => {
      expect((await get('/v2/stats/type/payment')).body.stats).toEqual([]);
      expect((await get('/v2/stats/type/Payment')).body.stats.length).toBeGreaterThan(0);
      expect((await get('/v2/stats/metric/Ledger_Count')).body.stats).toEqual([]);
    });

    it('a metric of the path wins over metrics=', async () => {
      const res = await get('/v2/stats/metric/ledger_count?metrics=tx_per_ledger&limit=1000');
      expect(res.body.stats).toEqual(flats(DAYS, 'metric', ['ledger_count']));
    });

    it('a metric that is not one, a metric of another family and a name that is only inherited are empty', async () => {
      for (const path of [
        '/v2/stats/metric/Payment',
        '/v2/stats/type/ledger_count',
        '/v2/stats/result/tesSUCCESSZ',
        '/v2/stats/metric/constructor',
        '/v2/stats/type/__proto__',
        '/v2/stats/metric/ledger_count:x',
      ]) {
        const res = await get(path);
        expect([path, res.status, res.body]).toEqual([path, 200, { result: 'success', count: 0, stats: [] }]);
      }
      expect((await get('/v2/stats/metric?metrics=')).body.stats).toEqual((await get('/v2/stats/metric')).body.stats);
    });

    it('metrics may name columns that are there and columns that are not', async () => {
      const res = await get('/v2/stats/metric?metrics=ledger_count,nothing,,tx_per_ledger&limit=1000');
      expect(res.body.stats).toEqual(flats(DAYS, 'metric', ['ledger_count', 'tx_per_ledger']));
    });
  });

  describe('errors', () => {
    const error = async (path: string): Promise<[number, unknown]> => {
      const res = await get(path);
      return [res.status, res.body];
    };

    it('metrics without a family is 400 `family is required`', async () => {
      expect(await error('/v2/stats?metrics=ledger_count')).toEqual([
        400,
        { result: 'error', message: 'family is required' },
      ]);
      expect(await error('/v2/stats?metrics=a,b&format=csv')).toEqual([
        400,
        { result: 'error', message: 'family is required' },
      ]);
    });

    it('an interval that is not hour, day or week is 400 `invalid interval`, not an empty list', async () => {
      for (const interval of ['month', 'year', 'minute', 'Day', 'HOUR', '1day', 'week2', 'zzz', '%20', 'null']) {
        expect([interval, await error(`/v2/stats?interval=${interval}`)]).toEqual([
          interval,
          [400, { result: 'error', message: 'invalid interval' }],
        ]);
      }
      expect((await get('/v2/stats?interval=')).body.stats).toEqual((await get('/v2/stats?interval=day')).body.stats);
    });

    it('the checks come in the order of the original', async () => {
      // 1. the metrics need a family
      expect(await error('/v2/stats?metrics=x&start=bad&end=bad&interval=bad')).toEqual([
        400,
        { result: 'error', message: 'family is required' },
      ]);
      // 2. the start, 3. the end
      expect(await error('/v2/stats/bad?start=bad&end=bad&interval=bad')).toEqual([
        400,
        { result: 'error', message: 'invalid start date format' },
      ]);
      expect(await error('/v2/stats/bad?end=bad&interval=bad')).toEqual([
        400,
        { result: 'error', message: 'invalid end date format' },
      ]);
      // 4. the family, 5. the interval
      expect(await error('/v2/stats/bad?interval=bad')).toEqual([
        400,
        { result: 'error', message: 'invalid family, use: type, result, metric' },
      ]);
      expect(await error('/v2/stats/metric?interval=bad&limit=1')).toEqual([
        400,
        { result: 'error', message: 'invalid interval' },
      ]);
      // a marker is checked when the list is read
      expect(await error('/v2/stats?interval=bad&marker=!!')).toEqual([
        400,
        { result: 'error', message: 'invalid interval' },
      ]);
    });

    it('an invalid family is 400 in the path and in family=', async () => {
      for (const path of [
        '/v2/stats/metrics',
        '/v2/stats/types',
        '/v2/stats/?family=x',
        '/v2/stats?family=x',
        '/v2/stats/x/y',
      ]) {
        expect([path, await error(path)]).toEqual([
          path,
          [400, { result: 'error', message: 'invalid family, use: type, result, metric' }],
        ]);
      }
    });

    it('the error body is the one of every other route, with no-store', async () => {
      const res = await get('/v2/stats?start=2015x');
      expect(Object.keys(res.body)).toEqual(['result', 'message']);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('needs an API key like every /v2 route', async () => {
      const res = await h.http().get('/v2/stats');
      expect(res.status).toBe(401);
    });

    it('is 500 `unable to retrieve stats` when the database fails, and says nothing of the cause', async () => {
      const spy = jest
        .spyOn(h.ch, 'query')
        .mockRejectedValue(new Error('DB::Exception: Cannot connect to the secret host'));
      const res = await get('/v2/stats');
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ result: 'error', message: 'unable to retrieve stats' });
      expect(JSON.stringify(res.body)).not.toMatch(/secret/);
    });
  });

  describe('format=csv', () => {
    const lines = (text: string): string[] => text.split('\n');

    it('a list without a family is flattened: date, then type., result. and metric. columns', async () => {
      const res = await get('/v2/stats?format=csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/csv/);
      expect(res.headers['content-disposition']).toBe('attachment; filename=stats.csv');
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 7);
      const header = rows[0].split(',').map((c) => c.replace(/"/g, ''));
      expect(header[0]).toBe('date');
      expect(header).toContain('type.Payment');
      expect(header).toContain('result.tesSUCCESS');
      expect(header).toContain('metric.ledger_count');
      expect(header).toContain('metric.tx_per_ledger');
      // the first row is the first day, with its own date and its ledger count in the column of the header
      const first = rows[1].split(',').map((c) => c.replace(/"/g, ''));
      expect(first[0]).toBe('2013-06-11T00:00:00Z');
      expect(first[header.indexOf('metric.ledger_count')]).toBe('1');
    });

    it('a family is a flat list: its columns and the date last, in a file named after the family', async () => {
      const res = await get('/v2/stats/metric?format=csv');
      expect(res.headers['content-disposition']).toBe('attachment; filename=stats metric.csv');
      const rows = lines(res.text);
      expect(rows).toHaveLength(1 + 7);
      // one column per name found in any row, in the order of first appearance (a row has no key for what is zero)
      const header = [...new Set(flats(DAYS, 'metric').flatMap((row) => Object.keys(row)))];
      expect(header).toContain('exchanges_count');
      expect(rows[0].split(',').map((c) => c.replace(/"/g, ''))).toEqual(header);
      expect(header[0]).toBe('accounts_created');
    });

    it('names the file after the family and the metrics, with their family, as the original did', async () => {
      const name = async (path: string): Promise<string | undefined> =>
        (await get(path)).headers['content-disposition'];
      expect(await name('/v2/stats/metric/ledger_count?format=csv')).toBe(
        'attachment; filename=stats metric-metric:ledger_count.csv',
      );
      expect(await name('/v2/stats/metric?format=csv&metrics=ledger_count,tx_per_ledger')).toBe(
        'attachment; filename=stats metric-metric:ledger_count-metric:tx_per_ledger.csv',
      );
      expect(await name('/v2/stats?format=csv&family=Type&metrics=Payment')).toBe(
        'attachment; filename=stats type-type:Payment.csv',
      );
      expect(await name('/v2/stats/result?format=csv')).toBe('attachment; filename=stats result.csv');
    });

    it('a metric file has the metric and the date', async () => {
      const res = await get('/v2/stats/metric/ledger_count?format=csv&interval=week');
      expect(lines(res.text)).toEqual([
        '"ledger_count","date"',
        ...WEEKS.map((w) => `"${w.ledgers}","${iso(w.start)}"`),
      ]);
    });

    it('format is case-insensitive, and anything but csv is JSON', async () => {
      expect((await get('/v2/stats?format=CSV&limit=1')).headers['content-type']).toMatch(/^text\/csv/);
      for (const format of ['json', 'xml', '']) {
        const res = await get(`/v2/stats?format=${format}&limit=1`);
        expect([format, res.headers['content-type']]).toEqual([format, expect.stringMatching(/application\/json/)]);
      }
    });

    it('has the Link header when there is a next page', async () => {
      const csv = await get('/v2/stats?format=csv&limit=3');
      const json = await get('/v2/stats?limit=3');
      expect(csv.headers.link).toBe(
        `<${new URL(csv.request.url).origin}/v2/stats?format=csv&limit=3&marker=${json.body.marker}>; rel="next"`,
      );
      expect(lines(csv.text)).toHaveLength(1 + 3);
      expect((await get('/v2/stats?format=csv&limit=1000')).headers.link).toBeUndefined();
    });

    it('an empty range is an empty CSV; an error is still JSON', async () => {
      const empty = await get('/v2/stats?format=csv&start=2030-01-01');
      expect(empty.status).toBe(200);
      expect(empty.headers['content-type']).toMatch(/^text\/csv/);
      expect(empty.text).toBe('');
      const bad = await get('/v2/stats/x?format=csv');
      expect(bad.status).toBe(400);
      expect(bad.body).toEqual({ result: 'error', message: 'invalid family, use: type, result, metric' });
    });
  });

  describe('the query', () => {
    const statsSql = (spy: jest.SpyInstance): [string, Record<string, unknown>][] =>
      spy.mock.calls
        .filter(([q]) => new RegExp(`FROM ${Table.StatsHourly}\\b`).test(String(q)))
        .map(([q, p]) => [String(q), p as Record<string, unknown>]);
    const planOf = async (sql: string, params: Record<string, unknown>, kind: string): Promise<string> =>
      (await h.ch.query<{ explain: string }>(`EXPLAIN ${kind} ${sql}`, params)).map((r) => r.explain).join('\n');
    /** The query that reads the hours of a window: the one with the fetch limit. */
    const windowQuery = (spy: jest.SpyInstance): [string, Record<string, unknown>] => {
      const found = statsSql(spy).find(([q]) => /\{fetch:UInt32\}/.test(q));
      if (!found) throw new Error('no window query was run');
      return found;
    };

    it('dedupes the hours by the newest version without FINAL, filters on ledger_count after it, and binds every value', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get('/v2/stats?interval=day&limit=5&start=2015-01-01&end=2016-01-01');
      const [sql, params] = windowQuery(spy);
      spy.mockRestore();
      expect(sql).not.toMatch(/\bFINAL\b/);
      expect(sql).toMatch(/ORDER BY hour ASC, version DESC\s+LIMIT 1 BY hour/);
      expect(sql).toMatch(/hour >= toDateTime\(\{lo:UInt32\}, 'UTC'\)/);
      expect(sql).toMatch(/hour < toDateTime\(\{hi:UInt32\}, 'UTC'\)/);
      // the zero rows of vanished hours are dropped AFTER the newest version of each hour was taken
      expect(sql.indexOf('LIMIT 1 BY hour')).toBeLessThan(sql.indexOf('ledger_count > 0'));
      expect(Object.keys(params).sort()).toEqual(['fetch', 'hi', 'lo']);
      expect(params.fetch).toBe(6);
      // no date of the request is in the text either
      expect(sql).not.toMatch(/2015|2016/);
    });

    it('never puts a request value in the SQL text', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get(`/v2/stats/type/Payment'%20OR%201=1--?marker=${markerOf(1)}&start=2014-01-01&limit=7`);
      await get(`/v2/stats/type?metrics=${encodeURIComponent("x') OR 1=1 --")},Payment`);
      const all = statsSql(spy);
      spy.mockRestore();
      expect(all.length).toBeGreaterThan(0);
      for (const [text] of all) {
        expect(text).not.toMatch(/OR 1=1|OR%201/);
        expect(text).not.toMatch(/Payment/);
      }
      // the names go in as a bound array
      expect(all.some(([, params]) => JSON.stringify(params).includes("x') OR 1=1 --"))).toBe(true);
    });

    it('reads the hours in the order of the primary key, bounded by the range, and sorts no more than the versions of an hour', async () => {
      for (const variant of [
        'interval=hour&limit=5',
        'interval=day&limit=3&start=2015-01-14&end=2015-02-10',
        'interval=week&limit=2&descending=true',
        'interval=day&limit=2&start=2017-01-01',
        `interval=day&limit=2&marker=${markerOf(unix('2015-01-14T00:00:00Z'))}`,
      ]) {
        const spy = jest.spyOn(h.ch, 'query');
        await get(`/v2/stats?${variant}`);
        const [sql, params] = windowQuery(spy);
        spy.mockRestore();
        const indexes = await planOf(sql, params, 'indexes = 1');
        // a range of the primary key, found by binary search, read in its order
        expect([variant, indexes]).toEqual([
          variant,
          expect.stringMatching(
            /Read type: InOrder[\s\S]*PrimaryKey\s+Keys:\s+hour\s+Condition: and\(\(hour in \(-Inf, \d+\]\), \(hour in \[\d+, \+Inf\)\)\)/,
          ),
        ]);
        const pipeline = await planOf(sql, params, 'PIPELINE');
        // the hours come sorted from the table; only the rows of one hour are put in order by version, and the newest is taken
        expect([variant, pipeline]).toEqual([
          variant,
          expect.stringMatching(/FinishSortingTransform[\s\S]*ReadFromMergeTree/),
        ]);
        expect(pipeline).toMatch(/LimitBySortedStreamTransform/);
        expect(pipeline).not.toMatch(/Final/i);
      }
    });

    it('asks the table for as few windows as the data needs: a gap of years costs a handful of queries, not one per bucket', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      await get('/v2/stats?interval=hour&limit=1000');
      await get('/v2/stats?interval=day&limit=1000&descending=true');
      await get('/v2/stats?interval=week&limit=1');
      const queries = statsSql(spy).length;
      spy.mockRestore();
      // a bounds query and a few windows each; the data spans four years and 10 hours
      expect(queries).toBeLessThanOrEqual(24);
    });

    it('does not touch the database when no metric of the request can exist', async () => {
      const spy = jest.spyOn(h.ch, 'query');
      const res = await get('/v2/stats/metric/not_a_metric');
      expect(res.body.stats).toEqual([]);
      expect(statsSql(spy).filter(([q]) => /\{fetch:UInt32\}/.test(q))).toHaveLength(0);
      spy.mockRestore();
    });
  });
});

// ===================================================================================================================
// rows written twice, newer versions, zero rows
// ===================================================================================================================

describe('GET /v2/stats when rows were written twice', () => {
  // `stats_hourly` is a ReplacingMergeTree and the reads never use FINAL, so until a merge an hour can be there twice (a
  // recompute writes a new version of every hour it touches). Merges are stopped and a SECOND insert (a duplicate inside
  // one insert would be collapsed on the way in) puts every row there twice.
  let h: Harness;
  let api: ApiClient;
  const get = (path: string) => api.get(path);

  const count = async (): Promise<number> =>
    Number((await h.ch.query<{ n: string }>(`SELECT count() AS n FROM ${Table.StatsHourly}`))[0].n);
  const stored = (hour: string): Promise<Record<string, unknown>[]> =>
    h.ch.query(
      `SELECT toUnixTimestamp(hour) AS hour, ledger_count, transaction_count, version FROM ${Table.StatsHourly} WHERE hour = toDateTime({hour:UInt32}, 'UTC') ORDER BY version`,
      { hour: unix(hour) },
    );

  beforeAll(async () => {
    h = await startHarness({ seed: 'ripple-mock', env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('puts every hour there twice, and lists each bucket once, whatever the interval', async () => {
    const before = Object.fromEntries(
      await Promise.all(
        INTERVALS.map(async (i) => [i, (await get(`/v2/stats?interval=${i}&limit=1000`)).body.stats] as const),
      ),
    );
    expect(await count()).toBe(10);
    await h.ch.command(`SYSTEM STOP MERGES ${h.database}.${Table.StatsHourly}`);
    await h.ch.command(
      `INSERT INTO ${Table.StatsHourly} SELECT * FROM ${Table.StatsHourly}`,
      {},
      { settings: { insert_deduplicate: 0 } },
    );
    expect(await count()).toBe(20);

    for (const interval of INTERVALS) {
      const res = await get(`/v2/stats?interval=${interval}&limit=1000`);
      expect([interval, res.body.stats]).toEqual([interval, before[interval]]);
      expect([interval, res.body.stats]).toEqual([interval, BY_INTERVAL[interval].map(nested)]);
      const family = await get(`/v2/stats/metric/ledger_count?interval=${interval}&limit=1000`);
      expect(family.body.stats).toEqual(flats(BY_INTERVAL[interval], 'metric', ['ledger_count']));
    }
  });

  it('walks the pages of a list whose hours are there twice without repeating or skipping a bucket', async () => {
    expect(await count()).toBe(20);
    for (const interval of INTERVALS) {
      for (const limit of [1, 2, 3]) {
        const walked = (await api.pages<Body<Stats>>(`/v2/stats?interval=${interval}`, limit, 'stats')).flatMap(
          (p) => p.stats,
        );
        expect([interval, limit, walked]).toEqual([interval, limit, BY_INTERVAL[interval].map(nested)]);
      }
    }
  });

  it('serves the newest version of an hour: a recompute that wrote something else wins', async () => {
    expect(await count()).toBe(20);
    const hour = iso(HOURS[2].start);
    const newer: StatsHourlyRow = {
      hour: HOURS[2].start,
      transaction_count: 1234,
      payments_count: 0,
      exchanges_count: 0,
      accounts_created: 0,
      ledger_count: 5,
      first_close_time: HOURS[2].start,
      last_close_time: HOURS[2].start + 600,
      type_counts: { Payment: 1234 },
      result_counts: { tesSUCCESS: 1234 },
      version: Date.now() + 60_000,
    };
    await h.ch.insert(Table.StatsHourly, [newer]);
    expect((await stored(hour)).length).toBe(3);

    const res = await get(`/v2/stats?interval=hour&limit=1000&start=${hour}&end=${hour}`);
    expect(res.body.stats).toEqual([
      {
        date: hour,
        type: { Payment: 1234 },
        result: { tesSUCCESS: 1234 },
        metric: { ledger_count: 5, ledger_interval: 120, transaction_count: 1234, tx_per_ledger: 246.8 },
      },
    ]);
    // the day it is in adds up the newest version of each of its hours
    const day = (
      await get(
        `/v2/stats/metric/transaction_count?interval=day&limit=1000&start=${hour.slice(0, 10)}&end=${hour.slice(0, 10)}`,
      )
    ).body.stats;
    const others = HOURS.filter(
      (b) =>
        b !== HOURS[2] &&
        b.start >= bucketStart('day', HOURS[2].start) &&
        b.start < bucketStart('day', HOURS[2].start) + DAY,
    );
    expect(day[0].transaction_count).toBe(1234 + others.reduce((n, b) => n + b.transactions, 0));
  });

  it('skips an hour whose newest version is a zero row, and a bucket made only of them', async () => {
    const hour = HOURS[5];
    const day = DAYS.find((d) => d.start === bucketStart('day', hour.start)) as Bucket;
    const inDay = HOURS.filter((b) => b.start >= day.start && b.start < day.start + DAY);
    await h.ch.insert(Table.StatsHourly, [
      {
        hour: hour.start,
        transaction_count: 0,
        payments_count: 0,
        exchanges_count: 0,
        accounts_created: 0,
        ledger_count: 0,
        first_close_time: hour.start,
        last_close_time: hour.start,
        type_counts: {},
        result_counts: {},
        version: Date.now() + 120_000,
      },
    ]);
    const hours = (await get('/v2/stats/metric/ledger_count?interval=hour&limit=1000')).body.stats.map(
      (r: Flat) => r.date,
    );
    expect(hours).not.toContain(iso(hour.start));
    expect(hours.length).toBe(9);
    const days = (await get('/v2/stats/metric/ledger_count?interval=day&limit=1000')).body.stats as Flat[];
    if (inDay.length === 1) {
      expect(days.map((r) => r.date)).not.toContain(iso(day.start));
    } else {
      expect(days.find((r) => r.date === iso(day.start))?.ledger_count).toBe(day.ledgers - hour.ledgers);
    }
    // and the pages still walk the rest without a hole
    const walked = (await api.pages<Body<Flat>>('/v2/stats/metric/ledger_count?interval=hour', 2, 'stats')).flatMap(
      (p) => p.stats,
    );
    expect(walked.map((r) => r.date)).toEqual(hours);
  });
});

// ===================================================================================================================
// Xahau
// ===================================================================================================================

describe('GET /v2/stats on Xahau', () => {
  const SEED: SeedName = 'xahau-recorded';
  const LEDGERS = fixtureSource(SEED).list();
  let h: Harness;
  let api: ApiClient;

  beforeAll(async () => {
    h = await startHarness({ seed: SEED, env: NO_RATE_LIMIT });
    api = await h.api();
  });
  afterAll(async () => {
    await h?.close();
  });

  it.each(INTERVALS)('interval=%s is what the oracle adds up from the recorded ledgers', async (interval) => {
    const buckets = oracle(LEDGERS, interval, 'xahau');
    expect(buckets.length).toBeGreaterThan(0);
    const res = await api.ok<Body<Stats>>(`/v2/stats?interval=${interval}&limit=1000&start=2020-01-01`, 'stats');
    expect(res.body.stats).toEqual(buckets.map(nested));
    const types = await api.ok<Body<Flat>>(`/v2/stats/type?interval=${interval}&limit=1000&start=2020-01-01`, 'stats');
    expect(types.body.stats).toEqual(flats(buckets, 'type'));
  });

  it('counts the ledgers and transactions of the recorded ledgers', async () => {
    const res = await api.ok<Body<Flat>>('/v2/stats/metric?interval=day&limit=1000&start=2020-01-01', 'stats');
    const rows: Flat[] = res.body.stats;
    expect(rows.reduce((n, r) => n + (r.ledger_count as number), 0)).toBe(LEDGERS.length);
    expect(rows.reduce((n, r) => n + ((r.transaction_count as number) ?? 0), 0)).toBe(
      LEDGERS.reduce((n, l) => n + l.transactions.length, 0),
    );
  });
});
