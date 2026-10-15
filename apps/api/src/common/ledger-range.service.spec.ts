import type { ClickHouseService } from '@gatehub/data-api-shared';
import {
  LedgerRangeResolver,
  LruCache,
  RANGE_CACHE_MAX_ENTRIES,
  RANGE_CACHE_MIN_AGE_MS,
  RANGE_CACHE_TTL_MS,
} from './ledger-range.service';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

interface Fake {
  ch: ClickHouseService;
  query: jest.Mock;
}

/**
 * A ClickHouse whose `ledgers` table is `ledgers` (ledger_index -> close time in unix seconds), answering the four
 * lookups of the resolver the way the SQL defines them.
 */
function chWith(ledgers: [number, number][]): Fake {
  const query = jest.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    const secs = params.secs as number | undefined;
    let rows = [...ledgers].sort((a, b) => a[0] - b[0]);
    if (sql.includes('close_time >=')) rows = rows.filter(([, close]) => close >= (secs as number));
    else if (sql.includes('close_time <')) rows = rows.filter(([, close]) => close < (secs as number));
    if (sql.includes('DESC')) rows.reverse();
    return rows.slice(0, 1).map(([ledger_index]) => ({ ledger_index }));
  });
  return { ch: { query } as unknown as ClickHouseService, query };
}

const at = (iso: string) => new Date(iso);
const secs = (iso: string) => Date.parse(iso) / 1000;

/** How many lookups of each kind reached ClickHouse. */
const asked = (query: jest.Mock, kind: 'from' | 'before') =>
  query.mock.calls.filter(([sql]) => String(sql).includes(kind === 'from' ? 'close_time >=' : 'close_time <')).length;

