import { bucketStart, ceilBucket, dayText, MAX_DAY_MS, nextBucket } from './volume-buckets';

const ms = (text: string): number => Date.parse(text);

describe('bucketStart', () => {
  it('day: the UTC midnight', () => {
    expect(bucketStart(ms('2026-03-03T17:45:12.345Z'), 'day')).toBe(ms('2026-03-03T00:00:00Z'));
    expect(bucketStart(ms('2026-03-03T00:00:00Z'), 'day')).toBe(ms('2026-03-03T00:00:00Z'));
    expect(bucketStart(ms('2026-03-03T23:59:59.999Z'), 'day')).toBe(ms('2026-03-03T00:00:00Z'));
  });

  it('week: the Monday before, at midnight UTC (ISO weeks)', () => {
    expect(bucketStart(ms('2026-03-04T10:00:00Z'), 'week')).toBe(ms('2026-03-02T00:00:00Z')); // a Wednesday
    expect(bucketStart(ms('2026-03-02T00:00:00Z'), 'week')).toBe(ms('2026-03-02T00:00:00Z')); // a Monday
    expect(bucketStart(ms('2026-03-08T23:59:59Z'), 'week')).toBe(ms('2026-03-02T00:00:00Z')); // a Sunday
    expect(bucketStart(ms('2015-01-14T18:00:00Z'), 'week')).toBe(ms('2015-01-12T00:00:00Z'));
    // across a year
    expect(bucketStart(ms('2027-01-01T00:00:00Z'), 'week')).toBe(ms('2026-12-28T00:00:00Z'));
  });

  it('month: the first of the month, at midnight UTC', () => {
    expect(bucketStart(ms('2026-03-31T23:59:59Z'), 'month')).toBe(ms('2026-03-01T00:00:00Z'));
    expect(bucketStart(ms('2024-02-29T12:00:00Z'), 'month')).toBe(ms('2024-02-01T00:00:00Z'));
    expect(bucketStart(ms('2026-12-31T00:00:00Z'), 'month')).toBe(ms('2026-12-01T00:00:00Z'));
  });

  it('works before 1970 too', () => {
    expect(bucketStart(ms('1969-12-31T12:00:00Z'), 'day')).toBe(ms('1969-12-31T00:00:00Z'));
    expect(bucketStart(0, 'week')).toBe(ms('1969-12-29T00:00:00Z'));
    expect(bucketStart(0, 'month')).toBe(0);
  });
});

describe('nextBucket', () => {
  it('is the start of the bucket after the one that holds the time', () => {
    expect(nextBucket(ms('2026-03-03T00:00:00Z'), 'day')).toBe(ms('2026-03-04T00:00:00Z'));
    expect(nextBucket(ms('2026-03-03T10:00:00Z'), 'day')).toBe(ms('2026-03-04T00:00:00Z'));
    expect(nextBucket(ms('2026-03-04T10:00:00Z'), 'week')).toBe(ms('2026-03-09T00:00:00Z'));
    expect(nextBucket(ms('2026-03-02T00:00:00Z'), 'week')).toBe(ms('2026-03-09T00:00:00Z'));
    expect(nextBucket(ms('2026-03-15T00:00:00Z'), 'month')).toBe(ms('2026-04-01T00:00:00Z'));
    expect(nextBucket(ms('2026-12-31T23:59:59Z'), 'month')).toBe(ms('2027-01-01T00:00:00Z'));
    expect(nextBucket(ms('2024-02-10T00:00:00Z'), 'month')).toBe(ms('2024-03-01T00:00:00Z'));
  });
});

describe('ceilBucket', () => {
  it('is the time itself on a boundary, else the next boundary', () => {
    expect(ceilBucket(ms('2026-03-03T00:00:00Z'), 'day')).toBe(ms('2026-03-03T00:00:00Z'));
    expect(ceilBucket(ms('2026-03-03T00:00:01Z'), 'day')).toBe(ms('2026-03-04T00:00:00Z'));
    expect(ceilBucket(ms('2026-03-03T00:00:00.001Z'), 'day')).toBe(ms('2026-03-04T00:00:00Z'));
    expect(ceilBucket(ms('2026-03-02T00:00:00Z'), 'week')).toBe(ms('2026-03-02T00:00:00Z'));
    expect(ceilBucket(ms('2026-03-03T00:00:00Z'), 'week')).toBe(ms('2026-03-09T00:00:00Z'));
    expect(ceilBucket(ms('2026-03-01T00:00:00Z'), 'month')).toBe(ms('2026-03-01T00:00:00Z'));
    expect(ceilBucket(ms('2026-03-01T00:00:01Z'), 'month')).toBe(ms('2026-04-01T00:00:00Z'));
    expect(ceilBucket(0, 'week')).toBe(ms('1970-01-05T00:00:00Z'));
  });
});

describe('dayText and MAX_DAY_MS', () => {
  it('writes a day as the ClickHouse Date takes it', () => {
    expect(dayText(ms('2026-03-03T17:00:00Z'))).toBe('2026-03-03');
    expect(dayText(0)).toBe('1970-01-01');
  });

  it('the last day of a ClickHouse Date is 2149-06-06', () => {
    expect(dayText(MAX_DAY_MS)).toBe('2149-06-06');
  });
});
