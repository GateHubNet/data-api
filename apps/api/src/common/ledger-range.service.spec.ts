import type { ClickHouseService } from '@gatehub/data-api-shared';
import {
  LedgerRangeResolver,
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
 * A ClickHouse whose `ledgers` table is `ledgers` (ledger_index -> close time in unix seconds; the test may push more
 * of them later), answering the lookups of the resolver the way the SQL defines them.
 */
function chWith(ledgers: [number, number][]): Fake {
  const query = jest.fn(async (sql: string, params: Record<string, unknown> = {}) => {
    const secs = params.secs as number | undefined;
    const all = [...ledgers].sort((a, b) => a[0] - b[0]);
    let rows = all;
    if (sql.includes('close_time >=')) rows = rows.filter(([, close]) => close >= (secs as number));
    else if (sql.includes('close_time <')) rows = rows.filter(([, close]) => close < (secs as number));
    if (sql.includes('DESC')) rows = [...rows].reverse();
    return rows.slice(0, 1).map(([ledger_index]) => ({
      ledger_index,
      // the lookup of the last ledger before a bound also reports when the newest ledger closed
      ...(sql.includes('head_close') && { head_close: all[all.length - 1][1] }),
    }));
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

    it('does not remember the last ledger before a bound that the ingest has not reached', async () => {
      // The newest ledger closed at 12:00:30, the bound is 12:05:00: the answer is only "the newest so far".
      const ledgers = [...LEDGERS];
      const { ch, query } = chWith(ledgers);
      const resolver = new LedgerRangeResolver(ch);
      const bound = at('2015-01-14T12:05:00Z');
      expect(await resolver.ledgerAtOrBefore(bound)).toBe(14);
      expect(await resolver.ledgerAtOrBefore(bound)).toBe(14);
      expect(asked(query, 'before')).toBe(2);

      // The syncer commits a ledger before the bound: the answer moves, and nothing stale is served.
      ledgers.push([15, secs('2015-01-14T12:04:50Z')]);
      expect(await resolver.ledgerAtOrBefore(bound)).toBe(15);
      expect(asked(query, 'before')).toBe(3);
      expect(await resolver.resolve(undefined, new Date(bound.getTime() + 1000))).toEqual({ min: 10, max: 15 });
      expect(asked(query, 'before')).toBe(4); // a different bound, not reached either

      // Once a ledger closes at or after the bound nothing can change the answer any more.
      ledgers.push([16, secs('2015-01-14T12:05:10Z')]);
      expect(await resolver.ledgerAtOrBefore(bound)).toBe(15);
      expect(asked(query, 'before')).toBe(5);
      expect(await resolver.ledgerAtOrBefore(bound)).toBe(15);
      expect(asked(query, 'before')).toBe(5);
    });

    it('remembers the last ledger before a bound that the newest ledger closed exactly at', async () => {
      const { ch, query } = chWith(LEDGERS);
      const resolver = new LedgerRangeResolver(ch);
      // closed < 12:00:30 -> ledger 13; the head (14) closed at 12:00:30, which is not before the bound
      await resolver.resolve(undefined, at('2015-01-14T12:00:30Z'));
      await resolver.resolve(undefined, at('2015-01-14T12:00:30Z'));
      expect(asked(query, 'before')).toBe(1);
    });

    it('does not remember an answer for a database whose ledgers are all before the bound', async () => {
      const { ch, query } = chWith([[1, secs('2015-01-14T12:00:00Z')]]);
      const resolver = new LedgerRangeResolver(ch);
      await resolver.resolve(undefined, at('2020-01-01T00:00:00Z'));
      await resolver.resolve(undefined, at('2020-01-01T00:00:00Z'));
      expect(asked(query, 'before')).toBe(2);
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

describe('LedgerRangeResolver cache size', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

  it('is capped at 10k entries', () => {
    expect(RANGE_CACHE_MAX_ENTRIES).toBe(10_000);
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
