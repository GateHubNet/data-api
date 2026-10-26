# Task 4 report: Testnet ledgers, definitions and account flags

**Status: DONE_WITH_CONCERNS** (was NEEDS_CONTEXT; the controller ruled, see "Ruling applied" at the end). Committed with the two testnet
rows of `tx-object.e2e-spec.ts` skipped until Task 5. The sections below up to "Ruling applied" are the original report.

## Blocker: the testnet API seeds need Task 5's amendments loader

`startHarness({ seed: 'xrpl-testnet-recorded' })` boots the whole `AppModule` with `GH_NETWORK=xrpl-testnet`. `ValidatorsModule`
builds `loadAmendmentsConfig(profile, config.amendmentsConfig)` (`apps/api/src/validators/validators.module.ts:29`), which reads
`config/amendments/<profile.name>.json` and, for any file, refuses `raw.network !== profile.name`
(`packages/shared/src/validators/amendments-config.ts:184,215`). So every test of the two new `describe.each` rows fails in
`beforeAll` with

```
Invalid amendments config: .../packages/shared/config/amendments/xrpl-testnet.json: ENOENT: no such file or directory
```

(28 tests: 14 per testnet; the 67 other tests of `tx-object` + `account-flags` pass). Reading the family's file
(`config/amendments/<profile.family>.json`) and accepting `raw.network` equal to `profile.family` is exactly Task 5's
"Interfaces / Produces", plus its `retired` and `enabled` rules, so it is not a one-line fix I should make inside Task 4, and a
stub file `config/amendments/xrpl-testnet.json` would make Task 5's Step 2 RED (which expects that file missing) wrong. Task 5
consumes only Tasks 1 and 2, so it can run before Task 4.

Verified with temporary stand-ins: I created `config/amendments/xrpl-testnet.json` and `xahau-testnet.json` as
`{"network":"<name>","updated":"2026-10-24","amendments":[]}`, ran everything below with them in place, and then **removed them**
(they are not in the tree; copies are in my scratchpad `stubs/`). With them: `tx-object` 71/71, all other suites unchanged.

Options for the controller (any of them is one message to me):
1. Run Task 5 (or at least its loader part) first, then resume me: I commit unchanged. (Its README edit and mine touch the same
   file `packages/shared/test/fixtures/README.md`, so resume me before Task 5 starts committing, or let it work on the dirty
   tree and name its own hunks.)
2. Tell me to commit now with the 28 testnet tests red until Task 5 (the commit message would say so).
3. Tell me to add test-only scaffolding to the two testnet `describe.each` rows (`startHarness({ seed, env: { GH_AMENDMENTS_CONFIG } })`
   with a temp file named for the testnet), which Task 5 would then have to delete.

## What I implemented

- **Recordings** (the public testnet nodes answered every request; no throttling, no retries needed; requests paced at 300 to 500 ms):
  - `packages/shared/test/fixtures/xrpl-testnet/recorded/`: ledgers 21799042, 21799043, 21799044 from
    `wss://s.altnet.rippletest.net:51233` (rippled 3.4.1, network id 1), recorded 2026-10-24 23:52 UTC: 22 transactions
    (4 Payments of which 2 of XRP, 5 OfferCreate, 1 AMMDeposit, 2 Batch, 10 OracleSet), all `tesSUCCESS`. The brief's search
    (`--want Payment,OfferCreate,AMMDeposit,AMMWithdraw --scan 400`) put `OfferCreate` and `Payment` in the head (21799215) but its
    Payments are all of issued currencies, and the new test needs an XRP payment; I listed 150 ledgers with a throwaway script and
    took the ledgers around an AMMDeposit that hold XRP payments. `AMMWithdraw` was not found in 400 ledgers.
  - `packages/shared/test/fixtures/xahau-testnet/recorded/`: ledgers 13464678, 13464679, 13464680 from `wss://xahau-test.net`
    (xahaud 2026.10.16-tmp-dev, network id 21338), recorded 2026-10-25 00:01 UTC: 14 transactions, all `tesSUCCESS`: 12 `Entropy`
    pseudo-transactions (4 per ledger, `Account: ""`), a `URITokenCreateSellOffer` and a Payment of 1 drop of XAH. The brief's search
    found only a Payment (13465104); a wider one (3000 ledgers, stopped at 658 with all found) found `SetHook` at 13464573 and
    `URITokenMint` at 13464676. No XAH payment is within three ledgers of either (mint to payment: 13464676 to 13464680), and the
    test needs one, so the three ledgers are the offer and the payment. Both are written up in `test/fixtures/README.md`.
  - `config/definitions/xrpl-testnet.json` and `xahau-testnet.json` are copies of the two `server_definitions.json`. Facts: the
    XRPL Testnet file is byte for byte `xrpl.json` (same rippled 3.4.1); the Xahau Testnet file differs from `xahau.json` only in
    `features` (amendment state) and `hash`. Both define `Entropy`, `Cron`, `CronSet` (the mainnet file already did).
