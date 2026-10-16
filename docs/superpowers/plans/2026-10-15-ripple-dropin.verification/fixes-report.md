# Task 38 fix round: report

Implementer of the fixes for the findings of the Task 38 end-to-end verification (F1 to F12), under the controller rulings R95 to R104.
Branch `feat/ripple-dropin`, base `04c0f0e`. Status: **DONE_WITH_CONCERNS** (see Concerns: the live re-check stopped on a rate-limit
answer before the flag ledger, as the rule requires; the flag ledger was checked from the built dist with a ledger recorded from the same
node instead).

## Commits

| Commit | Rulings | Subject |
| --- | --- | --- |
| `6006133` | R95, R97 (F1, F2) | fix(ingest,api): ingest Xahau UNLReport (Account "") and serve its node bytes |
| `74db13f` | R96 (F1 aggravating) | fix(syncer): halt on a ledger the parser rejects instead of recovering forever |
| `add88cb` | R98, R99 (F3, F4) | fix(node): honour rate-limit answers; boot without a node when no worker needs one |
| `3a2b831` | R100 (F5, F11) | fix(range-ingest): wait out rate limits and lgrNotFound; redo an intent once over its own range |
| `3cd4530` | R101 (F6) | fix(probe): a 503 of the liveliness probe carries the detail body of a 200 |
| `c4b4f8e` | R102, R103, R104 (F7, F8, F9, F10, F12) | docs,compose,markets: GET / and ledger_interval docs, a location-independent config check, dev compose next to another stack, Xahau markets v3 |
| `9f2703a` | (R97 follow-up, test hygiene) | chore: cheaper empty-AccountID check in the codec; keep an expected client warning out of the e2e output |
| `30b51df` | | docs: "Fixes after verification" section of `docs/superpowers/plans/2026-10-15-ripple-dropin.verification.md` |

No env file was read, printed, copied, edited or committed (`.env.example` / `deploy/.env.prod.example` templates were updated, as R98 asks).

## What was implemented

### R95 (F1): a transaction whose `Account` is `""`
- `packages/shared/src/parsers/parser.interface.ts`: `ACCOUNT_ZERO` and `senderAccount(tx)`: `""` -> `rrrrrrrrrrrrrrrrrrrrrhoLvTp`, a
  non-string -> undefined.
- `build-rows.ts` `senderOf` uses it (comment rewritten: pseudo-transactions carry the zero account; Xahau's UNLReport leaves it empty;
  `tx_json` keeps `""`); a missing / non-string Account is still rejected. `accounts-created.parser.ts`: the `parent` of an account created
  by such a transaction is the zero account too. Affected-accounts, payments, exchanges and balance changes read only metadata or fields a
  pseudo-transaction does not have: no change needed (checked: affected accounts filter on `r...`, nothing is listed under `""`).
- Xahau definitions: pseudo types are `EnableAmendment`, `SetFee`, `UNLModify`, `EmitFailure`, `UNLReport`; only UNLReport carried `""` in
  the recorded data and the run's 12-type sample (Cron re-hashed, i.e. has a real Account). The code handles any type with an empty
  Account alike (tested with an `EmitFailure`).
