# Developer Guide

This guide covers everything you need to develop on the **GateHub XRPL Data API** monorepo: a ClickHouse-backed platform that **indexes** the XRP Ledger (the *syncer*) and **serves** that data over a REST API (the *api*), with shared XRPL parsing and ClickHouse plumbing in a common library.

> Looking for runtime/operational docs? See `docs/architecture.md`, `docs/data-model.md`, `docs/configuration.md`, `docs/syncer.md`, `docs/backfill.md`, and `docs/api-reference.md`.

---

## 1. Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | `>=20` | Enforced by `engines.node` in the root `package.json`. |
| pnpm | `10.x` (repo pins `10.6.3` via `packageManager`) | Workspace package manager. Use `corepack enable` to get the pinned version. |
| Docker | recent | Runs local ClickHouse and powers the testcontainers-based integration tests. |
| `NPM_TOKEN` | a token with read access to the private `@gatehub/toolbox` | Both apps depend on `@gatehub/toolbox@^0.2.6`, which is published to the public npm registry but is **private**. |

Enable the pinned pnpm:

```bash
corepack enable
corepack prepare pnpm@10.6.3 --activate
```

### NPM_TOKEN

`@gatehub/toolbox` is private. The root `.npmrc` reads the token from the `NPM_TOKEN` env var:

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

You likely already have the token saved in your user `~/.npmrc` (from a previous `npm login`). Because `npm config get //registry.npmjs.org/:_authToken` **redacts** the value, extract it directly from the file and export it:

```bash
export NPM_TOKEN="$(grep '//registry.npmjs.org/:_authToken=' ~/.npmrc | tail -1 | sed 's/.*_authToken=//' | tr -d '"[:space:]')"
```

Add that line to your shell profile (`~/.zshrc` / `~/.bashrc`) so installs and Docker builds always pick it up. The same `NPM_TOKEN` is passed into the Docker images as a build `ARG` (see the Gotchas section).

---

## 2. Repository layout

This is a **pnpm workspace**. Members are declared in `pnpm-workspace.yaml`:

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

| Path | Package name | Role |
| --- | --- | --- |
| `apps/api` | `@gatehub/data-api-service` | NestJS REST API. Serves ledger data from ClickHouse, plus a few live-XRPL passthrough endpoints. |
| `apps/syncer` | `@gatehub/data-syncer` | NestJS worker. Ingests ledgers from the XRP Ledger, parses them, batches and writes them to ClickHouse. |
| `packages/shared` | `@gatehub/data-api-shared` | Shared library: the ClickHouse client/module/config, the migration runner, all XRPL parsers, the `Table`/`View` enums, and util/constants. Consumed by both apps via `workspace:*`. |

What lives in `packages/shared/src`:

- `clickhouse/` — `clickhouse.service.ts` (typed wrapper around `@clickhouse/client`), `clickhouse.module.ts`, `clickhouse.config.ts`, `migrate.ts` (the migration runner), `tables.ts` (the `Table` and `View` enums).
- `parsers/` — one file per XRPL concern (`payment`, `exchanges`, `balance-changes`, `offers`, `escrow`, `paychan`, `accounts-created`, `affected-accounts`, `from-client`, `issuers`), the `IParser` interface (`parser.interface.ts`), and the `ParsingService` that runs the whole suite.
- `util/` — `ctid.ts`, `quality.ts`, `time.ts`, `helpers.ts` (e.g. `retry`, `isoTimeToUnixSeconds`, `toClickHouseDateTime`).
- `types/` — ambient type declarations.
- `constants.ts` — shared constants.

The SQL schema lives in **`packages/shared/schema/`** (NOT under `src/`):

- `001_tables.sql` — base `ReplacingMergeTree` tables.
- `002_materialized_views.sql` — target tables + materialized views for pre-aggregated analytics.

Everything the library exposes to the apps is re-exported from `packages/shared/src/index.ts`. **If you add something the apps need, export it there.**

### Build order matters

The shared library must be **built before** the apps, because the apps import its compiled `dist/` (`"main": "dist/index.js"`). The root `pnpm build` runs `pnpm -r build`, which respects the workspace dependency graph and builds `@gatehub/data-api-shared` first (topological order). If you build an app in isolation, build shared first:

```bash
pnpm --filter @gatehub/data-api-shared build
pnpm --filter @gatehub/data-api-service build
```

---

## 3. First-time setup

