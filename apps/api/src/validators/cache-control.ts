import { ApiConfig } from '../config/api.config';

/** The `Cache-Control` of `/v2/network/validators` (the list, `/summary` and `/{key}`): private, and 30 s. */
export const VALIDATORS_CACHE_CONTROL = 'private, max-age=30';

/** The `Cache-Control` of `/v2/network/validators/{key}/validations`: private, and 5 s. */
export const VALIDATIONS_CACHE_CONTROL = 'private, max-age=5';

/**
 * The `Cache-Control` of `/v2/network/validators/{key}/validations` when the request has a `marker`: private, and 300 s. A page
 * behind a marker lies further back than the first one, where a validation is complete, so it is kept longer.
 */
export const VALIDATIONS_MARKER_CACHE_CONTROL = 'private, max-age=300';

/** The `Cache-Control` of `/v2/network/amendments` and `/v2/network/amendments/{name}`: private, and 60 s. */
export const AMENDMENTS_CACHE_CONTROL = 'private, max-age=60';

/**
 * The `Cache-Control` of a route that sends one of its own in place of the global header of `/v2` (`GH_CACHE_CONTROL`, 60 s):
 * `value` while `GH_CACHE_CONTROL` is not empty, and `undefined` when it is empty, since an operator who empties it wants no
 * header on any success. An error is `no-store` whatever this says (`RippleErrorFilter`).
 */
export function routeCacheControl(config: Pick<ApiConfig, 'cacheControl'>, value: string): string | undefined {
  return config.cacheControl === '' ? undefined : value;
}
