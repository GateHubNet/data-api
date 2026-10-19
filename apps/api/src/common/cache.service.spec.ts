import { CacheService } from './cache.service';

describe('CacheService', () => {
  let now: number;

  beforeEach(() => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('get and set', () => {
    it('gives back what was set within its ttl, and undefined after it', () => {
      const cache = new CacheService();
      expect(cache.get('k')).toBeUndefined();

      const value = { rate: '3' };
      cache.set('k', value, 60_000);
      expect(cache.get<{ rate: string }>('k')).toBe(value);
      now += 59_999;
      expect(cache.get('k')).toBe(value);
      now += 1;
      expect(cache.get('k')).toBeUndefined();
    });

    it('keeps a falsy value: a 0, an empty string and false are values, only undefined is none', () => {
      const cache = new CacheService();
      cache.set('zero', 0, 1000);
      cache.set('empty', '', 1000);
      cache.set('no', false, 1000);
      expect([cache.get('zero'), cache.get('empty'), cache.get('no')]).toEqual([0, '', false]);
    });

    it('replaces a value and starts its ttl again', () => {
      const cache = new CacheService();
      cache.set('k', 'old', 1000);
      now += 900;
      cache.set('k', 'new', 1000);
      now += 900;
      expect(cache.get('k')).toBe('new');
      now += 100;
      expect(cache.get('k')).toBeUndefined();
    });

    it('stores nothing for a ttl of 0 or less, as wrap does', () => {
      const cache = new CacheService();
      cache.set('zero', 'v', 0);
      cache.set('negative', 'v', -5);
      expect(cache.get('zero')).toBeUndefined();
      expect(cache.get('negative')).toBeUndefined();
    });

    it('shares its entries with wrap', async () => {
      const cache = new CacheService();
      cache.set('k', 'from set', 1000);
      const producer = jest.fn(async () => 'from wrap');
      expect(await cache.wrap('k', 1000, producer)).toBe('from set');
      expect(producer).not.toHaveBeenCalled();

      await cache.wrap('w', 1000, producer);
      expect(cache.get('w')).toBe('from wrap');
    });
  });

  describe('clear', () => {
    it('empties the cache: what was set and what wrap kept', async () => {
      const cache = new CacheService();
      cache.set('a', 1, 60_000);
      await cache.wrap('b', 60_000, async () => 2);
      cache.clear();
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();

      const producer = jest.fn(async () => 3);
      expect(await cache.wrap('b', 60_000, producer)).toBe(3);
      expect(producer).toHaveBeenCalledTimes(1);
    });
  });

  describe('eviction', () => {
    const MAX = 10_000;

    it('drops the oldest inserted key at 10,000 entries, for set', () => {
      const cache = new CacheService();
      for (let i = 0; i < MAX; i++) cache.set(`k${i}`, i, 60_000);
      expect(cache.get('k0')).toBe(0);

      cache.set('new', 'v', 60_000);
      expect(cache.get('k0')).toBeUndefined();
      expect(cache.get('k1')).toBe(1);
      expect(cache.get('new')).toBe('v');
      expect(cache.get(`k${MAX - 1}`)).toBe(MAX - 1);

      // and the next one takes the next oldest
      cache.set('newer', 'v', 60_000);
      expect(cache.get('k1')).toBeUndefined();
      expect(cache.get('k2')).toBe(2);
    });

    it('drops the oldest inserted key at 10,000 entries, for wrap', async () => {
      const cache = new CacheService();
      for (let i = 0; i < MAX; i++) await cache.wrap(`k${i}`, 60_000, async () => i);

      await cache.wrap('new', 60_000, async () => 'v');
      expect(cache.get('k0')).toBeUndefined();
      expect(cache.get('k1')).toBe(1);
      expect(cache.get('new')).toBe('v');
    });

    it('counts the entries of set and of wrap together', async () => {
      const cache = new CacheService();
      for (let i = 0; i < MAX / 2; i++) cache.set(`s${i}`, i, 60_000);
      for (let i = 0; i < MAX / 2; i++) await cache.wrap(`w${i}`, 60_000, async () => i);

      cache.set('new', 'v', 60_000);
      expect(cache.get('s0')).toBeUndefined();
      expect(cache.get('s1')).toBe(1);
      expect(cache.get(`w${MAX / 2 - 1}`)).toBe(MAX / 2 - 1);
    });
  });

  describe('wrap', () => {
    it('keeps the value for the ttl counted from when it was asked for, and runs the producer once', async () => {
      const cache = new CacheService();
      const producer = jest.fn(async () => {
        now += 400; // the producer takes a while
        return 'v';
      });
      expect(await cache.wrap('k', 1000, producer)).toBe('v');
      now += 500;
      expect(await cache.wrap('k', 1000, producer)).toBe('v');
      expect(producer).toHaveBeenCalledTimes(1);
      now += 100; // 1000 ms after the call began
      expect(await cache.wrap('k', 1000, producer)).toBe('v');
      expect(producer).toHaveBeenCalledTimes(2);
    });

    it('does not cache with a ttl of 0 or less', async () => {
      const cache = new CacheService();
      const producer = jest.fn(async () => 'v');
      await cache.wrap('k', 0, producer);
      await cache.wrap('k', 0, producer);
      expect(producer).toHaveBeenCalledTimes(2);
    });
  });
});