- Fixture: flag ledger **26570752** recorded with `scripts/record-fixtures.ts` (3 sequential requests, 500 ms apart) plus one `ledger`
  request with `binary: true` (`node-binary-26570752.json.gz`: the node's own `tx_blob` / `meta`), in
  `packages/shared/test/fixtures/xahau/flag/` with a manifest. Kept apart from `xahau/recorded` so the counts of the ~20 suites that seed
  those ledgers stay as they are; the API harness has a new seed `xahau-flag`.

### R97 (F2): `binary=true` reproduces the node's bytes
- `BinaryCodecService.encode`: an AccountID field (any depth, `type.name === 'AccountID'` and VL-encoded per the definitions in use) whose
  JSON value is `""` is encoded with a sentinel address (20 bytes from SHA-256 of a fixed text; the next of 4 candidates if the JSON holds
  the first), then `14 <sentinel>` at a byte boundary is cut to `00`, so the field is `<header> 00` (`81 00` for Account). The number of
  cuts must equal the number of substituted fields, else it throws (TxService then serves stored JSON and counts the fallback).
- `BinaryCodecService.roundTrip(json)`: `decode(encode())` that keeps `""` (the codec decodes a zero-length AccountID as the zero account);
  TxService's JSON mode uses it. `decode(hex)` is unchanged and documented as returning the zero account for `81 00`.
- `9f2703a`: a non-allocating `hasEmptyAccount` walk decides first, so the ordinary encode pays no copying walk.

### R96 (F1 aggravating): deterministic parse errors halt
- `buildLedgerRows` throws `LedgerParseError(ledgerIndex, reason)` (`Cannot parse ledger <n>: <reason>`); `isLedgerParseError` matches by
  name too. `LedgerWriter.write` documents that the whole batch is parsed before the first insert.
- `LiveRunner.flush`: on a `LedgerParseError` it writes the batch's ledgers before the bad one with the **same** writer (nothing of the
  failed call was inserted, and the prefix has its own dedup tokens), books them like any commit, then `halt()`: state `halted`, status
  `error`, liveliness 503, error log `Ingest halted until an operator intervenes: Cannot parse ledger ...`. A failing prefix write is an
  ordinary failed write (recovery; the next attempt ends in the same place). `runForever`/`runOnce` treat it like a chain break.
- `syncer_ingest_halts_total{reason=chain_break|parse_error|lease_lost}` counts every halt.
- `range-ingest`: a `LedgerParseError` is permanent (no chunk retry), named in the error log line; the intent stays open.

### R98 (F3): rate limits
- New `packages/shared/src/xrpl/node-throttle.ts`: `throttleHint(err)` (`retry in ~<N>ms`; `slowDown` / `tooBusy` codes; "rate limit",
  "too much load", "too busy", HTTP 429 texts), `EndpointThrottle` (pause = hint + 250 ms, 10 s without a hint, capped at 20 min; only
  extended; emits `'pause'` once per pause), `nodeThrottle` (process-wide default), `NodeThrottledError` (`retryAfterMs`), `retryAfterMsOf`.
- `NodeClient`: before each attempt, if every endpoint is paused -> `NodeThrottledError` without sending anything; a rate-limit answer
  pauses that endpoint (logged once: `Request X was refused by <endpoint>: <answer>. It rate limits this client: nothing is sent to it for
  N s`), then the request is retried on another usable endpoint (the connection moves) or fails with `NodeThrottledError`; `connection()`
  moves a live connection off a paused endpoint only when another one is usable (streams keep flowing otherwise); `connectLoop` never
  connects to a paused endpoint, sleeps until the first pause ends when all are paused, and treats a refused connection with the rate-limit
  text as a pause instead of a backoff failure.
- Callers: `LiveRunner.fetchLedger` sleeps `retryAfterMs` (debug log, no warning per fetch, backoff not grown); the head poll and
  `untilDone` honour it; `FeeStatsPoller` counts throttled samples without an error line per tick; the API's `XrplService` fails fast
  (no new client) while all its endpoints are paused.
- Metrics: `syncer_node_rate_limited_total{endpoint}`, `api_node_rate_limited_total{endpoint}` (host only, from the `'pause'` event).
- Defaults: XRPL `defaultNodeEndpoints` = `wss://s2.ripple.com`, `wss://xrplcluster.com` (profile, api config initializer, both compose
  files, `.env.example` comments, `deploy/.env.prod.example`); `GH_CATCHUP_CONCURRENCY` default 4 (config, examples, docs). Xahau keeps
  `wss://xahau.network`.

