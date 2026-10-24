# Architecture

The GateHub Data API is a **drop-in replacement for the Ripple Data API v2** (`data.ripple.com`, the
`rippled-historical-database` project) for the **XRP Ledger and Xahau**, built as a ClickHouse-backed system with two services and a
shared library. This page explains the moving parts; the reasons for the big choices are the [ADRs](adr/README.md).

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
 └──────────────────────────────┬────────────────────────────────────┘
                                │ bulk inserts (ledger tables: children first, `ledgers` row = commit)
                                ▼
                     ClickHouse  (one server, one database per network: xrpl, xahau)
                                ▲
                                │ parameterised SELECTs
 ┌──────────────────────────────┴────────────────────────────────────┐
 │ api (apps/api) — N replicas per network, stateless                │   balances / orders:
 │   /v2/*  Ripple-compatible, API key, rate limit, CSV, markers     │──▶ live node (account_info/lines/offers)
 └──────────────────────────────▲────────────────────────────────────┘
                                │ HTTP
              nginx (host routing: xrpl.data.* / xahau.data.*)  ◀── front proxy (TLS)  ◀── clients
```

Both services run `GH_NETWORK=xrpl` or `xahau` (the same images). One deployment serves one network; the network profile selects
the node URLs, the native currency (`XRP` / `XAH`), the CTID network id (0 / 21337), the markets config and the default database.
See [ADR-0009](adr/0009-one-deployment-per-network.md).

## Components

### Shared library: `packages/shared` (`@gatehub/data-api-shared`)

Everything both services need, written once:

- **`network/`**: `NetworkProfile` per network, the bundled binary-codec definitions (`config/definitions/<network>.json`, a fallback
  for when the node cannot supply `server_definitions`) and the markets config (`config/markets/<network>.json`).
- **`clickhouse/`**: config, the thin typed `ClickHouseService` (bound parameters, per-query guards, synchronous inserts with dedup
  tokens), `Table` enum, row types, the tracked migration runner.
- **`parsers/`** and **`ingest/`**: pure parsers (payments, exchanges, balance changes, accounts created, affected accounts, AMM) and
  `buildLedgerRows` (a raw ledger -> rows of the 20 ledger-derived tables), the `LedgerSource` interface (`RpcLedgerSource`,
  `FixtureLedgerSource`; a SQLite history importer would be another), `LedgerWriter` and the ingest-state helpers (checkpoint,
  partition-scoped deletes, quiescence).
- **`xrpl/node-client.ts`**: the resilient websocket `NodeClient` (failover, watchdog, re-subscribe), used by the syncer and the API.
- **`query/`**: `RatesService` (exchange rates, vwap, used by the API *and* the aggregator), the daily-rate and account day-group reads of the
  account and market aggregates, and amount/decimal helpers.
- **`aggregate/`**: the `stats_hourly`, volume and AMM jobs (`amm_pools`, `amm_daily`) the aggregator runs, and the reads they share
  (`amm-reads.ts`, the windowed fill-forward of pool state in `amm-pools.job.ts`), and the jobs of the account and market aggregates
  (`rates_daily`, `pair_hourly`, `markets_live`, `account_rollups`).

### Syncer: `apps/syncer` (`@gatehub/data-syncer`)

A NestJS process with five optional **workers** (`GH_WORKERS`) and a probe/metrics HTTP surface: `ingest` (the single writer of the
ledger tables, atomic per ledger), `validations`, `fee_stats`, `aggregator` and `validators` (the validator lists of the UNL publishers,
domain verification, the node's amendment state, voting rounds and validator agreement; it makes outbound HTTPS requests to the
publishers and to the validators' domains, [ADR-0012](adr/0012-validators-and-amendments-data.md)), plus the `range-ingest` CLI in the same image. Exactly one per
network. Details: [syncer](syncer.md).

### API: `apps/api` (`@gatehub/data-api-service`)

A NestJS REST service that reads ClickHouse with parameterised SQL and serves the Ripple Data API contract under `/v2`.

- **Contract layer** (`src/common`): `@RippleController` + `RippleErrorFilter` (every error is `{result:"error", message}` with the
  route's Ripple message; the toolbox's global filter is overridden per controller), `@RippleRoute('<failure message>')` (a 5xx
  becomes the route's message, the cause is logged), hand-written parameter parsers (`params.ts`: booleans, dates, limits;
  `asset-param.ts`: `CUR+issuer`), `pagination.ts` (markers, `Link`), `csv.interceptor.ts`, `format.ts`, and a catch-all `/v2/*` 404
  controller registered last.
- **Cross-cutting services:** `LedgerRangeResolver` (a date -> a ledger range, cached), `TxService` (a stored transaction ->
  the Ripple object, binary codec with the node's definitions, an LRU of serialized forms), `XrplService` (the shared `NodeClient` with
  short API timeouts, for balances and orders), `CacheService`.
- **Guards:** `ApiKeyGuard` (before) `ApiThrottlerGuard` (per client address and route, or per key and route for a key in `GH_RATE_LIMIT_KEYS`); `MetricsInterceptor`.
- **Endpoint modules** (`ledgers`, `transactions`, `payments`, `exchanges`, `accounts` with the analytics routes, `active-accounts`, `network` with the markets route, `amm`,
  `validations`, `validators` with the amendments routes, `stats`): see [api-reference](api-reference.md). Ops controllers (`/liveliness/healthz`) are unversioned.
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

### ClickHouse

One server, one database per network, 50 tables per database ([data-model](data-model.md)). Pinned to 26.8.14.3. Lists are key-ordered
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
   aggregates (`amm_pools`, `amm_daily`) from the append-only AMM ledger tables, and keeps the account and market
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
   answer briefly.

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
| One deployment per network | [0009](adr/0009-one-deployment-per-network.md) |
| Ripple v2 wire compatibility and every deliberate deviation | [0010](adr/0010-ripple-v2-wire-compatibility.md) |
| AMM data, and swaps against pools as exchanges | [0011](adr/0011-amm-data-and-swaps-as-exchanges.md) |
| Validators and amendments data: a worker of its own, agreement over the indexed chain, the safe fetcher, migration 002 | [0012](adr/0012-validators-and-amendments-data.md) |
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
