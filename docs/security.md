# Security

This document describes the security posture of the GateHub XRPL Data API: what is
implemented today, how it is deployed, and what remains on the hardening backlog. It is
written to be **honest about gaps** — where a control is recommended but not yet
implemented, that is called out explicitly.

The system has two runtime components plus a data store:

- **`api`** — a read-only HTTP service (NestJS) that serves XRPL data from ClickHouse and
  proxies a small number of live lookups to an XRPL node.
- **`syncer`** — an internal ingest worker that subscribes to / backfills the XRPL ledger
  and writes into ClickHouse.
- **ClickHouse** (+ ClickHouse Keeper) — the analytical data store.

---

## 1. Threat model & trust boundaries

The service is **not** internet-facing on its own. It is designed to run **behind the
GateHub reverse proxy**, which performs TLS termination and edge routing. ClickHouse, the
ClickHouse Keeper, and the syncer are **internal-only** and are never published to the
public network.

```
                          ┌──────────────────────── public internet ────────────────────────┐
                          │                                                                  │
                          │   client ──HTTPS──► GateHub reverse proxy (TLS termination, edge)│
                          └──────────────────────────────┬───────────────────────────────────┘
                                                         │ HTTP + X-Forwarded-For
   ════════════════════════ trust boundary ═════════════│══════════════════════════════════════
                                                         │ (internal network)
                          ┌──────────────────────────────▼───────────────────────────────────┐
                          │  api  (read replicas, :3001, behind in-cluster nginx/proxy)        │
                          │    │                                  │                            │
                          │    │ HTTP                             │ WSS (outbound)             │
                          │    ▼                                  ▼                            │
                          │  ClickHouse (:8123/:9000) ◄── syncer (:3002, ingest)   XRPL node   │
                          │      ▲                                                              │
                          │      └── ClickHouse Keeper (:9181, coordination)                    │
                          └────────────────────────────────────────────────────────────────────┘
```

**Trust boundary.** The boundary sits at the GateHub reverse proxy. Everything to the
left (the public client and the proxy) is untrusted; everything to the right (the API
replicas, ClickHouse, Keeper, the syncer) is on the internal network and treated as a
trusted zone. The API authenticates clients (API keys) and rate-limits them, but it
trusts the reverse proxy to:

- terminate TLS, and
- set a correct `X-Forwarded-For` so the API can identify the real client IP.

**Assets to protect.** Availability of the read API (the data itself is public XRPL
ledger data, so confidentiality of *responses* is not the primary concern); ClickHouse
integrity and availability; the secrets (API keys, ClickHouse password, NPM token).

**Primary threats considered.**

| Threat | Control |
| --- | --- |
| Unauthenticated access | API-key auth (§2) |
| SQL injection | Fully parameterised queries (§6) |
| Resource exhaustion / abuse | Rate limiting (§5) + per-query CH guards (§6) |
| Info disclosure via errors | RFC 7807 filter, 5xx detail suppressed (§7) |
| Secret leakage | `.env` git-ignored, secrets-manager injection (§8) |
| Direct ClickHouse access | CH not published to the network (§9) |

**Known residual risks** (not yet mitigated): single trust level / no per-key scopes
(§3), API keys stored in plaintext at rest (§2), rate limiting is per-replica not global
(§5), and the `NPM_TOKEN` build-arg is baked into an image layer (§8). These are tracked
in §10.

---

## 2. Authentication

Authentication is by **static API key**, enforced globally by `ApiKeyGuard`
(`apps/api/src/auth/api-key.guard.ts`), registered as an `APP_GUARD` in
`apps/api/src/app.module.ts`.

**Header forms.** Clients present their key in one of two request headers:

- `X-API-Key: <key>`, or
- `Authorization: Bearer <key>`.

The key is deliberately **not** accepted as a query-string parameter — query params leak
into access logs, browser history, and `Referer` headers.

**Constant-time comparison.** The presented key is compared against every configured key
using `crypto.timingSafeEqual`, with a same-length buffer substituted when lengths differ
(since `timingSafeEqual` requires equal-length inputs). This avoids leaking key length or
content through response timing. A simple `===` comparison is *not* used.

**Open operational paths.** A small allow-list of paths is always reachable without a key,
so health probes and metrics scrapers don't need credentials:

