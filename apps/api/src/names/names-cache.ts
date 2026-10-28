/**
 * The `CacheService` of the answers the names read on request, apart from the shared one of the `CommonModule`: the account domain
 * of each address asked (`account-domain:<address>`, up to 100 addresses a request) and the toml row of each domain asked
 * (`domain-toml:<domain>`, a miss too). Any well-formed address or domain is a key, so they must not push the coverage, amendments
 * and collections answers out of the 10,000 entries of the shared cache. The token lives in a file of its own, as the services that
 * inject it are imported by the module that provides it.
 */
export const NAMES_CACHE = Symbol('NAMES_CACHE');