### R99 (F4): boot
- `createNodeClient` retries `server_info` forever with 1 s doubling to 30 s, or `retryAfterMs` when larger; logs each failure; a network
  mismatch still fails at once (and stops the client). SIGTERM during the loop still exits (ShutdownSignals is installed).
- `SyncerCoreModule.register({..., nodeClient})`: `NODE_CLIENT` (and its shutdown) only when `needsNodeClient(workers)`, i.e. `ingest` or
  `fee_stats` (`NODE_CLIENT_WORKERS` in `worker-registry.ts`). The boot log says `nodes=(none: no worker reads from the node)`.

### R100 (F5, F11): range-ingest
- (a) `fetchOne` retries a throttled fetch after the pause it names and a `LedgerNotAvailableError` after `retryBackoffMs` doubling to 30 s,
  as long as the wait ends before the chunk's deadline (`maxTransientWaitMs`, CLI `--max-wait <s>`, default 1200 s); otherwise (or when
  another fetch of the chunk already failed) it throws, and such an error is not retried at chunk level.
- (b) `redoOpenIntents()` runs before the first chunk: open intents overlapping `[from, to]` are merged where they overlap; for each range
  the ledgers to write are the ones committed in it plus the run's own targets in it; they are fetched and dry-parsed, the **whole** range
  is deleted (removing orphans of ledgers not written now), they are written via `writeWithRecovery` (its own intent row with the run id),
  then every member intent and the range key get `done`, and `agg_dirty` is marked. Ledgers it wrote are not counted again as "skipped"
  by the chunk loop. `closeCoveredIntents` / `isChunkKey` are gone; chunks no longer redo because of an overlapping intent.
- (c) `docs/backfill.md` "Public nodes and rate limits" (quotas, `--concurrency 2`, `--chunk 100`, `--max-wait`, expectations, an
  example); `docs/syncer.md` flag table and the intent mechanics.

### R101 (F6): probe 503 body
- `LivelinessController` of both apps: `ServiceUnavailableException` from terminus -> status 503 and `err.getResponse()` (the terminus
  result) via `@Res({ passthrough: true })` typed structurally (no `express` import; the syncer has no express types). The docs already
  described this body; `docs/observability.md` now shows both 503 bodies.

### R102 (F7, F8, F10), R103 (F9), R104 (F12)
- api-reference "Out of scope": `/v2` paths -> Ripple 404; paths outside `/v2`, `GET /` included -> `{"error":{"key":"NOTFOUNDEXCEPTION",...}}`.
- configuration.md self-check: location independent (`ROOT=$(git rev-parse --show-toplevel)`, `require.resolve('reflect-metadata',
  { paths: [apps/api] })`, absolute grep path); run from the root and from `docs/`: 12 api names, 14 syncer names.
- api-reference `ledger_interval`: computed from the bucket start; the first partial bucket of a database reads too high (example).
- `docker-compose.yaml`: no `container_name`; ports `CLICKHOUSE_HTTP_PORT` (8123), `CLICKHOUSE_NATIVE_PORT` (9000),
  `XRPL_API_PORT` (3001), `XRPL_API_METRICZ_PORT` (3003), `XRPL_SYNCER_PORT` (3002), `XRPL_SYNCER_METRICZ_PORT` (3004), `XAHAU_*` (3011,
  3013, 3012, 3014). Prod compose keeps `data-syncer-*`, `ch-keeper`, `ch-server`: commented there, in deployment.md and troubleshooting.md.
- `xahau.json` version 3: `EVR/XAH`; payments `EVR`, `4555525100000000000000000000000000000000` (EURQ), `RVN`; `XXX` removed from both
  lists. `network-profile.spec.ts` expects exactly that. Provenance note kept (syncer.md, api-reference.md), with a link to the
  re-derivation queries of the verification report.

## Files

