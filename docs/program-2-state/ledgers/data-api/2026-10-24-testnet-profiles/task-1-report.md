# Task 1 report: the four network profiles

Status: DONE_WITH_CONCERNS (concerns: the XRPL Testnet majority hold differs from the spec's table; the commit trailer; a formatter drift in three untouched files).

Commit: `a254fa5 feat(shared): profiles for XRPL Testnet and Xahau Testnet` (branch feat/explorer-data-2). Not pushed.

## What I implemented

- `packages/shared/src/network/network-profile.ts`: `NetworkName` of four names, `NetworkFamily`, `NetworkKind`, `NETWORK_NAMES` (in the order of the brief),
  `isNetworkName` (own keys of `PROFILES` only), `networkChoiceText`, `networkLogText`; `NetworkProfile` gains `family`, `kind`, `displayName`, `acceptedNodeNetworkIds`
  (after `networkId`) and `defaultUnlValidators` (after `defaultUnlPublishers`); `PROFILES` has the four records with the values of the table (the mainnet values that
  existed keep theirs); `getNetworkProfile` now goes through `isNetworkName` (same message, same signature). `definitionsFallback` of the testnets reads
  `config/definitions/<name>.json`, which does not exist yet, so it is `undefined` until Task 4.
- `packages/shared/config/markets/xrpl-testnet.json`, `xahau-testnet.json`: `{ "version": 1, "tradeMarkets": [], "paymentCurrencies": [] }`.
- `apps/api/Dockerfile` and `apps/syncer/Dockerfile`: the two testnet markets files added to the list of files the build checks in the deployed package.
- `packages/shared/src/xrpl/node-client.ts`: the two placeholder rows `'xrpl-testnet': [1]`, `'xahau-testnet': [21338]` in `ACCEPTED_NETWORK_IDS` (the `xahau` row
  stays `[21337, 21338]` until Task 3).
- Tests: `network-profile.spec.ts` (the brief's tests, plus one: `reads GH_NETWORK for a testnet`; the existing publisher literals of the old test now use the shared
  constants), `migrate.e2e-spec.ts` case `(g)`.
- Everything is exported from `src/index.ts` and `src/network/index.ts` (both `export *` the network profile; I checked the built `dist`).
- Every existing reader of `NetworkName` compiled unchanged (`pnpm build` green for shared, api, exporter, syncer).

## Step 2: the two facts the plan leaves open

### Xahau Testnet's validators: match

`Xahau/Xahau-Testnet-Docker`, `store/etc/validators-xahau.txt`: last changed in commit `01ed74b5ebf34b27c8d5635b6d03972cc23346da` (2024-10-25), the file is the same at
the repo head `87eeb5db5f81f0d0b526f6365e2aede14cd2559d` (2025-12-18). Its `[validators]` holds exactly the four keys of the table (`nHBoJCE3…`, `nHUVv4g4…`,
`nHBvr8av…`, `nHUH3Z8T…`), nothing else (it also has an `[import_vl_keys]` with `ED264807…5860`, the key of `vl.altnet.rippletest.net`). Written in the comment above
`defaultUnlValidators`.

### XRPL Testnet's majority hold: NOT the table's 14 days. I set 1800 s (30 minutes)

Method. The brief's route (account_tx of `rrrrrrrrrrrrrrrrrrrrrhoLvTp`) does not work: that account is the `RegularKey` of many blackholed accounts, so account_tx lists
their transactions, and the `EnableAmendment` pseudo-transactions are not indexed under it (40 pages of 200 from the Clio, back to ledger 15.2M, 0 EnableAmendment;
I stopped there). Instead I walked the `Amendments` ledger object (index `7DB0788C…6EF4`) back through `PreviousTxnID` / `PreviousTxnLgrSeq` (every EnableAmendment
touches it): `ledger_entry` at `PreviousTxnLgrSeq - 1`, then `tx` of the hash. One request every 2 s against `https://clio.altnet.rippletest.net:51234/` (node `fetch`,
the system `curl` fails to verify the certificate on this machine; `openssl s_client` verifies the Amazon chain fine). Sixteen steps gave seven complete
pairs (got majority, flags 65536, then enabled, flags 0), read 2026-10-24:

| amendment | got-majority ledger | tx | closed (UTC) | enabling ledger | tx | closed (UTC) |
|---|---|---|---|---|---|---|
| 0F48FF561C709540328F31F1C97FD512ACC8B4E42138A161CB0E21ECA292540B | 21394177 | F7077524E6D29D05EB8CAAA24B6B2F2623911D52D9D92F6C21088F914D404B63 | 2026-10-09T05:11:50 | 21394945 | 7A730EDFD2E4E248B1E0F0D30928172381E200D9BA543502B21F075CA1FD30E3 | 2026-10-09T05:54:40 |
| 3298D47E1F3A8A24FECAA30F699B8FE1DD234E072834BA099AD8180FFCE0FEC4 | 20688385 | 5D961F3D5613194B3E05561C298D3D2D2781A96B5390357AA0F1507441CC47DD | 2026-09-12T05:07:01 | 20689153 | 827E60B95C2BED6D8BEA0B68E80957CC372B8EF94564DF22F50C963ACC7E7A81 | 2026-09-12T05:47:10 |
| 21B8D2F76F68E11E9C077A43BBBC394136E9987E99DDB73966DD68419467E431 | 19481857 | C2B811A997F8E93B6703719E5A9B52461333B1360322F5921896ADDB3FD375B7 | 2026-07-30T05:05:10 | 19482625 | 9D49882AE6CC6449D24AF0ECD386F8EA90A427A91F70B90E39B59847058C94BA | 2026-07-30T05:44:50 |
| 303ACB16CF8DBD3B5C34F131A9D19A7DE01AE05F480A8A682B869D1B4AAC8CFC | 17185537 | 861B7E421BBC183E97FC451CF07FD946126D4EC8C910F48806D1C29C3AD01CDC | 2026-05-08T01:38:30 | 17186305 | CFAD98C5BC84DB7574490D2070727DF50060937554A3D260630ED739B984F3DA | 2026-05-08T02:17:42 |
| 677E401A423E3708363A36BA8B3A7D019D21AC5ABD00387BDBEA6BDE4C91247E | 15017729 | 3DEF1933D85DAC18D6FF7822073728698A2D1336C51160E17C1B11C58E040200 | 2026-02-19T05:10:31 | 15018497 | A63A3BCF34B5F7A374FAE975C7E6A4ADF8D0C13F5A58FF08CE72C20C5F7D1A14 | 2026-02-19T05:50:21 |
| 138B968F25822EFBF54C00F97031221C47B1EAB8321D93C7C2AEAF85F04EC5DF | 14854145 | 25625FF2533E30E508B04B6817FCA72520834D0E8091AB1342A0EF8B656AB36D | 2026-02-13T05:12:41 | 14854913 | A1DBA3188B75481A0FD9B045A7F3F339C0A5FF256330428BF43D27BDEBF49F49 | 2026-02-13T05:52:31 |
| A730EB18A9D4BB52502C898589558B4CCEB4BE10044500EE5581137A2E80E849 | 14635521 | 456EFFE3703012D636D3EEF5A7276B400893E9B22D5B0D131DAE13052824E6D4 | 2026-02-05T05:11:21 | 14636289 | DBAC85714EEC30CD79B1EFECC7474B53DAF7A3E09C1907C2A4E2D86D0FD5D4EB | 2026-02-05T05:51:22 |

Result. All seven: enabled exactly 768 ledgers (3 flag intervals) after the got-majority ledger; close-time differences 2352 to 2570 s (39 to 43 minutes), not 14
days (1,209,600 s). The hold H is tested at each flag ledger against the parent close time of that ledger, so the three voting ledgers give bounds: with the
parent close times of the got-majority flag ledger and of the flag ledgers 512 and 768 ledgers later (12 more `ledger` requests), `1711 s < H <= 2359 s` over the
seven pairs (per pair: 1711/2570, 1610/2410, 1591/2380, 1559/2359, 1590/2390, 1591/2390, 1590/2408). A round value in that range is 30 minutes (1800 s); I pinned it and
the comment says which part is measured and which inferred. The setting is not published, so this is an inference: the owner may want to confirm "30 minutes" with
Ripple (rippled accepts whole minutes, hours, days or weeks; any whole number of minutes from 29 to 39 fits the data).

Consequence: `majorityHoldSeconds` feeds `expectedActivation = majority.since + hold` (apps/api/src/validators/amendment-status.ts:304). With 1800 s the answer for a
testnet amendment is the earliest bound; the real enabling lands on the third flag ledger after the majority (about 41 to 43 minutes after the majority began).

### Xahau Testnet's majority hold: 432000 s, the software default (no chain pair)

`wss://xahau-test.net` (build `2026.10.16-tmp-dev`, `network_id` 21338, confirmed) holds ledgers 13293254 to 13463527, about 5.7 days; the `Amendments` object last
changed in ledger 13236737, before that range (`tx` and `ledger_entry` there: not found). So no pair. `store/etc/xahaud.cfg` of `Xahau-Testnet-Docker` (commit
`1dd22588ce2dd8826488e6da1b65e304776a95a1`, repo head `87eeb5db…`) has no `[amendment_majority_time]`, so xahaud's compiled default applies:
`defaultAmendmentMajorityTime = std::chrono::days{5}` in `include/xrpl/protocol/SystemParameters.h` of `Xahau/xahaud` at `5c05e107c0211dcedb7adcf73dab1f6012747fe7`
(dev, 2026-10-21). 5 days = 432000, the table's value. Caveat: that is the docker image's configuration and the software default; the validators of the real testnet
may configure otherwise, and the chain history could not confirm it.

Also confirmed while there: `vl.altnet.rippletest.net` serves a version 1 list signed by `ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860`
(sequence 59, 6 validators).

## TDD evidence

RED (before the implementation; ts-jest fails to compile the new spec, which is how "NETWORK_NAMES is not exported" shows):
`cd packages/shared && npx jest --config jest.config.js network-profile` ->
```
src/network/network-profile.spec.ts:13:3 - error TS2305: Module '"./network-profile"' has no exported member 'networkLogText'.
src/network/network-profile.spec.ts:33:7 - error TS2353: Object literal may only specify known properties, and 'family' does not exist in type 'Omit<NetworkProfile, "definitionsFallback">'.
src/network/network-profile.spec.ts:74:5 - error TS2322: Type '"xrpl-testnet"' is not assignable to type 'NetworkName'.
... (and acceptedNodeNetworkIds, NETWORK_NAMES implicit any)
Test Suites: 1 failed, 1 total   Tests: 0 total
```
Runtime form of the same failure, with the old `network-profile.ts` from HEAD: `getNetworkProfile('xrpl-testnet')` -> `Unknown GH_NETWORK "xrpl-testnet"` (so
`(g)` would fail at `clickHouseConfigFromEnv`).

GREEN: `pnpm --filter @gatehub/data-api-shared test -- network-profile` -> `Tests: 33 passed, 33 total`. `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate`
-> `Tests: 164 passed` with `✓ (g) GH_NETWORK=xrpl-testnet creates and migrates xrpl_testnet`.

## Full verification (before the commit, after the last code change except two comment words)

- `pnpm build` exit 0 (shared, api, exporter, syncer).
- `pnpm test` exit 0: shared 1635, exporter 4, syncer 1286, api 1844 tests, all suites passed. No worker-spec timeout seen.
- `pnpm --filter @gatehub/data-api-shared test:e2e` exit 0: 15 suites, 876 tests (testcontainers ran without `TESTCONTAINERS_RYUK_DISABLED`).
- The api and syncer packages only changed their Dockerfiles, so I did not run their `test:e2e`.
- `npx prettier --check` on every file I changed: clean. After the last edit (two comment words in `network-profile.ts`) I re-ran `pnpm build` (exit 0) and the focused
  spec (33 passed); not the whole suite again.

## Self-review

- Brief against diff: every field of the table is pinned in the spec's `FOUR` rows (`toMatchObject` plus a separate `toEqual` for `acceptedNodeNetworkIds` with
  `undefined`), the six tests of Step 3 are present with the brief's names, (g) follows the brief's recipe, the Dockerfile loops list the markets files, the two
  placeholder rows are in `node-client.ts`. `account-flags.ts` untouched (`profile.name === 'xahau'` until Task 4).
