# Task 11 report: ADRs, the remaining docs, the verification and the rollout

Status: DONE_WITH_CONCERNS (concerns: the spec's volume claim, the literal `git diff --exit-code` step, one grep hit that is history; see the end).

Commits (branch `feat/explorer-data-2`, on top of `1606203`, nothing pushed; trailer `Co-Authored-By: Claude Opus 5.5` per the controller ruling):

| SHA | Subject |
|---|---|
| `a55d5b1` | fix(syncer): the boot reads the validated head with a warning for each failed try (carry-over 12) |
| `44dff68` | test(shared): the testnet validator list is asserted by the manifest and node-key specs (carry-over 5) |
| `ce1f33d` | docs: comments and env examples say four networks and the family's amendment file (carry-over 1, 2, 4, 6, 9, 11) |
| `f59102e` | docs: testnet profiles in ADR-0009, ADR-0012 and ADR-0010 item 44, the hosts and the database names (the plan's commit, plus the carry-over docs 3, 5, 7, 8, 10) |

## What I wrote

**ADRs.**
- `docs/adr/0009-one-deployment-per-network.md`: status line amended; section "Amendment (2026-10-24): testnets": the four profiles with `family`, `kind`, `displayName`, `acceptedNodeNetworkIds`,
  a table of the four profiles (ids, currency, accepted ids, databases, endpoints, files, hosts), what keys on name / family / kind, each process accepting exactly its own node (the `xahau`
  change, `record:fixtures`), the testnet databases, the sandbox as a stack of its own (compose slots, `XRPL_NETWORK`/`XAHAU_NETWORK`, certificates, why never on the production server), indexing from the
  head (no backfill), the reset rule and its runbook; "Decisions made while building it" (halt on any network, `record:fixtures`, the `default` word only for the two list variables, the blank sandbox
  validation endpoints, later sub-projects' fields); consequences.
- `docs/adr/0012-validators-and-amendments-data.md`: status line; section "Amendment (2026-10-24): the testnets": XRPL Testnet's publisher; Xahau Testnet's fixed list (the four keys, source file and commits);
  `GH_UNL_VALIDATORS`, `default`, the reserved id; `local` stored as a publisher's list (row shapes, expiration 4294967295, upper-case hash, sequence + 1 only on changed keys, never fetched);
  the threshold counting lists; what the API shows; the metadata file per family (rules for `network` and `enabled`); `retired` on XRPL (the 15 names); `amendments:check` on testnets; the majority holds with
  their source (XRPL Testnet 1,800 s **inferred** from 7 got-majority/enabled pairs, with the example hashes and the (1711 s, 2359 s] bound; Xahau Testnet 432,000 s the **software default, not verified on the chain**,
  with the repo commits); the names the testnets have that mainnet lacks (the unnamed ID is `fixXahauTestnetGenesis`, from the `testnet` / `tmp-dev` branches of xahaud, not `dev`); the plan rulings 7, 8, 11, 12 and the
  `retired` ruling (mainnet's answers do change by one additive key); consequences, including that `fixXahauTestnetGenesis` is a row on Xahau mainnet's board because the family file is shared.
- `docs/adr/0010-ripple-v2-wire-compatibility.md`: item 44 gains "`unl_lists` may name `local`, the fixed list of `GH_UNL_VALIDATORS`."; one line in the status.
- `docs/adr/README.md`: the index rows of 0009, 0010 and 0012 say they are amended.

**Docs.** `docs/api-reference.md` (Hosts: four rows with the production and sandbox hosts, CTID 1 / 21338, a paragraph on what differs in a testnet; `rules` holds per network; metadata "a file per family"; PDF `Network:` names; the
`unl` differences row names `local`; markets path `<network>.json`; partial-payment cut-off sentence), `docs/architecture.md` (four profiles, the keyed-by table, files per network and per family, databases, ADR rows), `docs/development.md`
(the profile and the files per network / per family, a "A testnet" paragraph, §4's `record:fixtures` and `amendments:check` rows with the four names), `docs/data-model.md` and `docs/clickhouse.md` (the four database names, `shared` on each
server, `syncer_lease.network`, the sandbox migrate command), `README.md` (host table, the sandbox, four names), `GLOSSARY.md` ("Network kind", the one word missing), `docs/README.md`, `docs/syncer.md` (the fixed list in the UNL section and the
domain checker; the boot head read), `docs/observability.md`, `docs/troubleshooting.md` (the `network_id` entry), `docs/security.md`.

**Carry-over (task-11-carryover.md), item by item.**
1. `NetworkProfile` doc and `clickhouse.config.ts` comment: four networks (what keys on name, family, kind). 2. `export-worker.ts` two comments. 3. `docs/configuration.md` §1 (Tasks 2/6/10 had fixed the rest; I reworded the CTID sentence).
4. `<network>.json` to `<family>.json`: `amendments-check.ts` header (also its "a Xahau node for the XRPL file" and the always-empty third list), `apps/api/.env.example`, `apps/syncer/.env.example`, `deploy/.env.prod.example`,
`deploy/.env.sandbox.example` (same wording), api-reference ("a file per family"). 5. Fixtures README: added the testnet list to the `RECORDED` / `LISTS` of `manifest.spec.ts` and `node-key.spec.ts` (trivial; the 6 manifests are now
asserted, the node-key count test is 35 + 35 + 19 + 6 validators and 4 publishers), `--unl --network xrpl|xahau|xrpl-testnet` (and a note that `xahau-testnet` records nothing), "3 to 21" replaced by the recorded 3, 14 and 5.
6. `defaultUnlThreshold(lists)`. 7. api-reference `unl` row. 8. operations: `<database>` in the reset SQL, one clause in the intro for the sandbox databases, the `account_network_names` paragraph and the false `GH_CLICKHOUSE_DATABASE` sentence.
9. `docker-compose.prod.yaml` two markets comments (`config/markets/<network>.json`, empty in the sandbox). 10. `docs/security.md`, `docs/configuration.md` §8, README: `deploy/.env.sandbox.example` added. 11. `syncer.config.spec.ts` comment now
points to where the database is pinned (`network-profile.spec.ts`, migrate e2e (g)). 12. Done as a code change, below.

**Carry-over 12 (behaviour change, a few lines).** `prepare()` reads the boot head with `untilDone('read the validated head', 'warn', ...)`; a stop or halt first throws `StoppedError` like the checkpoint fetch. Only the comparison's own failure
(`storedLedgerHash`, the one `fetch(head)`) is still an error that the boot retries. `docs/syncer.md` says so.

TDD (new e2e case in `live-runner.e2e-spec.ts`, "reads the head at boot with a warning for each failed try, as the loop does: no error, not recovering": `validatedHead` fails twice, then answers):
- RED (before the change), `NODE_ENV=test npx jest --config ./test/jest-e2e.json --runInBand test/live-runner.e2e-spec.ts -t "reads the head at boot with a warning"`:
  `expect(logger.lines.filter(error)).toEqual([])` received two `Could not prepare the ingest checkpoint, nothing is written until it succeeds (retry in 20 ms): Error: node unreachable` error lines. Expected: the boot head read was inside the error-level step.
- GREEN, same file with `-t "a head below the checkpoint"`: 8 passed (the 7 of Task 9 plus the new one), 33 skipped.

## Step 2: the docs against the code

- `pnpm --filter @gatehub/data-api-service test -- api-reference`: 1 suite, 35 tests passed (also after the last prose edit).
- "Keeping this page true" script of `docs/configuration.md` (after `pnpm build`): `GH_UNL_VALIDATORS` is printed for the syncer (between `GH_UNL_PUBLISHERS` and `GH_UNL_THRESHOLD`) and has its row (§5) and its `apps/syncer/.env.example` line;
  every name printed for api, syncer and exporter, and the `env.GH_*` reads of `clickhouse.config.ts`, has a row (checked with a loop: no "NO ROW").
- `grep -rn "xrpl or xahau\|xrpl|xahau[^|]" docs README.md apps/*/.env.example deploy docker-compose*.yaml GLOSSARY.md` (docs/superpowers excluded): the only two hits are in `docs/adr/0009-one-deployment-per-network.md`: line 4, my status line quoting
  the old `xrpl|xahau`, and line 21, the original 2026 decision text (left as history; the amendment says it is superseded). The escaped forms `xrpl\|xahau` in `docs/development.md` and `docs/observability.md` (the two the pre-flight found) now list
  the four names. README line 53 (the former hit) says the four names.
- `docker compose ... config -q` with `deploy/.env.sandbox.example` and `deploy/.env.prod.example` (after the compose comment edits): both valid.

## Step 3: the whole verification

- `pnpm format`: it changes my files not at all (the diff of `apps packages` before and after is identical) and rewrites the three known unrelated files (`clickhouse.module.ts`, `util/helpers.ts`, `util/time.ts`); I restored those three with
  `git checkout --`. The literal `pnpm format && git diff --exit-code -- apps packages` therefore cannot exit 0 on this branch (the drift is pre-existing, and my uncommitted work is in that diff anyway); what I verified is that
  nothing of mine is left unformatted. `prettier --check` of every `.ts` file I changed: clean.
- `pnpm build`: exit 0 (shared, api, syncer, exporter).
- `pnpm test`: exit 0. shared 49 suites / 1683 tests, exporter 3 / 12, api 75 / 1854, syncer 35 / 1337. No worker-spec timeout.
- `pnpm --filter @gatehub/data-api-shared test:e2e`: exit 0, 15 suites / 877 tests.
- `pnpm --filter @gatehub/data-api-service test:e2e`: exit 0, 47 suites / 2713 tests, 3600 snapshots (`api-reference-examples.e2e-spec.ts` included).
- `pnpm --filter @gatehub/data-syncer test:e2e`: exit 0, 13 suites / 345 tests (344 + the new case).
- Run once, in that order, on the tree before the commits; after the run I only edited prose in `docs/api-reference.md` (outside every `d2-example` block, re-ran its unit spec: 35 passed), `docs/troubleshooting.md` and the fixtures README. Ryuk pulled
  fine, `TESTCONTAINERS_RYUK_DISABLED` was not needed.

## Rollout (what the owner does; nothing of it is done here)

1. **Production.** Nothing to migrate or reprocess: no migration (`schema/` stays at 010, `schema-shared/` at 002), no parser version. Two things change what a mainnet does or answers, and both are additive or protective: the 15 retired XRPL amendment
   rows gain `"retired": true` (statuses and every other key unchanged; the plan said "no mainnet answer changes", which the first review corrected), and `GH_NETWORK=xahau` now refuses a node reporting `network_id` 21338 at boot. A mainnet syncer whose
   node head falls below its checkpoint under another hash now halts (`ChainBreakError`) instead of waiting. Deploy as usual: compose now leaves the database to the profile (same names, `xrpl` and `xahau`), spells the lists `default` and the
   endpoints blank, with the same result; the production env file sets neither `XRPL_NETWORK` nor `XAHAU_NETWORK`. Before the deploy, check that no `xahau` process points at a Xahau Testnet node.
2. **The sandbox.** A host of its own with its own ClickHouse server (never the production one: `shared` has one name per server). `cp deploy/.env.sandbox.example deploy/.env.sandbox`, fill in the secrets and the sandbox explorer's key in
   `GH_API_KEYS` and `GH_RATE_LIMIT_KEYS`, then `docker compose -f docker-compose.prod.yaml --env-file deploy/.env.sandbox up -d --build` (the image build needs `NPM_TOKEN`). It indexes from the validated head (decision 4) and starts empty; exports are off
   without a bucket of its own. Certificates for `xrpl.data.sandbox.gatehub.net` and `xahau.data.sandbox.gatehub.net` at the front proxy (`*.data.sandbox.gatehub.net`, or the two names: `*.gatehub.net` covers neither). Outbound HTTPS to
   `vl.altnet.rippletest.net`. The real `up -d --build` of the sandbox stack was never run (the build needs the npm token); the compose resolution and the config classes were checked in Task 10.
3. **Inputs only the owner can give.**
   - **Majority holds.** XRPL Testnet 1,800 s (30 minutes) is **inferred**, not published: seven enabled amendments were each enabled 768 ledgers after their majority, which bounds the hold to (1711 s, 2359 s]; ask Ripple to confirm, or leave it.
     Xahau Testnet 432,000 s (5 days) is the xahaud software default and the `Xahau-Testnet-Docker` configuration sets none; the chain held no pair (**not verified on the chain**): confirm with the testnet's operators. A wrong value shifts
     `expected_activation` only, never a status. Both live in `network-profile.ts`, with their source in the comment.
   - **Amendment IDs still unknown after Task 5:** none. `AB6612F1…FD1EE` is `fixXahauTestnetGenesis` (branches `testnet` and `tmp-dev` of xahaud; named in `xahau.json`). Owner decision to flag: that name is in the file Xahau mainnet shares, so it is a
     `voting` row on Xahau mainnet's board (as any name of the file that mainnet's ledger lacks); hide it, or accept it.
   - **In `deploy/.env.sandbox`:** GateHub's own testnet node endpoints if wanted (blank = the public testnet servers); `GH_CORS_ORIGINS` is empty (the explorer calls with a key from its Worker) and the sandbox explorer's rate budget is 6000 (the
     example's suggestion): confirm both; the validation endpoints are blank on purpose (production's would be refused at boot).
   - **Xahau Testnet's four validators** are the profile default (`validators-xahau.txt` of `Xahau-Testnet-Docker`, unchanged since 2024-10-25); compare again when the operators announce a change, or set `GH_UNL_VALIDATORS`.
4. **Then E7:** the explorer's sandbox deploy waits for these two hosts to answer (E7 section 15).

## Concerns

1. **Spec section 8 over-claims for the payment volume.** The spec (section 8) says a testnet's `exchange_volume` *and* `payment_volume` answer rows with no components. The volume job always lists the native currency among the payment
   currencies (`paymentAssetsOf`), so `payment_volume` has the native currency's component whenever there are native payments. I documented what the code does (ADR-0009, api-reference): trade volume has no market components, payment volume the native
   currency's alone. The spec was not edited (as instructed).
2. **`pnpm format && git diff --exit-code -- apps packages`** cannot pass as written (pre-existing drift in three files, listed above); I verified "nothing of mine unformatted" instead. Someone could commit that drift once.
3. **ADR-0009 line 21** still reads `GH_NETWORK=xrpl|xahau`, deliberately: it is the 2026 decision text, and the status line and the amendment say what replaced it.
4. **P-rulings are not cited in the ADRs by number** (the ledger is not in the repo); the plan's rulings are ("plan ruling N") and link to the plan.
5. Flags from earlier reviews that stay open and are now documented rather than changed: `fixXahauTestnetGenesis` on Xahau mainnet (above); the boot-time wait never re-checks a reset after a same-hash check (design, plan-mandated; in `docs/syncer.md`);
   `IsWithinPublishers` is still the name of the validator that bounds by lists (Task 6 note; not in the carry-over list).
6. The e2e boot options of Task 7 (`state: false, domains: false` in the fixed-list e2e) are a test matter; no doc describes them.
