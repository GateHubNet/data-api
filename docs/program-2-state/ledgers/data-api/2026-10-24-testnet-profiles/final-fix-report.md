# D-env final fix wave (after the whole-branch review)

Worktree `explorer-data-2`, branch `feat/explorer-data-2`, from HEAD `f59102e`. Status: DONE.

## Commits

| SHA | Subject |
| --- | --- |
| `1d9c9b4` | fix(shared): fixXahauTestnetGenesis is obsolete on Xahau mainnet, enabled on Xahau Testnet |
| `a6aacee` | test(syncer): a live loop on a testnet halts when the head falls below the first indexed ledger |
| `5294876` | docs: GH_AMENDMENTS_CONFIG comments say <family>, the syncer example leaves the node endpoints to the network |

## Finding 1 (Important): `fixXahauTestnetGenesis` on Xahau mainnet

**Change.** `packages/shared/config/amendments/xahau.json`: `{ "name": "fixXahauTestnetGenesis", "obsolete": true }`, as the file
already does for `AMMClawback` and `HookOnV2`. Status by the first rule that matches (`amendmentStatus`): in the ledger -> `enabled`
(Xahau Testnet); otherwise `meta.obsolete` -> `obsolete` (Xahau mainnet). `syncer_amendments_without_metadata` stays 0 (the name stays
in the file).

**Test** (`apps/api/src/validators/amendment-status.spec.ts`, a new `describe` in `assembleAmendments`, three cases). It loads the real
shipped family file through `loadAmendmentsConfig(getNetworkProfile(...))`, so it pins the file itself, not a made-up one:
- the ID of `amendmentId('fixXahauTestnetGenesis')` is `AB6612F1B9C2EAB6F687512297D9960B13B869EFF97E77D85A0574DFF97FD1EE`;
- under the `xahau` profile, an empty ledger, a node that lists nothing and no votes: `status: 'obsolete'`, no `votes`;
- under the `xahau-testnet` profile with the ID in the ledger's `Amendments`: `status: 'enabled'`, no `enabled` object.

The existing amendments e2e (`Xahau Testnet` block, "names the ones that Xahau mainnet lacks") already asserts `fixXahauTestnetGenesis`
`enabled` on the recorded testnet ledger end to end, and it passes.

**RED**, before the file change:

```
cd apps/api && NODE_ENV=test pnpm exec jest --config ./jest-config.json --runInBand src/validators/amendment-status.spec.ts
  ● assembleAmendments › a name that only Xahau Testnet has (...) › is obsolete on Xahau mainnet, whose node does not know it: no permanent 0-vote voting row
    -   "status": "obsolete",
    +   "status": "voting",
  Tests:       1 failed, 82 passed, 83 total
```
Expected: this is the defect (the unmarked entry is `voting` on mainnet). The other two new cases passed (they describe what was already true).

**GREEN**, after the one-line change: `Tests: 83 passed, 83 total`.

