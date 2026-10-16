# Task 38: end-to-end verification of the Ripple drop-in on XRPL and Xahau

Run of 2026-10-16 (16:08 to 18:10 UTC) on branch `feat/ripple-dropin`, base commit `2975ea9`, by the Task 38 verifier.
Everything below was observed, not assumed; the files behind each number are under the scratch folder
`/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/verify/`
(logs in `logs/`, every API response in `smoke/<network>/`) and the harness scripts are kept in
`.superpowers/sdd/2026-10-15-ripple-dropin/task-38-harness/` (git-ignored). The API key of the run is a random throwaway and is written `$KEY`.

## 0. Verdict

**DONE_WITH_CONCERNS.** The product works end to end on both networks and the API contract held on every call that could be made
(XRPL: 171 pass, 0 fail; Xahau: 169 pass, 0 fail), but the run found two real defects that block or distort **Xahau** (F1, F2), a family
of rate-limit problems that make the documented first run fail against the default public nodes (F3 to F5), and a handful of doc/contract
mismatches. Nothing was fixed in product code, as instructed. The only repo changes are this report, `packages/shared/config/markets/xahau.json`
(version 2) and the three one-line doc corrections that the new file made false (section 9).

| Area | Result |
| --- | --- |
| Step 1 unit tests | **1873 pass / 0 fail** (79 suites: shared 564, syncer 340, api 969) |
| Step 1 e2e tests | **2051 pass / 0 fail** (38 suites: shared 332, syncer 145, api 1574), 5 m 33 s |
| Step 2 sync to lag <= 1 | XRPL 7 m 10 s wall (2 m 37 s of it on the node that did not throttle); Xahau 18 m 18 s (clean run), both inside the 30-minute cap, **but only after changing the node/concurrency settings** (F3) and, for Xahau, a scratch workaround for F1 |
| Step 3 crash test (XRPL) | `kill -9` mid-catch-up with an INSERT in flight: **span = count = 1, count = uniqExact = 1**; plus 3 more live-mode kills and a ClickHouse outage: all invariants held every time |
| Step 4 endpoint sweep | XRPL **171 pass, 0 fail**; Xahau **169 pass, 0 fail** (every endpoint of the contract table: json + csv + 2-page marker walk + bad param + 401; 16 checks n/a by contract, 3 to 5 not run for lack of data in the window) |
| Step 5 spot checks | `/balances` and `/orders` equal the node; 112 of 112 `binary=true` blobs re-hash on XRPL; ledger transaction trees re-hash on XRPL; **Xahau UNLReport does not (F2)** |
| Step 6 | `xahau.json` version 2 written from a sample (2 trade markets, 4 payment currencies); validated by booting the aggregator; **one unit test now needs a one-line update (F12)** |
| BLOCKED | clean `pnpm install` and the docker image builds / full container stack (no `NPM_TOKEN`, which this task must not touch) |

## 1. Findings

Severity: HIGH = wrong or blocking behaviour of the product, MEDIUM = breaks the documented happy path or operability, LOW = doc/contract
mismatch, INFO = observation. Each finding gives the request, what was expected and what happened.

### F1 (HIGH) Xahau: a ledger with an `UNLReport` pseudo-transaction cannot be ingested, and the live syncer stalls on it silently

- Where: `packages/shared/src/ingest/build-rows.ts`, `senderOf()` (throws when `tx.Account` is `''`); its comment says "Every transaction, pseudo-transactions included, has one".
- Reproduce: `GH_NETWORK=xahau GH_SYNC_START_LEDGER=26570622 node apps/syncer/dist/main.js` against `wss://xahau.network` (any start below ledger 26570752). `range-ingest` calls the same `buildLedgerRows`, so it stops at the same ledger (not run without the workaround below).
- Expected: Xahau pseudo-transactions are stored like the XRPL ones (those carry `rrrrrrrrrrrrrrrrrrrrrhoLvTp`).
- Actual: Xahau's `UNLReport` has `"Account": ""` (node answer for tx `0A6ECA79C5DB7B114E0620C380F7C146E383F6753035933DF8EBD3E2B72EF8CA`, ledger 26570752, binary `... 73 00 81 00 ...`: an empty AccountID).
  `Error: Ledger 26570752: transaction 0A6ECA79... has no Account`. Every flag ledger (sequence divisible by 256) of Xahau carries one `UNLReport` per active validator
  (22 in each of the 4 flag ledgers of the run), so **no Xahau ingest can pass a flag ledger**.
- Aggravating: the live runner treats this deterministic parse error like a failed write. It "recovers" and re-fetches forever
  (`Writing ledgers 26570622-26570847 failed ... Recovered: continuing after ledger 26570621`, again with 26570863, 26570873, ...). The
  valid prefix (26570622..26570751, 130 good ledgers) is never committed, the probe stays `200 state=catching_up` with a lag that only grows (503 only after 60 s
  above `GH_MAX_LAG_HEALTHY`), no `error`/`halted` is shown, and `docs/syncer.md` only promises a halt for chain breaks. (Log: `logs/syncer-xahau.attempt1-ratelimit-unlreport.log`.)
- Workaround used for the rest of the run (verification only, no file in the repo changed): `workaround-unlreport.js`, a `node --require` preload that rewrites `senderOf` in memory so
  an empty Account becomes the zero account. Everything Xahau below ran with it (live syncer and range ingest).

### F2 (HIGH) Xahau: `binary=true` of an `UNLReport` does not re-hash, so every flag ledger's transaction tree is wrong

- Request: `GET /v2/transactions/1894BD0CC34AB227F86B3F90198D81F873C408161724D3239D0D0121B4810B9C?binary=true` (ledger 26571264); the same inside `GET /v2/ledgers/26571264?binary=true`, `/v2/transactions?binary=true`.
- Expected (docs/api-reference.md, Transactions): "The `binary=true` hex is the serialization itself and re-hashes to the transaction hash (the transactions of a ledger re-hash to its `transaction_hash`)".
- Actual: the served blob has the account as 20 zero bytes (`... 73 00 81 14 00 x20 E0 5F ...`); the ledger's own blob (`ledger` with `binary:true` on the node) has an empty AccountID
  (`... 73 00 81 00 E0 5F ...`). SHA-512Half of `TXN\0 + blob` is therefore not the transaction hash. In each of ledgers 26570752, 26571008, 26571264 (the flag ledgers) 22 tx blobs do not
  re-hash and the rebuilt tx-tree root differs from `transaction_hash`; all other Xahau ledgers tested are equal. The JSON form shows `tx.Account: "rrrrrrrrrrrrrrrrrrrrrhoLvTp"` where the node says `""`.
