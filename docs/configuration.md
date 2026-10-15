# Configuration Reference

This document is the authoritative reference for every environment variable read by the
GateHub XRPL Data API monorepo. It covers the two runnable services — **`apps/api`** (the
public REST API) and **`apps/syncer`** (the XRPL ingestion worker) — plus the **shared
ClickHouse** configuration that both services consume.

Every variable below is documented exactly as the code reads it. The source of truth is:

- `apps/api/src/config/api.config.ts` — `apiConfigFromEnv()`
- `apps/syncer/src/config/syncer.config.ts` — `syncerConfigFromEnv()`
- `packages/shared/src/clickhouse/clickhouse.config.ts` — `clickHouseConfigFromEnv()`
- `packages/shared/src/constants.ts` — `networkIdFromEnv()` / `NetworkId`

---

## 1. How configuration is loaded

1. **dotenv.** Each service's `src/main.ts` begins with `import 'dotenv/config'`, which loads
   a `.env` file from the **service's working directory** into `process.env` at startup.
   `apps/api` reads `apps/api/.env`; `apps/syncer` reads `apps/syncer/.env`.
2. **Read from `process.env`.** All config factory functions take
   `env: NodeJS.ProcessEnv = process.env` and read named keys (all prefixed `GH_`). The
   config is read **once** at boot and frozen into a strongly-typed object
   (`ApiConfig` / `SyncerConfig` / `ClickHouseConfig`).
3. **Validation / fail-fast.**
   - The **API** validates numerics through `requirePositive(name, raw, fallback)`: an empty or
     unset value falls back to the default; a value that is `NaN` or `< 0` throws a
     `ConfigError` (`Invalid or missing numeric config <NAME>: <raw>`), aborting boot. This
     applies to `GH_HTTP_API_PORT`, `GH_RATE_LIMIT`, `GH_RATE_LIMIT_WINDOW`,
     `GH_LIVE_CACHE_TTL_MS`, and `GH_TRUST_PROXY_HOPS`.
   - The **syncer** requires `GH_XRPL_NODE_ENDPOINT`; if it is missing/empty it throws
     `GH_XRPL_NODE_ENDPOINT is required.` Its numeric helper `num()` is more lenient — an
     empty or `NaN` value becomes `undefined` and falls back to the coded default (it does
     **not** fail-fast on bad numerics, it silently uses the default).
   - The **ClickHouse** config does not fail-fast: it wraps raw values in `Number(...)`, so a
     non-numeric value yields `NaN` (no default substitution beyond the `??` fallback for
     unset/empty).
4. **Production secrets injection.** In production these variables are injected by a secrets
   manager (Vault / AWS Secrets Manager / Kubernetes secrets) — **never committed**. The
   Docker images set `ENV NODE_ENV=production`.
5. **Git hygiene.** `.env` and `.env.*` are git-ignored, **except** `!.env.example`. The
   `.env.example` files (and `deploy/.env.prod.example`) are the committed templates; copy
   them to `.env` / `.env.prod` and fill in real values locally or via your secrets manager.

> Note on `NODE_ENV`: when `NODE_ENV=production` and `GH_API_KEYS` is empty, the API logs a
> loud warning (`GH_API_KEYS is empty in production — the API is UNAUTHENTICATED.`) but does
> **not** hard-fail, so a deliberately public deployment is still possible.

---

## 2. Shared ClickHouse configuration (`GH_CLICKHOUSE_*`)

Read by `clickHouseConfigFromEnv()` in `packages/shared`. **Used by BOTH services.** All
values are passed to the ClickHouse HTTP client; `maxExecutionTime` and `maxQueryMemoryBytes`
are applied as per-query safety caps (defense-in-depth against runaway queries / OOM).

