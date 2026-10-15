import { LruCache } from './lru-cache';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

describe('LruCache', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => jest.restoreAllMocks());

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

  it('keeps entries for ever without a time to live', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 10 * 365 * 24 * 3600 * 1000);
    expect(cache.get('a')).toBe(1);
  });

  it('holds a falsy value', () => {
    const cache = new LruCache<number | string>(2);
    cache.set('zero', 0);
    cache.set('empty', '');
    expect(cache.get('zero')).toBe(0);
    expect(cache.get('empty')).toBe('');
  });

  it('forgets everything on clear()', () => {
    const cache = new LruCache<number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    cache.set('c', 3);
    expect(cache.get('c')).toBe(3);
  });
});