Code: `packages/shared/src/{parsers/parser.interface.ts, parsers/accounts-created.parser.ts, ingest/build-rows.ts, ingest/ledger-writer.ts,
xrpl/node-client.ts, xrpl/node-throttle.ts (new), network/network-profile.ts, index.ts}`, `packages/shared/config/markets/xahau.json`,
`apps/api/src/{common/binary-codec.service.ts, common/tx-object.ts, xrpl/xrpl.service.ts, config/api.config.ts,
modules/prometheus/prometheus.service.ts, modules/liveliness/liveliness.controller.ts}`, `apps/syncer/src/{ingest/live-runner.ts,
cli/range-ingest.ts, core/node-client.provider.ts, core/syncer-core.module.ts, app.module.ts, worker-registry.ts, config/syncer.config.ts,
fees/fee-stats-poller.ts, modules/prometheus/prometheus.service.ts, modules/liveliness/liveliness.controller.ts}`.

Tests: `packages/shared/src/{ingest/build-rows.spec.ts (+snapshot), parsers/accounts-created.parser.spec.ts, xrpl/node-client.spec.ts,
network/network-profile.spec.ts}`, `packages/shared/test/{build-rows.e2e-spec.ts, ledger-writer.e2e-spec.ts}`,
`packages/shared/test/fixtures/xahau/flag/*` (new), `apps/api/src/{common/binary-codec.service.spec.ts, common/tx-object.spec.ts,
xrpl/xrpl.service.spec.ts, config/api.config.spec.ts, modules/prometheus/prometheus.service.spec.ts}`, `apps/api/test/{support/fixtures.ts,
xahau-flag.e2e-spec.ts (new), main.e2e-spec.ts}`, `apps/syncer/src/{app.module.spec.ts, core/node-client.provider.spec.ts,
config/syncer.config.spec.ts, fees/fee-stats-poller.spec.ts, cli/range-ingest.spec.ts, modules/prometheus/prometheus.service.spec.ts}`,
`apps/syncer/test/{app.e2e-spec.ts, live-runner.e2e-spec.ts, range-ingest.e2e-spec.ts, range-ingest-cli.e2e-spec.ts, synthetic-chain.ts}`.

Config/docs: `docker-compose.yaml`, `docker-compose.prod.yaml`, `apps/{api,syncer}/.env.example`, `deploy/.env.prod.example`,
`docs/{api-reference, architecture, backfill, configuration, data-model, deployment, development, observability, operations, syncer,
troubleshooting}.md`, `docs/superpowers/plans/2026-10-15-ripple-dropin.verification.md` (section "Fixes after verification").

## Tests: RED / GREEN evidence

| Change | RED (before the implementation) | GREEN |
| --- | --- | --- |
| R95 unit (`build-rows.spec`, `-t R95`) | 4 failed `... has no Account`, 1 passed (missing Account still rejected) | 110 / 110, golden snapshot written |
| R95 parent of a created account | 1 failed (parent `""`) | 19 / 19 |
| R95 shared e2e (`build-rows.e2e`, impl stashed) | 17 failed: `Ledger 26570752: transaction 0A6ECA79... has no Account` | 67 / 67 |
| R97 codec unit (with a `roundTrip = decode(encode)` stub) | 4 failed (`81 00` blob, tree root, `""` round trip, nested empty fields), 3 passed | 48 / 48 |
| R97 TxService | 2 failed (JSON shows the zero account) | 49 / 49 (cache test also spies `roundTrip`) |
| R95/R97 api e2e `xahau-flag` (codec + tx-object stashed) | 7 failed / 1 passed | 8 / 8 |
| R96 unit `LedgerParseError` | compile error (class missing) | 111 / 111 |
| R96 live-runner e2e | 3 failed: both parse tests **time out at 180 s** (the runner recovered forever), halt counter missing | 3 / 3; whole suite 28 / 28 |
| R96 range-ingest e2e | 1 failed (3 attempts, plain error) | pass |
| R98 NodeClient throttle | compile error (no `throttle` option / module) | 19 / 19 (7 new) |
| R98/R99 defaults, provider, app module (src stashed) | 18 failed / 28 passed | 57 / 57 |
| R98 live runner waits the hint | refetch after 21 ms (backoff) instead of >= 580 ms | pass |
| R98 fee poller | 1 failed (error line per throttled tick) | 35 / 35 |
| R98 rate-limit counters (both apps) | 1 failed each | pass |
| R98 XrplService fail-fast | 1 failed | 19 / 19 |
| R99 syncer app e2e (real `main.ts`, src stashed) | 2 failed, both **time out at 30 s** (aggregator boot blocks on the node; rate-limited boot exits) | 10 / 10 |
| R100 range-ingest e2e (old file + only the option field) | 8 failed / 8 | 70 / 70 |
| R100 CLI `--max-wait` | 1 failed | 20 / 20; CLI e2e 7 / 7 (the gap test needed `--max-wait 2`, else it waits the 20 min budget: it timed out at 240 s first) |
| R101 syncer app e2e / api `main.e2e-spec` | 2 failed / 1 failed (toolbox body) | 10 / 10, 12 / 12 |
| R104 `network-profile.spec` | 1 failed (version 2 with XXX) | 19 / 19 |