| Variable | Required? | Default | Description |
|---|---|---|---|
| `GH_CLICKHOUSE_URL` | No | `http://localhost:8123` | ClickHouse HTTP endpoint URL. |
| `GH_CLICKHOUSE_USER` | No | `default` | ClickHouse username (`username` in config). |
| `GH_CLICKHOUSE_PASSWORD` | No | `` (empty) | ClickHouse password. **Sensitive** — inject from a secrets manager in production. |
| `GH_CLICKHOUSE_DATABASE` | No | `xrpl` / `xahau` (the `GH_NETWORK` profile's default) | Database name. Must match `^[a-z_][a-z0-9_]*$`, otherwise startup fails. |
| `GH_CLICKHOUSE_REQUEST_TIMEOUT` | No | `30000` | HTTP request timeout in **ms**. (`.env.example`: API uses `30000`, syncer uses `60000`.) |
| `GH_CLICKHOUSE_MAX_CONNECTIONS` | No | `10` | Max concurrent HTTP connections in the client pool (`maxOpenConnections`). (`.env.example`: API `10`, syncer `20`.) |
| `GH_CLICKHOUSE_MAX_EXECUTION_TIME` | No | `30` | Per-query wall-clock cap in **seconds**. `0` = unlimited / server default. Kills runaway queries. |
| `GH_CLICKHOUSE_MAX_QUERY_MEMORY` | No | `0` | Per-query memory cap in **bytes** (`maxQueryMemoryBytes`). `0` = use server default. Defends against OOM. |

> These are read via `??` (unset/empty → default) and then `Number(...)`. A non-numeric
> value for the numeric fields produces `NaN` (no fail-fast), so keep them numeric.

---

## 3. API service (`apps/api`)

Read by `apiConfigFromEnv()` in `apps/api/src/config/api.config.ts`. All numeric fields are
validated by `requirePositive` (fail-fast on `NaN` or negative). Plus the shared ClickHouse
vars from §2.

| Variable | Required? | Default | Description |
|---|---|---|---|
| `GH_HTTP_API_PORT` | No | `3001` | HTTP port for the REST API, Swagger docs (`/internal/docs`), and metrics (`/metricz`). Numeric, fail-fast. |
| `GH_CORS_ORIGINS` | No | `` (empty → CORS disabled) | Comma-separated list of allowed CORS origins. Trimmed; empties filtered. If empty, `enableCors` is **not** called (no CORS headers). |
| `GH_API_KEYS` | No (but see note) | `` (empty → auth disabled) | Comma-separated accepted API keys. Clients send one as `X-API-Key:` or `Authorization: Bearer`. Empty array = authentication disabled (dev only). Empty in `production` logs a warning. **Sensitive.** |
| `GH_RATE_LIMIT` | No | `120` (code) / `600` (`.env.example`) | Per-client request budget per window. Numeric, fail-fast. |
| `GH_RATE_LIMIT_WINDOW` | No | `60` | Rate-limit window in **seconds**. Numeric, fail-fast. |
| `GH_TRUST_PROXY_HOPS` | No | `1` | Number of reverse-proxy hops to trust for `X-Forwarded-For` (Express `trust proxy`). The service runs behind the GateHub proxy (TLS termination); `1` trusts that single hop. Numeric, fail-fast. |
| `GH_LIVE_CACHE_TTL_MS` | No | `10000` | TTL (ms) for cached live-XRPL responses (account balances / open orders). `0` disables caching. Numeric, fail-fast. |
| `GH_XRPL_NODE_ENDPOINT` | No | `wss://xrplcluster.com` | XRPL node used for live account state (balances, open orders). |

### Service / logger / runtime variables (used by `@gatehub/toolbox` + Nest)

These appear in `apps/api/.env.example` and are consumed by the GateHub toolbox
logger/bootstrap layer and Nest's standard runtime (they are **not** read by
`apiConfigFromEnv()` directly, so no in-repo default is coded for them):

| Variable | Required? | Default (template) | Description |
|---|---|---|---|
| `GH_SERVICE_NAME` | No | `data-api` | Service name used in logs / metrics / OpenAPI metadata. |
| `GH_SERVICE_VERSION` | No | `0.0.1` | Service version label. |
| `GH_SERVICE_DESCRIPTION` | No | `GateHub XRPL Data API` | Human-readable service description. |
| `GH_LOGGER_FORMAT` | No | `pretty` (dev) / `structured` (prod) | Log output format. |
| `GH_LOGGER_LEVEL` | No | `debug` (dev) / `info` (prod) | Minimum log level. |
| `NODE_ENV` | No | `production` (set by Dockerfile) | Standard Node env. Drives the empty-`GH_API_KEYS` production warning and Nest behavior. |