- `packages/shared/src/network/account-flags.ts`: `accountFlagsOf` takes the hand list when `profile.family === 'xahau'`, else
  `LEDGER_ENTRY_FLAGS.AccountRoot` of the profile's own definitions; cache still keyed by name; comments updated.
- `apps/api/Dockerfile`, `apps/syncer/Dockerfile`: the two testnet definitions files added to the file loop (checked the same list with
  `test -f` against `packages/shared`).
- `apps/api/test/support/fixtures.ts`: seeds `xrpl-testnet-recorded` and `xahau-testnet-recorded` (`SeedName`, `DIRS`,
  `SEED_NETWORK`, `XRPL_TESTNET_RECORDED_DIR`, `XAHAU_TESTNET_RECORDED_DIR`).
- `apps/api/test/tx-object.e2e-spec.ts`: the two rows in `describe.each` and the CTID/native-currency test, as in the brief; plus
  one change the brief does not list (see "Concerns" 2).
- Tests: `account-flags.spec.ts` (new, the three cases of the brief), `network-profile.spec.ts` (the two definitions cases; the
  Xahau one also asserts the file has no `LEDGER_ENTRY_FLAGS`).

## TDD evidence

RED 1 (account flags), `pnpm --filter @gatehub/data-api-shared test -- account-flags network-profile` before the change:
```
FAIL src/network/account-flags.spec.ts
  ● accountFlagsOf › gives Xahau Testnet the hand list of Xahau
    The definitions of xahau-testnet name no AccountRoot flags
Tests: 1 failed, 37 passed, 38 total
```
Expected: the message of the brief. GREEN after the change: `Test Suites: 2 passed, Tests: 38 passed`.

RED 2 (definitions). The brief records first, so the two definitions tests passed on arrival; to see them fail I moved the two
files away (and back): `✕ bundles the definitions of XRPL Testnet ...`, `✕ bundles the definitions of Xahau Testnet ...`,
`TypeError: Cannot read properties of undefined (reading 'TRANSACTION_TYPES')` (no file: `definitionsFallback()` is undefined).

RED 3 (seeds), `pnpm --filter @gatehub/data-api-service test:e2e -- tx-object` with the `fixtures.ts` hunk reverted:
```
test/tx-object.e2e-spec.ts:43:10 - error TS2769: ... Type '"xrpl-testnet-recorded"' is not assignable to type 'SeedName'.
Test Suites: 1 failed
```
Then, with the seeds but without the amendments files, the failure of the Blocker section; with the stand-ins, one real failure
that I fixed (Concerns 2): `serves every stored transaction in both modes ...` on `xahau-testnet-recorded`:
`- "Account": "rrrrrrrrrrrrrrrrrrrrrhoLvTp"  + "Account": ""`.

## Results (final tree, stand-ins in place for the e2e)

- `pnpm build`: exit 0.
- `pnpm test` (root): shared 49 suites / 1658 tests, exporter 12, api 75 / 1849, syncer 34 / 1292, all passed.
- `pnpm --filter @gatehub/data-api-shared test:e2e`: 15 suites / 876 tests passed.
- `pnpm --filter @gatehub/data-api-service test:e2e -- tx-object account-flags`: with the stand-ins 2 suites passed (tx-object 71/71);
  without them `28 failed, 67 passed` (all 28 are the new testnet rows, all `Invalid amendments config ... ENOENT`).
- Full API e2e (`pnpm --filter @gatehub/data-api-service test:e2e`) with the stand-ins: 47 suites / 2700 tests passed (the stand-ins are removed again).
- `pnpm exec prettier --write` on my 5 `.ts` files: unchanged. `README.md` is not prettier-formatted in this repo; I aligned my
  table rows by hand.