Full suites at the final code commit (`9f2703a`):
- `pnpm build`: exit 0.
- `pnpm test`: **1911 pass / 0 fail** (shared 578, syncer 351, api 982); output clean (no console lines).
- `pnpm -r test:e2e`: first full run (at `c4b4f8e`) **2093 / 2093** (shared 350, syncer 160, api 1583, incl. `main.e2e-spec.ts`), with two
  `@clickhouse/client` "socket was closed" warnings from the pre-existing `kills the queries ...` test (also in the verifier's Step 1 log),
  now filtered in `9f2703a`. Second full run (at `9f2703a`): shared 350 / 350 (clean), syncer 160 / 160, api **1582 / 1583**: one
  intermittent failure, see Concerns; 9 isolated reruns of that suite pass 33 / 33; a third full api run passes **1583 / 1583**.

## Live re-check

Own compose project, scratch database, built dist, `env -i` with explicit variables, run from the scratch folder (no `.env` read):

```
CLICKHOUSE_HTTP_PORT=18124 CLICKHOUSE_NATIVE_PORT=19001 docker compose -p t38fix -f docker-compose.yaml up -d clickhouse
   -> t38fix-clickhouse-1 started next to the user's stopped data-api-clickhouse: no name conflict (R103 live)
node head.js wss://xahau.network          -> 26574278   (flag ledger 26574080 = 103805 x 256; start 26574060)
GH_ENV=local GH_NETWORK=xahau GH_NODE_ENDPOINTS=wss://xahau.network GH_WORKERS=ingest GH_CATCHUP_CONCURRENCY=1
  GH_SYNC_START_LEDGER=26574060 GH_RUN_MIGRATIONS_ON_BOOT=true GH_CLICKHOUSE_URL=http://127.0.0.1:18124
  GH_CLICKHOUSE_DATABASE=xahau_t38fix GH_HTTP_API_PORT=23102 GH_METRICZ_PORT=23110 node apps/syncer/dist/main.js
```

Syncer log (colours stripped):

```
21:25:30 LOG  [NodeClient] Connected to wss://xahau.network
21:25:30 LOG  [LiveRunner] Holding the xahau syncer lease as ...:48862:1d4138ce-...
21:25:30 LOG  [LiveRunner] Nothing is committed yet: starting at ledger 26574060
21:25:33 WARN [NodeClient] Request ledger was refused by wss://xahau.network: rate limit: units quota (50000 per 10s) exhausted,
                           retry in ~6280ms. It rate limits this client: nothing is sent to it for 6.5 s
21:25:33 DEBUG [LiveRunner] Fetching ledger 26574064 waits 6529 ms for a rate-limited node
21:25:36 LOG  [LiveRunner] Committed ledgers 26574060-26574063; head 26574281, lag 218
21:25:41 WARN [NodeClient] Request ledger was refused by wss://xahau.network: rate limit: units quota (50000 per 10s) exhausted,
                           retry in ~8148ms. It rate limits this client: nothing is sent to it for 8.4 s
21:25:41 DEBUG [LiveRunner] Fetching ledger 26574066 waits 8398 ms for a rate-limited node
21:25:46 LOG  [LiveRunner] Committed ledgers 26574064-26574065; head 26574284, lag 219
21:25:49 LOG  [Shutdown] Received SIGTERM: shutting down
21:25:49 LOG  [LiveRunner] Released the syncer lease
21:25:49 LOG  [Shutdown] Shutdown complete
```

The node answered with its rate limit 3 s after the start (Xahau ledgers of 160 to 180 transactions; about 2 to 3 per 10-second window at
concurrency 1). Per the rule I stopped the syncer on that answer (the SIGTERM landed 16 s later, after a second answer, both honoured
exactly, each logged once, nothing sent meanwhile). **The live flag ledger 26574080 was not reached**: 26574060-26574065 committed.

Then, without the node: the flag ledger 26570752 recorded from the same node earlier that day was ingested into the same scratch database
through the built `range-ingest` (`FixtureLedgerSource`; `Chunk [26570752,26570752] done ... 1 ledgers written`), and the built API was
started on it (`GH_NODE_ENDPOINTS=ws://127.0.0.1:1` on purpose, so it used the bundled Xahau definitions and never touched the public
node; throwaway API key, deleted afterwards). `check-flag.js` against `/v2/ledgers/<n>?binary=true&expand=true`:

```
26570752: 37 transactions, 0 blobs not re-hashing, 22 with 73 00 81 00, tree root C39A304D...ED854646 = transaction_hash: true
          JSON (?expand=true): 22 UNLReports, Account values [""]
26574060..26574065 (live): 161, 174, 173, 164, 170, 176 transactions; 0 blobs not re-hashing; tree root = transaction_hash: true (6 / 6)
```

Requests to `wss://xahau.network` in this round: 3 (fixture: `server_info`, `server_definitions`, `ledger`), 1 (binary form), 1 (head),
and the syncer's own (`server_info`, `subscribe`, validated head, ledgers one at a time: 6 committed, 2 refused). Never more than one in
flight. Teardown: syncer and API stopped with SIGTERM; `docker compose -p t38fix -f docker-compose.yaml down -v` removed
`t38fix-clickhouse-1`, `t38fix_default`, `t38fix_clickhouse-data`; no `t38fix` container, volume or network and no `dist/main.js`
process remain; ports 18124, 19001, 23101, 23102, 23110, 23111 free. The user's containers (`data-api-clickhouse`, `ch-keeper`,
`ghv2-clickhouse`, `rhyza-*`, `supabase_*`) were not touched; no testcontainers left.

