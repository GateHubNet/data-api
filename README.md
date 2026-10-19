# GateHub Data API

A drop-in replacement for the **Ripple Data API v2** (`data.ripple.com`, the `rippled-historical-database` project) for the **XRP Ledger**
and for **Xahau**. It indexes a network's validated ledgers into ClickHouse (the *syncer*) and serves the Ripple v2 endpoints over REST
(the *api*): ledgers, transactions, payments, exchanges and candles, rates, accounts (history, balances, orders, reports, stats), active
accounts, network fees and volumes, validations and stats. Paths, parameters, defaults, error messages and the shape and key order of the
answers match what `data.ripple.com` served, so a client of the original works by changing its host and sending an API key. The deliberate
differences are listed in [ADR-0010](docs/adr/0010-ripple-v2-wire-compatibility.md).

One deployment serves one network; the same images run both. The API answers the same `/v2/...` paths on `xrpl.data.<domain>` (native
currency `XRP`) and `xahau.data.<domain>` (`XAH`).

This is a **pnpm workspace** with two services and a shared library:

```
data-api-new/
├── apps/
│   ├── api/        @gatehub/data-api-service — REST API (reads ClickHouse; live node for balances/orders)
│   └── syncer/     @gatehub/data-syncer      — ingest worker: ingest, validations, fee_stats, aggregator; range-ingest CLI
├── packages/
│   └── shared/     @gatehub/data-api-shared  — parsers, ledger writer, ClickHouse client + schema, node client, network profiles
├── deploy/         nginx template, ClickHouse/Keeper config, .env.prod.example
├── docs/           architecture, API reference, data model, operations, ADRs, OpenAPI
├── load/           k6 load test + synthetic seeder
├── docker-compose.yaml        local development stack (one ClickHouse, per-network profiles)
└── docker-compose.prod.yaml   production-shaped stack (Keeper, ClickHouse, per-network migrate/syncer/api, nginx)
```

## Quickstart (local)

