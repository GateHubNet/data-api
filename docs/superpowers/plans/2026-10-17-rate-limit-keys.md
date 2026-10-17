# Per-key rate limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Requests made with an API key listed in `GH_RATE_LIMIT_KEYS` are rate-limited per key, with that key's own limit, instead of per client address.

**Architecture:** `ApiConfig` gains the raw setting and a validating parser (`rateLimitKeysOf`, alongside `apiKeysOf`). The header-reading logic of `ApiKeyGuard` moves to one helper that both guards use. `ApiThrottlerGuard` overrides `getTracker` and `handleRequest` of `@nestjs/throttler` 5.2 to track a listed key by a hash of the key and to apply its limit.

**Tech Stack:** NestJS 10, `@nestjs/throttler` 5.2.0, Jest (unit and the e2e harness in `apps/api/test`), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-17-rate-limit-keys-design.md`

**Branch:** `feat/rate-limit-keys`, cut from `feat/ripple-dropin` (the branch with the current API; `main` holds only the baseline). Work in a git worktree.

## Global Constraints

- `GH_RATE_LIMIT_KEYS`: comma-separated `key=limit` pairs; empty (the default) changes nothing.
- A pair splits at its **last** `=` (API keys may contain `=`).
- A listed key's tracker is `key:` + the first 16 hex digits of the key's SHA-256. The raw key never appears in the throttler's storage, an error message, a log line or a metric label.
- Boot fails (an `Error` thrown while the guard is constructed, as `apiKeysOf` does) on: a pair without `=`, an empty key, a limit that is not a positive integer, a key not in `GH_API_KEYS`, a key listed twice, or a non-empty setting while `GH_API_KEYS` is empty. Messages name the entry by 1-based position, never the key.
- 429 body, `Retry-After` and `X-RateLimit-*` stay as they are; `X-RateLimit-Limit` shows the key's limit.
- The liveliness probe stays unthrottled. The limit stays per replica.
- Don't delete or rewrite anything this plan does not name. Don't touch `feat/amm-data`.

## Review Focus

- A key containing `=` (base64 keys end in `=`): `abc==` + `=5` must parse as key `abc==`, limit 5. Pinned in Task 1.
- Whitespace around pairs and around `=` (`" k = 5 , j=6 "`): trimmed, as `splitList` trims list entries. Pinned in Task 1.
- `Authorization: Bearer <listed key>` and `X-API-Key: <listed key>` must share one budget: they are the same client. Pinned in Task 2.
- A listed key whose limit is lower than `GH_RATE_LIMIT`: the key's limit wins (it is that client's budget, not a bonus). Pinned in Task 2.
- A request with a listed key on an open path (`/liveliness/healthz`): still not throttled. Pinned in Task 2.

---

### Task 1: The setting and its parser

**Files:**
- Modify: `apps/api/src/config/api.config.ts` (new property after `rateLimitWindow`; new exported function after `apiKeysOf`)
- Test: `apps/api/src/config/api.config.spec.ts`

**Interfaces:**
- Produces: `ApiConfig.rateLimitKeys: string` (default `''`, `@ConfigValue() @MaybeEmptyText()`, documented as a secret like `apiKeys`); `export function rateLimitKeysOf(cfg: Pick<ApiConfig, 'apiKeys' | 'rateLimitKeys'>): Map<string, number>`.

- [ ] **Step 1: Copy the spec and this plan onto the branch and commit them** (`git show 621581b:docs/superpowers/specs/2026-10-17-rate-limit-keys-design.md`; the plan from wherever it was written), commit `docs: per-key rate limits spec and plan`.

- [ ] **Step 2: Write the failing tests** in `api.config.spec.ts`, a `describe('rateLimitKeysOf')` block:

```ts
const of = (rateLimitKeys: string, apiKeys = 'a,b,abc==') => rateLimitKeysOf({ apiKeys, rateLimitKeys });