```bash
# 0. Make sure NPM_TOKEN is exported (see section 1).

# 1. Install all workspace deps.
pnpm install

# 2. Start a local ClickHouse (HTTP on :8123, native on :9000).
docker compose up -d clickhouse      # or: pnpm docker:up

# 3. Create env files for each service from the committed examples.
cp apps/api/.env.example apps/api/.env
cp apps/syncer/.env.example apps/syncer/.env
#   The .env files are gitignored; .env.example files are committed.
#   The syncer requires GH_XRPL_NODE_ENDPOINT (it throws on boot without it).

# 4. Apply the ClickHouse schema (tables + materialized views).
pnpm ch:migrate

# 5. Run the services in watch mode (separate terminals).
pnpm start:api       # http://localhost:3001  (docs at /internal/docs)
pnpm start:syncer    # http://localhost:3002
```

ClickHouse connection defaults (overridable via `GH_CLICKHOUSE_*`, see `clickhouse.config.ts`): URL `http://localhost:8123`, user `default`, empty password, database `xrpl`.

To tear down ClickHouse: `pnpm docker:down`.

---

## 4. Common commands

All commands run from the repo root unless noted. `pnpm -r <script>` fans out across every workspace package in dependency order.

| Command | What it does |
| --- | --- |
| `pnpm build` | `pnpm -r build` — builds shared (tsc) then both apps (`nest build`), in topological order. |
| `pnpm test` | `pnpm -r test` — runs **unit** tests (`*.spec.ts`) in every package. |
| `pnpm --filter @gatehub/data-api-service test:e2e` | API integration/e2e tests. **Needs Docker** (spins a real ClickHouse). |
| `pnpm --filter @gatehub/data-syncer test:e2e` | Syncer integration/e2e tests. **Needs Docker**. |
| `pnpm lint` | `pnpm -r lint` — ESLint with `--fix` across packages. |
| `pnpm format` | Prettier write across `{apps,packages}/**/src/**/*.ts`. |
| `pnpm swagger` | Builds the OpenAPI document to `apps/api/dist/swagger.json` (no server needed). |
| `pnpm ch:migrate` | Runs the ClickHouse schema migrations (`packages/shared/src/clickhouse/migrate.ts`). |
| `pnpm start:api` / `pnpm start:syncer` | `nest start --watch` for the respective app. |
| `pnpm docker:up` / `pnpm docker:down` | Start/stop the local ClickHouse container. |

> Note: there is **no root `test:e2e` script** — e2e is per app, by design (each spins its own throwaway ClickHouse and they should not race over `--runInBand`).

---

## 5. Conventions

- **TypeScript strict mode.** `tsconfig.base.json` sets `strict: true` (plus `noImplicitAny`, `strictNullChecks`, etc.). Each package extends it.
- **ESLint + Prettier.** Prettier config (`.prettierrc`): `printWidth: 120`, `singleQuote: true`, `trailingComma: 'all'`, 2-space indent, plus `prettier-plugin-organize-imports`. Run `pnpm format` / `pnpm lint` before committing.
- **NestJS module-per-domain.** Each API domain is a self-contained folder under `apps/api/src/<domain>/` with `<domain>.module.ts`, `.controller.ts`, `.service.ts`, and `.dto.ts`. Register the module in `apps/api/src/app.module.ts`.
- **Parameterised ClickHouse queries only.** Always pass user-derived values through `query_params` (`{name:Type}` placeholders + a `params` object). **Never interpolate user input into SQL.** `ClickHouseService.query()` enforces this pattern; only trusted enum/constant values (e.g. `Table.Payments`, column names from `SortKey`) are ever string-built into queries.
- **Keyset (cursor) pagination.** Use the helpers in `apps/api/src/common/pagination.ts` (`keysetClause`, `orderByClause`, `nextMarker`, `encodeMarker`/`decodeMarker`). The marker is an opaque base64url token of the last row's sort-key tuple — O(1) deep paging, no `OFFSET`.
- **Standard list envelope.** List endpoints return `listResponse(itemsKey, items, marker)` from `apps/api/src/common/response.ts`: `{ result: 'success', marker?, count, [itemsKey]: items }`. Normalise ClickHouse `DateTime` to ISO with `toIso()`.
- **Config via `*.config.ts` + env.** `apps/api/src/config/api.config.ts`, `apps/syncer/src/config/syncer.config.ts`, and shared `clickhouse.config.ts` each build a typed config object from `GH_*` env vars and fail fast on bad input. Don't read `process.env` ad-hoc in services.