describe('LedgerRangeResolver', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  // ledgers 10..14 close every 10 s from 12:00:00 on 2015-01-14; 12 and 13 share a close time like some mock ledgers do
  const LEDGERS: [number, number][] = [
    [10, secs('2015-01-14T12:00:00Z')],
    [11, secs('2015-01-14T12:00:10Z')],
    [12, secs('2015-01-14T12:00:20Z')],
    [13, secs('2015-01-14T12:00:20Z')],
    [14, secs('2015-01-14T12:00:30Z')],
  ];

  describe('resolve', () => {
    it('is null when there are no ledgers', async () => {
      const { ch } = chWith([]);
      const resolver = new LedgerRangeResolver(ch);
      expect(await resolver.resolve()).toBeNull();
      expect(await resolver.resolve(at('2015-01-14T00:00:00Z'), at('2015-01-15T00:00:00Z'))).toBeNull();
    });

    it('is the first ledger closed at or after start and the last closed before end', async () => {
      const resolver = new LedgerRangeResolver(chWith(LEDGERS).ch);
      expect(await resolver.resolve(at('2015-01-14T12:00:10Z'), at('2015-01-14T12:00:30Z'))).toEqual({
        min: 11,
        max: 13,
      });
      // start is inclusive, end exclusive
      expect(await resolver.resolve(at('2015-01-14T12:00:00Z'), at('2015-01-14T12:00:10Z'))).toEqual({
        min: 10,
        max: 10,
      });
      expect(await resolver.resolve(at('2015-01-14T12:00:20Z'), at('2015-01-14T12:00:21Z'))).toEqual({
        min: 12,
        max: 13,
      });
    });

    it('leaves a side open when its bound is missing', async () => {
      const resolver = new LedgerRangeResolver(chWith(LEDGERS).ch);
      expect(await resolver.resolve()).toEqual({ min: 10, max: 14 });
      expect(await resolver.resolve(at('2015-01-14T12:00:20Z'))).toEqual({ min: 12, max: 14 });
      expect(await resolver.resolve(undefined, at('2015-01-14T12:00:20Z'))).toEqual({ min: 10, max: 11 });
    });

    it('is null when the window holds no ledger', async () => {
      const resolver = new LedgerRangeResolver(chWith(LEDGERS).ch);
      expect(await resolver.resolve(at('2030-01-01T00:00:00Z'), at('2031-01-01T00:00:00Z'))).toBeNull(); // after the last
      expect(await resolver.resolve(at('2013-01-01T00:00:00Z'), at('2014-01-01T00:00:00Z'))).toBeNull(); // before the first
      expect(await resolver.resolve(at('2015-01-14T12:00:11Z'), at('2015-01-14T12:00:20Z'))).toBeNull(); // between two
      expect(await resolver.resolve(at('2015-01-14T12:00:20Z'), at('2015-01-14T12:00:10Z'))).toBeNull(); // start after end
    });

    it('treats a fractional bound as the whole-second close times see it', async () => {
      const resolver = new LedgerRangeResolver(chWith(LEDGERS).ch);
      // closed >= 12:00:10.001 is closed >= 12:00:11; closed < 12:00:20.5 is closed < 12:00:21
      expect(await resolver.resolve(at('2015-01-14T12:00:10.001Z'), at('2015-01-14T12:00:20.500Z'))).toEqual({
        min: 12,
        max: 13,
      });
    });

    it('binds the bounds as seconds parameters and never writes them into the SQL', async () => {
      const { ch, query } = chWith(LEDGERS);
      await new LedgerRangeResolver(ch).resolve(at('2015-01-14T12:00:10Z'), at('2015-01-14T12:00:30Z'));
      for (const [sql, params] of query.mock.calls) {
        expect(sql).not.toMatch(/\d{9,}/);
        expect(sql).toContain('{secs:UInt32}');
        expect(typeof params.secs).toBe('number');
      }
    });

    it('rejects an invalid date instead of querying with NaN', async () => {
      const { ch, query } = chWith(LEDGERS);
      const resolver = new LedgerRangeResolver(ch);
      await expect(resolver.resolve(new Date('nope'))).rejects.toThrow(RangeError);
      await expect(resolver.resolve(undefined, new Date('nope'))).rejects.toThrow(RangeError);
      await expect(resolver.ledgerAtOrBefore(new Date('nope'))).rejects.toThrow(RangeError);
      expect(query).not.toHaveBeenCalled();
    });

    it('handles dates outside the DateTime range', async () => {
      const resolver = new LedgerRangeResolver(chWith(LEDGERS).ch);
      expect(await resolver.resolve(at('1960-01-01T00:00:00Z'), at('2300-01-01T00:00:00Z'))).toEqual({
        min: 10,
        max: 14,
      });
      expect(await resolver.resolve(at('2300-01-01T00:00:00Z'))).toBeNull();
      expect(await resolver.resolve(undefined, at('1960-01-01T00:00:00Z'))).toBeNull();
    });
  });

  describe('ledgerAtOrBefore', () => {
    it('is the last ledger closed at or before the date', async () => {
      const resolver = new LedgerRangeResolver(chWith(LEDGERS).ch);
      expect(await resolver.ledgerAtOrBefore(at('2015-01-14T12:00:30Z'))).toBe(14);
      expect(await resolver.ledgerAtOrBefore(at('2015-01-14T12:00:29Z'))).toBe(13); // 12 and 13 share a close time: the later one
      expect(await resolver.ledgerAtOrBefore(at('2015-01-14T12:00:20Z'))).toBe(13);
      expect(await resolver.ledgerAtOrBefore(at('2015-01-14T12:00:19Z'))).toBe(11);
      expect(await resolver.ledgerAtOrBefore(at('2015-01-14T12:00:19.999Z'))).toBe(11);
      expect(await resolver.ledgerAtOrBefore(at('2015-01-14T12:00:20.999Z'))).toBe(13);
      expect(await resolver.ledgerAtOrBefore(at('2099-01-01T00:00:00Z'))).toBe(14);
    });

    it('is undefined before the first ledger and on an empty database', async () => {
      expect(
        await new LedgerRangeResolver(chWith(LEDGERS).ch).ledgerAtOrBefore(at('2015-01-14T11:59:59Z')),
      ).toBeUndefined();
      expect(
        await new LedgerRangeResolver(chWith(LEDGERS).ch).ledgerAtOrBefore(at('1960-01-01T00:00:00Z')),
      ).toBeUndefined();
      expect(await new LedgerRangeResolver(chWith([]).ch).ledgerAtOrBefore(at('2015-01-14T12:00:00Z'))).toBeUndefined();
    });
  });

  describe('latest', () => {
    it('is the highest committed ledger, and it is never cached', async () => {
      const { ch, query } = chWith(LEDGERS);
      const resolver = new LedgerRangeResolver(ch);
      expect(await resolver.latest()).toBe(14);
      await resolver.latest();
      expect(query).toHaveBeenCalledTimes(2);
      expect(await new LedgerRangeResolver(chWith([]).ch).latest()).toBeUndefined();
    });
  });

  describe('cache', () => {
    const OLD_START = at('2015-01-14T12:00:10Z');
    const OLD_END = at('2015-01-14T12:00:30Z');

    it('remembers a resolution whose bounds are older than an hour', async () => {
      const { ch, query } = chWith(LEDGERS);
      const resolver = new LedgerRangeResolver(ch);
      expect(await resolver.resolve(OLD_START, OLD_END)).toEqual({ min: 11, max: 13 });
      expect(query).toHaveBeenCalledTimes(2); // one per bound
      expect(await resolver.resolve(OLD_START, OLD_END)).toEqual({ min: 11, max: 13 });
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('keys on the bound, not on the call: another Date for the same instant hits, another instant misses', async () => {
      const { ch, query } = chWith(LEDGERS);
      const resolver = new LedgerRangeResolver(ch);
      await resolver.resolve(OLD_START, OLD_END);
      await resolver.resolve(new Date(OLD_START.getTime()), new Date(OLD_END.getTime()));
      expect(query).toHaveBeenCalledTimes(2);
      // a different end reuses the cached start
      await resolver.resolve(OLD_START, at('2015-01-14T12:00:20Z'));
      expect(query).toHaveBeenCalledTimes(3);
      // the same instant on the other side of the window is another question (>= vs <)
      await resolver.resolve(at('2015-01-14T12:00:30Z'), at('2015-01-14T12:00:31Z'));
      expect(query).toHaveBeenCalledTimes(5);
    });

    it('shares the upper bound between resolve and ledgerAtOrBefore when they ask the same question', async () => {
      const { ch, query } = chWith(LEDGERS);
      const resolver = new LedgerRangeResolver(ch);
      await resolver.resolve(undefined, at('2015-01-14T12:00:21Z')); // closed before 12:00:21
      const calls = query.mock.calls.length;
      expect(await resolver.ledgerAtOrBefore(at('2015-01-14T12:00:20Z'))).toBe(13); // closed at or before 12:00:20
      expect(query).toHaveBeenCalledTimes(calls);
    });

    it('does not remember a bound younger than an hour', async () => {
      const recent = new Date(NOW - HOUR + 1000);
      const { ch, query } = chWith([[1, Math.floor((NOW - 5000) / 1000)]]);
      const resolver = new LedgerRangeResolver(ch);
      await resolver.resolve(recent);
      await resolver.resolve(recent);
      expect(asked(query, 'from')).toBe(2);
      await resolver.ledgerAtOrBefore(recent);
      await resolver.ledgerAtOrBefore(recent);
      expect(asked(query, 'before')).toBe(2);
    });

    it('draws the line at one hour', async () => {
      const { ch, query } = chWith([[1, Math.floor(NOW / 1000)]]); // a ledger that closed after every bound below
      const resolver = new LedgerRangeResolver(ch);
      const exactly = new Date(NOW - RANGE_CACHE_MIN_AGE_MS);
      await resolver.resolve(exactly);
      await resolver.resolve(exactly);
      expect(asked(query, 'from')).toBe(2); // not older than an hour yet
      const older = new Date(NOW - RANGE_CACHE_MIN_AGE_MS - 1000);
      await resolver.resolve(older);
      await resolver.resolve(older);
      expect(asked(query, 'from')).toBe(3);
    });

    it('does not remember a missing ledger or an open bound: history may still be filled in', async () => {
      const { ch, query } = chWith([]);
      const resolver = new LedgerRangeResolver(ch);
      await resolver.resolve(OLD_START, OLD_END);
      await resolver.resolve(OLD_START, OLD_END);
      expect(query).toHaveBeenCalledTimes(4);
      query.mockClear();
      await resolver.resolve();
      await resolver.resolve();
      expect(query).toHaveBeenCalledTimes(4);
      const filled = chWith(LEDGERS);
      await new LedgerRangeResolver(filled.ch).resolve();
      await new LedgerRangeResolver(filled.ch).resolve();
      expect(filled.query).toHaveBeenCalledTimes(4);
    });

    it('forgets after the time to live, so ledgers backfilled below a cached bound are seen', async () => {
      const { ch, query } = chWith(LEDGERS);
      const resolver = new LedgerRangeResolver(ch);
      await resolver.resolve(OLD_START);
      await resolver.resolve(OLD_START);
      expect(asked(query, 'from')).toBe(1);
      jest.spyOn(Date, 'now').mockReturnValue(NOW + RANGE_CACHE_TTL_MS + 1);
      await resolver.resolve(OLD_START);
      expect(asked(query, 'from')).toBe(2);
    });

    it('a failed lookup caches nothing', async () => {
      const { ch, query } = chWith(LEDGERS);
      query.mockRejectedValueOnce(new Error('ClickHouse is down'));
      const resolver = new LedgerRangeResolver(ch);
      await expect(resolver.resolve(OLD_START, OLD_END)).rejects.toThrow('ClickHouse is down');
      expect(await resolver.resolve(OLD_START, OLD_END)).toEqual({ min: 11, max: 13 });
    });
  });
});

describe('LruCache', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it('is capped at 10k entries', () => {
    expect(RANGE_CACHE_MAX_ENTRIES).toBe(10_000);
  });

  it('evicts the least recently used entry beyond its capacity', () => {
    const cache = new LruCache<number>(3, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(1); // a is now the most recent
    cache.set('d', 4); // evicts b
    expect(cache.get('b')).toBeUndefined();
    expect([cache.get('a'), cache.get('c'), cache.get('d')]).toEqual([1, 3, 4]);
    expect(cache.size).toBe(3);
  });

  it('replacing a key does not grow it', () => {
    const cache = new LruCache<number>(2, 1000);
    cache.set('a', 1);
    cache.set('a', 2);
    cache.set('b', 3);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe(2);
  });

  it('drops an entry once its time to live has passed', () => {
    const cache = new LruCache<number>(2, 1000);
    cache.set('a', 1);
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 1000);
    expect(cache.get('a')).toBe(1);
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 1001);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('holds 10k resolutions and no more through the resolver', async () => {
    const { ch, query } = chWith([[5, secs('2020-01-01T00:00:00Z')]]);
    const resolver = new LedgerRangeResolver(ch);
    const start = (i: number) => new Date(Date.UTC(2015, 0, 14) + i * 1000);
    for (let i = 0; i <= RANGE_CACHE_MAX_ENTRIES; i += 1) await resolver.resolve(start(i));
    expect(asked(query, 'from')).toBe(RANGE_CACHE_MAX_ENTRIES + 1);

    await resolver.resolve(start(RANGE_CACHE_MAX_ENTRIES)); // the newest is still there
    expect(asked(query, 'from')).toBe(RANGE_CACHE_MAX_ENTRIES + 1);
    await resolver.resolve(start(0)); // the oldest was evicted
    expect(asked(query, 'from')).toBe(RANGE_CACHE_MAX_ENTRIES + 2);
  });
});
