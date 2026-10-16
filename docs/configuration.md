# Configuration reference

Every environment variable of the two services, with its default, the service that reads it and what it does. The tables are
checked against the configuration classes by [the check at the end of this page](#keeping-this-page-true). The sources of
truth are
[`apps/api/src/config/api.config.ts`](../apps/api/src/config/api.config.ts),
[`apps/syncer/src/config/syncer.config.ts`](../apps/syncer/src/config/syncer.config.ts),
[`packages/shared/src/clickhouse/clickhouse.config.ts`](../packages/shared/src/clickhouse/clickhouse.config.ts) and
[`packages/shared/src/network/network-profile.ts`](../packages/shared/src/network/network-profile.ts).

## 1. How configuration is loaded

- Every variable is prefixed `GH_`. A class property `fooBar` is read from `GH_FOO_BAR` by the `@gatehub/toolbox`
  `ConfigService` (`@ConfigValue()`); the ClickHouse variables are read by `clickHouseConfigFromEnv`.
- The values are validated at boot. An invalid value (a port that is not a number, an unknown worker name, a node URL that is not
  `ws://` / `wss://`, `GH_NETWORK` other than `xrpl` / `xahau`) prints a message that **names the variable** and stops the
  process with a non-zero exit status. Integers are plain decimal digits: `1.5`, `1e3` and `abc` are rejected.
- An unset or blank variable takes the default of the table. A variable that may be empty (`GH_API_KEYS`, `GH_CORS_ORIGINS`,
  `GH_CACHE_CONTROL`, `GH_WORKERS`) is empty when it is set to the empty string.
- **Env files.** Without `GH_ENV` the toolbox loads `.env` (or `.env.$NODE_ENV` when `NODE_ENV` is set) from the working
  directory and **refuses to start when that file is missing**. That is what you want when running from source
  (`cp apps/api/.env.example apps/api/.env`). In containers the variables come from the environment: the images set
  `NODE_ENV=production` and `GH_ENV=container`, and any non-empty `GH_ENV` skips the file. The `.env` files are git-ignored;
  only the `.env.example` files are committed.
- **One network per process.** `GH_NETWORK` selects the node URLs, the native currency (`XRP` / `XAH`), the CTID network id (0 /
  21337), the markets config and the default ClickHouse database (all in the *network profile*). Run one API and one syncer per
  network; a node whose `network_id` does not match refuses the boot.

## 2. Variables of both services

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_ENV` | unset | Any non-empty value: do not load an env file, the environment is the configuration. Set by both images. |
| `GH_NETWORK` | `xrpl` | `xrpl` or `xahau`. Also read by `migrate` and `range-ingest`. |
| `GH_NODE_ENDPOINTS` | the public endpoints of the network (XRPL `wss://s2.ripple.com,wss://xrplcluster.com`, Xahau `wss://xahau.network`) | Comma separated `ws://` / `wss://` URLs of rippled / xahaud, tried in order with failover. A node that answers with a rate limit (`retry in ~<N>ms`, `slowDown`, `tooBusy`) gets nothing from the process, no request and no connection attempt, for as long as it asked (at most 20 min; 10 s without a hint); another endpoint of the list is used meanwhile. **API:** the live-state endpoints (balances, orders). **Syncer:** the ingest source (and the fee poller). A Xahau process never falls back to an XRPL node. For full-history ingest point it at your own node or at a full-history server such as `wss://s2.ripple.com`. Credentials in a URL are never logged: logs show only `scheme://host:port`. |
| `GH_HTTP_API_PORT` | API `3001`, syncer `3002` | The main HTTP port: the REST API and the probe (API), the probe (syncer). 1-65535. |
| `GH_METRICZ_PORT` | `3000` | Prometheus `GET /metricz` on a second HTTP app. 1-65535. |

## 3. ClickHouse client (API, syncer, `migrate`, `range-ingest`)

Read by `clickHouseConfigFromEnv`. One ClickHouse server holds one database per network.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_CLICKHOUSE_URL` | `http://localhost:8123` | HTTP interface of the server. |
| `GH_CLICKHOUSE_USER` | `default` | |
| `GH_CLICKHOUSE_PASSWORD` | empty | A secret. |
| `GH_CLICKHOUSE_DATABASE` | the network's name (`xrpl` / `xahau`) | Plain lowercase identifier (`^[a-z_][a-z0-9_]*$`): it is written into DDL. |
| `GH_CLICKHOUSE_REQUEST_TIMEOUT` | `30000` | Client request timeout, ms. |
| `GH_CLICKHOUSE_MAX_CONNECTIONS` | `10` | Connections in the client pool. |
| `GH_CLICKHOUSE_MAX_EXECUTION_TIME` | `30` | `max_execution_time` of every SELECT, seconds; 0 = unlimited. Kills runaway queries. |
| `GH_CLICKHOUSE_MAX_QUERY_MEMORY` | `0` | `max_memory_usage` of every SELECT, bytes; 0 = the server's default. |

The numeric ones are parsed with `Number()` and are not range-checked: a typo gives `NaN` and a client that does not work.

## 4. API (`apps/api`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_API_KEYS` | empty | Comma separated API keys, sent as `X-API-Key` or `Authorization: Bearer`. Empty turns authentication **off**, which is for development only: with `NODE_ENV=production` an empty list fails the boot, and so does a placeholder key (`dev-api-key`, or anything starting with `change-me`, case-insensitive). A secret. |
| `GH_CORS_ORIGINS` | empty | `*` or comma separated `http(s)://` origins. Empty sends no CORS headers. |
| `GH_RATE_LIMIT` | `600` | Requests per client address and route per window. |
| `GH_RATE_LIMIT_WINDOW` | `60` | The window, seconds. |
| `GH_TRUST_PROXY_HOPS` | `1` | Reverse-proxy hops whose `X-Forwarded-For` is believed for the client address (the key of the rate limit and the `Link` header's scheme). With the shipped nginx in front, leave it at `1`: nginx hands the API exactly one address. Too high a value lets clients spoof their address. |
| `GH_CACHE_CONTROL` | `public, max-age=60` | `Cache-Control` of successful `/v2/*` responses (printable ASCII); empty sends none. Errors are always `no-store`. |
| `GH_LIVE_CACHE_TTL_MS` | `10000` | How long the live-node answers (balances, orders) are cached in memory; 0 disables the cache. |
| `GH_TX_CACHE_SIZE` | `20000` | Serialized transactions (decoded JSON and binary hex) kept in memory by hash, to spare the codec on repeated requests; a transaction never changes so nothing expires; each entry is a few KB. 0 disables. |
| `GH_SERVICE_NAME`, `GH_SERVICE_DESCRIPTION`, `GH_SERVICE_VERSION` | `data-api`, `Ripple Data API v2 compatible API for XRPL and Xahau, served from ClickHouse.`, the package version | The title of the Swagger document (read by the toolbox bootstrap; the API fills in the defaults). Optional. The syncer has no Swagger and ignores them. |

## 5. Syncer (`apps/syncer`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_VALIDATION_ENDPOINTS` | the value of `GH_NODE_ENDPOINTS` | Nodes the validations collector subscribes to, one client per endpoint (each is a distinct reporter). Use several independent nodes for a good validations picture. |
| `GH_WORKERS` | `ingest,validations,fee_stats,aggregator` | Comma separated subset of the four workers; empty runs none. An unknown name fails the boot (`Unknown worker "x"`). Run **exactly one syncer per network and database**; see [syncer](syncer.md). |
| `GH_SYNC_START_LEDGER` | unset: the validated head at the first boot | Where the very first run starts. **Ignored once the database has a committed ledger.** |
| `GH_LEDGER_FETCH_TIMEOUT_MS` | `120000` | Timeout of one expanded `ledger` request (a busy ledger is big). |
| `GH_CATCHUP_CONCURRENCY` | `4` | Ledgers the **live runner** fetches in parallel while catching up. Observed on the public nodes: `wss://s2.ripple.com` did not throttle a first sync at 2; `wss://xahau.network` throttles even at 1, which the syncer waits out (see [syncer](syncer.md#rate-limits)). Raise it with your own node. It is not read by `range-ingest`, which has its own `--concurrency` flag (default 8; see [backfill](backfill.md#public-nodes-and-rate-limits) for public nodes). |
| `GH_CATCHUP_FLUSH_LEDGERS` | `300` | A catch-up batch is written when it holds this many ledgers ... |
| `GH_CATCHUP_FLUSH_TXS` | `100000` | ... or this many transactions ... |
| `GH_CATCHUP_FLUSH_MS` | `5000` | ... or when its first ledger is this old, whichever comes first. In live mode every ledger is its own commit. |
| `GH_RUN_MIGRATIONS_ON_BOOT` | `false` | Apply the schema before the workers start (`true`/`1`/`false`/`0`). Convenient for a single dev process; the compose files leave it `false` because the `migrate-<network>` job owns the schema. |
| `GH_MAX_LAG_HEALTHY` | `10` | `/liveliness/healthz` answers 503 when the ingest lag (validated head minus committed checkpoint, in ledgers) stays above this for more than 60 s. |
| `GH_MARKETS_CONFIG` | the file shipped as `config/markets/<network>.json` | Path of the markets config (versioned list of trade markets and payment currencies) of the aggregator's volume jobs. Per network: with two syncers use two files. Empty counts as unset. |

## 6. Other variables

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `GH_SCHEMA_DIR` | `migrate` (and `GH_RUN_MIGRATIONS_ON_BOOT`) | the `schema/` folder of the shared package | Directory of the `*.sql` migrations. Only for tests and experiments. |
| `NODE_ENV` | both | `production` in the images | `production` also switches on the keyless-boot guard of the API and makes the toolbox look for `.env.production` unless `GH_ENV` is set. The dev compose runs the API with `NODE_ENV=development` so that its `dev-api-key` is allowed. |
| `NPM_TOKEN` | **build only** | | The npm token of the private `@gatehub/toolbox`. Needed to `pnpm install` and to build the images; it is handed to the build as a BuildKit **secret** (compose `build.secrets`), never as a build argument or environment variable of the image, and is in no layer. See [development](development.md#npm-access). |

## 7. Compose-level variables

These are read by `docker compose` for interpolation, not by the applications. The production compose turns them into the
variables above, per network.

| Variable | Used in | Default | Becomes |
| --- | --- | --- | --- |
| `XRPL_NODE_ENDPOINTS`, `XAHAU_NODE_ENDPOINTS` | prod, dev | `wss://s2.ripple.com,wss://xrplcluster.com`, `wss://xahau.network` | `GH_NODE_ENDPOINTS` of the network's syncer **and** api |
| `XRPL_VALIDATION_ENDPOINTS`, `XAHAU_VALIDATION_ENDPOINTS` | prod, dev | empty (= the node endpoints) | `GH_VALIDATION_ENDPOINTS` of the syncer |
| `XRPL_SYNC_START_LEDGER`, `XAHAU_SYNC_START_LEDGER` | prod, dev | empty (= the validated head) | `GH_SYNC_START_LEDGER` of the syncer |
| `XRPL_MARKETS_CONFIG`, `XAHAU_MARKETS_CONFIG` | prod | empty (= the shipped file) | `GH_MARKETS_CONFIG` of the syncer; the file must be mounted into the container (a commented `volumes:` line shows how) |
| `GH_CLICKHOUSE_USER`, `GH_CLICKHOUSE_PASSWORD` | prod, dev | prod: `data_api` and **required**; dev: `default` and empty | The ClickHouse server's user (`CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`) and the login of every client |
| `GH_API_KEYS` | prod, dev | prod: **required**; dev: `dev-api-key` | `GH_API_KEYS` of the apis |
| `IMAGE_TAG` | prod, dev | prod `latest`, dev `dev` | tag of the locally built `gatehub/data-api` and `gatehub/data-syncer` images |
| `TRUSTED_PROXIES` | prod (nginx) | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Comma separated addresses / CIDRs of the front proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` nginx believes. `0.0.0.0/0` and any zero prefix length are refused. **Set it to your front proxy** (see [security](security.md)). |
| `NGINX_BIND`, `NGINX_PORT` | prod (nginx) | `0.0.0.0`, `8080` | Where nginx is published on the host. Bind it to an interface only the front proxy can reach. |
| `API_CLICKHOUSE_MAX_QUERY_MEMORY` | prod | `2147483648` in `deploy/.env.prod.example`; unset or empty = `GH_CLICKHOUSE_MAX_QUERY_MEMORY` | `GH_CLICKHOUSE_MAX_QUERY_MEMORY` of the **apis** only: a per-query memory cap (bytes) for the API, so a request that needs more fails with its route's 500 instead of taking the server's memory (Ruling R107). The syncers keep `GH_CLICKHOUSE_MAX_QUERY_MEMORY`. |

### Which service gets which variables (production compose)

`docker-compose.prod.yaml` does not hand the whole `deploy/.env.prod` to any container: the file is only the `--env-file` for
interpolation, and each service lists the variables it needs, so a secret reaches only the services that use it. A listed
variable that is unset in the file is not passed on and the application's own default applies.

| Service | Variables it gets |
| --- | --- |
| `migrate-xrpl`, `migrate-xahau` | `GH_CLICKHOUSE_URL`, `_USER`, `_PASSWORD`, `GH_NETWORK` |
| `syncer-xrpl`, `syncer-xahau` | the ClickHouse login and `GH_CLICKHOUSE_DATABASE` (= the network), the optional `GH_CLICKHOUSE_MAX_EXECUTION_TIME`, `_MAX_QUERY_MEMORY`, `_REQUEST_TIMEOUT`, `_MAX_CONNECTIONS`; `GH_NETWORK`; `GH_NODE_ENDPOINTS`, `GH_VALIDATION_ENDPOINTS`, `GH_SYNC_START_LEDGER`, `GH_MARKETS_CONFIG` (from the `XRPL_*` / `XAHAU_*` variables); `GH_WORKERS`, `GH_LEDGER_FETCH_TIMEOUT_MS`, `GH_CATCHUP_*`, `GH_MAX_LAG_HEALTHY`; fixed `GH_RUN_MIGRATIONS_ON_BOOT=false`, `GH_HTTP_API_PORT=3002`, `GH_METRICZ_PORT=3000`. **No** API keys, CORS or rate-limit settings. |
| `api-xrpl`, `api-xahau` | the ClickHouse login and tuning (`GH_CLICKHOUSE_MAX_QUERY_MEMORY` from `API_CLICKHOUSE_MAX_QUERY_MEMORY` when that is set), `GH_CLICKHOUSE_DATABASE`, `GH_NETWORK`, `GH_NODE_ENDPOINTS`; `GH_API_KEYS` (required), `GH_CORS_ORIGINS`, `GH_RATE_LIMIT`, `GH_RATE_LIMIT_WINDOW`, `GH_TRUST_PROXY_HOPS`, `GH_LIVE_CACHE_TTL_MS`, `GH_TX_CACHE_SIZE`, `GH_CACHE_CONTROL`; fixed `GH_HTTP_API_PORT=3001`, `GH_METRICZ_PORT=3000`. |
| `clickhouse` | `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` (from `GH_CLICKHOUSE_USER` / `_PASSWORD`) |
| `nginx` | `TRUSTED_PROXIES`, and the fixed `NGINX_ENVSUBST_*` of the template |

The dev compose ([development](development.md)) takes `GH_CLICKHOUSE_USER`, `GH_CLICKHOUSE_PASSWORD`, `GH_API_KEYS` and the
`XRPL_*` / `XAHAU_*` variables from the environment of your shell, with the development defaults above; it does not read
`apps/*/.env` (those files are for running the apps from source).

## 8. Sensitive values

Treat these as secrets and inject them from a secrets manager (or the environment of the deployment tool), never commit them:
`GH_API_KEYS`, `GH_CLICKHOUSE_PASSWORD`, node endpoints that carry credentials, and `NPM_TOKEN`. The `.env.example` and
`deploy/.env.prod.example` files hold placeholders only (`change-me-...`); the API refuses to start in production with a
placeholder key, but there is no such guard for `GH_CLICKHOUSE_PASSWORD`. Rotation steps are in
[operations](operations.md#routine-tasks).

## 9. Examples

**Local development, from source** (`apps/api/.env` and `apps/syncer/.env`, see the `.env.example` next to each):

```bash
# apps/api/.env
GH_NETWORK=xrpl
GH_API_KEYS=            # empty = no authentication (development only)
GH_CLICKHOUSE_URL=http://localhost:8123

# apps/syncer/.env
GH_NETWORK=xrpl
GH_SYNC_START_LEDGER=   # empty = start at the validated head
GH_CLICKHOUSE_URL=http://localhost:8123
GH_RUN_MIGRATIONS_ON_BOOT=true
```

**Production**, per network, through `deploy/.env.prod` (copy `deploy/.env.prod.example`; the example lists every variable
with a comment):

```bash
GH_CLICKHOUSE_USER=data_api
GH_CLICKHOUSE_PASSWORD=<secret>
GH_API_KEYS=<key1>,<key2>
XRPL_NODE_ENDPOINTS=wss://your-own-node:6006,wss://s2.ripple.com
XRPL_VALIDATION_ENDPOINTS=wss://s1.ripple.com,wss://s2.ripple.com
XAHAU_NODE_ENDPOINTS=wss://xahau.network
TRUSTED_PROXIES=<address of your front proxy>
NGINX_BIND=<interface only the front proxy reaches>
```

## 10. Performance and security knobs

| Concern | Variables |
| --- | --- |
| Query cost and memory | `GH_CLICKHOUSE_MAX_EXECUTION_TIME`, `GH_CLICKHOUSE_MAX_QUERY_MEMORY`, `GH_CLICKHOUSE_MAX_CONNECTIONS` |
| API CPU and latency | `GH_TX_CACHE_SIZE`, `GH_LIVE_CACHE_TTL_MS`, `GH_CACHE_CONTROL` |
| Ingest speed | `GH_CATCHUP_CONCURRENCY` (live runner; `range-ingest --concurrency` for the CLI), `GH_CATCHUP_FLUSH_LEDGERS`, `GH_CATCHUP_FLUSH_TXS`, `GH_CATCHUP_FLUSH_MS`, `GH_LEDGER_FETCH_TIMEOUT_MS`, the node you point at |
| Abuse and exposure | `GH_API_KEYS`, `GH_RATE_LIMIT`, `GH_RATE_LIMIT_WINDOW`, `GH_TRUST_PROXY_HOPS`, `GH_CORS_ORIGINS`, `TRUSTED_PROXIES`, `NGINX_BIND` |
| Health | `GH_MAX_LAG_HEALTHY` |

## Keeping this page true

The variables of sections 2 to 6 are the properties of `ApiConfig` and `SyncerConfig`, the `env.GH_*` reads of
`clickhouse.config.ts` and the few reads in `network-profile.ts`, `migrate.ts` and `service-info.ts`. After changing a config
class, list what the built code reads and compare:

```bash
# works from any directory of the checkout (the root's node_modules has no reflect-metadata: it is resolved from apps/api)
ROOT="$(git rev-parse --show-toplevel)"
(cd "$ROOT" && pnpm build)
node -e "
const path = require('path');
const root = process.argv[1];
require(require.resolve('reflect-metadata', { paths: [path.join(root, 'apps/api')] }));
const names = (Cls) => (Reflect.getMetadata('opts', Cls) || []).map((k) => {
  const e = (k.options && k.options.path) || k.propertyName.replace(/([A-Z])/g, '_\$1').toUpperCase();
  return e.startsWith('GH_') ? e : 'GH_' + e;
});
console.log('api   ', names(require(path.join(root, 'apps/api/dist/config/api.config.js')).ApiConfig).join(' '));
console.log('syncer', names(require(path.join(root, 'apps/syncer/dist/config/syncer.config.js')).SyncerConfig).join(' '));
" "$ROOT"
grep -o 'env\.GH_[A-Z_]*' "$ROOT/packages/shared/src/clickhouse/clickhouse.config.ts" | sort -u
```

Every name printed must have a row in this page (and in the matching `.env.example`), and every `GH_*` name in a row must be
printed or be one of `GH_ENV`, `GH_MARKETS_CONFIG`, `GH_SCHEMA_DIR`, `GH_SERVICE_*`.