- `^/liveliness/` (health/liveness probes)
- `^/metricz` (Prometheus metrics)
- `^/internal/docs` (Swagger UI / OpenAPI JSON)

**"Auth disabled when no keys" (dev convenience).** If `GH_API_KEYS` is empty, the guard
is a **no-op** and the API is fully open. This makes local/dev work out of the box. To
prevent this from silently shipping to production, `apiConfigFromEnv`
(`apps/api/src/config/api.config.ts`) logs a **loud warning** when keys are empty *and*
`NODE_ENV=production`:

> `GH_API_KEYS is empty in production — the API is UNAUTHENTICATED.`

It does **not** hard-fail, so a deliberately public deployment is still possible — but the
operator is warned.

**Provisioning & rotation.** Keys are supplied via the `GH_API_KEYS` environment variable
as a comma-separated list (e.g. `key_live_aaa,key_live_bbb`). In production these come
from a secrets manager (Vault / AWS Secrets Manager / k8s secrets), never committed (see
§8). Because multiple keys are accepted simultaneously, **rotation is zero-downtime**:
add the new key alongside the old, roll it out to clients, then remove the old key on the
next deploy.

**Honest caveats (current state):**

- **Plaintext at rest.** Keys are read from the environment and compared in plaintext.
  They are not hashed. *Recommended future hardening:* store only a hash (e.g.
  SHA-256/HMAC) and compare hashes, so a leaked env/config does not directly expose usable
  keys. (Backlog item, §10.)
- **No shared key store.** Key validation is in-process per replica; there is no shared
  auth state. All replicas must receive the same `GH_API_KEYS`. This is fine for static
  keys but means revocation requires a config roll-out, not an instant central toggle.

---

## 3. Authorization

