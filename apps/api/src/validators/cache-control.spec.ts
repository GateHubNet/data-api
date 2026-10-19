import { VALIDATORS_CACHE_CONTROL, routeCacheControl } from './cache-control';

describe('routeCacheControl', () => {
  it('is the value of the route while GH_CACHE_CONTROL is set', () => {
    expect(routeCacheControl({ cacheControl: 'private, max-age=60' }, 'private, max-age=30')).toBe(
      'private, max-age=30',
    );
    expect(routeCacheControl({ cacheControl: 'public, max-age=5' }, 'private, max-age=5')).toBe('private, max-age=5');
  });

  it('is undefined when GH_CACHE_CONTROL is empty, so that the route sends no header', () => {
    expect(routeCacheControl({ cacheControl: '' }, 'private, max-age=30')).toBeUndefined();
  });

  it('is private with 30 s for the validators routes of the list, the summary and the detail', () => {
    expect(VALIDATORS_CACHE_CONTROL).toBe('private, max-age=30');
  });
});