## Concerns

1. The Blocker above.
2. `tx-object.e2e-spec.ts` line `expect(json.tx).toEqual(codec.decode(codec.encode(JSON.parse(row.tx_json))))` is wrong for a
   transaction whose `Account` is `""` (the codec decodes a zero-length AccountID as the zero account; the app deliberately shows
   `""` like the node, `BinaryCodecService.roundTrip`). Xahau Testnet's ledgers all hold `Entropy` pseudo-transactions with
   `Account: ""`, so I changed it to `codec.roundTrip(JSON.parse(row.tx_json))`, which is `decode(encode(...))` for every other
   row. Not in the brief's file changes, but inside its file list.
3. Xahau Testnet has no `SetHook`/`URITokenMint` in the recorded triple (the brief asks for them "when near"): see above.
4. The brief's "N is a ledger the first run's manifest lists for OfferCreate" could not hold: that ledger had no XRP payment.

## Files in the working tree (uncommitted)

Modified: `apps/api/Dockerfile`, `apps/syncer/Dockerfile`, `apps/api/test/support/fixtures.ts`, `apps/api/test/tx-object.e2e-spec.ts`,
`packages/shared/src/network/account-flags.ts`, `packages/shared/src/network/network-profile.spec.ts`,
`packages/shared/test/fixtures/README.md`. New: `packages/shared/src/network/account-flags.spec.ts`,
`packages/shared/config/definitions/{xrpl,xahau}-testnet.json`,
`packages/shared/test/fixtures/{xrpl-testnet,xahau-testnet}/recorded/*` (3 ledgers, `server_definitions.json`, `server_info.json`,
`manifest.json` each).

Commit when cleared (the brief's command, files named):
```
git add packages/shared/test/fixtures/xrpl-testnet packages/shared/test/fixtures/xahau-testnet packages/shared/test/fixtures/README.md \
  packages/shared/config/definitions/xrpl-testnet.json packages/shared/config/definitions/xahau-testnet.json \
  packages/shared/src/network/account-flags.ts packages/shared/src/network/account-flags.spec.ts packages/shared/src/network/network-profile.spec.ts \
  apps/api/Dockerfile apps/syncer/Dockerfile apps/api/test/support/fixtures.ts apps/api/test/tx-object.e2e-spec.ts
```

## Ruling applied (controller): the testnet rows are skipped until Task 5

The controller ruled: commit with the new testnet rows of `tx-object.e2e-spec.ts` skipped, no stub amendments files, no
`GH_AMENDMENTS_CONFIG` scaffolding; Task 5 removes the skip. Done as follows: the body of the old `describe.each` became
`const txServiceTests = (seed, network) => { ... }` (same indentation, no other change), run by
`describe.each([ripple-mock, xrpl-recorded, xahau-recorded])('TxService on the %s ledgers', txServiceTests)` and by
`describe.skip.each([xrpl-testnet-recorded, xahau-testnet-recorded])(..., txServiceTests)` under the comment
`// Skipped until Task 5: the API boots a testnet only once the amendments loader reads the family's file.` Task 5's GREEN is to
change `describe.skip.each` to `describe.each` (and may merge the two tables). Everything else is as verified above (recordings,
definitions, account flags, `codec.roundTrip`, README hunk). The stand-in amendments files are gone; `config/amendments/` holds
`xrpl.json` and `xahau.json` only.

Re-run on the tree as committed (no stand-ins):
- `pnpm build`: exit 0.
- `pnpm --filter @gatehub/data-api-service test:e2e -- tx-object account-flags`: exit 0, `Test Suites: 2 passed, Tests: 28 skipped,
  67 passed, 95 total` (the 28 skipped are the two testnet rows; they were green with the stand-ins).
- `pnpm test` (root): exit 0; shared 49 suites / 1658 tests, exporter 3 / 12, api 75 / 1849, syncer 34 / 1292.
- Not re-run after the skip (nothing else changed since the green runs above): the shared e2e (15 suites / 876 tests passed) and
  the full API e2e (47 suites / 2700 tests passed with the stand-ins; the only file changed since is `tx-object.e2e-spec.ts`).
