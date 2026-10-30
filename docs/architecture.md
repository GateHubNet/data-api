# Architecture

The GateHub Data API is a **drop-in replacement for the Ripple Data API v2** (`data.ripple.com`, the
`rippled-historical-database` project) for the **XRP Ledger and Xahau** (and the testnet of each), built as a ClickHouse-backed system with two services, an
exporter and a shared library. This page explains the moving parts; the reasons for the big choices are the [ADRs](adr/README.md).

## System diagram

```
                       rippled / xahaud (websocket)  ─ ledger, fee, validations, manifests, server_info, feature
                                     │
                                     ▼
 ┌───────────────────────────────────────────────────────────────────┐
 │ syncer (apps/syncer) — ONE per network                            │
 │   ingest ─ LiveRunner (live + catch-up)   range-ingest CLI        │
 │   validations ─ collector      fee_stats ─ poller                 │
 │   aggregator ─ stats, volumes, AMM pools, rates, markets, rollups │
 │   validators ─ UNL lists, domains (HTTPS), votes, agreement       │
 │   tomls ─ the toml of every domain accounts name (HTTPS)          │
 └──────────────────────────────┬────────────────────────────────────┘
                                │ bulk inserts (ledger tables: children first, `ledgers` row = commit)
                                ▼
                     ClickHouse  (one server, one database per network: xrpl, xahau; xrpl_testnet, xahau_testnet)
                                ▲
                                │ parameterised SELECTs
 ┌──────────────────────────────┴────────────────────────────────────┐
 │ api (apps/api) — N replicas per network, stateless                │   balances / orders:
 │   /v2/*  Ripple-compatible, API key, rate limit, CSV, markers     │──▶ live node (account_info/lines/offers)
 └──────────────────────────────▲────────────────────────────────────┘
                                │ HTTP
              nginx (host routing: xrpl.data.* / xahau.data.*)  ◀── front proxy (TLS)  ◀── clients

 ┌───────────────────────────────────────────────────────────────────┐
 │ exporter (apps/exporter) — ONE per network                        │──▶ api: the list's CSV pages (HTTP, own key)
 │   takes queued export jobs (export_jobs), one at a time           │──▶ Google Cloud Storage: <network>/<id>.csv|.pdf
 └───────────────────────────────────────────────────────────────────┘    (the api signs the download links)
```

Every service runs `GH_NETWORK=` one of four names, `xrpl`, `xahau`, `xrpl-testnet` or `xahau-testnet` (the same images). One
deployment serves one network; the network profile selects the node URLs, the native currency (`XRP` / `XAH`), the CTID network id (0,
21337, 1 and 21338), the `network_id` a node must report to be accepted, the markets config and the default database. A testnet is a network
of its own, with a profile of its own; the profile also names its **family** (`xrpl` or `xahau`: the protocol and software) and its **kind**
(`mainnet` or `testnet`), and the rest of the code branches on exactly one of the three:

| Keyed by | Where |
| --- | --- |
| the **name** (`xrpl-testnet`) | the files of markets (`config/markets/<name>.json`) and binary-codec definitions (`config/definitions/<name>.json`), the ClickHouse database (`xrpl`, `xahau`, `xrpl_testnet`, `xahau_testnet`), `syncer_lease.network`, the export object keys (`<name>/<id>.csv`), the cache keys |
| the **family** (`xrpl`) | the amendment metadata file (`config/amendments/<family>.json`: a testnet reads its family's), the source of the account flags (the XRPL definitions file, or Xahau's hand list) |
| the **kind** (`testnet`) | the reset rule of the live runner (a head below the first indexed ledger halts a testnet only), the boot line (`network=xrpl-testnet kind=testnet`) |