## Self-review

- The throttle is process-wide on purpose (a pause must also hold for the validations collector's per-node clients and for a client the
  API makes again after a failed start); tests isolate with their own `EndpointThrottle` or `nodeThrottle.clear()`.
- A connection to a paused endpoint is kept while no other endpoint is usable, so the `ledger` / `validations` streams keep flowing during
  a pause; only requests are held back. A pause is only ever extended, never shortened.
- The LiveRunner's prefix write after a `LedgerParseError` reuses the writer: safe because `write()` parses the whole batch before its
  first insert (asserted by the writer e2e: `insert` never called), and the prefix has other batch bounds, so other dedup tokens.
- The intent redo deletes the whole recorded range only after every replacement ledger is fetched and parsed (the existing
  `writeWithRecovery` guarantee), so a redo that cannot fetch leaves committed rows intact and the intents open (existing test still green).
- `roundTrip` keeps `decode(encode())` for everything without an empty AccountID (routed through the public `encode`/`decode`, so the
  existing cache tests that spy on them keep their meaning); the sentinel path can only throw when a sentinel collides, which falls back.
- Lessons of `endpoint-context.md` followed: no value `express` import in the probe controllers (structural type); new api e2e uses the
  harness; no FINAL / ORDER BY changes in queries.
- Prettier run on every changed TypeScript file; `tsc --noEmit` clean in all three packages.