---

## 6. How-to guides

### 6a. Add a new API endpoint

Mirror an existing domain such as `apps/api/src/payments/`. Suppose we add an endpoint to a new `widgets` domain.

1. **DTO** — `apps/api/src/widgets/widgets.dto.ts`. Extend `CommonQueryDto` (gives you `start`/`end`/`limit`/`descending`/`marker`/`format` with validation) and add domain filters with `class-validator` + `@ApiPropertyOptional`:

   ```ts
   export class WidgetsQueryDto extends CommonQueryDto {
     @ApiPropertyOptional({ description: 'Filter by owner address.' })
     @IsOptional()
     @IsString()
     owner?: string;
   }
   ```

2. **Service** — `widgets.service.ts`. Inject `ClickHouseService`, build the `WHERE` with **bound params**, add the keyset clause, and order by your sort keys. Follow `payments.service.ts`:

   ```ts
   const SORT_KEYS: SortKey[] = [
     { column: 'date', type: 'DateTime' },
     { column: 'ledger_index', type: 'UInt32' },
     { column: 'tx_index', type: 'UInt16' },
   ];

   const where: string[] = [];
   const params: Record<string, unknown> = { limit: options.limit };
   if (options.owner) {
     where.push('owner = {owner:String}');   // bound, never interpolated
     params.owner = options.owner;
   }
   const keyset = keysetClause(SORT_KEYS, options.descending, options.marker);
   if (keyset.clause) { where.push(keyset.clause); Object.assign(params, keyset.params); }

   const sql = `SELECT ... FROM ${Table.Widgets}
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY ${orderByClause(SORT_KEYS, options.descending)}
                LIMIT {limit:UInt32}`;

   const rows = await this.ch.query<Record<string, unknown>>(sql, params);
   const marker = nextMarker(rows, SORT_KEYS, options.limit);
   return listResponse('widgets', rows, marker);
   ```

3. **Controller** — `widgets.controller.ts`. Version it and tag it for OpenAPI; add `@ApiOperation` to every route:

   ```ts
   @ApiTags('widgets')
   @Controller({ version: '2', path: 'widgets' })
   export class WidgetsController {
     constructor(private readonly service: WidgetsService) {}

     @Get()
     @ApiOperation({ summary: 'List widgets' })
     getWidgets(@Query() query: WidgetsQueryDto) {
       return this.service.getWidgets(query);
     }
   }
   ```

4. **Module** — `widgets.module.ts` declaring the controller + service, then **register it** in `apps/api/src/app.module.ts`'s `imports` array.

5. Regenerate OpenAPI (`pnpm swagger`) and add an e2e assertion (section 7).

### 6b. Add a new ClickHouse table or column

1. **DDL** — add a new migration file in `packages/shared/schema/`, named with the next number, e.g. `003_widgets.sql`. The runner applies files in lexical order and records them in `schema_migrations`, so **never edit an already-applied file** — add a new one. Write all DDL as `CREATE ... IF NOT EXISTS` (and use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for new columns). Follow the existing conventions in `001_tables.sql`: `ReplacingMergeTree(ledger_index)` keyed on the natural XRPL identity, `PARTITION BY toYYYYMM(date)`, time columns as `DateTime` (UTC).

2. **Table enum** — add the table to the `Table` enum in `packages/shared/src/clickhouse/tables.ts` so services reference `Table.Widgets`, never a string literal.

3. **Populate it** — in the relevant parser's output type and in the syncer's mapping in `apps/syncer/src/processor/clickhouse-data-processor.service.ts`: add a row-array, push mapped rows inside the per-tx loop, append to its buffer, and add the table to the `CHILD_TABLES` list so it's flushed. (For a new column on an existing table, just add the field to that table's row object.)

4. **Expose it** — read the new table/column from an API service.

5. **Apply** — `pnpm ch:migrate` locally. In production a one-shot `migrate` job runs it (see `docker-compose.prod.yaml`); the integration tests apply it automatically via `runMigrations()`.

### 6c. Add a new XRPL parser

