# Troubleshooting

Concrete failures encountered building and running this system, each with the symptom, the root cause and the fix. Operational
playbooks are in [operations](operations.md); this page is the lookup table for error messages.

## Build and packaging

### `tsc` emits nothing / `Cannot find module '@gatehub/data-api-shared'`
**Symptom:** a clean Docker build fails the API type check with many `Cannot find module` errors although `pnpm build` works locally, or
a local rebuild produces a near-empty `dist/`.

**Root cause:** TypeScript writes a `*.tsbuildinfo`; a stale one next to a missing `dist` makes `tsc` believe the output is current and
emit nothing (nest's `deleteOutDir` is the trap). The shared package's `dist/index.d.ts` is then missing.

**Fix:** `**/*.tsbuildinfo` is in [`.dockerignore`](../.dockerignore) and git-ignored. Locally delete `*.tsbuildinfo` and `dist` and rebuild.

### Docker build: workspace package not found after `pnpm install`
**Root cause:** pnpm workspace symlinks do not survive across BuildKit layers. **Fix:** the Dockerfiles do install, build and deploy in one `RUN`.

### `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`
**Root cause:** pnpm 10 refuses `deploy` without injected workspaces. **Fix:** `pnpm ... --legacy deploy --prod /app/out` (the Dockerfiles do).

### Docker build: `secret npm_token: not found` / `the npm_token secret is empty`
**Symptom:** `docker compose build` (or `docker build`) stops at the install `RUN`.

**Root cause:** the npm token of the private `@gatehub/toolbox` is a **BuildKit secret**, read from the `NPM_TOKEN` environment variable
(compose: `secrets.npm_token.environment: NPM_TOKEN`). It is not a build argument, and not read from `~/.npmrc`.

**Fix:** `export NPM_TOKEN=...` in the shell that runs the build (`NPM_TOKEN=... docker compose build`), or
`docker build --secret id=npm_token,env=NPM_TOKEN ...`. Do not copy the token out of `~/.npmrc` or pass it as a build argument: the
secret is in no layer and `docker history` shows nothing. A `404`/`401` for `@gatehub/toolbox` during install means the token cannot read it.

### `pnpm install` fails with 404/401 for `@gatehub/toolbox`
**Root cause:** the package is private and pnpm has no token. **Fix:** [development](development.md#npm-access) (log in to npm, or reference
`${NPM_TOKEN}` from your user-level `~/.npmrc`). The committed `.npmrc` does not carry the token.

### `Env file not found: .env.production` (or `.env`)
**Symptom:** the service dies right at boot, before any log line of its own.

**Root cause:** the toolbox config loader reads `.env` (or `.env.$NODE_ENV`) from the working directory and refuses to start without it,
unless `GH_ENV` is set to any value. The images set `GH_ENV=container`; running `node dist/main.js` by hand with `NODE_ENV=production` and
no `GH_ENV` hits this.

**Fix:** from source copy `apps/<app>/.env.example` to `.env` and run from the package folder; in a container or CI set `GH_ENV=container`
and put the variables in the environment.

### `process exits: GH_DATABASE_...` when importing the toolbox
**Root cause:** the package root of `@gatehub/toolbox` registers its own database and queue configuration. **Fix:** import
`@gatehub/toolbox/lib/<module>` (as `api.config.ts` does), never the package root.

### `ERR_REQUIRE_ESM` / `require() of ES Module` at boot
**Root cause:** Node older than 20.19 (22.12 on the 22 line): `ripple-binary-codec` 2.x pulls ES-module-only dependencies with `require(esm)`.
**Fix:** Node >= 20.19 (the images pin `node:22.23.2-bookworm-slim`; do not go back to a floating `node:20` tag).

### A GH_* value rejected at boot
**Symptom:** `GH_CATCHUP_CONCURRENCY must be a positive integer`, `GH_NODE_ENDPOINTS must be a comma separated list of ws:// or wss:// URLs`,
`GH_NETWORK must be one of xrpl, xahau, xrpl-testnet, xahau-testnet`, `Unknown worker "x"`. **Fix:** the message names the variable; see [configuration](configuration.md).
Integers are plain digits (`1.5`, `1e3` are rejected).

## Containers and compose

### `docker compose`: "variable is not set" / `required variable ... is missing a value`
**Root cause:** `${...}` interpolation in a compose file is resolved from your shell or `--env-file`, not from a service's environment.
`GH_CLICKHOUSE_PASSWORD` and `GH_API_KEYS` are required in the production compose.

**Fix:** pass `--env-file deploy/.env.prod` to **every** compose subcommand (`up`, `ps`, `logs`, `down`, `run`), and `export NPM_TOKEN` for builds.

### The API container exits: `GH_API_KEYS must be set in production` / `contains a placeholder key` / `GH_RATE_LIMIT_KEYS entry N ...`
**Root cause:** the images run with `NODE_ENV=production`, where an empty key list, `dev-api-key`, or a key starting with `change-me` is refused.
An invalid `GH_RATE_LIMIT_KEYS` also stops the boot; the message names the entry by its position (1-based), never the key: `entry N must be key=limit`
(a malformed pair), `must have a positive whole limit`, `names a key that is not in GH_API_KEYS`, `repeats a key`; `GH_RATE_LIMIT_KEYS needs GH_API_KEYS` when
the setting is set and the key list is empty.
**Fix:** real keys in `deploy/.env.prod`; correct the named entry of `GH_RATE_LIMIT_KEYS`. A key removed from `GH_API_KEYS` (a rotation) leaves its entry
behind: remove it there too ([operations](operations.md#rotate-an-api-key)). The dev compose runs its API with `NODE_ENV=development` so `dev-api-key` works there.

### Containers show `(unhealthy)` but the service works
**Root cause 1:** an old healthcheck used `wget`, which the slim image does not have; the current ones use Node's `fetch`.
**Root cause 2 (syncer):** the syncer opens its probe port only once its node connection is up, and answers 503 while it is more than
`GH_MAX_LAG_HEALTHY` ledgers behind for over a minute (catch-up, backfill). `unhealthy` is informational; compose restarts nothing on it.
**Fix:** read the probe body, with Node (the slim images have no `curl`):
`docker compose exec syncer-xrpl node -e "fetch('http://127.0.0.1:3002/liveliness/healthz').then(r=>r.text()).then(console.log)"` and look at `state`, `lag`, `last_commit_age`.

### ClickHouse Keeper stuck "unhealthy" -> ClickHouse will not start
**Root cause:** the healthcheck `echo ruok | nc localhost 9181` hung; this image's `nc` has no `-q`. **Fix:**
`echo ruok | nc -w1 127.0.0.1 9181 | grep -q imok` (the compose file has it).

### ClickHouse healthy but peers get `ECONNREFUSED` on :8123
**Root cause:** mounting our `config.d` shadowed the image's `docker_related_config.xml`, which sets `listen_host = 0.0.0.0`.
**Fix:** `deploy/clickhouse/config.d/cluster.xml` sets `<listen_host>0.0.0.0</listen_host>`.

### The migrate job fails on an old ClickHouse volume
**Symptom:** `Missing columns: 'checksum'`, `Unknown identifier`/`no such column` in later queries, or the schema looks wrong.

**Root cause:** the volume was created by the previous stack (`001_tables.sql` / `002_materialized_views.sql`). The baseline replaced them;
`CREATE TABLE IF NOT EXISTS` skips old tables of the same name, and the old `schema_migrations` has no `checksum` column.

**Fix (local, throw-away data):** `docker compose down -v`, then `up` again so the migrate job creates a clean database. There is no
in-place migration; re-ingest with the syncer and `range-ingest` ([deployment](deployment.md#cutover-on-an-existing-host)).

### The new syncer refuses to boot (lease) or two syncers write
**Symptom:** the syncer exits with a message that the lease is held; or an old container is still ingesting.

**Root cause:** after moving to the per-network stack the old `migrate` / `syncer` / `api` containers are **orphans** that keep running; a
syncer's lease (30 s) is held by a live or recently dead holder.

**Fix:** `docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod up -d --remove-orphans`, or `docker rm -f` the old containers; wait 30 s.

### Dev compose: port already in use, or a second stack next to the first
**Root cause:** the dev stack publishes 8123/9000, 3001-3004, 3011-3014 on 127.0.0.1, and another stack or service holds one of them.
The dev compose fixes no container name (an older version named its ClickHouse `data-api-clickhouse`), so a project name is enough to
keep two stacks apart. **Fix:** run under your own project and move the ports with their variables, e.g.
`CLICKHOUSE_HTTP_PORT=18123 CLICKHOUSE_NATIVE_PORT=19000 docker compose -p my-check up -d clickhouse` (the list of variables is at the top
of `docker-compose.yaml`; point `GH_CLICKHOUSE_URL` at the new port). The prod compose keeps fixed names for the syncers and ClickHouse:
it is one stack per host.

### nginx exits at start / `unknown directive "${TRUSTED_PROXY_DIRECTIVES}"`
**Root cause:** `16-trusted-proxies.envsh` lost its executable bit (it must stay `chmod +x`; the image sources it before rendering the
template), or `TRUSTED_PROXIES` has an invalid entry or a zero prefix (`0.0.0.0/0`), which is refused on purpose. **Fix:** restore the mode;
use plain addresses/CIDRs of your front proxy.

### Host seeder cannot reach ClickHouse in the prod compose
**Root cause:** the prod compose does not publish ClickHouse. **Fix:** for load testing only add `-f docker-compose.prod.override.yaml`
(publishes 8123). Never in production. The dev compose already publishes it on 127.0.0.1.

## Runtime and performance

### ClickHouse `Memory limit (total) exceeded`; the API is slow with idle replicas
**Symptom:** under concurrency p95 balloons and requests fail while the API replicas sit at ~0 % CPU; ClickHouse logs `Memory limit (total)
exceeded`. **Root cause:** a list query with `FINAL` merge-sorts the whole table per request and the replicas wait on ClickHouse.
**Fix:** no `FINAL` on lists ([ADR-0003](adr/0003-no-final-on-list-queries.md), [clickhouse](clickhouse.md#the-final-rule)); the per-query guards
`GH_CLICKHOUSE_MAX_QUERY_MEMORY` (`API_CLICKHOUSE_MAX_QUERY_MEMORY` for the apis in production) / `_MAX_EXECUTION_TIME` bound a
regression. A list query must read its page with `readDistinctPage`: a `LIMIT 1 BY` in the SELECT that reads the table makes ClickHouse
read most of the range ([clickhouse](clickhouse.md#reading-a-page-what-stops-the-read)); `system.query_log.read_rows` of one page should
be about a granule per part, not the range.

### Every client shares one rate-limit bucket
**Symptom:** all clients get 429 together; a single-IP load test hits 429 almost at once; the logs show the proxy's address for everybody.

**Root cause:** the throttler keys on `req.ip`. If nginx does not recover the real client, or the API trusts the wrong number of hops, `req.ip`
is the proxy.

**Fix:** set `TRUSTED_PROXIES` (deploy/.env.prod) to the address(es) of your **front proxy**, so nginx believes its `X-Forwarded-For`; keep
`GH_TRUST_PROXY_HOPS=1` (nginx hands the API exactly one address). If clients can reach nginx from a *trusted* address they can pick their own
address instead: bind nginx (`NGINX_BIND`) to the front proxy's interface. See [deployment](deployment.md#the-edge-nginx). The limit is per replica
and in memory.

### 401 `Missing or invalid API key.`
The key goes in a header (`X-API-Key: <key>` or `Authorization: Bearer <key>`), never the query string; it must be one of `GH_API_KEYS`; an empty
`X-API-Key` falls through to `Authorization`.

### 404 `Cannot GET /v2/...`
The route does not exist on this API: `/v2/network/top\_currencies` and the old GateHub `/v2/ledgers` list are gone; check the path in
[api-reference](api-reference.md). Paths ignore case but not spelling (`/v2/exchange_rates`, `/v2/active_accounts`).

### `/v2/ledgers/...` or lists are empty on a fresh database
Nothing is committed yet, or the window is before the syncer's start ledger (`GH_SYNC_START_LEDGER`, default the validated head at the first
boot). Check `SELECT min(ledger_index), max(ledger_index) FROM xrpl.ledgers` and backfill history with `range-ingest` ([backfill](backfill.md)).
`/v2/last_validated` is `500 unavailable` on an empty database.

### Volumes are empty / stats are stale
`/v2/network/exchange_volume` and `payment_volume` need markets in the markets config (`GH_MARKETS_CONFIG` or `config/markets/<network>.json`); the Xahau
file ships empty. `/v2/network/amm_volume` does not depend on the markets for its components (every pool with swaps counts), but converts them with the rates of the
markets against the native currency and of the pools, and Xahau has no AMM, so it is empty there. `/v2/stats` and the volumes (all four metrics, fifteen live sets) are
written by the aggregator once a minute; after an outage or on a database with years of history the current hour lags until it has caught up
(`syncer_aggregator_stats_lag_seconds`).

### `GET /v2/amm/pools/{pool}` is 404 `pool not found` for a pool that exists
Three causes, in the order to check. (1) The pool is new: the detail and the pair form are served from `amm_pools`, which the aggregator rebuilds once a minute, so a
pool is 404 there for up to about a minute after its ledger committed while its history, swaps, liquidity and governance are already served. (2) The pool's ledgers
are not ingested: the syncer started after them and the history was not re-ingested ([backfill](backfill.md#amm-data-re-ingest)); `SELECT count() FROM xrpl.amm_pool_states
WHERE amm_account = '<pool>'`. (3) `amm_pools` fails for this pool: the aggregator log names it (`Aggregator job amm_pools failed for pool ..., set aside to be tried
again`) and `syncer_aggregator_errors_total{job="amm_pools"}` rises ([operations](operations.md#the-amm-jobs)).

### NFT answers say `"complete": false`, or an NFT has no `minted`
`coverage` says how much of the history the index holds ([api-reference](api-reference.md#coverage)): the NFT data start at the first ledger written by parser
version 5 or later, and `complete` is true only when that is at or before the ledger the amendment was enabled in (XRPL 75443457, Xahau 1). Before the history is
re-ingested, or on a testnet (never backfilled), it is false and an NFT minted earlier has no `minted` and perhaps no `owner`. `SELECT maxOrNull(ledger_index)
FROM xrpl.ledgers WHERE parser_version < 5` is the last ledger the NFT data lack ([backfill](backfill.md#nft-re-ingest)). With the history in and the answer still
`complete: false` on a mainnet, the enable ledger is not known to the API: check `GET /v2/network/amendments/NonFungibleTokensV1_1` (or `URIToken`) has an
`enabled.ledger_index`. It reports one only for an amendment that the node's ledger state lists as enabled, which the `validators` worker polls into `network_state` (the ledger is
then the indexed `EnableAmendment` transaction or, on a mainnet, the metadata file): a syncer with only the `ingest` and `aggregator` workers never does, and every
NFT answer then says `complete: false`.

### `GET /v2/nft_collections/...` is 404 `collection not found` for a collection that exists
(1) The other network's form of the path: XRPL is `/{issuer}/{taxon}`, Xahau `/{issuer}`. (2) The collection is new, or the first fill is still under way: collections
are computed by the aggregator some minutes after their NFTs change, and after a rollout first in, first out (`syncer_nft_collections_pending`,
[operations](operations.md#the-nft-data)); the NFT's own routes and an account's holdings are served meanwhile. (3) `nft_collections` fails for it: the log names the
collection (`Aggregator job nft_collections failed for collection <issuer>/<taxon>, set aside to be tried again`) and `syncer_aggregator_errors_total{job="nft_collections"}` rises.

### `syncer_nft_state_lag_ledgers` stays 0 after a start while the NFT lists do not move, or `syncer_nft_dirty_ledgers` jumped after a restart
The job does not know its cursor until it has read it (a join of every touch with the NFTs, which may take as long as a query may), and the lag gauge is not
set until then (it keeps its value, 0 in a new process): wait a few minutes. A read of the cursor that fails is logged and counted
(`syncer_aggregator_errors_total{job="nft_state"}`, `Aggregator job nft_state failed reading where the job goes on from, tried again in N min`) and tried
again after 5 minutes, doubling to an hour; if it never fits `GH_CLICKHOUSE_MAX_EXECUTION_TIME` the live part never starts and the gauge never moves
([operations](operations.md#the-nft-data)). A restart during a history fill (or after the aggregator was off while the ingest wrote more than 10,000
ledgers) finds the cursor far behind the head and leaves that stretch to `nft_dirty` (`nft_state: the stale NFTs of ledgers A - B are left to the dirty
ranges`): `syncer_nft_dirty_ledgers` jumps by it and falls as the dirty sweep rebuilds it, while the live part follows the chain. Nothing is wrong.

### `GET /v2/account_names` shows `kind: "domain"` for an account that should be verified, or `GET /v2/toml/{domain}` is 404 `toml not found`
(1) The account has no `domain` in the answer: its Domain was set before the state history starts and has not changed since, or the seed was not run
([backfill](backfill.md#account-domains-seed)). (2) The toml was not read yet: a new domain waits for the `tomls` worker (a 404 `toml not found`; `syncer_tomls_due`),
and everything waits for the first sweep after a deploy. (3) The check failed: `GET /v2/toml/{domain}` says why in `reason` (a host that is down, a 404 on the file, a
file that is not TOML, an integer above 2^53 anywhere in it); a transient failure keeps the names and is tried again hourly up to 24 hours after the re-read it
missed, then backs off 1, 2, 4 and 7 days, as a definite one does. (4) The toml does not list the address, or lists it for another network (an entry's `network` must
be absent or one of the network's names), or its `desc` is over 64 characters or holds an `@` (the domain is then the name). (5) The worker never filled the store:
`GH_DOMAIN_VERIFICATION=false` or `tomls` out of `GH_WORKERS` from the start, or no outbound HTTPS (`syncer_tomls_checks_total` full of `dns_error`, `connect_error` or
`timeout`). A worker turned off **after** it ran does not do this: its rows keep verifying names (below). (6) An answer with **no** `display_name` for an account with a
domain (not even `kind: "domain"`) is one whose read of `domain_tomls` failed (`Could not read the tomls of the account domains, no domain is a name in this answer`, a
`warn` of the api): the next call reads it again ([operations](operations.md#the-display-names)).

### A verified name stays although the `tomls` worker is off, or the domain dropped the account
The api uses what the store holds as it is: with the worker off (`GH_DOMAIN_VERIFICATION=false`, `tomls` out of `GH_WORKERS`) the rows of its last checks stay, and
the names they verify stay, **without limit**, also for a domain whose toml has dropped the account since. To withdraw them, `TRUNCATE TABLE <network>.domain_tomls`
(the worker fills it again when it is switched back on; the api keeps an answer at most 60 s). `GET /v2/toml/{domain}` likewise answers the last row of a domain no
account names any more: the store keeps every domain it checked ([operations](operations.md#the-display-names)).

### Syncer refuses to boot: `lacks the schema of 012_display_names.sql`
The `tomls` worker is enabled and the database does not have `account_domains` and `domain_tomls`. Apply the migrations (`dc run --rm migrate-<network>`) and start the syncer
again. A syncer of this release without the tables could not write a ledger either, so migrate before it starts ([deployment](deployment.md#schema-migrations)).

### Syncer refuses to boot: `lacks the schema of 014_issued_tokens.sql`
The `ingest` worker is enabled and the database does not have `state_touches`, or the `aggregator` worker is and it lacks any of `state_touches`, `token_generations`, `token_lines` and `tokens`. Apply the migrations
(`dc run --rm migrate-<network>`) and start the syncer again. A syncer of this release without `state_touches` could not write a ledger, and an aggregator without the other three could not drain `agg_dirty`, so migrate before it
starts ([deployment](deployment.md#schema-migrations), [agg_dirty does not drain](#agg_dirty-does-not-drain-the-tokens-hook-fails)).

### Syncer refuses to boot: `lacks the schema of 015_supply.sql`
The `ingest` worker is enabled and the database does not have the three mint tables `genesis_mints`, `imports` and `reward_claims`, or the `aggregator` worker is and it lacks any of those and `network_supply`. The schema is one on
every network, so a syncer on the XRP Ledger is refused too, though its ingest never inserts into the mint tables; on Xahau an insert into a missing mint table fails the batch, so the live runner would retry the same ledgers
without end, and the `supply` job of the aggregator reads them on Xahau (it plans no read of them on the XRP Ledger) and writes `network_supply` on both. Apply the migrations (`dc run --rm migrate-<network>`) and start the syncer again
([deployment](deployment.md#schema-migrations)).

### Syncer refuses to boot: `lacks the schema of 016_validator_toml_details.sql`
The `validators` worker is enabled and `validator_domains` does not have the five columns of the migration (`owner_country`, `server_country`, `toml_network`, `toml_unl`, `toml_version`). The domain checker reads and writes them, so without them every pass would fail, and every validators route of the api answers 500 until they exist. Apply the migrations (`dc run --rm migrate-<network>`) and start the syncer again
([deployment](deployment.md#schema-migrations)).

### Syncer refuses to boot: `lacks the schema of 017_mpt.sql`
The `ingest` worker is enabled and the database does not have the five MPT ledger tables `mpt_issuance_states`, `mpt_holder_states`, `mpt_touches`, `mpt_transfers` and `mpt_issuance_transfers`. The schema is one on every network, so a syncer on Xahau is refused too, though its ingest never inserts into them; on XRPL and XRPL Testnet an insert into a missing table fails the batch, so the live runner would retry the same ledgers without end. Apply the migrations (`dc run --rm migrate-<network>`) and start the syncer again
([deployment](deployment.md#schema-migrations)).

### An escrow, check, payment channel or delegation answers 404, has no `created`, or says `"complete": false`
`coverage` says how much of the history the index holds ([api-reference](api-reference.md#coverage)): the object data start at the first ledger written by parser version 7 or
later, and `complete` is true only when that is at or before the ledger the feature starts at (XRPL: 28,685,313 for escrows and payment channels, 56,219,905 for checks, 107,524,865
for delegations; Xahau: its first ledger, ledger 1). (1) **404 `escrow not found`** (`check not found`, `payment channel not found`, `ledger object not found`) for an object that
exists on the ledger: it was created before the first version-7 ledger and has not changed since, so the index has no row of it; the API never asks a node, and the explorer reads
it from the node. `SELECT count() FROM xrpl.object_changes WHERE object_type = 'Escrow' AND object_id = '<ID>'` is 0. (2) **No `created`, `complete: false`**: it was created before
that ledger and changed after it, so its history starts in the middle. Both end when the history is written by parser version 7 or later (the program's one reprocess, or the history
load: [backfill](backfill.md#ledger-objects-and-delegation-re-ingest)); `SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 7` is the last ledger the object data
lack. (3) **Delegations say `complete: false` after the re-ingest**: the enable ledger of `PermissionDelegationV1_1` is not known to the API (`GET
/v2/network/amendments/PermissionDelegationV1_1` has no `enabled.ledger_index`: it reports one only for an amendment the node's ledger state lists as enabled, which the `validators`
worker polls into `network_state`), or a ledger from 107,524,865 on was written by an older parser. On Xahau the delegations are `complete: true` and an empty list, always.
(4) **A 500** (`unable to retrieve escrow`, `... delegations`): the tables of migration 013 are missing, or ClickHouse refused the read (the api logs the cause); an account with
more than 10,000 delegations in one direction is a 500 too, by design.

### `syncer_escrows_lag_ledgers` is high or stays still, or `escrows_dirty` errors rise
The lag is the newest committed ledger less the watermark of the `escrows` job (the `through_ledger` of the sentinel: `SELECT through_ledger FROM xrpl.escrows WHERE escrow_id = ''
ORDER BY version DESC LIMIT 1`). (1) **A first fill** (a rollout, or a rebuild after the history load) starts at the size of the history and falls in jumps of up to 1,000,000 ledgers,
one step or more a tick: nothing is wrong ([operations](operations.md#ledger-objects-and-delegation)). (2) **The job fails**: `syncer_aggregator_errors_total{job="escrows"}` rises and the
log says `Aggregator job escrows failed: ...`; the gauge keeps growing with the head because it is read from the table after a failed step. A database that is down for the step and
for the gauge reads freezes the gauge: the errors rate is the signal. (3) **One escrow cannot be mapped**: `Aggregator job escrows failed for escrow <ID>, set aside: ...`; the step
commits without it and the lag is not affected. (4) **The hook fails** (`Aggregator job escrows_dirty failed in <from> - <to>: ...`; with the reason `the escrows step of this tick
failed` the cause is (2), and the slice waits for a step that commits): the slice stays in `agg_dirty`, so
`SELECT count() FROM xrpl.agg_dirty` does not fall, and the earlier hooks of the slice (rates, pairs, rollups, `nft_dirty`) run again at every tick until it works; fix the cause and the
next tick drains the queue. (5) `SYSTEM STOP MERGES` on `xrpl.escrows` stops the lightweight `DELETE` a step may wait for: start merges again.

### `/v2/tokens` lists nothing, a token answers 404, a token is not `listed`, or `syncer_tokens_lag_ledgers` is high
**Nothing is listed (`"count": 0, "tokens": []`) and a token is 404 `token not found`.** Four causes, in the order to look. (1) **No generation is live yet**: a new database, or a first build under way
(an hour to a few hours on a full XRP Ledger history). `syncer_tokens_live` is 0; `syncer_tokens_building` 1 with `tokens: generation N: the account pass is at <account> ...` in the log is the build, 0 and nothing
logged is a job that does not run (the `aggregator` worker is off, or the first run failed: look for `Aggregator job tokens failed`). (2) **The token has no counting line, or its lines have not changed since the
coverage starts**: the answer's `coverage` has `"complete": false` until the state tables are whole from ledger 32,570 (`SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 3` is the
newest ledger the state tables lack), and a line that has not changed since `from_ledger_index` is not known ([backfill](backfill.md#account-state-history-re-ingest)). Filling the history builds a new generation by itself.
(3) **The currency is an AMM's LP token** (`03` and 38 hex digits): never a token here, the pool's page is `/v2/amm/pools`. (4) **The path**: `usd` names `USD`, a code outside rippled's set is
400 `invalid currency`, and a 3-character code and its 40-hex form are the same token ([api-reference](api-reference.md#tokens)).
**A token is not `listed`, or has no `domain`.** The listing is two-way and comes from D4's store: the issuer's account must have a Domain in `account_domains` (seed it, [backfill](backfill.md#account-domains-seed)), the
`tomls` worker must have read that domain's toml (`GET /v2/toml/{domain}`, [Account names and tomls](api-reference.md#account-names-and-tomls)), and the toml must have a `[[CURRENCIES]]` entry with the token's code and
issuer that counts on this network (`network` empty or the network's name). A change shows after the job's sweep, within tens of minutes ([operations](operations.md#issued-tokens)).
**`syncer_tokens_lag_ledgers` is high or stays still.** The gauge follows the head also while the job's steps fail; a database that is down freezes it, so read it with
`rate(syncer_aggregator_errors_total{job="tokens"}[15m])`. Causes: a step that fails (a window, a batch, a rebuild check: `Aggregator job tokens failed...`, and after two in a row it waits 5 minutes,
doubling to an hour), a window of a heavy ledger (a few seconds: it halves itself and the lag falls once it is applied), a reprocess whose repair is under way (`syncer_tokens_repair_ledgers` above 0), or a
generation marked stale whose replacement is still building (`syncer_tokens_building` 1: the live one serves meanwhile, with its last `through_ledger`). **A build that never ends** and a log line every ten minutes saying
`tokens: generation N was stale while it built; it is retired` is a coverage start that keeps moving (a history fill below the oldest stored ledger, or a rewrite of the newest ledger of a parser older than 3, is under way):
the job starts the build again from the first account at each housekeeping. Finish the fill; the next build runs to the end ([backfill](backfill.md#issued-tokens-re-ingest)).

### `agg_dirty` does not drain: the tokens hook fails
**Symptom:** `SELECT count() FROM xrpl.agg_dirty` does not fall, `syncer_aggregator_errors_total{job="tokens_dirty"}` rises at each tick, and the log has `Aggregator job tokens_dirty failed in <from> - <to>: ...`
(`the tokens job has not read its version floor yet` or `could not read its generations at its last run`). The hook of the `tokens` job is the last of a slice's hooks and refuses to run while the job cannot
read its generations, so the slice stays queued **for every job** and its earlier hooks run again at each tick. A database without **migration 014** does not cause it: the syncer refuses to boot without the
tables (`lacks the schema of 014_issued_tokens.sql`: apply it with `dc run --rm migrate-xrpl` and start the syncer again). The opening reads fail because ClickHouse refuses them (down, a memory or time limit); if the
boot log says `Could not check that 014_issued_tokens.sql is applied`, ClickHouse was unreachable at the boot and the migration may be the cause (`Table ... token_generations doesn't exist` in the log of the job):
apply it, and the next tick drains the queue. Fix the cause. No mark is lost meanwhile ([operations](operations.md#a-persistent-tokens_dirty)).

### The Xahau syncer is halted on a payment channel that holds an issued token
**Symptom:** `state=halted` and `error: Cannot parse ledger <index>: ... dropsToNative: invalid value '[object Object]' ...`. Before parser version 7, `BalanceChangesParser` read the amounts of a payment channel as drops, and a channel that holds an issued token (Xahau, `PaychanAndEscrowForTokens`) made it
throw, so the live syncer stopped at its ledger (`state=halted`, [operations](operations.md#syncer-halted)) and a range-ingest chunk with it failed. This release types the amounts, and
the syncer goes on from its checkpoint when it is deployed ([ADR-0010](adr/0010-ripple-v2-wire-compatibility.md) item 92). Apply migration 013 first, as for the rest of the release.

### A delegated transaction's fee is on the sender, or the delegate's list lacks it
The ledger was written by a parser older than version 7. From version 7 on the `transaction_cost` row of a delegated transaction is the delegate's, and the delegate has the
transaction in its own list (`account_transactions`), also when the metadata names none of its accounts. Re-ingest the ledger: `range-ingest --from 107524865 --to <deploy ledger>
--reprocess` ([backfill](backfill.md#ledger-objects-and-delegation-re-ingest)).

### AMM swaps, pools or days are missing before a date
The ledgers were written by parser version 1, which has no AMM rows (`SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 86795265 GROUP BY
parser_version`). Re-ingest them with `--reprocess` from the enablement ledger 86795265 ([backfill](backfill.md#amm-data-re-ingest)); the aggregator then rebuilds
`amm_pools`, `amm_daily` and the AMM volume from `agg_dirty`.

### `/balances` or `/orders` answer 400 `the date provided is too old`, 404 `account not found` or 500
`/orders`, and `/balances` for the current ledger (none named, `validated`, `closed`, `current`), read the live node (`GH_NODE_ENDPOINTS` of
the **api**): a date before the first stored ledger or a ledger the node no longer has is the 400; an address the node does not know is the
404; an unreachable node is the 500 `unable to retrieve balances|orders`. Check the node and the api log (`XrplService`). `/balances` at a
historical ledger (a hash, a date or a ledger number) reads the state history in ClickHouse instead: the 400 is a ledger this API does not
hold or one the state history does not cover (see [backfill](backfill.md#account-state-history-re-ingest)), the 404 an account with no
state at that ledger or one deleted at or before it.

### Syncer: `Node network_id N does not match GH_NETWORK=...`
The endpoint belongs to another network: an XRPL node for a Xahau syncer or the reverse, a mainnet node for a testnet process (a mainnet rippled reports
no `network_id`, which only `xrpl` accepts), or a testnet node for a mainnet one (`GH_NETWORK=xahau` refuses Xahau Testnet's node, `network_id` 21338). Each network
accepts exactly its own ids ([syncer](syncer.md)). Fix `GH_NODE_ENDPOINTS` / `XRPL_NODE_ENDPOINTS` / `XAHAU_NODE_ENDPOINTS`, and for a sandbox leave them blank
(the testnets' defaults) or give testnet nodes only.

### `rate limit: units quota ... exhausted, retry in ~<N>ms` / `It rate limits this client`
A public node throttles this process. The node client pauses that endpoint for the time it named (logged once, counted in
`syncer_node_rate_limited_total` / `api_node_rate_limited_total`) and uses the next endpoint of `GH_NODE_ENDPOINTS` meanwhile;
nothing is lost, the syncer waits. If it happens all the time: lower `GH_CATCHUP_CONCURRENCY` (2 for `wss://xahau.network`), list
a second endpoint, or use a node of your own. For `range-ingest` see [backfill](backfill.md#public-nodes-and-rate-limits).

### Syncer: lag does not fall / halted
See [operations](operations.md#after-an-outage): a node without the history (`complete_ledgers`), ClickHouse refusing writes (`system.mutations`,
the probe's `recovering`/`error`), a chain break, a ledger the parser rejects (`error: Cannot parse ledger <index>: ...`) or a lost lease
(`state=halted`, see [operations](operations.md#syncer-halted)).

### Syncer halted: `The node's validated ledger <head> has hash <h1>, but ledger <head> is stored with hash <h2>: the network was reset, or the node is of another chain`
**Symptom:** `state=halted`, a 503 on the syncer's probe, and this `error`.

**Root cause:** the node's validated head is below the committed checkpoint, and the node's ledger at `<head>` has another hash than the one stored for
that index. Two hashes at one index can only be two chains: a testnet that was reset (its indexes start again), or a node of another chain than the one
stored. The check runs on every network. A node that is merely behind has the stored hash at `<head>`; the syncer only warns and waits then.

**Fix:** on a testnet that was reset, [A testnet was reset](operations.md#a-testnet-was-reset) (drop the testnet's database and start again). If the
network was not reset, the node is the wrong one: fix `GH_NODE_ENDPOINTS` ([Syncer halted](operations.md#syncer-halted)).

### Syncer halted: `The node's validated head <head> is below the first indexed ledger <first>: the network was reset`
**Symptom:** the same, with this `error`, on a testnet.

**Root cause:** the node's validated head is below the checkpoint and below the lowest ledger the database holds, so there is no stored ledger to
compare it with. On a testnet that means the same thing as the message above. A mainnet does not halt on this: it waits, as does a testnet whose head falls
in a gap between stored ledgers.

**Fix:** [A testnet was reset](operations.md#a-testnet-was-reset).

### `api_tx_encode_fallback_total` rises
A transaction type or field is missing from the binary-codec definitions in use, so those transactions are served as their stored JSON. The
definitions come from the node's `server_definitions` (at api boot) with the bundled `config/definitions/<network>.json` as fallback: restart
the api against an up-to-date node, or refresh the bundled file with `record:fixtures`.

### Validations are missing for recent ledgers
The collector subscribes to the `validations` stream of every node in `GH_VALIDATION_ENDPOINTS` and only sees what those nodes publish; use
several independent nodes. Check `syncer_validations_flushed_total`, `syncer_validations_dropped_total{reason}` and the `ValidationsCollector` log.

## Load testing reality check

A laptop running the whole stack plus the load generator is CPU-bound by the box, not the architecture. For meaningful numbers run the generator on
another machine against a real deployment, raise `GH_RATE_LIMIT`, and keep the syncer from competing. See [load/README.md](../load/README.md).

## Quick diagnostics

```bash
# is ClickHouse reachable from the app network?
docker compose exec api-xrpl node -e "fetch('http://clickhouse:8123/ping').then(r=>console.log(r.status))"

# what is slow in ClickHouse right now?
docker compose exec clickhouse clickhouse-client -q "SELECT query_id, formatReadableSize(memory_usage), elapsed, substring(query,1,80) FROM system.processes ORDER BY memory_usage DESC"

# health and metrics (inside the compose network)
docker compose exec api-xrpl node -e "fetch('http://127.0.0.1:3001/liveliness/healthz').then(r=>r.text()).then(console.log)"
docker compose exec syncer-xrpl node -e "fetch('http://127.0.0.1:3000/metricz').then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>l.startsWith('syncer_')&&!l.startsWith('#')).join('\n')))"
```
