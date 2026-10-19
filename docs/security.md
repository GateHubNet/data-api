# Security

The security posture of the Data API: what is implemented, how it is deployed, and what remains on the hardening backlog. It is
honest about gaps: where a control is recommended but not implemented, that is said.

Components: the **api** (a read-only HTTP service; it also forwards a few live lookups to a node), the **syncer** (an internal ingest
worker), **ClickHouse** (+ Keeper), and **nginx** as the edge of the stack. The data itself is public ledger data, so the
confidentiality of responses is not the main concern; availability, the integrity of the store and the secrets are.

## 1. Threat model and trust boundaries

The service is not internet-facing on its own. It runs behind a **front proxy** (the GateHub reverse proxy / a load balancer) that
terminates TLS, then through the stack's **nginx**, which routes by host name. ClickHouse, Keeper and the syncers are internal only.

```
   client ──HTTPS──▶ front proxy (TLS, edge) ──HTTP, X-Forwarded-For──▶ nginx ──▶ api-xrpl / api-xahau ──▶ ClickHouse
   ═══════════ untrusted ═════════════════════ │ ═══════════════ internal network ═════════════════════════════
                                                ClickHouse ◀── syncer-xrpl / syncer-xahau ──▶ XRPL / Xahau node (WSS, outbound)
                                                                      └─HTTPS─▶ UNL publishers, validator domains (public hosts, outbound; §9)
```

The API authenticates clients (API keys) and rate-limits them, but relies on the proxy chain to terminate TLS and to hand it a
correct client address (§4).

The syncer is the one component that connects to hosts nobody on the team chose: the `validators` worker fetches the lists of the
configured UNL publishers and the TOML file of every domain that a validator claims in its signed manifest, and a validator's operator
picks that domain. Those requests are untrusted-URL requests and are made only through the `SafeFetcher` (§9).