Prerequisites: Node >= 20.19, pnpm 10, Docker. `@gatehub/toolbox` is private: `pnpm install` needs an npm token that can read it (log in to npm,
or export `NPM_TOKEN` and reference `${NPM_TOKEN}` from your user-level `~/.npmrc`; see [docs/development.md](docs/development.md#npm-access)).

```bash
export NPM_TOKEN=...                       # a token that can read @gatehub/toolbox
pnpm install

docker compose up -d clickhouse            # ClickHouse on 127.0.0.1:8123

cp apps/syncer/.env.example apps/syncer/.env
cp apps/api/.env.example    apps/api/.env  # GH_NETWORK=xrpl by default; GH_API_KEYS empty = no authentication (development only)

pnpm ch:migrate                            # creates the `xrpl` database and applies packages/shared/schema/*.sql (001_baseline, 002_validators_amendments)

pnpm start:syncer                          # ingests the XRP Ledger from the validated head  (probe on :3002)
pnpm start:api                             # serves /v2/* on :3001, Swagger at /internal/docs
curl -s localhost:3001/v2/ledgers
```

**Per network.** Everything is per network: `GH_NETWORK=xrpl|xahau` picks the node URLs, the native currency, the markets config and the
default database. For Xahau run a second pair with `GH_NETWORK=xahau` (and its own ports): `GH_NETWORK=xahau pnpm ch:migrate`, then
start its syncer and api the same way. Or run both networks in containers:

```bash
NPM_TOKEN=... docker compose --profile full --profile xahau up -d --build   # migrate-xrpl/xahau, syncer-xrpl/xahau, api-xrpl/xahau
curl -s -H 'X-API-Key: dev-api-key' localhost:3001/v2/last_validated        # XRPL on 3001, Xahau on 3011
```

The dev compose publishes only on 127.0.0.1 and uses the API key `dev-api-key`. **An existing ClickHouse volume from the previous stack carries the
replaced schema: recreate it with `docker compose down -v`.**

History before the syncer's start ledger is filled with the range-ingest CLI; read [docs/backfill.md](docs/backfill.md) first (node choice,
sizing):

```bash
pnpm build                                  # ingest:range runs the compiled dist/cli/range-ingest.js
pnpm --filter @gatehub/data-syncer ingest:range --from 90000000 --to 90100000     # reads apps/syncer/.env like the syncer (or set GH_ENV=local and the variables)
```

## Build and test

```bash
pnpm build                                  # shared, then both apps
pnpm test                                   # unit tests of every package
pnpm --filter @gatehub/data-api-shared test:e2e    # e2e suites: need Docker (testcontainers starts a real ClickHouse)
pnpm --filter @gatehub/data-api-service test:e2e   # per-endpoint contract tests, both networks
pnpm --filter @gatehub/data-syncer test:e2e        # recovery, workers, range ingest
```

The API's OpenAPI document is generated from the running app (`/internal/docs-json`); [docs/openapi.yaml](docs/openapi.yaml) is the checked-in copy
and [docs/development.md](docs/development.md#8-building-openapi-and-the-images) says how to regenerate it.

## Authentication

Every `/v2/*` endpoint requires an API key, in a header:

```
X-API-Key: <key>            # or:  Authorization: Bearer <key>
```

Keys are configured with `GH_API_KEYS` (comma separated). Empty disables authentication, which is for development only: **with `NODE_ENV=production`
(the images) the API refuses to start without keys, and with the placeholder keys `dev-api-key` / `change-me...`**. A missing or wrong key is
`401 {"result":"error","message":"Missing or invalid API key."}`. Errors everywhere are Ripple-shaped: `{"result":"error","message":"..."}`.
The probe (`/liveliness/healthz`), the metrics port (3000) and Swagger (`/internal/docs`) need no key and are not exposed by the shipped nginx to the public.

## Endpoints (v2)

Full contract: [docs/api-reference.md](docs/api-reference.md).

| Area | Endpoints |
| --- | --- |
| Ledgers | `/v2/ledgers[/{ledger}]`, `/v2/last_validated` |
| Transactions | `/v2/transactions`, `/v2/transactions/{hash}` |
| Payments | `/v2/payments[/{currency}]` |
| Exchanges | `/v2/exchanges/{base}/{counter}` (raw, `interval` candles, `reduce`), `/v2/exchanges` (all pairs, extra) |
| Rates | `/v2/exchange_rates/{base}/{counter}`, `/v2/normalize` |
| Accounts | `/v2/accounts`, `/v2/accounts/{address}`, `.../transactions[/{sequence}]`, `.../payments`, `.../exchanges[/{base}[/{counter}]]`, `.../balance_changes`, `.../balances`, `.../orders`, `.../reports[/{date}]`, `.../stats/{transactions\|value}` |
| Markets | `/v2/active_accounts/{base}/{counter}` |
| Network | `/v2/network/fees`, `/v2/network/fee_stats`, `/v2/network/exchange_volume`, `/v2/network/payment_volume` |
| Validations | `/v2/ledgers/{hash}/validations[/{pubkey}]` (alias `/v2/ledger/...`) |
| Stats | `/v2/stats[/{family}[/{metric}]]` |
| Operational | `/liveliness/healthz` (api 3001, syncer 3002), `/metricz` (3000), `/internal/docs` |

Lists take `start`, `end`, `descending`, `limit` and `marker` (with a `Link` header), and most take `format=csv`.

## Production deployment

`docker-compose.prod.yaml` brings up Keeper -> ClickHouse -> one-shot `migrate-xrpl` / `migrate-xahau` -> `syncer-<network>` (exactly one each)
+ scalable `api-<network>` -> nginx, which routes by host (`xrpl.data.*`, `xahau.data.*`). Configuration and secrets come from `deploy/.env.prod`
(copy `deploy/.env.prod.example`; inject from a secrets manager in real deployments); the compose file hands each service only the variables
it needs. The images need your npm token at build time as a BuildKit secret.

```bash
cp deploy/.env.prod.example deploy/.env.prod                 # fill in the secrets, TRUSTED_PROXIES, NGINX_BIND
export NPM_TOKEN=...                                         # BuildKit secret, never baked into an image
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod up -d --build
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod up -d --scale api-xrpl=3 --scale api-xahau=2   # scale the read tier (repeat the flags on every up); never a syncer
```

Moving an existing host from the previous single-network stack: add `--remove-orphans` (the old `migrate` / `syncer` / `api` containers are orphans,
and a still-running old syncer holds the writer lease), update `deploy/.env.prod` to the new format and recreate old local ClickHouse volumes with
`docker compose down -v` ([docs/deployment.md](docs/deployment.md#cutover-on-an-existing-host)).

Migrations are owned by the migrate jobs (the apps wait for them): each `schema/*.sql` is a checksummed, tracked migration applied at most once per
network database. Set `TRUSTED_PROXIES` to your front proxy and bind nginx to an interface only it can reach ([docs/security.md](docs/security.md#4-transport-and-the-client-address)).

## Load and capacity testing

See [load/README.md](load/README.md): a synthetic seeder for the current schema, a k6 API load test and a recipe for measuring syncer throughput.

## Docs

**Full index: [docs/README.md](docs/README.md).** Quick links:
[Architecture](docs/architecture.md) · [API reference](docs/api-reference.md) · [Configuration](docs/configuration.md) · [Syncer](docs/syncer.md) ·
[Data model](docs/data-model.md) · [Deployment](docs/deployment.md) · [Operations](docs/operations.md) · [Backfilling](docs/backfill.md) ·
[Security](docs/security.md) · [Observability](docs/observability.md) · [Development](docs/development.md) · [Troubleshooting](docs/troubleshooting.md) ·
[ADRs](docs/adr/README.md) · [OpenAPI](docs/openapi.yaml)
