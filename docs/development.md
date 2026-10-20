# Developer guide

Everything you need to develop on the Data API monorepo: a ClickHouse-backed, Ripple Data API v2 compatible platform for the XRP
Ledger and Xahau, with an **api** that serves it, a **syncer** that fills it, and a **shared** library.

> Runtime and operations docs: [architecture](architecture.md), [data-model](data-model.md), [configuration](configuration.md),
> [syncer](syncer.md), [backfill](backfill.md), [api-reference](api-reference.md), [deployment](deployment.md).

## 1. Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | `>=20.19` (`engines` in the root and api `package.json`; the images use 22) | `ripple-binary-codec` 2.x loads ES-module-only dependencies with `require(esm)`, which Node enables by default from 20.19 / 22.12 |
| pnpm | `10.x` (the repo pins `10.6.3` via `packageManager`) | Workspace package manager (`corepack enable`) |
| Docker | recent, with BuildKit | Local ClickHouse, the compose stacks and the testcontainers-based e2e suites |
| npm access | a token that can read the private `@gatehub/toolbox` | Both apps depend on `@gatehub/toolbox`, which is on the npm registry but private |

```bash
corepack enable
corepack prepare pnpm@10.6.3 --activate
```

### NPM access

`@gatehub/toolbox` is private, so `pnpm install` needs an npm token that can read it. The committed `.npmrc` keeps its auth line
commented out (so installs without a token do not lose the project settings in it) and does not read the token. Two ways to give pnpm
the token, neither of which writes it into the repo:

- you are already logged in to npm on this machine (`npm login`): your user-level `~/.npmrc` holds the token and pnpm uses it; or
- export the token and reference it from your **user-level** `~/.npmrc`:

  ```bash
  export NPM_TOKEN=...                                                    # in your shell profile or a secrets manager
  echo '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' >> ~/.npmrc        # literally ${NPM_TOKEN}: pnpm expands it
  ```