> **Open (unauthenticated) paths:** regardless of `GH_API_KEYS`, the API key guard always
> allows `/liveliness/*`, `/metricz`, and `/internal/docs*`.

---

## 4. Syncer service (`apps/syncer`)

Read by `syncerConfigFromEnv()` in `apps/syncer/src/config/syncer.config.ts`. Numeric fields
use the lenient `num()` helper (unset/empty/`NaN` → coded default). Plus the shared ClickHouse
vars from §2.

| Variable | Required? | Default | Description |
|---|---|---|---|
| `GH_XRPL_NODE_ENDPOINT` | **Yes** | — (throws if missing/empty) | XRPL node WebSocket endpoint to fetch ledgers from. A mainnet full-history node is recommended for a long backfill. |
| `GH_XRPL_NETWORK_ID` | No | `0` (Mainnet) | XRPL network ID used when computing CTIDs. `NetworkId`: `0`=Mainnet, `1`=Testnet, `2`=Devnet. Also read independently by `networkIdFromEnv()` (defaults to `NetworkId.Mainnet`). |
| `GH_RUN_MIGRATIONS_ON_BOOT` | No | `true` | Run schema migrations on boot. **Disabled only by the literal string `false`** (`!== 'false'`); any other value (including unset) = `true`. All DDL is `IF NOT EXISTS`, so it is safe. |
| `GH_BACKFILL_ENABLED` | No | `false` (code) / `true` (`.env.example`) | Enable historical backfill. **Enabled only by the literal string `true`** (`=== 'true'`). |
| `GH_BACKFILL_START_LEDGER` | No | `undefined` | First ledger of the backfill range (inclusive). Numeric; empty → `undefined`. |
| `GH_BACKFILL_END_LEDGER` | No | `undefined` | Last ledger of the backfill range (inclusive). Numeric; empty → `undefined`. |
| `GH_BACKFILL_WORKERS` | No | `8` (code) / `12` (`.env.example`) | Concurrent ledger fetchers. Raise with your own node; public clusters need fewer. |
| `GH_BACKFILL_BATCH_LEDGERS` | No | `500` (code) / `1000` (prod example) | Buffer this many ledgers before one batched INSERT per table. Fewer, bigger writes reduce ClickHouse load and avoid "too many parts". 500–2000 is a good range. |
| `GH_BACKFILL_SHARD_INDEX` | No | `0` | This instance's slice index when sharding the range across N instances (`shardIndex`). Instance *i* sets `SHARD_INDEX=i`. |
| `GH_BACKFILL_SHARD_TOTAL` | No | `1` | Total number of shards/instances (`shardTotal`); the `[start,end]` range is split into N contiguous slices. |
| `GH_SUBSCRIBE_LIVE` | No | `false` (code) / `true` (`.env.example`) | Subscribe to live ledgers as they close. **Enabled only by the literal string `true`** (`=== 'true'`). Can run alongside or instead of backfill. |
| `GH_FETCH_THROTTLE_MS` | No | `100` | Throttle (ms) between ledger fetches per worker, to respect node rate limits. Set to `0` when pointing at your own full-history node. |
| `GH_HTTP_API_PORT` | No | `3002` | HTTP port for the liveliness probe (`/liveliness/healthz`) and Prometheus metrics (`/metricz`). Read directly in `main.ts` as `process.env.GH_HTTP_API_PORT ?? 3002`. |

The syncer also reads the same `GH_SERVICE_*` / `GH_LOGGER_*` / `NODE_ENV` toolbox variables
described in §3 (template values: `GH_SERVICE_NAME=data-syncer`,
`GH_SERVICE_DESCRIPTION="GateHub XRPL syncer"`).