**Docs.** `docs/adr/0012-validators-and-amendments-data.md` (Consequences, the bullet on the shared family file): the voting row is no longer described;
it says the entry is `obsolete: true` as `AMMClawback` and `HookOnV2` are, that Xahau mainnet shows `obsolete`, Xahau Testnet `enabled`
(the ledger rule comes first), and that the gauge stays 0. `docs/operations.md` ("Keep the amendment metadata current", the paragraph on
what a testnet's node knows): a name that only a testnet's own build has and no release carries is marked `obsolete: true` as well, and why.
Note: `operations.md` line ~247 did not itself describe a voting row (it said the testnet-only names "belong in `xahau.json` like any other
new name"); I added the rule for the testnet-only name there, which is the place an operator updating the file reads.

## Finding 2 (Minor): the live-loop reset path

`apps/syncer/test/live-runner.e2e-spec.ts`, in `a head below the checkpoint`: **"on a testnet, halts while live when the head falls below the
first indexed ledger (the sandbox reset)"**. `xrpl-testnet`, `syncStartLedger` L(10), L(10)..L(20) indexed by a first runner; a second runner
boots on the same database (`headSilenceMs` 50, `headBelowCheckMs` 300), goes `live` at L(20) (only the checkpoint L(20) fetched), then the
source's head and `available` jump to L(3). Asserted: the runner halts; `status()` is `halted`, checkpoint L(20), `error` = the second halt
message ("The node's validated head L(3) is below the first indexed ledger L(10): the network was reset"); `runOnce()` rejects with
`ChainBreakError` (message, `ledgerIndex` L(3)); `source.fetches` is still `[L(20)]` (no stored hash to compare, nothing fetched); the stored
ledgers are still L(10)..L(20); the `chain_break` halt counter went up by one.

The code under test already behaved this way, so a plain run is green at once. To make sure the test is real I ran it against a deliberately
broken loop path (temporarily, in `apps/syncer/src/ingest/live-runner.ts`, `compareHeadBelow`: the testnet check inverted to
`kind === 'mainnet'`), then restored the file from a copy (`git status` showed it unmodified):

- **RED (mutated)**: `NODE_ENV=test pnpm exec jest --config ./test/jest-e2e.json --runInBand test/live-runner.e2e-spec.ts -t "first indexed ledger"` ->
  `● ... halts while live when the head falls below the first indexed ledger (the sandbox reset): Timed out waiting for the runner to halt`
  (and the boot case and the mainnet case failed too, as expected for an inverted check).
- **GREEN (restored)**: same command -> 3 passed (`on a testnet, halts when the head is below the first indexed ledger`, the new case
  (1899 ms), `on a mainnet, waits ...`), 39 skipped by `-t`.

## Findings 3, 4, 5 (Minor), commit `5294876`

3. `apps/api/src/config/api.config.ts` and `apps/syncer/src/config/syncer.config.ts`: the `GH_AMENDMENTS_CONFIG` comments say
   `config/amendments/<family>.json` (the API's adds "a testnet reads its family's"). `docs/configuration.md` already said `<family>`.
4. `apps/syncer/.env.example`: `# GH_NODE_ENDPOINTS=wss://s2.ripple.com` (commented out, as `apps/api/.env.example` has it), so the default
   is the public endpoints of `GH_NETWORK`. `docs/development.md` (the first-time setup block: "defaults: ..."): both examples leave
   `GH_NODE_ENDPOINTS` commented out; for xrpl the default is `wss://s2.ripple.com` (Ripple's full-history server), then `wss://xrplcluster.com`.
   The testnet paragraph of the same file ("Leave `GH_NODE_ENDPOINTS` at its default") is now true of the copied example.
5. `packages/shared/src/network/account-flags.ts`: the doc comment no longer leaves `("ltACCOUNT_ROOT") of` on a line of its own with the date
   after the URL: `("ltACCOUNT_ROOT") of the file below (branch `dev`, 2026-10-24). A new flag there is a new line here.`, then the URL.

## Verification (after all changes, before the commits)

- `pnpm exec prettier --write` on my TypeScript files only (it reformatted one long line in `live-runner.e2e-spec.ts`; nothing else changed).
- `pnpm build`: exit 0 (shared, api, exporter, syncer).
- `pnpm test`: shared 49 suites / 1683 tests, exporter 3 / 12, api 75 / 1857, syncer 35 / 1337: all passed, exit 0.
- `pnpm --filter @gatehub/data-api-shared test:e2e`: 15 suites / 877 tests passed, exit 0.
- `pnpm --filter @gatehub/data-api-service test:e2e`: 47 suites / 2713 tests, 3600 snapshots passed, exit 0 (the amendments e2e included).
- `pnpm --filter @gatehub/data-syncer test:e2e`: 13 suites / 346 tests passed, exit 0 (the new live-runner case included).
- No testcontainers/ryuk problem; no flaky worker spec this time.

## Files changed

- `packages/shared/config/amendments/xahau.json`
- `apps/api/src/validators/amendment-status.spec.ts`
- `docs/adr/0012-validators-and-amendments-data.md`, `docs/operations.md`
- `apps/syncer/test/live-runner.e2e-spec.ts`
- `apps/api/src/config/api.config.ts`, `apps/syncer/src/config/syncer.config.ts`, `apps/syncer/.env.example`, `docs/development.md`,
  `packages/shared/src/network/account-flags.ts`

Nothing under `docs/superpowers/` or `.claude/` was touched; no migration, no parser version, no new ADR.

## Self-review and concerns

- The diff is limited to the five findings. The temporary mutation of `live-runner.ts` is not in any commit.
- Left alone on purpose (outside the findings): `docs/adr/0012-validators-and-amendments-data.md` line 46, the original decision text "a hand-kept
  file per network (`.../amendments/<network>.json`)", which the decision further down ("per family, not per network") amends; it is history, not
  a statement of the current default. `packages/shared/test/fixtures/README.md` (line ~411) says the `fixXahauTestnetGenesis` entry "has no
  `introduced`", which is still true; it does not mention the mark.
- Concern for the owner: `obsolete: true` on this entry says "mainnet's software cannot vote it in", which is the mainnet truth and what the
  family file records; a custom file for a testnet (`GH_AMENDMENTS_CONFIG`) can leave the mark off, since the ledger rule comes first there.