There is currently a **single trust level**: any valid API key grants **full read
access** to the entire API surface. The service is read-only, so there is no write/admin
distinction to enforce — but there is also **no per-key scoping** (no notion of "this key
may only read payments", rate-tier per key, or per-key data restrictions).

Per-key scopes/roles are **future work** (§10). Until then, treat every issued key as
equivalent to every other key in terms of access.

---

## 4. Transport security

**TLS is terminated at the GateHub reverse proxy.** The API process itself speaks plain
**HTTP** on its internal port (default `3001`); it does not manage certificates. This is
intentional for a service that always runs behind the edge proxy.

Because the app sits behind a proxy, Express `trust proxy` is configured in
`apps/api/src/main.ts` from `GH_TRUST_PROXY_HOPS` (default `1` — the GateHub proxy). This
makes `req.ip` resolve to the real client IP from `X-Forwarded-For`, which is required for
correct per-client rate limiting (§5) and logging.

**Operational note:** `trustProxyHops` must match the actual number of trusted proxy hops.
If it is set too high, a client could spoof `X-Forwarded-For` and impersonate another
client IP (defeating rate limiting and poisoning logs). Keep it equal to the count of
proxies you actually control in front of the service.

---

## 5. Rate limiting & abuse protection

Rate limiting uses `@nestjs/throttler` (`ThrottlerModule` in
`apps/api/src/app.module.ts`, `ThrottlerGuard` registered as an `APP_GUARD`).

- **Default limit:** `600` requests per `60` second window per client
  (`GH_RATE_LIMIT` / `GH_RATE_LIMIT_WINDOW`).
- **Keying:** because `trust proxy` is configured, the throttler keys on the **real client
  IP** from `X-Forwarded-For`, not the proxy's IP.
- **Response:** over-limit requests receive HTTP **429** (rendered as RFC 7807
  problem+json by the global filter, §7).

**Honest caveats:**

- **Per-replica, in-memory.** The default throttler store is in-memory, so each API
  replica counts independently. With *N* replicas behind the proxy the effective global
  limit is up to *N × 600/min* (depending on how the proxy load-balances). This is **not a
  true global limit.**
- **Shared store option.** For a true global limit, the throttler supports a **Redis-backed
  shared store** (`@nest-lab/throttler-storage-redis` or similar). Adopting this is on the
  backlog (§10).
- **Edge proxy.** The GateHub reverse proxy may *also* apply its own rate limiting at the
  edge; the in-app throttler is a defence-in-depth layer, not the only one.

---

## 6. Input validation & injection

**Request validation.** A global `ValidationPipe` is configured in
`apps/api/src/main.ts` with:

- `whitelist: true` — strips properties not declared on the DTO,
- `forbidNonWhitelisted: true` — *rejects* requests carrying unknown properties (does not
  silently drop them),
- `transform: true` + `enableImplicitConversion` — coerces query/path params into typed
  DTO fields,
- `validationError: { target: false }` — keeps the raw input object out of error output.

All endpoints use typed DTOs, so inputs are constrained by type/shape before reaching any
service.

**No SQL injection.** Every ClickHouse query goes through `ClickHouseService.query()` /
`queryOne()` (`packages/shared/src/clickhouse/clickhouse.service.ts`), which **always**
passes user values via `query_params` (ClickHouse server-side bound parameters). User
input is **never** string-interpolated into SQL.

This was verified across the query services. For example, in
`apps/api/src/payments/payments.service.ts` and
`apps/api/src/accounts/accounts.service.ts`, every user-supplied filter is bound with a
typed placeholder:

```sql
WHERE currency = {currency:String}
  AND issuer   = {issuer:String}
  AND date    >= {start:DateTime}
LIMIT {limit:UInt32}
```

with the actual values supplied in the `params` object — never concatenated into the
query string. Pagination keyset clauses likewise emit placeholders and contribute their
values to `params`.

**Table/column names are trusted-source only.** The only parts of a query that are
interpolated are table names (from the `Table` enum) and column lists / sort keys, all of
which are **hard-coded in application code** — they never derive from request input. So
even the non-parameterisable identifiers cannot be influenced by a client.

**Per-query resource guards.** `ClickHouseService` applies `max_execution_time` and
`max_memory_usage` (from `GH_CLICKHOUSE_MAX_EXECUTION_TIME` / `GH_CLICKHOUSE_MAX_QUERY_MEMORY`)
to every SELECT, so a single expensive query is bounded in wall-clock time and memory —
limiting the blast radius of an abusive or pathological request.

---

## 7. Error handling & information disclosure

All errors are rendered as **RFC 7807 `application/problem+json`** by the global
`ProblemDetailsFilter` (`apps/api/src/common/problem-details.filter.ts`), giving a
consistent error shape instead of Nest's ad-hoc default JSON.

- **5xx detail is not leaked.** For any error that is not an `HttpException` (i.e.
  unexpected server errors), the client receives a generic `500` problem document with
  `detail: "An unexpected error occurred."`. The real exception (including stack trace) is
  **logged server-side only**.
- **4xx detail is intentional.** Client errors (400/401/404/429, etc.) return their
  message/validation errors so callers can correct their request.
- **`x-powered-by` is disabled** in `main.ts` (`app.disable('x-powered-by')`), so the
  response does not advertise the framework.

---

## 8. Secrets management

Secrets handled by the system: **API keys** (`GH_API_KEYS`), the **ClickHouse password**
(`GH_CLICKHOUSE_PASSWORD`), the **XRPL node endpoint** (`GH_XRPL_NODE_ENDPOINT`), and the
build-time **`NPM_TOKEN`** for the private `@gatehub` registry.

**Source of truth.** All runtime secrets are provided via environment variables.

- `.env` and `.env.*` are **git-ignored** (`.gitignore`), with only `.env.example` /
  `deploy/.env.prod.example` checked in as templates. `deploy/.env.prod` itself is
  git-ignored and must never be committed.
- `.dockerignore` excludes `**/.env` and `**/.env.*` (except `*.env.example`) so secrets
  are not copied into image build contexts.
- In production, env vars are expected to be **injected from a secrets manager** (Vault /
  AWS Secrets Manager / k8s secrets). The config layer and the env templates both call
  this out. The `prod` compose file consumes them via `--env-file deploy/.env.prod`, which
  in a real deployment should itself be rendered from the secrets manager rather than
  stored on disk.
- Config is **fail-fast**: `apiConfigFromEnv` validates numeric settings and throws on bad
  input at boot, and the compose file requires `GH_CLICKHOUSE_PASSWORD`
  (`${GH_CLICKHOUSE_PASSWORD:?set a ClickHouse password}`) so the stack won't start without
  one.

**`NPM_TOKEN` build-arg caveat (honest gap).** Both `apps/api/Dockerfile` and
`apps/syncer/Dockerfile` take `NPM_TOKEN` as an `ARG` and use it to authenticate `pnpm
install` against the private registry:

```dockerfile
ARG NPM_TOKEN
ENV npm_read_token=$NPM_TOKEN
RUN npm config set "//registry.npmjs.org/:_authToken" "${npm_read_token}"
```

This bakes the token into the **builder layer's history**. The final runtime image is a
fresh `node:20-bookworm-slim` stage that copies only `/app/out` (a multi-stage build, so
the token does not land in the *runtime* image filesystem) — but the token can still be
recovered from the **builder image layers** if that intermediate image is retained or
pushed. *Recommended hardening:* use **BuildKit secrets**
(`RUN --mount=type=secret,id=npm_token ...`) so the token is never written to any layer.
This matters especially for images pushed to a registry. (Backlog, §10.)

**Containers run as non-root.** Both Dockerfiles drop to the unprivileged `node` user
(`USER node`) and `--chown=node:node` the copied app, so the process does not run as root.

---

## 9. Network exposure

In the production topology (`docker-compose.prod.yaml`):

- **ClickHouse is deliberately not published.** The `clickhouse` service exposes no host
  ports — `8123` (HTTP) and `9000` (native) are reachable only on the internal compose
  network. ClickHouse Keeper (`9181`) is likewise internal.
- **The syncer is internal.** It has no published host port; its `3002` health endpoint is
  used only by the in-container healthcheck.
- **The API is not directly published either.** API replicas use `expose: ['3001']` (no
  host port binding, no fixed `container_name`) so they can be scaled with
  `--scale api=N`. Traffic reaches them through the in-cluster `nginx`/proxy, which in turn
  sits behind the GateHub edge proxy. Only that ingress path is reachable.
- **Load-testing override.** `docker-compose.prod.override.yaml` *does* publish ClickHouse
  (`8123:8123`) so a host-side seeder can reach it. This file is **explicitly marked for
  load/perf testing only** and must **not** be used in real production. Using it widens the
  trust boundary to include the host.

**ClickHouse access management** is enabled in the prod compose
(`CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: 1`) with a dedicated `data_api` user rather than
`default`. Tightening that user to least-privilege is on the backlog (§10).

---

## 10. Security checklist / hardening backlog

### Implemented today

- [x] API-key authentication (two header forms), enforced globally.
- [x] Constant-time key comparison (`timingSafeEqual`).
- [x] Loud production warning when auth is disabled (no keys configured).
- [x] Zero-downtime key rotation (multiple keys accepted).
- [x] TLS terminated at the GateHub reverse proxy; `trust proxy` configured.
- [x] Per-client rate limiting (429), keyed on real client IP.
- [x] Global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` + typed DTOs.
- [x] Fully parameterised ClickHouse queries (no SQL injection); identifiers from
      trusted code/enums only.
- [x] Per-query ClickHouse time & memory guards.
- [x] RFC 7807 errors; 5xx detail suppressed; `x-powered-by` disabled.
- [x] Secrets via env / secrets manager; `.env` git-ignored & docker-ignored; fail-fast
      config validation.
- [x] Containers run as non-root (`node` user).
- [x] ClickHouse and Keeper not published to the network in prod.

### Backlog / recommended hardening (not yet implemented)

- [ ] **Hash API keys at rest** — compare hashes instead of plaintext env values.
- [ ] **Per-key scopes / trust levels** — currently any valid key = full read access.
- [ ] **Shared (Redis-backed) rate-limit store** — for a true global limit across replicas.
- [ ] **BuildKit secrets for `NPM_TOKEN`** — stop baking the token into image layers.
- [ ] **Secret-scanning in CI** — catch committed credentials before merge.
- [ ] **Dependency / vulnerability scanning** — automated SCA on the dependency tree and
      base images.
- [ ] **Audit logging** — structured record of authenticated requests (which key, what
      endpoint) for traceability.
- [ ] **ClickHouse user least-privilege** — restrict the `data_api` user to the minimum
      grants (read on the `xrpl` DB for the API; scoped writes for the syncer/migrator).