The parsers know no network: `parseContextFor(profile)` hands them the native currency, the CTID network id and the partial-payment cut-off, nothing else. The production stack runs `xrpl`
and `xahau`; the **sandbox** is another stack of the same images on a host and ClickHouse server of its own, running `xrpl-testnet` and
`xahau-testnet`. See [ADR-0009](adr/0009-one-deployment-per-network.md) and its [amendment](adr/0009-one-deployment-per-network.md#amendment-2026-10-24-testnets).

## Components

### Shared library: `packages/shared` (`@gatehub/data-api-shared`)

Everything both services need, written once:

- **`network/`**: `NetworkProfile` per network (four: `xrpl`, `xahau`, `xrpl-testnet`, `xahau-testnet`), the bundled binary-codec definitions
  (`config/definitions/<network>.json`, a fallback for when the node cannot supply `server_definitions`) and the markets config
  (`config/markets/<network>.json`, empty for the testnets). The amendment metadata is a file per **family**
  (`config/amendments/<family>.json`), read by the testnet of the family without its `enabled` entries.
- **`clickhouse/`**: config, the thin typed `ClickHouseService` (bound parameters, per-query guards, synchronous inserts with dedup
  tokens), `Table` enum, row types, the tracked migration runner.
- **`parsers/`** and **`ingest/`**: pure parsers (payments, exchanges, balance changes, accounts created, affected accounts, AMM, path payments, NFTs and URITokens, and the history of escrows, checks, payment channels and delegations) and
  `buildLedgerRows` (a raw ledger -> rows of the 32 ledger-derived tables), the `LedgerSource` interface (`RpcLedgerSource`,
  `FixtureLedgerSource`; a SQLite history importer would be another), `LedgerWriter` and the ingest-state helpers (checkpoint,
  partition-scoped deletes, quiescence).
- **`xrpl/node-client.ts`**: the resilient websocket `NodeClient` (failover, watchdog, re-subscribe), used by the syncer and the API.
- **`query/`**: `RatesService` (exchange rates, vwap, used by the API *and* the aggregator), the daily-rate and account day-group reads of the
  account and market aggregates, and amount/decimal helpers.
- **`tomls/`**: what the display names need of tomls, shared by the syncer's `tomls` worker, the validators checks and the api: `readToml` (what is kept of a
  file), `cleanTomlText`, `accountDomainOf` (the one rule for an account's domain), `countsOn` (which entries count on a network), the store of tomls
  (`recordToml`, `readStoredTomls`) and `ACCOUNT_DOMAINS_SEED_SQL`.
- **`export/`**: the export jobs (`export_jobs`: append, read the current state, the queue) and the storage of their files
  (`ExportStorage`: `GcsExportStorage`, V4 signed links; `MemoryExportStorage` for tests), shared by the api and the exporter.
- **`aggregate/`**: the `stats_hourly`, volume and AMM jobs (`amm_pools`, `amm_daily`) the aggregator runs, and the reads they share
  (`amm-reads.ts`, the windowed fill-forward of pool state in `amm-pools.job.ts`), the jobs of the account and market aggregates
  (`rates_daily`, `pair_hourly`, `markets_live`, `account_rollups`), the NFT jobs (`nft_state`, `nft_collections`, with `foldNftEvents`, the one
  fold of an NFT's events that the job and the API's detail route share, and the prices of sales in `query/nft-prices.ts`) and the `escrows` job (the
  current state of every escrow and the sentinel that holds the escrowed total for D7).

### Syncer: `apps/syncer` (`@gatehub/data-syncer`)

A NestJS process with six optional **workers** (`GH_WORKERS`) and a probe/metrics HTTP surface: `ingest` (the single writer of the
ledger tables, atomic per ledger), `validations`, `fee_stats`, `aggregator`, `validators` (the validator lists of the UNL publishers,
domain verification, the node's amendment state, voting rounds and validator agreement; it makes outbound HTTPS requests to the
publishers and to the validators' domains, [ADR-0012](adr/0012-validators-and-amendments-data.md)) and `tomls` (reads the toml of every domain that an account's
`Domain` field names into `domain_tomls`, over HTTPS and through the same safe fetcher; it needs no node, [ADR-0017](adr/0017-display-names.md)), plus the
`range-ingest` CLI in the same image. Exactly one per network. Details: [syncer](syncer.md).

### API: `apps/api` (`@gatehub/data-api-service`)

A NestJS REST service that reads ClickHouse with parameterised SQL and serves the Ripple Data API contract under `/v2`.

- **Contract layer** (`src/common`): `@RippleController` + `RippleErrorFilter` (every error is `{result:"error", message}` with the
  route's Ripple message; the toolbox's global filter is overridden per controller), `@RippleRoute('<failure message>')` (a 5xx
  becomes the route's message, the cause is logged), hand-written parameter parsers (`params.ts`: booleans, dates, limits;
  `asset-param.ts`: `CUR+issuer`), `pagination.ts` (markers, `Link`), `csv.interceptor.ts`, `format.ts`, and a catch-all `/v2/*` 404
  controller registered last.
- **Cross-cutting services:** `FeatureCoverageService` (`coverage(feature)`: how much of a feature's history the index holds, the program's one coverage rule, [api-reference](api-reference.md#coverage)), `LedgerRangeResolver` (a date -> a ledger range, cached), `TxService` (a stored transaction ->
  the Ripple object, binary codec with the node's definitions, an LRU of serialized forms), `XrplService` (the shared `NodeClient` with
  short API timeouts, for balances and orders), `CacheService`.
- **Guards:** `ApiKeyGuard` (before) `ApiThrottlerGuard` (per client address and route, or per key and route for a key in `GH_RATE_LIMIT_KEYS`); `MetricsInterceptor`.
- **Endpoint modules** (`ledgers`, `transactions`, `payments`, `exchanges`, `accounts` with the analytics routes, `active-accounts`, `network` with the markets route, `amm`,
  `nft`, `names`, `ledger-objects`, `validations`, `validators` with the amendments routes, `stats`, `exports`): see [api-reference](api-reference.md). Ops controllers (`/liveliness/healthz`) are unversioned.
- Boots through the toolbox `bootstrap()`: Swagger at `/internal/docs`, metrics on a second port, validation pipe disabled (it rejects
  unknown query parameters; the Ripple API ignores them), compression, CORS, `trust proxy` applied in `onModuleInit`.

#### The AMM module (`apps/api/src/amm`)

The AMM routes are GateHub extras ([ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md)); a few structural facts matter when you add to them.

- **Route order, and why the pair controller is last.** `AmmModule` lists its controllers as `AmmPoolsController` (the list,
  `:pool/history`, `:pool`), `AmmEventsController` (`:pool/swaps`, `:pool/liquidity`, `:pool/governance`) and **`AmmPairController`
  last**. The pair form `GET /v2/amm/pools/:base/:counter` matches every path of two segments under `pools`, so a route such as
  `/pools/:pool/history` registered after it would be taken for a pair (base the pool, counter `history`). Nest registers routes in the
  order of `controllers`; `amm.module.spec.ts` pins the order, and a new two-segment route under `pools` goes before the pair controller.
- **The events controller reuses the exchanges.** `AmmModule` imports `ExchangesModule`, which exports `ExchangesService`:
  `/pools/:pool/swaps` is `ExchangesService.pair` on the pool's pair with `amm=only` and the pool's account, so the rows, the mapper and
  the markers are the exchange route's. The window of the exchange routes (`start`, `end`, `limit` 200/400, `amm`, `autobridged`,
  `descending`, `marker`) is parsed by `exchanges/exchanges-window.ts`, shared by them and by the swaps route (which passes a reader that
  ignores `amm`).
- **One list of events.** `AMM_LIQUIDITY_EVENTS` in the shared AMM parser is the list of liquidity events the parser writes; the API validates
  the `event` filter and builds the Swagger enum from it (as `GOVERNANCE_TYPES` does for `type`).
- **Object shapes in one file.** `amm/amm-objects.ts` holds every object and its CSV row, with the key order in its header, and
  `amm/amm-positions.ts` the position and the exact division. The account routes (`amm_liquidity`, `amm_positions`) are
  `AccountAmmController` in `AccountsModule`.
- **Existence of a pool.** The pool routes other than detail and pair share `AmmPoolsService.requirePool` (a state row in a committed
  ledger); detail and pair read `amm_pools`, which the aggregator rebuilds.

#### The NFT module (`apps/api/src/nft`)

The NFT routes are GateHub extras ([ADR-0016](adr/0016-nft-and-uritoken-data.md)); the module follows the AMM module's pattern.

- **Controllers and route order.** `NftModule` lists `NftsController` (`v2/nfts/:nft_id`, `/history`, `/offers`), **`NftCollectionListsController`**
  (`:issuer/nfts`, `:issuer/:taxon/nfts`, and the same for `holders`, `sales` and `stats`), then **`NftCollectionsController`** (the list, and
  `:issuer`, `:issuer/:taxon`) and `NftSalesController`. The lists of a collection come before the collection itself: the detail's
  `/:issuer/:taxon` matches every path of two segments, so `/{issuer}/nfts` would be read as a collection of the taxon `nfts`. Nest registers routes in the
  order of `controllers`, and `nft.module.spec.ts` pins the order. `AccountNftsController` (`nfts`, `nft_history`) is in `AccountsModule`, and `nft_volume`
  in the volume controller of `network`.
- **Object shapes in one file.** `nft/nft-objects.ts` holds every object, its key order (the `*_KEYS` constants the tests and
  `nft/api-reference.spec.ts` pin), its CSV columns and the builders; `nft/nft-params.ts` the parameters with their messages in the order of the checks.
- **Coverage.** Every service asks `FeatureCoverageService` for `coverage('nfts')` (`common/coverage-features.ts` registers the feature: its parser
  version and where it starts), or for an NFT's own coverage (`itemCoverage`). A later feature adds an entry there.
- **One fold, one conversion.** The detail route folds the NFT's events with the shared `foldNftEvents`; every price in an answer is converted by
  `convertedSalePrices` (`nftSalesNativeSql`).
- **Reads.** The events are read by `readDistinctPage` (a range of the primary key, the filters inside the capped read), the lists of the aggregates by
  `readNewestPage` (the newest version of each key, again with more room while a filter leaves a page short); both are bounded by `read_rows` tests
  (`paged-reads.e2e-spec.ts`).

#### The ledger objects module (`apps/api/src/ledger-objects`)

The escrow, check, payment channel and delegation routes are GateHub extras ([ADR-0018](adr/0018-ledger-object-history.md)); the module follows the AMM and NFT modules' pattern.

- **Controllers.** `LedgerObjectsModule` lists `EscrowsController` (`v2/escrows/:escrow_id`, `/history`), `ChecksController`, `PaymentChannelsController` and
  `LedgerObjectsController` (`v2/ledger_objects/:object_id`). Every path has the object's segment first and one id after it, so no route shadows another and the order of the
  controllers does not matter. The two routes under `/v2/accounts` are in `AccountsModule`: `AccountEscrowController` (`:address/escrows/:sequence`, which computes the escrow's ID
  from its owner and sequence and answers as the escrow route does) and `AccountDelegationsController` with `DelegationsService`. `app.module.spec.ts` pins the module's place
  before `NotFoundModule`.
- **State at query time.** `LedgerObjectsService` reads `object_changes` by the object's prefix `(object_type, object_id)` with `ledger_index <= H`, `H` being the newest committed
  ledger (`LedgerRangeResolver`, whose close time the answer carries): one page of 51 rows, the creation by a prefix read when it is older than the page, and, for a payment channel, its
  counts. `ObjectAnswers` builds the answers of the three kinds from those reads (the escrow route and the owner-and-sequence route share it), `object-views.ts` maps a row's JSON to the
  response objects (the `*_KEYS` constants that the tests and `ledger-objects/api-reference.spec.ts` pin, and the CSV columns), `object-status.ts` holds the status rules, and
  `object-params.ts` the parsing of an ID. No object is cached.
- **Coverage.** Every service asks `FeatureCoverageService` for the coverage of its feature (`escrows`, `payment_channels`, `checks`, `delegations`; `common/coverage-features.ts`
  registers them: Xahau's start at the network's first ledger, delegation is `unavailable` where `NetworkProfile.hasDelegation` is false) or for an object's own (`itemCoverage`).
- **Delegations** read the account's prefix of `account_object_changes` for `Delegate` and the role, the newest row of each ID and those that are not deleted (at most 10,000
  IDs), then their newest `object_changes` rows 1,000 IDs at a time, and sort and page them in memory.