Do not copy the token out of `~/.npmrc` into other files, build arguments or the repo. **Docker builds** take the token from the
`NPM_TOKEN` environment variable as a BuildKit **secret** (`docker compose build`, or `docker build --secret id=npm_token,env=NPM_TOKEN`),
never as a build argument; see [deployment](deployment.md#build).

## 2. Repository layout

A **pnpm workspace** (`pnpm-workspace.yaml`: `apps/*`, `packages/*`):

| Path | Package | Role |
| --- | --- | --- |
| `apps/api` | `@gatehub/data-api-service` | NestJS REST API: the `/v2` Ripple-compatible endpoints over ClickHouse, plus live-node lookups (balances, orders) |
| `apps/syncer` | `@gatehub/data-syncer` | NestJS worker: the five workers `ingest`, `validations`, `fee_stats`, `aggregator` and `validators`, and the `range-ingest` CLI |
| `packages/shared` | `@gatehub/data-api-shared` | ClickHouse client and migration runner, the `Table` enum and row types, parsers, `buildLedgerRows` / `LedgerWriter`, the `NodeClient`, `RatesService`, the aggregation jobs, the network profiles |

`packages/shared` in more detail:

- `src/network/`: `NetworkProfile` for `xrpl` and `xahau`; `config/definitions/<network>.json` (binary-codec definitions, a fallback for when
  the node cannot supply `server_definitions`) and `config/markets/<network>.json` (volume markets) ship next to `dist/`.
- `src/clickhouse/`: `clickhouse.service.ts` (typed wrapper: bound parameters, per-query guards, synchronous inserts with dedup tokens),
  `clickhouse.config.ts`, `migrate.ts`, `tables.ts` (the `Table` enum), `rows.ts` (row types).
- `src/parsers/`, `src/ingest/`: the pure parsers, `build-rows.ts`, `ledger-writer.ts`, `ingest-state.ts`, the `LedgerSource` interface with
  `FixtureLedgerSource`, `raw-ledger.ts`.
- `src/xrpl/node-client.ts`, `src/query/` (rates, decimals, the daily-rate and account day-group reads), `src/aggregate/` (the stats, volume, and account and market jobs), `src/util/`.
- `schema/001_baseline.sql`, `schema/002_validators_amendments.sql`, `schema/003_account_market_aggregates.sql`: the schema (migration units, applied in file-name order; **not** under `src/`).
- `test/` (e2e suites, the shared ClickHouse container helper, fixtures), `scripts/record-fixtures.ts`.

Everything the apps use is re-exported from `packages/shared/src/index.ts`: **export what you add there.**

### Build order

The apps import the compiled `dist/` of the shared package, so build it first. The root `pnpm build` (`pnpm -r build`) respects the graph.
Alone:

```bash
pnpm --filter @gatehub/data-api-shared build
pnpm --filter @gatehub/data-api-service build
```

## 3. First-time setup

```bash
export NPM_TOKEN=...                       # or be logged in to npm, see 1
pnpm install

docker compose up -d clickhouse            # ClickHouse on 127.0.0.1:8123 / 9000 (or: pnpm docker:up)
#   next to another stack: docker compose -p <name> up -d clickhouse, ports via CLICKHOUSE_HTTP_PORT / CLICKHOUSE_NATIVE_PORT

cp apps/api/.env.example    apps/api/.env  # the .env files are git-ignored; the .env.example files are committed
cp apps/syncer/.env.example apps/syncer/.env
#   defaults: GH_NETWORK=xrpl; the syncer example reads from Ripple's full-history server wss://s2.ripple.com (the API example keeps the
#   default nodes wss://s2.ripple.com,wss://xrplcluster.com); GH_API_KEYS is empty (no authentication)

pnpm ch:migrate                            # creates the database of GH_NETWORK (xrpl) and applies the schema

pnpm start:syncer                          # http://localhost:3002 (probe), starts at the validated head
pnpm start:api                             # http://localhost:3001, Swagger at /internal/docs
```

Without `GH_ENV` the toolbox loads `.env` from the working directory (`pnpm --filter` runs from the package folder, where the `.env`
files above live) and refuses to start without it. Try it:

```bash
curl -s localhost:3001/v2/last_validated            # empty database: 500 {"result":"error","message":"unavailable"}; fine until the syncer commits a ledger
curl -s localhost:3001/liveliness/healthz
```

**A second network (Xahau).** Use a second pair of env files (or the compose stack), with `GH_NETWORK=xahau`: the database defaults to
`xahau`, the node to `wss://xahau.network`, the native currency to `XAH`. Run `GH_NETWORK=xahau pnpm ch:migrate` once, and give the second
API and syncer different ports (`GH_HTTP_API_PORT`, `GH_METRICZ_PORT`).

**Everything in containers.** `NPM_TOKEN=... docker compose --profile full up -d --build` brings up ClickHouse, the XRPL migrate job,
syncer and api (add `--profile xahau` for Xahau); see [deployment](deployment.md#option-2-local-development-stack). The ports are
published on 127.0.0.1, the API key is `dev-api-key`, and **an old ClickHouse volume from the previous stack must be recreated**
(`docker compose down -v`: the schema baseline was replaced).

Tear down: `pnpm docker:down`.

## 4. Common commands

From the repo root; `pnpm -r <script>` fans out in dependency order.

| Command | What it does |
| --- | --- |
| `pnpm build` | builds shared (`tsc`), then both apps (`nest build`) |
| `pnpm test` | **unit** tests (`*.spec.ts`) of every package |
| `pnpm --filter @gatehub/data-api-service test:e2e` | API contract e2e tests. **Needs Docker.** |
| `pnpm --filter @gatehub/data-syncer test:e2e` | Syncer recovery/worker e2e tests. **Needs Docker.** |
| `pnpm --filter @gatehub/data-api-shared test:e2e` | Shared e2e tests (migrations, writer, build-rows, rates, aggregation). **Needs Docker.** |
| `pnpm format` | Prettier write over `{apps,packages}/**/src/**/*.ts`. (`pnpm lint` runs `eslint --fix`, but the repo has no ESLint configuration yet, so it does not work.) |
| `pnpm ch:migrate` | applies the schema to the database of `GH_NETWORK` (`ts-node` on `migrate.ts`) |
| `pnpm --filter @gatehub/data-syncer ingest:range --from N --to M` | the range-ingest CLI from source: it runs `dist/`, so `pnpm build` first, and it needs the syncer's `GH_*` environment (`.env` or `GH_ENV=local`) ([backfill](backfill.md)) |
| `pnpm --filter @gatehub/data-api-shared record:fixtures -- --network xrpl --endpoint <wss> --out <dir> ...` | records ledgers as gzipped fixtures. Two more modes record the inputs of the `validators` worker: `--unl --network xrpl\|xahau [--out <dir>]` the validator lists of the network's default publishers (needs no node), and `--network-state --network xrpl\|xahau --endpoint <wss> [--out <dir>] [--ledger <n>]` what the worker asks the node for (the Amendments, NegativeUNL and FeeSettings objects at the validated ledger, or at `--ledger`, which the node must still hold, `server_info` and `feature`) |
| `pnpm --filter @gatehub/data-api-shared amendments:check -- --network xrpl\|xahau [--clickhouse]` | compares the amendment metadata file with a node (and with the database) and exits 1 on a difference ([operations](operations.md#keep-the-amendment-metadata-current)) |
| `pnpm start:api` / `pnpm start:syncer` | `nest start --watch` |
| `pnpm docker:up` / `pnpm docker:down` | start/stop the dev ClickHouse container |

There is no root `test:e2e`: each package spins its own throwaway ClickHouse and runs `--runInBand`.

## 5. Conventions

- **TypeScript strict** (`tsconfig.base.json`); each package extends it. **Prettier** (`.prettierrc`): 120 columns, single quotes, trailing
  commas, organize-imports plugin. Run `pnpm format` before committing.
- **Module per domain.** `apps/api/src/<domain>/` has `<domain>.module.ts`, `.controller.ts`, `.service.ts` and, where the shape is non-trivial,
  `<thing>-object.ts` (+ spec) for the response object. Modules are listed in `ENDPOINT_MODULES` of `app.module.ts`; **the catch-all
  `NotFoundModule` must stay last** (`app.module.spec.ts` guards the order).
- **Ripple contract.** Controllers use `@RippleController('v2/...')` (the `/v2` is part of the route; the app has no global prefix) and
  `@RippleRoute('<failure message>')`; errors are `badRequest('exact ripple message')` / `notFound(...)` from `common/errors.ts`, never a
  generic exception. Parameters are read with the helpers of `common/params.ts` (`first`, `bool`, `limitParam`, `dateParam`, `uintParam`),
  assets with `asset-param.ts`. **Match the original** (`rippled-historical-database`): its messages, defaults, field order. Success bodies
  omit fields that have no value (`compact`); `fmt*` functions take unix **seconds**.
- **Parameterised queries only.** Pass every user-derived value through `query_params` (`{name:Type}` + a params object). Only table names
  (from the `Table` enum, checked by `sql-tables.spec.ts`), fixed column lists and whitelisted expressions are written into SQL.
- **Lists: key-ordered, no `FINAL`.** Read a page with `readDistinctPage` (shared): `ORDER BY` the full table key with a plain
  `LIMIT` in a subquery and the dedupe (`LIMIT 1 BY <key>`) outside it, `limit + 1` rows; never `LIMIT 1 BY` in the SELECT that reads
  the table, which makes ClickHouse read most of the range (Ruling R106). Page with `keysetClause` (it also bounds the first key column,
  which the primary key needs) / `paginate` / `setLinkHeader`; the marker is the base64url of the key of the last row and never a
  DateTime. Resolve `start`/`end` to a ledger range with `LedgerRangeResolver`. See
  [clickhouse](clickhouse.md#reading-a-page-what-stops-the-read).
- **Amounts** are exact decimal strings; sum with the shared decimal helpers, never with floats.
- **Config** lives in `api.config.ts`, `syncer.config.ts` and `clickhouse.config.ts` (`@ConfigValue()` + the helpers of `env-decorators.ts`);
  do not read `process.env` ad hoc in services. Import the toolbox through `@gatehub/toolbox/lib/<module>`, never the package root (the
  root loads database/queue config and exits without `GH_DATABASE_*`).

## 6. How-to guides

### 6a. Add an API endpoint

Mirror a small domain such as `apps/api/src/active-accounts/`.

1. **Service** (`widgets.service.ts`): inject `ClickHouseService` and, for time windows, `LedgerRangeResolver`. Build the `WHERE` with bound
   parameters, add `keysetClause`, read `limit + 1` rows with `readDistinctPage` in the order of the whole key, and `paginate` them:

   ```ts
   const KEYS: KeysetKey[] = [{ column: 'ledger_index', type: 'UInt32' }, { column: 'tx_index', type: 'UInt32' }];
   const ORDER: KeysetKey[] = [{ column: 'owner', type: 'String' }, ...KEYS]; // the table's whole ORDER BY
   const after = decodeMarker(q.marker, KEYS);                       // 400 `invalid marker` before any query
   const range = await this.ranges.resolve(q.start, q.endExclusive);
   const cursor = keysetClause(KEYS, q.descending, after);           // the keys after the columns fixed with `=`
   const rows = await readDistinctPage<Row>(this.ch, {
     columns: 'ledger_index, tx_index, ...',
     table: Table.Widgets,
     where: ['owner = {owner:String}', 'ledger_index BETWEEN {min:UInt32} AND {max:UInt32}', ...(cursor.clause ? [cursor.clause] : [])],
     orderBy: columnsOf(ORDER),   // inner: ORDER BY owner, ledger_index, tx_index LIMIT <page + room>
     unique: columnsOf(KEYS),     // outer: LIMIT 1 BY ledger_index, tx_index LIMIT <page>
     descending: q.descending,
     params: { owner: q.owner, min: range.min, max: range.max, ...cursor.params },
     limit: q.limit + 1,
   });
   const { rows: page, marker } = paginate(rows, q.limit, (r) => [r.ledger_index, r.tx_index]);
   ```

   Add the page to `apps/api/test/paged-reads.e2e-spec.ts` (what it reads over a bulk of four parts) and a plan test
   (`expectBoundedInOrderRead` of `test/support/plans.ts`).

2. **Object** (`widget-object.ts`): the response shape with the keys **in the order of the original**; leave out what is missing.
3. **Controller**: `@RippleController('v2/widgets')`, `@RippleRoute('unable to retrieve widgets')`, optional `@Csv('widgets', 'widgets')`,
   `@ApiOperation` / `@ApiQuery` for Swagger, parse with the `common/params.ts` helpers in the order of the original's checks,
   `setLinkHeader(req, res, page.marker)`, return `{ result: 'success', count, marker, widgets }`.
4. **Module**: declare it and add it to `ENDPOINT_MODULES` (before `NotFoundModule`).
5. **Tests**: unit spec for the object and the parameter parsing, an e2e spec against a seeded database (6c), including the limit clamp,
   descending order, concatenated marker pages equalling the unpaged list, unknown params ignored, the exact error messages, 401 without a key.
6. **Docs**: [api-reference](api-reference.md) (including a "Differences" note if you deviate from the original) and regenerate
   [openapi.yaml](openapi.yaml) (section 8).

### 6b. Add a ClickHouse table or column

1. Add a **new** migration file `packages/shared/schema/NNN_*.sql`, numbered after the last one (now `003_account_market_aggregates.sql`;
   never edit an applied one; `CREATE ... IF NOT EXISTS` or `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and the semicolon of a
   statement must end its last line, no comment line may end with `;`).
2. Add the table to the `Table` enum (`tables.ts`) and its row type to `rows.ts`.
3. For a ledger-derived table: have `buildLedgerRows` produce the rows and add the table to `CHILD_TABLES` (`build-rows.ts`), to
   `LEDGER_KEYED_TABLES` (`ingest-state.ts`, so recovery deletes it; keep its partitioning identical to the DDL) and give it
   `non_replicated_deduplication_window`. Bump `PARSER_VERSION` when the parsers' output changes, and re-ingest with `--reprocess`.
4. Read it from an API service with `${Table.X}`. Apply: `pnpm ch:migrate` locally; the migrate job in compose; the e2e suites apply
   `runMigrations()` themselves.

### 6c. Add or change a parser

1. Parsers are **pure and synchronous**: derive everything from the transaction and its metadata, no I/O, never mutate the input (the
   tests deep-freeze it), take the network from `ParseContext` (native currency, `partialPaymentFixLedger`), never hard-code `XRP`.
2. Feed the result into `buildLedgerRows` and add the golden tests: the snapshot of `build-rows`, key uniqueness per table, every amount
   parses with BigNumber, per-currency balance changes sum to zero except for the fee burn and XAH mint, and the parity tests ported from
   the original's mocha suite.
3. Fixtures: `packages/shared/test/fixtures/{xrpl,xahau}` (`ripple-mock` ledgers from the original, `recorded` ledgers from public nodes;
   `record:fixtures` records more). Tests that need a transaction type skip per type using `recorded/manifest.json`.

### 6d. Add an aggregate

There are no materialized views ([ADR-0008](adr/0008-no-aggregate-materialized-views.md)). Query-time aggregates are plain `GROUP BY`
queries over a bounded, key-ordered range (guard them with a window). A precomputed aggregate is a table the **aggregator** writes: a
`ReplacingMergeTree(version)`, recomputed idempotently (a complete set under one new version; readers keep the highest version), added as a
job in `aggregator.service.ts` with its own budget, and marked via `agg_dirty` when ingest rewrites its inputs.

## 7. Testing

Jest with `ts-jest`, in three layers.

- **Unit tests** (`*.spec.ts`, no Docker): `pnpm test`. Parsers (golden and parity), `build-rows` snapshots, params/pagination/format/CSV,
  response objects, the config classes, the guards, the node client with a fake socket.
- **Contract e2e tests** (`apps/api/test/*.e2e-spec.ts`): one per endpoint. A **real ClickHouse** in Docker (testcontainers) is migrated
  with the real schema and seeded through the real `LedgerWriter` from a `FixtureLedgerSource` (the 54 mock ledgers of the original, or
  the recorded Xahau ledgers); the app runs in-process behind `supertest` (`test/harness.ts`; `TEST_API_KEY` is accepted, the live node
  can be stubbed). Many suites port the assertions of the original's mocha tests as the parity oracle, and the Xahau network is
  exercised too.
- **Recovery e2e tests** (`apps/syncer/test`): fault injection between the child inserts and the commit, an ambiguous timeout after a
  commit, a gap that is filled, `validated:false` retried, a `parent_hash` mismatch that halts, a WS close with a refused reconnect, a
  range-ingest intent that is redone, the aggregator run twice. They use a synthetic contiguous chain built from a mock ledger.
- **Shared e2e tests** (`packages/shared/test`): migrations, the writer, `buildLedgerRows` against real data, rates, the stats and
  volume jobs, the account and market jobs and the day-group and daily-rate reads.

```bash
# Docker must be running
pnpm --filter @gatehub/data-api-shared test:e2e
pnpm --filter @gatehub/data-api-service test:e2e
pnpm --filter @gatehub/data-syncer test:e2e
```

`packages/shared/test/clickhouse-container.ts` starts the pinned `clickhouse/clickhouse-server:26.8.14.3` (override with
`CLICKHOUSE_IMAGE`), waits for `/ping`, and exports the connection into `process.env`. Import `AppModule` only **after** the environment is
set (config is read at module load). Suites run `--runInBand` with a long `testTimeout`. A suite that hangs once in a while on the
container start is an infrastructure flake; a failure that reproduces alone is a bug.

**When you add an endpoint add an e2e suite; when you add a parser add golden/parity tests.** A bug fix starts with a failing test.

## 8. Building, OpenAPI and the images

```bash
pnpm build
```

`docs/openapi.yaml` is generated from the running app (the Swagger decorators of the controllers). There is no `swagger` script:

```bash
pnpm --filter @gatehub/data-api-shared build && pnpm --filter @gatehub/data-api-service build
env -i PATH="$PATH" NODE_ENV=development GH_ENV=container GH_API_KEYS=any GH_CLICKHOUSE_URL=http://127.0.0.1:1 \
  GH_HTTP_API_PORT=23001 GH_METRICZ_PORT=23000 node apps/api/dist/main.js &        # boots without a reachable ClickHouse
curl -s http://127.0.0.1:23001/internal/docs-json | ruby -ryaml -rjson -e 'puts JSON.parse(STDIN.read).to_yaml' > /tmp/openapi.yaml
kill %1                                                                           # then keep the header comment of docs/openapi.yaml on top of /tmp/openapi.yaml
```

At runtime the API serves Swagger UI at `/internal/docs` and the JSON at `/internal/docs-json` (the shipped nginx does not expose them).

Images: [deployment](deployment.md#build). The npm token is a BuildKit secret (`NPM_TOKEN` in the environment), not a build argument.

## 9. Gotchas

**a. TypeScript incremental builds vs `nest build --deleteOutDir`.** `apps/*/nest-cli.json` sets `deleteOutDir`. With incremental builds / a stale
`*.tsbuildinfo` the compiler can believe the output is up to date after the folder was wiped and skip emit, leaving an empty `dist`.
`*.tsbuildinfo` is git- and docker-ignored; if a build looks stale delete `dist` and any `*.tsbuildinfo`.

**b. Docker: install + build + deploy in one `RUN`.** pnpm workspace symlinks do not survive across BuildKit layers, so the Dockerfiles run
`pnpm install && build && pnpm deploy` in a single `RUN`. `pnpm deploy` on pnpm 10 needs `--legacy`. Inside the image the shared package
is `node_modules/@gatehub/data-api-shared` (so the migrate command is `node node_modules/@gatehub/data-api-shared/dist/clickhouse/migrate.js`).

**c. No `FINAL` on list or aggregate queries.** See [clickhouse](clickhouse.md#the-final-rule). Dedupe with `LIMIT 1 BY <key>` (outside the
read of a page: `readDistinctPage`) and read versioned aggregates by their newest version.

**d. `DateTime64(3)` takes seconds.** A JSON insert of a `DateTime64(3)` reads integers as seconds: insert `1700000000.123`, never `Date.now()`.

**e. Slim images have no `wget` / `curl`.** Container healthchecks use Node's `fetch`. (The ClickHouse image has `wget`.)

**f. The toolbox pipe and filter.** The toolbox `bootstrap()` installs a validation pipe that rejects unknown query parameters (disabled here)
and a global filter that renders `{error:{...}}` (overridden per controller by `RippleErrorFilter`). A new controller must use
`@RippleController`, or its errors come out in the wrong shape.

**g. Node >= 20.19.** A lower Node fails at runtime requiring the ESM-only dependencies of `ripple-binary-codec` 2.x. The Dockerfiles pin one patch
version of `node:22` for both images; `apps/api/src/node-version.spec.ts` checks it.

**h. Flaky e2e under load.** Parallel load on a laptop has caused rare ClickHouse timeouts in the recovery suites; rerun a failing suite
once in isolation before looking for a bug.
