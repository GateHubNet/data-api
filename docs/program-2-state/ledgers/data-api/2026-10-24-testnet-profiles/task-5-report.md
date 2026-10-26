# Task 5 report: Amendment metadata on the testnets

Status: DONE (concerns listed at the end are notes for the controller, none blocks).
Commit: `3035a5c feat(shared): testnets read their family's amendment metadata without mainnet's enable ledgers`
(on `feat/explorer-data-2`, on top of `dfd7044`; nothing pushed).

## What was implemented

**Loader (`packages/shared/src/validators/amendments-config.ts`)**
- `loadAmendmentsConfig(profile, path?)` reads `config/amendments/<profile.family>.json` for an absent, empty or blank path.
- `parseAmendmentsConfig(raw, profile)` accepts `raw.network` equal to `profile.name` or `profile.family`, refuses anything else with the
  unchanged text (`"<x>" is not the network of this deployment, "<name>"`), keeps `enabled` only when `raw.network === profile.name`
  (the `enabled` of a dropped entry is still validated first, so a malformed one is refused rather than hidden), and returns
  `network: profile.name`.
- `retired: true` is valid on both families (`is for Xahau only` is gone); the `introduced` patterns still go by `software`.
- Doc comments of `AmendmentMeta.enabled`, `AmendmentMeta.retired`, `AmendmentsConfig.network` and both functions updated.

**Metadata files**
- `xrpl.json`: the 15 `XRPL_RETIRE` names marked `"retired": true` (MultiSign, TrustSetAuth, FeeEscalation, PayChan, CryptoConditions,
  TickSize, fix1368, Escrow, fix1373, EnforceInvariants, SortedDirectories, fix1201, fix1512, fix1523, fix1528), `enabled` kept;
  `updated` is 2026-10-25 (the day of the change). Reformatted by prettier (entries that grew past 120 columns became multi-line).
- `xahau.json`: `{ "name": "fixXahauTestnetGenesis" }` added (alphabetical place), `updated` 2026-10-25.

**Recorded** `packages/shared/test/fixtures/xahau-testnet/network-state/{amendments,negative_unl,fee_settings,server_info,feature}.json`:
`pnpm record:fixtures -- --network-state --network xahau-testnet --endpoint wss://xahau-test.net` on 2026-10-25 00:34 UTC, validated
ledger 13465944 (`86BE78CC...DEFA0`), xahaud 2026.10.16-tmp-dev, network id 21338. 91 enabled amendments; NegativeUNL present (3 disabled
validators); FeeSettings in the legacy hex form; `feature` 117 amendments, all named. Provenance in `test/fixtures/README.md` (table row,
section title, a Xahau Testnet paragraph, the re-recording command with the four names). The README sentence "No recorded answer is in the
legacy FeeSettings form..." is corrected: the Xahau Testnet answers are the first recorded ones in the legacy FeeSettings form.

**Tests**
- `amendments-config.spec.ts`: a testnet reads its family file and drops the enabled entries (both families); a file whose `network`
  is the testnet's own name keeps `enabled` (parse, and load by path); other family's file refused for a testnet, a testnet's file refused
  for a mainnet (both texts verbatim); `retired` accepted on both families (`'accept a retired entry on both families'`); `retired: false`
  refused on XRPL; `introduced` patterns follow the testnet's software; the testnet's shipped file equals the family file in names, IDs and
  `obsolete`/`retired` marks; `'XRPL: exactly the 15 XRPL_RETIRE amendments are retired, keeping their enabled'` (same list as Xahau's test,
  each with its `enabled`; the four withdrawn amendments are still obsolete, neither retired nor enabled).
- `amendment-status.spec.ts`: new `a retired name (XRPL)`: a retired XRPL amendment the ledger does not list is `enabled` with `retired` and no
  `enabled` object; with the ID in the ledger the enabled object (source metadata) is there; a testnet reading the family file shows no
  `enabled` object either way and an indexed `EnableAmendment` wins. The old title `(Xahau)` of the status test became `(on either family)`.
