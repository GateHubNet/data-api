# Task 10 report: the compose files and the sandbox env file

Status: DONE (one flag, see Concerns).
Commit: `1606203 build: the sandbox is the production compose file with deploy/.env.sandbox`

## What I implemented

- `docker-compose.prod.yaml` and `docker-compose.yaml`:
  - `GH_NETWORK: ${XRPL_NETWORK:-xrpl}` on `migrate-xrpl`, `syncer-xrpl`, `api-xrpl`, `exporter-xrpl`; `${XAHAU_NETWORK:-xahau}` on the Xahau four. A header
    paragraph in each file and a comment at each slot's divider say the slot serves its family (nginx routes `xrpl.data.*` / `xahau.data.*` to it), that a
    name of the other family would serve the wrong protocol on the host, and that every app logs its network at boot.
  - `GH_CLICKHOUSE_DATABASE` removed from the prod file (the dev file never set it): the profile's `defaultDatabase`.
  - `GH_NODE_ENDPOINTS: ${XRPL_NODE_ENDPOINTS:-}` / `${XAHAU_NODE_ENDPOINTS:-}` on syncers and apis (blank is the profile's default).
  - `GH_UNL_PUBLISHERS: ${XRPL_UNL_PUBLISHERS:-default}` / `${XAHAU_UNL_PUBLISHERS:-default}`; new `GH_UNL_VALIDATORS: ${XRPL_UNL_VALIDATORS:-default}` /
    `${XAHAU_UNL_VALIDATORS:-default}` on the syncers.
  - The sandbox commands are in the prod file's header.
- `deploy/.env.sandbox.example` (new): the production example's variables with `XRPL_NETWORK=xrpl-testnet`, `XAHAU_NETWORK=xahau-testnet`, empty endpoint, publisher and
  validator variables (with comments naming the defaults), **both validation endpoint variables empty (ruling P5)**, empty start ledgers, `GH_EXPORT_BUCKET=` (exports
  off), the sandbox explorer's key (`change-me-sandbox-explorer-key`) in `GH_API_KEYS` and `GH_RATE_LIMIT_KEYS` (`=6000`), and a head comment with §10's two commands.
- `deploy/.env.prod.example`: commented `# XRPL_NETWORK=xrpl` / `# XAHAU_NETWORK=xahau`; the publisher comment says empty is `default`; `XRPL_UNL_VALIDATORS=` /
  `XAHAU_UNL_VALIDATORS=` rows (empty = `default`, so the template still lists every variable); header and threshold comments no longer mention
  `GH_CLICKHOUSE_DATABASE` or "publisher count".
- `apps/*/.env.example`: the `GH_NETWORK` comments list the four names and CTID ids, the node-endpoint comments the testnet defaults, the database comment the four databases.
- `deploy/nginx/nginx.conf.template`: only the comment above the map (sandbox hosts and databases).
- `apps/syncer/src/config/syncer.config.spec.ts`: `it('resolves the sandbox compose values')` (both testnets; `GH_NODE_ENDPOINTS=''`, `GH_VALIDATION_ENDPOINTS=''`,
  `default` lists, `GH_UNL_THRESHOLD=0`: endpoints = the testnet defaults for node and validation, `unlPublishersOf` `[]` / `vl.altnet.rippletest.net`,
  `unlValidatorsOf` the four keys / none, `unlThresholdOf` 1). It passes already, as the brief says.
- `docs/configuration.md`: §7 rows `XRPL_NETWORK` / `XAHAU_NETWORK`, `*_NODE_ENDPOINTS`, `*_VALIDATION_ENDPOINTS`, `*_UNL_PUBLISHERS` (blank and `default` spellings), new
  `*_UNL_VALIDATORS`; "Which service gets which variables": no `GH_CLICKHOUSE_DATABASE` anywhere, `GH_UNL_VALIDATORS` to the syncers, a paragraph on why; the
  `GH_CLICKHOUSE_DATABASE` default in §3.
- `docs/deployment.md`: new "Environments" section (production and sandbox table, hosts, one host and ClickHouse server each, the sandbox commands, API keys, indexing from the
  head, exports off without a bucket of its own, certificates `*.data.gatehub.net` + `*.data.sandbox.gatehub.net` or the four names because `*.gatehub.net` covers none), the
  topology diagram's note, the UNL publisher hosts to allow outbound, the `.env.sandbox` paragraph, and a "testnet locally" bullet for the dev stack.
- `docs/operations.md` (controller ruling, Task 9's review): see below.

## Controller rulings

- **P4:** my `show` passes all four profiles (`--profile full --profile xahau --profile exports --profile xahau-exports`); it works for both compose files (the prod file only
  has `exports`; unused profiles are accepted).
- **P5:** the sandbox file blanks `XRPL_VALIDATION_ENDPOINTS` and `XAHAU_VALIDATION_ENDPOINTS`, with a comment that GateHub sets testnet endpoints there when needed.
- **Runbook (Task 9 review):** checked against what I built. `<slot>` = `xrpl` / `xahau` is now true: the `*-xrpl` services run `xrpl-testnet`, the `*-xahau` ones `xahau-testnet`,
  in the databases `xrpl_testnet` / `xahau_testnet` (no `GH_CLICKHOUSE_DATABASE` from compose). "A plain `dc up -d` would also scale the apis back to 1" is true (no
  `deploy.replicas`, scale 1), but step 4 was incomplete: naming `api-<slot>` without `--scale` also resets *that* api to 1 replica. Step 4 is now
  `dc up -d --scale api-<slot>=<n> syncer-<slot> api-<slot>`. The `dc()` helper hard-wired `deploy/.env.prod`; the intro now gives the sandbox's
  (`--env-file deploy/.env.sandbox`) and says to read the services as slots, and the runbook says to run on the sandbox host with that `dc`.
  `dc stop syncer-xrpl api-xrpl exporter-xrpl` with the `exports` profile inactive was checked with `docker compose --dry-run stop`: no error.

## Tests and results

RED (Step 2, before the implementation; `show` = the brief's function with the four profiles and, for the evidence, `GH_VALIDATION_ENDPOINTS` added to the keys):

```
$ docker compose -f docker-compose.prod.yaml --env-file deploy/.env.sandbox.example config
couldn't find env file: .../deploy/.env.sandbox.example                      <- sandbox file missing: fails as expected
$ show docker-compose.prod.yaml deploy/.env.prod.example
syncer-xrpl GH_NETWORK="xrpl" GH_CLICKHOUSE_DATABASE="xrpl" GH_NODE_ENDPOINTS="wss://s2.ripple.com,wss://xrplcluster.com" ... GH_UNL_PUBLISHERS="https://vl.ripple.com=ED2677...,https://unl.xrplf.org=ED42AE..." GH_UNL_VALIDATORS=-
api-xrpl    GH_NETWORK="xrpl" GH_CLICKHOUSE_DATABASE="xrpl" ...
```

GREEN (after; every line is `<service> GH_NETWORK=... GH_CLICKHOUSE_DATABASE=... GH_NODE_ENDPOINTS=... GH_VALIDATION_ENDPOINTS=... GH_UNL_PUBLISHERS=... GH_UNL_VALIDATORS=...`):

```
sandbox file x docker-compose.prod.yaml   (docker-compose.yaml prints the same)
api-xahau       GH_NETWORK="xahau-testnet" GH_CLICKHOUSE_DATABASE=- GH_NODE_ENDPOINTS=""
api-xrpl        GH_NETWORK="xrpl-testnet"  GH_CLICKHOUSE_DATABASE=- GH_NODE_ENDPOINTS=""
exporter-xahau  GH_NETWORK="xahau-testnet" GH_CLICKHOUSE_DATABASE=-          exporter-xrpl GH_NETWORK="xrpl-testnet" GH_CLICKHOUSE_DATABASE=-
migrate-xahau   GH_NETWORK="xahau-testnet" GH_CLICKHOUSE_DATABASE=-          migrate-xrpl  GH_NETWORK="xrpl-testnet" GH_CLICKHOUSE_DATABASE=-
syncer-xahau    GH_NETWORK="xahau-testnet" GH_CLICKHOUSE_DATABASE=- GH_NODE_ENDPOINTS="" GH_VALIDATION_ENDPOINTS="" GH_UNL_PUBLISHERS="default" GH_UNL_VALIDATORS="default"
syncer-xrpl     GH_NETWORK="xrpl-testnet"  GH_CLICKHOUSE_DATABASE=- GH_NODE_ENDPOINTS="" GH_VALIDATION_ENDPOINTS="" GH_UNL_PUBLISHERS="default" GH_UNL_VALIDATORS="default"
production example x docker-compose.prod.yaml
api-xrpl GH_NETWORK="xrpl" ... GH_NODE_ENDPOINTS="wss://s2.ripple.com,wss://xrplcluster.com"      api-xahau GH_NETWORK="xahau" ... "wss://xahau.network"
syncer-xrpl GH_NETWORK="xrpl" GH_CLICKHOUSE_DATABASE=- ... GH_VALIDATION_ENDPOINTS="wss://s1.ripple.com,wss://s2.ripple.com" GH_UNL_PUBLISHERS="default" GH_UNL_VALIDATORS="default"
syncer-xahau GH_NETWORK="xahau" GH_CLICKHOUSE_DATABASE=- ... GH_UNL_PUBLISHERS="default" GH_UNL_VALIDATORS="default"
```

Extra evidence that mainnet does not change:

1. A diff of the whole resolved environment of every service, old compose vs new, for the production example and for a minimal env file (defaults), both compose files:
   the only differences are `GH_CLICKHOUSE_DATABASE` removed, `GH_UNL_PUBLISHERS` spelled `default` instead of the text, `GH_UNL_VALIDATORS=default` added, and, with
   no endpoints in the env file, `GH_NODE_ENDPOINTS=""` instead of the same default text.
2. I ran the **real compiled config classes** (`loadSyncerConfig`, `loadApiConfig`, `clickHouseConfigFromEnv`) on the environment compose resolves for each service
   (`NODE_ENV=production`, `GH_ENV=container`): sandbox file gives `xrpl-testnet` / `xahau-testnet`, databases `xrpl_testnet` / `xahau_testnet`, the testnet endpoints for node
   and validation, `unlPublishers` the altnet one / none, `unlValidators` none / the four keys, `exportBucket` empty; the production example gives `xrpl` / `xahau`,
   `xrpl` / `xahau`, the example's endpoints, the mainnet publishers, no validators, exactly as before. (The exporters refuse the empty bucket in both, which is the
   documented "exports off".)

Suite (from the worktree root):

- `pnpm build` rc 0.
- `pnpm test` rc 0: shared 1682, exporter 12, api 1854, syncer 1337 tests passed.
- `pnpm --filter @gatehub/data-syncer test:e2e` rc 0: 13 suites, 344 tests passed (the package I touched; shared and service not touched).
- `prettier --check` on my spec: clean. `pnpm format` also rewrote the three known unrelated files; I put them back with `git checkout -- <the three files>`, and nothing of them is in the commit.
- The new case alone: `NODE_ENV=test pnpm exec jest --config ./jest-config.json src/config/syncer.config.spec.ts -t "resolves the sandbox compose values"` passes (and it passed before
  the compose change, as the brief says: it pins the syncer's side, the compose check pins the other).

## Files changed

`docker-compose.prod.yaml`, `docker-compose.yaml`, `deploy/.env.sandbox.example` (new), `deploy/.env.prod.example`, `deploy/nginx/nginx.conf.template` (comment only),
`apps/api/.env.example`, `apps/syncer/.env.example`, `apps/exporter/.env.example`, `apps/syncer/src/config/syncer.config.spec.ts`, `docs/configuration.md`,
`docs/deployment.md`, `docs/operations.md`.

## Self-review

- Completeness against the brief: every file of the list, the interface bullets, Step 4's expectations, and the three rulings.
- The dev compose never set `GH_CLICKHOUSE_DATABASE`, so only `GH_NETWORK`, the endpoints and the lists changed there.
- Compose precedence: a shell variable beats `--env-file`, so a developer with `XRPL_NODE_ENDPOINTS` (mainnet) exported and `XRPL_NETWORK=xrpl-testnet` gets a boot refusal naming
  `GH_NETWORK`: the desired failure, and the docs say to leave the endpoints unset.
- YAGNI: no new compose variable beyond `XRPL_NETWORK`, `XAHAU_NETWORK`, `XRPL_UNL_VALIDATORS`, `XAHAU_UNL_VALIDATORS`; no change to nginx beyond its comment.

## Concerns / things to know

1. **Deviations the brief did not spell out (small):**
   - `GH_CORS_ORIGINS` is empty in the sandbox file (the production example's `https://app.gatehub.net` is a production origin; the explorer calls the API from its
     Worker with a key, so no CORS is needed). The owner may list a browser origin there.
   - `GH_RATE_LIMIT_KEYS=change-me-sandbox-explorer-key=6000`: 6000 is the budget the production example already suggests for the exporter's key; the owner sizes it.
   - I added `XRPL_UNL_VALIDATORS=` / `XAHAU_UNL_VALIDATORS=` to the production example too (empty = `default`, no behaviour change) so the template lists every compose variable.
   - Also edited: `docs/operations.md` (not in the brief's list; by the Task 9 review ruling), the `GH_CLICKHOUSE_DATABASE` row of `docs/configuration.md` §3, the `.env.example` database
     comments, and the publisher outbound-hosts line of `docs/deployment.md`.
2. The decision numbering "D3"/"D14" collides with the sub-project D3 (NFTs) in prose; in the docs I wrote "decision 3 of the testnet design". The commit body keeps the brief's "(D3)".
3. Not checked, because it needs a host: a real `up -d --build` of the sandbox (the image build needs `NPM_TOKEN`; a `--dry-run up` tries to build and was stopped). The compose
   resolution and the config classes were checked as above.