it('is empty for an empty setting', () => expect(of('')).toEqual(new Map()));
it('parses pairs and trims', () => expect(of(' a = 5 , b=60000 ')).toEqual(new Map([['a', 5], ['b', 60000]])));
it('splits at the last =', () => expect(of('abc===7')).toEqual(new Map([['abc==', 7]])));
it.each([
  ['a', 'GH_RATE_LIMIT_KEYS entry 1 must be key=limit'],
  ['=5', 'GH_RATE_LIMIT_KEYS entry 1 must be key=limit'],
  ['a=5,b=0', 'GH_RATE_LIMIT_KEYS entry 2 must have a positive whole limit'],
  ['a=-1', 'GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'],
  ['a=1.5', 'GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'],
  ['a=abc', 'GH_RATE_LIMIT_KEYS entry 1 must have a positive whole limit'],
  ['a=5,zz=5', 'GH_RATE_LIMIT_KEYS entry 2 names a key that is not in GH_API_KEYS'],
  ['a=5,a=6', 'GH_RATE_LIMIT_KEYS entry 2 repeats a key'],
])('rejects %s', (value, message) => expect(() => of(value)).toThrow(message));
it('needs GH_API_KEYS', () => expect(() => of('a=5', '')).toThrow('GH_RATE_LIMIT_KEYS needs GH_API_KEYS'));
it('never puts a key in a message', () => {
  for (const v of ['secret-key', 'secret-key=0', 'secret-key=5']) {
    try { of(v, 'other'); } catch (e) { expect((e as Error).message).not.toContain('secret-key'); }
  }
});
```

Also extend the existing config-loading test that checks defaults so that `rateLimitKeys` defaults to `''` and `GH_RATE_LIMIT_KEYS=a=5` loads as the string `'a=5'`.

- [ ] **Step 3: Run them and see them fail**

Run: `pnpm --filter @gatehub/data-api-service test -- src/config/api.config.spec.ts`
Expected: FAIL, `rateLimitKeysOf` is not exported.

- [ ] **Step 4: Implement `rateLimitKeysOf`** with `splitList` for the entries and `splitList(cfg.apiKeys)` for the known keys; a limit is valid when it matches `/^[1-9]\d*$/`.

- [ ] **Step 5: Run the tests; expect PASS.** Run the whole unit suite of the app too: `pnpm --filter @gatehub/data-api-service test`.

- [ ] **Step 6: Commit** `feat(api): GH_RATE_LIMIT_KEYS setting and its parser`.

### Task 2: Per-key tracking in the throttler

**Files:**
- Create: `apps/api/src/auth/presented-key.ts`
- Modify: `apps/api/src/auth/api-key.guard.ts` (its `extractKey` uses the helper)
- Modify: `apps/api/src/common/api-throttler.guard.ts`
- Test: `apps/api/src/auth/presented-key.spec.ts`, `apps/api/src/common/api-throttler.guard.spec.ts` (create), `apps/api/test/errors.e2e-spec.ts` (new `describe`)

**Interfaces:**
- Consumes: `rateLimitKeysOf`, `ApiConfig` (Task 1).
- Produces: `export function presentedApiKey(req: Pick<Request, 'header'>): string | undefined` (the exact logic of today's `ApiKeyGuard.extractKey`: `X-API-Key` trimmed, else `Authorization: Bearer` case-insensitive, trimmed); `export function rateLimitTracker(key: string): string` (`'key:' + sha256 hex .slice(0, 16)`).

- [ ] **Step 1: Write the failing unit tests.**
  - `presented-key.spec.ts`: `X-API-Key: ' k '` → `'k'`; `Authorization: 'bearer k'` → `'k'`; both headers → the `X-API-Key` one; `Authorization: 'Basic k'` → `undefined`; none → `undefined`. `rateLimitTracker('k')` is `'key:' + createHash('sha256').update('k').digest('hex').slice(0, 16)` and does not contain `'k'` as a whole word for a long key such as `'explorer-secret'`.
  - `api-throttler.guard.spec.ts`: construct the guard with `ApiConfig` `{ apiKeys: 'test-key,explorer-key', rateLimitKeys: 'explorer-key=3' }` and the Nest throttler test doubles; `getTracker` of a request with `X-API-Key: explorer-key` is `rateLimitTracker('explorer-key')`, of one with `test-key` is `req.ip`; constructing it with `rateLimitKeys: 'zz=3'` throws `GH_RATE_LIMIT_KEYS entry 1 names a key that is not in GH_API_KEYS`.

- [ ] **Step 2: Run them; expect FAIL** (`presented-key` missing). Run: `pnpm --filter @gatehub/data-api-service test -- presented-key api-throttler`.

- [ ] **Step 3: Implement.**
  - `presented-key.ts` with the two functions; `ApiKeyGuard.extractKey` becomes a call to `presentedApiKey`.
  - `ApiThrottlerGuard`: a constructor taking `@InjectThrottlerOptions() options`, `@InjectThrottlerStorage() storage`, `reflector: Reflector` and `config: ApiConfig`, calling `super(options, storage, reflector)` and keeping `this.keyLimits = rateLimitKeysOf(config)`. `getTracker(req)` returns `rateLimitTracker(key)` for a listed key, else `req.ip`. `handleRequest(context, limit, ttl, throttler, getTracker, generateKey)` calls `super.handleRequest` with the listed limit for a listed key, else with `limit`. Keep `shouldSkip`, `throwThrottlingException` and `secondsUntilReset` as they are. Update the class comment: counted per client address and route, or per key and route for a key in `GH_RATE_LIMIT_KEYS`.

- [ ] **Step 4: Run the unit tests; expect PASS.**

- [ ] **Step 5: Write the failing e2e tests**, a new `describe('with per-key limits (GH_RATE_LIMIT_KEYS)')` in `apps/api/test/errors.e2e-spec.ts` beside the rate-limit block. A key's budget is shared by every request with it, so each test starts its own harness (`beforeEach` / `afterEach` with `startHarness` and `close()`), with env `{ GH_API_KEYS: 'test-key,explorer-key', GH_RATE_LIMIT_KEYS: 'explorer-key=3', GH_RATE_LIMIT: '2', GH_RATE_LIMIT_WINDOW: '60' }` unless the test says otherwise. All requests go to `/v2/test/ok`:
  - `'a listed key shares one budget across client addresses'`: `explorer-key` from `203.0.113.30`, `.31`, `.32` → 200, 200, 200; from `.33` → 429 with `x-ratelimit-limit` `'3'`.
  - `'X-API-Key and Authorization: Bearer are the same budget'`: two requests with `X-API-Key: explorer-key`, one with `Authorization: Bearer explorer-key` → 200; the next with either → 429.
  - `'an unlisted key keeps per-address budgets'`: `test-key` from `203.0.113.40` → 200, 200, 429; from `.41` → 200.
  - `'the liveliness probe is not throttled for a listed key'`: 5 × `/liveliness/healthz` with `explorer-key` → never 429.
  - `'a key limit below GH_RATE_LIMIT wins'`: its harness uses `GH_RATE_LIMIT_KEYS: 'explorer-key=1'` and `GH_RATE_LIMIT: '600'` → 200, then 429.

- [ ] **Step 6: Run the e2e block; expect FAIL before Step 3's code is in, PASS with it.** Run: `pnpm --filter @gatehub/data-api-service test:e2e -- errors.e2e-spec.ts -t "per-key"` (needs Docker; the harness starts ClickHouse with testcontainers).

- [ ] **Step 7: Run the full unit suite and `errors.e2e-spec.ts`; expect PASS. Commit** `feat(api): rate-limit keys listed in GH_RATE_LIMIT_KEYS per key`.

### Task 3: Docs and deployment

**Files:**
- Modify: `docs/configuration.md` (the API table after `GH_RATE_LIMIT_WINDOW`; the secrets paragraph; the `api-xrpl`/`api-xahau` variable list; the "Abuse and exposure" row)
- Modify: `docs/security.md` (rate-limit section), `docs/api-reference.md` (section "Rate limit")
- Modify: `apps/api/.env.example`, `deploy/.env.prod.example`, `docker-compose.prod.yaml` (the shared api environment block next to `GH_RATE_LIMIT_WINDOW`)

**Interfaces:**
- Consumes: the behaviour of Tasks 1 and 2.

- [ ] **Step 1: Write the docs.** The configuration row:

`| GH_RATE_LIMIT_KEYS | empty | Comma separated key=limit pairs. A request made with a listed key is counted per key and route, with that limit per window, instead of per client address: for a trusted server-side client whose requests share addresses (the explorer behind Cloudflare). Every listed key must also be in GH_API_KEYS. Like GH_RATE_LIMIT, the limit is per API replica. A secret. |`

`docs/api-reference.md` "Rate limit" gets one sentence after the first paragraph: "A key listed in `GH_RATE_LIMIT_KEYS` is counted per key, with its own limit, instead of per client address; the 429 answer and headers are the same." `docs/security.md` says the same and that the tracker is a hash of the key. The env examples get `GH_RATE_LIMIT_KEYS=` (empty) next to `GH_RATE_LIMIT_WINDOW`, and the compose file passes `GH_RATE_LIMIT_KEYS:` wherever it passes `GH_RATE_LIMIT_WINDOW:`.

- [ ] **Step 2: Verify** `docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod.example config >/dev/null` exits 0, and `grep -n GH_RATE_LIMIT_KEYS docs/configuration.md docker-compose.prod.yaml deploy/.env.prod.example apps/api/.env.example` lists every file above.

- [ ] **Step 3: Commit** `docs: GH_RATE_LIMIT_KEYS`.
