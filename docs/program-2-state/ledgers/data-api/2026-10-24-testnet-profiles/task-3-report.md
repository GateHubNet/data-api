# Task 3 report: A node of another network is refused

Status: DONE. Commit `911e139` `feat(shared): each network accepts exactly its own node network_id` (branch feat/explorer-data-2).

## Implemented

- `packages/shared/src/xrpl/node-client.ts`: the `ACCEPTED_NETWORK_IDS` table is gone (it held the Task 1 stop-gap rows, with
  `xahau: [21337, 21338]`). `assertNetwork(info, profile)` reads `profile.acceptedNodeNetworkIds`; its doc comment states the four rules
  of spec section 4 (`xrpl` none or 0, `xahau` 21337, `xrpl-testnet` 1, `xahau-testnet` 21338, and the two consequences: a Xahau Testnet
  node does not serve `GH_NETWORK=xahau`, a mainnet rippled, which reports none, does not serve `xrpl-testnet`). The message is
  unchanged (`Node network_id <id> does not match GH_NETWORK=<name>`). The now unused `NetworkName` import was dropped.
- `packages/shared/scripts/record-fixtures.ts`: `networkIdProblem` is exported, takes
  `Pick<NetworkProfile, 'name' | 'networkId' | 'acceptedNodeNetworkIds'>`, and returns `undefined` only when `info.network_id` (absent
  included) is in `acceptedNodeNetworkIds`; otherwise today's text `reports network_id <id>, but --network <name> is <networkId>`
  (Ruling 6). A mainnet endpoint can no longer be recorded into `fixtures/xrpl-testnet/`. The two call sites (`recordNetworkState`,
  `recordFixtures`) are unchanged.
- `docs/syncer.md` line 44: the accepted `network_id` per network.
- Tests: `node-client.spec.ts` (the 14 cells of the section 4 table as an `it.each`, replacing the old `assertNetwork rejects xahau
  node for xrpl profile` test), `record-fixtures.spec.ts` (`networkIdProblem` describe with the brief's four expectations),
  `apps/syncer/test/app.e2e-spec.ts` (`exits with an error when a Xahau Testnet node serves GH_NETWORK=xahau (D10)`).

## TDD evidence

RED, `pnpm --filter @gatehub/data-api-shared test -- node-client record-fixtures` (run in `packages/shared`):

```
FAIL scripts/record-fixtures.spec.ts
  ● Test suite failed to run
    scripts/record-fixtures.spec.ts:12:3 - error TS2459: Module '"./record-fixtures"' declares 'networkIdProblem' locally, but it is not exported.
FAIL src/xrpl/node-client.spec.ts
  ● NodeClient › xahau: a node reporting network_id 21338 is accepted: false
    Expected substring: "Node network_id 21338 does not match GH_NETWORK=xahau"
    Received function did not throw
Tests: 1 failed, 34 passed, 35 total
```

Expected: `xahau` still accepted 21338 (the stop-gap table) and `networkIdProblem` was not exported. The other new cells already passed
because Task 1's placeholder rows for the two testnets were right; only the `xahau` row was wrong.

GREEN, same command after the implementation:

```
PASS scripts/record-fixtures.spec.ts
PASS src/xrpl/node-client.spec.ts
Test Suites: 2 passed, 2 total
Tests:       87 passed, 87 total
```

The syncer e2e test was not run on its own before the change (RED is the unit test above, the same rule in the same function); after it:
`pnpm exec jest --config ./test/jest-e2e.json --runInBand --verbose test/app.e2e-spec.ts -t "another network|Xahau Testnet"` gives
`exits with an error when the node belongs to another network` and `exits with an error when a Xahau Testnet node serves
GH_NETWORK=xahau (D10)` both passing.

## Verification before the commit

- Prettier on my six files (`pnpm exec prettier --write <files>`): unchanged; `docs/syncer.md` is not under the repo's prettier glob
  (`pnpm format` touches only `{apps,packages}/**/src/**/*.ts`), and its baseline does not pass `--check` either, so I left it.
- `pnpm build`: exit 0 (shared, api, syncer, exporter).
- `pnpm test`: exit 0. shared 48 suites / 1653 tests, exporter 3 / 12, api 75 / 1849, syncer 34 / 1292.
- `pnpm --filter @gatehub/data-syncer test:e2e -- app`: exit 0, 13 suites / 335 tests. (The `-- app` filter is not applied by the
  script's `jest ... -- app` form, so all 13 suites ran; `app.e2e-spec.ts` is among them and passed.)
- `pnpm --filter @gatehub/data-api-shared test:e2e`: exit 0, 15 suites / 876 tests.
- The api package was not touched (its `xrpl.service.ts` calls `assertNetwork` unchanged; its unit suite is in the `pnpm test` run), so
  its e2e was not run. Ryuk pulled fine; `TESTCONTAINERS_RYUK_DISABLED` was not needed.

## Files changed

- `packages/shared/src/xrpl/node-client.ts`
- `packages/shared/src/xrpl/node-client.spec.ts`
- `packages/shared/scripts/record-fixtures.ts`
- `packages/shared/scripts/record-fixtures.spec.ts`
- `apps/syncer/test/app.e2e-spec.ts`
- `docs/syncer.md`

## Self-review

- Brief covered completely; no file outside it changed. No duplicate table remains (`grep ACCEPTED_NETWORK_IDS` finds nothing outside the
  plan/spec documents).
- Behaviour that changes: `xahau` refuses 21338 (D10); `xrpl-testnet` refuses an absent `network_id`; `networkIdProblem` for `xrpl` now
  accepts exactly absent or 0 where it took "absent or equal to `networkId`" (0), the same set; for `xahau` it took absent too, and now
  refuses absent (a Xahau node always reports 21337, so a mainnet rippled recorded as `xahau` is now refused, as `assertNetwork` already did).
- `amendments-check.ts` and the three `assertNetwork` callers (api `xrpl.service.ts`, syncer `node-client.provider.ts` and
  `validations-collector.ts`) needed no change; they pass the profile.
- The other docs that mention the node check (`docs/configuration.md`, `docs/troubleshooting.md`, `docs/operations.md`) are Task 11's.

## Concerns

None.