> **Boolean parsing gotcha:** `GH_BACKFILL_ENABLED` and `GH_SUBSCRIBE_LIVE` are `true` only
> when set to the exact string `true`. `GH_RUN_MIGRATIONS_ON_BOOT` is the inverse — `false`
> only when set to the exact string `false`.

---

## 5. Sensitive values & secrets-manager guidance

The following must be treated as secrets and **never committed**:

| Secret | Where | Notes |
|---|---|---|
| `GH_API_KEYS` | API runtime | Comma-separated live API keys (e.g. `key_live_aaa,key_live_bbb`). Inject from a secrets manager; rotate periodically. Empty in production = unauthenticated API (logs a warning). |
| `GH_CLICKHOUSE_PASSWORD` | Both services (runtime) | ClickHouse password. Inject from a secrets manager. |
| `NPM_TOKEN` | **Build time only** | npm auth token for the private `@gatehub/toolbox` dependency. Used in `.npmrc` (`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`) and passed to the Docker build as `ARG NPM_TOKEN` / `ENV npm_read_token=$NPM_TOKEN`. It is **not** needed at runtime and must not be baked into the final image layer. |

Guidance:

- `.env` / `.env.*` are git-ignored; only `*.env.example` templates are committed.
- In production, inject all runtime variables (especially the secrets above) from Vault / AWS
  Secrets Manager / Kubernetes secrets. `deploy/.env.prod.example` is a template only — copy
  to `deploy/.env.prod` and fill in, or feed equivalent values from your secrets manager.
- TLS is terminated by the GateHub reverse proxy in front of the API; the API speaks plain
  HTTP and trusts the proxy's `X-Forwarded-For` (see `GH_TRUST_PROXY_HOPS`).

---

## 6. Example environment blocks

### 6.1 Minimal local dev

**`apps/api/.env`**

```dotenv
GH_HTTP_API_PORT=3001
# Auth + CORS disabled for local dev:
GH_API_KEYS=
GH_CORS_ORIGINS=
GH_XRPL_NODE_ENDPOINT=wss://xrplcluster.com

GH_CLICKHOUSE_URL=http://localhost:8123
GH_CLICKHOUSE_USER=default
GH_CLICKHOUSE_PASSWORD=
GH_CLICKHOUSE_DATABASE=xrpl
```

**`apps/syncer/.env`**

```dotenv
GH_HTTP_API_PORT=3002
GH_XRPL_NODE_ENDPOINT=wss://xrplcluster.com   # required
GH_XRPL_NETWORK_ID=0

GH_RUN_MIGRATIONS_ON_BOOT=true
GH_SUBSCRIBE_LIVE=true
GH_BACKFILL_ENABLED=false
GH_FETCH_THROTTLE_MS=100

GH_CLICKHOUSE_URL=http://localhost:8123
GH_CLICKHOUSE_USER=default
GH_CLICKHOUSE_PASSWORD=
GH_CLICKHOUSE_DATABASE=xrpl
```

### 6.2 Production

Inject these from a secrets manager (placeholder secrets shown). Based on
`deploy/.env.prod.example`.

**API (production)**

```dotenv
NODE_ENV=production

# shared ClickHouse
GH_CLICKHOUSE_URL=http://clickhouse:8123
GH_CLICKHOUSE_DATABASE=xrpl
GH_CLICKHOUSE_USER=data_api
GH_CLICKHOUSE_PASSWORD=<from-secrets-manager>
GH_CLICKHOUSE_MAX_CONNECTIONS=10
GH_CLICKHOUSE_MAX_EXECUTION_TIME=30
GH_CLICKHOUSE_MAX_QUERY_MEMORY=0

# API
GH_HTTP_API_PORT=3001
GH_API_KEYS=<from-secrets-manager>          # e.g. key_live_aaa,key_live_bbb
GH_CORS_ORIGINS=https://app.gatehub.net
GH_RATE_LIMIT=600
GH_RATE_LIMIT_WINDOW=60
GH_TRUST_PROXY_HOPS=1
GH_LIVE_CACHE_TTL_MS=10000
GH_XRPL_NODE_ENDPOINT=wss://xrplcluster.com

# logging
GH_LOGGER_FORMAT=structured
GH_LOGGER_LEVEL=info
```