- Cause (checked with the repo's `ripple-binary-codec` 2.11.0 and the bundled `config/definitions/xahau.json`): `decode(<node blob>)` gives `Account: rrrrrrrrrrrrrrrrrrrrrhoLvTp`, and `encode` of either `""` or that address gives `8114 + 20 zero bytes`, never `8100`; the API serves `encode(stored JSON)`, so the round trip is not the identity for this input.
  Serving the node's original blob (or special-casing the empty AccountID) would fix it. Not fixed here.

### F3 (MEDIUM) The default public endpoints throttle the documented first run; the syncer's retry ignores the node's hint

- Request: the README/`.env.example` flow: `GH_SYNC_START_LEDGER = head - 500`, defaults (`GH_CATCHUP_CONCURRENCY=8`, `wss://xrplcluster.com`, `wss://xahau.network`).
- Expected: lag <= 1 within the cap.
- Actual, with the node text verbatim:
  - `wss://xrplcluster.com`: `rate limit: units quota (10000 per 60s) exhausted, retry in ~109117ms` 4 s after the restart that followed the crash (17 + 5 ledgers committed by then; the XRPL syncer log holds 88 rate-limit lines). The syncer
    retried every 0.5 s doubling to 30 s (and `NodeClient` connection attempts were rejected too: `Cannot connect to wss://xrplcluster.com: rate limit ... retry in ~65304ms`), so the block was still active 2 minutes later. I stopped the syncer twice (rule: stop when rate limited) and
    switched the XRPL syncer to `wss://s2.ripple.com` (the full-history server the repo's docs recommend) at `GH_CATCHUP_CONCURRENCY=2`: 495 ledgers in 2 m 37 s, never limited.
  - `wss://xahau.network` and `wss://xahau.org`: `rate limit: units quota (50000 per 10s) exhausted, retry in ~12376ms` at concurrency 8 and again at 1 and 2 (507 rejections in the Xahau syncer logs, 455 in the range-ingest logs); a Xahau ledger is ~260 KB (38 txs).
    Later also a second tier: `rate limit: units quota (10000000 per 3600s) exhausted, retry in ~929624ms`, reached at 17:42 UTC after roughly an hour of one syncer plus a 3,300-ledger sample (section 8). From then on even `server_info` was refused for ~15 minutes.
- The syncer/NodeClient/range-ingest do not read the `retry in ~N ms` hint, so they keep knocking at the capped backoff of 30 s; three attempts of a `range-ingest` chunk are over in 1.5 s.
- Practical result: on `xrplcluster.com` the syncer made 22 ledgers of progress in the 4 minutes it was allowed to run and was then refused (I did not wait for the block to clear); Xahau reached lag <= 1 only at concurrency 1, and its throughput came and went (3 ledgers per 10 s for 14 minutes, then about 10 per second).

### F4 (MEDIUM) A rate-limited node kills the boot, and workers that do not need the node still need it to boot

- `xahau.org`: `ERROR [ExceptionHandler] rate limit: units quota (50000 per 10s) exhausted ... RippledError` right after `Connected`, process exit (the boot network check, `server_info`, got the rate-limit answer and it is not retried).
- `GH_WORKERS=aggregator node dist/main.js` (no ingest, no node use) died the same way while the node was refusing: the aggregator and the probe only need ClickHouse, yet the boot is gated on the node.
- Expected: retry the check with backoff (as the runner does for ledgers), or skip it for workers that do not use the node.

### F5 (MEDIUM) `range-ingest` makes no progress against a throttled node, and a changed `--chunk` leaves intents that are redone forever

- Request: `pnpm --filter @gatehub/data-syncer ingest:range --from 26549127 --to 26570726 --concurrency 3 --chunk 500` (as `docs/backfill.md` does, smaller concurrency, chunk 500 instead of 1000).
- Actual: chunk 1 (373 ledgers) done in 12 s, chunk `[26549500,26549999]` failed on all 3 attempts (`rate limit ... retry in ~8776ms`) and **failed the same way on 5 consecutive runs** (a rerun starts the chunk from scratch; the 500 ledgers need more units than one 10-second window).
  Only `--chunk 100` makes progress (about 100 ledgers per run, 30 s per run with a 12 s pause).
- Changing `--chunk` between runs: the 500-wide intent `[26549500,26549999]` stayed `started` and each new run (chunk 100) printed `N unfinished intents ... will be redone` and **rewrote `[26549500,26549599]` again every time** (committed rows deleted and written 6 times)
  until I closed the stale rows by hand (`INSERT INTO xahau.ingest_log ... 'done'`). The docs do not mention that the chunk size must stay the same across reruns.
- The docs do say public clusters throttle a large sweep (`docs/backfill.md`); they do not say what a chunk size must be for that to work.

### F6 (LOW) The probe's 503 body is not the one the docs describe

- Request: `GET /liveliness/healthz` on the syncer while catching up (lag 400 for > 60 s) and on both services with ClickHouse stopped.
- Expected: `docs/observability.md` ("503 with `status: error` and `error: { clickhouse: { status: down } }`") and `docs/operations.md` ("The body shows `state`, `lag`, `last_commit_age`").
- Actual (all three cases): `503 {"error":{"key":"SERVICEUNAVAILABLEEXCEPTION","message":"Service Unavailable Exception"}}`. The detailed body exists only on 200.

### F7 (LOW) `GET /` is not Ripple-shaped

- `docs/api-reference.md` ("Out of scope"): `GET /` and `GET /v2` answer `404 {"result":"error","message":"Cannot GET ..."}`. `GET /v2` does; `GET /` answers `404 {"error":{"key":"NOTFOUNDEXCEPTION","message":"Cannot GET /"}}`.

### F8 (LOW, docs) The self-check snippet at the end of `docs/configuration.md` fails from the repo root

- `node -e "require('reflect-metadata'); ..."` run in the repo root: `Error: Cannot find module 'reflect-metadata'` (the root `node_modules` only holds prettier/typescript; `reflect-metadata` is in `apps/api/node_modules`).
  Run from `apps/api` with `require('./dist/config/api.config.js')` and `require('../syncer/dist/config/syncer.config.js')` it works and its output matches the documented tables (api 12 names, syncer 14 names, nothing missing).

### F9 (LOW, compose) The dev compose cannot be run next to another stack, `-p` does not help

- `docker compose -p dropin-verify up -d clickhouse` with the documented command:
  `Error response from daemon: Conflict. The container name "/data-api-clickhouse" is already in use`. `docker-compose.yaml` pins `container_name: data-api-clickhouse` and host ports `8123`/`9000`; `docker-compose.prod.yaml` pins `ch-keeper`, `ch-server`, `data-syncer-xrpl`, `data-syncer-xahau`
  (the user's host has a stopped `ch-keeper` and `data-api-clickhouse` from the old stack). I used an override file (container name and ports replaced with `!override`) so nothing of the user's was touched.

### F10 (LOW) `ledger_interval` of a partial hour

- `GET /v2/stats?interval=hour`: the first hour of the XRPL database (204 ledgers over 13 minutes) reads `ledger_interval: 17.608`. The code computes (last close - bucket start) / ledgers, which is right for a full hour and an hour in progress, but the docs say "average seconds between ledgers". Only the first, partial hour of a database is affected.

### F11 (INFO) Other observations

- `Content-Disposition: attachment; filename=payments - MAG rXmag....csv`: the file name has spaces and is not quoted (matches the docs, not RFC 6266).
- `Link` uses the request `Host` (`http://localhost:13001/...`), and `https` when `X-Forwarded-Proto: https` is sent from a trusted hop (works).
- Validations are only collected while the syncer runs: ledgers closed during the crash/restart gaps hold fewer validations (for example 52 instead of ~105 validators), as documented.
- `LedgerNotAvailableError` (`lgrNotFound`) came back intermittently from `wss://xahau.network` for ledgers it holds (cluster members with different history); the live runner retries it, `range-ingest` would treat it as permanent.
- A failed `range-ingest` chunk leaves `started` intents (33 after the sample run) and no orphan rows: `transactions`, `payments`, `exchanges`, `ledger_by_hash` rows without a `ledgers` row: 0, duplicates: 0.
- The Xahau DEX is thin: 5 trades in about 3,770 sampled ledgers (section 8).

### F12 (TEST) One unit test now fails because `xahau.json` is populated (Step 6 consequence)

- `packages/shared/src/network/network-profile.spec.ts`, `loadMarketsConfig › loads the bundled xahau markets (empty until populated)` expects `{version: 1, tradeMarkets: [], paymentCurrencies: []}`.
  Run after the file change: the shared package has **563 pass, 1 fail**; syncer 340/340 and api 969/969 still pass; the e2e specs build their own empty config and do not read the shipped file.
  Per the dispatch (commit only the report, `xahau.json` and doc corrections) the test was **not** edited. It needs a one-line update, e.g. `expect(markets.version).toBe(2)` with the two markets and four currencies of section 8.

## 2. Doc steps that were wrong or needed a deviation

| Doc | Step | What happened |
| --- | --- | --- |
| README quickstart, `docker-compose.yaml` | `docker compose up -d clickhouse` | Fails when another container is called `data-api-clickhouse`; fixed host ports; see F9 |
| README / `docs/syncer.md` | start the syncer, "reaches live" | Does not reach live on the default public endpoints, see F3 |
| `docs/backfill.md`, `docs/syncer.md` §4 | `ingest:range ... --chunk` (default 1000) | A chunk that cannot be fetched in one quota window never completes; changing the chunk leaves redone intents, see F5 |
| `docs/configuration.md` "Keeping this page true" | run the snippet | Fails from the repo root, F8 |
| `docs/operations.md`, `docs/observability.md` | probe body | 503 body differs, F6 |
| `docs/api-reference.md` "Out of scope" | `GET /` | Not Ripple-shaped, F7 |
| `docs/syncer.md`, `docs/api-reference.md`, ADR-0009 | "the shipped Xahau list is empty" | True before this task, false after: corrected (section 9) |
| `docs/deployment.md` Build | "Without the secret the build stops with `secret npm_token: not found` (an empty secret: `the npm_token secret is empty`)" | Correct for a build with **no** `--secret` flag. With `--secret id=npm_token,env=NPM_TOKEN` and `NPM_TOKEN` unset the message is the "empty" one (checked both) |
| `docs/configuration.md` §1 | "refuses to start when [the env file] is missing" | Correct: `Error: Env file not found: .env` (checked for syncer and api from a scratch cwd with no `GH_ENV`) |
| README | `GH_ENV=local pnpm --filter @gatehub/data-syncer ingest:range --from --to` | Correct (used as written; no env file needed) |

Verified as written: `pnpm build`, `pnpm test`, `pnpm -r test:e2e`, `GH_NETWORK=<n> pnpm ch:migrate` (both networks, idempotent), `docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod.example config` (parses; with the two required secrets unset it refuses with the documented messages),
the lease refusal (`Another syncer holds the lease` on an immediate restart after `kill -9`, takeover 39 s later with `Taking over the lease ..., whose last heartbeat is 39 s old`), the SQL health checks of `docs/operations.md`, the 429 text and headers, the 401 text, the OpenAPI copy
(`docs/openapi.yaml` paths and parameters are deep-equal to the live `/internal/docs-json`, 38 paths).

## 3. BLOCKED / not verified

- `pnpm install` from a clean checkout and `docker compose ... build` / `up` of the image-based stack (migrate-*, syncer-*, api-*, nginx): need `NPM_TOKEN` for the private `@gatehub/toolbox`; this task must not read or use npm credentials.
  `pnpm install` ran against the existing `node_modules` ("Already up to date", 0.7 s). What was checked without a token: both Dockerfiles stop at the secret step with the documented messages, and the compose files parse.
  Nothing built means nothing of the nginx template, the non-root user, `/healthz` of nginx, `TRUSTED_PROXIES` or the container healthchecks was exercised.
- The apps were run from the compiled `dist` (`node dist/main.js`) with explicit environment, not through `pnpm start:syncer` (`nest start --watch`) and not from `apps/*/.env` files (not touched, as ordered).
- A full-history XRPL backfill, and any Xahau window larger than the ~3,770 sampled ledgers.
- `/v2/network/*_volume` paging (historical rows exist for closed days only; the synced windows have none or only sampled ones) and 2-page walks of `acct stats`/`reports` (one row per active UTC day); the marker mechanism is covered by the e2e suites.
- `wss://xrplcluster.com` was only used for the first minutes of the syncer, for `/balances`, `/orders` and the spot checks; the XRPL syncer ran on `wss://s2.ripple.com` (F3).

## 4. Step 1: the suite

```
pnpm install                      # Lockfile is up to date ... Already up to date (0.7 s)
pnpm build                        # shared, syncer, api: exit 0 (2.8 s, incremental)
pnpm test                         # exit 0, 19.5 s
pnpm -r test:e2e                  # exit 0, 5 m 33 s (testcontainers: real ClickHouse 26.8.14.3)
```

| Package | unit suites / tests | e2e suites / tests |
| --- | --- | --- |
| `packages/shared` | 21 / 564 | 6 / 332 |
| `apps/syncer` | 15 / 340 | 8 / 145 |
| `apps/api` | 43 / 969 | 24 / 1574 |
| **total** | **79 / 1873** | **38 / 2051** |

No test failed, so none was re-run. After `xahau.json` was populated (Step 6) the shared unit run is 563/564 (F12).

## 5. Steps 2 and 3: stack, sync, crash test

Stack (isolated project `dropin-verify`, ports not used by running containers; the user's containers were never touched):

```
docker compose -p dropin-verify -f docker-compose.yaml -f <scratch>/compose.override.yaml up -d clickhouse
   # override: container_name dropin-verify-clickhouse, ports 127.0.0.1:18123->8123 and 19000->9000 (!override), restart 'no'
set -a; . <scratch>/env/common.env; set +a      # GH_ENV=local GH_CLICKHOUSE_URL=http://127.0.0.1:18123 (no secrets; the real .env files were not read)
GH_NETWORK=xrpl  pnpm ch:migrate                # [migrate] db="xrpl"  applied=1 skipped=0
GH_NETWORK=xahau pnpm ch:migrate                # [migrate] db="xahau" applied=1 skipped=0   (24 tables each)
```

Syncers: `node apps/syncer/dist/main.js` with `GH_NETWORK`, `GH_SYNC_START_LEDGER` = validated head - 500, probes on 13002 (XRPL) / 13012 (Xahau), metrics 13000 / 13010. Start ledgers: XRPL 107698007 (head 107698507), Xahau 26570727 (head 26571227).

### XRPL timeline (UTC)

| Time | Event |
| --- | --- |
| 16:19:17 | first start (`xrplcluster.com`, concurrency 4) |
| 16:19:35 | **`kill -9`** (pid 14708) with an INSERT in flight, 17 ledgers committed (107698007..107698023) |
| | state before restart: `ledgers` 17, `transactions` rows up to ledger **107698027** (4 ledgers of orphan child rows), `ingest_log`: live intent `started` then `done`, lease held by the dead pid |
| 16:19:52 | immediate restart refused: `Another syncer holds the lease (...:14708:...)`, exit |
| 16:20:06 | restart after the 30 s lease TTL: `Taking over the lease ... whose last heartbeat is 39 s old`; `Committed ledgers 107698024-107698028` |
| 16:20:10 / 16:22:20 | rate limited by `xrplcluster.com` (F3), stopped 16:20:33 and 16:23:25 |
| 16:23:50 | restart on `wss://s2.ripple.com`, concurrency 2: 495 ledgers behind |
| **16:26:27** | live (first single-ledger commit); lag 0-1 from then on. Total from first start: **7 m 10 s**; on s2: **2 m 37 s** |

Crash-test checks (R92: run after recovery; again after the sync, section "Later"):

```
SELECT max(ledger_index)-min(ledger_index)+1 = count() FROM xrpl.ledgers;                       -- 1  (22 ledgers right after recovery, 807 after sync)
SELECT count() = uniqExact(ledger_index, tx_index) FROM xrpl.transactions;                       -- 1  (1861 rows, 129,577 after sync)
SELECT count() = 0 FROM xrpl.transactions WHERE ledger_index > (SELECT max(ledger_index) FROM xrpl.ledgers);   -- 1  (the 4 orphan ledgers were deleted by recovery)
SELECT (SELECT sum(tx_count) FROM xrpl.ledgers) = (SELECT count() FROM xrpl.transactions);       -- 1
SELECT (SELECT count() FROM xrpl.ledger_by_hash) = (SELECT count() FROM xrpl.ledgers);           -- 1
SELECT count() FROM xrpl.ingest_log FINAL WHERE status = 'started';                              -- 0
```

Extra crash tests, live mode (`crash-loop.sh`, 3 rounds: poll `system.processes` every 20 ms, `kill -9` while an INSERT is in flight, wait for the lease to age, restart, check): all three rounds `span=count 1`, `count=uniqExact 1`, no transaction above the checkpoint 1,
`sum(tx_count)=rows 1`, `ledger_by_hash=ledgers 1`, lag back to 0-1 within 40 s (`logs/crash-loop.log`).

ClickHouse outage (`docker stop dropin-verify-clickhouse` for 29 s, mine): both probes 503 (F6 body), `GET /v2/payments` -> `500 {"result":"error","message":"unable to retrieve payments"}`, `/v2/ledgers` -> `500 ... unable to retrieve ledger`
(Ripple-shaped, no database text), `/balances` still 200 (live node). After `docker start`: both probes 200 within 10 s, `Recovered: continuing after ledger 107699834`, invariants again 1/1/1/1/1 over 1854 ledgers and 274,355 transactions (`logs/ch-outage.log`).

`agg_dirty` / stats after the sync (R92), XRPL: `stats_hourly` has rows for both synced hours (15:00: 204 ledgers, 30,441 tx; 16:00 growing), `agg_dirty` 0, hours with ledgers = hours with stats rows (2 = 2). The stats API agrees with the ledgers table (section 7, e).
Live ingest does not write `agg_dirty` (documented); the watermark sweep covered the hours. The other two workers wrote `fee_stats` (every 5 s, 1,174 rows at the end) and the validations (122 validators, 171k rows at the end).

### Xahau timeline (UTC)

| Time | Event |
| --- | --- |
| 16:17:49 | first start, concurrency 8: rate limited (`50000 per 10s`) and **F1**: endless `Writing ledgers ... failed` loop, checkpoint stuck; stopped 16:18:25; database dropped and recreated (my own) |
| 16:24:39 | clean start with the scratch F1 workaround, concurrency 1 (start ledger 26570727) |
| 16:25-16:34 | throttled (3 to 4 ledgers per 10 s, the head moves 2.7 per 10 s), lag stuck near 365..420; restarts on `xahau.org` (boot crash F4, same quota), then ingest+aggregator only |
| 16:39:15 | the node's throughput jumps (about 10 ledgers/s with concurrency 1) and the backlog drains |
| **16:42:57** | live. Total from the clean start **18 m 18 s** (25 m 08 s from the first attempt), inside the 30-minute cap |
| 16:44:07 | restarted with all four workers (validations, fee_stats) at concurrency 1: stayed live |

Xahau after the sync: 895 ledgers (26570727..26571621 when the sweep started), 56,243 transactions (25,364 `Payment`, 5,427 `URITokenBuy`, 4,866 `Invoke`, 88 `UNLReport`, 53 `Cron`, ...), 0 trades, 3 accounts created; `stats_hourly` rows for all 38 hours present at the end (including the sampled ones),
`agg_dirty` 0, no orphan child rows, no duplicate `(ledger_index, tx_index)`.

## 6. Step 4: the endpoint sweep

Harness: `smoke.js <network>` (discovers sample accounts, pairs, hashes, currencies from the network's own database, so the answers are non-empty where the synced data allows), 190 checks per run. Each endpoint of the contract table is called with an API key
(json, with the wrapper keys and the key list and key order of every row object compared with `docs/api-reference.md`), with `format=csv` (content type, `Content-Disposition`, row count equals the JSON count, no `[Object]` cells), with a 2-page marker walk
(page 1 + page 2 must equal the first rows of a double-size unpaged call, `Link: rel="next"` present), with one bad parameter (exact status and message, `Cache-Control: no-store`) and once without a key (401). Responses are in `smoke/<network>/`.
"n/a" = the contract has no CSV form / the endpoint is not paged / a single object.

### XRPL

| Endpoint | json | csv | paging (2-page walk) | bad param | no key (401) |
| --- | --- | --- | --- | --- | --- |
| `GET /v2/ledgers[/{id}]` | pass x8 | n/a | n/a | pass x2 | pass |
| `GET /v2/last_validated` | pass | n/a | n/a | n/a | n/a |
| `GET /v2/transactions/{hash}` | pass x3 | n/a | n/a | pass x2 | pass |
| `GET /v2/transactions` | pass x4 | n/a | pass x2 | pass x2 | pass |
| `GET /v2/payments[/{currency}]` | pass x3 | pass x2 | pass x2 | pass | pass |
| `GET /v2/exchanges/{base}/{counter}` | pass x5 | pass x3 | pass x3 | pass x3 | pass |
| `GET /v2/active_accounts/{base}/{counter}` | pass x3 | pass | n/a | pass | pass |
| `GET /v2/exchange_rates/{base}/{counter}` | pass x3 | n/a | n/a | pass | pass |
| `GET /v2/normalize` | pass | n/a | n/a | pass | pass |
| `GET /v2/exchanges (all pairs)` | pass | pass | pass | pass | pass |
| `GET /v2/stats[/{family}[/{metric}]]` | pass x4 | pass | pass | pass | pass |
| `GET /v2/accounts` | pass x2 | pass | pass | pass | pass |
| `GET /v2/accounts/{address}` | pass x2 | n/a | n/a | pass | pass |
| `GET /v2/accounts/{address}/transactions[/{seq}]` | pass x3 | n/a | pass | pass x2 | pass |
| `GET /v2/accounts/{address}/payments` | pass x3 | pass | pass | pass | pass |
| `GET /v2/accounts/{address}/exchanges[/{base}[/{counter}]]` | pass x3 | pass | pass | pass | pass |
| `GET /v2/accounts/{address}/balance_changes` | pass x2 | pass | pass | pass | pass |
| `GET /v2/accounts/{address}/balances (live node)` | pass x3 | pass | n/a | pass x2 | pass |
| `GET /v2/accounts/{address}/orders (live node)` | pass | pass | n/a | pass | pass |
| `GET /v2/accounts/{address}/reports[/{date}]` | pass x2 | pass | n/a | pass | pass |
| `GET /v2/accounts/{address}/stats/{transactions or value}` | pass x2 | pass x2 | not run* | pass | pass |
| `GET /v2/network/fees` | pass x3 | pass | pass | pass | pass |
| `GET /v2/network/fee_stats` | pass x2 | pass | pass | pass | pass |
| `GET /v2/network/exchange_volume` | pass x3 | pass | not run* | pass | pass |
| `GET /v2/network/payment_volume` | pass x3 | pass | not run* | pass | pass |
| `GET /v2/ledgers/{hash}/validations[/{pubkey}]` | pass x3 | pass | pass | pass x2 | pass |
| `GET /v2/<unknown>` | n/a | n/a | n/a | pass | n/a |

171 pass, 0 fail, 19 skipped (190 checks): 16 are n/a by contract, 3 not run.

n/a = the contract has no such form (no CSV, not paged, single object); not run* = no data in the synced window:
- SKIP GET /v2/accounts/{address}/stats/{transactions or value} [paging] acct_stats: one row per active UTC day; the synced window spans at most 2 days
- SKIP GET /v2/network/exchange_volume [paging] exchange_volume: historical rows exist only for closed days; the synced window has no closed day (marker mechanism covered by e2e tests)
- SKIP GET /v2/network/payment_volume [paging] payment_volume: historical rows exist only for closed days; the synced window has no closed day (marker mechanism covered by e2e tests)

### Xahau

| Endpoint | json | csv | paging (2-page walk) | bad param | no key (401) |
| --- | --- | --- | --- | --- | --- |
| `GET /v2/ledgers[/{id}]` | pass x8 | n/a | n/a | pass x2 | pass |
| `GET /v2/last_validated` | pass | n/a | n/a | n/a | n/a |
| `GET /v2/transactions/{hash}` | pass x3 | n/a | n/a | pass x2 | pass |
| `GET /v2/transactions` | pass x4 | n/a | pass x2 | pass x2 | pass |
| `GET /v2/payments[/{currency}]` | pass x3 | pass x2 | pass x2 | pass | pass |
| `GET /v2/exchanges/{base}/{counter}` | pass x5 | pass x3 | pass x2 (+1 not run*) | pass x3 | pass |
| `GET /v2/active_accounts/{base}/{counter}` | pass x3 | pass | n/a | pass | pass |
| `GET /v2/exchange_rates/{base}/{counter}` | pass x3 | n/a | n/a | pass | pass |
| `GET /v2/normalize` | pass | n/a | n/a | pass | pass |
| `GET /v2/exchanges (all pairs)` | pass | pass | pass | pass | pass |
| `GET /v2/stats[/{family}[/{metric}]]` | pass x4 | pass | pass | pass | pass |
| `GET /v2/accounts` | pass x2 | pass | pass | pass | pass |
| `GET /v2/accounts/{address}` | pass x2 | n/a | n/a | pass | pass |
| `GET /v2/accounts/{address}/transactions[/{seq}]` | pass x3 | n/a | pass | pass x2 | pass |
| `GET /v2/accounts/{address}/payments` | pass x3 | pass | pass | pass | pass |
| `GET /v2/accounts/{address}/exchanges[/{base}[/{counter}]]` | pass x3 | pass | not run* | pass | pass |
| `GET /v2/accounts/{address}/balance_changes` | pass x2 | pass | pass | pass | pass |
| `GET /v2/accounts/{address}/balances (live node)` | pass x3 | pass | n/a | pass x2 | pass |
| `GET /v2/accounts/{address}/orders (live node)` | pass | pass | n/a | pass | pass |
| `GET /v2/accounts/{address}/reports[/{date}]` | pass x2 | pass | n/a | pass | pass |
| `GET /v2/accounts/{address}/stats/{transactions or value}` | pass x2 | pass x2 | not run* | pass | pass |
| `GET /v2/network/fees` | pass x3 | pass | pass | pass | pass |
| `GET /v2/network/fee_stats` | pass x2 | pass | pass | pass | pass |
| `GET /v2/network/exchange_volume` | pass x3 | pass | not run* | pass | pass |
| `GET /v2/network/payment_volume` | pass x3 | pass | not run* | pass | pass |
| `GET /v2/ledgers/{hash}/validations[/{pubkey}]` | pass x3 | pass | pass | pass x2 | pass |
| `GET /v2/<unknown>` | n/a | n/a | n/a | pass | n/a |

169 pass, 0 fail, 21 skipped (190 checks): 16 are n/a by contract, 5 not run.

n/a = the contract has no such form (no CSV, not paged, single object); not run* = no data in the synced window:
- SKIP GET /v2/exchanges/{base}/{counter} [paging] exchanges_candles_walk: only 2 rows in the window
- SKIP GET /v2/accounts/{address}/exchanges[/{base}[/{counter}]] [paging] acct_exchanges_walk: only 1 rows in the window
- SKIP GET /v2/accounts/{address}/stats/{transactions or value} [paging] acct_stats: one row per active UTC day; the synced window spans at most 2 days
- SKIP GET /v2/network/exchange_volume [paging] exchange_volume: historical rows exist only for closed days; the synced window has no closed day (marker mechanism covered by e2e tests)
- SKIP GET /v2/network/payment_volume [paging] payment_volume: historical rows exist only for closed days; the synced window has no closed day (marker mechanism covered by e2e tests)

After the sweep, with the sampled closed days in place, a 2-page walk (`limit=2`) of `/v2/network/exchange_volume` and `/v2/network/payment_volume` (`start=2026-10-13&interval=day`) was run on Xahau: page 1 = 2 rows + marker + `Link`, page 2 = 2 rows, equal to the unpaged answer (both routes pass). The two "only N rows" paging cases are real data limits (2 candles, 1 trade of that account).

Semantic cross-checks on XRPL (`semantic.js`, window = first 20 minutes of the synced data): `/v2/payments` page walk = SQL count (3,918 = 3,918, no duplicate hash); `/v2/exchanges` walk 878 = 878; `/v2/accounts/{a}/transactions` walk 5,899 = 5,899;
`/v2/network/fees` of ledger 107698017 equals the node (total 0.000726, max 0.00003, min 0.00001, 61 tx); `/v2/stats` hour 15:00 equals the ledgers table (30,441 tx / 204 ledgers / 2,668 payments / 493 trades / 36 accounts); `reduce` of the busiest pair equals SQL (500 trades, base volume to the 10th digit).

The same six checks on Xahau over its whole range: `/v2/payments` walk 54,933 rows in 55 pages = SQL 54,933 (no duplicate hash); `/v2/exchanges` walk 5 = 5; `/v2/accounts/rHktf.../transactions` walk 23,802 = 23,802; `/v2/network/fees` of ledger 26516863 equals the node (total 0.134112, 21 tx);
`/v2/stats` hour 2026-10-13T23:00 equals the ledgers table (361 tx, 100 ledgers, 277 payments); `reduce` of `EVR/XAH` equals SQL (4 trades, base volume 1060.4998).

Other contract checks made on the XRPL API: parameter rules (`limit=0` -> 200, `limit=99999` -> clamped to 1000, `limit=2.9` -> 2, `limit=abc` -> default, repeated `limit` first wins, `descending=1` is not true, `format=CSV` works, unknown parameters ignored, `marker=garbage` -> 400 `invalid marker`,
future `date` -> 400 `must not be a future date`, `0x`-hash -> 404, `/v2/health`, `/v2/gateways`, `/v2/network/validators`, `/v2/accounts/{a}/escrows` -> Ripple-shaped 404), network awareness (`XRP+issuer` is 400 on XRPL and a valid issued currency on Xahau; `XAH` needs an issuer on XRPL;
`type=URITokenMint`/`Cron` accepted on Xahau only), 600 requests then `429 {"error":"Rate limit exceeded, retry in 59.77sec"}` with `Retry-After: 60`, `X-RateLimit-Limit: 600`, `Remaining: 0`, `Reset: 60`, `Cache-Control: no-store`, and the keyless request still 401 while the route is limited, probe 200.

## 7. Step 5: spot checks against the node

| Check | XRPL | Xahau |
| --- | --- | --- |
| `/v2/ledgers/{index}` vs node `ledger` (3 ledgers, 9 header fields; `close_time` is unix seconds, the node's is ripple-epoch + 946684800) | all equal | all equal (3 ledgers) |
| `/v2/transactions?binary=true`, 100 newest: SHA-512Half(`TXN\0` + blob) = `hash` | 100 / 100 | 100 / 100 (none of them an UNLReport) |
| `/v2/transactions/{hash}?binary=true`, one of each of the 12 most common types; `json.hash == hash` | 12 / 12 | 11 / 12; **`UNLReport`: does not re-hash (F2)**; `json.hash == hash` for all 12 |
| `/v2/ledgers/{n}?binary=true`: SHAMap root of the tx tree (`SND\0` leaves, `MIN\0` nodes) = `transaction_hash` | 3 / 3 (86, 96, 154 tx; later 221, 128, 136) | 3 / 3 for ordinary ledgers (219, 177, 199 tx); **0 / 3 for the flag ledgers 26570752, 26571008, 26571264** (22 of their tx blobs do not re-hash, F2) |
| `/v2/accounts/{a}/balances?limit=all` vs `account_info` + `account_lines` at the same ledger | identical (7 = 1 + 6) | identical (4 = 1 + 3) |
| `/v2/accounts/{a}/orders` vs `account_offers` at the same ledger | 12 / 12 sequences equal (13 / 13 later) | 0 / 0 (the account holds no offer; the Xahau DEX is thin) |
| validations of the stored ledgers closed during one continuous run of the worker | 399 / 400 (since the last restart, 17:14:30 UTC; up to 106 per ledger; the one without is the newest ledger, the collector flushes every 20 s) | 327 / 327 stored ledgers of the continuous four-worker run (16:44:30 to 17:03:00 UTC) have 26 validations each (26 validators); ledgers closed while the syncer was stopped have none |
| `fee_stats` cadence (live, nothing else running) | median 5.001 s, p90 5.002 s, p99 5.003 s, max 10.003 s over 362 samples (the 10 s is a skipped tick) | median 5.0005 s, p90 5.002 s, max 10.001 s over 80 samples |

Notes on Step 5. (a) The re-hash is SHA-512Half(`54584E00` + blob) over the served hex, so it needs no codec (the XRPL definitions of `ripple-binary-codec` cannot decode most Xahau types; the API uses the bundled Xahau definitions). (b) The tx-tree check builds the SHAMap
itself (leaf `SND\0` + VL(tx) + VL(meta) + id, inner `MIN\0` + 16 children): it proves that the stored `tx`/`meta` re-encode to exactly what the ledger committed, for ledgers of 86 to 221 transactions. (c) `close_time` is the only header field that differs in form from the node
(unix seconds against ripple-epoch seconds), by contract. (d) `Batch` transactions and every other type of the XRPL window re-hash.

## 8. Step 6: `packages/shared/config/markets/xahau.json`

`server_info.complete_ledgers` of `wss://xahau.network`: `1-26571037` at the start (and `1-26571674` later): full history from ledger 1.

Range ingest of the last 3 days (about 65,000 ledgers, 26505727..26570726) was **not feasible** on the public nodes (F3, F5): the 50,000 units / 10 s window let through roughly 100 to 370 ledgers, and the 10,000,000 units / 3,600 s window was exhausted at 17:42.
Done instead, polite and bounded (<= 3 in flight, 100-ledger chunks, one invocation per chunk, a 15 s pause after a failed attempt, 27.5 minutes):

- contiguous block 26549127..26549599 (473 ledgers, ingested first and finished by hand-closing the stale intents, F5),
- a stratified sample of 33 successful bursts of 100 ledgers each, spaced 1,000 ledgers apart across 26505727..26570726 (65 planned, 32 skipped after two rate-limited attempts) visited in a spread order (`sample-range.sh`),
- the live block 26570727.. (the syncer).

Result in the `xahau` database: 3,773 ledgers below the live block (2026-10-13 23:31 to 2026-10-15 19:02 UTC: 100 / 2,400 / 1,273 ledgers on the three days) + the live block; `agg_dirty` drained to 0 by the syncer's aggregator, `stats_hourly` rows for all 38 hours, `volume_daily` computed for 2026-10-13..16 under the new version.
The ledgers table now has gaps by construction (a sample), so no gap invariant is claimed for Xahau.

Top markets against XAH by trade count in the sample (`exchanges`, either stored orientation), and the issued payment currencies by count:

| Market (base issued, counter XAH) | Trades | Base volume |
| --- | --- | --- |
| `EVR` / `rEvernodee8dJLaFsujS6q1EiXvZYmHXr8` | 4 | 1,060.5 |
| `XXX` / `rxxxx9gmp1DSJ8bE4Gya48VtRdPPz7mHF` | 1 | 1.74 (looks like a test token; kept because it is what the data says, prune if unwanted) |

| Payment currency | Payments |
| --- | --- |
| `EVR` / `rEvernodee8dJLaFsujS6q1EiXvZYmHXr8` | 1,388 |
| `4555525100000000000000000000000000000000` ("EURQ") / `rDk1xiArDMjDqnrR2yWypwQAKg4mKnQYvs` | 8 |
| `RVN` / `rodinGM9xiKq7rDDnLPyieREkqGJ6zKyb` | 4 |
| `XXX` / `rxxxx9gmp1DSJ8bE4Gya48VtRdPPz7mHF` | 3 |
| (native XAH, implicit) | 46,215 |

Written to `packages/shared/config/markets/xahau.json`: `version` 1 -> **2**, 2 `tradeMarkets` (issued asset as base, `{"currency":"XAH"}` as counter), 4 `paymentCurrencies`.
**This list was derived from a ~6% sample of three days (and only 5 trades); it is a bootstrap and should be re-derived from a full-history node** (the Xahau DEX is thin; a 30-day count against XAH needs a real backfill).

Validation by booting the syncer's aggregator (config validation runs at boot):

```
GH_NETWORK=xahau GH_WORKERS=aggregator node apps/syncer/dist/main.js
  [Aggregator] Volume jobs on: 2 trade market(s), 4 payment currenc(ies) and the native one, markets config version 2
GH_MARKETS_CONFIG=<same asset both sides>   -> ERROR Invalid markets config: tradeMarkets[0]: a market needs two different assets      (boot refused)
GH_MARKETS_CONFIG=<XAH with an issuer>      -> ERROR Invalid markets config: tradeMarkets[0].counter: the native currency XAH has no issuer (boot refused)
```

End to end: with the new file the aggregator computed `volume_live` (7 sets) and `volume_daily` for 2026-10-13..16; the API's Xahau `exchange_volume?live=30day` now returns the two configured markets (`EVR/XAH` 4 trades, 1,060.5 EVR worth 8,557.29 XAH; `XXX/XAH` 1 trade, 1.74 XAH) and the daily rows for 2026-10-14 (3 trades) and 2026-10-15 (2 trades) carry them as components;
`payment_volume` shows only the XAH component (41,778 of 42,388 payments of the day), because an issued currency needs a strict rate (at least 10 trades) and EVR has 4: those payments are counted in `count` but, as documented, left out of the components.

To re-derive the list from a full-history node later (the `xahau` database filled by a real backfill), run in `clickhouse-client`:

```sql
SELECT base_currency, base_issuer, counter_currency, counter_issuer, count() AS trades
FROM xahau.exchanges
WHERE close_time >= now() - INTERVAL 30 DAY AND ((base_currency = 'XAH' AND base_issuer = '') OR (counter_currency = 'XAH' AND counter_issuer = ''))
GROUP BY base_currency, base_issuer, counter_currency, counter_issuer ORDER BY trades DESC LIMIT 10;

SELECT currency, issuer, count() AS payments FROM xahau.payments
WHERE issuer != '' AND close_time >= now() - INTERVAL 30 DAY GROUP BY currency, issuer ORDER BY payments DESC LIMIT 10;
```

then put the issued asset as `base` and `{"currency":"XAH"}` as `counter`, bump `version`, and boot the aggregator once to validate. The Xahau chain needs F1 fixed first or a backfill cannot pass a flag ledger.

The unit test of F12 reads this file: update `packages/shared/src/network/network-profile.spec.ts` (`loads the bundled xahau markets`) to the new content when the list is accepted.

## 9. Repo changes of this task

- `packages/shared/config/markets/xahau.json` (version 2, section 8).
- Doc corrections made false by that file: `docs/syncer.md` §7 (last bullet), `docs/api-reference.md` (network volumes intro), `docs/adr/0009-one-deployment-per-network.md` ("ships empty"). No other doc was changed; F6 to F9 are listed, not fixed, because the right side to fix (docs or product) is the controller's call.
- This report, and `.superpowers/sdd/2026-10-15-ripple-dropin/task-38-report.md` (git-ignored) with the harness copy.

No product code, test or env file was edited; no key, token or env file is in the report or the commit.

## 10. Cleanup

- Processes: both syncers stopped with SIGTERM (lease released, `Released the syncer lease` logged; the `kill -9` ones were the crash tests), both apis stopped, every range-ingest / sample / crash script finished or stopped; `pgrep` for `dist/main.js`, `range-ingest`, `sample-range`, `crash-loop`, `smoke.js`, `step5.js`, `semantic.js` finds nothing, ports 13000 to 13013 are free.
- Docker: `docker compose -p dropin-verify -f docker-compose.yaml -f compose.override.yaml down -v` removed the container `dropin-verify-clickhouse`, the network `dropin-verify_default` and the volume `dropin-verify_clickhouse-data`; no container, volume, network or image with `dropin` in its name remains. The testcontainers of Step 1 removed themselves (no `ryuk` or ClickHouse test container left).
  The user's containers and volumes (`data-api-clickhouse`, `ch-keeper`, the `ghv2_*`, `supabase_*`, `rhyza-*` ones) were not stopped, started, removed or modified; the running ones were running before and after. The two failed `docker build` attempts produced no image; BuildKit may keep unnamed cache layers of the base image steps.
- Files: nothing was deleted except my own scratch files inside the verify folder (`range.stop`, two `*.tmp`, one 260 KB ledger sample). The verify folder itself is left in place as the evidence; nothing was written outside it and the repo except the harness copy in the git-ignored `.superpowers/sdd/.../task-38-harness/`. No stray file from a mistyped path.
- The user's `apps/api/.env`, `apps/syncer/.env`, `deploy/.env.prod` and the npm credentials were not read, printed, copied or edited.

## Appendix: harness and commands

The scripts (all use explicit environment, API key from a throwaway env file in the scratch folder, never printed):
`start-syncer.sh`, `start-api.sh`, `crash-poll.sh`, `crash-loop.sh`, `smoke.js`, `step5.js`, `semantic.js`, `gen-coverage.js`, `sample-range.sh`, `run-range-loop.sh`, `workaround-unlreport.js` (scratch only, F1), `compose.override.yaml`, `rpc.js` (xrpl.js one-shot requests), `ch.sh` (clickhouse-client in my container).

Key commands, in order (secrets elided):

```
pnpm install && pnpm build && pnpm test && pnpm -r test:e2e
docker compose -p dropin-verify up -d clickhouse                                  # fails: container name in use (F9)
docker compose -p dropin-verify -f docker-compose.yaml -f compose.override.yaml up -d clickhouse
GH_NETWORK={xrpl,xahau} pnpm ch:migrate
GH_NETWORK=xrpl  GH_SYNC_START_LEDGER=107698007 GH_NODE_ENDPOINTS=wss://xrplcluster.com   node apps/syncer/dist/main.js    # then kill -9 <pid>, restart (twice)
GH_NETWORK=xrpl  GH_CATCHUP_CONCURRENCY=2 GH_NODE_ENDPOINTS=wss://s2.ripple.com            node apps/syncer/dist/main.js
GH_NETWORK=xahau GH_SYNC_START_LEDGER=26570727 GH_CATCHUP_CONCURRENCY=1 NODE_OPTIONS="--require workaround-unlreport.js" node apps/syncer/dist/main.js
GH_API_KEYS=$KEY GH_NETWORK={xrpl,xahau} NODE_ENV=development node apps/api/dist/main.js   # ports 13001 / 13011
node smoke.js {xrpl,xahau}; node step5.js {xrpl,xahau}; node semantic.js {xrpl,xahau}
GH_ENV=local pnpm --filter @gatehub/data-syncer ingest:range --from <a> --to <b> --concurrency 3 --chunk 100 --run-id verify-sample
docker compose -p dropin-verify -f docker-compose.yaml -f compose.override.yaml down -v
```

## Fixes after verification

Fix round of 2026-10-16 on `feat/ripple-dropin` (base `04c0f0e`), under the controller rulings R95 to R104. Every code change was
written test first (RED, then GREEN); the RED/GREEN evidence per change is in `.superpowers/sdd/2026-10-15-ripple-dropin/task-38-fix-report.md`.

| Finding | Ruling | Commit | What changed | Evidence |
| --- | --- | --- | --- | --- |
| F1 UNLReport (`Account: ""`) blocks ingest | R95 | `6006133` | `senderAccount()`: an empty `Account` is the zero account `rrrrrrrrrrrrrrrrrrrrrhoLvTp` in the index columns (`transactions.account`, `account_tx_by_sequence`, `is_initiator`, `accounts_created.parent`); `tx_json` keeps the node's `""`; a missing / non-string `Account` is still rejected | Flag ledger 26570752 recorded from `wss://xahau.network` (`record-fixtures`, plus its `binary: true` form) in `packages/shared/test/fixtures/xahau/flag/`; golden snapshot of its rows; shared e2e: inserts and reads back in every table, commits through `LedgerWriter` (22 UNLReport under the zero account, `tx_json` Account `""`) |
| F1 aggravating: deterministic parse error loops | R96 | `74db13f` | `buildLedgerRows` throws `LedgerParseError` (ledger index + reason). The live runner commits the batch prefix before the bad ledger with the same writer (nothing of the batch was inserted) and halts (`state: halted`, `error: Cannot parse ledger <n>: ...`, probe 503, `syncer_ingest_halts_total{reason="parse_error"}`); range-ingest fails the chunk at once, intent open | live-runner e2e: before the fix the runner never stopped (both tests hit the 180 s timeout); after: checkpoint = ledger before the bad one, no rows above it, the bad ledger fetched once; range-ingest e2e: one attempt, `Cannot parse ledger <n>` |
| F2 `binary=true` of UNLReport does not re-hash | R97 | `6006133`, `9f2703a` | `BinaryCodecService.encode` writes an AccountID whose JSON value is `""` as a zero-length field (`81 00`: encoded with a sentinel address whose `14 <20 bytes>` is cut to `00`); `roundTrip()` keeps `""` in JSON mode | codec unit: all 37 blobs and metas of the flag ledger are byte-equal to the node's `binary: true` answer and re-hash; tx tree root = `transaction_hash`; api e2e `xahau-flag`: `/v2/transactions/{hash}` shows `Account: ""`, `?binary=true` and `/v2/ledgers/26570752?binary=true[&expand=true]` re-hash (7 of 8 tests failed before the fix) |
| F3 rate limits ignored; default endpoints throttle | R98 | `add88cb` | Process-wide `EndpointThrottle`: a rate-limit answer (`retry in ~<N>ms`, `slowDown`, `tooBusy`, HTTP 429) pauses that endpoint (hint + 250 ms, 10 s without a hint, max 20 min) for every NodeClient of the process: no request, no connection attempt; failover to another endpoint; `NodeThrottledError` (`retryAfterMs`) when all are paused; logged once per pause; `syncer_node_rate_limited_total` / `api_node_rate_limited_total{endpoint}`. Defaults: XRPL `wss://s2.ripple.com,wss://xrplcluster.com`, `GH_CATCHUP_CONCURRENCY=4` | NodeClient unit tests against a mock rippled (pause, no request during it, failover, connect refusal, shared throttle, cap); live runner waits the hint (e2e); live re-check below |
| F4 boot dies on a rate-limited `server_info`; aggregator needs a node | R99 | `add88cb` | The boot network check retries (1 s doubling to 30 s, or the hint); only a node of another network ends the boot. The shared NodeClient is made only for `ingest` / `fee_stats` | syncer app e2e (real `main.ts`): boots through two rate-limited `server_info` answers; `GH_WORKERS=aggregator` boots and serves 200 with no node listening (both timed out before) |
| F5 range-ingest stuck on throttled nodes; `--chunk` change redoes intents forever | R100 | `3a2b831` | Rate-limited and `lgrNotFound` fetches are retried within a per-chunk wait budget (`--max-wait`, default 1200 s); unfinished intents are redone first over their own recorded range (overlapping ones merged) and closed | range-ingest e2e: 8 new tests failed on the old code; the F5 scenario (wide intent, smaller chunk, later failure) closes the intent and the rerun fetches only what is missing |
| F11 `lgrNotFound` intermittent | R100 | `3a2b831` | as F5 (retried as transient in range-ingest; the live runner already retried) | as F5 |
| F6 probe 503 body | R101 | `3cd4530` | The probe controller of both apps answers 503 with the terminus result (`status: error`, `info`, `error`, `details`) | syncer app e2e (ClickHouse down; halted runner: `state`, `lag`, `last_commit_age`, `error`), api `main.e2e-spec` (ClickHouse down), all under the real toolbox `bootstrap()` |
| F7 `GET /` body | R102 | `c4b4f8e` | api-reference "Out of scope": paths outside `/v2`, `GET /` included, answer the platform's `{"error":{...}}` 404 | doc only |
| F8 config self-check snippet | R102 | `c4b4f8e` | The snippet works from any directory of the checkout (`git rev-parse`, `reflect-metadata` resolved from `apps/api`) | run from the repo root and from `docs/`: prints the 12 api and 14 syncer names |
| F9 dev compose next to another stack | R103 | `c4b4f8e` | `docker-compose.yaml`: no `container_name`, every host port from a variable with the old default; prod compose keeps the syncer / ClickHouse names (documented as the refuse-to-scale mechanism, one prod stack per host) | `docker compose -p t38fix up -d clickhouse` with `CLICKHOUSE_HTTP_PORT=18124 CLICKHOUSE_NATIVE_PORT=19001` started next to the user's stopped `data-api-clickhouse` without a conflict (live re-check) |
| F10 `ledger_interval` of a partial first hour | R102 | `c4b4f8e` | Documented as computed from the bucket start | doc only |
| F12 / markets | R104 | `c4b4f8e` | `xahau.json` version 3 without `XXX` / `rxxxx9gmp1DSJ8bE4Gya48VtRdPPz7mHF`; `network-profile.spec.ts` expects it; provenance note kept | shared unit suite 578 / 578 |

Suites at the end of the round (code commit `9f2703a`): `pnpm build` exit 0; `pnpm test` 1911 pass / 0 fail (shared 578, syncer 351,
api 982); `pnpm -r test:e2e` 2093 pass / 0 fail (shared 350, syncer 160, api 1583, including `apps/api/test/main.e2e-spec.ts`). One
of three full api e2e runs had a single intermittent failure (`errors.e2e-spec.ts`, `/v2` answered a 404 whose body was not the JSON
one); it did not recur in 9 isolated reruns of that suite nor in the other two full runs, and nothing on that path changed in this round.

**Live re-check** (built `dist`, own compose project `t38fix`, scratch database `xahau_t38fix`, `GH_WORKERS=ingest`, concurrency 1,
`wss://xahau.network`; validated head 26574278, flag ledger 26574080, start 26574060): the syncer committed 26574060-26574063, then the node
answered `rate limit: units quota (50000 per 10s) exhausted, retry in ~6280ms`. The node client logged it once (`... nothing is sent to it
for 6.5 s`), the runner waited exactly that long and committed 26574064-26574065, and a second answer (`retry in ~8148ms`) was honoured the
same way, before the syncer was stopped (SIGTERM, lease released) **as the rule requires on a rate-limit answer: the flag ledger 26574080 was
not reached live**. Instead, the flag ledger recorded from the same node earlier that day (26570752, 22 UNLReport) was ingested offline into
the same database through the built `range-ingest` (`FixtureLedgerSource`, no node), and the built API (node endpoint unreachable on
purpose, bundled Xahau definitions) served `/v2/ledgers/26570752?binary=true&expand=true`: 37 of 37 blobs re-hash, 22 carry `81 00`, tree
root `C39A304D...54646` = `transaction_hash`; the JSON form shows the 22 UNLReports with `Account: ""`. The six ledgers ingested live
(161 to 176 transactions each) re-hash the same way. Requests to the public node in this round: 3 for the fixture (`server_info`,
`server_definitions`, `ledger`), 1 for its binary form, 1 for the head, and the syncer's own (`server_info`, `subscribe`, the validated
head, and one ledger at a time: 6 committed, 2 refused with the rate limit); never more than one in flight. Everything started was torn down
(`docker compose -p t38fix down -v`: container, network, volume); the user's containers were not touched.