| Threat | Control |
| --- | --- |
| Unauthenticated access | API key on every `/v2/*` route (§2) |
| SQL injection | Fully parameterised queries (§6) |
| Resource exhaustion and abuse | Rate limit (§5), per-query ClickHouse guards (§6), bounded windows and limits per endpoint |
| Information disclosure through errors | Ripple-shaped errors, 5xx causes only in the log (§7) |
| Client-address spoofing (rate-limit evasion) | nginx trusts `X-Forwarded-For` only from `TRUSTED_PROXIES` and sets exactly one address (§4) |
| Secret leakage | Env-only secrets, git/docker-ignored env files, BuildKit secret for the npm token, per-service env (§8) |
| Server-side request forgery through a fetched URL (a validator's domain, a publisher, a redirect, a DNS name that points inward) | Every outbound HTTP request of the syncer goes through `SafeFetcher`: HTTPS on port 443 to public addresses only, every resolved address checked and the connection pinned to it, redirects checked again, bounded time and size (§9) |
| Direct ClickHouse access | Not published (§9) |
| Exposure of internals | `/internal/` and `/liveliness/` blocked at the edge for the public (§9) |

**Known residual risks:** a single trust level (no per-key scopes), API keys in the environment in plaintext, a per-replica in-memory
rate limit, the same full-access ClickHouse user for every client, and the nginx trust default (private ranges) that the operator must
narrow. A key listed in `GH_RATE_LIMIT_KEYS` is also exempt from the per-address limit: whoever holds it gets its own budget (60000
per 60 s at rollout, against 600 per address) per route and replica from any address, so it must stay server-side (§3). They are tracked in §10.

## 2. Authentication

Static **API keys**, enforced globally by `ApiKeyGuard` (`apps/api/src/auth/api-key.guard.ts`, an `APP_GUARD`), checked **before** the
rate limit so a request with a bad key spends nobody's budget.

- **Header forms:** `X-API-Key: <key>` or `Authorization: Bearer <key>`. The key is deliberately not accepted in the query string
  (query strings leak into logs, history and `Referer`).
- **Constant-time comparison:** the SHA-256 digest of the presented key is compared with the digest of every configured key using
  `crypto.timingSafeEqual` (equal-length buffers whatever the key lengths, no early exit), so response time leaks neither length nor
  content.
- **401 body:** `{"result":"error","message":"Missing or invalid API key."}` ([api-reference](api-reference.md#authentication)).
- **Open paths:** `^/liveliness/` only (the probe). `/metricz` is a separate app on its own port, and the Swagger docs are served by the
  toolbox outside the Nest routes, so neither reaches the guard; keep both off the public network (§9).
- **No keys = no authentication, development only.** If `GH_API_KEYS` is empty the guard lets everything through and logs
  `GH_API_KEYS is empty: the API is UNAUTHENTICATED (development only).` In production this is a **boot failure**: with
  `NODE_ENV=production` an empty list throws `GH_API_KEYS must be set in production`, and so does a placeholder key (`dev-api-key`, or
  anything starting with `change-me`, case-insensitive): `GH_API_KEYS contains a placeholder key ... set real keys in production`
  (the message never echoes the keys). The dev compose runs its API with `NODE_ENV=development` for that reason.
- **Provisioning and rotation:** `GH_API_KEYS` is a comma separated list; several keys are accepted at once, so rotation needs no client flag day (add the new
  key, roll the clients, remove the old one, [operations](operations.md#rotate-an-api-key)); restarting the apis for each step is still a brief outage per
  service. A key that has an entry in `GH_RATE_LIMIT_KEYS` is changed there in the same step: an entry for a key that is not in
  `GH_API_KEYS` fails the boot of every api. Keys come from a secrets manager, never from git.

Caveats: keys are compared by digest in memory but live in the environment as plaintext; validation is per replica, so revoking a key
needs a roll-out of every replica.

## 3. Authorization

One trust level: any valid key grants full read access to the whole `/v2` surface. The service is read-only, so there is no
write/admin distinction, and no per-key scopes: access is the same for every key. What differs is the rate budget: a key listed in
`GH_RATE_LIMIT_KEYS` (§5) has its own limit whatever the client address, not the per-address one. Such a key must stay server-side
(never in a browser or an app) and be rotated at once if it leaks ([operations](operations.md#rotate-an-api-key)), because from any
address it gets that budget per route and replica. Per-key scopes are future work.

## 4. Transport and the client address

**TLS ends at the front proxy.** The api and nginx speak plain HTTP inside the network. To key the rate limit on the real client the API
trusts `GH_TRUST_PROXY_HOPS` proxy hops of `X-Forwarded-For` (default 1).

The address chain in the shipped stack ([deployment](deployment.md#the-edge-nginx)):

1. The front proxy appends the client to `X-Forwarded-For`.
2. nginx believes that header **only from a `TRUSTED_PROXIES` peer** (comma separated addresses/CIDRs; default the private ranges; zero
   prefix lengths such as `0.0.0.0/0` are refused at start). It takes the last non-trusted address as the client, and then **sets**
   (never appends) `X-Forwarded-For` to that single address and passes `X-Forwarded-Proto` through from a trusted peer only
   (`http`/`https`; anything else becomes the scheme of the connection).
3. The API, with `GH_TRUST_PROXY_HOPS=1`, takes that one address as `req.ip`.

So a client cannot choose its address by sending its own `X-Forwarded-For`, unless it reaches nginx **from a trusted address**.
**Operator duties:** set `TRUSTED_PROXIES` to your front proxy's address(es), and publish nginx (`NGINX_BIND`) only on an interface that
proxy can reach. With the placeholder defaults (the private ranges, published on 0.0.0.0) a client that reaches the port from a
private address, on Docker Desktop every connection, can pick any address and get a rate-limit bucket of its own per request.
`GH_TRUST_PROXY_HOPS` must equal the number of proxies you actually control in front of the API; too high lets clients spoof their
address.

## 5. Rate limiting

`@nestjs/throttler` with a custom guard (`ApiThrottlerGuard`):

- **Default:** 600 requests per 60 s per client address **and route** (`GH_RATE_LIMIT`, `GH_RATE_LIMIT_WINDOW`). Everything except
  `/liveliness/*` is limited (the check is case-insensitive: Express routes ignore case, so `/V2/...` is limited too).
- **Per key:** a key listed in `GH_RATE_LIMIT_KEYS` (`key=limit` pairs, for a trusted server-side client whose requests share
  addresses) is counted per key and route, with its own limit, instead of per client address; the 429 answer is unchanged and
  `X-RateLimit-Limit` shows the key's limit. Like the default, it is counted per replica (see the caveat below). The tracker is `key:`
  and the first 16 hex digits of the key's SHA-256, so the key itself is never stored. Every listed key must also be in
  `GH_API_KEYS`; a malformed pair, a limit that is not a positive whole number, a repeated key, or a setting without `GH_API_KEYS`
  fails the boot, with a message that names the entry by position, never the key. The setting holds API keys: treat it as a secret.
- **Response:** 429 `{"error":"Rate limit exceeded, retry in N.NNsec"}` with `Retry-After` and `X-RateLimit-*` headers, the wording of
  the original service.
- **Honest caveat:** the store is in memory, per replica, so with N replicas behind the proxy the effective limit is up to N x the
  setting. A true global limit needs a shared store (Redis-backed throttler storage), which is backlog; the front proxy may also rate
  limit at the edge.

## 6. Input validation and injection

- **Parameters** are parsed by hand-written, strict parsers (`apps/api/src/common/params.ts`, `asset-param.ts`, `pagination.ts`) with the
  exact error messages of the original; issuer addresses are checked with `ripple-address-codec`, dates against the supported formats,
  hashes against hex, markers against the shape and types of their key. The toolbox `ValidationPipe` is **disabled** (it would reject
  unknown query parameters; the Ripple API ignores them). Unknown parameters are ignored, never trusted.
- **No SQL injection.** Every query goes through `ClickHouseService.query()`, which passes user values as ClickHouse server-side bound
  `query_params` with typed placeholders (`{currency:String}`, `{limit:UInt32}`), never by string interpolation. Pagination and
  `IN (...)` clauses emit placeholders too. The only interpolated parts are table names (from the `Table` enum, enforced by a unit test),
  column lists and sort keys, all hard-coded; interval expressions come from a fixed whitelist.
- **Resource guards:** every SELECT carries `max_execution_time` and `max_memory_usage` (`GH_CLICKHOUSE_MAX_EXECUTION_TIME`,
  `GH_CLICKHOUSE_MAX_QUERY_MEMORY`), and endpoints bound their own work (`limit` maxima, the 200-day report window, capped candle pages,
  node timeouts for live lookups).
- **Output hygiene:** the CSV file name is built from the request and stripped of characters a header cannot carry. A known nit: the
  payments CSV file name echoes an unvalidated currency text (the header is made safe, the name is not restricted further).
- **The live-node proxy** only forwards fixed commands (`account_info`, `account_lines`, `account_offers`, plus `server_info` / `server_definitions` at boot) with validated
  addresses and ledger selectors; node errors are mapped to Ripple messages, never passed through.

## 7. Error handling and information disclosure

Errors are `{"result":"error","message":...}` rendered by `RippleErrorFilter` at controller level (the toolbox's global filter would
render another shape).

- **5xx causes are never sent.** Any unexpected error, and any 5xx, becomes the route's fixed failure message (`unable to retrieve
  payments`, ...) or `internal error`; the exception and stack are logged server-side only.
- **4xx messages are intentional** so that callers can fix their request.
- Errors are `Cache-Control: no-store`; `x-powered-by` is disabled. Successful `/v2` answers are `Cache-Control: private,
  max-age=60` by default (`GH_CACHE_CONTROL`): they are for the holder of an API key, and a shared cache that does not key on it
  would hand them to anybody (Ruling R109). The live `/balances` and `/orders` are private for the live cache's TTL only (R108).
- A malformed percent-escape in a `/v2` path answers the Ripple 400 shape before any route runs (R55).
- A route that does not exist answers `Cannot GET /v2/nope`, not a framework page.

## 8. Secrets management

Secrets: `GH_API_KEYS`, `GH_RATE_LIMIT_KEYS` (it holds API keys), `GH_CLICKHOUSE_PASSWORD`, node URLs with credentials, and the build-time
`NPM_TOKEN`.

- All runtime secrets are environment variables. `.env` and `.env.*` are git-ignored (only `*.env.example` and `deploy/.env.prod.example`
  are committed) and excluded from the Docker build context (`.dockerignore` excludes all `**/.env*`). In production inject them from a
  secrets manager; `deploy/.env.prod` should be rendered from it, not stored.
- **Least privilege per service.** The production compose does not hand `deploy/.env.prod` to containers; each service lists the
  variables it needs, so the syncers never see `GH_API_KEYS` or the CORS and rate-limit settings
  ([which service gets what](configuration.md#which-service-gets-which-variables-production-compose)).
- **Config is fail-fast:** invalid values stop the boot with a message naming the variable (values of secrets are not echoed), and the
  compose file refuses to start without `GH_CLICKHOUSE_PASSWORD` and `GH_API_KEYS`. There is no boot guard against a placeholder
  ClickHouse password.
- **`NPM_TOKEN` is a BuildKit secret.** Both Dockerfiles mount it with `RUN --mount=type=secret,id=npm_token,required=true`: it is written
  to `~/.npmrc` inside that one `RUN` and removed by a `trap` before the layer is committed. It is not an `ARG` or `ENV`, so it is in no
  image layer, config or `docker history` (verified with a leak probe for both images). Do not copy the token out of `~/.npmrc` into
  files or build arguments; pass `NPM_TOKEN` in the environment of the build command.
- **Containers run as non-root** (`USER node`, `--chown=node:node`).
- Logs show node endpoints as `scheme://host:port` only.

## 9. Network exposure

Production compose (`docker-compose.prod.yaml`):

- **Only nginx has a host port** (`NGINX_BIND:NGINX_PORT`, default `0.0.0.0:8080`, bind it to the front proxy's interface).
  ClickHouse (8123/9000), Keeper (9181), the apis (3001) and the syncers (3002), and every metrics port (3000) are `expose`d inside the
  compose network only.
- **Edge rules** (nginx, case-insensitive after URI normalisation): `/internal/` (Swagger) is 404 for everyone; `/liveliness/healthz` is
  answered only for trusted proxies; unknown hosts get a 404 JSON and `/healthz`.
- **Load-test override.** `docker-compose.prod.override.yaml` publishes ClickHouse on the host for seeding; never use it in production.
- **Dev compose:** everything is published on `127.0.0.1` only, and the dev API key is `dev-api-key`.
- **ClickHouse users:** a dedicated `data_api` user (access management enabled), not `default`. The api and the syncers share it
  (full access); a read-only user for the api would be better.

### Outbound HTTPS to arbitrary public hosts (syncer)

The only HTTP requests to hosts outside the stack are those of the syncer's `validators` worker: the validator lists of the
publishers in `GH_UNL_PUBLISHERS` and, unless `GH_DOMAIN_VERIFICATION=false`, the `/.well-known/` TOML file of each domain a
validator claims. The URL is data from outside (a validator's operator chooses its domain), so the rules of
`apps/syncer/src/validators/safe-fetch.ts` are fixed in code and no environment variable loosens any of them:

- **URL:** `https:` only, port 443 only, no user name or password, and a host that is a domain name (4 to 128 characters, an alphabetic
  top-level label): no IP literal, port or single label such as `localhost`.
- **DNS, all addresses judged:** the A and AAAA records are resolved before connecting, and the request is refused (`blocked_address`)
  if **any** address is not public: IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16` (this covers the
  cloud metadata address), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`,
  `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`; IPv6 `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`,
  `2001:db8::/32`, `100::/64`, `64:ff9b::/96`, `2002::/16`; an IPv4-mapped address (`::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`) is judged
  by its IPv4. A host that resolves to nothing is `dns_error`.
- **Pinned connection:** the request connects to an address that was checked: the connection's `lookup` returns it, with no second
  DNS query, so an answer that changes between the check and the connect (DNS rebinding) cannot redirect it. SNI and `Host` are the
  domain; TLS uses Node's default trust store and checks the certificate against the domain, with no override
  (`rejectUnauthorized` is set to `true` explicitly, so `NODE_TLS_REJECT_UNAUTHORIZED=0` has no effect, and `checkServerIdentity` is
  never replaced).
- **Redirects:** followed by hand, at most 3. Each target is checked from the top (scheme, port, credentials, domain syntax, DNS and
  address range); another scheme or port, credentials in the URL or a fourth redirect is `redirect_rejected`.
- **Limits:** one timeout for the whole fetch, redirects included (20 s for a list, `GH_DOMAIN_FETCH_TIMEOUT_MS` for a TOML file); the
  body is capped at 1 MiB for a list and 256 KiB for a TOML file, counted while it is read, and a `Content-Length` above the cap is
  refused before a byte is read; only status 200 is accepted; no cookies are kept, no `Accept-Encoding` is sent and nothing is
  decompressed; the `User-Agent` is the fixed `gatehub-data-api/<version> (validators)`.
- **No environment agent:** `HTTP_PROXY` and `HTTPS_PROXY` are ignored. Only the tests can replace the resolver, the address policy
  and the CA, through a constructor argument.

Residual: the syncer can be made to send a `GET` to any public host on port 443 (the path is the fixed TOML path, or the configured
publisher URL), and its address is the source of that request. [Deployment](deployment.md#outbound-network-access) says what egress
to allow and recommends blocking the private ranges at the network as well.

## 10. Security checklist

### Implemented

- [x] API-key authentication (two header forms), global, before the rate limit; constant-time comparison.
- [x] Production boot refuses an empty key list and the placeholder keys.
- [x] Key rotation without a flag day: several keys are accepted at once, so clients move to the new key at their own pace. Each
  change of `GH_API_KEYS` restarts the apis, which compose recreates together: a brief 502 per network, not zero downtime (see
  [operations](operations.md#rotate-an-api-key)).
- [x] TLS at the front proxy; the client address recovered by nginx from trusted proxies only and handed on as one address.
- [x] Per-client-and-route rate limit (429), or per listed key (`GH_RATE_LIMIT_KEYS`) and route; case-insensitive path handling.
- [x] Strict hand-written parameter parsers with the original's messages; fully parameterised ClickHouse queries.
- [x] Per-query ClickHouse time and memory guards; bounded windows and limits.
- [x] Ripple-shaped errors; 5xx causes only in logs; `x-powered-by` disabled.
- [x] Secrets via environment; env files git- and docker-ignored; per-service env in compose.
- [x] The npm token is a BuildKit secret, in no layer.
- [x] Containers run as non-root; ClickHouse, Keeper, syncers and metrics are not published; `/internal/` and `/liveliness/` blocked at the edge.
- [x] Outbound HTTPS to arbitrary public hosts (UNL lists, validator TOML files) only through `SafeFetcher`: https on 443 without
  credentials, every resolved address checked against the non-public ranges, the connection pinned to a checked address, redirects
  checked again from the top, one timeout and a body cap enforced while reading, no environment proxy, no environment switch (§9).

### Backlog

- [ ] **Hash API keys at rest** (store digests, not plaintext env values).
- [ ] **Per-key scopes** (rate tiers are covered by `GH_RATE_LIMIT_KEYS`).
- [ ] **Shared (Redis-backed) rate-limit store** for a true global limit across replicas.
- [ ] **Read-only ClickHouse user for the api** and scoped grants for the syncer and migrator.
- [ ] **Guard for a placeholder `GH_CLICKHOUSE_PASSWORD`.**
- [ ] **Count 401/429 in the metrics** (guard rejections are not in `api_http_requests_total`).
- [ ] **Secret scanning and dependency/base-image vulnerability scanning in CI.**
- [ ] **Audit logging** (which key called which endpoint).
- [ ] **Egress policy at the network for the syncer** (deny the private ranges and the metadata address as a second line behind
  `SafeFetcher`; a hostname allowlist is not possible, the validator domains are open-ended).
- [ ] **Narrow the nginx trust defaults** by shipping no default for `TRUSTED_PROXIES` (today: private ranges).