**Syncer (production)**

```dotenv
NODE_ENV=production

# shared ClickHouse
GH_CLICKHOUSE_URL=http://clickhouse:8123
GH_CLICKHOUSE_DATABASE=xrpl
GH_CLICKHOUSE_USER=data_api
GH_CLICKHOUSE_PASSWORD=<from-secrets-manager>
GH_CLICKHOUSE_MAX_CONNECTIONS=20
GH_CLICKHOUSE_REQUEST_TIMEOUT=60000
GH_CLICKHOUSE_MAX_EXECUTION_TIME=30
GH_CLICKHOUSE_MAX_QUERY_MEMORY=0

# syncer
GH_HTTP_API_PORT=3002
GH_XRPL_NODE_ENDPOINT=wss://xrplcluster.com   # required
GH_XRPL_NETWORK_ID=0
GH_RUN_MIGRATIONS_ON_BOOT=true
GH_BACKFILL_ENABLED=true
GH_BACKFILL_START_LEDGER=
GH_BACKFILL_END_LEDGER=
GH_BACKFILL_WORKERS=12
GH_BACKFILL_BATCH_LEDGERS=1000
GH_BACKFILL_SHARD_INDEX=0
GH_BACKFILL_SHARD_TOTAL=1
GH_SUBSCRIBE_LIVE=true
GH_FETCH_THROTTLE_MS=0                          # 0 when using your own full-history node

# logging
GH_LOGGER_FORMAT=structured
GH_LOGGER_LEVEL=info
```

---

## 7. Cross-reference: performance & security knobs

### Performance-affecting variables

| Variable | Service | Effect |
|---|---|---|
| `GH_BACKFILL_WORKERS` | syncer | Concurrent ledger fetchers — more = faster backfill, but more node/CH pressure. |
| `GH_BACKFILL_BATCH_LEDGERS` | syncer | Ledgers buffered per batched INSERT — bigger batches = fewer, larger writes, less CH load. |
| `GH_BACKFILL_SHARD_INDEX` / `GH_BACKFILL_SHARD_TOTAL` | syncer | Horizontal scaling across N instances over contiguous range slices. |
| `GH_FETCH_THROTTLE_MS` | syncer | Per-worker delay between fetches; `0` for your own node, higher for rate-limited public clusters. |
| `GH_CLICKHOUSE_MAX_CONNECTIONS` | both | Client connection pool size. |
| `GH_CLICKHOUSE_REQUEST_TIMEOUT` | both | HTTP request timeout (ms). |
| `GH_CLICKHOUSE_MAX_EXECUTION_TIME` | both | Per-query wall-clock cap (s) — kills runaway queries. |
| `GH_CLICKHOUSE_MAX_QUERY_MEMORY` | both | Per-query memory cap (bytes) — OOM defense. |
| `GH_LIVE_CACHE_TTL_MS` | API | Caches live-XRPL responses; higher = fewer XRPL round-trips. |

### Security-affecting variables

| Variable | Service | Effect |
|---|---|---|
| `GH_API_KEYS` | API | Authentication. Empty = unauthenticated API (warned in production). |
| `GH_CORS_ORIGINS` | API | CORS allowlist; empty disables CORS entirely. |
| `GH_RATE_LIMIT` / `GH_RATE_LIMIT_WINDOW` | API | Per-client rate limiting (client identified via trusted `X-Forwarded-For`). |
| `GH_TRUST_PROXY_HOPS` | API | How many proxy hops to trust for client IP — must match the real proxy depth or rate limiting / logging will use the wrong IP. |
| `GH_CLICKHOUSE_PASSWORD` | both | Database credential (secret). |
| `NPM_TOKEN` | build | Private registry credential (build-time secret). |
| `GH_CLICKHOUSE_MAX_EXECUTION_TIME` / `GH_CLICKHOUSE_MAX_QUERY_MEMORY` | both | Defense-in-depth resource caps limiting the blast radius of abusive/expensive queries. |