- **Reads** are bounded by `read_rows` tests (`paged-reads.e2e-spec.ts`, over a bulk of other objects' rows): the object's prefix and `H` on every read.

#### The names module (`apps/api/src/names`)

`GET /v2/account_names` and `GET /v2/toml/{domain}` are GateHub extras ([ADR-0017](adr/0017-display-names.md)). `NamesModule` is in `ENDPOINT_MODULES`
before `NotFoundModule` and owns:

- **`NamesAndLabelsService`**, moved here from `accounts/` (ADR-0014's in-memory sets of names, network names and labels): one instance and one reload
  timer, which `AccountsModule` imports.
- **`AccountDomainsService`**: the current domain of the addresses a call asks, one keyed read of `account_domains` for the distinct addresses
  (`argMax(domain_hex, version)`, never `FINAL`), each answer kept 60 s per address.
- **`DomainTomlsService`**: the *directory* (`domain -> address -> desc` of the entries that count on this network, loaded at start and with the names; a failed
  reload keeps the last one) and `get(domain)`, the newest row of one domain by key, kept 60 s. Before the first load `loaded` is false and no domain is a name.
- **`DisplayNamesService`** puts them together with the pure `displayNameOf` (`display-name.ts`: `verified`, else `account`, else `domain`), and the two
  controllers parse and answer; `account-names-object.ts` and `toml-object.ts` hold the key orders (the `*_KEYS` constants that
  `names/api-reference.spec.ts` pins against the reference). The request-driven keys (the account domain of an address, the row of a domain) live in a cache of
  their own (`NAMES_CACHE`), so that they cannot evict the coverage or amendments keys of the shared one.

### Exporter: `apps/exporter` (`@gatehub/data-exporter`)

A NestJS worker with a probe/metrics HTTP surface, exactly one per network (spec #4, ticket #15). It takes the queued
[export](api-reference.md#exports) jobs of its database one at a time, oldest first, and makes each file by walking the list's own
CSV pages (`format=csv`, `limit`, following `Link`) through the network's api with an API key of its own: every list has one
implementation, and an export is always the list it names. `CsvFile` puts the pages together into the file the route would give
for the whole list in one page (one header, the columns of every page; the rows wait in a spool file under `/tmp`). A renderer
per format (`EXPORT_RENDERERS`) turns it into the file: CSV as it is; PDF (ticket #17) as a landscape A4 document drawn with
`pdfkit` (`renderPdf`), with a header that names the account of an account's list (read from `/v2/accounts/{address}` through
the api) and a table of the columns chosen for the list (`PDF_COLUMNS`, in `apps/exporter/src/pdf-columns.ts`). The file is
uploaded to `<network>/<id>.<format>` in the bucket of `GH_EXPORT_BUCKET`. The job's states are rows of `export_jobs` (`running`, then
`done` or `failed` with why). A shutdown queues the job in hand again; a job a crashed exporter left `running` is failed when the
next one starts. The api queues the jobs (`POST /v2/exports`) and signs the download links (`GET /v2/exports/{id}`).

### ClickHouse

One server, one database per network (`xrpl`, `xahau` in production; `xrpl_testnet`, `xahau_testnet` on the sandbox's own server), 74 tables per database ([data-model](data-model.md)). Pinned to 26.8.14.3. Lists are key-ordered
range reads without `FINAL`; the `ledgers` row is the commit marker; aggregates are tables the aggregator writes, not materialized
views. See [clickhouse](clickhouse.md).

## Data flow

### Write path (ingest)

1. `NodeClient` follows the `ledgerClosed` stream as a **head hint**; the `LiveRunner` always fetches ledgers **by index** (expanded),
   accepts only `validated` ones and checks that each `parent_hash` chains to the previous ledger.
2. `buildLedgerRows(raw, ctx)` (pure) produces the rows of all tables plus the ledger summary row.
3. `LedgerWriter` inserts every child table in parallel, then `ledger_by_hash`, then `ledgers` (the atomic commit), synchronously, with
   dedup tokens.
4. Workers on the side: validations stream -> `validations`/`validator_manifests` (and `validator_validations`, `validator_seen`); `fee` every 5 s
   -> `fee_stats`; the aggregator rolls `ledgers` into `stats_hourly`, computes `volume_*` from `exchanges`/`payments` and rates, rebuilds the AMM
   aggregates (`amm_pools`, `amm_daily`) from the append-only AMM ledger tables and the NFT aggregates (`nfts`, `account_nfts`, `nft_collections`,
   `nft_collection_holders`) from the append-only NFT ledger tables, and keeps the account and market
   aggregates (daily native rates, `pair_hourly` and `markets_live` from `exchanges`, rollups of heavy accounts from `balance_changes`,
   `account_transactions` and `account_exchanges`); the `validators` worker fetches the validator lists and the domains' TOML files, polls the node's amendment state, and computes the voting
   rounds and the hourly agreement from `validations` and `ledgers`.
5. Crashes recover from the database alone: re-read the checkpoint, delete the uncommitted tail, carry on
   ([syncer](syncer.md#checkpoint-boot-and-recovery)).

### Read path (serving)

1. nginx maps the host to the network's api; the guards check the API key and the rate limit.
2. The controller parses and validates the parameters with the original's messages, resolves `start`/`end` to a ledger range,
   queries a key-ordered range (secondary table -> keys -> full rows) with `limit + 1`, builds the Ripple-shaped objects, emits
   `marker` and `Link`, and the CSV interceptor reformats on `format=csv`.
3. Balances and orders are the exception: they read the **live node** (`account_info`, `account_lines`, `account_offers`) and cache the
   answer briefly. Balances at a historical ledger (a hash, a date or a ledger number) are not: they come from the account and trust
   line state history in ClickHouse ([ADR-0015](adr/0015-historical-account-state-from-clickhouse.md)).

## Key design decisions

| Decision | ADR |
| --- | --- |
| ClickHouse as the analytical store | [0001](adr/0001-use-clickhouse.md) |
| No `FINAL` on list queries | [0003](adr/0003-no-final-on-list-queries.md) |
| Opaque marker, ledger-key pagination (supersedes the date keyset) | [0004](adr/0004-keyset-pagination.md) |
| pnpm monorepo with a shared library | [0005](adr/0005-pnpm-monorepo.md) |
| TLS at the front proxy; the client address from `X-Forwarded-For` | [0006](adr/0006-reverse-proxy-tls.md) |
| `ledger_index` axis and narrow secondary tables | [0007](adr/0007-ledger-index-axis-and-secondary-tables.md) |
| No aggregate materialized views | [0008](adr/0008-no-aggregate-materialized-views.md) |
| One deployment per network, and the testnets as networks of their own (profiles with family and kind, the sandbox as a stack of its own, the reset rule) | [0009](adr/0009-one-deployment-per-network.md) |
| Ripple v2 wire compatibility and every deliberate deviation | [0010](adr/0010-ripple-v2-wire-compatibility.md) |
| AMM data, and swaps against pools as exchanges | [0011](adr/0011-amm-data-and-swaps-as-exchanges.md) |
| Validators and amendments data: a worker of its own, agreement over the indexed chain, the safe fetcher, migration 002; the fixed validator list `local` of Xahau Testnet | [0012](adr/0012-validators-and-amendments-data.md) |
| Account and market aggregates: precomputed daily rates, heavy-account rollups, markets from hourly pair stats, migration 003; D2b, the AMM data additions, migration 004 | [0013](adr/0013-account-and-market-aggregates.md) |
| CTID dedup (superseded by the commit marker and dedup tokens) | [0002](adr/0002-ctid-idempotent-ingest.md) |

## Cross-cutting concerns

- **Configuration:** `GH_*` environment variables through the toolbox `ConfigService`, validated at boot
  ([configuration](configuration.md)).
- **Errors:** one shape, Ripple's messages ([api-reference](api-reference.md#errors)); causes of 5xx only in the log.
- **Auth and abuse:** API key on `/v2/*`, in-memory rate limit per client and route, input validation, parameterised SQL
  ([security](security.md)).
- **Observability:** `/liveliness/healthz` and `/metricz` on both services ([observability](observability.md)).
- **Testing:** unit tests, parser golden tests, and Docker-based e2e suites (real ClickHouse via testcontainers, seeded through the real
  `LedgerWriter`) for every endpoint and for the syncer's recovery ([development](development.md#7-testing)).

## Scaling and resilience model

| Tier | Scales | Resilience |
| --- | --- | --- |
| API | Horizontally (stateless; small per-replica caches and rate-limit state) | A replica loss is invisible behind nginx; `GET /liveliness/healthz` gates readiness |
| Syncer | **Does not scale out**: one writer per network (fixed container name + ClickHouse lease). Speed up history with `range-ingest --concurrency` | Crash-safe: the checkpoint is `max(ledgers.ledger_index)`, the uncommitted tail is deleted on boot, the node client reconnects with failover; halts (probe 503) on a chain break, a ledger the parser rejects, or a lost lease |
| ClickHouse | Vertically first; replication needs Keeper-backed engines | Backups; the data is re-derivable from the ledger |

## Why two services

Ingest is a long-lived stateful worker with one writer and backpressure from the node; serving is stateless and elastic. Splitting
them lets the read tier scale and deploy independently, keeps node connections and write load off the request path, and lets a
parser fix be re-run without touching the API.

## Technology summary

| Concern | Choice |
| --- | --- |
| Runtime | Node.js >= 20.19 (images: `node:22.23.2-bookworm-slim`), TypeScript |
| Framework | NestJS 10 with the private `@gatehub/toolbox` (config, bootstrap, logger) |
| Store | ClickHouse 26.8 (`@clickhouse/client`, HTTP) |
| XRPL access | `xrpl` 2.14 (API v1 shape; both rippled and xahaud default to it) behind the shared `NodeClient`; `ripple-binary-codec` 2.x in the API for `binary=true` and canonical JSON |
| Parsing | `ripple-lib-transactionparser` for balance changes, own pure parsers for the rest |
| Packaging | pnpm workspace, Docker (BuildKit secret for the npm token), docker compose |
| Edge | nginx (host routing, trusted-proxy client address), TLS at the front proxy |
| Metrics | `prom-client` -> Prometheus |