## Concerns

1. **Live re-check incomplete by rule**: `wss://xahau.network` rate-limited the syncer 3 s into the run, so it was stopped before the flag
   ledger. The flag-ledger path was verified from the built dist on a ledger recorded from the same node (offline), and the R98 behaviour
   was observed live (hint honoured, one log line per pause, no request during a pause). At these Xahau ledger sizes the public node lets
   about 2 to 3 ledgers per 10 s through at concurrency 1, close to the 2.7 per 10 s the chain produces: a Xahau syncer on the public node
   barely keeps pace; a node of its own is advisable.
2. **One intermittent api e2e failure** in the second full run: `errors.e2e-spec.ts` "/v2 and /v2/ are Ripple 404s too" got a 404 whose
   body supertest did not parse (`{}`, i.e. not the JSON 404). Not reproduced in 9 isolated reruns of the suite nor in the other full
   runs; no code on that path (routing, `NotFoundController`, filters, key guard) changed in this round. Possibly the per-request
   listen/close of supertest under load (the harness notes a similar Node 24 issue); left as is, worth a look if it recurs.
3. **R99, letter vs intent**: the shared `NodeClient` is made only for `ingest` and `fee_stats`. The validations collector never used the
   shared client (it opens one per node and checks their network itself), so it does not cause the shared one to be created.
4. `range-ingest --concurrency` keeps its default 8 (R98 changed only `GH_CATCHUP_CONCURRENCY`); the backfill doc recommends 2 on public
   nodes. An intent redo inside an index-list run writes the committed ledgers and the listed ones of the range and deletes the orphan
   rows of the others in it (they were not committed), which is the consistent state the intent stands for.
5. `BinaryCodecService.decode(hex)` of a raw node blob with `81 00` still yields the zero account (codec limitation, documented); the
   API never decodes node blobs (it uses `roundTrip` on stored JSON).
6. The golden snapshot of the flag ledger adds 3,297 lines to `build-rows.spec.ts.snap`.

## Files outside the repo

All in `/private/tmp/claude-501/-Users-golobitch-github-com-GateHubNet-data-api-new/096aa099-861f-4246-9d06-6b477dcfe4c1/scratchpad/t38fix/`
(created by me): the recording (`rec-flag/`), `fetch-binary.js`, `head.js`, `check-flag.js`, `ingest-flag-fixture.js`, `selfcheck.sh`,
`patches/r100.py`, `range-ingest.new.ts` (a copy used for the RED run), suite logs (`final*-*.log`, `errors-stress.log`), live logs
(`live-syncer.log`, `live-syncer.clean.log`, `live-api.log`), `notes.md`. Deleted (mine, inside that folder): the throwaway API key file,
pid files, one `.bak`. No stray file elsewhere; nothing deleted outside that folder.

## Fix round 1 (after review)

The reviewer confirmed R95–R99 and R101–R104 and found one Important issue in R100 (it became ruling R105) plus seven minor
ones. All nine items are fixed, each test first. No public node was contacted in this round.

