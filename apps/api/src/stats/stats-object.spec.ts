import { RippleHttpError } from '../common/errors';
import {
  bucketAlign,
  checkFamily,
  flatStats,
  nestedStats,
  statsFilename,
  statsSelection,
  StoredStats,
} from './stats-object';

const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const unix = (text: string): number => Date.parse(text) / 1000;

/** The day 2015-01-14 of the mock ledgers, roughly: 41 ledgers, closing between 17:29 and 19:10. */
const DAY_STATS: StoredStats = {
  bucket: unix('2015-01-14T00:00:00Z'),
  transaction_count: 679,
  payments_count: 30,
  exchanges_count: 0,
  accounts_created: 2,
  ledger_count: 41,
  last_close: unix('2015-01-14T19:10:10Z'),
  types: { Payment: '30', OfferCreate: 600, AccountSet: 49, TrustSet: 0 },
  results: { tesSUCCESS: 600, tecUNFUNDED_OFFER: 79, tecNO_DST: '0' },
};

describe('statsSelection', () => {
  const sel = (family: string | undefined, metric: string | undefined, query: Record<string, unknown> = {}) =>
    statsSelection({ family, metric }, query);

  it('has no family and no metrics for a bare request', () => {
    expect(sel(undefined, undefined)).toEqual({ family: '' });
  });

  it('takes the family from the path, else from the query, lower-cased', () => {
    expect(sel('metric', undefined).family).toBe('metric');
    expect(sel(undefined, undefined, { family: 'Type' }).family).toBe('type');
    expect(sel('RESULT', undefined, { family: 'type' }).family).toBe('result');
    expect(sel(undefined, undefined, { family: ['metric', 'type'] }).family).toBe('metric');
  });

  it('makes the metric of the path the one metric, not lower-cased, and ignores the metrics of the query', () => {
    expect(sel('metric', 'ledger_count', { metrics: 'x,y' })).toEqual({ family: 'metric', names: ['ledger_count'] });
    expect(sel('type', 'OfferCreate')).toEqual({ family: 'type', names: ['OfferCreate'] });
  });

  it('splits the metrics of the query at commas, as the original did', () => {
    expect(sel('metric', undefined, { metrics: 'ledger_count,tx_per_ledger' })).toEqual({
      family: 'metric',
      names: ['ledger_count', 'tx_per_ledger'],
    });
    expect(sel(undefined, undefined, { family: 'type', metrics: 'Payment' })).toEqual({
      family: 'type',
      names: ['Payment'],
    });
    expect(sel('metric', undefined, { metrics: ['a', 'b'] }).names).toEqual(['a']);
  });

  it('treats an empty metrics parameter as none', () => {
    expect(sel('metric', undefined, { metrics: '' })).toEqual({ family: 'metric' });
    expect(sel(undefined, undefined, { metrics: '' })).toEqual({ family: '' });
  });

  it('answers 400 `family is required` for metrics without a family', () => {
    for (const run of [
      () => sel(undefined, undefined, { metrics: 'ledger_count' }),
      () => sel('', undefined, { metrics: 'a' }),
    ]) {
      try {
        run();
        throw new Error('did not throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RippleHttpError);
        expect((err as RippleHttpError).getStatus()).toBe(400);
        expect((err as RippleHttpError).message).toBe('family is required');
      }
    }
  });
});

describe('checkFamily', () => {
  it('accepts no family and the three families', () => {
    expect(checkFamily('')).toBeUndefined();
    expect(checkFamily('type')).toBe('type');
    expect(checkFamily('result')).toBe('result');
    expect(checkFamily('metric')).toBe('metric');
  });

  it('answers 400 with the families listed for any other', () => {
    expect(() => checkFamily('metricz')).toThrow('invalid family, use: type, result, metric');
    expect(() => checkFamily('metrics')).toThrow(RippleHttpError);
  });
});

describe('statsFilename', () => {
  it('is `stats`, then the family, then the metrics with their family, as the original named the file', () => {
    expect(statsFilename({ family: '' })).toBe('stats');
    expect(statsFilename({ family: 'metric' })).toBe('stats metric');
    expect(statsFilename({ family: 'metric', names: ['ledger_count'] })).toBe('stats metric-metric:ledger_count');
    expect(statsFilename({ family: 'type', names: ['Payment', 'OfferCreate'] })).toBe(
      'stats type-type:Payment-type:OfferCreate',
    );
  });
});

describe('bucketAlign', () => {
  it('floors an hour and a day to their start, and a week to its Monday', () => {
    const t = unix('2015-01-14T19:10:10Z'); // a Wednesday
    expect(bucketAlign.floor('hour', t)).toBe(unix('2015-01-14T19:00:00Z'));
    expect(bucketAlign.floor('day', t)).toBe(unix('2015-01-14T00:00:00Z'));
    expect(bucketAlign.floor('week', t)).toBe(unix('2015-01-12T00:00:00Z'));
    expect(new Date(bucketAlign.floor('week', t) * 1000).getUTCDay()).toBe(1);
  });

  it('ceils to the first bucket start at or after, and leaves a start alone', () => {
    const t = unix('2015-01-14T19:10:10Z');
    expect(bucketAlign.ceil('hour', t)).toBe(unix('2015-01-14T20:00:00Z'));
    expect(bucketAlign.ceil('day', t)).toBe(unix('2015-01-15T00:00:00Z'));
    expect(bucketAlign.ceil('week', t)).toBe(unix('2015-01-19T00:00:00Z'));
    for (const interval of ['hour', 'day', 'week'] as const) {
      const start = bucketAlign.floor(interval, t);
      expect(bucketAlign.ceil(interval, start)).toBe(start);
      expect(bucketAlign.size(interval)).toBe({ hour: HOUR, day: DAY, week: WEEK }[interval]);
    }
  });

  it('agrees with the calendar on the Mondays around the epoch, a leap day and the far future', () => {
    for (const monday of ['1970-01-05', '2013-01-07', '2016-02-29', '2100-03-01', '2105-12-28']) {
      const t = unix(`${monday}T00:00:00Z`);
      expect([monday, new Date(t * 1000).getUTCDay()]).toEqual([monday, 1]); // it is a Monday
      for (const inside of [0, 1, DAY, 3 * DAY + 5, WEEK - 1]) {
        expect([monday, inside, bucketAlign.floor('week', t + inside)]).toEqual([monday, inside, t]);
      }
      expect(bucketAlign.floor('week', t + WEEK)).toBe(t + WEEK);
      expect(bucketAlign.floor('week', t - 1)).toBe(t - WEEK);
    }
    // 1970-01-01 is a Thursday: the week it belongs to began on Monday 1969-12-29
    expect(bucketAlign.floor('week', 0)).toBe(unix('1969-12-29T00:00:00Z'));
  });
});

describe('nestedStats', () => {
  it('is {date, type, result, metric}, in that order, with the keys of every family sorted', () => {
    const row = nestedStats(DAY_STATS);
    expect(Object.keys(row)).toEqual(['date', 'type', 'result', 'metric']);
    expect(Object.keys(row.type)).toEqual(['AccountSet', 'OfferCreate', 'Payment']);
    expect(Object.keys(row.result)).toEqual(['tecUNFUNDED_OFFER', 'tesSUCCESS']);
    expect(Object.keys(row.metric)).toEqual([
      'accounts_created',
      'ledger_count',
      'ledger_interval',
      'payments_count',
      'transaction_count',
      'tx_per_ledger',
    ]);
  });

  it('serves numbers, the date as `YYYY-MM-DDTHH:mm:ssZ`, and omits what is zero', () => {
    expect(nestedStats(DAY_STATS)).toEqual({
      date: '2015-01-14T00:00:00Z',
      type: { AccountSet: 49, OfferCreate: 600, Payment: 30 },
      result: { tecUNFUNDED_OFFER: 79, tesSUCCESS: 600 },
      metric: {
        accounts_created: 2,
        ledger_count: 41,
        ledger_interval: 1683.2,
        payments_count: 30,
        transaction_count: 679,
        tx_per_ledger: 16.561,
      },
    });
    // exchanges_count is 0: not served
    expect(nestedStats(DAY_STATS).metric).not.toHaveProperty('exchanges_count');
  });

  it('works out tx_per_ledger and ledger_interval as the aggregation stored them: five significant digits', () => {
    // 1 / 3 = 0.33333..., (10 * 60 + 1) / 3 = 200.333...
    const m = nestedStats({
      ...DAY_STATS,
      transaction_count: 1,
      ledger_count: 3,
      bucket: 0,
      last_close: 601,
    }).metric;
    expect(m.tx_per_ledger).toBe(0.33333);
    expect(m.ledger_interval).toBe(200.33);
    expect(typeof m.tx_per_ledger).toBe('number');
  });

  it('measures the ledger interval from the start of the bucket to the last close', () => {
    const hour = nestedStats({
      ...DAY_STATS,
      bucket: unix('2015-01-14T19:00:00Z'),
      ledger_count: 4,
      last_close: unix('2015-01-14T19:10:10Z'),
    });
    expect(hour.metric.ledger_interval).toBe(152.5); // 610 s / 4 ledgers
  });

  it('omits tx_per_ledger and ledger_interval when they are zero, and leaves empty families empty', () => {
    const empty = nestedStats({
      bucket: unix('2015-01-14T19:00:00Z'),
      transaction_count: 0,
      payments_count: 0,
      exchanges_count: 0,
      accounts_created: 0,
      ledger_count: 2,
      last_close: unix('2015-01-14T19:00:00Z'),
      types: {},
      results: {},
    });
    expect(empty).toEqual({ date: '2015-01-14T19:00:00Z', type: {}, result: {}, metric: { ledger_count: 2 } });
  });

  it('takes counts that come as text', () => {
    const row = nestedStats({
      ...DAY_STATS,
      transaction_count: '679',
      ledger_count: '41',
      bucket: String(DAY_STATS.bucket) as never,
    });
    expect(row.metric.transaction_count).toBe(679);
    expect(row.date).toBe('2015-01-14T00:00:00Z');
  });

  it('does not change what it is given', () => {
    const input = JSON.parse(JSON.stringify(DAY_STATS)) as StoredStats;
    Object.freeze(input.types);
    Object.freeze(input.results);
    Object.freeze(input);
    expect(() => nestedStats(input)).not.toThrow();
  });
});

describe('flatStats', () => {
  it('has the sorted keys of the family, then the date last, as the original row had them', () => {
    const metric = flatStats(DAY_STATS, 'metric') as Record<string, unknown>;
    expect(Object.keys(metric)).toEqual([
      'accounts_created',
      'ledger_count',
      'ledger_interval',
      'payments_count',
      'transaction_count',
      'tx_per_ledger',
      'date',
    ]);
    expect(Object.keys(flatStats(DAY_STATS, 'type') as object)).toEqual([
      'AccountSet',
      'OfferCreate',
      'Payment',
      'date',
    ]);
    expect(Object.keys(flatStats(DAY_STATS, 'result') as object)).toEqual(['tecUNFUNDED_OFFER', 'tesSUCCESS', 'date']);
  });

  it('serves only the metrics asked for that are not zero, in sorted order whatever the order asked', () => {
    expect(flatStats(DAY_STATS, 'metric', ['tx_per_ledger', 'ledger_count'])).toEqual({
      ledger_count: 41,
      tx_per_ledger: 16.561,
      date: '2015-01-14T00:00:00Z',
    });
    expect(Object.keys(flatStats(DAY_STATS, 'metric', ['tx_per_ledger', 'ledger_count']) as object)).toEqual([
      'ledger_count',
      'tx_per_ledger',
      'date',
    ]);
    expect(flatStats(DAY_STATS, 'type', ['Payment', 'OfferCreate', 'Payment'])).toEqual({
      OfferCreate: 600,
      Payment: 30,
      date: '2015-01-14T00:00:00Z',
    });
  });

  it('is nothing when none of the columns asked for is there, as a row of the original without the column was not returned', () => {
    expect(flatStats(DAY_STATS, 'metric', ['ledger_countz'])).toBeUndefined();
    expect(flatStats(DAY_STATS, 'metric', ['exchanges_count'])).toBeUndefined();
    expect(flatStats(DAY_STATS, 'type', ['TrustSet'])).toBeUndefined();
    expect(flatStats({ ...DAY_STATS, types: {} }, 'type')).toBeUndefined();
    expect(flatStats({ ...DAY_STATS, results: {} }, 'result')).toBeUndefined();
  });

  it('does not read a metric of another family or a name that is only inherited', () => {
    expect(flatStats(DAY_STATS, 'type', ['constructor', '__proto__', 'toString'])).toBeUndefined();
    expect(flatStats(DAY_STATS, 'metric', ['constructor', 'hasOwnProperty'])).toBeUndefined();
  });
});
