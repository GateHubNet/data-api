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

    it('refreshing a key that is kept evicts no other key, even at 10,000 entries', () => {
      const cache = new CacheService();
      for (let i = 0; i < MAX; i++) cache.set(`k${i}`, i, 60_000);

      cache.set('k5', 'again', 60_000);
      expect(cache.get('k5')).toBe('again');
      for (let i = 0; i < MAX; i++) if (i !== 5) expect(cache.get(`k${i}`)).toBe(i);
    });

    it('wrap refreshing a key whose ttl is over evicts no other key either', async () => {
      const cache = new CacheService();
      for (let i = 0; i < MAX; i++) cache.set(`k${i}`, i, i === 7 ? 1000 : 60_000);
      now += 1001;

      expect(await cache.wrap('k7', 60_000, async () => 'produced')).toBe('produced');
      expect(cache.get('k7')).toBe('produced');
      for (let i = 0; i < MAX; i++) if (i !== 7) expect(cache.get(`k${i}`)).toBe(i);
    });

    it('a refreshed key moves to the newest position: the evictions after it take the oldest of the others', () => {
      const cache = new CacheService();
      for (let i = 0; i < MAX; i++) cache.set(`k${i}`, i, 60_000);
      cache.set('k5', 'refreshed', 60_000);

      // ten more keys push out ten: k0 to k4 and k6 to k10 (k5 is the newest of the keys that were there)
      for (let i = 0; i < 10; i++) cache.set(`n${i}`, i, 60_000);
      expect(cache.get('k5')).toBe('refreshed');
      for (const gone of ['k0', 'k4', 'k6', 'k10']) expect(cache.get(gone)).toBeUndefined();
      expect(cache.get('k11')).toBe(11);
      expect(cache.get('n9')).toBe(9);
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

    /** A producer whose answer the test gives when it says. */
    function deferred(): { producer: jest.Mock; resolve: (value: string) => void; reject: (error: Error) => void } {
      const settle: { resolve?: (value: string) => void; reject?: (error: Error) => void } = {};
      const producer = jest.fn(
        () =>
          new Promise<string>((resolve, reject) => {
            settle.resolve = resolve;
            settle.reject = reject;
          }),
      );
      return {
        producer,
        resolve: (value) => settle.resolve?.(value),
        reject: (error) => settle.reject?.(error),
      };
    }

    it('shares one producer call between the misses of a key that come while it runs', async () => {
      const cache = new CacheService();
      const { producer, resolve } = deferred();
      const calls = [cache.wrap('k', 1000, producer), cache.wrap('k', 1000, producer), cache.wrap('k', 1000, producer)];
      expect(producer).toHaveBeenCalledTimes(1);
      // another key has a producer of its own
      const other = jest.fn(async () => 'o');
      expect(await cache.wrap('other', 1000, other)).toBe('o');
      expect(other).toHaveBeenCalledTimes(1);

      resolve('v');
      expect(await Promise.all(calls)).toEqual(['v', 'v', 'v']);
      // and the value is kept for the ttl, counted from the first call
      expect(cache.get('k')).toBe('v');
      expect(await cache.wrap('k', 1000, producer)).toBe('v');
      expect(producer).toHaveBeenCalledTimes(1);
      now += 1000;
      const again = jest.fn(async () => 'w');
      expect(await cache.wrap('k', 1000, again)).toBe('w');
      expect(again).toHaveBeenCalledTimes(1);
    });

    it('never keeps a rejection: the misses that shared the call all get it, and the next call runs the producer again', async () => {
      const cache = new CacheService();
      const { producer, reject } = deferred();
      const calls = [cache.wrap('k', 1000, producer), cache.wrap('k', 1000, producer)];
      expect(producer).toHaveBeenCalledTimes(1);
      reject(new Error('DB::Exception: Timeout exceeded'));
      await Promise.all(calls.map((call) => expect(call).rejects.toThrow('Timeout exceeded')));
      expect(cache.get('k')).toBeUndefined();

      const next = jest.fn(async () => 'v');
      expect(await cache.wrap('k', 1000, next)).toBe('v');
      expect(next).toHaveBeenCalledTimes(1);
      expect(cache.get('k')).toBe('v');
    });

    it('a producer that throws before it returns a promise is a rejection like any other, never kept', async () => {
      const cache = new CacheService();
      const throwing = jest.fn((): Promise<string> => {
        throw new Error('no connection');
      });
      await expect(cache.wrap('k', 1000, throwing)).rejects.toThrow('no connection');
      await expect(cache.wrap('k', 1000, throwing)).rejects.toThrow('no connection');
      expect(throwing).toHaveBeenCalledTimes(2);
    });

    it('a ttl of 0 or less shares nothing: each call runs the producer, also while another runs', async () => {
      const cache = new CacheService();
      const producer = jest.fn(async () => 'v');
      expect(await Promise.all([cache.wrap('k', 0, producer), cache.wrap('k', 0, producer)])).toEqual(['v', 'v']);
      expect(producer).toHaveBeenCalledTimes(2);
    });

    it('clear forgets a producer that is running: its value is not kept, and a call after the clear runs its own', async () => {
      const cache = new CacheService();
      const { producer, resolve } = deferred();
      const before = cache.wrap('k', 1000, producer);
      cache.clear();
      const after = jest.fn(async () => 'after');
      expect(await cache.wrap('k', 1000, after)).toBe('after');
      resolve('before');
      expect(await before).toBe('before');
      // what the producer from before the clear gave is not what is kept
      expect(cache.get('k')).toBe('after');
    });
  });
});