| # | Item | Commit | Change | RED / GREEN |
| --- | --- | --- | --- | --- |
| 1 | R105: the wait budget was a deadline on the whole fetch phase | `d114173` | `FetchPhase`: every ledger fetched restarts `--max-wait`. A chunk fails only when the budget passes with no ledger arriving, or when every worker waits past that point (so a pause longer than the budget, with nothing in flight, still fails at once). A ledger the node really lacks fails in bounded time. The chunk-failure log names `--max-wait (N s)`. Docstring, `--help`, syncer.md and backfill.md are corrected. The hourly-quota claim now says when 1200 s covers the ~930 s pause (a pause that starts within about 4.5 min of the last ledger), and that a pause capped at 20 min never fits | RED: 4 failed (log text; slow fetches + throttle → chunk failed; bounded-time test; abandon test waited 10.3 s). GREEN: range-ingest suites 80 / 80 four times in a row. One intermediate flake (a budget of 0 still waited 1 ms) was fixed with `>=`, so a budget of 0 means no waiting |
| 3 | `abandon()` only checked before a sleep | `d114173` | A failing fetch calls `phase.fail()`, which wakes every sleeping worker. The woken workers stop with `FetchAbandoned`, which is not recorded as a failure, so the real cause is what the chunk reports | the abandon e2e test: < 3 s instead of the 10 s pause |
| 2 | The intent redo refetched committed ledgers | `bc7c227` | A committed ledger is kept. Only the uncommitted ledgers this run ingests in the range are written, and only the uncommitted spans are deleted (new `uncommittedSpans`; orphan rows still go). An all-committed range is closed without a fetch | RED: 5 failed. GREEN: 80 / 80 twice. The F5 test now asserts that the committed L(1)..L(3) are not fetched; the live-syncer-appears test triggers on the first uncommitted ledger; 2 new unit tests for `uncommittedSpans` |
| 4 | `NodeThrottledError(0)` when attempts ran out with another endpoint usable | `77498a3` | The connection moves and the node's own answer is rethrown (nothing to wait for; the next request goes to the other endpoint) | RED 1 failed → GREEN |
| 5 | Credentials in NodeClient logs | `77498a3` | `redactEndpoint()` (`scheme://host:port`) is used in every NodeClient log line and in the invalid-endpoint error. Prometheus labels already used the host only | RED 2 failed (path, userinfo and query in logs; raw endpoint in the error) → GREEN 22 / 22 |
| 6 | Concurrency overclaims | `550c218` | The two `.env.example` files, the `SyncerConfig` comment, configuration.md and syncer.md now state what was observed (s2 not throttled at 2; xahau.network throttles at 1, waited out). backfill.md's "100 to 370 ledgers per window" contradicted that and now says the same (the only edit beyond the listed lines) | doc only (config spec 26 / 26) |
| 7 | API error noise while the node is paused | `6d87348` | `logFailure()` (route interceptor and Ripple filter): a `NodeThrottledError` is logged once per pause, at warn, without a stack. The 500 answer is unchanged | RED 3 failed (stub module) → GREEN 29 / 29 |
| 8 | `xahau-flag.e2e-spec.ts` used `h.http()` | `151317b` | Uses `(await h.api()).get` | 8 / 8 |
| 9 | Halted-503 example in observability.md | `31d51f4` | The real body from the syncer e2e test (captured by a temporary write that was then reverted), with `details`, hashes shortened | doc only |

Suites at `31d51f4`: `pnpm build` exit 0; `pnpm test` **1919 / 1919** (shared 581, syncer 353, api 985); `pnpm -r test:e2e`
**2096 / 2096** (shared 350, syncer 163, api 1583, including `main.e2e-spec.ts`). Both outputs are clean: no console lines.

Concerns of this round:
- The new budget is enforced per chunk attempt. A chunk that keeps hitting pauses each a little under the budget keeps waiting,
  as long as a ledger arrives within every budget window. That is the intended "slow, not failing" behaviour.
- `FetchAbandoned` cannot interrupt a request that is already in flight. Such a request ends within its own timeout
  (`GH_LEDGER_FETCH_TIMEOUT_MS`, 120 s) before the attempt ends.
- The intermittent `errors.e2e` failure from the previous round did not recur in this round's full run.
