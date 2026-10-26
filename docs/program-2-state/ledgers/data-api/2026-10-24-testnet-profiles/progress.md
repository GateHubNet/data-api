# SDD ledger — plan: docs/superpowers/plans/2026-10-24-testnet-profiles.md
BASE (plan start): 8a0f648
Baseline (8a0f648): pnpm build ok; pnpm test all green (shared 1622, syncer 1286, api 1844, exporter 4).

## Pre-flight scan

Read-only scan of the plan against the worktree (branch feat/explorer-data-2, base 8a0f648) and the spec. Verdicts: agree, or CONFLICT with the ruling suggested. T = Task. Section A: every pair of tasks that share a file or an interface. Section B: every task against itself, the code it names and the spec values it quotes. Section C: other flags.

### A. Task pairs

| # | Tasks | Produces / consumes, shared files | Finding |
|---|---|---|---|
| A1 | T1 to T2 | T1: NETWORK_NAMES, isNetworkName, networkChoiceText, networkLogText, displayName. T2: 3 config classes, 2 scripts, 3 boot lines, pdf-file, range-ingest | agree: names, signatures and the verbatim messages (Global Constraints) are identical in both Interfaces blocks. |
| A2 | T1 to T3 | T1: acceptedNodeNetworkIds plus 2 placeholder rows in ACCEPTED_NETWORK_IDS (node-client.ts:71); T3 deletes the table | agree: the table is Record<NetworkName,...>, so the placeholders are needed to compile. T1's Files block omits node-client.ts (see B1). |
| A3 | T1 to T4 | network-profile.spec.ts, apps/api/Dockerfile, apps/syncer/Dockerfile; testnet definitionsFallback | agree: T1 adds the markets files on Dockerfile lines 38/44, T4 the definitions files on 39/45; definitionsFallback is by name, undefined until T4 by design. |
| A4 | T1 to T5 | family, software | agree: loader reads config/amendments/<family>.json; the introduced pattern stays by software. |
| A5 | T1 to T6 | defaultUnlPublishers, defaultUnlValidators | agree: the 4 node keys are identical in T1 table, T6 constant and spec section 5, and each decodes with decodeNodePublic (33 bytes); the testnet publisher key is 66 hex. |
| A6 | T1 to T9 | kind; getNetworkProfile(cfg.network) | agree (live-runner.ts imports no profile today; T9 adds it). |
| A7 | T1 to T10 | names, defaultDatabase, defaultNodeEndpoints, default lists | agree, except the validation-endpoints gap in B10. |
| A8 | T2 and T3 | packages/shared/scripts/record-fixtures.ts and .spec: T2 Options.network, parseArgs, USAGE; T3 exported networkIdProblem | CONFLICT: recordNetworkState(o: { network: 'xrpl' or 'xahau' }) (record-fixtures.ts:336) receives options.network (:499); T2 retypes only Options.network, so ts-jest reports TS2322 in record-fixtures.spec.ts. Also record-fixtures.spec.ts:77 and :82 assert the old USAGE substrings; T2 names neither. |
| A9 | T2 to T4 | record:fixtures --network <testnet> | agree: --unl and --network-state default --out dirs (test/fixtures/<network>/unl, /network-state) match the paths T5 and T6 name; ledgers mode needs --out, which T4 passes. |
| A10 | T2 to T5 | amendments:check --network <testnet> | agree: default endpoint is defaultNodeEndpoints[0], wss://xahau-test.net as T2's test expects. The header comment of amendments-check.ts (config/amendments/<network>.json) goes stale after T5, which does not list the script (low). |
| A11 | T2 and T6 | syncer.config.ts and spec, docs/configuration.md | agree: T2 touches the network IsIn (:224) and GH_NETWORK doc lines (17, 37); T6 the UNL properties and rows; disjoint hunks. |
| A12 | T2 and T9 | docs/troubleshooting.md | agree: line 57 versus the new ChainBreakError text. |
| A13 | T2 and T10 | docs/configuration.md, apps/*/.env.example | agree: T2 does not list the .env.example files, T10 owns them. |
| A14 | T2 to T8 | ApiConfig accepts xahau-testnet; harness network | agree: HarnessOptions.network is NetworkName; nothing else needed. |
| A15 | T3 to T4 | network check applied while recording | agree: T3 precedes T4, so a mainnet node cannot be recorded as a testnet. |
| A16 | T3 to T7 | accepted id 21338 for xahau-testnet in the validators e2e fake node | agree. |
| A17 | T3 and T9 | docs/syncer.md | agree: line 44 (accepted ids) versus the head-below paragraph. |
| A18 | T4, T5, T6 | packages/shared/test/fixtures/README.md | agree: append-only sections for xrpl-testnet and xahau-testnet recorded, xahau-testnet network-state, xrpl-testnet unl; recorded/ and network-state/ are different dirs. |
| A19 | T5 and T9 | docs/operations.md | agree: "Keep the amendment metadata current" (:218) versus the new "A testnet was reset"; the link target #name-an-account-on-one-network exists (:121). |
| A20 | T5 to mainnet answers (T11, api-reference.md) | 15 "retired": true marks in config/amendments/xrpl.json | CONFLICT: the marks add a retired: true key to 15 mainnet rows (amendment-status.ts:332 sets it whether or not the ledger lists the id; amendment-object.ts:215 emits it). This contradicts "mainnet's answers do not change" (T5 commit text, T11 rollout item 1, Global Constraints, spec 6 and 15); docs/api-reference.md:3054 still says "Xahau". |
| A21 | T6 to T7 | unlValidators, unlValidatorsOf, unlListCount, unlThresholdOf, LOCAL_PUBLISHER_ID; stored-lists.ts and unl-fetcher.ts config types | CONFLICT: rounds.job.ts:124 and agreement.job.ts:159 type cfg as Pick<'unlPublishers' or 'unlThreshold'> and pass it to loadListContext, whose type T6 widens, so the syncer build breaks in T6; neither file is in T6 or T7. Also validators.e2e-spec.ts:1860 and :3448 build Object.assign(new SyncerConfig(), { unlPublishers }) with no unlValidators (undefined at runtime), and T6 Step 5 runs that e2e while the file is only in T7's list. |
| A22 | T6 to T8 | LOCAL_PUBLISHER_ID through the shared index | agree. |
| A23 | T6 and T10 | syncer.config.spec.ts, apps/syncer/.env.example, docs/configuration.md | agree: T10's "resolves the sandbox compose values" relies on T6's default word and GH_UNL_VALIDATORS and is green on arrival, as T10 says. |
| A24 | T7 to T8 | row shapes of the local publisher and list | agree: fields match UnlPublishersRow and UnlListsRow (rows.ts:523-556); expiration 4294967295 fits DateTime('UTC') (002_validators_amendments.sql:87); insertPublishers defaults url to https://<publisher>, so the T8 seed must pass url '' (publisher_key already defaults to ''). |
| A25 | T8 and T11 | docs/api-reference.md | agree: summary publishers versus the Hosts section (the retired row is A20). |
| A26 | T9 and T11 | operations, troubleshooting, syncer docs | agree. |
| A27 | T10 and T11 | docs/deployment.md, README, architecture | agree: no overlap; T11 Step 3 re-runs all suites. |
| A28 | T1, T5 to T11 | majority holds (T1 Step 2) and any unnamed amendment id (T5 Step 5) go to rollout item 3 | agree. |

### B. Tasks

| # | Task | Own text, code it names, spec values | Finding |
|---|---|---|---|
| B1 | T1 | Interfaces, tests, steps; table versus spec section 1 | Spec values all match (ids, endpoints, databases, holds, keys; CTID suffixes 0001/535A are 1 and 21338 in hex). Tests agree with code (assertValidDatabaseName and assertValidMarketsConfig exist and accept empty lists; (g) fits migrate.e2e-spec). Minor: Files block omits packages/shared/src/xrpl/node-client.ts, which Step 5 edits and Step 7 stages. |
| B2 | T2 | tests versus code, files | CONFLICT via A8. Also: exporter.config.spec.ts is mandated as "a copy of api.config.spec.ts's loadConfig" (verbatim duplicate, C1); docs/configuration.md section 5a has no GH_NETWORK row (prose only). Line refs verified: main.e2e-spec.ts:178, troubleshooting.md:57, configuration.md:17 and :37; networkOf message unchanged. |
| B3 | T3 | table versus spec section 4 and code | agree: String(id) gives 'undefined' as in the code; networkIdProblem text equals today's; start(21338, {GH_NETWORK: 'xahau', ...}) fits the e2e helper. Minor: Review Focus 1 names a test ('refuses a node that reports no network_id for xrpl-testnet') that the it.each title does not produce; Step 4 filter "app" matches every path under apps/ (whole suite). |
| B4 | T4 | tests versus code and files | Verified: xrpl.json AccountRoot flags hold DefaultRipple 0x00800000 and AllowTrustLineClawback 0x80000000; xahau.json definitions have no LEDGER_ENTRY_FLAGS, so the predicted failure message equals the code's. Gaps: (a) the existing describe.each tests index all[3] (tx-object.e2e-spec.ts:110-111, fetchByKeys), but Step 1 only requires Payment plus OfferCreate in three ledgers, with no minimum of 4 transactions (Xahau Testnet is quiet); (b) the test casts to a type Definitions that exists nowhere in repo or plan. |
| B5 | T5 | tests versus loader (amendments-config.ts:168) and amendment-status | Verified: all 15 names exist in xrpl.json with enabled and none is retired yet; xahau.json has the 13 listed names and not id AB6612F1...; existing network-mismatch tests still hold. CONFLICT via A20. Also: unqualified pnpm amendments:check in Step 5 (C4); the 15-name list is repeated in two tests of one spec (C1). |
| B6 | T6 | tests versus syncer.config.ts and its spec | CONFLICT via A21. Also: syncer.config.spec.ts:411 asserts 'number of publishers (0)' and is not in the "(2) and (1)" rewrite; unlThresholdOf calls at spec :442-445 need unlValidators; IsWithinPublishers must keep skipping unreadable text (existing test :384-389), which the plan does not say. Spec values match; MaybeEmptyText transform (trim, fallback) fits the described defaultWord option. |
| B7 | T7 | registerPublishers, localListRow, loadListContext versus unl-fetcher.ts | agree: publisher row fields, fetchOnce message "local is not a configured UNL publisher", skip of local in the configured=0 loop, upper-case blob hash (unl-list.ts:158), thresholds 1 and 3 by defaultUnlThreshold(2 or 4). Spec says effective: now; plan floors it (column is DateTime), same effect. Depends on A21. |
| B8 | T8 | summary-object, seed, e2e | agree: compact() drops only undefined so '' url and public_key stay; key order of the example equals PUBLISHER_KEYS; summary-object.ts:99 is the only place a list expiration is exposed; directory filter matches local's '' key; scope=unl exists. |
| B9 | T9 | six runner cases versus live-runner.ts and the e2e helpers | agree: ChainBreakError halts through :303 and :584; fetches [L(5)] holds because TestSource.available equals head. Note: "raising the head" in cases 2 and 4 must also raise source.available (e2e :932-933 do both) or fetch(L(11)) fails. Spec section 11 matches (plan adds: a gap waits). Global Constraint conflict: C6. |
| B10 | T10 | show script, compose, sandbox example | CONFLICT: (a) show passes only --profile exports; for docker-compose.yaml that fails ("service exporter-xrpl depends on undefined service migrate-xrpl", reproduced), the dev file needs --profile full --profile xahau --profile exports --profile xahau-exports; Step 4's expectations for it cannot be produced; (b) the sandbox example is "the production example's variables" plus the spec block, which has no XRPL_VALIDATION_ENDPOINTS, and deploy/.env.prod.example:37 sets it to mainnet nodes; the testnet syncer's validations collector would be refused by assertNetwork; (c) the check only prints. Production output verified as T10 Step 2 states. |
| B11 | T11 | docs and verification | Minor gaps: Step 2 grep xrpl|xahau[^|] cannot match the escaped xrpl\|xahau of docs/development.md:131-132 and docs/observability.md:254 (observability is in no task's Files); GLOSSARY.md has entries for network, testnet, family, profile, environment and fixed list but none for "kind" (only in an Avoid line) or "sandbox"; api-reference retired row (A20). |

### C. Other flags

| # | Kind | Finding |
|---|---|---|
| C1 | verbatim duplicated logic | T2 mandates exporter.config.spec.ts as a copy of api.config.spec.ts's loadConfig helper; T5's new XRPL test repeats the 15-name list of the existing Xahau test. Share one helper or constant. |
| C2 | assertion-free check | T10 Step 1 `show` prints and never fails on a mismatch (compared by eye with Step 4 prose); its jest case is green on arrival and overlaps T6's cases. No other assertion-free test found (negative assertions in T4, T5, T9 sit beside positive ones). |
| C3 | relies on something unproduced | none found: LOCAL_PUBLISHER_ID, kind, family, acceptedNodeNetworkIds, record modes, fixturePayments, getTxCtid, testKey, harness network option all come from the repo or an earlier task. Only the undefined type Definitions (B4). |
| C4 | commands | every pnpm script named exists; pnpm amendments:check in T5 Step 5 is not a root script (only packages/shared; the docs use the --filter form); pnpm lint exists but the plan forbids it. Jest filter "app" (T3, T9) matches every path containing "apps". |
| C5 | paths | all ~85 Modify paths exist, all Create paths are absent; Dockerfile lines 38/44 and doc lines 17, 37, 44, 57 and main.e2e-spec.ts:178 are right. The x-explorer specs (E7, overview) exist only under x-explorer-worktrees/explorer-pages-2. |
| C6 | Global Constraints | "Mainnet behaviour does not change, except D10 and compose defaults" is contradicted by T9 (every network now halts on another hash below the checkpoint, spec section 11) and by T5 (retired key, A20). |
| C7 | notation | D3, D4, D5, D9 mean sub-projects in T1 Interfaces and Ruling 1, but spec decisions in T1 Step 2 ("D5's decision"), T6, T10, T11 ("D3"). |
| C8 | trailer | The plan fixes Co-Authored-By: Claude Opus 5.5; the session attribution line is Sonnet 5.5. Pick one before dispatch. |
| C9 | names | Review Focus test names that differ from the task text: item 1 (see B3) and item 4 ("assembleAmendments: a retired amendment not in the ledger has no enabled object" versus T5's "a retired XRPL amendment that the ledger does not list is enabled with no enabled object"). |

### Conflicts and suggested rulings

1. A8/B2: T2 also types recordNetworkState's o.network as NetworkName and rewrites record-fixtures.spec.ts:77 and :82.
2. A20/B5: accept retired: true as an additive key on 15 mainnet rows; correct the "answers do not change" claims, update api-reference.md:3054, assert it in amendment-status.spec.
3. A21/B6: add rounds.job.ts, agreement.job.ts and validators.e2e-spec.ts (:1860, :3448) to T6's Files; add the :411 "(0)" assertion.
4. B10(a): show takes all four --profile flags for docker-compose.yaml.
5. B10(b): sandbox example blanks XRPL_VALIDATION_ENDPOINTS and XAHAU_VALIDATION_ENDPOINTS; add GH_VALIDATION_ENDPOINTS to show.
6. B4(a): T4 Step 1 requires at least 4 transactions across the three ledgers.
7. C6: add T9 and the T5 key to the Global Constraints exception.

## Pre-flight rulings (controller)
Ruling: P1 (T2) Options.network: NetworkName also retypes recordNetworkState's network param (record-fixtures.ts:336, call :499) and rewrites record-fixtures.spec.ts:77,82 — cost if wrong: none.
Ruling: P2 (T5) 15 XRPL entries get retired: true, which adds a `retired` key to mainnet amendment rows — accept; correct the "mainnet answers unchanged" claims and update api-reference.md:3054 — cost if wrong: a visible added key on mainnet (additive).
Ruling: P3 (T6) widening loadListContext also updates rounds.job.ts:124, agreement.job.ts:159, validators.e2e-spec.ts:1860,3448 and the spec's line-411 "(0)" — cost if wrong: none.
Ruling: P4 (T10) `show` passes all four compose profiles (exports alone fails: "depends on undefined service migrate-xrpl") — cost if wrong: none.
Ruling: P5 the sandbox env blanks both XRPL/XAHAU validation endpoint variables (prod's mainnet values would refuse the boot) — cost if wrong: sandbox validations stream off until GateHub sets testnet endpoints.
Ruling: P6 (T4) the recording must hold at least 4 transactions (existing tx-object e2e indexes all[3]) — cost if wrong: none.
Ruling: P7 Global Constraints' "mainnet unchanged" lists T5 (retired key) and T9 (halt on any network) as exceptions — cost if wrong: none.
Task 1: dispatched implementer (sonnet) BASE 8a0f648 — report task-1-report.md
Task 1: implementer DONE_WITH_CONCERNS a254fa5 (build+test green; shared e2e 876 green).
Ruling: XRPL Testnet majorityHoldSeconds = 1800 (not the spec's assumed 14 d): 7 got-majority/enabled pairs found via the Amendments object's PreviousTxnID chain, each enabled 768 ledgers after majority — Task 11 docs must say 30 minutes — cost if wrong: testnet amendment 'expected' dates shown too early; an inferred value, not published.
Ruling: commit trailer is the session's 'Co-Authored-By: Claude Opus 5.5' for every commit (a254fa5 carries 'Claude Sonnet 5.5' and stays; no amend) — cost if wrong: attribution names the session model, not the subagent's.
Task 1: complete (commits 5e498c2..a254fa5, review clean)
Task 1: minor (deferred): NetworkProfile doc says XRPL/Xahau only (and clickhouse.config.ts:49-51) — fix in Task 11; endpoint comment claims rippled verification w/o source; ACCEPTED_NETWORK_IDS duplicate must be removed by Task 3 (check in Task 3 review); duplicate 'unknown network' test (plan-mandated)
Task 2: dispatched implementer (sonnet) BASE a254fa5, with ruling P1
Task 2: implementer DONE_WITH_CONCERNS 83f7fd7 (build+test green; e2e shared 876, service 2669, syncer 334). Concerns -> Task 11: export-worker.ts comments, configuration.md CTID line 28 and GH_CLICKHOUSE_DATABASE row 52; formatter drift noted in IMPLEMENTER.md. Review dispatched (sonnet).
Task 2: ⚠️ '§5a exporter row' — resolved: §5a has no GH_NETWORK row; the sentence edit stands; §7 exporter rows belong to Task 10.
Task 2: complete (commits a254fa5..83f7fd7, review clean)
Task 2: minor (deferred): networkIdProblem doc/absent network_id (Task 3 handles); no test of boot lines or amendments-check w/o --network; stale text export-worker.ts:48,113, configuration.md §1 (~28, 751-753), GH_CLICKHOUSE_DATABASE (~52) and GH_NODE_ENDPOINTS (~762) rows — Task 10/11; long USAGE line
Task 3: dispatched implementer (sonnet) BASE 83f7fd7 (must remove ACCEPTED_NETWORK_IDS duplicate and fix networkIdProblem for testnets)
Task 3: implementer DONE 911e139 (build+test green; syncer e2e 335, shared e2e 876). Review dispatched (sonnet).
Task 3: complete (commits 83f7fd7..911e139, review clean)
Task 3: minor (deferred): networkIdProblem treats JSON null network_id differently from assertNetwork (no practical effect); long docs line
Task 4: dispatched implementer (sonnet) BASE 911e139, with ruling P6
Task 4: implementer NEEDS_CONTEXT (uncommitted) — plan defect: tx-object.e2e testnet rows boot the API with GH_NETWORK=xrpl-testnet|xahau-testnet, but loadAmendmentsConfig reading the family's file is Task 5's; 28 tests fail in beforeAll (ENOENT). With temp stubs everything passes (api e2e 2700, shared e2e 876).
Ruling: Task 4 commits with the testnet rows of tx-object.e2e-spec.ts skipped (describe.skip/it.skip with a comment: enabled by Task 5, the amendments loader reads the family's file); Task 5's brief gains 'remove that skip' as part of its GREEN — keeps commits green and task boundaries — cost if wrong: 28 tests dark for one task.
Task 4: implementer DONE_WITH_CONCERNS dfd7044 (build+unit green; tx-object/account-flags e2e 67 pass, 28 skipped per ruling; full api e2e 2700 + shared e2e 876 passed with temp stubs before the skip). Task 5 must flip describe.skip.each -> describe.each in tx-object.e2e-spec.ts. Review dispatched (sonnet).
Task 4: complete (commits 911e139..dfd7044, review clean)
Task 4: minor (deferred): 'own definitions file' tests can't tell testnet file from mainnet (could pin xahau-testnet hash); README '3 to 21 transactions' wording; orphan line in account-flags.ts:12 doc comment; commit msg says recordings prove CTID/round trip (true only after Task 5)
Ruling: Task 5 also adds, when re-enabling the testnet rows, an assertion that a recorded tx with Account "" keeps Account "" in json.tx (pins the roundTrip change) — cost if wrong: one line.
Task 5: dispatched implementer (sonnet) BASE dfd7044, with rulings P2, P7, flip skip + Account "" assertion
Task 5: implementer DONE_WITH_CONCERNS 3035a5c (build+unit green; e2e shared 876, api 2710 incl. re-enabled testnet rows 30, syncer 335; amendments:check exit 0 on all four). fixXahauTestnetGenesis named (testnet/tmp-dev branch only). Spec §6/§15 'mainnet unchanged' wording -> Task 11. Review dispatched (sonnet).
Task 5: complete (commits dfd7044..3035a5c, review clean)
Task 5: minor (deferred, FLAG for final review): fixXahauTestnetGenesis in xahau.json (shared by Xahau mainnet) adds a 'voting' row to Xahau mainnet's board (plan-mandated; precedent: other testnet-only names) — consider hiding names a network's node doesn't know; Account '' test asserts nothing on 5 seeds; stale '<network>.json' wording in amendments-check.ts:8, .env.example files, deploy/.env.prod.example:54, api-reference ~3058 (Task 11); hand-built fixture path in amendments e2e; long comment line
Task 6: dispatched implementer (sonnet) BASE 3035a5c, with ruling P3
Task 6: implementer DONE 99fc706 (build+unit green; syncer e2e 335, shared e2e 876). Docs compose rows + .env.example -> Task 10/11. Review dispatched (sonnet).
Task 6: ⚠️ loadListContext doesn't yet read the local list while unlListCount counts it — owned by Task 7 (carry into Task 7 dispatch).
Task 6: complete (commits 3035a5c..99fc706, review clean)
Task 6: minor (deferred): fixtures README overclaims spec coverage of testnet validator manifests (add file to manifest/node-key RECORDED lists or reword); README:359 record:fixtures --network list; defaultUnlThreshold param name 'publishers' -> 'lists'; IsWithinPublishers name
Task 7: dispatched implementer (sonnet) BASE 99fc706 (must close the loadListContext/local gap)
Task 7: implementer DONE 36e5a33 (syncer unit 1336, syncer e2e 337); deviation: e2e boots with domains:false (a still-running domain pass logged socket hang up on close). Review dispatched (sonnet).
Ruling: Task 7's e2e boots with worker.start {state:false, domains:false} (brief said state:false only) — accepted: validators-env.ts documents domains:false for avoiding a pass under way at close; the unit spec covers the domain checker's fixed list — cost if wrong: no e2e of the domain loop with the fixed list.
Task 7: complete (commits 99fc706..36e5a33, review clean)
Task 7: minor (deferred): stored-side sort in storeFixedList not pinned (spec with unsorted stored validators); e2e web.requests [] trivially true; two sorts of keys (optional sortedKeys helper)
Task 8: dispatched implementer (sonnet) BASE 36e5a33
Task 8: implementer DONE c0d5d91 (build+unit green; api e2e 2713). Review dispatched (sonnet).
Task 8: complete (commits 36e5a33..c0d5d91, review clean)
Task 8: minor (deferred): api-reference:2719 'unl' differences row omits the fixed list (Task 11); seed comment '20 s' vs 20.5; api-reference.md prettier (baseline?)
Task 9: dispatched implementer (sonnet) BASE c0d5d91, with ruling P7
Task 9: implementer DONE_WITH_CONCERNS 6a2f31b (build+unit green; shared e2e 877, syncer e2e 344). Concerns: boot head-fetch failure retried by prepare(); a reset during checkpoint wait isn't re-checked until restart (design). Review dispatched (sonnet).
Task 9: complete (commits c0d5d91..6a2f31b, review clean; opus reviewer found no false-halt route on mainnet)
Task 9: minor (deferred, FLAG for final review): mainnet boot now logs head-poll failures at error level with recovering:true (was debug/warn) — consider untilDone('warn') for the head read; boot-time wait never re-checks a reset (plan-mandated); 'below first' can halt a testnet whose node is merely far behind (plan-level; runbook mitigates); untested paths: loop check failure retry, boot check retry, headBelowChecked clear; duplicated pending condition; throttled check warns; live-runner.ts size; operations.md SQL hard-codes xrpl_testnet
Task 9 ⚠️ -> Task 10: operations.md step 4 'a plain dc up -d would also scale the apis back to 1' and <slot>=xrpl/xahau for testnet services depend on Task 10's compose — Task 10 must make them true or correct the runbook.
Task 10: dispatched implementer (sonnet) BASE 6a2f31b, with rulings P4, P5 + Task 9 runbook check
Task 10: implementer DONE 1606203 (build+unit green; syncer e2e 344; compose resolution checked with all 4 profiles; real up -d not run — image build needs NPM_TOKEN). Review dispatched (sonnet).
Task 10: complete (commits 6a2f31b..1606203, review clean)
Task 10: minor (deferred) -> Task 11 carry-over (see task-11-carryover.md); CI doesn't guard compose wiring (plan-mandated manual show); owner to confirm GH_CORS_ORIGINS empty and the 6000 rate budget in the sandbox file
Task 11: dispatched implementer (sonnet) BASE 1606203, with the carry-over list
Task 11: implementer DONE_WITH_CONCERNS a55d5b1, 44dff68, ce1f33d, f59102e (all suites green: shared 1683/877e2e, api 1854/2713e2e, syncer 1337/345e2e). Concerns: spec §8 vs payment_volume native component (documented code behaviour); fixXahauTestnetGenesis voting row on Xahau mainnet (owner decision; ADR-0012 says so); owner inputs: majority holds, sandbox CORS/rate budget. Review dispatched (sonnet).
Task 11: complete (commits 1606203..f59102e, review clean)
Task 11: minor (deferred): api.config.ts:152/syncer.config.ts:376 GH_AMENDMENTS_CONFIG '<network>.json' comments; development.md:75-77 testnet: .env.example sets GH_NODE_ENDPOINTS explicitly (say comment it out); live-runner e2e recovering assertion vacuous; ADR-0012:46 'per network' (superseded below); long ADR amendments
ALL 11 TASKS COMPLETE. Final whole-branch review dispatched (opus) on 8a0f648..f59102e.
Final review (opus): With fixes — Important: fixXahauTestnetGenesis gives Xahau mainnet a permanent 0-vote 'voting' row; Minors: loop-path reset case untested, api/syncer config comments '<network>.json', syncer .env.example GH_NODE_ENDPOINTS uncommented, account-flags.ts orphan wrap. No false-halt route on mainnet; T9 flagged log level already resolved by a55d5b1.
Ruling: mark fixXahauTestnetGenesis "obsolete": true in xahau.json (as AMMClawback/HookOnV2 are) so Xahau mainnet shows it obsolete and Xahau Testnet still enabled; one fix wave with Important 1 + Minors 1–4 — cost if wrong: an amendment the testnet later renames would need its own entry.
Final fix wave dispatched (sonnet) BASE f59102e.
Final fix wave DONE: 1d9c9b4, a6aacee, 5294876 (build+unit+e2e green). Scoped re-review dispatched (sonnet).
Final fix wave re-review: all 5 addressed, no new breakage (f59102e..5294876).
D-env COMPLETE (8a0f648..5294876). Workspace kept until program end to collect rulings.