- `amendments.e2e-spec.ts`: new `Xahau Testnet (the family file without its enable ledgers)` (4 tests, plan's spec: `startWithDirectory`,
  `insertState` with the 91 IDs of the recorded `node.Amendments` at its ledger; every ID a row with status `enabled`, the 15 retired
  names with them; no row has an `enabled` object, one file-dated amendment of the ledger is checked explicitly; AMMClawback, HookOnV2, RNG and
  fixXahauTestnetGenesis are named, no row `unknown`; nothing says `"source":"metadata"`). Addition in the existing XRPL case: one retired name the
  ledger lists (keeps the file's ledger and day) and one it does not list (enabled, no `enabled`), `retired: true` on both (P2).
- `tx-object.e2e-spec.ts` (Task 4 ruling): `describe.skip.each` -> `describe.each`, the "Skipped until Task 5" comment removed, and a new test in
  the shared body (15 tests per seed, so 30 on the two testnet rows: the 28 that were skipped plus this one on each seed): a recorded
  transaction whose `tx_json` has `Account` `""` keeps `Account: ""` (and is an `Entropy`) in `json.tx`; on `xahau-testnet-recorded` it asserts
  that there are some (`> 0`).

**Docs**: `docs/operations.md` ("Keep the amendment metadata current": the two testnet commands, the family file, the empty third list, the
`retired` rule and the 15); `docs/api-reference.md` (the `retired` key at ~3054 and the `enabled` row: the key is on XRPL mainnet rows too, and
what testnet rows show); `docs/configuration.md` (two `GH_AMENDMENTS_CONFIG` rows: `<network>.json` -> `<family>.json`, which my loader change made
wrong; this is a two-row addition outside the brief's file list, not in Task 11's list either). Comment in
`apps/api/src/validators/amendment-status.ts` (`AmendmentView.retired`, "Xahau:" removed). The commit message says that mainnet's rows gain
`retired: true` (instead of "mainnet's answers do not change").

## TDD evidence

RED (1), loader, `cd packages/shared && pnpm test -- amendments-config`: 6 failed, 41 passed.
Failures: `accept a retired entry on both families` (`retired: is for Xahau only`), `follows the software of the testnet, which is its family's`
(same cause), `may also be its family's file for a testnet, and then drops the enabled entries` (network refused), `reads its family's file and drops
the enabled entries` and `is the family file otherwise...` (`ENOENT .../config/amendments/xrpl-testnet.json`), `XRPL: exactly the 15 XRPL_RETIRE amendments are retired,
keeping their enabled` (received `[]`). The "keeps enabled in a file whose network is the testnet's own name", "refuses another family's file"
tests passed from the start: they pin behaviour the old code already had (regression guards).

RED (2), status: `cd apps/api && NODE_ENV=test pnpm exec jest --config ./jest-config.json --runInBand src/validators/amendment-status.spec.ts`: 3 failed, 77 passed:
`Invalid amendments config: amendments[0] (MultiSign): retired: is for Xahau only` (x2) and `network: "xrpl" is not the network of this deployment, "xrpl-testnet"`.

RED (3), the re-enabled testnet rows with the old loader (HEAD's `amendments-config.ts` swapped in and `shared` rebuilt, then restored byte for byte):
`jest --config ./test/jest-e2e.json test/tx-object.e2e-spec.ts -t xahau-testnet-recorded` -> `Tests: 15 failed, 61 skipped`, each
`Invalid amendments config: .../config/amendments/xahau-testnet.json: ENOENT`.
The new amendments e2e with the old loader fails at suite level (`amendments[11] (CryptoConditions): retired: is for Xahau only`, from the new xrpl.json).
Mutation check: with `keepEnabled = true` forced, the Xahau Testnet e2e test `has no enabled object...` fails (the other three pass), so that test bites.

GREEN:
- `cd packages/shared && pnpm test -- amendments-config` -> `Tests: 47 passed, 47 total`.
- `cd apps/api && ... jest src/validators/amendment-status.spec.ts` -> `Tests: 80 passed, 80 total`.
- `jest --config ./test/jest-e2e.json --runInBand --verbose test/tx-object.e2e-spec.ts` -> `Tests: 76 passed, 76 total`; the xrpl-testnet-recorded
  and xahau-testnet-recorded groups are 15 tests each, all passing: computes the CTIDs of its network and books native payments in its currency; serves
  every stored transaction in both modes without falling back to the stored JSON; keeps an Account "" as the node shows it (the Entropy
  pseudo-transactions of Xahau Testnet); converts a fetched page with the ledger hashes...; serves a fetched row as a TxObject...; fetchByKeys (5);
  ledgerHashes (2); binary form of what is stored (3: bundled definitions, hashes to the stored hash for every transaction, rebuilds the
  transaction_hash of every ledger).
- Amendments e2e (final files): `... --verbose test/amendments.e2e-spec.ts -t "the metadata file of the network"` -> 11 passed (XRPL 3, Xahau 4, Xahau Testnet 4).

Full verification before the commit: `pnpm --filter @gatehub/data-api-shared build`, then `pnpm build` (exit 0), `pnpm test` (exit 0: shared 49 suites/1667 tests,
exporter 12, api 75 suites/1852, syncer 34 suites/1292), `pnpm --filter @gatehub/data-api-shared test:e2e` (15 suites, 876 tests, exit 0),
`pnpm --filter @gatehub/data-api-service test:e2e` (47 suites, 2710 tests, exit 0), `pnpm --filter @gatehub/data-syncer test:e2e` (13 suites, 335 tests, exit 0).
The api e2e run began before I appended the XRPL retired case to `amendments.e2e-spec.ts`; I ran `amendments` + `tx-object` e2e again with the final files
(2 suites, 167 tests, exit 0). `pnpm format` was NOT run (it rewrites three unrelated files); my files were checked with `prettier --check` (clean);
the docs and README were not run through prettier (it reformats unrelated tables and whole docs), so only my lines changed there. No `TESTCONTAINERS_RYUK_DISABLED` was needed.

## Step 5: the checks (after the changes; exit codes)

| Command | Exit | Result |
| --- | --- | --- |
| `amendments:check -- --network xrpl-testnet` | 0 | 126 entries; node knows 107, the ledger lists 82; lists: 0 / 0 / 0 |
| `amendments:check -- --network xahau-testnet` | 0 | 127 entries; node knows 117, the ledger lists 91; lists: 0 / 0 / 0 |
| `amendments:check -- --network xrpl` (extra) | 0 | ledger lists 98 (15 retired among them), 0 / 0 / 0 |
| `amendments:check -- --network xahau` (extra) | 0 | ledger lists 77, 0 / 0 / 0 |

Before the xahau.json edit, the Xahau Testnet check listed one name the file lacked: `fixXahauTestnetGenesis` (exit 1). The 13 other names were already in the file (Ruling 9).
The XRPL Testnet check was clean (82 enabled, all on mainnet).

**The ID `AB6612F1B9C2EAB6F687512297D9960B13B869EFF97E77D85A0574DFF97FD1EE` is named**: `fixXahauTestnetGenesis` (`amendmentId('fixXahauTestnetGenesis')` is that ID, and the node's `feature` names it).
Source: `XRPL_FIX (XahauTestnetGenesis, Supported::no, VoteBehavior::DefaultNo)` in `include/xrpl/protocol/detail/features.macro` of the `testnet` and `tmp-dev` branches of `Xahau/xahaud`
(added by commit `f70eaba37` "testnet genesis fix", 2026-10-16, comment "Xahau testnet (NetworkID 21338) only"). **Deviation from the brief**: it is NOT on branch `dev`
(`dev`'s macro has no such line), because the testnet runs a build of its own (2026.10.16-tmp-dev). No release carries it, so the entry has no `introduced`. No unnamed ID is left: nothing for "IDs nobody names".

## Files changed (commit 3035a5c)
`packages/shared/src/validators/amendments-config.ts`, `.spec.ts`; `packages/shared/config/amendments/xrpl.json`, `xahau.json`;
`packages/shared/test/fixtures/xahau-testnet/network-state/{amendments,negative_unl,fee_settings,server_info,feature}.json` (new);
`packages/shared/test/fixtures/README.md`; `apps/api/src/validators/amendment-status.ts` (comment), `amendment-status.spec.ts`;
`apps/api/test/amendments.e2e-spec.ts`, `tx-object.e2e-spec.ts`; `docs/operations.md`, `docs/api-reference.md`, `docs/configuration.md`.

## Self-review
- Against the brief: all interface points done; Step 3 marks, Step 4 recording, Step 5 checks, Step 6 verification, Step 7 commit (message adapted per P2).
- `parseEntry` takes a `keepEnabled` flag instead of post-filtering, and still validates a dropped `enabled`.
- No change to rows.ts, migrations, parser versions. `AmendmentsConfig.network` stays the profile name, so the syncer and API keys (cache keys, gauges) are untouched.
- Scratch files stayed in the scratchpad; the temporary swaps of the loader were restored byte for byte (checked with `cmp`).

## Concerns / notes for the controller
1. Mainnet XRPL rows gain `retired: true` for the 15 names (P2); documented in api-reference and operations, in the commit message. The plan's spec text
   (`2026-10-24-testnet-profiles-design.md` section 6 "mainnet's answers do not change" and section 15 "change no mainnet answer") and the plan's own
   commit-message text still say so; they were not in my file list and I left them.
2. `fixXahauTestnetGenesis` comes from the `testnet`/`tmp-dev` branches, not `dev` (see above); the brief's Step 5 and plan item 9 name `dev`.
3. `docs/configuration.md` was edited (two table cells) although not in the brief's list; ADR-0012, architecture/development (Task 11) still say
   `config/amendments/<network>.json` / "per network" and need the family wording.
4. The recorded Xahau Testnet NegativeUNL has three disabled validators with `FirstLedgerSequence` 1280/1536/1792, and FeeSettings is in the legacy hex form (`BaseFee: "a"`):
   the first recorded legacy-form FeeSettings; the syncer's poller has hand-written specs for that form, but nothing here exercises the poller on these files (not in scope).
5. The run began 2026-10-25 00:34 UTC; `updated` dates are 2026-10-25 rather than the plan's 2026-10-24.