1. **Implement `IParser`** in `packages/shared/src/parsers/<thing>.parser.ts`. Define a `Parsed<Thing>` output type and a class implementing `IParser<Parsed<Thing>[]>` (or a single object). Parsers must be **pure and synchronous** — derive everything from `transaction.meta` (the affected nodes), no network calls. `issuers.parser.ts` is a good model: it reads `RippleState` nodes from metadata rather than making an `account_lines` RPC.

2. **Export** it from `packages/shared/src/index.ts`.

3. **Wire it into the suite** — in `packages/shared/src/parsers/parsing.service.ts`: add a private instance and call it in `parseTransaction()`, adding the result to the `ParsedTransaction` interface.

4. **Map its output** in `apps/syncer/src/processor/clickhouse-data-processor.service.ts` (see 6b step 3) and **add a table** for it (see 6b).

5. **Add fixture-based unit tests** (section 7).

### 6d. Add a materialized view

1. **DDL** — append to `packages/shared/schema/002_materialized_views.sql` only if it has **not** been applied anywhere yet; otherwise add a **new** numbered migration (the runner skips already-recorded files). Use the established pattern: a target `*MergeTree` table (`AggregatingMergeTree` for OHLC/argMax-argMin, `SummingMergeTree` for additive counters) **plus** a `CREATE MATERIALIZED VIEW ... TO target AS SELECT ...`. See `exchange_candles_1m` and `payment_volume_daily`.

2. **View enum** — add it to the `View` enum in `tables.ts`.

3. **Query it from an API service.** Because `SummingMergeTree`/`AggregatingMergeTree` may hold un-merged parts, **re-aggregate in the query** (`sum(...) ... GROUP BY`, or `argMaxMerge`/`argMinMerge` for `AggregateFunction` columns) — do **not** rely on `FINAL` for list/analytics queries. `apps/api/src/stats/stats.service.ts` is the reference: it `sum()`s and `GROUP BY day` over `View.StatsDaily`.

> Materialized views only populate on **new** inserts after they're created. To populate historical data, backfill the target table once with an `INSERT INTO target SELECT ...` over the source table.

---

## 7. Testing

Two layers, both Jest with `ts-jest`.

### Unit tests (`*.spec.ts`)

Fast, no Docker. Run with `pnpm test` (root) or `pnpm --filter <pkg> test`.

- Shared: `packages/shared/src/util/ctid.spec.ts`, `packages/shared/src/parsers/balance-changes.parser.spec.ts`.
- API: `apps/api/src/common/pagination.spec.ts`.

Each app's unit config (`jest-config.json`) deliberately **excludes** e2e files (`"testRegex": "^(?!.*e2e-).*\\.spec\\.ts$"`).

### Integration / e2e tests (`*.e2e-spec.ts`) — needs Docker

These use **testcontainers** to boot a real, throwaway ClickHouse, apply the **real schema** via `runMigrations()`, then exercise the actual code against it.

```bash
# Docker must be running.
pnpm --filter @gatehub/data-api-service test:e2e
pnpm --filter @gatehub/data-syncer test:e2e
pnpm --filter @gatehub/data-api-shared test:e2e
```

The shared helper — `packages/shared/test/clickhouse-container.ts` (the apps import it by relative path) — starts the pinned `clickhouse/clickhouse-server` LTS (`26.8.14.3`, override with `CLICKHOUSE_IMAGE`), waits for `/ping` to return 200, and **exports the connection into `process.env`** (`GH_CLICKHOUSE_URL`, `GH_CLICKHOUSE_DATABASE`, etc.) so the shared config picks it up. With a `database` argument the image creates that database on startup; without one only `default` exists and `runMigrations()` creates the target database itself:

```ts
export async function startClickHouse(database?: string): Promise<StartedClickHouse> {
  const container = await new GenericContainer(process.env.CLICKHOUSE_IMAGE || DEFAULT_CLICKHOUSE_IMAGE)
    .withExposedPorts(8123)
    .withWaitStrategy(Wait.forHttp('/ping', 8123).forStatusCode(200))
    .withStartupTimeout(120_000)
    .start();
  process.env.GH_CLICKHOUSE_URL = `http://${container.getHost()}:${container.getMappedPort(8123)}`;
  // ...
  return { container, url, database, config }; // config: ClickHouseConfig for the started server
}
```

The shared package has its own e2e suite for the migration runner and the ClickHouse client (`pnpm --filter @gatehub/data-api-shared test:e2e`, config `packages/shared/jest.e2e.config.js`). Point `GH_SCHEMA_DIR` at a directory of `*.sql` files to migrate from somewhere other than `packages/shared/schema/`.

Test shape (see `apps/api/test/api.e2e-spec.ts` and `apps/syncer/test/processor.e2e-spec.ts`):

1. `beforeAll`: `startClickHouse('xrpl')` → set env → `await runMigrations()` → seed rows.
2. **Import `AppModule` only AFTER the env is set** (config is read at module-init time) — use a dynamic `await import('../src/app.module')`.
3. Run assertions (the API tests use `supertest`).
4. `afterAll`: close the app, close the ClickHouse client, `container.stop()`.

The e2e Jest config (`test/jest-e2e.json`) uses a long `testTimeout` (180000 ms) because container startup is slow, and runs `--runInBand`.

**When you add a parser, add fixture-based unit tests** (feed a representative `XrplTx`/metadata object, assert the parsed output). **When you add an endpoint, add an e2e assertion** that seeds a row and hits the route.

---

## 8. Building & OpenAPI

```bash
pnpm build      # shared (tsc) -> api (nest build) -> syncer (nest build), topological
pnpm swagger    # writes apps/api/dist/swagger.json
```

`pnpm swagger` runs `apps/api/src/swagger.ts`, which boots `AppModule` in-memory (no HTTP listener), builds the document via `buildOpenApiDocument()`, and writes `dist/swagger.json`. That file is **gitignored** (`apps/api/dist/swagger.json`) — it's a build artifact, regenerated in CI / the Docker build.

At runtime the API serves interactive docs from **`/internal/docs`** (and the raw JSON at `/internal/docs/json`), wired up in `apps/api/src/main.ts`. Endpoints are URI-versioned (`@Controller({ version: '2', ... })` → `/v2/...`).

---

## 9. Gotchas (learned the hard way on this project)

**a. TS incremental builds vs `nest build --deleteOutDir`.**
`apps/*/nest-cli.json` sets `"deleteOutDir": true`. Combined with TypeScript incremental builds / `.tsbuildinfo`, the compiler can think outputs are already up to date and **skip emit** after the dir was wiped — leaving an empty/partial `dist`. `*.tsbuildinfo` is gitignored; don't commit it and don't rely on it for the apps' Nest builds. If a build looks stale, delete `dist` and any `*.tsbuildinfo` and rebuild.

**b. Docker: install + build must share one `RUN` layer.**
pnpm's workspace symlinks (the `workspace:*` link from each app to `@gatehub/data-api-shared`) **do not survive across separate `RUN` layers** in BuildKit. So `apps/api/Dockerfile` and `apps/syncer/Dockerfile` run `pnpm install && pnpm --filter shared build && pnpm --filter <app> build && ... deploy` in a **single `RUN`**. Also:
   - `**/*.tsbuildinfo` is in `.dockerignore` (so a stale local incremental cache can't poison the image — see gotcha a).
   - `pnpm deploy` on pnpm v10 needs the `--legacy` flag: `pnpm --filter <app> --legacy deploy --prod /app/out`.
   - `NPM_TOKEN` is passed as a build `ARG` and written to npm config so the private `@gatehub/toolbox` installs.

**c. Don't use `FINAL` on ClickHouse list/analytics queries.**
The per-tx tables are `ReplacingMergeTree` and the analytics targets are `Summing`/`AggregatingMergeTree`. `... FINAL` forces a merge-on-read across all parts, which **OOMs under concurrency** on large tables. For lists and aggregates, rely on background merges plus **query-time de-dup/aggregation**: `argMax`/`argMaxMerge` for latest-wins (see `network.service.ts`), `sum() ... GROUP BY` for counters (see `stats.service.ts`). `FINAL` is acceptable only for **single-row point lookups** by primary key (e.g. one tx by `hash`, one ledger, one account — see `transactions`/`ledgers`/`accounts` services), where it touches a tiny range.

**d. `node:*-slim` has no `wget`/`curl` — health checks use Node `fetch`.**
The runtime image is `node:22.23.2-bookworm-slim`, which ships **no** `wget`/`curl`. Container health checks therefore use Node's global `fetch` against `/liveliness/healthz`, e.g.:

```yaml
test: ['CMD', 'node', '-e', "fetch('http://localhost:3001/liveliness/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
```

(The local `docker-compose.yaml` ClickHouse health check uses `wget` because the *ClickHouse* image has it — this only bites the **app** images.)
