# Per-key rate limits: design

Date: 2026-10-17. Status: proposed. A prerequisite of the public explorer, which lives in its own repository (`GateHubNet/x-explorer`, spec `docs/superpowers/specs/2026-10-17-explorer-foundation-design.md` there).

## Context

The API limits each client address to `GH_RATE_LIMIT` requests (default 600) per route per `GH_RATE_LIMIT_WINDOW` seconds (default 60). `ApiThrottlerGuard` (`apps/api/src/common/api-throttler.guard.ts`, on `@nestjs/throttler` 5) counts per `req.ip`, which honours `X-Forwarded-For` for `GH_TRUST_PROXY_HOPS` hops. `ApiKeyGuard` runs first, so a request without a valid key uses nobody's budget.

The explorer runs on Cloudflare Workers and calls the API from its server side with one key. Its requests arrive from Cloudflare's shared egress addresses, where many visitors share one address, so the explorer would get 429s under real traffic even though each visitor is modest. The explorer limits its own visitors at the edge; the API needs to count the explorer's traffic per key instead.

This is a bounded change to the existing rate limit. Nothing in the Ripple contract changes.

## Change

A new setting, `GH_RATE_LIMIT_KEYS`:

- **Format**: comma-separated `key=limit` pairs, e.g. `GH_RATE_LIMIT_KEYS=<explorer key>=60000`. Empty, the default, changes nothing.
- **Matching**: a request whose API key, sent as `X-API-Key` or `Authorization: Bearer` (exactly what `ApiKeyGuard` accepts), is listed is tracked under that key and route, with the listed limit per `GH_RATE_LIMIT_WINDOW`. Every other request is tracked per client address and route as today.
- **The tracker never holds the key itself.** It is `key:` plus the first 16 hex digits of the key's SHA-256, so the key appears in neither the throttler's storage nor any log or metric label.
- **Validation at boot**, in `ApiConfig` (`apps/api/src/config/api.config.ts`) like the other `GH_*` settings: every pair is `key=limit` with a non-empty key and a positive integer limit; every listed key is also in `GH_API_KEYS`; no key is listed twice. With `GH_API_KEYS` empty, a non-empty `GH_RATE_LIMIT_KEYS` fails the boot. A failure names the bad pair by position, never by key.
- **Answers are unchanged**: a rejected request gets the same 429 body, `Retry-After` and `X-RateLimit-*` headers, and `X-RateLimit-Limit` shows the key's own limit.
- **Unchanged otherwise**: the liveliness probe stays unthrottled, and the limit stays per replica (the throttler's in-memory storage), so with N API replicas behind nginx the effective budget of a key is N times its limit, as it is for an address today. The docs say so.
- The setting is a secret, like `GH_API_KEYS`.

## Implementation notes

- `ApiThrottlerGuard` overrides `getTracker` (the key's hash or the address) and, in `handleRequest`, replaces the limit for a listed key. The key is read from the request the same way `ApiKeyGuard` reads it, through one shared helper so the two cannot disagree.
- `ApiConfig` parses the setting into a map from key to limit; the guard looks keys up there.

## Tests

- **Unit, `ApiConfig`**: valid pairs; empty; a malformed pair; a limit of `0`, `-1`, `1.5` and `abc`; a key not in `GH_API_KEYS`; a key listed twice; a non-empty setting with `GH_API_KEYS` empty. Error messages do not contain the key.
- **Unit, the guard**: a listed key's tracker is its hash and its limit the listed one; an unlisted key and a keyless development request are tracked per address with `GH_RATE_LIMIT`.
- **End to end (`apps/api/test`)**: with a listed key at a small limit, requests from two different `X-Forwarded-For` addresses share one budget and the request after the limit gets 429 with `X-RateLimit-Limit` equal to the key's limit; an unlisted key from the same two addresses gets two budgets.

## Documentation and deployment

- `docs/configuration.md`: the new row next to `GH_RATE_LIMIT`, the secrets list, and the variable list of `api-xrpl` / `api-xahau`.
- `docs/security.md`: the rate-limit section, including the per-replica budget.
- `docs/api-reference.md`: the rate-limit section says listed keys are counted per key.
- `apps/api/.env.example` and `deploy/.env.prod.example`: the variable, empty.
- `docker-compose.prod.yaml`: `GH_RATE_LIMIT_KEYS` in the environment of `api-xrpl` and `api-xahau` (the compose file passes each service only the variables it names).

## Rollout

Deploy with the setting empty (no change), then issue the explorer's key: add it to `GH_API_KEYS` and `GH_RATE_LIMIT_KEYS` with a limit sized from the explorer's expected cache-miss rate (start at 60000 per 60 s per replica), and restart the apis.

## Out of scope

- Rate-limit storage shared across replicas (for example Redis).
- Per-key limits that differ by route.
