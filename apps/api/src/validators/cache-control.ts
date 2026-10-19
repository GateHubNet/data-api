import { ApiConfig } from '../config/api.config';

/** The `Cache-Control` of `/v2/network/validators` (the list, `/summary` and `/{key}`): private, and 30 s. */
export const VALIDATORS_CACHE_CONTROL = 'private, max-age=30';

/**
 * The `Cache-Control` of a route that sends one of its own in place of the global header of `/v2` (`GH_CACHE_CONTROL`, 60 s):
 * `value` while `GH_CACHE_CONTROL` is not empty, and `undefined` when it is empty, since an operator who empties it wants no
 * header on any success. An error is `no-store` whatever this says (`RippleErrorFilter`).
 */
export function routeCacheControl(config: Pick<ApiConfig, 'cacheControl'>, value: string): string | undefined {
  return config.cacheControl === '' ? undefined : value;
}
