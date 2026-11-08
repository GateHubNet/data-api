# Operations runbook

Day-2 operations of the GateHub Data API: routine tasks, what to watch, what to do after an outage, backfill and repair, scaling
and incident playbooks. How it is deployed: [deployment](deployment.md). Metrics and health in detail:
[observability](observability.md). How the syncer works: [syncer](syncer.md).

Commands use the production compose file through a small shell function (works in bash and zsh; the env file holds secrets, do not paste
it into tickets). Define it once per shell, in the repo root:

```bash
dc() { docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod "$@"; }
```

The sandbox is the same compose file on a host of its own ([deployment](deployment.md#environments)): there the env file is `deploy/.env.sandbox`, so define
`dc() { docker compose -f docker-compose.prod.yaml --env-file deploy/.env.sandbox "$@"; }` and read the service names as the slots: `api-xrpl` serves XRPL Testnet and
`api-xahau` Xahau Testnet (`XRPL_NETWORK` / `XAHAU_NETWORK` of the file), in the databases `xrpl_testnet` and `xahau_testnet`. The SQL in this
runbook names the production databases, `xrpl.` and `xahau.`: on the sandbox write `xrpl_testnet.` and `xahau_testnet.` in their place (compose sets
no `GH_CLICKHOUSE_DATABASE`, so each network's database is the name its profile gives it).

## At a glance

| Thing | Where |
| --- | --- |
| API health | `GET /liveliness/healthz` on the api (3001): 200, or 503 when ClickHouse does not answer. The shipped nginx lets only trusted proxies reach it. |
| Syncer health | `GET /liveliness/healthz` on the syncer (3002): 503 when ClickHouse is down, the ingest is `halted`, or the lag stays above `GH_MAX_LAG_HEALTHY` for more than 60 s. The body shows `state`, `lag`, `last_commit_age`. |
| Metrics | `GET /metricz` on port 3000 of every api and syncer, inside the compose network only |
| Swagger | `GET /internal/docs` (not exposed by nginx; reach the api container directly) |
| Apply the schema | `dc run --rm migrate-xrpl` / `migrate-xahau` / `migrate-shared` (idempotent) |
| Account names | `INSERT INTO shared.account_names ...`, shows within 60 s: [Name an address](#name-an-address) |
| Account network names | `INSERT INTO xrpl.account_network_names ...` (or `xahau.`), shows within 60 s on that network only: [Name an account on one network](#name-an-account-on-one-network) |
| Labels | `INSERT INTO shared.account_labels ...`, shows within 60 s: [Label an address](#label-an-address) |
| Ingest progress | `syncer_checkpoint_ledger`, `syncer_head_ledger`, **`syncer_lag_ledgers`**, `syncer_last_commit_age_seconds` |
| Aggregator progress | `syncer_aggregator_stats_lag_seconds`, `rate(syncer_aggregator_runs_total[5m])`, `syncer_aggregator_errors_total{job}` (jobs `volume_live`, `volume_daily`, `amm_pools`, `nft_state`, `escrows`, `pair_hourly`, `markets_live`, `tokens`, `stats_live`, `stats_dirty`, `mpt_state`, `amm_daily`, `nft_collections`, `rates_daily`, `account_rollups`, `volume_backfill`, `supply`, and the dirty hooks `volume_dirty`, `amm_pools_dirty`, `amm_daily_dirty`, `rates_daily_dirty`, `pair_hourly_dirty`, `account_rollups_dirty`, `nft_state_dirty`, `escrows_dirty`, `tokens_dirty`, `mpt_state_dirty`, `token_history_dirty`) |
| AMM data | `syncer_amm_unclassified_total`, the `amm_pools` / `amm_daily` error labels, [the AMM jobs](#the-amm-jobs) |
| NFT data | `syncer_nft_state_lag_ledgers`, `syncer_nft_dirty_ledgers`, `syncer_nft_collections_pending`, `syncer_nft_skipped_total`, the `nft_state` / `nft_state_dirty` / `nft_collections` error labels, [the NFT data](#the-nft-data) |
| Ledger objects | `syncer_escrows_lag_ledgers`, `syncer_escrows_open`, `syncer_objects_unclassified_total`, the `escrows` / `escrows_dirty` error labels; the rollout and the re-ingest: [Ledger objects and delegation](#ledger-objects-and-delegation) |
| Issued tokens | `syncer_tokens_live`, `syncer_tokens_lag_ledgers`, `syncer_tokens_building`, `syncer_tokens_repair_ledgers`, the `tokens` / `tokens_dirty` error labels; the rollout, the first build and the runbook: [Issued tokens](#issued-tokens) |
| MPT state | `syncer_mpt_state_lag_ledgers`, the `mpt_state` / `mpt_state_dirty` error labels: [The MPT state job](#the-mpt-state-job) |
| Token history | `syncer_token_history_lag_ledgers`, `syncer_token_history_rebuild_needed{reason}`, `syncer_token_history_building{phase}`, `syncer_token_history_errors_total{step}`, the `token_history_dirty` error label; the rollout, `token-history-build` and `token-history-check`: [The token history](#the-token-history) |
| Supply | `syncer_supply_snapshot_age_seconds`, `syncer_supply_cycle_seconds`, `syncer_parser_anomalies_total{kind}`, the `supply` error label; reading the newest row and the re-ingests: [Supply snapshots](#supply-snapshots) |
| Display names | `syncer_tomls_due`, `syncer_tomls_domains{status}`, `syncer_tomls_checks_total{outcome}`, `syncer_tomls_discovery_seconds`; the rollout and the seed: [The display names](#the-display-names) |
| Validators progress | `syncer_validators_rounds_lag_ledgers`, `syncer_validators_agreement_lag_seconds`, `syncer_validators_unl_expiry_seconds`, `syncer_amendments_without_metadata` (the rollout: [Roll out the validators and amendments data](#roll-out-the-validators-and-amendments-data)) |
| Exports | `exporter-xrpl` / `exporter-xahau` (profile `exports`, one each): `GET /liveliness/healthz` on 3005, `exporter_jobs_total{status}`; the jobs are rows of `export_jobs` ([deployment](deployment.md#topology)) |
| Account and market aggregates | `syncer_markets_live_age_seconds{period}`, `syncer_markets_live_amm_share_known{period}`, `syncer_pair_hourly_missing_hours`, `syncer_rates_daily_missing_days`, `syncer_account_rollups_pending_accounts`; see [Account and market aggregates](#account-and-market-aggregates) and [the AMM data additions](#the-amm-data-additions) |

Two services per network, never more than **one syncer**: `syncer-xrpl`, `syncer-xahau` are singletons (a fixed
`container_name`, so compose refuses to scale them, and an application-level lease in ClickHouse that refuses a second writer).
The apis (`api-xrpl`, `api-xahau`) scale freely.

## Routine tasks

### Deploy a new version

**Release checklist.** A rippled or xahaud release with new amendments gets its entries in the amendment metadata *before* the deploy
([Keep the amendment metadata current](#keep-the-amendment-metadata-current)).

```bash
git pull                                              # or check out the release tag
export NPM_TOKEN=...                                  # the private @gatehub/toolbox; BuildKit secret, never baked in
dc build                                              # builds gatehub/data-api and gatehub/data-syncer from this checkout
dc up -d --scale api-xrpl=<n> --scale api-xahau=<m>   # migrate jobs run first (idempotent), then recreates what changed
```

**Repeat your `--scale` flags on every `up`**: a plain `dc up -d` converges every service to its configured count and scales the apis back to 1.

**There is no rolling update and no zero-downtime deploy with compose.** `up -d` recreates every container of a changed service **together**: while the new
api containers start (a few seconds to the end of their healthcheck `start_period`) that network's host answers 502 from nginx, and the other network is not
affected. A changed **syncer** is stopped (SIGTERM, 30 s grace: it finishes its write and releases the lease) before the new one starts, so the two never
overlap; the new one catches up from its checkpoint, and the api keeps serving what is committed meanwhile. Order does not matter for the schema: the migrate
jobs run before the apps start (the syncer needs migration 002 applied before it starts, see [Apply a schema migration](#apply-a-schema-migration)). If a brief outage per release is not acceptable, put an orchestrator with rolling updates (Kubernetes, see
[deployment](deployment.md#option-3-kubernetes)) in front of the same images, or run a second compose project next to the first and switch the nginx
upstream between them; neither is shipped or tested here.

### Apply a schema migration

Migrations are the `*.sql` files in `packages/shared/schema/`, applied in file-name order, each once, and recorded with a SHA-256
checksum in `<database>.schema_migrations`. To change the schema add a new `NNN_*.sql` and run the migrate job
(`dc run --rm migrate-xrpl && dc run --rm migrate-xahau`, or `dc up -d --scale api-xrpl=N --scale api-xahau=M` with your own scale
flags: a plain `dc up -d` scales the apis back to 1). **Never edit an applied file**: its changed
checksum is a hard error (`Migration ... was modified after being applied`). All DDL is `CREATE ... IF NOT EXISTS`, so a file that
failed halfway can simply be run again. Run migrations as a one-shot step, not from every replica. Details:
[data-model](data-model.md#5-migrations).

**The syncer needs migration `002_validators_amendments.sql` applied before it starts.** Its collector inserts rows as `JSONEachRow`, and ClickHouse
refuses a row that has a field the table lacks, so a syncer of this version with the `validations` or `validators` worker refuses to boot against a
database without `002`: the message names the file and what is missing. Apply the migration and start it again.
The compose files order it for you (the syncer waits for its `migrate-<network>` job); with another orchestrator run the job first. The whole rollout
(and the constraint with `feat/amm-data`) is [below](#roll-out-the-validators-and-amendments-data).

**The ingest needs migrations `007_path_payments.sql` and `008_account_path_payments.sql` applied before a syncer with parser version 4
starts.** That syncer writes `path_payments` and `account_path_payments` row sets with every ledger, and an insert into a missing table
fails the batch, so the live runner retries the same ledgers without end. Nothing checks for the tables at boot: run the migrate job
first (the compose files do). The api's `/v2/path_payments` and `/v2/accounts/{address}/path_payments` answer 500
`unable to retrieve path payments` until the tables exist. Filling the history:
[backfill](backfill.md#path-payments-re-ingest).
**The ingest needs migration `011_nft_data.sql` applied before a syncer with parser version 5 or later starts, and the api after it.** That syncer writes the
five NFT tables (`nft_events`, `account_nft_events`, `collection_nft_events`, `nft_sales`, `nft_touches`) with every ledger, and an insert into a
missing table fails the batch, so the live runner retries the same ledgers without end; the NFT aggregator jobs read the other tables of the file.
Nothing checks for the tables at boot: run the migrate job first (the compose files do), then deploy the syncer, then the api (the NFT routes answer
500 until the tables exist). The rollout and the history: [The NFT data](#the-nft-data), [backfill](backfill.md#nft-re-ingest).
**The ingest needs migration `013_ledger_objects.sql` applied before a syncer with parser version 7 starts, and the api after it.** That syncer writes `object_changes` and
`account_object_changes` with every ledger, and an insert into a missing table fails the batch, so the live runner retries the same ledgers without end; the `escrows` job reads
and writes the third table of the file. Nothing checks for the tables at boot: run the migrate job first (the compose files do), then deploy the syncer, then the api (the
object routes answer 500 until the tables exist). The rollout and the history: [Ledger objects and delegation](#ledger-objects-and-delegation),
[backfill](backfill.md#ledger-objects-and-delegation-re-ingest).
**The ingest needs migration `014_issued_tokens.sql` applied before a syncer with parser version 8 starts, and the api after it.** That syncer writes `state_touches` with every ledger,
and an insert into a missing table fails the batch, so the live runner would retry the same ledgers without end; the `tokens` job reads and writes the other three tables of the file.
A syncer with the `ingest` worker (it needs `state_touches`) or the `aggregator` worker (it needs all four tables) therefore refuses to boot against a database without them: the message
names the file and the tables that are missing (`lacks the schema of 014_issued_tokens.sql`). Run the migrate job first (the compose files do), then deploy the syncer, then the api (the
token routes answer 500 until the tables exist).
**The ingest and the aggregator need migration `015_supply.sql` applied before a syncer with parser version 9 starts, and the api after it.** That syncer writes `genesis_mints`, `imports` and `reward_claims` on Xahau,
whenever a ledger has mint rows (a successful `GenesisMint` or `Import`, or any `ClaimReward`) (on XRPL they stay empty and nothing is written to them), and an insert into a missing table fails the batch, so the live runner
would retry the same ledgers without end. The `supply` job of the aggregator reads the three tables on Xahau (it plans no read of them on the XRP Ledger) and writes the fourth, `network_supply`, on both networks. A syncer with the `ingest` worker therefore refuses to boot against a
database without the three mint tables, and one with the `aggregator` worker against a database without all four: the message names the file and the tables (`lacks the schema of 015_supply.sql`), on every network, since the schema is one
on every network (on Xahau an insert into a missing mint table fails the batch and the `supply` job reads them; the check is the same on both networks, as the schema is). Run the migrate job first (the compose files do), then deploy the syncer, then the api (the supply routes answer 500 until the tables exist).
**The `validators` worker needs migration `016_validator_toml_details.sql` applied before it starts, and the api after it.** The domain checker reads and writes the five columns it adds to `validator_domains`, and every validators route of the api reads them, so a syncer with the `validators` worker refuses to boot without them (`lacks the schema of 016_validator_toml_details.sql`), and those routes answer 500 until they exist. Run the migrate job first (the compose files do), then deploy the syncer, then the api.
**The ingest and the aggregator need migration `017_mpt.sql` applied before a syncer with parser version 10 starts, and the api after it.** That syncer writes `mpt_issuance_states`, `mpt_holder_states`, `mpt_touches`, `mpt_transfers` and `mpt_issuance_transfers` on XRPL and XRPL Testnet, whenever a ledger has MPT rows (on Xahau and Xahau Testnet there are none), and an insert into a missing table fails the batch, so the live runner would retry the same ledgers without end. The `mpt_state` job of the aggregator reads the five tables and writes `mpt_issuances` and `mpt_holders`. A syncer with the `ingest` worker therefore refuses to boot against a database without the five, and one with the `aggregator` worker without `mpt_touches`, the two state tables and the two aggregates: the message names the file and the tables (`lacks the schema of 017_mpt.sql`), on every network, since the schema is one. Run the migrate job first (the compose files do), then deploy the syncer, then the api (the MPT routes answer 500 until the tables exist).
**The `token_history` worker and the aggregator need migration `019_token_history.sql` applied before they start, and the api after it.** The worker reads and writes its seven tables, and the aggregator's eighth hook writes `token_history_dirty`, so a syncer with the `token_history` worker refuses to boot without the seven (and the tables it reads), and one with the `aggregator` worker without `token_history_dirty` (`lacks the schema of 019_token_history.sql`). The api's token history routes read the tables, and `/v2/tokens/{token}/holders` reads `token_history_state` first to choose its source. Run the migrate job first (the compose files do), then deploy the syncer, then the api ([The token history](#the-token-history)).
**The shared database has migrations of its own.** `packages/shared/schema-shared/` holds the schema of the `shared` database (account names and labels,
[ADR-0014](adr/0014-address-names-and-labels-in-a-shared-database.md)), numbered from 001 and recorded in `shared.schema_migrations`. One job applies it
for both networks, `dc run --rm migrate-shared` (the command `migrate.js shared`); never run it from two places at once. **It must run before an api
that reads it**: the compose files make both apis wait for it. An api started without it serves every account without a name or label and logs
`Could not load the account names` (and `the account labels`) at every reload, until the job has run. An api of this version on a shared
database migrated before `002` serves the names and logs `Could not load the account labels` until the job has run again.

### Name an address

The **account name** of an address ("GateHub", "Bitstamp") is written by hand into `shared.account_names` and shows on
`GET /v2/accounts/{address}` (`account_name`) of **every network** within 60 s (`GH_NAMES_AND_LABELS_RELOAD_MS`), with no restart. The table is
append-only: never `UPDATE`, `DELETE` or `OPTIMIZE ... FINAL` it, because its rows are the audit trail. The newest row of an address wins, so
renaming is another insert and removing is an insert with `removed = 1`. Put your own name or email in `added_by`; `added_at` is filled in. A
name shows only on a network where the address has an activation: elsewhere `/v2/accounts/{address}` answers 404 as before. (`GET /v2/account_names`
answers the name and the labels of any address, an account on that network or not, on the same reload.)

In `clickhouse-client` (see [SQL health checks](#sql-health-checks) for how to open it):

```sql
-- give an address a name, or a new one (the newest row wins)
INSERT INTO shared.account_names (address, name, added_by)
VALUES ('<address>', 'GateHub', 'ops@gatehub.net');

-- remove the name of an address
INSERT INTO shared.account_names (address, name, removed, added_by)
VALUES ('<address>', '', 1, 'ops@gatehub.net');

-- the name each address has now, as the api reads it
SELECT address, name, added_by, added_at
FROM (SELECT * FROM shared.account_names ORDER BY address, added_at DESC, removed DESC LIMIT 1 BY address)
WHERE removed = 0 AND name != '';

-- the history of one address
SELECT * FROM shared.account_names WHERE address = '<address>' ORDER BY added_at;
```

Nothing checks the address or the name: a typo in either shows within a minute, and is fixed with a newer row. With
`GH_CLICKHOUSE_SHARED_DATABASE` set, use that database in place of `shared`.

### Name an account on one network

The **account network name** of an account ("USD Issuer" for GateHub's issuing address on the XRP Ledger) is written by hand into
`account_network_names` of **that network's database** (`xrpl`, `xahau`, `xrpl_testnet` or `xahau_testnet`, migration `009`) and shows on `GET /v2/accounts/{address}`
(`account_network_name`, after `account_name`) of **that network only**, within 60 s (`GH_NAMES_AND_LABELS_RELOAD_MS`), with no restart. It
needs no account name: an account can have either, both or neither. The table has the columns and rules of `shared.account_names`: append-only
(never `UPDATE`, `DELETE` or `OPTIMIZE ... FINAL` it), the newest row of an address wins, removing is an insert with `removed = 1`, your own name or
email goes in `added_by` and `added_at` is filled in. It shows only where the address has an activation.

```sql
-- give an account a name on the XRP Ledger, or a new one (the newest row wins)
INSERT INTO xrpl.account_network_names (address, name, added_by)
VALUES ('<address>', 'USD Issuer', 'ops@gatehub.net');

-- remove it
INSERT INTO xrpl.account_network_names (address, name, removed, added_by)
VALUES ('<address>', '', 1, 'ops@gatehub.net');

-- the network name each account has now, as the api reads it
SELECT address, name, added_by, added_at
FROM (SELECT * FROM xrpl.account_network_names ORDER BY address, added_at DESC, removed DESC LIMIT 1 BY address)
WHERE removed = 0 AND name != '';

-- the history of one address
SELECT * FROM xrpl.account_network_names WHERE address = '<address>' ORDER BY added_at;
```

On Xahau write `xahau.account_network_names`, on a testnet `xrpl_testnet.` or `xahau_testnet.` (the network's database is the one its profile names). A name inserted into the wrong
network's database shows there, not on the network meant: remove it there with a `removed = 1` row and insert it into the right one. The table
comes with `migrate-<network>` (migration `009`): an api started before it serves every account without a network name and logs
`Could not load the account network names` at every reload, until the job has run.

### Label an address

A **label** (`scam`, `spam` or `advisory`) is written by hand into `shared.account_labels` and shows on `GET /v2/accounts/{address}`
(`account_labels`) of **every network** within 60 s, with the names and on the same reload. Each label carries a `description` (why the
address is marked), and optionally a `source` (who says so) and a `url` (where): leave them out, or empty, when there is none. An address
can carry several labels; each (address, label) is its own key, and its newest row wins, so changing the description, source or url is
another insert of the whole label, and removing it is an insert with `removed = 1`. The same append-only rules as for names hold: never
`UPDATE`, `DELETE` or `OPTIMIZE ... FINAL`. The label is an `Enum8`: a misspelt one (`Scam`, `scma`) fails the insert with an error
naming the value, and a new label needs a migration of `schema-shared/`.

```sql
-- put a label on an address, or replace what it says (the newest row of the address and label wins)
INSERT INTO shared.account_labels (address, label, description, source, url, added_by)
VALUES ('<address>', 'advisory', 'On the warning list of the regulator', '<who says so>', 'https://<where>', 'ops@gatehub.net');

-- a label with a description only
INSERT INTO shared.account_labels (address, label, description, added_by)
VALUES ('<address>', 'scam', 'Fake giveaway, reported by customers', 'ops@gatehub.net');

-- remove one label from an address (its other labels stay)
INSERT INTO shared.account_labels (address, label, description, removed, added_by)
VALUES ('<address>', 'scam', '', 1, 'ops@gatehub.net');

-- the labels each address has now, as the api reads them
SELECT address, label, description, source, url, added_by, added_at
FROM (SELECT * FROM shared.account_labels ORDER BY address, label, added_at DESC, removed DESC LIMIT 1 BY address, label)
WHERE removed = 0
ORDER BY address, label;

-- the history of one address
SELECT * FROM shared.account_labels WHERE address = '<address>' ORDER BY label, added_at;
```

Nothing but the `Enum8` checks a row: a typo in the address or the description shows within a minute, and is fixed with a newer row.

### Roll out the validators and amendments data

The change that adds the `validators` worker, migration `002` and the validators and amendments routes ([ADR-0012](adr/0012-validators-and-amendments-data.md)).

**Constraint.** Deploy it to a persistent environment only after `feat/amm-data` is merged, or accept losing what it collected: that branch edits
`001_baseline.sql` in place, the migration runner refuses the changed checksum, so a database created before the merge is recreated, and the
`validations` (90 days), votes, tallies, agreement, first-seen history, stored UNL lists, domain results and polled ledger states (`network_state`) cannot be recomputed
([deployment](deployment.md#rolling-out-the-validators-and-amendments-data) has the whole text).

**Order.** `migrate-<network>` (applies `002`), then `syncer-<network>`, then `api-<network>`. `dc up -d` with your `--scale` flags runs the migrate jobs first
and starts the syncers and the apis together once they are done (an api that comes first answers from empty tables, with no errors; everything is additive,
so a rollback removes the routes or takes `validators` out of `GH_WORKERS`, and `002` needs no undo). Before it: the amendment metadata is filled ([below](#keep-the-amendment-metadata-current)), `GH_WORKERS` includes `validators` where it is set
explicitly, and egress to the publishers (and to the validators' domains, or `GH_DOMAIN_VERIFICATION=false`) is open.

**Filling.** After the syncer starts the tables fill by themselves; the times are estimates for XRPL, and the metrics ([observability](observability.md))
show the progress:

| Data                                      | Ready after                                                                                                                                                                                                                            | Watch                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| UNL lists, network state, amendment names | The first fetch and poll: seconds to a minute                                                                                                                                                                                          | `syncer_validators_unl_fetches_total{outcome="ok"}`, `syncer_validators_node_polls_total`; the `unl.publishers` of the summary |
| First seen                                | The seeding scan of `validations`, in the background, one statement per partition: about a minute                                                                                                                                      | The log line `validator_seen was seeded from validations`                                                                      |
| Domain verification                       | Passes of up to 100 checks a minute: minutes for a few hundred domains                                                                                                                                                                 | `syncer_validators_domain_checks_total`                                                                                        |
| Versions                                  | The first voting ledger after the new collector: at most about 17 minutes                                                                                                                                                              | `version` on a validator row                                                                                                   |
| Votes and tallies                         | The back-fill of the retained rounds (up to about 7,600 on XRPL), 5 s of every minute: about 1-2 hours                                                                                                                                 | `syncer_validators_rounds_lag_ledgers` falling to 0; `votes_through_ledger` of the summary                                     |
| Agreement 1 h / 24 h / 30 d               | A day per query during catch-up, 10 s of every minute: about 1-2 hours for 90 days. A window is complete once the collector has run, and the ledgers are indexed, for as long as the window is: 30-day agreement needs 30 days of both | `syncer_validators_agreement_lag_seconds`; `agreement_through` of the summary; `incomplete` on a window                        |
| Recent validations of a validator         | From the deploy on (the table keeps 7 days)                                                                                                                                                                                            | `GET /v2/network/validators/{key}/validations`                                                                                 |

History from before the collector ran does not exist: "first seen" means first seen by this deployment, and there is no agreement or vote
history before the first stored hour or round.

### Keep the amendment metadata current

No node or ledger serves an amendment's version, standard or description, so they are kept by hand in
`packages/shared/config/amendments/xrpl.json` and `xahau.json` (shipped with the package; the shape is in the
[design](superpowers/specs/2026-10-19-validators-amendments-design.md), 2.6). A testnet reads the file of its family, so there are two
files for four networks: XRPL Testnet reads `xrpl.json` and Xahau Testnet `xahau.json`, both without their `enabled` entries, which record
mainnet's ledgers and dates (a testnet's own ledger says when an amendment was enabled there). Do this after every rippled or xahaud
release that adds or retires amendments, and before the deploy that needs it:

```bash
pnpm --filter @gatehub/data-api-shared amendments:check -- --network xrpl
pnpm --filter @gatehub/data-api-shared amendments:check -- --network xahau --clickhouse
pnpm --filter @gatehub/data-api-shared amendments:check -- --network xrpl-testnet
pnpm --filter @gatehub/data-api-shared amendments:check -- --network xahau-testnet
```

It asks a public node (`--endpoint <wss url>`, by default the first default endpoint of the network) for `feature` and the `Amendments`
ledger object, prints three lists and exits 1 when any is not empty. A node of the other network (its `server_info.network_id`) fails the
run before anything is compared. With `--clickhouse` it also reads the newest round's votes and the
indexed `EnableAmendment` transactions from the database the `GH_CLICKHOUSE_*` variables name.

On a testnet it checks the family file against the testnet's node (by default the first default endpoint of the testnet profile). A
testnet runs newer builds than mainnet, so its node can know names the file lacks: on 2026-10-24 Xahau Testnet had 14 amendments that Xahau
mainnet did not (`RNG`, `HookOnV2` and `fixXahauTestnetGenesis` among them), and each belongs in `xahau.json` like any other new name. A name
that only a testnet's own build has, and no release carries (`fixXahauTestnetGenesis`), is marked `obsolete: true` as well: the file is shared,
and unmarked the name would be a `voting` row with no votes for ever on Xahau mainnet, whose node does not know it. Marked, mainnet shows it
`obsolete` and the testnet, whose ledger lists it, `enabled`. The third list is always empty on a testnet, because the file's `enabled`
entries are dropped there and none can contradict the index.

| List | What to do |
| --- | --- |
| Names the node knows that the file lacks | Add an entry with the `name` (the ID is computed, never written) and, from the release notes, `introduced` (a rippled version `1.12.0` on XRPL, a xahaud date version `2024.4.21` on Xahau). Add `xls` / `xls_url` (under `https://github.com/XRPLF/XRPL-Standards/`) and `description` (one line, at most 200 characters) when you have them. |
| IDs in the ledger or the votes that no one names | The node may lack a name. Find it in the newest `features.macro` of rippled or xahaud (an ID is the SHA-512Half of the name) and add the entry. |
| Entries whose `enabled.ledger_index` contradicts the index | The indexed `EnableAmendment` is right: correct or remove the `enabled` of the entry. |

Mark an amendment `obsolete: true` when current software can no longer vote it in (rippled's `VoteBehavior::Obsolete`, a withdrawn one),
and `retired: true` for a name that rippled lists with `XRPL_RETIRE` (xahaud's retired list on Xahau): its code is unconditional, and a
ledger begun after the retirement no longer lists it. The 15 retired names are marked on both families; keep their `enabled` on XRPL (mainnet's
`Amendments` object still lists them, so the API shows their ledger and day, with `retired: true` beside them). XRPL Testnet's ledger lacks
them, so the API shows them `enabled` with `retired: true` and no `enabled` object. Set `updated`. An invalid file (a duplicate name, an
unknown key, an `xls_url` outside the standards repository) fails the loader with the entry named.

### Rotate an API key

`GH_API_KEYS` is comma separated and read at boot, so a change needs a restart of the apis. Rotate in two steps so that no client has to switch at the
same instant: add the new key beside the old one in `deploy/.env.prod` (`old,new`) and `dc up -d` (repeat your `--scale` flags), move the clients,
then remove the old key and `dc up -d` again (with the same `--scale` flags). Each `up` recreates the apis of both networks together, i.e. a brief 502 from nginx (see
[Deploy a new version](#deploy-a-new-version)). The API refuses to start with an empty list, or a key that is `dev-api-key` or starts with `change-me`.
A key that has an entry in `GH_RATE_LIMIT_KEYS` is rotated there in the same edit: add `new=limit` beside `old=limit` with the first step and remove
`old=limit` with the second, or the new key is limited per client address. An entry whose key is not in `GH_API_KEYS` fails the boot of every api, so
removing the old key from `GH_API_KEYS` alone is an outage (the message names the entry by position, never the key).

### Rotate a validator list publisher

`GH_UNL_PUBLISHERS` (in the compose stacks `XRPL_UNL_PUBLISHERS` / `XAHAU_UNL_PUBLISHERS` of `deploy/.env.prod`) pairs the URL of each
validator list publisher with its master key and is read at boot. A publisher that moves its signing key by a new manifest needs
nothing from you: the syncer follows the manifests in the lists it fetches. When the **master key** or the **URL** changes:

1. Edit the entry (`https://vl.example.org=<new key>`), or add the new one beside it, and apply it with `dc up -d` (repeat your `--scale` flags, see
   [Deploy a new version](#deploy-a-new-version)): only the syncer of that network is recreated, a brief restart. An invalid entry fails the boot with `GH_UNL_PUBLISHERS entry <n>: <why>`.
2. A publisher that is no longer listed is not fetched again. Its `unl_publishers` row is kept with `configured = 0` and its lists stay in
   `unl_lists`, but it no longer counts: the trusted UNL is built from the configured publishers only. A new entry gets its row at the
   first start and its first list at the first fetch.
3. Check the new publisher:
   `SELECT publisher, argMax(configured, checked_at) AS configured, argMax(status, checked_at) AS status, argMax(error, checked_at) AS error FROM xrpl.unl_publishers GROUP BY publisher`
   shows `configured = 1`, `ok` and an empty `error` for it, and `configured = 0` for the one you replaced.

The id of a publisher is its URL, so a new key at the **same** URL is the same publisher, with the same `unl_publishers` row (it
stays `configured = 1`). Its lists are told apart by key: a list of the new key is compared only with the lists stored under the new
key (`unl_lists.publisher_key`), so a publisher that starts numbering anew with its new key is not `stale`. The lists of the old key
stay in `unl_lists` and count for nothing.

### Rotate the ClickHouse password

`data_api` is not a SQL-created user: the clickhouse-server entrypoint writes `users.d/default-user.xml` (a user defined in XML, with `default` removed) from
`CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` on **every container start**, and ClickHouse refuses to change an XML-defined user (`ALTER USER data_api ...` fails with
`ACCESS_STORAGE_READONLY`; checked on 26.8.14.3). In `docker-compose.prod.yaml` the server's `CLICKHOUSE_PASSWORD` and the `GH_CLICKHOUSE_PASSWORD` of the
migrate jobs, syncers and apis are all the same `GH_CLICKHOUSE_PASSWORD` of `deploy/.env.prod`. So:

```bash
# 1. set the new GH_CLICKHOUSE_PASSWORD in deploy/.env.prod (from your secrets manager)
dc up -d --scale api-xrpl=<n> --scale api-xahau=<m>
```

Compose sees the changed environment and **recreates the clickhouse container and every client** (migrate jobs, syncers, apis; nginx is unchanged). The data volume is
kept, the new container regenerates the XML user with the new password, and the clients start with it; the syncers catch up from their checkpoints. Expect a short
outage of the whole stack (ClickHouse restarts). Any other client of the database (backups, a Prometheus exporter, your own `clickhouse-client` sessions) needs the new
password too.

### Reclaim space after a big load

`ReplacingMergeTree` collapses duplicates only on background merges, and list queries never rely on that. To compact after a large
backfill or `--reprocess`:

```sql
OPTIMIZE TABLE xrpl.transactions FINAL;   -- per table, off-peak; expensive on big tables
```

### Retention

Five tables expire on their own, by TTL: `validations` (90 days), `validator_validations` (7 days), `network_state` (100 days),
`validator_agreement_hourly` (400 days) and `pair_hourly` (45 days); none of them is a ledger table ([clickhouse](clickhouse.md#retention-and-ttl)). Raw ledger data is deleted by
dropping whole partitions, **but a ledger exists only if all its tables agree**:

- `ledgers` is the commit marker; `range-ingest` **skips every ledger that has a `ledgers` row** (it believes it is complete), and the live syncer never looks
  behind its checkpoint.
- A ledger that has a `ledgers` row but fewer stored transactions than its `tx_count` is answered with **500** by `/v2/ledgers/{id}` (and its hash list); lists of
  payments, exchanges and balance changes silently lose the rows whose tables were dropped.

So never drop the partitions of one table alone. Drop **the same ledger range from 39 of the 40 ledger-derived tables, all but `account_domains`**, in blocks
aligned to the **10,000,000-ledger partitions of the P7 tables** (the P6 tables `ledgers`, `transactions`, `payments`, `amm_pool_touches`, `path_payments`, `nft_sales`, `nft_touches`, `state_touches`, `genesis_mints`, `imports`, `reward_claims`, `mpt_touches`, `mpt_transfers` have ten 1,000,000-ledger partitions per block; `accounts_created` has no partition and
is cleaned with a `DELETE`). `ledgers` goes first (the commit marker: the ledgers vanish from every list at once), then the children. For the block 80,000,000-89,999,999
(P7 partition 8, P6 partitions 80-89) of the XRPL database:

```bash
# run from the repo root; clickhouse-client authenticates with the container's own environment (the secret never touches the host command line)
ch() { dc exec -T clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" -q "$0"' "$1"; }
for p in 80 81 82 83 84 85 86 87 88 89; do ch "ALTER TABLE xrpl.ledgers DROP PARTITION $p"; done      # the commit marker first
for p in 80 81 82 83 84 85 86 87 88 89; do for t in transactions payments amm_pool_touches path_payments nft_sales nft_touches state_touches genesis_mints imports reward_claims mpt_touches mpt_transfers; do ch "ALTER TABLE xrpl.$t DROP PARTITION $p"; done; done
for t in ledger_by_hash tx_by_hash tx_by_type account_transactions account_tx_by_sequence payments_by_currency account_payments exchanges account_exchanges balance_changes \
         amm_pool_states amm_liquidity account_amm_liquidity amm_governance account_states trust_line_states account_path_payments \
         nft_events account_nft_events collection_nft_events object_changes account_object_changes \
         mpt_issuance_states mpt_holder_states mpt_issuance_transfers; do
  ch "ALTER TABLE xrpl.$t DROP PARTITION 8"
done
ch "DELETE FROM xrpl.accounts_created WHERE ledger_index BETWEEN 80000000 AND 89999999"
```

**`account_domains` is kept** (it is not in the loop). It holds the current Domain of an account in the row of the account's last change, and merges keep
about one row per account and partition, so a partition is small and no route reads it per ledger. Dropping one would forget the domain of every account that
has not changed since that block, until its next change, and nothing can bring it back: the [seed](backfill.md#account-domains-seed) reads `account_states`,
whose rows of the block are dropped too. A `range-ingest` of the block later writes the same rows again (the same `version`), and `--reprocess` deletes and
rewrites them as it does in every table.

The rollups (`stats_hourly`, `volume_*`, `amm_pools`, `amm_daily`) and the issued token tables (`token_generations`, `token_lines`, `tokens`: [Retention of the token tables](#retention-of-the-token-tables)) and the MPT aggregates (`mpt_issuances`, `mpt_holders`: [Retention of the MPT tables](#retention-of-the-mpt-tables)) and the token history (migration 019: [Retention of the token history](#retention-of-the-token-history)) are not touched: old hours keep their numbers (that is usually what you want); `fee_stats`, `validations`, the tables of the validators and amendments data (migration 002) and the account and market aggregates (migration 003) are independent: a dropped block reaches the aggregates only through `agg_dirty` when it is ingested again. A block dropped from the AMM tables and
brought back by `range-ingest` marks `agg_dirty`, and the aggregator rebuilds the pools and days it covers.

To **bring a dropped block back**, run `range-ingest` over the same range: with no `ledgers` rows left it ingests everything. To repair a **partial** loss (some tables
dropped, or a ledger answering 500) without caring about partition alignment, use `--reprocess` over exactly the damaged range
(`range-ingest --from A --to B --reprocess`: it fetches and parses first, then deletes and rewrites those ledgers in every table, from any sub-range).

## What to watch

| Signal | Healthy | Act when |
| --- | --- | --- |
| `syncer_lag_ledgers` | 0-2 live; large and falling during catch-up | Does not fall, or is above 10 for more than a minute (the probe fails at `GH_MAX_LAG_HEALTHY`) |
| `syncer_last_commit_age_seconds` | under ~10 s live (a ledger closes every 3-4 s on XRPL) | Above 60 s with a lag of 0 means the chain is not closing ledgers or the head hint is stuck |
| syncer probe `state` | `live` (`catching_up` while behind) | `halted` (chain break, a ledger the parser rejects, or lost lease) |
| `syncer_aggregator_stats_lag_seconds` | 0 | Positive for hours: the sweep is slower than the data, see [syncer](syncer.md#7-the-aggregator) |
| `syncer_aggregator_errors_total{job}` | flat | Rising: look for the job's log lines. For `amm_pools` / `amm_daily` see [the AMM jobs](#the-amm-jobs), for `nft_state` / `nft_state_dirty` / `nft_collections` [the NFT data](#the-nft-data), for `tokens` / `tokens_dirty` [Issued tokens](#issued-tokens), for `escrows` / `escrows_dirty` [Ledger objects and delegation](#ledger-objects-and-delegation) |
| `syncer_amm_unclassified_total` | a trickle at most | A burst: the parser met a pool shape it cannot place (a new kind of AMM transaction, an MPT asset); see [backfill](backfill.md#amm-data-re-ingest) |
| `syncer_nft_state_lag_ledgers` | 0-2 once caught up (not set after a start until the job has placed its cursor: it keeps its value, 0 in a new process, and never reads the whole head) | Above 100 for more than 10 minutes (alert with a `for:` longer than a tick); large and falling is a catch-up, see [The NFT data](#the-nft-data). A read of the cursor that keeps failing shows as `{job="nft_state"}` errors, not here |
| `syncer_nft_dirty_ledgers` | 0 | Positive and not falling for an hour: a re-ingest is waiting for `nft_state` and the job is failing (`syncer_aggregator_errors_total{job="nft_state"}`); falling is the digest of a re-ingest |
| `syncer_nft_collections_pending` | 0 or small | Large after a rollout, falling by 150 or more every five minutes: see the first fill in [The NFT data](#the-nft-data); not falling at all for hours with `{job="nft_collections"}` errors rising: a collection that fails |
| `syncer_nft_skipped_total` | flat (no MPT-priced NFT offer exists today) | Rising: NFT events with an MPT amount are dropped (the parser warns in the range-ingest log), the NFT history is missing them |
| `syncer_escrows_lag_ledgers` | 0 to a few ledgers once caught up (the `escrows` job writes its watermark at every tick); large and falling is the first fill, see [Ledger objects and delegation](#ledger-objects-and-delegation) | Above 1,000 for 15 minutes (alert, paired with `rate(syncer_aggregator_errors_total{job="escrows"}[15m])`): the watermark is stuck or the job is failing. It follows the head also while steps fail |
| `syncer_escrows_open` | the open native escrows the sentinel counts (0 until the first step has run) | Not an alert; it is D7's open count |
| `syncer_tokens_live` | 1 once the first generation of the issued tokens is promoted (hours after the deploy of a new database) | 0 for longer than the first build: see [Issued tokens](#issued-tokens). It gates the explorer's `TOKENS` switch |
| `syncer_tokens_lag_ledgers` | 0 to a few ledgers (0 also while no generation is live) | Above 300 for 15 minutes (alert, paired with `rate(syncer_aggregator_errors_total{job=~"tokens.*"}[15m])`): the live generation is not following the head, see [Issued tokens](#issued-tokens) |
| `syncer_tokens_building` / `syncer_tokens_repair_ledgers` | 0 / 0 outside a build and a re-ingest | `building` 1 for days with the log's cursor not moving, or a log line every ten minutes saying the generation `was stale while it built`: a coverage start that keeps moving, finish the fill; `repair_ledgers` above 0 and not falling: a repair waiting for the replacement generation |
| `syncer_mpt_state_lag_ledgers` | 0 to a few ledgers once caught up (0 also before its first run); climbing at about 20 a minute during a stats catch-up, when the job gets no budget | Above 300 for 15 minutes outside a catch-up (alert, with `increase(syncer_aggregator_errors_total{job=~"mpt_state.*"}[2h])`): see [The MPT state job](#the-mpt-state-job) |
| `syncer_token_history_lag_ledgers` | 0 to a few ledgers once a generation is live (no sample before) | Above 30 for 10 minutes (alert, with `syncer_token_history_errors_total`): see [The token history](#the-token-history) |
| `syncer_token_history_rebuild_needed{reason}` | no series | A series at 1: a build is due, for its `reason`; run `token-history-build` ([A forced rebuild](#a-forced-rebuild-of-the-token-history)). Not an alert |
| `syncer_supply_snapshot_age_seconds` | up to about an hour plus the cycle (no series until the job has seen a snapshot) | Above 3 hours for 5 minutes outside a catch-up: see [Supply snapshots](#supply-snapshots) |
| `syncer_parser_anomalies_total{kind="import_minted_negative"}` | 0 | Any rise: a Xahau `Import` came out below 0 minted drops, which the network cannot produce, and was stored as 0 |
| `syncer_parser_anomalies_total{kind="mpt_unreadable"}` | 0 | Any rise: an MPT amount was not a `UInt64`, which the network cannot produce, and was stored as 0, or an MPT node had no ID that could be made and has no row |
| `syncer_objects_unclassified_total` | flat | Rising: a transaction changed an escrow, check, channel or delegation in a way the history has no event for (stored as event `update`), a shape the parser does not know; see [Ledger objects and delegation](#ledger-objects-and-delegation) |
| `syncer_markets_live_age_seconds{period="day"}` | under 120 s (a set a minute) | Above 600 s for 10 minutes: the Markets table is stale, see [below](#account-and-market-aggregates) |
| `syncer_markets_live_age_seconds{period=~"7day\|30day"}` | under about 300 s (a set every fifth run, about every 5 minutes); about 900 s for a few minutes after one failed set | Above 600 s for 10 minutes: that period of the Markets table is stale (the `MARKETS` switch needs all three periods under 600 s) |
| `syncer_pair_hourly_missing_hours` | 0 (745 for a few minutes after the first start of a syncer with the AMM data additions) | Above 0 for 30 minutes |
| `syncer_markets_live_amm_share_known{period}` | 1 for `day`, `7day` and `30day` once the AMM data is complete in the window; 0 is right before | Not an alert, a gate of the explorer's `AMM_DATA` switch: see [the AMM data additions](#the-amm-data-additions) |
| `syncer_rates_daily_missing_days` | 0 (the day that has just become final is computed by the next run) | Above 2 for 6 hours after the first back-fill; the size of the history on a fresh deployment, falling over about a day |
| `syncer_account_rollups_pending_accounts` | 0 | Positive for days: a heavy account is not being promoted |
| `rate(syncer_fee_stats_samples_total[5m])` | about 0.2/s | 0 (node unreachable) |
| `rate(syncer_validations_flushed_total[5m])` | positive on XRPL (validators validate every ledger) | 0 for minutes; `syncer_validations_dropped_total{reason}` rising |
| `api_http_requests_total{status=~"5.."}` | none | Spike |
| `api_http_request_duration_seconds` | p95 under 500 ms | Rising with idle api CPU: ClickHouse is the bottleneck |
| `api_tx_encode_fallback_total` | 0 | Rising: the binary-codec definitions lack a transaction type, see [troubleshooting](troubleshooting.md) |

### SQL health checks

Run them in `clickhouse-client` inside the container, which authenticates with the container's own environment (the password stays off the host command
line; `data_api` is the only user, `default` is removed):

```bash
dc exec clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD"'
```

and paste:

```sql
-- no gaps and no duplicate ledgers (span = count = distinct)
SELECT max(ledger_index) - min(ledger_index) + 1 AS span, count() AS ledgers, uniqExact(ledger_index) AS distinct
FROM xrpl.ledgers;

-- no duplicate transactions
SELECT count() AS rows, uniqExact(ledger_index, tx_index) AS distinct FROM xrpl.transactions;

-- where are the gaps?
SELECT prev + 1 AS missing_from, ledger_index - 1 AS missing_to
FROM (
  SELECT ledger_index, lagInFrame(ledger_index, 1, 0) OVER (ORDER BY ledger_index ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS prev
  FROM (SELECT DISTINCT ledger_index FROM xrpl.ledgers)
)
WHERE prev > 0 AND ledger_index - prev > 1;

-- unfinished range-ingest chunks, and who holds the syncer lease
SELECT * FROM xrpl.ingest_log FINAL WHERE status = 'started' AND range_end > 0;
SELECT network, holder, heartbeat FROM xrpl.syncer_lease FINAL;

-- stats the aggregator still has to recompute
SELECT count() FROM xrpl.agg_dirty;
```

`count()` can exceed `uniqExact(...)` for a moment on freshly rewritten ledgers (merges have not run); that is expected and is not
visible to the API.

## After an outage

**Nothing needs to be repaired by hand in the usual case.** The syncer is crash-safe by construction (see
[syncer](syncer.md#checkpoint-boot-and-recovery)):

1. Start the syncer (`dc up -d syncer-xrpl`, or let `restart: unless-stopped` do it). If it refuses to boot because the lease is
   held, a previous syncer is still running or died less than 30 s ago: stop it (`docker ps` for stray `syncer`/`data-syncer-*`
   containers of an older stack) and wait 30 s.
2. It reads the checkpoint, confirms the checkpoint's hash with the node, deletes the uncommitted tail, and catches up from
   checkpoint + 1. Watch `syncer_lag_ledgers` fall to 0.
3. The aggregator's watermark sweeps the hours that were missed by itself; `syncer_aggregator_stats_lag_seconds` shows the
   remaining work. The stats of the current hour are stale until the sweep is over.
4. **If the node no longer has the missing ledgers** (a non-full-history node: `complete_ledgers` of `server_info`), the syncer retries
   forever and the lag never falls. Point `GH_NODE_ENDPOINTS` at a full-history node (your own, or `wss://s2.ripple.com` for
   XRPL), `dc up -d syncer-xrpl` (only that service: a plain `dc up -d` would also scale the apis back to 1; repeat your `--scale`
   flags if you run a whole-stack `up`), and it carries on.
5. A ClickHouse outage is handled the same way: writes fail, the runner recovers (waits for the failed queries, deletes the
   tail, writes again) and no ledger is lost or duplicated.

Gaps **below** the checkpoint are not detected by the live syncer (it only moves forward); find them with the SQL above and fill
them with `range-ingest` (see [Backfill and repair](#backfill-and-repair)).

### Syncer halted

`state=halted` in the probe and a 503:

- `parent_hash` break or a checkpoint hash the node does not confirm: the stored chain and the node disagree about history. Find
  out which is wrong (ask a second node: `ledger` at the stored index, compare `ledger_hash`). If the **node** is on another
  chain (the wrong network) fix `GH_NODE_ENDPOINTS`. If the **stored** ledgers are wrong, re-ingest from the last
  good ledger: `range-ingest --reprocess --from <last good> --to <checkpoint>` from a stopped live syncer, then start it.
- `The node's validated ledger <head> has hash <h1>, but ledger <head> is stored with hash <h2>: the network was reset, or the node is of
  another chain` or `The node's validated head <head> is below the first indexed ledger <first>: the network was reset`: the node's head is
  below the checkpoint and its chain is not the stored one. On a testnet that is a reset: [A testnet was reset](#a-testnet-was-reset). On
  a mainnet the first message means the node is of another chain (fix `GH_NODE_ENDPOINTS`), and the second never halts it.
- `Cannot parse ledger <index>: <reason>`: the parser rejects that ledger (a transaction type or field it does not handle). It
  fails the same way every time, so the runner committed the ledgers before it and stopped instead of retrying. Look at the
  ledger (`ledger` with `transactions` and `expand` on the node), fix the parser, deploy, restart: the runner carries on at that
  ledger. `range-ingest` fails the chunk with the same message and leaves its intent open; rerun it after the fix.
- `lease lost to <holder>`: another syncer took the lease. Find and stop it; restart this one.

### Syncer falling behind

`syncer_lag_ledgers` grows while `syncer_last_commit_age_seconds` grows: check, in order, the node (`GH_NODE_ENDPOINTS`
reachable? `[NodeClient]` reconnect warnings), ClickHouse (writes failing? `recovering` in the probe body, `[LiveRunner]` errors,
stuck mutations in `system.mutations`), and disk. Live load is about one ledger per 3-4 s on XRPL; falling behind in live mode is
a downstream problem, not throughput. In catch-up, throughput is bound by the node first: raise `GH_CATCHUP_CONCURRENCY` with
your own node.

### A testnet was reset

A testnet is reset from time to time: its ledger indexes start again, under other hashes, so everything the network's database holds is of a chain
that no longer exists. The syncer notices when the node's validated head is below its checkpoint ([syncer](syncer.md#a-head-below-the-checkpoint))
and **halts** instead of waiting for ledgers the node will never have: `state=halted` and a 503 on its probe, with one of two messages:

- `The node's validated ledger <head> has hash <h1>, but ledger <head> is stored with hash <h2>: the network was reset, or the node is of another chain`:
  the node has a ledger at `<head>`, below the checkpoint, and it is not the one stored.
- `The node's validated head <head> is below the first indexed ledger <first>: the network was reset`: the node's head is lower than the first ledger the
  database holds, so there is nothing stored to compare it with. Only a testnet halts on this one.

A node that is only **behind** (the same hash at `<head>`) does not halt the syncer: it logs one warning per head, `... is below the checkpoint
<checkpoint>, with the stored hash: waiting for it to catch up`, and waits.

**Make sure it is a reset** before you drop anything: ask a second endpoint of the same network for `ledger` at `<head>`. If its `ledger_hash` is `<h1>`, the
one in the message, the network was reset. If it is `<h2>`, the stored one, the endpoint in `GH_NODE_ENDPOINTS` is the odd one out (or the wrong network):
fix it instead and restart the syncer. For the second message, a second endpoint's validated ledger is just as low.

**Start again from an empty database.** Run it on the sandbox host, with the `dc` of `deploy/.env.sandbox` (above). `<slot>` is the service family of the testnet:
`xrpl` for XRPL Testnet, `xahau` for Xahau Testnet (the sandbox runs the testnets in the `*-xrpl` and `*-xahau` services, `XRPL_NETWORK=xrpl-testnet` and
`XAHAU_NETWORK=xahau-testnet`). The database is `xrpl_testnet` or `xahau_testnet`: **never a mainnet name**, because a dropped `xrpl` or `xahau` is the
production history.

1. Stop the services that use it (the exporter only runs with the `exports` profile):

   ```bash
   dc stop syncer-<slot> api-<slot> exporter-<slot>
   ```

2. Drop the database. Open `clickhouse-client` as in [SQL health checks](#sql-health-checks), read the network the database belongs to, and drop it:

   ```sql
   SELECT network, holder FROM <database>.syncer_lease FINAL;   -- the network column must read xrpl-testnet (xahau-testnet)
   DROP DATABASE <database>;
   ```

   `<database>` is `xrpl_testnet` for XRPL Testnet and `xahau_testnet` for Xahau Testnet.

3. Create it again, with the schema:

   ```bash
   dc run --rm migrate-<slot>
   ```

4. Start the syncer and the api (only these: a plain `dc up -d` would also scale the apis back to 1, and so does naming `api-<slot>` without a `--scale`; start
   `exporter-<slot>` again after them if exports are on, which the sandbox has only with a bucket of its own):

   ```bash
   dc up -d --scale api-<slot>=<n> syncer-<slot> api-<slot>      # <n>: the replicas the api had (1 unless you scaled it)
   ```

5. Insert the account network names again: they live in the network's database (`account_network_names`) and went with it
   ([Name an account on one network](#name-an-account-on-one-network)).

The syncer finds an empty database and starts at `GH_SYNC_START_LEDGER` (default: the node's validated head). What goes with the database: its ledgers, the
aggregates, the lease, the export jobs and the account network names. What stays: the **shared** database (`shared`: account names, labels), which belongs to no
network. The explorer's side is its own: it deploys its sandbox with a new build id (the explorer's sandbox environment design, section 11).

## The AMM jobs

The aggregator keeps two AMM tables up to date, `amm_pools` (the current state of every pool) and `amm_daily` (a row per pool and UTC
day), and a third volume metric, `amm_volume`, in the volume sets. How they work is in [syncer](syncer.md#the-amm-jobs); what an
operator needs:

| Job | Budget and cadence | Healthy | Watch |
| --- | --- | --- | --- |
| `amm_pools` | 3 s, every tick, third in the tick (after `volume_daily`) | A new pool is in `GET /v2/amm/pools/{pool}` within about a minute of its first ledger | `syncer_aggregator_errors_total{job="amm_pools"}` and `{job="amm_pools_dirty"}`; log lines `Aggregator job amm_pools ...` |
| `amm_daily` | 4 s, at the first tick and then every 5th tick (about five minutes), twelfth in the tick (after `mpt_state`) | Today's row follows the pool within five minutes; the back-fill says `AMM daily back-fill: N days to compute` and then `is done` | `{job="amm_daily"}` and `{job="amm_daily_dirty"}` |
| `amm_volume` | inside `volume_live` (5 s), `volume_daily` (4 s) and `volume_backfill` (10 s) | `GET /v2/network/amm_volume` has components | the volume jobs' errors, `volume_live` and `volume_daily` |

- **The tick shares its budget.** `volume_live` (fifteen live sets) and `volume_daily` (eight daily sets of today and yesterday) go first,
  then `amm_pools` and `nft_state`, so the pool list is as fresh as the volumes; `amm_daily` goes after `stats_dirty` and only gets what is left.
  Each job has its own budget, so a long `amm_daily` back-fill cannot starve the live jobs. If a job logs `reached its budget`, it goes
  on at the next tick or run (said once until a run finishes in time).
- **What a recompute costs.** A pool's state is the newest non-null value of each column over its state rows (a swap carries no fee, LP
  supply or slot). The aggregators read a window of `AMM_FILL_WINDOW_LEDGERS` (160,000 ledgers, about a week) of each pool first, and walk
  further back in doubling steps only for the pools whose window leaves a column null and that have older rows, each down to its own
  first state ledger at most, so a pool pays for the distance back to its oldest needed value (its own history for a column that is null
  for ever, and nothing below it). A back-fill of many days costs that for each day, so the first sweep of a deployment with years of AMM
  history takes many ticks: watch `AMM daily back-fill: N days to compute` in the log. A day is never cut by the budget: a day whose set
  takes longer than it logs `Aggregator job amm_daily: the set of <day> took <n> ms, more than the budget of amm_daily`, and the tick
  runs that much longer (past the 60 s interval the next tick is skipped).
- **The dirty-slice hooks.** `stats_dirty` (after a `range-ingest`) recomputes, for each slice of an `agg_dirty` range, the stats, the
  daily volume sets of its days, the `amm_pools` rows of the pools with a touch in its ledgers or whose newest row last saw one of them
  (error label `amm_pools_dirty`; a pool with no state row left is removed from `amm_pools`, Ruling R-A28) and the `amm_daily` sets of its
  days (`amm_daily_dirty`). A slice is started whole, so a slice with thousands of pools runs past the
  `amm_pools` budget of 3 s. The budget of `stats_dirty` (10 s) is checked between slices, so a tick can run as long as one slice
  longer; the rest of the range is done at the next tick.
- **A pool that fails is set aside, not stuck.** `amm_pools` halves a failing batch of up to 200 pools to find the pools that fail on
  their own (at most three per batch), counts each as an error, and retries each after 5 minutes, doubling up to an hour. The log names
  the pool: `Aggregator job amm_pools failed for pool r..., set aside to be tried again`. The pool is stale in `amm_pools` until its
  retry works. The set is in memory: a restart recomputes it from the tables and finds the pool again.
- **`failed as a whole, but its halves were rebuilt`.** A warning `Aggregator job amm_pools: a batch of N pool(s) failed as a whole, but
  its halves were rebuilt: <cause>` is counted as one error. Nothing is lost; the batch failed for its size (a timeout, a memory limit
  of ClickHouse). If it keeps appearing, look at the cause and at `system.query_log` for the fill-forward query.
- **`amm_daily`: a day that fails** is counted once and tried again at the next run; a closed day waits 5 minutes, doubling up to an
  hour. A day that fails on the dirty path (after a re-ingest) is owed to the job and does not hold up `agg_dirty`; it is also marked
  owed in the tables (its set again under a newer version that is not final: readers keep its rows, and a restarted aggregator's
  back-fill computes it again, Ruling R-A27). A mark that fails is logged as `Aggregator job amm_daily_dirty failed marking <day> owed
  in the tables` and counted; that day is then owed in memory only.
- **After a re-ingest** (`range-ingest --reprocess` over AMM ledgers, see [backfill](backfill.md#amm-data-re-ingest)) the written
  ledgers mark `agg_dirty`, and the aggregator rebuilds the pools and the days they cover with the stats: `SELECT count() FROM
  xrpl.agg_dirty` shrinks as it works. The pools of the live ledgers are found by the stale-pool cursor.
- **When the computation of `amm_daily` changes** (a fix to the fee estimate, say), bump `AMM_DAILY_CONFIG_VERSION` in
  `packages/shared/src/aggregate/amm-daily.job.ts` and deploy: every closed day is computed again by the back-fill, newest first.
- **A pool that is missing.** `GET /v2/amm/pools/{pool}` answers 404 for a brand-new pool until the first tick of `amm_pools` after
  its ledger is committed (up to about a minute); its history, swaps, liquidity and governance are served as soon as the ledger is.
  A 404 that lasts: no ledger of the pool was ingested (the history starts at the ledger the syncer started at, or at the ledger of a
  `--reprocess`), or `amm_pools` is failing for it (the log names the pool).
- **Is the AMM data complete?** `SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 86795265 GROUP BY parser_version`:
  ledgers written by version 1 have no AMM rows. A pool whose creation was not ingested has no `created_ledger` / `created_by`.

## The NFT data

The aggregator keeps four NFT tables up to date with two jobs, `nft_state` (`nfts`, `account_nfts`) and `nft_collections` (`nft_collections`,
`nft_collection_holders`), and a fourth volume metric, `nft_volume`, in the volume sets. How they work is in [syncer](syncer.md#the-nft-jobs); the
design in [ADR-0016](adr/0016-nft-and-uritoken-data.md); what an operator needs:

| Job | Budget and cadence | Healthy | Watch |
| --- | --- | --- | --- |
| `nft_state` | 3 s, every tick, fourth in the tick (after `amm_pools`) | An account's holdings and its NFTs in a collection's list follow the ledger within about a minute; the detail, history and offers of an NFT are read from its events and are there at once | `syncer_aggregator_errors_total{job="nft_state"}` and `{job="nft_state_dirty"}`; `syncer_nft_state_lag_ledgers`, `syncer_nft_dirty_ledgers`; log lines `Aggregator job nft_state ...` |
| `nft_collections` | 3 s, at the first tick and then every 5th tick (about five minutes), thirteenth in the tick (after `amm_daily`) | A collection's row and holders follow its NFTs within about five minutes | `{job="nft_collections"}`; `syncer_nft_collections_pending`; log lines `Aggregator job nft_collections ...` |
| `nft_volume` | inside `volume_live` (5 s; the sets for `day`, `7day`, `30day`), `volume_daily` (4 s) and `volume_backfill` (10 s) | `GET /v2/network/nft_volume` has components | the volume jobs' errors, `volume_live` and `volume_daily` |

**What the owner does to deploy** (the order matters):
1. **Apply migration `011_nft_data.sql`** (`dc run --rm migrate-xrpl` / `migrate-xahau`) **before this release's syncer**; then deploy the syncer, then the
   api. The writer inserts into the five NFT ledger tables with every ledger ([above](#apply-a-schema-migration)).
2. **Fill the history.** `range-ingest --from 75443457 --to <checkpoint> --reprocess` on XRPL and `--from 1` on Xahau (Xahau's coverage needs
   ledger 1: the amendment `URIToken` is enabled in its genesis), or as part of the program's one reprocess after its last parser version, which is far
   cheaper than one pass per feature ([backfill](backfill.md#nft-re-ingest)). Watch **`syncer_nft_dirty_ledgers` fall to 0**; `volume_backfill`
   fills `nft_volume`'s daily sets. Xahau's `--from 1` stores ledger 1 with the close time 0, so `volume_backfill` then starts at 1970-01-01 and
   walks about 19,000 empty days for each of the four metrics, newest first: the real days are done first, and the empty ones are cheap but many.
3. **Coverage turns `complete`** once no ledger at or above the enable ledger was written by an older parser ([the check](#is-the-nft-data-complete)),
   and once the enable ledger is known: the API reads it from the amendments data, which needs the validators worker of the syncer to have polled
   `network_state` (until then every answer says `complete: false`; `GET /v2/network/amendments` shows the amendment with its `enabled` ledger).
   The testnets stay `complete: false`: they get no backfill.
4. **Hand the explorer this commit** for its API sync (`pnpm api:sync`). The explorer turns its `NFTS` switch on per environment once that
   environment's API serves these routes on both networks and the lag gauges are near 0.

- **A first fill is slow, by design.** After the re-ingest the queue of `nft_collections` holds every collection, and it is worked first in, first
  out, **one 3 s run every five minutes**: plan on about **150 collections every five minutes** for XRPL's large collections (a batch of 50 takes about
  a second), while small ones go thousands to a run (the Xahau live check cleared 2,089 in one). A collection that changes meanwhile waits behind the fill. So after a rollout the collection
  pages update slowly until `syncer_nft_collections_pending` is 0 (days on XRPL), and `GET /v2/nft_collections` lists only the collections counted
  so far (its `total` grows); an NFT's own routes, an account's holdings and a collection's sales do not wait for it.
- **The cursor of `nft_state` is placed at every start, and the read can be slow.** It is found from the tables (`nftStateWatermark`: the ledger
  before the oldest NFT touch the aggregate has not seen, else the newest ledger), a join of every touch with its NFT, which on a mainnet-sized `nfts`
  may take as long as the time limit of a query (`GH_CLICKHOUSE_MAX_EXECUTION_TIME`, 30 s). The job does not wait for it: the live part starts at the
  first tick after the read answered, and until then **`syncer_nft_state_lag_ledgers` is not set** (it keeps its value: 0 in a new process), so it
  never reads the whole head. A read that fails is counted (`{job="nft_state"}`) and tried again after 5 minutes, doubling to an hour: a failed read
  at boot delays the live part by at least five minutes, and **a read that never fits the time limit keeps the live part from ever starting** while
  the retries and the dirty ranges go on. The lag gauge does not show that (it is not set): watch the errors of `nft_state`, raise
  `GH_CLICKHOUSE_MAX_EXECUTION_TIME` for the syncer, or rebuild the NFTs with a re-ingest. A stop of the syncer does not cancel a read in flight.
- **A restart while the history is being filled leaves the stretch to the dirty ranges.** During the fill (step 2) the NFTs that the re-ingest
  wrote and the dirty sweep has not rebuilt yet are behind the head, so the cursor read at a restart is far back. When it is more than 10,000 ledgers
  (`NFT_LIVE_STEP_LEDGERS`) behind the newest ledger, the ledgers after it, up to the newest, are marked in `nft_dirty` (first) and the live cursor
  starts at the newest ledger (the log says `nft_state: the stale NFTs of ledgers A - B are left to the dirty ranges; the live cursor starts at B`):
  the holdings of new ledgers keep following the chain, and the dirty sweep, which digests the fill anyway, rebuilds the stretch. So
  `syncer_nft_dirty_ledgers` jumps by the stretch, and **each restart during the fill adds the stretch once more** (the NFTs of its ledgers are
  rebuilt again): do not restart the syncer during the fill without need. The same holds after the aggregator was off while the ingest wrote
  more than 10,000 ledgers (a syncer run with `GH_WORKERS` without `aggregator` for half a day or more).
- **A database with no ledger** at the first read of the cursor (a first start) places the cursor at the ledger before the first ledger stored, once
  one is: the job never crosses the empty history before it.
- **An NFT or a collection that fails is set aside, not stuck.** `nft_state` halves a failing batch of up to 500 NFTs to find the NFTs that fail on their
  own (at most three per batch), counts each as an error, and retries each after 5 minutes, doubling up to an hour; `nft_collections` does the same with
  batches of 50 collections. The log names it: `Aggregator job nft_state failed for NFT <id>, set aside to be tried again`, `... nft_collections failed for
  collection <issuer>/<taxon>, ...`. The warning `a batch of N NFT(s) failed as a whole, but its halves were rebuilt: <cause>` is one error and loses
  nothing (the batch failed for its size). The sets are in memory: a restart finds the NFT or collection again from the tables. An NFT of a dirty range
  that fails on its own (`... failed for NFT <id>, its ledgers of the dirty range are marked again`) has its ledgers of the step marked in `nft_dirty`
  again (from its first to its last touch there), and those ledgers wait 5 minutes, doubling up to an hour, before they are taken again (`nft_state:
  ledgers A - B are marked dirty again, taken again in N min`), while the ranges marked after them are worked on; a restart forgets the waits, not the
  marks.
- **After a re-ingest** (`range-ingest --reprocess` over NFT ledgers, see [backfill](backfill.md#nft-re-ingest)) the written ledgers mark `agg_dirty`, and each
  slice's hook (error label `nft_state_dirty`; it fails the slice if it fails) appends the ledgers to `nft_dirty`; `nft_state` works through the oldest range in
  steps of 10,000 ledgers, rebuilding the NFTs with a touch in the step and removing an NFT that has no event left, and the range shrinks until it is
  gone (`SELECT * FROM xrpl.nft_dirty` shows them). Until then the aggregates (holdings, collection lists) show the old data; an NFT's detail, history
  and offers show the new data at once.
- **`syncer_nft_skipped_total`** counts the NFT events the parser dropped because their amount is an MPT amount (none is possible in the ledger today).
  A rise means the NFT history is missing those events: the range-ingest log warns with the total of its run, and its last line always says `J skipped NFT events` (and ends with `L unclassified object changes`).
- **A collection that is missing.** `GET /v2/nft_collections/{issuer}/{taxon}` and its sub-routes answer 404 for a collection the job has not counted yet
  (up to about five minutes after its first NFT, or a long wait in the first fill above). A 404 that lasts: no event of the NFTs was ingested, or
  `nft_collections` is failing for it (the log names the collection).
- **Disk.** An event is stored in up to four tables (by NFT, by collection, once for each account it involves, and a sale again in ledger order): a
  brokered sale is up to seven rows (`nft_events` 1, `collection_nft_events` 1, `account_nft_events` 4: the issuer, the seller, the buyer and the broker,
  `nft_sales` 1). The four aggregates grow with each rebuild until merges drop the older versions
  ([data-model](data-model.md#nft-aggregates-migration-011)).

### Is the NFT data complete?

```sql
-- the NFT data cover the ledgers above this one (NULL: every stored ledger); the answers say `complete` when it is below the enable ledger
SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 5;
-- every ledger from the enable ledger on is written by parser version 5 or later (Xahau: xahau.ledgers, from ledger 1)
SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 75443457 GROUP BY parser_version;
-- the NFTs and collections the aggregator has built so far, and the ranges it still has to rebuild
SELECT (SELECT uniqExact(nft_id) FROM xrpl.nfts) AS nfts, (SELECT uniqExact(issuer, taxon_key) FROM xrpl.nft_collections) AS collections;
SELECT from_ledger, to_ledger FROM xrpl.nft_dirty ORDER BY from_ledger;
```

The coverage the API states is `GET /v2/nfts/{id}` or any list's `coverage` ([api-reference](api-reference.md#coverage)): `from_ledger_index` is that first query's
answer plus one. On a testnet (`xrpl_testnet.`, `xahau_testnet.`) it is `complete: false` for ever: there is no backfill.

## The display names

The explorer shows an address by name wherever it shows one, and gets a page's names in one call: `GET /v2/account_names` (the operator's names and
labels of [above](#name-an-address), and a **verified name** where an account's domain lists it in its toml) and `GET /v2/toml/{domain}`
([api-reference](api-reference.md#account-names-and-tomls), [ADR-0017](adr/0017-display-names.md)). The pieces, all per network:

| Piece | Cadence | Healthy | Watch |
| --- | --- | --- | --- |
| `account_domains`, written by the ingest (parser version 6 or later) | with every ledger | a row for each change of an account that has a Domain | the [seed](backfill.md#account-domains-seed) fills it for the ledgers before the deploy |
| The `tomls` worker of the syncer ([syncer](syncer.md#8a-the-tomls-worker)) | discovery every 5 minutes; a pass 60 s after the previous one, at most 300 domains, 16 at a time | a toml `ok` every 24 hours; `syncer_tomls_due` near 0 | `syncer_tomls_due`, `syncer_tomls_domains{status}`, `syncer_tomls_checks_total{outcome}`, `syncer_tomls_discovery_seconds`; the `Tomls: ...` log lines |
| The api's names and labels | loaded at start and every `GH_NAMES_AND_LABELS_RELOAD_MS` (60 s) | a row the operator inserts shows within a minute | `Could not load the ...` (a `warn`) |
| What the toml of an account's domain says of it | read by key at each call, for the distinct domains of the batch, kept 60 s per address | a toml read by the worker shows within a minute | `Could not read the tomls of the account domains, no domain is a name in this answer` (a `warn`: that answer has no `verified` and no `domain` kind) |
| The account domain of an address | read at each call, kept 60 s per address | | a 500 `unable to retrieve account names` is a failed read of `account_domains` |

**What the owner does to deploy** (per network, the sandbox first, then production; the order matters):
1. **Apply migration `012_display_names.sql`** (`dc run --rm migrate-xrpl` / `migrate-xahau`) **before this release's syncer starts**: the ingest writes
   `account_domains` with every ledger, and a write to a missing table fails the batch ([above](#apply-a-schema-migration)). The `tomls` worker refuses to boot
   without it.
2. **Deploy the syncer** (parser version 6 or later; the `tomls` worker is in the default `GH_WORKERS`, and **where `GH_WORKERS` is set explicitly add `tomls`**) **and the api.**
   The syncer needs **outbound HTTPS to every domain accounts name** ([deployment](deployment.md#outbound-network-access)): open the egress, or set
   `GH_DOMAIN_VERIFICATION=false` (no toml is read; on a store that is still empty no name is verified and every domain shows as an unverified one).
3. **Run the seed once per network** ([backfill](backfill.md#account-domains-seed), 16 buckets): it gives every account its current Domain from the state
   history, which no reprocess does faster.
4. **Wait for the first sweep**: `syncer_tomls_due` falls to near 0 (about 300 domains a minute, slower when many hosts time out; the number of domains is
   `syncer_tomls_domains`). Until a domain is checked its accounts show it as an unverified domain.
5. **Raise the explorer key's limit** in `GH_RATE_LIMIT_KEYS` if its 429s rise: the explorer makes one names call for most page renders (two on an account
   page), and a key's limit is counted per key and route (`/v2/account_names` has a bucket of its own, [security](security.md#5-rate-limiting)).
6. **Hand the explorer this commit** for its API sync. The explorer turns its `NAMES` switch on per environment once that environment's API serves both routes
   and the sweep is done.

**No reprocess.** The ledgers written before the deploy get their domains from the seed. **Coverage:** an account whose Domain was set before the state
history starts and whose root has not changed since has no domain, so no verified name, until it changes (a payment received is enough) or the history is filled
and ingested again ([backfill](backfill.md#account-domains-seed)). To roll back, remove the routes or take `tomls` out of `GH_WORKERS`; `012` needs no undo.
**After a rollback to the previous syncer, run the seed again when this one is deployed again**: the previous syncer (parser version 5) writes no
`account_domains`, so the ledgers it wrote meanwhile have no rows, and `X` (the last ledger of an older parser) has moved to the last of them.

- **A first sweep is slow, by design.** A mainnet names tens of thousands of domains; 300 a pass is about 300 a minute while the hosts answer. A host that is
  down or slow keeps a lane for up to 10 s, 16 lanes at a time, and the next pass starts 60 s after one ends, so a sweep over many dead hosts is about 72 a
  minute. The backlog alert fires during it on a mainnet ([observability](observability.md#recommended-alerts)): silence it until `syncer_tomls_due` is near 0 once.
- **A domain is read once a day** (`GH_TOML_RECHECK_MS`), a failed one on its own schedule, and **at once** (at most hourly) when more accounts name it than at
  the last discovery: an account that sets its Domain is verified within minutes. A transient failure (a name that does not resolve, a timeout, a 5xx) keeps
  the content and is retried hourly **up to 24 hours after the re-read it missed** (48 hours after the read at the default recheck): a host that blips at its
  daily re-read keeps its names. Once nothing is carried, it backs off 1, 2, 4, then 7 days, as a definite failure (a 404, a file that is not TOML) does from
  the start: a dead host is asked once a week, and one that comes back after a long outage is read again up to 7 days later.
- **A name does not appear.** Check, in order: the account's domain (`GET /v2/account_names` has a `domain` key); the toml (`GET /v2/toml/{domain}`: 404 means it was
  never checked, `status: "failed"` says why); that the toml lists the address under `[[ACCOUNTS]]` with no `network` or one of this network's names; that the `desc`
  is at most 64 characters and holds no `@` (else the domain is the name). A toml with an integer above 2^53 anywhere in it fails whole (`toml_invalid`).
- **Everything shows as an unverified domain.** The store is empty and the worker is off (`GH_DOMAIN_VERIFICATION=false`, or `tomls` out of `GH_WORKERS`), or it
  has no egress (`syncer_tomls_checks_total` full of `dns_error`, `connect_error` and `timeout`: the names go 24 hours after each missed re-read). When the api
  cannot read `domain_tomls` at all (the `warn` above), no domain is a name, verified or not, and the names and labels are served all the same.
- **The worker is off, and names are still verified.** Turning the worker off after it has run does not withdraw anything: the stored rows stay, and the api
  verifies names from them **without limit**, as they were at the last read, a domain that has dropped an account since included. To withdraw the verified
  names, `TRUNCATE TABLE xrpl.domain_tomls` (per network; the worker fills it again when it is switched back on).
- **A host to block.** The worker fetches any host an account names: nothing is configurable per host. `GH_DOMAIN_VERIFICATION=false` is the switch, and egress filtering at the
  network is the second line ([security](security.md#outbound-https-to-arbitrary-public-hosts-syncer)).

```sql
-- the state of the store: the newest check of each domain, counted by outcome
SELECT s AS status, r AS reason, count() AS domains
FROM (SELECT domain, argMax(status, checked_at) AS s, argMax(reason, checked_at) AS r FROM xrpl.domain_tomls GROUP BY domain)
GROUP BY s, r ORDER BY domains DESC;
-- one domain: its checks, newest first
SELECT checked_at, status, reason, status_code, failures, next_check_at FROM xrpl.domain_tomls WHERE domain = '<domain>' ORDER BY checked_at DESC LIMIT 20;
-- the accounts that name a domain now (what the worker discovers is these, grouped by domain)
SELECT count() FROM (SELECT account, argMax(domain_hex, version) AS h, argMax(deleted, version) AS gone FROM xrpl.account_domains GROUP BY account) WHERE h != '' AND gone = 0;
```

`domain_tomls` has one row per check, and merges keep the newest row of a domain. **It keeps the row of every domain ever checked**, also of a domain no account
names any more: the worker does not check it again, and `GET /v2/toml/{domain}` answers its last row. So it grows with the churn of Domains (anyone can set one),
by at most about 300 checks a minute, and nothing removes those rows yet. D8 did not take that on: it adds the domains only a validator names, and any later blanking of undiscovered domains must keep those. The api reads it by key only,
per request: its size costs disk and the worker's schedule read, not the api's memory. `account_domains` is ordered by
account, so merges keep about one row per account and partition ([data-model](data-model.md#account_domains-p7-order-by-account-migration-012)).

## Ledger objects and delegation

The explorer shows an escrow, a check, a payment channel and a delegation with the history of the transactions that changed it. The history is a ledger table
the ingest writes, read at query time; one aggregate, `escrows`, keeps the escrowed total for D7's supply ([syncer](syncer.md#the-escrows-job),
[ADR-0018](adr/0018-ledger-object-history.md), [api-reference](api-reference.md#ledger-objects)). The pieces, all per network:

| Piece | Cadence | Healthy | Watch |
| --- | --- | --- | --- |
| `object_changes` and `account_object_changes`, written by the ingest (parser version 7) | with every ledger | a row for each change of an escrow, check, payment channel and delegation, and the owner's and the counterparty's index rows | `syncer_objects_unclassified_total`; the range-ingest log (`L unclassified object changes`) |
| The `escrows` job of the aggregator ([syncer](syncer.md#the-escrows-job)) | every tick, fifth in the tick (after `nft_state`), budget 2 s; the first fill in steps of 1,000,000 ledgers; a hook on the `agg_dirty` slices | `syncer_escrows_lag_ledgers` 0 to a few ledgers, `syncer_escrows_open` the open native escrows | `syncer_aggregator_errors_total{job="escrows"}` and `{job="escrows_dirty"}`; `syncer_escrows_lag_ledgers`, `syncer_escrows_open`; log lines `Aggregator job escrows ...` |
| The routes of the api | read at each call, each read bounded by the object and the newest committed ledger; the coverage of a feature kept 60 s | an object answers as of the newest ledger, with no lag | a 500 `unable to retrieve escrow` (check, payment channel, delegations, ledger object) is a failed read, which the api logs with its cause |

**What the owner does to deploy** (per network, the sandbox first, then production; the order matters):
1. **Apply migration `013`** on each network database (`dc run --rm migrate-xrpl` / `migrate-xahau`; from source `pnpm ch:migrate`) **before the syncer and the API of this release**:
   the writer inserts into the two new tables on every ledger, and a write to a missing table fails the batch ([above](#apply-a-schema-migration)).
2. **Deploy the syncer, then the API.** From the deploy ledger every ledger has object rows, the delegate's account rows and the fixed fee rows; the `escrows` job builds its
   table in steps of 1,000,000 ledgers until `syncer_escrows_lag_ledgers` is a few ledgers. **A Xahau syncer that is halted on a ledger with an issued-token payment channel
   resumes after the deploy**: the old parser threw on its amounts (`Cannot parse ledger <n>`, [Syncer halted](#syncer-halted)), the new one types them.
3. **On the XRP Ledger, re-ingest the delegation amendment's ledgers:** `range-ingest --from 107524865 --to <deploy ledger> --reprocess` (about 415,000 ledgers on
   2026-10-28, about 20,800 more a day; hours on Ripple's full-history node, [backfill](backfill.md#ledger-objects-and-delegation-re-ingest)). `agg_dirty` carries the rewrite into
   the rollups and the escrows. Delegation coverage is then `complete: true`.
4. **Escrows, checks and channels stay `complete: false`** until the history backfill (ADR-0015's load from ledger 32,570, or one reprocess after the program's last parser
   version) writes every ledger from 28,685,313 on the XRP Ledger (checks: 56,219,905) and from Xahau's first ledger with parser version 7 or later. D5 does not do it. An
   object created before the first ledger of version 7 and untouched since is a 404 until then, and the explorer reads it from the node.
5. **Hand the explorer this commit** for its API sync (`pnpm api:sync`). The explorer's `LEDGER_OBJECTS` switch goes on in an environment once this API serves the routes there on
   both networks; `DELEGATION` once step 3 is done there (in the sandbox once the routes answer: its coverage is never complete).

**No new setting.** The job and its budget are in the aggregator (`GH_WORKERS` with `aggregator`, as for the NFT jobs); the api needs nothing of its own. To roll back, remove the
routes or the `escrows` option: `013` needs no undo, and a syncer of the previous release writes no object rows (the ledgers it writes meanwhile have none, and their
objects are 404 or start in the middle until they are re-ingested).

- **The first fill of `escrows` holds ticks, by design.** With no sentinel the job starts at the ledger before the first committed one and walks to the head in steps of
  1,000,000 ledgers, each a handful of narrow reads and the writes of the escrows it touched; on a full parser-7 history of the XRP Ledger (from ledger 32,570, so from
  32,569) that is about 108 steps: the first 28 or so, below the Escrow amendment (28,685,313), hold no escrow and are cheap, and about 80 can hold escrows. The
  budget is checked before a step and **never inside one** (a step cannot resume partway: its sentinel is its last write), so a heavy step runs past the 2 s, the rest of the
  tick waits for it (see the 27 of 30 s below), and the job goes on at the next tick where it stopped: expect `syncer_escrows_lag_ledgers` to fall in jumps of up to a million, and the
  later jobs of those ticks (`stats_live` among them) to be short of time until it is at the head. The watermark is in the table (`through_ledger` of the sentinel), so a restart
  goes on where it was.
- **The budget of a tick.** The jobs before `stats_live` have 27 of the 30 s of a tick when each uses its whole budget (`volume_live` 5, `volume_daily` 4, `amm_pools` 3, `nft_state` 3, `escrows` 2,
  `pair_hourly` 3, `markets_live` 3, `tokens` 4), so `stats_live` gets the 3 s that are left in the worst tick, and `stats_dirty` nothing if `stats_live` takes them; in the steady state the escrows step is a few narrow reads.
- **A failing `escrows` hook re-runs its slice's hooks.** The hooks of `tokens` and `mpt_state` come after this one. When it fails, the slice fails and stays in `agg_dirty`, those two are skipped for the tick, and at the next tick the
  earlier hooks of the slice run again (they are idempotent; the hook of `nft_state` marks its `nft_dirty` range once more, and at most three failing ranges are tried in a tick),
  with no backoff. `syncer_aggregator_errors_total{job="escrows_dirty"}` rises each tick and `SELECT count() FROM xrpl.agg_dirty` does not fall: look for
  `Aggregator job escrows_dirty failed in <from> - <to>: ...` in the log, fix the cause, and the next tick drains the queue.
- **Pair the lag alert with the errors rate.** `syncer_escrows_lag_ledgers` is set from the step; after a step that failed it is set from the head and the sentinel, read outside
  the job's budget (a head read that is slow can wait up to the request timeout once), so a watermark that is stuck shows as a lag that grows with the head. A database that is down
  for the step and for those reads freezes the gauge: `rate(syncer_aggregator_errors_total{job="escrows"}[15m]) > 0` says it. The alert is
  `syncer_escrows_lag_ledgers > 1000` for 15 minutes ([observability](observability.md#recommended-alerts)).
- **An escrow that cannot be mapped is set aside, not stuck.** A step maps each touched escrow to its row; one whose rows cannot be read (a text that is not JSON, an amount of no shape
  the ledger has, drops that are not a whole number, an MPT ID that is not one: unreachable from ledger data) is left as it was, counted as an error of `escrows` by its ID with the
  reason (`Aggregator job escrows failed for escrow <ID>, set aside: the Amount is of a shape the ledger does not have`, for one) and the step commits without it: the sentinel's total
  and its watermark stay in agreement. It is a parser or data bug to report; the next rebuild of that escrow tries it again.
- **An escrow with no row left is deleted.** After a re-ingest that removes an escrow's rows the job removes its row with a lightweight `DELETE` that it waits for
  (`lightweight_deletes_sync = 2`). A lightweight `DELETE` is a mutation, and `SYSTEM STOP MERGES` on `escrows` stops it too: do not leave merges stopped on the table.
- **`syncer_objects_unclassified_total`** counts the changes of a tracked object that no event of its type covers (event `update`), over the ledgers written by the live ingest and
  by the range-ingest runs of the process. None is expected; a rise is a transaction type or a field combination the parser has no event for. The range-ingest log warns with the
  total of its run, and its last line ends with `L unclassified object changes`.
- **After a re-ingest** (`range-ingest --reprocess` over ledgers with objects, [backfill](backfill.md#ledger-objects-and-delegation-re-ingest)) the written ledgers mark `agg_dirty`, and
  each slice's hook recomputes the escrows of the slice's ledgers as of the job's watermark (a slice above the watermark is the live steps' to read) and reads the total again if one
  was written or removed. Until then `escrows` shows the old rows; an object's own routes read `object_changes` and show the new rows at once.
- **A delegated transaction's fee moved.** After the reprocess of its ledger the fee row is the delegate's and the delegate lists the transaction; the balances, stats and reports
  of the accounts concerned are recomputed through `agg_dirty` like any re-ingest ([above](#what-a-re-ingest-does-to-them)).
- **Disk.** One row for every change of every tracked object on every network, with its fields and previous fields compressed (`ZSTD(3)`), and a narrow index row for each of its two
  accounts. A payment channel claimed every day for years is thousands of rows; an escrow, a check or a delegation a few. The retention loop drops both tables with the others
  ([Retention](#retention)); `escrows` is an aggregate and is not dropped: it keeps its rows, and nothing rebuilds it after a drop. A manual rebuild (the aggregator
  stopped, `TRUNCATE TABLE xrpl.escrows`, then started: with no sentinel the job starts again below the first committed ledger) is exact only for the escrows created
  above the oldest kept ledger: an escrow created in a dropped block and still open has no row left to rebuild it from, and drops out of the table and its total.

```sql
-- the object data cover the ledgers above this one (NULL: every stored ledger); delegations are `complete` once it is below 107,524,865
SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 7;
-- the sentinel of the escrows job: the open native escrows, their drops and the ledger it is as of; the lag is the head less through_ledger
SELECT open_count, amount_drops, through_ledger FROM xrpl.escrows WHERE escrow_id = '' ORDER BY version DESC LIMIT 1;
SELECT max(ledger_index) AS head FROM xrpl.ledgers;
-- the objects the index has seen, by type and by the event that last changed them
SELECT object_type, count() AS rows, uniqExact(object_id) AS objects FROM xrpl.object_changes GROUP BY object_type;
-- changes no event expects (the counter's rows): what the parser could not name
SELECT object_type, tx_type, count() FROM xrpl.object_changes WHERE event = 'update' GROUP BY object_type, tx_type ORDER BY count() DESC LIMIT 20;
```

## Issued tokens

The explorer's Tokens and Token pages (the issued tokens of the network ranked by holders, one token with the settings of its issuer, its toml entry and its markets, its holders and its
transfers) are served by `/v2/tokens` ([api-reference](api-reference.md#tokens), [ADR-0019](adr/0019-issued-tokens-from-state-history.md)). The transfers are read from the ledgers at query
time; the rest is an aggregate that the `tokens` job of the aggregator builds from the state history and keeps current ([syncer](syncer.md#the-tokens-job)). The pieces, all per network:

| Piece | Cadence | Healthy | Watch |
| --- | --- | --- | --- |
| `state_touches`, written by the ingest (parser version 8) | with every ledger | a row for each changed trust line and each issuer-settings change, in ledger order (about 25 to 40 a ledger: [measured](#measured-on-synthetic-data)) | the live runner's log; `SELECT count() FROM xrpl.state_touches WHERE ledger_index >= <a recent ledger>` |
| The `tokens` job of the aggregator ([syncer](syncer.md#the-tokens-job)) | every tick, eighth in the tick (after `markets_live`), budget 4 s; the housekeeping every tenth run | `syncer_tokens_live` 1, `syncer_tokens_lag_ledgers` 0 to a few ledgers, `syncer_tokens_building` 0 and `syncer_tokens_repair_ledgers` 0 outside a build and a re-ingest | `syncer_aggregator_errors_total{job="tokens"}` and `{job="tokens_dirty"}`; the four gauges; log lines `tokens: ...` |
| The routes of the api | the live generation read every 5 s, the markets sets every 30 s, the coverage every 60 s | an answer is as of the ledger it names, a few ledgers behind the head | a 500 `unable to retrieve tokens` (`token`, `holders`, `transfers`) is a failed read, which the api logs with its cause |

**What the owner does to deploy** (per network, the sandbox first, then production; the order matters):
1. **Apply migration `014`** on each network database (`dc run --rm migrate-xrpl` / `migrate-xahau`; from source `pnpm ch:migrate`) **before the syncer and the API of this release**: the writer
   inserts into `state_touches` on every ledger, and a write to a missing table fails the batch ([above](#apply-a-schema-migration)). **The job needs the other three tables as well**, and **the syncer refuses to boot without 014**: with
   the `ingest` worker it checks for `state_touches`, with the `aggregator` worker for all four tables, and the message names `014_issued_tokens.sql` and what is missing
   ([syncer](syncer.md#10-failure-modes)). A job that cannot read its generations would make its hook throw on every `agg_dirty` slice and **stop the queue for every job**: that is left to ClickHouse
   failing the job's opening reads, also at the first run after a boot that could not make the check (a persistent `tokens_dirty`, [below](#a-persistent-tokens_dirty)).
2. **Deploy the syncer** (parser version 8). From the deploy ledger every ledger has its touches, and the `tokens` job **builds the first generation from `trust_line_states`**, as it is: no re-ingest is
   needed for it. The build is a pass over all of `trust_line_states`, in batches of 500 accounts (about 60 of them fit in the 4 s of a tick on the synthetic data), one tick a minute: **between an hour and a
   few hours** on a full XRP Ledger history ([the estimate below](#estimated-for-the-xrp-ledger)). Watch `syncer_tokens_building` (1 until the generation is promoted) and the logged cursor
   (`tokens: generation 1: the account pass is at <account> ...`). Until it is live `/v2/tokens` answers the no-generation answer and a token 404.
   **Finish every history fill before the first build starts.** The promotion does not check the state coverage start; the housekeeping does: at each one (every tenth run, about every ten
   minutes) the job compares the start with the one the generation was built on and **retires a building generation whose start has moved and starts another from the first account** (`tokens: generation N was stale while it built; it is retired`).
   A build that finishes between two housekeepings is promoted all the same, then found stale at the next one and replaced (the live generation, once there is one, keeps serving meanwhile). The start is
   the oldest stored ledger when no ledger of a parser older than 3 is stored, else one above the newest ledger written by such a parser ([Coverage](api-reference.md#coverage)), so it moves while a fill keeps writing ledgers
   below the oldest stored one (a single ascending `--from/--to` run moves it once, at its first chunk; a fill from the top down moves it with every chunk) and while a range-ingest or `--reprocess` rewrites the newest
   ledgers of an older parser; a multi-hour first build under such a fill restarts every ten minutes and does not end. Only the building generation restarts (the live one, once there is one, keeps serving), so this starves a **first** build and delays a rebuild; the program's reprocess
   moves the start only while stored ledgers of a parser older than 3 remain, and not at all over a database whose ledgers are all version 3 or later.
   **Listings need D4's account domains**: a token is `listed` only when the issuer's account domain is known (`account_domains`) and its toml was read by the `tomls` worker. Seed first to avoid a wait, not
   because it is lost otherwise: run the [account-domains seed](backfill.md#account-domains-seed) (it needs no reprocess) and let the `tomls` worker's first sweep run before the build. A first generation
   built without them has no `domain` and no listing, and **corrects itself at the first toml sweep after it is promoted**, within tens of minutes of the domains and the tomls being in the store, with no
   change of the issuers needed ([the display names](#the-display-names)).
3. **Deploy the API.** The explorer reads `/v2/tokens` from it.
4. **No reprocess is needed for the aggregate** (the touches only matter after the first generation's head). The coverage follows the state tables ([Coverage](api-reference.md#coverage)): `complete` needs
   the state tables whole from ledger 32,570 (ADR-0015's history load), and filling them further back builds a new generation by itself. **The program's one reprocess** (after its last parser version)
   writes every ledger by parser version 8 and **rebuilds the generation through the repair path**: each `agg_dirty` slice lowers the `repair_from` of the generations, the repair applies the windows of
   `[repair_from, through_ledger]` again, and **a window that meets a ledger written by an older parser ends the repair and marks a rebuild** (a new generation is built from the state tables beside the
   live one and swapped in). The tokens reprocess is the **whole history**, about **108 million ledgers, 216,000 windows of 500**, not the 415,000 ledgers of the delegation re-ingest. While it runs
   from the oldest ledger up, the frontier of the reprocess is always followed by ledgers of an older parser, so expect the job to rebuild more than once (each time a repair reaches the frontier):
   every build is an hour to a few hours, only one runs at a time, the live generation serves meanwhile, and the generation built after the last slice is the right one. The repair itself takes at most half of a run's
   budget and a window is never cut: between one window a minute (a window of ten thousand lines takes seconds, [measured](#measured-on-synthetic-data)) and a hundred or more (an empty one), so the repair
   of a reprocessed range of years is days, not hours. Watch `syncer_tokens_repair_ledgers`, `syncer_tokens_building` and `SELECT count() FROM xrpl.agg_dirty`.
5. **The syncer's ClickHouse user keeps `ALTER DELETE` on `token_lines` and `tokens`** (the privilege that `ALTER TABLE ... DROP PARTITION` asks for) if access is ever narrowed: the job drops a retired
   generation's partitions 15 minutes after it was replaced. Today the full-access `data_api` user has it ([clickhouse](clickhouse.md), [security](security.md)). Without it the drop fails (a streak, then a wait), the retired partitions stay and disk grows
   by one generation at each rebuild; nothing else is affected.
6. **Hand the explorer this commit** for its API sync (`pnpm api:sync`): `docs/openapi.yaml` has the four paths and the Tokens section of the reference is what its fixture generator follows.
7. **The explorer's `TOKENS` switch** goes on in an environment once `syncer_tokens_live` is 1 and `syncer_tokens_lag_ledgers` is under 300 there, on both networks.
8. **Record the real first-build duration, the daily `state_touches` rows and the slowest windows of the first day** in the table below (the rest of this section is measured on synthetic data and estimated).

**No new setting.** The job and its budget are in the aggregator (`GH_WORKERS` with `aggregator`, as for the NFT jobs, on by default); the api needs nothing of its own. To roll back, remove the routes: `014`
needs no undo, and a syncer of the previous release writes no touches (the ledgers it writes meanwhile have none, and the job builds a new generation when it meets them).

| Rollout record (to fill in) | XRP Ledger | Xahau |
| --- | --- | --- |
| First build: started, promoted, ticks, the account pass's last cursor | | |
| Lines in `trust_line_states` (`SELECT uniqExact(account, counterparty, currency) FROM xrpl.trust_line_states`: two for each `RippleState`), its rows, and the `tokens` rows of the live generation | | |
| `state_touches` rows a day (`SELECT count() FROM xrpl.state_touches WHERE ledger_index >= <a day ago>`) | | |
| The slowest live window, and the slowest catch-up or repair window, of the first day (the `ms` at the end of the job's debug lines `tokens: generation N (live): ledgers A - B, ...` and `(repair)`) | | |

### A forced rebuild

A change of the token rules (the listing, the supply, anything every token must be computed again for) bumps `TOKENS_CONFIG_VERSION` in `packages/shared/src/aggregate/tokens.job.ts` and ships with a release.
The next housekeeping of the job (within ten runs of the start) finds the live generation's `config_version` stale and starts a new generation beside it: the live one keeps serving and being
updated, the new one is built by the pass and the touches after its head, promoted when it has caught up, and the old partitions are dropped 15 minutes later. There is no outage and no step to run,
and the first build's duration (below) is the duration of the rebuild; `syncer_tokens_building` is 1 meanwhile. Two other things force one by themselves: a change of the state coverage start (a history
fill, or a range written again by an older parser) and a window of touches that meets a ledger of an older parser.

### Measured on synthetic data

Measured on 2026-10-30 with the real functions of the job (`nextPassAccounts`, `writePassLines`, `passTokens`, `recomputeTokens`, `applyLineStates`, `distinctHolders`) against a ClickHouse 26.8.14.3 of its own in
Docker (16 CPUs, 16 GB for the VM, a laptop shared with other work, the tables warm in the cache), through the clients' production defaults (30 s of execution time, no memory cap). **Synthetic means
that the shape is made up**: `trust_line_states` has 1,000,000 lines in 50,000 accounts, 5 state rows for each (5,000,000 rows, 409 MB, merged to one part for each of 3 partitions), one issuer has 200,000 of the lines
(the others about 16) and half of the others' lines are on the issuer's side (their holder has a balance), so the pass writes 596,000 `token_lines` rows and 50,002 `tokens` rows; a second table of 8
copies of it (8,000,000 lines, 400,000 accounts, 40,000,000 rows, 3.3 GB, 4,923 granules) carries the figures marked "8x". Real tables are not this shape: the figures show how the job scales, not what
mainnet costs. The script that ran it is not in the repository (it was a throwaway); what it did is below, so that it can be done again.

```sql
-- trust_line_states: five inserts, s = 1..5, each of the 1,000,000 lines n; the first 200,000 are the lines of one issuer (account number 25000), the others are spread over the other 49,999 accounts
INSERT INTO trust_line_states
SELECT concat('r', leftPad(toString(a), 33, '0')) AS account,                                    -- 'r' and 33 digits, so the accounts sort like their numbers
       concat('r', leftPad(toString(n % 400000), 33, 'p')) AS counterparty,                      -- 400,000 holders, shared by the issuers
       if(n < 200000, concat('B', toString(n % 3), 'X'), concat('T', leftPad(toString((a + n % 2) % 50), 2, '0'))) AS currency,
       toUInt32(70000000 + (s - 1) * 7000000 + n % 1000) AS ledger_index, toUInt32(n % 300) AS tx_index, toUInt16(0) AS node_index,
       concat(lower(hex(sipHash128(n, s))), lower(hex(sipHash128(n, s + 100)))) AS tx_hash,
       toDateTime(1500000000 + ledger_index * 4 - 280000000) AS close_time,
       multiIf(s < 5, if(n % 2 = 0 OR n < 200000, concat('-', toString(1 + sipHash64(n, s) % 100000000 / 100)), toString(1 + sipHash64(n, s) % 100000000 / 100)),
               n % 20 = 0, '0',                                                                   -- the newest state: 5% zero lines (a limit above 0 keeps them counting)
               n % 2 = 0 OR n < 200000, concat('-', toString(1 + sipHash64(n, s) % 100000000 / 100)),
               toString(1 + sipHash64(n, s) % 100000000 / 100)) AS balance,                       -- below 0: the account is the issuer of the line
       '0' AS `limit`, '1000000000' AS limit_peer,
       toUInt8(0), toUInt8(0), toUInt8(0), toUInt8(0), toUInt8(0), toUInt8(0), toUInt32(0), toUInt32(0), toUInt32(0),   -- flags and qualities
       toUInt8(s = 5 AND n % 50 = 1) AS deleted                                                   -- 2% of the lines end deleted
FROM (SELECT number AS n, if(n < 200000, 25000, 1 + (n - 200000) % 49999 + ((n - 200000) % 49999 >= 24999)) AS a FROM numbers(1000000));
-- account_states: three rows for each of the 50,000 accounts (a tenth with the DefaultRipple flag and a TransferRate), then
OPTIMIZE TABLE trust_line_states FINAL; OPTIMIZE TABLE account_states FINAL;
```

The 8x table is the same insert seven more times with the account numbers moved by 100,000 for each copy and the holders by 400,000. The job's functions were then called from a script, as the runner calls them: a tick starts a
batch (`nextPassAccounts`, `writePassLines`, `passTokens`, `recomputeTokens` with `rematch: 'all'`, the generation row) while less than 4 s have passed since it started; a window is `applyLineStates` and
`recomputeTokens` over random lines of the table, in chunks of 2,000 (`LINE_STATES_SQL`, `STORED_LINES_SQL`); the memory is `system.query_log.memory_usage` and the rows read are its `read_rows`. The **cost of the
toml sweep was not measured**, nor was the cost of an empty repair window. **`account_states` held 3 rows an account** in these tables, so **the issuer-settings read of a window was not measured at mainnet shape**:
it takes the newest row of each issuer the window names (`LIMIT 1 BY account` over `account IN {issuers}`), which reads each issuer's prefix of the key in every partition, with the wide `fields` column, and the
whole history of a busy issuer's changes of its own settings. On real tables with billions of rows a window that names a few hundred issuers may spend seconds on this read alone; a window is never cut, so the
effect is time (the run overruns its 4 s and delays `stats_live` of that tick), not a stall. The job logs the duration of each window at debug level (`tokens: generation N (live): ledgers A - B, ..., T ms`; the repair
has the same line, with `(repair)`), so that the rollout can record the slowest ones (the table above); a read of the newest key first is for the rollout to show necessary. The `T ms` covers the **whole window**, from the
read that chooses it to the update of the generation row (the older-parser check, the state reads, the recompute and the writes), not the issuer-settings read alone, so it shows that a window was slow and not which of its reads.

| What | Measured |
| --- | --- |
| **The account pass, a 4 s tick** (batches start while the budget lasts, 3 runs) | 62 to 64 batches: **31,000 to 32,000 accounts** and 4.0 to 5.0 million `trust_line_states` rows read, 31,000 tokens recomputed and 250,000 to 440,000 `token_lines` rows written (the tick that holds the big issuer writes more), 4.03 to 4.05 s |
| The whole pass | 100 batches in 2 ticks (6 s of work). 8x: 800 batches in 13 ticks (50 s), 30,500 to 34,500 accounts and 4.1 to 5.2 million rows a tick |
| **The slowest batch** | **0.35 to 0.39 s**, the batch that holds the issuer of 200,000 lines (the lines' `INSERT ... SELECT` 0.27 s and the tokens 0.07 s); the median batch 58 to 59 ms, the 90th percentile 62 to 65 ms. Nothing near the 4 s of a tick |
| **Peak memory** (`system.query_log.memory_usage`) | **140 MiB**, the `INSERT ... SELECT` of the big issuer's batch (the average batch 22 MiB); every other statement of the pass 14 MiB or less |
| An issuer with **2,000,000 lines** (10,000,000 state rows) in one batch | 2.1 s for the lines, 0.4 s for the tokens, **2.5 s**; peak **696 MiB**. A batch is one statement and is not split, and is never cut by the budget |
| **A window of 2,000 lines** (the touches of a window are read in chunks of 2,000 lines), 8x | `LINE_STATES_SQL` **0.30 s** (3,371 of 4,923 granules, 27.5 million rows, 221 MiB peak), `STORED_LINES_SQL` **0.15 s** (two reads of 2,000 keys, 3.9 of 5.4 million rows, 103 MiB peak); applying it 0.48 s and recomputing its 3,600 tokens 0.40 s: **0.9 s** against the 4 s of a tick. On the 1x table 0.3 s |
| A window of 20,000 lines (the most a window holds before it is halved), 8x | applying 4.7 s, recomputing 35,000 tokens 1.0 s: **5.7 s**, past a tick (a window is never cut; the next run starts when it ends). A window of 500 ledgers holds about 12,000 lines on today's mainnet (below), so a heavy window is a few seconds |
| **`distinctHolders`**, 8x (4,776,431 `token_lines` rows, 2,216,359 distinct holders) | 0.40 s, **331 MiB** |

**`distinctHolders` against `maxQueryMemoryBytes`.** The job runs in the syncer, whose `GH_CLICKHOUSE_MAX_QUERY_MEMORY` is 0 (no cap of its own: the server's limit applies) in `deploy/.env.prod.example`; the api's cap of
2 GiB (`API_CLICKHOUSE_MAX_QUERY_MEMORY`) does not apply to it. Linearly, 20 million lines with about 9 million distinct holders would need about 1.4 GiB: under 2 GiB, not by much. **If a cap is ever set on the
syncer, keep it above 2 GiB** (the query is one aggregate over the generation's partition, and runs once in ten runs).

**`state_touches` rows a ledger**, from the parser over the real mainnet ledgers that three of the fixture sets of the repository (`packages/shared/test/fixtures/xrpl/{recorded,path-payments,objects}`) record; the other sets were not counted. They are not a sample: they were picked for the transactions in them.

| Set | Ledgers | Touches | A ledger |
| --- | --- | --- | --- |
| `recorded` (107,670,360 to 107,671,607) | 9 | 221 | 24.6 (22.2 `line`, 2.3 `account`) |
| the path payments (107,872,476 to 107,873,048, and 3 older) | 7 | 156 | 22.3 |
| the ledger objects (102,145,584 to 107,972,102) | 22 | 885 | 40.2 |
| All three | 38 | 1,262 | **33.2** (31.0 `line`, 2.2 `account`) |

A `line` touch is one changed `RippleState` node (a state change writes two `trust_line_states` rows, one for each side). A ledger full of `TrustSet` transactions has thousands of touches: the average does not include such bursts. The compressed size of a `state_touches` row was **68 bytes** (3,000,000 rows whose two
addresses were 32 random hexadecimal digits each; a real base58 address holds more entropy a character, so 70 to 90 bytes is the guess).

### Estimated for the XRP Ledger

These are estimates, and say what they assume. **The count of `RippleState` entries of the XRP Ledger is not known here**: no figure is in the repository, and a search for one found only 1,030,942 total trust lines
in September 2021 (a post of Xrpl.Services on X, <https://x.com/XrplServices/status/1433390299901046790>), far below today's. The estimates below assume round figures, to be replaced by the real count at the rollout (step 8).

| Estimate | Assumes | How | Result |
| --- | --- | --- | --- |
| **The first build, by rows** (the account pass; the touches after its head are a few minutes of work on top) | **20 million** `RippleState` entries (an assumed round figure, no source), 5 state rows for each of its two sides (the synthetic shape) = 200 million `trust_line_states` rows | rows ÷ about 4.5 million rows a tick (4.0 to 5.2 million measured), one tick a minute | about **44 ticks, under an hour** with the table in the page cache |
| the same, a longer history | 40 million entries, 10 state rows for each side = 800 million rows | the same rate | about **180 ticks, 3 hours** |
| the same, a shorter one | 10 million entries, 5 state rows = 100 million rows | the same rate | about 22 ticks, 22 minutes |
| **The first build, by accounts** | **5 million accounts** that have a trust line in `trust_line_states` (an assumed round figure, no source) | accounts ÷ about 31,500 accounts a tick (31,000 to 34,500 measured), one tick a minute | about **160 ticks, 2.7 hours** |
| **Disk of the table the pass reads** | 200 million rows | 82 bytes a row (409 MB for 5 million, measured) | about 16 GB, so a cold table is read from disk, which makes the build slower than the cached rate: allow a multiple of the figures above |
| **`state_touches` rows a day** | **33 touches a ledger** (31 `RippleState` nodes: the 38 recorded ledgers above, which were picked for their transactions and may be above the average) and **20,800 ledgers a day** (the figure of the delegation re-ingest, about 21,600 at a ledger every 4 s) | 33.2 × 20,800 | about **690,000 rows a day** (460,000 to 840,000 for 22 to 40 a ledger), 50 to 60 MB a day compressed at 70 to 90 bytes, about 20 GB a year (the P6 retention drops it with its block) |
| **The repair of a reprocess** (step 4) | 216,000 windows of 500 ledgers; 12,000 lines in a window (500 ledgers × 25 `line` touches, today's rate: older ledgers have fewer) | 3 to 4 s a window (the interpolation of the measured 0.9 s for 2,000 lines and 5.7 s for 20,000), one window a run | **at worst 216,000 minutes, 150 days**, if every window were as heavy as today's and the repair never found an older parser; the windows of the early years hold far fewer lines, and an empty window costs a few small reads (not measured). The rebuild that the first older-parser window starts is the hours of the first estimate |

**The first build is the larger of the two estimates.** The measurement cannot tell the cost of a row from the cost of a batch: every batch is about 500 accounts of about 16 lines and 80 state rows each, so a table of accounts with one or two lines costs more a row than the
synthetic one, and the rate by accounts is the one to trust for it; a table of accounts with many lines or many states costs more a batch, and the rate by rows is. Hence "an hour to a few hours", and the real duration is step 8.

A batch of the pass is nowhere near the 4 s of a tick on the synthetic data. Two things can pass it, and a batch or a window is never cut: an issuer with several million lines (2 million: 2.5 s and 700 MiB; the
figure grows linearly), and a window of touches of several thousand lines (a few seconds). A tick that holds one runs long, and `stats_live` and `stats_dirty` after it get what is left of the 30 s ([the budget of a tick](#ledger-objects-and-delegation)).

### Retention of the token tables

`state_touches` is a P6 ledger table and goes with its block when the ledger tables are dropped ([Retention](#retention): the same ten partitions of a block as `amm_pool_touches`). **The token tables are never dropped by
retention**: `token_lines`, `tokens` and `token_generations` are aggregates, partitioned by generation, and nothing rebuilds them after a drop but the account pass over the state tables. A rebuild after a block was
dropped (a forced rebuild, or a new generation after a change of the coverage) is **exact only for the lines whose last state row is above the oldest kept block**: a line that was last changed in a dropped
block has no row left to rebuild it from, and drops out of the tokens it belonged to (their holders, trust lines and supply fall). The live generation keeps serving the lines it already has.

### A persistent `tokens_dirty`

`syncer_aggregator_errors_total{job="tokens_dirty"}` rises at each tick and `SELECT count() FROM xrpl.agg_dirty` does not fall. The hook of `tokens` comes before only the hooks of `mpt_state` and of the token history, which wait with the slice, and **throws, by design, while the job
has not read its version floor or when the reads that open its last run failed**, so that a range is never marked without the job being able to repair it; a slice that fails stays in `agg_dirty` and its earlier hooks
run again at each tick. Look in the log for `Aggregator job tokens failed...` and `Aggregator job tokens_dirty failed in <from> - <to>: ...`:
- **A missing table** (`Table xrpl.token_generations doesn't exist`): migration 014 was not applied before the syncer, and the boot check could not be made (ClickHouse was unreachable then: the boot log has
  `Could not check that 014_issued_tokens.sql is applied`), because a syncer that can read the database refuses to boot without it. Apply it (`dc run --rm migrate-xrpl`); the job reads its tables at the next tick and the queue drains.
- **ClickHouse refusing the reads** of the job (time limit, memory cap, the database down): fix the cause; the job's opening reads work at the next tick.
- **A step of the job that fails** does not stop the hook: only the opening reads do. A drop that fails for the privilege, a window, a batch of the pass, a rebuild check that keeps failing wait (5 minutes, doubling to an hour)
  and show as `tokens` errors, not as `tokens_dirty`.
No mark is lost meanwhile; when the job reads its tables the queue drains by itself.

```sql
-- the generations: the newest row of each (state: building, live, retired)
SELECT generation, argMax(state, version) AS state, argMax(through_ledger, version) AS through_ledger, argMax(repair_from, version) AS repair_from,
       argMax(pass_done, version) AS pass_done, argMax(account_cursor, version) AS cursor, argMax(holders, version) AS holders
FROM xrpl.token_generations GROUP BY generation ORDER BY generation;
-- the head, for the lag of the live generation
SELECT max(ledger_index) AS head FROM xrpl.ledgers;
-- the tokens of the live generation (replace 7 with its number): the newest row of each, not deleted
SELECT count() FROM (SELECT issuer, currency, argMax(deleted, version) AS gone FROM xrpl.tokens WHERE generation = 7 GROUP BY issuer, currency) WHERE gone = 0;
-- the partitions: a retired generation should be gone 15 minutes after it was replaced
SELECT table, partition, sum(rows) AS rows, formatReadableSize(sum(bytes_on_disk)) AS size FROM system.parts
WHERE database = 'xrpl' AND table IN ('token_lines', 'tokens') AND active GROUP BY table, partition ORDER BY table, partition;
```

## The MPT state job

The `mpt_state` job of the aggregator ([syncer](syncer.md#the-mpt_state-job)) keeps `mpt_issuances` and `mpt_holders`, which the MPT routes serve. Every tick, eleventh in the tick (after `stats_dirty`), budget 3 s.

**Roll out MPT in this order.**

1. Apply `017_mpt.sql` on each network's database: `dc run --rm migrate-xrpl` and the same for each network ([Apply a schema migration](#apply-a-schema-migration)). It comes before a syncer of parser version 10, which refuses to boot without its tables.
2. Deploy the syncer (parser version 10, job `mpt_state`) and the api together. The api's MPT routes read the tables of step 1 and answer from empty ones until the syncer has filled them.
3. Watch `syncer_mpt_state_lag_ledgers`: 0 to a few ledgers once caught up ([alerts](observability.md#recommended-alerts)).
4. The history comes with the program's one reprocess ([backfill](backfill.md#mpt-data-re-ingest)); Xahau needs none.

**Until that reprocess** an issuance untouched since the deploy is a 404 (`state_known = 0`), the list leaves it out, and the answers say `complete: false`. To see where a network stands:

```sql
SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 99226369 GROUP BY parser_version;
SELECT countIf(state_known = 0) FROM (SELECT * FROM xrpl.mpt_issuances ORDER BY mpt_issuance_id, version DESC LIMIT 1 BY mpt_issuance_id);
```


- **During a stats catch-up a new issuance waits.** The job comes after `stats_live` and `stats_dirty`, so that the jobs before `stats_live` keep to their 27 of the 30 s of a tick. While those two use the tick it gets no budget: `syncer_mpt_state_lag_ledgers` climbs at about 20 ledgers a minute, `/v2/mpt/{id}` answers 404 for an issuance made meanwhile, and an alert on the gauge fires without a fault (read `syncer_aggregator_stats_lag_seconds` beside it). It ends with the catch-up.
- **A first run reads where it stands, and waits for the answer.** The cursor is found once per process, by a scan of `mpt_touches` joined with the newest row of each issuance, whether or not the run has budget. Measured on ClickHouse 26.8.14.3 in a container on a laptop, 2026-10-31: 14 ms at 1,000,000 touches and 5,000 issuances, 24 ms at 5,000,000, with or without the issuances' rows. Mainnet's MPT history, as far as it was read, is far below the first of those (the recorded findings count 3,796 transactions touching an MPT in the histories of 113 issuers, 14 of them capped), so `nft_state`'s read in the background is not needed here: it would take about 30 lines. Look again if `mpt_touches` passes tens of millions of rows.
- **An issuance that fails on its own is set aside**, and does not show in the gauge, since the cursor goes on: `increase(syncer_aggregator_errors_total{job=~"mpt_state.*"}[2h]) > 0` says so ([observability](observability.md#recommended-alerts)), and the log names it (`Aggregator job mpt_state failed for issuance <id>, set aside to be tried again: ...`). Its row and its holders are stale until its retry works: 5 minutes, doubling to an hour. A restart forgets the set and finds the issuance again in the tables; what a slice of `agg_dirty` named of it is forgotten with it, and a pair the re-ingest rewrote below the issuance's `last_ledger` then waits for its next touch, or a `--reprocess` of the range again ([Backfill and repair](#backfill-and-repair)).
- **`mpt_state_dirty` rising** with `agg_dirty` not falling is the hook of a slice failing: the read of what the slice names, or most of its issuances (the database, not an issuance). The slice stays queued and its earlier hooks run again each tick, as for every hook.

### Retention of the MPT tables

`mpt_touches` and `mpt_transfers` are P6 ledger tables and `mpt_issuance_states`, `mpt_holder_states` and `mpt_issuance_transfers` P7, and all five go with their block when the ledger tables are dropped ([Retention](#retention)). **`mpt_issuances` and `mpt_holders` are never dropped by retention**: they are aggregates, and nothing rebuilds them after a drop but the job. After a block was dropped:

- **The holdings read the state table directly.** `/v2/accounts/{address}/mpt` reads `mpt_holder_states`, so a holder last changed in a dropped block leaves that route, although `/v2/mpt/{issuanceId}/holders` still lists it from `mpt_holders`.
- **A rebuild is exact only for what has a state row above the oldest kept block.** A pair last changed in a dropped block has no row to rebuild it from: a rebuild that names it deletes its `mpt_holders` row, and its issuance's counts fall. An issuance whose own node last changed in a dropped block turns `state_known = 0` at its next rebuild, which any touch of a holder causes, so it answers 404 and leaves the list. Its `created_*` keys go at that rebuild too when the block of its creation is gone.
- **The transfers of a dropped block leave `/v2/mpt/{issuanceId}/transfers`**, and the live numbers do not change for it.

To bring a block back run `range-ingest` over it ([Retention](#retention)); its marks reach the job through `agg_dirty`.

## The token history

The issuer analytics routes (`/v2/issuers/{issuer}/tokens`, and `/summary`, `/supply`, `/flows`, `/distribution` and `/snapshot` of a token; [api-reference](api-reference.md))
and, once it is built, D6's `/v2/tokens/{token}/holders` are served from the **token history** ([ADR-0021](adr/0021-token-history-in-clickhouse.md),
[data-model](data-model.md#token-history-migration-019)): a change log of every issued token and MPT, its checkpoints and its hourly rollups, one generation at a time.
**Two writers share it.** The syncer's `token_history` worker follows the head, repairs after a re-ingest, catches a finished build up and promotes it
([syncer](syncer.md#8b-the-token_history-worker)). The operator's **`token-history-build`** command does the heavy one-off work of a generation: the worker never starts one,
it only says when one is due. The pieces, all per network:

| Piece | Cadence | Healthy | Watch |
| --- | --- | --- | --- |
| The `token_history` worker | a pass a second; whether a build is due every 10 minutes | once a generation is live, `syncer_token_history_lag_ledgers` 0 to a few ledgers, no `syncer_token_history_rebuild_needed` series, `syncer_token_history_errors_total` flat | the gauges; the log lines `Token history: ...` |
| `token-history-build` | when the operator runs it | exit status 0, then the worker catches the generation up to the head and promotes it (`Token history: generation <g> is live`) | its log; `token_history_state` (below) |
| The aggregator's eighth `agg_dirty` hook | with each `agg_dirty` slice | `token_history_dirty` empties as the worker repairs | `syncer_aggregator_errors_total{job="token_history_dirty"}` |
| The routes of the api | the live generation read every 5 s | an answer is as of the live generation's `levels_through`, seconds behind the head | 404 `token history is not built yet` before the first generation is live |

**What the owner does to deploy** (per network, the sandbox first, then production):
1. **Apply migration `019`** (`dc run --rm migrate-xrpl` / `migrate-xahau`) before the syncer and the api of this release ([above](#apply-a-schema-migration)).
2. **Deploy the syncer with `token_history` in `GH_WORKERS`.** It is in the default list and in the lists of `deploy/.env.prod.example`, `deploy/.env.sandbox.example`
   and `apps/syncer/.env.example`; a deployment whose `GH_WORKERS` was copied from an earlier example names the six workers before it: add `token_history`, or the
   worker does not run and `token-history-build` refuses to start ([configuration](configuration.md#5-syncer-appssyncer)). The worker follows the head with no generation to write to and
   reports `syncer_token_history_rebuild_needed{reason="none"}`; the aggregator's hook marks every re-ingest from now on, whether the worker runs or not.
3. **Deploy the api.** The new routes answer 404 `token history is not built yet`; `/v2/tokens/{token}/holders` serves D6's answer as before (a ledger parameter or an
   MPT is that 404) until a generation is live.
4. **Fill the history** with `range-ingest` from the network's first ledger (32,570 on XRPL, 1 on Xahau), as [backfill](backfill.md#token-history) says. The build
   refuses to start while it runs.
5. **Run `token-history-build`** once the fill is done (below). The worker catches its levels up to the head and promotes it; on XRPL and Xahau the answers then
   say `complete: true` (the coverage reaches the network's first ledger). The testnets have no first ledger to reach and stay `complete: false`.
6. **Run `token-history-check`** against a node GateHub runs, EURGH among the tokens (below), and add its report to the verification file of the plan
   (`docs/superpowers/plans/2026-11-08-issuer-analytics.verification.md`).
7. **The explorer** moves to the extended `/holders` when it wants: its order is exact and its marker holds the holder and the balance text, so a marker from D6's
   answer is `invalid marker` once after the switch.

**For analytics before the fill ends**, run the build after step 3: it builds on the head's unbroken run of stored ledgers (`complete: false`). When the fill joins
that run the worker says `rebuild_needed{reason="coverage"}`, and one more run of the build replaces the generation.

### The build: `token-history-build`

```bash
# production compose (the syncer keeps running: the build needs its token_history worker)
dc run --rm --no-deps syncer-xrpl node dist/cli/token-history-build.js
dc run --rm --no-deps syncer-xrpl node dist/cli/token-history-build.js --threads 2      # fewer threads, less load on the server
# the same from source: `token-history:build` runs the compiled dist/cli/token-history-build.js, so `pnpm build` first; it needs the syncer's GH_* environment
pnpm build && GH_ENV=local pnpm --filter @gatehub/data-syncer token-history:build
```

Options: `--threads <n>` (`max_threads` of every statement, a whole number from 1, default `TOKEN_HISTORY_BUILD_THREADS` = 4; more is faster and loads the
ClickHouse server more) and `--help`. The network and ClickHouse come from the same `GH_*` environment as the syncer; its client has no 30 s guards (a request timeout
of 6 hours and no `max_execution_time`, unless `GH_CLICKHOUSE_REQUEST_TIMEOUT` or `GH_CLICKHOUSE_MAX_EXECUTION_TIME` is set). It resumes a building generation of the
current config and coverage, else it starts a new one at `h0` = the commit marker (a building one of another config or coverage is retired first), and runs the phases
`changes`, `mpt_changes` (where the network has MPTs), `levels` and `dex` ([syncer](syncer.md#the-build-command)), writing its state row after every batch.

**It refuses to start** (exit status 2) with a message that names why:
- `another token-history-build holds the lease (<holder>)`: a build holds the lease `<network>:token_history_build` (fresh for 30 s after its last heartbeat). Two
  builds that start together each read the lease back after a second, and the one that finds the other newest leaves (`another token-history-build took the lease`).
- `a range-ingest is running: build the token history once the fill is done`: an `ingest_log` range whose newest row is `started` (a `range-ingest` or a
  `--reprocess` in progress). **A run that died leaves its chunk `started`** until a rerun of it redoes the chunk, and the build refuses until then (the query
  below finds it).
- `no token_history worker holds a fresh lease: the build needs it to write the changes above its start`: no syncer runs the worker (not in `GH_WORKERS`, or the
  syncer is down).

**Exit status:** `0` the build is done (`Generation <g> is built; the token_history worker catches it up to the head and promotes it`); `1` it failed or was
interrupted: run it again to resume; `2` it refused to start, or the command line is wrong; `3` it was stopped while it ran: a `range-ingest` started, and the
generation is retired (`a range-ingest started: generation <g> is retired; build again once the fill is done`), or it lost its lease (`token-history-build lost its
lease (...)`: another holder is newest, or no renewal landed for 20 s). A lost lease leaves the generation `building`: look for the other build before running it
again, or wait 30 s if none runs. Two failures name their cause: `no ledger is committed: there is nothing to
build the token history from` and `no unbroken run of stored ledgers reaches the head <h>`.

**Stopping it.** Ctrl-C (SIGINT) or a SIGTERM (`docker stop`) stops it after the statement in flight (`Interrupted: stopping after the statement in flight ...`),
exit status 1, and it resumes from its state row when run again. A second signal exits at once (130), without releasing the lease: wait 30 s before running it
again. So it can be run off-peak, stopped and started again with fewer threads.

**Its log**, as `range-ingest`'s: `Building the token history of <network> in database "<db>" at <url>, <n> thread(s)`, then `token-history-build: generation <g>
started at h0 <h>, coverage from <f>`, a line after every batch (`token-history-build: generation <g> phase <phase> cursor <cursor> rows <n> (<r> rows/s)`) and
`token-history-build: generation <g> done, levels through <l>`. Every statement carries the `log_comment` `token-history-build`. The command has no metrics endpoint;
the syncer's `syncer_token_history_building{phase}` follows its state row.

```sql
-- the generations: the newest row of each (state building, live or retired; the build's phase and cursors; how far each is)
SELECT generation, state, config_version, coverage_from, h0, h1, phase, account_cursor, token_cursor_issuer, token_cursor_currency,
       through_ledger, levels_through, started_at, changed_at
FROM xrpl.token_history_state ORDER BY generation, version DESC LIMIT 1 BY generation;
-- the head, for the lag of the live generation
SELECT max(ledger_index) AS head FROM xrpl.ledgers;
-- is a range-ingest in progress, or did one die? (the build refuses while one of these is listed)
SELECT range_start, range_end FROM xrpl.ingest_log WHERE NOT startsWith(run_id, 'live:')
GROUP BY range_start, range_end HAVING argMax(status, updated_at) = 'started';
-- the build's statements of the last hour
SELECT count() AS statements, sum(query_duration_ms) / 1000 AS seconds, sum(read_rows), sum(written_rows), formatReadableSize(max(memory_usage)) AS peak
FROM system.query_log WHERE type = 'QueryFinish' AND log_comment = 'token-history-build' AND event_time > now() - 3600;
-- the ranges a re-ingest left for the worker to repair
SELECT * FROM xrpl.token_history_dirty ORDER BY from_ledger, to_ledger;
-- the partitions of the generation tables: a retired generation should be gone 15 minutes after it was retired
SELECT table, partition, sum(rows) AS rows, formatReadableSize(sum(bytes_on_disk)) AS size FROM system.parts
WHERE database = 'xrpl' AND table IN ('token_holder_changes', 'token_checkpoints', 'token_checkpoint_heads', 'token_hourly') AND active
GROUP BY table, partition ORDER BY table, partition;
```

**What it costs the rest of the system.** The ingest never waits for the build: they are separate processes, and the build's work happens in ClickHouse. But they
share the server: while the build runs it reads hundreds of GB and writes tens to hundreds on XRPL, and the merges of what it writes follow, so the ingest's inserts
and the api's reads can be slower. That effect was not measured. Run it off-peak, with fewer `--threads`, and stop it if the api suffers: it resumes.

### Measured on synthetic data (the build)

Measured on 2026-11-08 with `token-history-build --threads 4` against a ClickHouse 26.8.14.3 of its own in Docker (16 CPUs and 16 GB for the VM, a laptop shared with other
work, the tables warm), from `system.query_log` of the statements tagged `token-history-build`; the record is
[the verification file](superpowers/plans/2026-11-08-issuer-analytics.verification.md#build-measurement). **Synthetic means that the shape is made up**, as for the issued
tokens above: `trust_line_states` held 1,000,000 lines in 50,000 accounts, 5 state rows each (5,000,000 rows; one issuer has 200,000 of the lines in 3 currencies), and the
8x tables 8 copies of it (40,000,000 rows); `ledgers` every ledger from 70,000,000 to 98,000,999; 100,000 `mpt_holder_states` rows; 2,000,000 `exchanges`. No live window
ran beside the build (a fake lease stood in for the worker), so `h1 = h0`.

| | 1x | 8x |
| --- | --- | --- |
| **Whole build** (wall time) | **18 s** | **111 s** |
| `changes` | 6 s, 100 batches: 5,000,000 state rows into 3,000,000 change rows, about 1.25 million state rows a second of statement time | 51 s, 800 batches: 40,000,000 into 24,000,000, 1.14 million a second of statement time (0.78 million of wall time) |
| `mpt_changes` | 1 s | 2 s |
| `levels` | 7 s: 257,130 hour rows, 15 checkpoints of 947,000 rows | 54 s: 400,026 tokens, 120 checkpoints of 7,576,000 rows; about 630,000 changes a second of statement time (440,000 of wall time) |
| `dex` | 3 s, 1,711,123 rows of `token_hourly_dex` | 3 s |
| **Peak memory** | 665 MiB (the `changes` batch of the issuer of 200,000 lines); `dex` 552 MiB | 667 MiB (the same batch: it grows with the largest account of a batch, not with the table); `dex` 575 MiB |
| Bytes a row | 31.5 a change, 24.4 a checkpoint row, 34.0 an hour row | 31.7, 24.2 and 32.9 |

**Estimated for the XRP Ledger**, from those rates, assumed linear (as they were from 1x to 8x), warm, at 4 threads: `changes` reads 2 to 7 billion
`trust_line_states` rows, **30 minutes to 2.5 hours**; `levels` reads 1 to 3.5 billion changes, **30 minutes to 2.2 hours**; `mpt_changes` minutes; **in all 1 to 5
hours** before the DEX history and a cold disk (the spec's estimate was half a day to two days). On a cold disk the read rate bounds `changes` and `levels`: at 200 to 500
MB/s, 300 GB of state rows take 10 to 25 minutes to read, the same order as the warm figures. **Not measured:** real-shaped tables, the DEX history at scale (its
synthetic reads were mostly `ledgers`), a cold disk, the catch-up and the promotion, and the build's effect on the ingest and the api. **Disk:** the synthetic rows
compress far better than real ones (their addresses and amounts repeat), so 60 to 90 bytes a change stays the planning figure: 60 to 315 GB for the change log (the
synthetic 32 to 110 GB is a floor), about 70 to 350 GB for the whole token history, and twice the generation tables while a build exists beside the live generation.
Record the real figures (the build's duration per phase, the rows and the disk of each table) in the verification file at the rollout.

The worker's check of whether a build is due searches the start of the head's unbroken run every 10 minutes: about 27 counts of distinct ledgers over ranges of
`ledgers`, each 0.08 s over 90 million ledgers (`groupBitmap`, measured in PR 1's review), so a few seconds every 10 minutes on XRPL.

### A forced rebuild of the token history

**Running `token-history-build` while a generation is live builds a new one beside it**, whatever the worker says: the live generation keeps serving and being kept at
the head, the worker catches the new one up and promotes it, and the old one's partitions are dropped 15 minutes after its retirement. There is no outage and nothing
else to run; the cost is that of the first build, and twice the generation tables on disk until the drop. A run that finds a building generation of the current config
and coverage resumes it instead, and one of another config or coverage is retired and started again.

The worker says when a rebuild is due (`syncer_token_history_rebuild_needed{reason}` and one log line, `Token history: a build is due (<reason>); run token-history-build`),
and builds nothing:
- `config`: a release raised `TOKEN_HISTORY_CONFIG_VERSION` in `packages/shared/src/token-history/constants.ts` (a change of the token side, the checkpoint floor or the
  flow rules): the answers follow the old rules until the new generation is promoted;
- `coverage`: a fill has joined the head's unbroken run, so the history reaches further back than the live generation's `coverage_from`;
- `repair`: the oldest range of `token_history_dirty` holds a ledger of a parser older than the token history reads (8, or 10 on a network with MPTs): it is not
  repaired, and the ranges after it wait until the promotion of the new generation clears them;
- `none`: there is no generation yet.

No reason is given while a building generation exists. **A due build raises no alert**: it waits for the operator by design, and the gauge and the `complete: false`
of the answers say so.

### Alerts and errors of the token history

The recommended alerts ([observability](observability.md#recommended-alerts); no alert rules ship in the repository): `syncer_token_history_lag_ledgers > 30` for 10
minutes while a generation is live (the answers are behind the head), and `syncer_token_history_errors_total` rising for 15 minutes. A step of the worker that fails is
tried again at the next pass, a second later, with no backoff, and the log says which (`Token history: the <step> step failed: <message>`):
- **`drop`**: most often the `ALTER DELETE` privilege that `DROP PARTITION` asks for, if the syncer's access was narrowed ([clickhouse](clickhouse.md#memory-and-safety-guards));
  the retired partitions stay and the disk grows by a generation at each rebuild.
- **`live`**: a window the worker cannot apply. The lag grows with the head, and the answers stay at the last `levels_through`.
- **`repair`**, **`catch_up`**, **`dex`**: ClickHouse refusing a read or an insert. A failing repair keeps its range, and the ranges after it wait.
- **`token_history_dirty`** (an aggregator label) rising with `agg_dirty` not falling: the hook of a slice cannot append its range; the slice stays queued, as for every hook.

### Retention of the token history

- **A retired generation is dropped by the worker**, by partition from the four generation tables, 15 minutes after it was retired (`TOKEN_HISTORY_RETIRED_KEEP_MS`).
  `token_history_state` keeps a row for each change of a generation, and `token_hourly_dex` (no generation) is kept: once the DEX history is written, `pair_hourly`'s
  45 days do not matter to it.
- **The ledger retention never touches the seven tables** ([Retention](#retention)): the live generation keeps its rows and its coverage after a block is dropped, and no
  reason for a build is given (the start of the head's run moved up, not down). A build after a dropped block starts its coverage above it (`complete: false`), and a
  line whose state rows were all in the dropped block is missing from it, as for D6's tables. Bringing the block back with `range-ingest` changes nothing for a
  generation built before the drop (the repair of the block's ranges writes the same rows again); for one built after it, the worker says `coverage` once the fill
  joins the head's run.

### The mainnet check: `token-history-check`

The success check of the rollout, run by an operator against mainnet, not in CI (`apps/syncer/src/cli/token-history-check.ts`). For every token of a file and every
ledger of a list it walks `/v2/tokens/{token}/snapshot` of the api (pages of 10,000) and the issuer's `account_lines` at the ledger on a node, compares every holder's
balance exactly (a holder's balance is the issuer side's negated, where the issuer owes), and compares the snapshot's `supply` with the issuer's obligation in
`gateway_balances`. One request is in flight at a time, to the api and to the node. It needs no ClickHouse and no `GH_*` environment, only an api key in an environment
variable that `--key-env` names.

```bash
# from source (it runs the compiled dist/cli/token-history-check.js; the image has it too, as node dist/cli/token-history-check.js)
pnpm build
export DATA_API_KEY=<an api key of the deployment>
pnpm --filter @gatehub/data-syncer token-history:check --api https://xrpl.data.gatehub.net --key-env DATA_API_KEY \
  --node wss://<a node GateHub runs> --tokens tokens.txt --ledgers 90000000,100000000,<a recent ledger>
```

All five options are required: `--api` (the api's base URL), `--key-env` (the name of the variable that holds its key, sent as `X-API-Key`), `--node` (a WebSocket URL),
`--tokens` (a file of one `{currency}.{issuer}` a line; blank lines and `#` comments are left out) and `--ledgers` (comma-separated ledger numbers). The report goes to
stdout, a line a sample, `<token> @ <ledger>: match (<n> holders, supply <s>)`, or `DIFFERENT: ...` followed by a line for each holder that differs, or `skipped: <why>`
(an MPT, which has no trust lines, or a sample the api refused, with its message), and last `summary: <m> matched, <d> different, <s> skipped`. **Exit status:** `0` every
sample matched or was skipped, `1` one differed (or the command failed), `2` a wrong command line or no key in the variable. Use a node GateHub runs: public nodes
pushed back on D9's comparison after 39 requests. Report fewer samples than asked as such.

## Supply snapshots

The `supply` job of the aggregator ([syncer](syncer.md#the-supply-job)) writes one row of `network_supply` an hour, every figure as of one ledger, and `GET /v2/network/supply` serves the newest. Rows are kept and have no TTL.

**Read the newest row:**

```sql
-- `version` tells the rows apart when a cycle was redone at the same ledger
SELECT * FROM xrpl.network_supply ORDER BY ledger_index DESC, version DESC LIMIT 1;
```

**Watch** `syncer_supply_snapshot_age_seconds` (a healthy age peaks at about an hour plus the cycle; the alert is above 3 hours), `syncer_supply_cycle_seconds`, `syncer_aggregator_errors_total{job="supply"}` and, on Xahau, `syncer_parser_anomalies_total{kind="import_minted_negative"}`, which should stay 0 ([alerts](observability.md#recommended-alerts)).

**Before the first snapshot** the route answers 404 `supply not computed yet`. The first cycle starts once the sentinel of the `escrows` job is within 1,000 ledgers of the head and, on the XRP Ledger, the `amm_pools` job has its cursor, so during a first fill of the escrows the route answers 404 for hours without a fault (the log says `supply: waiting for escrows/amm_pools to reach the head`). The cycle itself takes minutes today, up to an hour at full history.

**A reprocess or a backfill shows in the figures at the next cycle that starts after it, up to an hour later plus the cycle itself, while `coverage` changes at once**, since coverage is read at request time and the figures come from the snapshot. A part can say `complete: true` over a figure from before the fill, because a cycle already running keeps the start it planned. To be sure, read a row whose `started_at` is after the fill; the api does not serve `started_at`, so read it in `network_supply`.

**Re-ingests.** The job keeps no incremental state, so it has no `agg_dirty` hook and nothing to repair. A `--reprocess` that rewrites ledgers at or below the snapshot ledger while a cycle runs can leave that cycle's figures off for the accounts or mints it rewrote (a range read between the delete and the rewrite); the next cycle is right again. Which re-ingest each part needs is in [backfill](backfill.md#supply).

## Backfill and repair

The live syncer never fills history. History, gaps and parser changes go through the range-ingest CLI, which runs next to the live
syncer in the same image. Full guidance on sizing and nodes: [backfill](backfill.md).

```bash
# a range of one network (the syncer keeps running; the CLI checks its lease itself)
dc run --rm --no-deps syncer-xrpl node dist/cli/range-ingest.js --from 90000000 --to 90100000
# Xahau's public node throttles even one fetch at a time: 1 in flight (more only meets its pauses sooner; see backfill)
dc run --rm --no-deps syncer-xahau node dist/cli/range-ingest.js --from 1 --to 100000 --concurrency 1 --chunk 100

# after a parser change: rewrite committed ledgers (below the live checkpoint)
dc run --rm --no-deps syncer-xrpl node dist/cli/range-ingest.js --from 90000000 --to 90100000 --reprocess
```

- **Resume:** rerun the same command. Finished chunks are skipped, an unfinished one is redone. Exit status 1 means failed, 2 a
  wrong command line. **Not with `--reprocess`**: it writes every chunk it is given, so a rerun rewrites the whole range again. Restart
  with `--from` just after the last chunk the failed run finished (the last `Chunk [a,b] done ... (redone)` line, or `ingest_log`; the SQL
  is in [backfill](backfill.md#resuming-gap-repair-reprocessing)).
- **Speed:** `--concurrency` (ledgers of a chunk fetched at once) is bound by the node; `--chunk` (default 1000, must divide
  1,000,000) is the memory a run needs.
- **Above the checkpoint:** refused while the live syncer's lease is fresh. Backfill is history. A range that **starts** above the
  checkpoint + 1 is refused on a database a live syncer has run on, fresh lease or not, unless `--allow-gap` (Ruling R110): the live
  syncer resumes after the highest committed ledger, so the ledgers in between would never be fetched (and a live syncer that boots
  while the range is written deletes everything above its checkpoint). Pass `--allow-gap` only for a gap you fill yourself next.
- **Unfinished intents:** a rerun redoes the unfinished chunk of a run that died over its whole recorded range (also beyond the range
  of the rerun), and marks the hours of all its committed ledgers in `agg_dirty` (Ruling R110).
- **Aggregates follow by themselves:** every chunk marks `agg_dirty`, the aggregator recomputes the affected hours and days within
  its per-tick budgets. Watch `SELECT count() FROM xrpl.agg_dirty`.
- **The token history:** while a run is in progress (or one died and was not run again) `token-history-build` refuses to start, and a build that runs stops with
  its generation retired (exit status 3). A fill below the head's unbroken run is not repaired into the live generation; once it joins the run the worker says a build
  is due (`coverage`). A `--reprocess` inside the generation's coverage is repaired by the worker from `token_history_dirty` ([backfill](backfill.md#token-history)).
- **Do not** run two range ingests over overlapping ranges at once.

## Account and market aggregates

The routes `GET /v2/network/markets` and `GET /v2/accounts/{address}/analytics/*`, and `interval` on `stats/{family}` and `reports`, are served from aggregates that the syncer's
aggregator keeps ([syncer](syncer.md#7-the-aggregator), [ADR-0013](adr/0013-account-and-market-aggregates.md)). **Correctness never depends on them**: before an aggregate exists or while it lags, an
answer is the same and only slower, except for the `network/markets` table, which is only as current as its newest set.

### Rolling it out

1. **Deploy the syncer first.** `migrate` applies `003_account_market_aggregates.sql` (nine new tables; additive, nothing existing changes; on a database that lacks `002` the same job applies that first, in file-name order, see [Roll out the validators and amendments data](#roll-out-the-validators-and-amendments-data)), then the syncer starts the four jobs. `pair_hourly` fills its 31 days in minutes and the Markets sets appear;
   `rates_daily` back-fills newest first (`syncer_rates_daily_missing_days` falls to 0 within about a day on XRPL); `account_rollups` discovers and promotes the heavy accounts (`syncer_account_rollups_pending_accounts` falls to 0
   within one to two days). A database that is recreated (a new baseline: the migration runner refuses an applied file that changed, see [Schema migration failed](#schema-migration-failed)) goes through this step again: all of D2's tables are recomputable.
2. **Deploy the API.** The routes are right at once and fast where the tables already cover them: `network/markets` as soon as the first sets exist, an ordinary account once the rates of its days are stored, a heavy account once it is promoted.
3. **Switch the explorer** (one switch per sub-project, each a per-environment variable of the explorer's Worker) once the gauges of the data API that environment reads are at their mark:

| Explorer sub-project | Switch | Gauges that gate it |
| --- | --- | --- |
| Markets | `MARKETS` | `syncer_pair_hourly_missing_hours` = 0, and `syncer_markets_live_age_seconds{period}` under 600 for `day`, `7day` and `30day` |
| Account analytics | `ACCOUNT_ANALYTICS` | `syncer_rates_daily_missing_days` = 0 and `syncer_account_rollups_pending_accounts` = 0 |
| The AMM parts of the explorer | `AMM_DATA` | Only once that data API has merged the AMM work, re-ingested history with the AMM parser and back-filled: `syncer_pair_hourly_missing_hours` = 0 and `syncer_rates_daily_missing_days` = 0 again after the reprocess (it marks hours and rate days for recompute); and, with the AMM data additions of the aggregates, `syncer_markets_live_amm_share_known{period}` = 1 for `day`, `7day` and `30day`, **and `agg_dirty` drained** after the reprocess (`SELECT count() FROM xrpl.agg_dirty` is 0): see [the AMM data additions](#the-amm-data-additions) |
| Network dashboard | none | the network dashboard reads no route of these aggregates |
| AMM pages | `AMM_PAGES` | no gauge of these aggregates: the AMM work's routes and its `amm_daily` back-fill gate it (the AMM additions of the aggregates, `fees_est` and the computed range, are used when present) |
| Validators and amendments | `VALIDATORS` | no gauge of these aggregates: the validators work's own |

### The back-fills

While a back-fill runs, the API is **right and slower**. What that means:

- A closed day without a stored rate set is valued on read: a window over years can reach the 30 s `max_execution_time` guard (the route's 500), and `api_rates_on_read_total` climbs. Short windows (30 D, 90 D) are not noticeably slower.
- **`analytics/counterparties`** of an account with very many paid asset-days (a heavy account that paid thousands of assets over years) can answer 500 `unable to retrieve counterparties` **during the rates back-fill**: the rates of the days that are not stored
  travel in the request to ClickHouse, whose URI limit is 1 MiB. It is the same class of failure as the guard above and disappears once `syncer_rates_daily_missing_days` is 0 (then only the rates of today and yesterday travel). It is not a reason to
  raise `GH_CLICKHOUSE_MAX_EXECUTION_TIME`; wait for the back-fill.
- A heavy account that has not been promoted yet is read from its own rows: right, and as slow as the rows it holds (tens of seconds for years of an exchange's hot wallet, or the 500 of the guard).
- `network/markets` is not affected by the rates back-fill; it waits for `pair_hourly` (minutes). An old or missing hour (`Markets set of period <p> not written ...` in the log, `syncer_pair_hourly_missing_hours` > 0) keeps the previous set, whose `end_time` ages. The first start of a syncer with the AMM data additions computes the 31 days again (config version 2) and so waits the same way, for minutes.

Watch them with the gauges of [observability](observability.md#4-metrics-syncer); each job also logs once that its back-fill is under way and once that it is done. To follow one in SQL (the database `xrpl`; use `xahau` on the other network):

```sql
-- hours of pair_hourly that have a set (the sentinel is the empty pair), by day: 24 a day for the last 31 days
SELECT toDate(hour) AS day, uniqExact(hour) AS hours
FROM xrpl.pair_hourly WHERE base_currency = '' AND base_issuer = '' AND counter_currency = '' AND counter_issuer = ''
GROUP BY day ORDER BY day DESC LIMIT 32;

-- the newest sentinel of each rates day: stale = 1 is a day waiting to be computed again
SELECT day, argMax(stale, version) AS stale FROM xrpl.native_rates_daily WHERE currency = '' AND issuer = ''
GROUP BY day ORDER BY day DESC LIMIT 10;

-- the heavy accounts and what their rollups cover
SELECT account, rows, first_day, rolled_from, rolled_through, config_version
FROM xrpl.account_rollup_state ORDER BY account, version DESC LIMIT 1 BY account;
```

### What a re-ingest does to them

`range-ingest` (and `--reprocess`) marks the hours it rewrote in `agg_dirty`, and `stats_dirty` drains them in slices of at most a day. After each slice the hooks of the three jobs run ([syncer](syncer.md#76-the-agg_dirty-hooks)), and a fourth, of `nft_state`, marks the slice's ledgers in `nft_dirty` ([The NFT data](#the-nft-data)), a fifth, of `escrows`, recomputes the escrows of the slice's ledgers ([Ledger objects and delegation](#ledger-objects-and-delegation)), and, last, a sixth, of `tokens`, marks the slice for the repair of the generations of the issued tokens (the next run of the `tokens` job applies it):

- **Rates**: the days of the slice and the 14 after it that have a valid set are marked stale (a day's rate reads the trades of the 14 days before it). Until `rates_daily` has computed them again, newest first, the API values those days on read, so `syncer_rates_daily_missing_days` rises by up to the range plus 14 days and falls again; expect the
  slower path for the window of the range, and `api_rates_on_read_total` to show it. While ranges of the re-ingest wait in `agg_dirty`, `rates_daily` leaves the days they reach (the range and the 14 days after it) for after they are drained, so the gauge falls only as the queue empties. A range
  that keeps failing keeps its days waiting too: the "Daily rates not written" alert and `syncer_aggregator_errors_total` both show it.
- **Hours**: the hours of the slice in the last 31 days are recomputed at once (after an AMM `--reprocess` this is what puts the swaps into the `amm` rows of the Markets, see [the AMM data additions](#the-amm-data-additions)).
- **Heavy accounts**: every account whose rollups cover a day of the slice has that day recomputed (a new rollup set under a new version), and the partitions of the range are recounted by the next discovery.
- **Issued tokens**: the slice's `tokens` hook (the last one) lowers `repair_from` of the live and the building generation, and the `tokens` job applies the touches of `[repair_from, through_ledger]` again, a window of 500 ledgers at a time; a window that meets a ledger of an older parser marks a rebuild instead ([Issued tokens](#issued-tokens)).

Between the rewrite and the hook the aggregates show the old data (eventual, like `stats_hourly`). A hook that fails fails its slice: the range stays in `agg_dirty` and is retried at the next tick, and `syncer_aggregator_errors_total{job="rates_daily_dirty"}` (or `pair_hourly_dirty`, `account_rollups_dirty`, `nft_state_dirty`, `escrows_dirty`, `tokens_dirty`) says which.

### The AMM data additions

The AMM data additions to the aggregates (sub-project D2b, [ADR-0013](adr/0013-account-and-market-aggregates.md#d2b-the-amm-data-additions)) fill the AMM fields of `network/markets` (the `amm`
filter, `amm_share`, `amm_pool`, `totals.amm_share`), put `fees_est` on the live day row of `network/amm_volume` and `computed_start` / `computed_end` on the daily pool history. They read the AMM work's
data (a swap against a pool is an `exchanges` row written by parser version 2) and are deployed **after the AMM rollout**: the databases recreated at the merge and the history ingested again with
`range-ingest --reprocess` from the enablement ledger ([backfill](backfill.md#amm-data-re-ingest)).

**Rolling it out**, in this order:

1. **`migrate`** applies `004_amm_fee_estimates.sql`: one `ALTER TABLE volume_live ADD COLUMN IF NOT EXISTS`, additive and safe to run again. It runs before the API (required: the API reads the column on the live `amm_volume` read of the period `day`, which fails without it, step 3) and
   before the syncer (advisable): the syncer writes `fees_est_f` on every row of every live volume set, and a syncer against a database without `004` does not fail, because ClickHouse 26.8 skips a JSONEachRow field the table lacks
   (`input_format_skip_unknown_fields` is 1 by default and `ClickHouseService.insert` does not change it). The insert succeeds without the column, so the fee estimates of the ticks before the migration are lost and the live `amm_volume` day set
   reads as not known until `migrate` has run and the next tick has written it. Nothing shows this: `syncer_aggregator_errors_total{job="volume_live"}` does not count a missing column.
2. **The syncer.** `pair_hourly` computes its 31 days again at config version 2 (each pair split by source): `syncer_pair_hourly_missing_hours` starts at 745 and falls to 0 in minutes, and the Markets
   sets wait for it (`Markets set of period <p> not written ...` in the log, `syncer_markets_live_age_seconds` climbing): `day` and `7day` resume once the newest week of hours has its sets, `30day` once the hours of its 720-hour
   window and the current hour (and its 7 sparkline days) have theirs, not all 31 days ([syncer 7.2](syncer.md#72-pair_hourly)). Until a period's first run after that, `amm=exclude` and `amm=only` answer the no-set answer (those sets do not exist yet) and the old `include` set has no AMM fields. The `agg_dirty` ranges of
   the reprocess, while they drain, correct the rates and the heavy accounts' days and recompute the hours of the last 31 days ([syncer 7.6](syncer.md#76-the-agg_dirty-hooks)). The live day set of
   `amm_volume` gets its fee estimates at its next recompute (a set written before the column reads as not known).
3. **The API, last.** It reads `fees_est_f` on the live `amm_volume` read of the period `day` (`live=day`, the default of `live`, so the bare route reads it too) and on no other, so an API that runs before `004` fails that one read (500 `error getting data`); the other live reads do not name the column.
   The compose files order it (`migrate` completes before the services start); a deploy that starts the API by hand runs `migrate` first.
4. **The explorer's `AMM_DATA` switch** is the owner's, per environment (section 16 of the design). The gauges for it are in the table above; read the rest of this section first.

**What to watch: the cost of the live day set.** The live `amm_volume`/`day` set now estimates the fees of its pools at every tick (the swaps of 24 hours of the listed pools, one day-read of `amm_daily`), inside the
5 s budget of `volume_live` that the fifteen live sets share (`AGGREGATOR_VOLUME_LIVE_BUDGET_MS` in `aggregator.service.ts`, a constant, not a setting). After the deploy check that the live sets keep refreshing: the
spacing of the `version`s (the write time in milliseconds) of the live `amm_volume`/`day` and `trade_volume`/`day` sets in `volume_live`, about a minute apart; `syncer_aggregator_errors_total{job="volume_live"}`; and the warning
`Aggregator job volume_live reached its budget; the sets left go on next tick` in the log (said once until a tick finishes in time). Measure the duration of the `amm_volume`/`day` set on the mainnet database before turning
`AMM_DATA` on. If it crowds the budget, the options are raising `AGGREGATOR_VOLUME_LIVE_BUDGET_MS`, computing the estimate only every Nth tick, or narrowing the carry it requires to the trading fee (a slot lasts 24 h, far less
than the 160,000-ledger window) in both jobs, the live set and `amm_daily`.

**Turning on `AMM_DATA`.** `syncer_markets_live_amm_share_known{period}` is 1 when the newest `include` set of the period has its AMM share, which `markets_live` writes only when every ledger of the set's window was
written by parser 2 (the parser gate). The gate opens as soon as the last ledger of the window is rewritten, which can be **before the reprocessed hours are recomputed**: `markets_live`
runs before `stats_dirty`, and the hook of `stats_dirty` recomputes the hours of an `agg_dirty` slice, slice by slice. Until `agg_dirty` has drained (on a large reprocess that is longer than a tick) the gauge is 1 and the AMM share is understated (a window whose hours still hold the data of
the parser before AMM shows a share near 0). So turn `AMM_DATA` on once, in this order:

1. the reprocess has finished and **`agg_dirty` has drained**: `SELECT count() FROM xrpl.agg_dirty` is 0 (no metric shows the backlog; `stats_dirty` drains a day at a time, so a long reprocess takes a while);
2. `syncer_pair_hourly_missing_hours` = 0 and `syncer_rates_daily_missing_days` = 0 again (the reprocess marks the rate days stale; the `pair_hourly` hook recomputes its hours in place, so the hours gauge does not move for it);
3. `syncer_markets_live_amm_share_known` = 1 for `day`, `7day` and `30day`, read **after** the queue is empty: the `7day` and `30day` sets are rewritten every fifth run, so give them one more five-minute turn
   to be made from the corrected hours.

```sql
-- the lowest and the highest parser version among the ledgers of the last 31 days (a little more than the 30day window): the AMM share needs every ledger of a window at 2 or more, so the gauge of 30day is 0 while one is older
SELECT min(parser_version) AS lowest, max(parser_version) AS highest FROM xrpl.ledgers
WHERE ledger_index >= (SELECT ledger_index FROM xrpl.ledgers WHERE close_time >= now() - INTERVAL 31 DAY ORDER BY ledger_index LIMIT 1);

-- the newest include set of each period, and whether it has its AMM share (NULL: not known)
SELECT period, end_time, total_amm_share FROM xrpl.markets_live
WHERE amm = 'include' AND base_currency = '' AND base_issuer = '' AND counter_currency = '' AND counter_issuer = ''
ORDER BY period, version DESC LIMIT 1 BY period;
```

**What the API shows meanwhile.** Without the AMM share the fields are absent (never `0` or `false`), `exclude` is exact and `only` partial ([api-reference](api-reference.md#get-v2networkmarkets)); the explorer does not show the filter
then, even with `AMM_DATA` on. On a database whose history is not ingested again, the `30day` gauge turns 1 only 30 days after the release that writes parser 2. The other two additions need no gate: `fees_est` is absent for
a pool whose fee is not known, and `computed_start` / `computed_end` show how far the `amm_daily` back-fill has come.

### Rollups of heavy accounts

- `GH_ACCOUNT_ROLLUP_MIN_ROWS` is the size from which an account is heavy (default 1,000,000 balance changes). Raising it demotes accounts (their coverage is dropped, and the API reads their rows again) and lowering it promotes more, at the next run of the job (it classifies the accounts from the counts it already has; the counts themselves are refreshed every 24 hours for the newest partition of `balance_changes` and every 7 days for the others, so an account that
  grows past the threshold is found within a day).
  `0` turns the job off: the rollups that exist are still used by the API and still corrected after a re-ingest, and simply stop growing (`syncer_account_rollups_pending_accounts` is not updated while it is off).
- **Superseded rollup versions are never pruned.** A correction of a day (the hook above) writes a new set beside the old one: one more copy of the day for each covered account on every correction pass (the ranges of a day that were marked before its roll began share one roll). The old rows are not read; they stay in `account_lines_daily`, `account_tx_daily`, `account_trades_daily` and the old sentinels in `account_rollup_days`, and they only
  accumulate with re-ingests of covered days. Watch the size with `SELECT table, formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE active AND database = 'xrpl' AND table LIKE 'account_%' GROUP BY table`; no cleanup is shipped, and [Superseded rollup versions](#superseded-rollup-versions) has the query to run by hand.
- A heavy account whose rollup fails or lags is read raw for the days after `rolled_through` (slower, right); the failure is in the log of `account_rollups` and `syncer_aggregator_errors_total{job="account_rollups"}`.

### Superseded rollup versions

Nothing prunes the old copies of a corrected day (above). If they have grown enough to matter, delete them by hand: in each of the three row tables, the rows of an (account, day) whose `version` is below the newest version of that day's sentinel in `account_rollup_days` (the readers use only the rows of the newest sentinel), and in `account_rollup_days` the sentinels that are below the newest of their day. A set that is still being written has no newer sentinel yet, and what is above the newest sentinel is left alone. The database is `xrpl` (`xahau` on the other network).

```sql
-- the rows of the superseded sets, per table
ALTER TABLE xrpl.account_lines_daily DELETE WHERE (account, day, version) IN (
  SELECT r.account, r.day, r.version
  FROM (SELECT DISTINCT account, day, version FROM xrpl.account_lines_daily) AS r
  INNER JOIN (SELECT account, day, max(version) AS newest FROM xrpl.account_rollup_days GROUP BY account, day) AS s
    ON r.account = s.account AND r.day = s.day
  WHERE r.version < s.newest);
ALTER TABLE xrpl.account_tx_daily DELETE WHERE (account, day, version) IN (
  SELECT r.account, r.day, r.version
  FROM (SELECT DISTINCT account, day, version FROM xrpl.account_tx_daily) AS r
  INNER JOIN (SELECT account, day, max(version) AS newest FROM xrpl.account_rollup_days GROUP BY account, day) AS s
    ON r.account = s.account AND r.day = s.day
  WHERE r.version < s.newest);
ALTER TABLE xrpl.account_trades_daily DELETE WHERE (account, day, version) IN (
  SELECT r.account, r.day, r.version
  FROM (SELECT DISTINCT account, day, version FROM xrpl.account_trades_daily) AS r
  INNER JOIN (SELECT account, day, max(version) AS newest FROM xrpl.account_rollup_days GROUP BY account, day) AS s
    ON r.account = s.account AND r.day = s.day
  WHERE r.version < s.newest);
-- the superseded sentinels
ALTER TABLE xrpl.account_rollup_days DELETE WHERE (account, day, version) IN (
  SELECT r.account, r.day, r.version
  FROM xrpl.account_rollup_days AS r
  INNER JOIN (SELECT account, day, max(version) AS newest FROM xrpl.account_rollup_days GROUP BY account, day) AS s
    ON r.account = s.account AND r.day = s.day
  WHERE r.version < s.newest);

-- each is a mutation that returns at once; follow them here (no row left: all done)
SELECT table, command FROM system.mutations WHERE database = 'xrpl' AND table LIKE 'account_%' AND NOT is_done;
```

**Run it only when no rollup write is in flight**: no `range-ingest` is draining through `agg_dirty` and the aggregator's `account_rollups` job is not running (stop the syncer for the minutes it takes, or choose a quiet time), and preferably off-peak, because a request that picked an older sentinel just before a newer one landed can find the rows of that set deleted under it. The delete cannot be undone, but these tables are recomputable from the raw rows. No cleanup is shipped: nothing runs this for you.

### Stopped or broken aggregator

With the aggregator stopped, the Markets sets age (`end_time` says so, the age gauge alerts), new days are valued on read, and a heavy account's raw part grows by a day per day: slower, right. A `pair_hourly` gap leaves the previous Markets set in place. Nothing needs repairing by hand: restart it and the back-fills resume (their waits are in memory), newest first.

## Scaling

| Tier | How |
| --- | --- |
| API (read) | `dc up -d --scale api-xrpl=4 --scale api-xahau=2` (repeat the flags on every `up`; compose has no rolling update; nginx resolves the replicas per request through Docker DNS and uses all of them). The api is stateless apart from small in-memory caches. The rate limit is per replica (in memory), so the effective limit grows with the replica count. |
| Syncer | **Never.** One per network. It is network- and ClickHouse-bound, not CPU-bound. |
| ClickHouse | One server with one database per network. Scale it up first (RAM, disk); replication needs Keeper-backed `Replicated*` engines, see [clickhouse](clickhouse.md#high-availability-and-replication). |

The compose file keeps the ClickHouse memory limit at 8 GB: size it to your data (full XRPL history is roughly 1-1.5 TB
compressed, mostly `transactions`).

## Incident playbooks

### Probe returns 503 on the api

ClickHouse does not answer a ping. Is it up and reachable from the api's network (`dc exec api-xrpl node -e "fetch('http://clickhouse:8123/ping').then(r=>console.log(r.status))"`)? Memory or disk? The api itself is fine; it is the dependency.

### API 5xx spike

The body only says `unable to retrieve ...`; the cause is in the api log (`[RippleRoute]`/`[RippleError]` lines with the stack).
Most likely ClickHouse: a heavy query, memory pressure (`Memory limit exceeded`), timeouts (`GH_CLICKHOUSE_MAX_EXECUTION_TIME`).
Inspect `system.query_log` for slow and failed queries and `system.processes` for what runs now.

### API slow while the replicas are idle

The replicas wait for ClickHouse. Look at `system.processes`, `system.query_log` (`read_rows`, `memory_usage`), and `max_execution_time`
kills. Typical causes: a very active account on `/reports` or `/stats/value`, a `/v2/stats` over the full history before the rollup
caught up, `FINAL` added to a list query by a code change ([ADR-0003](adr/0003-no-final-on-list-queries.md)), or a list query that
reads its page with `LIMIT 1 BY` in the same SELECT as the table, which reads most of the range
([clickhouse](clickhouse.md#reading-a-page-what-stops-the-read)): one page should read about a granule per part.

### Many 401s after a deploy

`GH_API_KEYS` changed or the env file did not reach the container. The api refuses to boot without keys in production, so a running
api has keys; compare the key clients send with `dc exec api-xrpl printenv GH_API_KEYS` only on a trusted terminal.

### Every client gets 429

The rate limiter sees one client address: the proxy chain is misconfigured. `TRUSTED_PROXIES` must contain your front proxy so nginx
recovers the real client; `GH_TRUST_PROXY_HOPS` stays 1. See [troubleshooting](troubleshooting.md#every-client-shares-one-rate-limit-bucket).

### ClickHouse "too many parts"

Something inserts too often in small batches. The syncer batches (300 ledgers / 100,000 transactions / 5 s in catch-up, one commit
per ledger live), so look for an external writer. Let merges catch up; `OPTIMIZE` if needed.

### Schema migration failed

The migrate job is idempotent: fix the cause and rerun it. A statement that genuinely failed (bad DDL in a new file): fix the file
*before* it was ever applied successfully; applied files are never re-run, and an edited applied file is rejected by checksum.
`Migration ... was modified after being applied` means someone edited history: restore the file and add a new migration.

### Old local ClickHouse volume

A volume created by the previous stack (the one before the per-network rewrite) carries the replaced baseline schema and old `schema_migrations` rows.
For local development recreate it: `docker compose down -v`, then migrate again. Do not do this on a database you care about.

## Backup and restore

See [clickhouse](clickhouse.md#backups). Two layers: real backups (`clickhouse-backup` or snapshots) for a fast restore, and the
ledger itself as the ultimate source (re-ingest with `range-ingest`). **Test restores regularly.**

## Known gotchas

Collected in [troubleshooting](troubleshooting.md): slim-image healthchecks need `node fetch` (no wget), the syncer's port opens only
after its node connects, mounting ClickHouse `config.d` shadows `listen_host`, Keeper healthcheck flags, `pnpm deploy --legacy`.
