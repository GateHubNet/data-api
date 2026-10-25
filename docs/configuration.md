# Configuration reference

Every environment variable of the two services and the exporter, with its default, the service that reads it and what it does. The tables are
checked against the configuration classes by [the check at the end of this page](#keeping-this-page-true). The sources of
truth are
[`apps/api/src/config/api.config.ts`](../apps/api/src/config/api.config.ts),
[`apps/syncer/src/config/syncer.config.ts`](../apps/syncer/src/config/syncer.config.ts),
[`apps/exporter/src/config/exporter.config.ts`](../apps/exporter/src/config/exporter.config.ts),
[`packages/shared/src/clickhouse/clickhouse.config.ts`](../packages/shared/src/clickhouse/clickhouse.config.ts) and
[`packages/shared/src/network/network-profile.ts`](../packages/shared/src/network/network-profile.ts).

## 1. How configuration is loaded

- Every variable is prefixed `GH_`. A class property `fooBar` is read from `GH_FOO_BAR` by the `@gatehub/toolbox`
  `ConfigService` (`@ConfigValue()`); the ClickHouse variables are read by `clickHouseConfigFromEnv`.
- The values are validated at boot. An invalid value (a port that is not a number, an unknown worker name, a node URL that is not
  `ws://` / `wss://`, `GH_NETWORK` other than `xrpl` / `xahau` / `xrpl-testnet` / `xahau-testnet`) prints a message that
  **names the variable** and stops the process with a non-zero exit status. Integers are plain decimal digits: `1.5`, `1e3` and `abc` are rejected.
- An unset or blank variable takes the default of the table. A variable that may be empty (`GH_API_KEYS`,
  `GH_RATE_LIMIT_KEYS`, `GH_CORS_ORIGINS`, `GH_CACHE_CONTROL`, `GH_WORKERS`, `GH_UNL_PUBLISHERS`, `GH_UNL_VALIDATORS`,
  `GH_AMENDMENTS_CONFIG`) is empty when it is set to the empty string. For `GH_UNL_PUBLISHERS` and `GH_UNL_VALIDATORS` that is
  not the default but a setting of its own: no publishers, no fixed validator list. They have a word for the default, too: the
  value `default` (in any case) is the network's default, exactly as unset is.
- **Env files.** Without `GH_ENV` the toolbox loads `.env` (or `.env.$NODE_ENV` when `NODE_ENV` is set) from the working
  directory and **refuses to start when that file is missing**. That is what you want when running from source
  (`cp apps/api/.env.example apps/api/.env`). In containers the variables come from the environment: the images set
  `NODE_ENV=production` and `GH_ENV=container`, and any non-empty `GH_ENV` skips the file. The `.env` files are git-ignored;
  only the `.env.example` files are committed.
- **One network per process.** `GH_NETWORK` selects the node URLs, the native currency (`XRP` on the XRP Ledger and XRPL Testnet, `XAH`
  on Xahau and Xahau Testnet), the CTID network id (0, 21337, 1 and 21338 for `xrpl`, `xahau`, `xrpl-testnet` and `xahau-testnet`), the
  markets config and the default ClickHouse database (all in the *network profile*). Run one API and one syncer per network; a node
  whose `network_id` is not the one its profile accepts refuses the boot.

## 2. Variables of both services

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_ENV` | unset | Any non-empty value: do not load an env file, the environment is the configuration. Set by both images. |
| `GH_NETWORK` | `xrpl` | `xrpl`, `xahau`, `xrpl-testnet` or `xahau-testnet`; any other value fails the boot with `GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet`. A testnet is a network of its own (its own database and files), and its boot line says `kind=testnet`. Also read by `migrate` and `range-ingest`. |
| `GH_NODE_ENDPOINTS` | the public endpoints of the network (XRPL `wss://s2.ripple.com,wss://xrplcluster.com`, Xahau `wss://xahau.network`, XRPL Testnet `wss://s.altnet.rippletest.net:51233,wss://testnet.xrpl-labs.com`, Xahau Testnet `wss://xahau-test.net`) | Comma separated `ws://` / `wss://` URLs of rippled / xahaud, tried in order with failover. A node that answers with a rate limit (`retry in ~<N>ms`, `slowDown`, `tooBusy`) gets nothing from the process, no request and no connection attempt, for as long as it asked (at most 20 min; 10 s without a hint); another endpoint of the list is used meanwhile. **API:** the live-state endpoints (balances, orders). **Syncer:** the ingest source (and the fee poller). A Xahau process never falls back to an XRPL node. For full-history ingest point it at your own node or at a full-history server such as `wss://s2.ripple.com`. Credentials in a URL are never logged: logs show only `scheme://host:port`. |
| `GH_HTTP_API_PORT` | API `3001`, syncer `3002`, exporter `3005` | The main HTTP port: the REST API and the probe (API), the probe (syncer, exporter). 1-65535. |
| `GH_METRICZ_PORT` | `3000` | Prometheus `GET /metricz` on a second HTTP app. 1-65535. |

## 3. ClickHouse client (API, syncer, `migrate`, `range-ingest`)

Read by `clickHouseConfigFromEnv` (`GH_CLICKHOUSE_SHARED_DATABASE`: `sharedDatabaseFromEnv`). One ClickHouse server holds one database per
network, and the shared database that the apis of every network read ([ADR-0014](adr/0014-address-names-and-labels-in-a-shared-database.md)).

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_CLICKHOUSE_URL` | `http://localhost:8123` | HTTP interface of the server. |
| `GH_CLICKHOUSE_USER` | `default` | |
| `GH_CLICKHOUSE_PASSWORD` | empty | A secret. |
| `GH_CLICKHOUSE_DATABASE` | the database of the network's profile: `xrpl`, `xahau`, `xrpl_testnet`, `xahau_testnet` | Plain lowercase identifier (`^[a-z_][a-z0-9_]*$`): it is written into DDL. |
| `GH_CLICKHOUSE_SHARED_DATABASE` | `shared` (also when empty) | The shared database (account names and labels), on the same server: read by the api, created and migrated by `migrate.js shared` (the `migrate-shared` job). Give every api and the job the same name. A plain lowercase identifier, as above: it is written into the SQL. |
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
| `GH_RATE_LIMIT_KEYS` | empty | Comma separated `key=limit` pairs (a pair splits at its last `=`, so a key may end in `=`). A request made with a listed key is counted per key and route, with that limit per window, instead of per client address: for a trusted server-side client whose requests share addresses (the explorer behind Cloudflare). Every listed key must also be in `GH_API_KEYS`, and the limit is a positive whole number. An invalid setting fails the boot with a message that names the entry by position, never the key. The limit is per API replica (the counts are in memory), so with N replicas the effective limit is up to N times it. A secret. |
| `GH_TRUST_PROXY_HOPS` | `1` | Reverse-proxy hops whose `X-Forwarded-For` is believed for the client address (the key of the rate limit and the `Link` header's scheme). With the shipped nginx in front, leave it at `1`: nginx hands the API exactly one address. Too high a value lets clients spoof their address. |
| `GH_CACHE_CONTROL` | `private, max-age=60` | `Cache-Control` of successful `/v2/*` responses (printable ASCII); empty sends none. Errors are always `no-store`. `private` because the answers are key-gated: a shared cache that ignores the API key would serve them to anybody (Ruling R109); behind a CDN that keys on the API key, `public` is an option. The live answers of `/balances` (the current ledger) and `/orders` send `private, max-age=<GH_LIVE_CACHE_TTL_MS in seconds>` (`no-store` when it is 0) instead (R108). |
| `GH_LIVE_CACHE_TTL_MS` | `10000` | How long the live-node answers (balances at the current ledger, orders) are cached in memory; 0 disables the cache. Their `Cache-Control` follows it: `private, max-age=<it in whole seconds>`, `no-store` at 0. |
| `GH_TX_CACHE_SIZE` | `20000` | Serialized transactions (decoded JSON and binary hex) kept in memory by hash, to spare the codec on repeated requests; a transaction never changes so nothing expires; each entry is a few KB. 0 disables. |
| `GH_AMENDMENTS_CONFIG` | empty: the file shipped as `config/amendments/<family>.json` (`xrpl.json` for XRPL and XRPL Testnet, `xahau.json` for Xahau and Xahau Testnet) | Path of the amendment metadata file (names, descriptions, specifications) behind `/v2/network/amendments`. The syncer reads the same variable ([section 5](#5-syncer-appssyncer)): give both the same file, or the API and the syncer name an amendment differently. Empty counts as the shipped file. |
| `GH_NAMES_AND_LABELS_RELOAD_MS` | `60000` | How often the api loads the account names and labels of the shared database (`GH_CLICKHOUSE_SHARED_DATABASE`) and the account network names of its network database again, ms; a positive integer. A row the operator inserts shows on `/v2/accounts/{address}` within this time ([operations](operations.md#name-an-address)). Each load reads the whole tables, which are small. |
| `GH_EXPORT_BUCKET` | empty | The Google Cloud Storage bucket of the [export](api-reference.md#exports) files, the exporters' `GH_EXPORT_BUCKET`. The api signs the 15-minute download links with the application default credentials (`GOOGLE_APPLICATION_CREDENTIALS`, [section 6](#6-other-variables)). **Empty turns exports off**: `POST /v2/exports` and `GET /v2/exports/{id}` answer 503 `exports are not available`. |
| `GH_EXPORT_MAX_JOBS_PER_KEY` | `3` | The most [exports](api-reference.md#exports) one API key may have queued or running at once; one more answers 429 `too many exports in progress: at most 3 per API key`. A positive integer. |
| `GH_EXPORT_MAX_ROWS_CSV` | `1000000` | The most rows a CSV export holds. An export whose list counts its rows up front (the account transactions by time) and has more answers 400; the exporter, which reads the same variable ([section 5a](#5a-exporter-appsexporter)), fails one whose list turns out longer. Give the api and the exporter of a network the same value. A positive integer. |
| `GH_EXPORT_MAX_ROWS_PDF` | `10000` | The same for a PDF export. |
| `GH_SERVICE_NAME`, `GH_SERVICE_DESCRIPTION`, `GH_SERVICE_VERSION` | `data-api`, `Ripple Data API v2 compatible API for XRPL and Xahau, served from ClickHouse.`, the package version | The title of the Swagger document (read by the toolbox bootstrap; the API fills in the defaults). Optional. The syncer has no Swagger and ignores them. |

## 5. Syncer (`apps/syncer`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_VALIDATION_ENDPOINTS` | the value of `GH_NODE_ENDPOINTS` | Nodes the validations collector subscribes to, one client per endpoint (each is a distinct reporter). Use several independent nodes for a good validations picture. |
| `GH_WORKERS` | `ingest,validations,fee_stats,aggregator,validators` | Comma separated subset of the five workers; empty runs none. An unknown name fails the boot (`Unknown worker "x"`). Run **exactly one syncer per network and database**; see [syncer](syncer.md). |
| `GH_SYNC_START_LEDGER` | unset: the validated head at the first boot | Where the very first run starts. **Ignored once the database has a committed ledger.** |
| `GH_LEDGER_FETCH_TIMEOUT_MS` | `120000` | Timeout of one expanded `ledger` request (a busy ledger is big). |
| `GH_CATCHUP_CONCURRENCY` | `4` | Ledgers the **live runner** fetches in parallel while catching up. Observed on the public nodes: `wss://s2.ripple.com` throttled at 2 in flight (2026-10-18), so use 1 in flight at about 1.5 requests a second or less, or your own node; `wss://xahau.network` throttles even at 1, which the syncer waits out (see [syncer](syncer.md#rate-limits)). Raise it with your own node. It is not read by `range-ingest`, which has its own `--concurrency` flag (default 8; see [backfill](backfill.md#public-nodes-and-rate-limits) for public nodes). |
| `GH_CATCHUP_FLUSH_LEDGERS` | `300` | A catch-up batch is written when it holds this many ledgers ... |
| `GH_CATCHUP_FLUSH_TXS` | `100000` | ... or this many transactions ... |
| `GH_CATCHUP_FLUSH_MS` | `5000` | ... or when its first ledger is this old, whichever comes first. In live mode every ledger is its own commit. |
| `GH_RUN_MIGRATIONS_ON_BOOT` | `false` | Apply the schema before the workers start (`true`/`1`/`false`/`0`). Convenient for a single dev process; the compose files leave it `false` because the `migrate-<network>` job owns the schema. |
| `GH_MAX_LAG_HEALTHY` | `10` | `/liveliness/healthz` answers 503 when the ingest lag (validated head minus committed checkpoint, in ledgers) stays above this for more than 60 s. |
| `GH_MARKETS_CONFIG` | the file shipped as `config/markets/<network>.json` | Path of the markets config (versioned list of trade markets and payment currencies) of the aggregator's volume jobs. Per network: with two syncers use two files. Empty counts as unset. |
| `GH_UNL_PUBLISHERS` | XRPL: `https://vl.ripple.com=ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734,https://unl.xrplf.org=ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1`; Xahau: `https://vl.xahau.org=EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8`; XRPL Testnet: `https://vl.altnet.rippletest.net=ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860`; Xahau Testnet: none (see `GH_UNL_VALIDATORS`) | The validator list publishers of the `validators` worker: comma separated `url=key` pairs, split at the last `=`. The URL is `https://`; the key is 66 hex digits starting `ED`, `02` or `03`; no URL or key twice. The id of a URL (the URL without its scheme and trailing slash) may not be `local`, in any case: that id names the list of `GH_UNL_VALIDATORS`. An invalid entry fails the boot with `GH_UNL_PUBLISHERS entry <n>: <why>`. **Unset, and the value `default` (in any case), take the default of `GH_NETWORK`; set but empty means no publishers**, so with no `GH_UNL_VALIDATORS` either, every validator is untrusted. |
| `GH_UNL_VALIDATORS` | Xahau Testnet: `nHBoJCE3wPgkTcrNPMHyTJFQ2t77EyCAqcBRspFCpL6JhwCm94VZ,nHUVv4g47bFMySAZFUKVaXUYEmfiUExSoY4FzwXULNwJRzju4XnQ,nHBvr8avSFTz4TFxZvvi4rEJZZtyqE3J6KAAcVWVtifsE7edPM7q,nHUH3Z8TRU57zetHbEPr1ynyrJhxQCwrJvNjr4j1SMjYADyW1WWe`; the other networks: empty | A validator list fixed in the configuration, the way a node's `[validators]` section is: comma separated validator public keys in the base58 form (`n…`), each one listed once. Xahau Testnet has no list publisher, and its nodes trust these four keys. The keys count as one list of their own (the publisher `local`) beside the publishers', for the threshold of `GH_UNL_THRESHOLD`. An entry that is not a validator public key fails the boot with `GH_UNL_VALIDATORS entry <n>: must be a validator public key (n…)`, a key listed twice with `GH_UNL_VALIDATORS entry <n>: repeats a key`. **Unset, and the value `default` (in any case), take the default of `GH_NETWORK`; set but empty means no fixed list.** |
| `GH_UNL_THRESHOLD` | `0` | Lists that must name a validator for it to be trusted. `0` is rippled's rule: 1 below three lists, else half of them plus one (rounded down). At most the number of lists (the publishers, plus one when `GH_UNL_VALIDATORS` is not empty), or the boot fails with `GH_UNL_THRESHOLD must be between 0 and the number of lists (<n>)`. One value reaches the syncer of every network (the compose file passes the same `GH_UNL_THRESHOLD` to both), and the bound is each network's own number of lists (XRPL 2, Xahau 1, XRPL Testnet 1 and Xahau Testnet 1 by default), so `2` fails the boot of the Xahau and the testnet syncers: keep `0` (the default rule) unless every network has that many lists. |
| `GH_UNL_REFRESH_MS` | `300000` | Refresh interval of a validator list that gives no `refresh_interval`. At least 1. The wait actually used, from this setting or from a list's `refresh_interval`, is kept between 1 minute and 24 hours: below 60000 means a minute, above 86400000 a day. |
| `GH_DOMAIN_VERIFICATION` | `true` | `true`/`1`/`false`/`0`. `false` skips the checks of the domains validators claim (a host without outbound HTTPS); the domains then show `pending`. |
| `GH_DOMAIN_RECHECK_MS` | `21600000` (6 h) | How long a definite domain result stands before the domain is checked again. At least 1. |
| `GH_DOMAIN_FETCH_TIMEOUT_MS` | `10000` | Overall timeout of one TOML fetch, redirects included. At least 1. |
| `GH_AMENDMENTS_CONFIG` | empty: the file shipped as `config/amendments/<family>.json` (`xrpl.json` for XRPL and XRPL Testnet, `xahau.json` for Xahau and Xahau Testnet) | Path of the amendment metadata file the `validators` worker reads. The API reads the same variable ([section 4](#4-api-appsapi)): give both the same file. Empty counts as the shipped file. |
| `GH_ACCOUNT_ROLLUP_MIN_ROWS` | `1000000` | Balance changes from which an account is **heavy** and gets daily rollups from the `account_rollups` job of the aggregator ([syncer](syncer.md#74-account_rollups)): a read of years of such an account (`stats` and `reports` with `interval`, `analytics/*`) then reads thousands of day groups instead of tens of millions of rows. A whole number in plain digits (`1.5`, `1e6` and `abc` fail the boot, naming the variable). **`0` turns the job off**: the rollups that exist are still used by the API (and corrected after a re-ingest), and simply stop growing. A value below 10,000 behaves like 10,000. The API needs no setting: it reads the state tables. Lower it only to try rollups on a seeded account (see `load/README.md`). |

## 5a. Exporter (`apps/exporter`)

The exporter of a network ([architecture](architecture.md#exporter-appsexporter-gatehubdata-exporter)) reads `GH_NETWORK`
(any of the four names), `GH_HTTP_API_PORT`, `GH_METRICZ_PORT` ([section 2](#2-variables-of-both-services)), the ClickHouse client variables
([section 3](#3-clickhouse-client-api-syncer-migrate-range-ingest)) and these:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_API_URL` | `http://127.0.0.1:3001` | The base URL of the network's api, whose lists the exporter walks (`http://api-xrpl:3001` in the compose files). `http://` or `https://`. |
| `GH_EXPORTER_API_KEY` | empty | The exporter's own API key, sent as `X-API-Key`. It must be one of the api's `GH_API_KEYS`; give it a large budget in the api's `GH_RATE_LIMIT_KEYS`, since a long list is many pages. Empty sends no key (an api without keys, development only). A secret. |
| `GH_EXPORT_BUCKET` | **required** | The Google Cloud Storage bucket of the export files (the api's `GH_EXPORT_BUCKET`); this network's files go under `<network>/`. The boot fails without it. The client uses the application default credentials (`GOOGLE_APPLICATION_CREDENTIALS`). |
| `GH_EXPORT_PAGE_SIZE` | `1000` | The `limit` of each page the exporter asks for, 1-1000. A list serves at most its own maximum. |
| `GH_EXPORT_POLL_MS` | `2000` | How often the exporter looks for a queued job while it has none, ms; at least 100. |
| `GH_EXPORT_REQUEST_TIMEOUT_MS` | `60000` | How long one page may take, ms; at least 1000. A slower page fails the job (`a page of the list took longer than 60 s`). |
| `GH_EXPORT_MAX_ROWS_CSV` | `1000000` | The most rows a CSV export holds: the walk stops at the page that passes it and fails the job (`the list has more than 1000000 rows, the most a CSV export holds: narrow the window`). The api's `GH_EXPORT_MAX_ROWS_CSV`, with the same value. A positive integer. |
| `GH_EXPORT_MAX_ROWS_PDF` | `10000` | The same for a PDF export; its message ends `narrow the window or use CSV`. |

Run **exactly one exporter per network and database**: two would take the same job.

## 6. Other variables

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `GH_SCHEMA_DIR` | `migrate` (and `GH_RUN_MIGRATIONS_ON_BOOT`) | the `schema/` folder of the shared package | Directory of the `*.sql` migrations. Only for tests and experiments. |
| `GOOGLE_APPLICATION_CREDENTIALS` | api (with `GH_EXPORT_BUCKET`), exporter | unset | The path of a Google service account key file, read by the Cloud Storage client (application default credentials). The account needs `storage.objects.create` and `storage.objects.get` on the export bucket; the api signs the links with the key. Without it the client looks for other default credentials (a GKE workload identity, which then needs `iam.serviceAccounts.signBlob` on itself to sign). The key file is a secret. |
| `NODE_ENV` | both | `production` in the images | `production` also switches on the keyless-boot guard of the API and makes the toolbox look for `.env.production` unless `GH_ENV` is set. The dev compose runs the API with `NODE_ENV=development` so that its `dev-api-key` is allowed. |
| `NPM_TOKEN` | **build only** | | The npm token of the private `@gatehub/toolbox`. Needed to `pnpm install` and to build the images; it is handed to the build as a BuildKit **secret** (compose `build.secrets`), never as a build argument or environment variable of the image, and is in no layer. See [development](development.md#npm-access). |

## 7. Compose-level variables

These are read by `docker compose` for interpolation, not by the applications. The production compose turns them into the
variables above, per network.

| Variable | Used in | Default | Becomes |
| --- | --- | --- | --- |
| `XRPL_NETWORK`, `XAHAU_NETWORK` | prod, dev | `xrpl`, `xahau` | `GH_NETWORK` of the slot's migrate job, syncer, api and exporter. `XRPL_NETWORK` is `xrpl` or `xrpl-testnet`, `XAHAU_NETWORK` is `xahau` or `xahau-testnet`: the slot serves its family (nginx routes `xrpl.data.*` to the `xrpl` slot and `xahau.data.*` to the `xahau` slot), so a name of the other family would serve Xahau on the XRPL host. Every app logs its network at boot (`network=xrpl-testnet kind=testnet`) and refuses a node of another network. Production's env file sets neither (`deploy/.env.prod.example` has them commented); `deploy/.env.sandbox.example` sets the testnets. |
| `XRPL_NODE_ENDPOINTS`, `XAHAU_NODE_ENDPOINTS` | prod, dev | empty (= the public endpoints of the network: [`GH_NODE_ENDPOINTS`](#2-variables-of-both-services)) | `GH_NODE_ENDPOINTS` of the network's syncer **and** api. `deploy/.env.prod.example` sets `wss://s2.ripple.com,wss://xrplcluster.com` and `wss://xahau.network`; the sandbox leaves them empty (the testnets' public servers) until GateHub sets its own nodes. |
| `XRPL_VALIDATION_ENDPOINTS`, `XAHAU_VALIDATION_ENDPOINTS` | prod, dev | empty (= the node endpoints) | `GH_VALIDATION_ENDPOINTS` of the syncer. `deploy/.env.prod.example` sets mainnet servers for XRPL; the sandbox file leaves both **empty**, because a mainnet value under a testnet name fails the boot. |
| `XRPL_SYNC_START_LEDGER`, `XAHAU_SYNC_START_LEDGER` | prod, dev | empty (= the validated head) | `GH_SYNC_START_LEDGER` of the syncer |
| `XRPL_MARKETS_CONFIG`, `XAHAU_MARKETS_CONFIG` | prod | empty (= the shipped file) | `GH_MARKETS_CONFIG` of the syncer; the file must be mounted into the container (a commented `volumes:` line shows how) |
| `XRPL_UNL_PUBLISHERS`, `XAHAU_UNL_PUBLISHERS` | prod, dev | empty (= `default`, the publishers of the network) | `GH_UNL_PUBLISHERS` of the syncer. An empty `GH_UNL_PUBLISHERS` would mean "no lists", so compose never passes an empty one on: an empty or unset variable becomes the word `default`, which the syncer reads as the default of its `GH_NETWORK` (the compose file no longer spells out the publishers of one network). |
| `XRPL_UNL_VALIDATORS`, `XAHAU_UNL_VALIDATORS` | prod, dev | empty (= `default`, the network's fixed list) | `GH_UNL_VALIDATORS` of the syncer, by the same rule: empty or unset becomes `default` (Xahau Testnet's four validators; no list on the other networks). |
| `XRPL_AMENDMENTS_CONFIG`, `XAHAU_AMENDMENTS_CONFIG` | prod, dev | empty (= the shipped file) | `GH_AMENDMENTS_CONFIG` of the network's syncer **and** api; the file must be mounted into both containers (a commented `volumes:` line in each shows how) |
| `XRPL_ACCOUNT_ROLLUP_MIN_ROWS`, `XAHAU_ACCOUNT_ROLLUP_MIN_ROWS` | prod, dev | empty (= `1000000`) | `GH_ACCOUNT_ROLLUP_MIN_ROWS` of the network's syncer. Plain digits; empty is the default; `0` turns the `account_rollups` job off |
| `GH_CLICKHOUSE_USER`, `GH_CLICKHOUSE_PASSWORD` | prod, dev | prod: `data_api` and **required**; dev: `default` and empty | The ClickHouse server's user (`CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD`) and the login of every client |
| `GH_API_KEYS` | prod, dev | prod: **required**; dev: `dev-api-key` | `GH_API_KEYS` of the apis |
| `GH_EXPORT_BUCKET` | prod, dev | empty (= exports off) | `GH_EXPORT_BUCKET` of the apis and the exporters |
| `EXPORTER_API_KEY` | prod | empty | `GH_EXPORTER_API_KEY` of both exporters; add it to `GH_API_KEYS` (and `GH_RATE_LIMIT_KEYS`) |
| `XRPL_EXPORTER_API_KEY`, `XAHAU_EXPORTER_API_KEY` | dev | `dev-api-key` | `GH_EXPORTER_API_KEY` of the network's exporter |
| `GOOGLE_APPLICATION_CREDENTIALS_IN_CONTAINER` | dev | empty | `GOOGLE_APPLICATION_CREDENTIALS` of the apis and exporters: the path where a commented `volumes:` line mounts the key file |
| `IMAGE_TAG` | prod, dev | prod `latest`, dev `dev` | tag of the locally built `gatehub/data-api`, `gatehub/data-syncer` and `gatehub/data-exporter` images |
| `TRUSTED_PROXIES` | prod (nginx) | `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | Comma separated addresses / CIDRs of the front proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` nginx believes. `0.0.0.0/0` and any zero prefix length are refused. **Set it to your front proxy** (see [security](security.md)). |
| `NGINX_BIND`, `NGINX_PORT` | prod (nginx) | `0.0.0.0`, `8080` | Where nginx is published on the host. Bind it to an interface only the front proxy can reach. |
| `API_CLICKHOUSE_MAX_QUERY_MEMORY` | prod | `2147483648` in `deploy/.env.prod.example`; unset or empty = `GH_CLICKHOUSE_MAX_QUERY_MEMORY` | `GH_CLICKHOUSE_MAX_QUERY_MEMORY` of the **apis** only: a per-query memory cap (bytes) for the API, so a request that needs more fails with its route's 500 instead of taking the server's memory (Ruling R107). The syncers keep `GH_CLICKHOUSE_MAX_QUERY_MEMORY`. |

### Which service gets which variables (production compose)

`docker-compose.prod.yaml` does not hand the whole `deploy/.env.prod` to any container: the file is only the `--env-file` for
interpolation, and each service lists the variables it needs, so a secret reaches only the services that use it. A listed
variable that is unset in the file is not passed on and the application's own default applies.

| Service | Variables it gets |
| --- | --- |
| `migrate-xrpl`, `migrate-xahau` | `GH_CLICKHOUSE_URL`, `_USER`, `_PASSWORD`, `GH_NETWORK` (from `XRPL_NETWORK` / `XAHAU_NETWORK`) |
| `migrate-shared` | `GH_CLICKHOUSE_URL`, `_USER`, `_PASSWORD`, `GH_CLICKHOUSE_SHARED_DATABASE` |
| `syncer-xrpl`, `syncer-xahau` | the ClickHouse login, the optional `GH_CLICKHOUSE_MAX_EXECUTION_TIME`, `_MAX_QUERY_MEMORY`, `_REQUEST_TIMEOUT`, `_MAX_CONNECTIONS`; `GH_NETWORK`, `GH_NODE_ENDPOINTS`, `GH_VALIDATION_ENDPOINTS`, `GH_SYNC_START_LEDGER`, `GH_MARKETS_CONFIG`, `GH_UNL_PUBLISHERS`, `GH_UNL_VALIDATORS`, `GH_AMENDMENTS_CONFIG`, `GH_ACCOUNT_ROLLUP_MIN_ROWS` (from the `XRPL_*` / `XAHAU_*` variables); `GH_WORKERS`, `GH_LEDGER_FETCH_TIMEOUT_MS`, `GH_CATCHUP_*`, `GH_MAX_LAG_HEALTHY`, `GH_UNL_THRESHOLD`, `GH_UNL_REFRESH_MS`, `GH_DOMAIN_VERIFICATION`, `GH_DOMAIN_RECHECK_MS`, `GH_DOMAIN_FETCH_TIMEOUT_MS`; fixed `GH_RUN_MIGRATIONS_ON_BOOT=false`, `GH_HTTP_API_PORT=3002`, `GH_METRICZ_PORT=3000`. **No** API keys, CORS or rate-limit settings. |
| `api-xrpl`, `api-xahau` | the ClickHouse login and tuning (`GH_CLICKHOUSE_MAX_QUERY_MEMORY` from `API_CLICKHOUSE_MAX_QUERY_MEMORY` when that is set), `GH_NETWORK`, `GH_NODE_ENDPOINTS`, `GH_AMENDMENTS_CONFIG` (from `XRPL_AMENDMENTS_CONFIG` / `XAHAU_AMENDMENTS_CONFIG`); `GH_API_KEYS` (required), `GH_CORS_ORIGINS`, `GH_RATE_LIMIT`, `GH_RATE_LIMIT_WINDOW`, `GH_RATE_LIMIT_KEYS`, `GH_TRUST_PROXY_HOPS`, `GH_LIVE_CACHE_TTL_MS`, `GH_TX_CACHE_SIZE`, `GH_CACHE_CONTROL`, `GH_NAMES_AND_LABELS_RELOAD_MS`, `GH_CLICKHOUSE_SHARED_DATABASE`, `GH_EXPORT_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`, `GH_EXPORT_MAX_JOBS_PER_KEY`, `GH_EXPORT_MAX_ROWS_CSV`, `GH_EXPORT_MAX_ROWS_PDF`; fixed `GH_HTTP_API_PORT=3001`, `GH_METRICZ_PORT=3000`. |
| `exporter-xrpl`, `exporter-xahau` (profile `exports`) | the ClickHouse login and tuning, `GH_NETWORK`, `GH_API_URL` (= `http://api-<network>:3001`); `GH_EXPORTER_API_KEY` (from `EXPORTER_API_KEY`), `GH_EXPORT_BUCKET`, `GOOGLE_APPLICATION_CREDENTIALS`, `GH_EXPORT_PAGE_SIZE`, `GH_EXPORT_POLL_MS`, `GH_EXPORT_REQUEST_TIMEOUT_MS`, `GH_EXPORT_MAX_ROWS_CSV`, `GH_EXPORT_MAX_ROWS_PDF`; fixed `GH_HTTP_API_PORT=3005`, `GH_METRICZ_PORT=3000`. **No** `GH_API_KEYS`. |
| `clickhouse` | `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD` (from `GH_CLICKHOUSE_USER` / `_PASSWORD`) |
| `nginx` | `TRUSTED_PROXIES`, and the fixed `NGINX_ENVSUBST_*` of the template |

**No service gets `GH_CLICKHOUSE_DATABASE`:** the database is the `defaultDatabase` of the network's profile (`xrpl`, `xahau`, `xrpl_testnet`,
`xahau_testnet`), so a slot that runs a testnet writes to the testnet's database whatever else the env file says, and never beside mainnet data.
`GH_NETWORK` is the one variable that picks it. A service takes the variables of its slot: `XRPL_*` for the `*-xrpl` services and `XAHAU_*` for the
`*-xahau` ones. The same file serves the sandbox with `deploy/.env.sandbox` ([deployment](deployment.md#environments)).

The dev compose ([development](development.md)) takes `GH_CLICKHOUSE_USER`, `GH_CLICKHOUSE_PASSWORD`, `GH_API_KEYS` and the
`XRPL_*` / `XAHAU_*` variables from the environment of your shell, with the development defaults above; it does not read
`apps/*/.env` (those files are for running the apps from source).

## 8. Sensitive values

Treat these as secrets and inject them from a secrets manager (or the environment of the deployment tool), never commit them:
`GH_API_KEYS`, `GH_RATE_LIMIT_KEYS` (it holds API keys), `GH_EXPORTER_API_KEY` (`EXPORTER_API_KEY`), the service account key file of
`GOOGLE_APPLICATION_CREDENTIALS`, `GH_CLICKHOUSE_PASSWORD`, node endpoints that carry credentials, and `NPM_TOKEN`. The `.env.example`, `deploy/.env.prod.example` and `deploy/.env.sandbox.example` files hold placeholders only (`change-me-...`); the API refuses to
start in production with a placeholder key, but there is no such guard for `GH_CLICKHOUSE_PASSWORD`. Rotation steps are in
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
| Account aggregates | `GH_ACCOUNT_ROLLUP_MIN_ROWS` (which accounts get rollups; the budgets and cadences of the aggregator jobs are constants, not settings) |
| API CPU and latency | `GH_TX_CACHE_SIZE`, `GH_LIVE_CACHE_TTL_MS`, `GH_CACHE_CONTROL` |
| Ingest speed | `GH_CATCHUP_CONCURRENCY` (live runner; `range-ingest --concurrency` for the CLI), `GH_CATCHUP_FLUSH_LEDGERS`, `GH_CATCHUP_FLUSH_TXS`, `GH_CATCHUP_FLUSH_MS`, `GH_LEDGER_FETCH_TIMEOUT_MS`, the node you point at |
| Abuse and exposure | `GH_API_KEYS`, `GH_RATE_LIMIT`, `GH_RATE_LIMIT_WINDOW`, `GH_RATE_LIMIT_KEYS`, `GH_TRUST_PROXY_HOPS`, `GH_CORS_ORIGINS`, `TRUSTED_PROXIES`, `NGINX_BIND` |
| Health | `GH_MAX_LAG_HEALTHY` |

## Keeping this page true

The variables of sections 2 to 6 are the properties of `ApiConfig`, `SyncerConfig` and `ExporterConfig`, the `env.GH_*` reads of
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
console.log('exporter', names(require(path.join(root, 'apps/exporter/dist/config/exporter.config.js')).ExporterConfig).join(' '));
" "$ROOT"
grep -o 'env\.GH_[A-Z_]*' "$ROOT/packages/shared/src/clickhouse/clickhouse.config.ts" | sort -u
```

Every name printed must have a row in this page (and in the matching `.env.example`), and every `GH_*` name in a row must be
printed or be one of `GH_ENV`, `GH_MARKETS_CONFIG`, `GH_SCHEMA_DIR`, `GH_SERVICE_*`. `GH_AMENDMENTS_CONFIG` is a property of both
classes: both lists print it, and it has a row in section 4 and in section 5. `GH_EXPORT_BUCKET`, `GH_EXPORT_MAX_ROWS_CSV` and
`GH_EXPORT_MAX_ROWS_PDF` are properties of `ApiConfig` and `ExporterConfig`, with a row in section 4 and in section 5a.