- The Dockerfile edit puts the two files on a continuation line of the `for f in …` list; I did not build the images (needs the npm token secret).
- Small additions beyond the brief: the test `reads GH_NETWORK for a testnet`; module-level constants in the spec so the old test and `FOUR` share the publisher texts.
- `clickhouse.config.ts` still says "(`xrpl` / `xahau`)" in the doc of `clickHouseConfigFromEnv`; it is not in this task's files.

## Concerns / things for the controller

1. **XRPL Testnet `majorityHoldSeconds` is 1800, not the table's 1209600** (evidence above). Two follow-ups: the spec (section 1, D13) and the plan table still say 14 days for
   XRPL Testnet; Task 11's docs ("Step 2 for the majority holds") must say 30 minutes, source "7 EnableAmendment pairs", and Task 5's tests that compute an expected
   activation on `xrpl-testnet` (if any) must use 1800. It is an inferred round value inside a measured range (1711, 2359] s: put it to the owner/Ripple as a
   confirmation ("Inputs needed from the owner"), not as a missing input.
2. **Trailer.** The plan and IMPLEMENTER.md say `Co-Authored-By: Claude Opus 5.5`; the session's attribution instruction (and my model) is Sonnet 5.5, so the commit ends with
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (the ledger's C8 left this open). Change it in the next commits if the owner wants Opus.
3. `pnpm format` reformats three files this task does not touch (`packages/shared/src/clickhouse/clickhouse.module.ts`, `src/util/helpers.ts`, `src/util/time.ts`:
   existing drift). I reverted those three with `git checkout --` and formatted only my files, so the Global Constraints' "pnpm format before each commit" would
   dirty the tree again for every task; someone should decide whether to commit that drift once.
4. Not run: the Docker image builds (the `for f` check of the Dockerfiles is only exercised there).
5. The recording scripts (`xrpl-testnet-majority.mjs`, `walk.mjs`, `bounds.mjs`) are in the session scratchpad, not in the repo.
