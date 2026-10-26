# SDD ledger — plan: docs/superpowers/plans/2026-10-24-sandbox-environment.md
BASE (plan start): 6ed915b
Baseline (6ed915b): pnpm typecheck ok; pnpm test 9798/9801 — 3 worker-project timeouts (account-analytics-flight, market-pair-live, transaction specs) under machine load; all 72 pass when re-run alone.
Ruling: baseline counts as green — the 3 worker specs are load-sensitive (5 s timeouts) — cost if wrong: a real regression in them could be mistaken for flakiness, so implementers must re-run any failing worker spec alone before calling it flaky.

## Pre-flight scan

Read-only scan of `docs/superpowers/plans/2026-10-24-sandbox-environment.md` (T1..T11) against the spec and the worktree at BASE `6ed915b`. Nothing was edited, built or run. "agree" = checked and consistent; "conflict Cn" = needs a ruling before dispatch (rulings are listed under the tables).

### A. Task pairs that share a file or an interface

| # | Pair | Shared file / interface (produces -> consumes) | Finding |
|---|---|---|---|
| P1 | T1 x T2 | `wrangler.jsonc`, `scripts/predeploy-guard.ts`, `scripts/predeploy-check.test.ts`, `README.md`; T1 produces `sandbox` block, `ENVIRONMENTS`, `deploy:sandbox`; T2 puts real values and `DEPLOYED` (keyed `sandbox`/`production`) on them | agree on names. conflict C1: T1 renames the existing cases, T2's new rules then break some of their expectations (see T2) |
| P2 | T1 x T11 | `README.md` (T1 renames 59 lines; T11 rewrites sections) | agree: T11 Step 3 re-runs `no-staging`, and the T11 text never needs the old word (the `x-explorer-staging` note goes in the task report, not the README) |
| P3 | T2 x T11 | `README.md`, section "The pipeline and deploying" | agree: Ruling 8 splits it (T2: guard rules, "Hosts and routes", summary line; T11: secrets, "The sandbox", checklists); the paragraphs are disjoint |
| P4 | T2 x T3 | T2 produces `Env.ENVIRONMENT`; T3's root loader reads it | agree |
| P5 | T2 x T4 | `vitest.config.ts`: T2 adds `ENVIRONMENT: "development"` to `testBindings`; T4 builds `sandboxBindings = { ...testBindings, ENVIRONMENT: "sandbox" }` and the project | agree (the head comment of `vitest.config.ts` still says the root config is for `worker` and `worker-off`; T4 should say three: cosmetic) |
| P6 | T2 x T10 | `app/server/env.ts` (T2 `Env`, T10 `cacheGeneration`), `env.test.ts`, `edge-cache.spec.ts`, `entry.spec.ts`, `features-off.spec.ts` (hand-built `Env` in T2, generation/Sentry cases in T10) | agree on the interface; conflict C7 (T10 assertions on the generation are not only "exact strings") |
| P7 | T3 x T4 | `test/support/under-network.tsx` (T3 `environment` option; T4 new fields on its XRPL constant); T3 `environmentOf`/`networkKindOf`/`NetworkKind` -> T4 `networkOf`, `NETWORK_NAMES` | agree |
| P8 | T3 x T5 | `app/root.tsx` (T3 `loader`/`shouldRevalidate`; T5 `meta`/`ErrorBoundary`); `useEnvironment`, `ROOT_ROUTE_ID`, `RootLoaderData.environment` | agree: T5's `loaderData?.environment ?? "development"` matches T3's contract |
| P9 | T3 x T7 | `useEnvironment` -> `Header`; `renderUnderNetwork(..., { environment })` -> Header tests | agree ("none" in T7's test = no root data = development, as T3 specifies) |
| P10 | T3 x T10 | `test/worker/layout.spec.ts` (T3 `.data?_routes=root` case; T10 "no X-Robots-Tag"); `environmentOf` -> `cacheGeneration` | agree |
| P11 | T4 x T5 | `app/ui/networks.ts` (T4 adds `NETWORK_NAMES`, T5 rewrites the rest); `net.search.tsx`, `net.validators.$key.tsx`, `net.amendments.$name.tsx` (T4: other-network loaders; T5: clientLoader/meta: different functions); sandbox spec | agree on the interface (names table = spec 5; `findNetwork` keeps one argument until T5 so T4 compiles). conflict C2: T5 changes `NetworkBrief`/`NetworkInfo`, T4's "hand-built" clause does not cover them |
| P12 | T4 x T6 | `net.amm.$pool.tsx` (T4: `other = networkOf(net.other, env)`; T6: note uses `other.longName`); `Network.label/longName/dexName` -> T6 pages | agree |
| P13 | T4 x T7 | only the sandbox spec (T4 creates it) | agree |
| P14 | T4 x T8 | `Network.displays` -> `NetworkViews` | agree on the interface; conflict C3 (`NetworkInput["net"]` and its test) |
| P15 | T4 x T10 | `worker-sandbox` project and `*-sandbox.spec.ts` naming -> T10's sandbox cases | agree |
| P16 | T5 x T6 | `app/server/meta.ts` (T5 `metaContext`; T6 drops `DEX_NAMES`, and from `META_EXPORTS` of `meta-bundle.test.ts`), `meta.test.ts`, `components.test.tsx`, sandbox spec; `NetworkBrief`/`NetworkInfo`/`networkChoices`/`findNetwork`/`metaContext` | agree (`homeMeta`/`ammListMeta` get `longName` from the layout network that T5's `metaContext` returns) |
| P17 | T5 x T7 | `root.tsx`/`net.tsx` `ErrorBoundary` (T5) draw the `Shell`/`Header` that T7 gives the badge; `components.test.tsx`, `routes-wiring.test.tsx` | agree |
| P18 | T5 x T8 | `net.network.tsx` clientLoader: T5 `isNetworkId(params.net ?? "")`, T8 `{ id, displays: ALL_DISPLAYS }`; `routes-wiring.test.tsx` | agree (Ruling 4) |
| P19 | T5 x T9 | `NetworkInfo.kind` -> `unlIntro`; `meta.test.ts` | agree on the interface; conflict C2 (the hand-built `NetworkInfo` of the validators tests break at T5, not T9) |
| P20 | T5 x T10 | sandbox spec only | agree |
| P21 | T6 x T7 | `components.test.tsx`, sandbox spec | agree |
| P22 | T6 x T8 | `NetworkPage.tsx`/`NetworkPage.test.tsx` (T6 `NETWORK_TITLES`, `ammWording`; T8 `networkHref`), sandbox spec | regions disjoint; conflict C3 (`networkHref(network, ...)` with a `NetworkInfo`) |
| P23 | T6 x T9 | `meta.test.ts` | agree |
| P24 | T6 x T10 | sandbox spec | agree |
| P25 | T7 x T8 | `routes-wiring.test.tsx`, sandbox spec | agree |
| P26 | T7 x T10 | `layout.spec.ts` ("shows no Testnet badge" / "has no X-Robots-Tag on a page": two cases, distinct names), sandbox spec | agree |
| P27 | T8 x T10 | T8's 302 on `?in=usd` -> T10's `it.each` includes `/xrpl/network?in=usd` | agree (T8 before T10) |
| P28 | T1 x T3..T10 (8 pairs) | `test/unit/no-staging.test.ts` constrains every later file | agree: T3 builds the word from halves; no other task writes it; leftovers in T1 itself: C8 |
| P29 | T11 x T3..T10 (8 pairs) | README documents their names, flags and checks (spec 14 list) | agree: every README section T11 names exists (Getting started, Scripts, Configuration, Switches, The data API and the node, SEO and link previews, Tests, End-to-end tests, The pipeline and deploying, The client bundle check) |

### B. One row per task: does the task agree with itself and with the spec?

| Task | Tests vs code / files vs later touches / names vs Interfaces | Spec values quoted | Verdict |
|---|---|---|---|
| T1 | The 13 files of its list are exactly the 13 files that contain the word (grep over the walked places); README has 59 lines; `deploy:sandbox` equals the steps the existing test expects. Leftovers: `test/worker/meta.spec.ts` has a local variable `staging` (the plan names only the URL), and `predeploy-check.test.ts` has cases `"Staging"`, `"STAGING"`, `"staging "` (an old name is a useful "unknown environment" case, so it must be built from halves) | spec 2 table: agree (release.yml moved to T2, it has no such word) | minor, C8 |
| T2 | Interfaces, message formulas and the six quoted texts agree with spec 4. conflict C1: existing cases that the new rules break. Gaps: only three route messages (an extra route, `zone_name` or a string route has none); Step 1 outcome B (routes absent from `build/server/wrangler.json`) leaves `checkBuild`'s scratch-root tests without a way to give routes; "keeps one reason for a placeholder or a plain-http URL" is the existing cases again | `DEPLOYED`, `KNOWN_NODES`, hosts, namespaces 1000/1001/1002, summary line: agree | C1 |
| T3 | `environmentOf`/`networkKindOf`/`useEnvironment`/`ROOT_ROUTE_ID` consistent across Interfaces, tests and T5/T7 uses; `app/ui/environment.test.ts` runs in `components` (Ruling 3) | spec 5, 6: agree | agree |
| T4 | Facts and names tables agree with spec 5 cell by cell; CTID 21338 = 0x535A, 21337 = 0x5359. conflict C5: its `search.spec.ts` case duplicates an existing one; Review Focus 4 cites it under another title. `PAYMENT`/`REMIT` are non-exported consts of `transaction.spec.ts`, so T4 must declare them in the new spec (T5, T6, T10 reuse them). Spec 12 lists unit cases for `resolve`/`search-view` CTIDs that no task writes (the sandbox spec covers 7.7) | spec 5, 7.4, 7.7: agree | C5 |
| T5 | conflict C2. Otherwise: all `findNetwork`/`DEFAULT_NETWORK`/`NETWORK_CHOICES` users are in its list (grep), the five clientLoaders are exactly the five that use `findNetwork(params.net)`, `metaContext` tests match the new rule. `findNetwork` returns `| undefined`, so the two `ErrorBoundary`s need a fallback (not said) | spec 6, root description: agree | C2 |
| T6 | Its list covers every hit of its own grep (AmmListPage:259, NoAmmPage, RouteErrorScreen:127, network-volume:74-75, HomePage:24/100, meta-amm-list:12, DEX_NAMES, markets-view:321/331-334, analytics-view:395, net.amm.$pool:102, card-data:42, NetworkPage:30, root description in T5). conflict C6. The `/og` case asserts 200 and `image/png`, which passes in development too | spec 7.1, 7.3: agree; texts rebuilt from `dexName`/`longName` reproduce today's mainnet sentences | C6 |
| T7 | Token values, contrast (7.07 light, 9.54 dark, computed) and `.pill--testnet` declarations agree with spec 7.2; `icon={null}` is redundant (the testnet tone has no icon of its own); `.hdr__brandgroup` is not in the spec (Ruling 6) | agree | agree |
| T8 | conflict C3. The redirect already exists (`net.network.tsx` line 66); `network-params.test.ts` expectations were checked by hand and hold | spec 7.5: agree | C3 |
| T9 | conflict C4. Intro wording reproduces today's mainnet sentence exactly; D-env `local` shape quoted correctly (`data-api-worktrees/explorer-data-2` spec section 5); Review Focus 1 quotes the shape test without "and no expiration" (title drift only) | spec 7.6: agree | C4 |
| T10 | conflict C7 is a completeness gap only. `cacheGeneration` normalises through `environmentOf` (Ruling 14; spec 8 writes the raw value); Sentry option as spec; the `Pick<Env, "ENVIRONMENT">` signature fits `workers/app.ts` | spec 8: agree (one ruled deviation) | C7 |
| T11 | README-only; Step 1 measures before Step 2 writes, as it should; rollout (Step 5) equals spec 15 | spec 14, 15: agree | agree |

### C. Other flags

| # | Flag | Where | Note |
|---|---|---|---|
| F1 | Test that asserts (almost) nothing | T6 `/og/xrpl/tx/{hash}.png renders` | 200 and `image/png` hold in development as well; the sandbox part is only the card-data unit test |
| F2 | Duplicated test | T4 `search.spec.ts` case | repeats the existing "is a 404 for a network id that is neither XRPL's nor Xahau's" (same CTID id 1, same sentence); see C5 |
| F3 | Redundant or drift-prone | T2 | `DEPLOYED.kind` and the four labels re-encode `networkKindOf` and `NETWORK_NAMES[..].label` (spec-mandated; the script already imports `app/ui/features`); "keeps one reason..." repeats existing cases |
| F4 | Convention | T6 commit | `git add app/ui/pages` adds a directory; Global Constraints say name the files |
| F5 | Task relies on something no earlier task produces | T5 (tests), T6, T8, T9 | the hand-built `NetworkInfo`/`NetworkBrief`/`NetworkInput["net"]` literals of ~20 test files; see C2, C3 |
| F6 | Task relies on something no earlier task produces | T5, T6, T10 | `PAYMENT` in the sandbox spec: not exported anywhere (T4 creates the file; say it declares them) |
| F7 | Commands | all tasks | every `pnpm` script exists in `package.json` (`test`, `test:e2e`, `verify`, `build`, `check:bundle`, `fixtures:check`, `api:check`, `typecheck`, `deploy:production`); `deploy:sandbox` is created by T1; `vitest run --project worker-sandbox` is valid for Vitest 5; `pnpm exec playwright install chromium` fine. None missing |
| F8 | Paths | all tasks | every path in a Modify list exists; created: `test/unit/no-staging.test.ts`, `app/ui/environment.ts`+test, `app/ui/networks.test.ts`, `app/server/environment.ts`+test, `test/worker/environment-sandbox.spec.ts`; `build/server/wrangler.json` is a build artifact (T2 Step 1). The D-env spec and plan exist only in `data-api-worktrees/explorer-data-2`, not in the `data-api` checkout |
| F9 | Test-file quirk | T4 sandbox spec | visitor addresses `198.51.100.x` are also used by `entry.spec.ts` and `home.spec.ts`; harmless because `worker-sandbox` is a separate project |
| F10 | Ruled deviations from the spec text | Rulings 9 and 14 | `/xrpl` title in the sandbox is "Explore XRPL Testnet · explorer" (spec 12 says "XRPL Testnet · explorer"); the generation uses the normalised environment (spec 8 the raw one). Both are argued in the plan; no action |
| F11 | Environment build left behind | T2 Step 5 | `CLOUDFLARE_ENV=... pnpm build` leaves an environment build and `.wrangler/deploy/config.json`; every later Step 4 runs `pnpm verify` (which rebuilds) before `pnpm test:e2e`, but T3 Step 4 runs `pnpm test` first: fine because `vitest.config.ts` names `./wrangler.jsonc` explicitly |

### D. Conflicts and suggested rulings

- **C1 (T2, Step 2 / "keeps one reason")**: the existing "does not take a real host that only mentions invalid" case expects `[]` for `XRPL_DATA_API_URL: "https://invalid.example.com/"` (the new data API rule gives one reason), and "refuses a build for another environment" (`good("production")` asked for `sandbox`, and the reverse; also `checkBuild` "a placeholder, and one for another environment") expects length 1 (the new rules print about seven reasons, as spec 4 wants). Ruling: move the first case to a node variable of an unknown host; make the others `toContain` the target-environment reason and `length >= 1`; say so in T2.
- **C2 (T5)**: `NetworkBrief` gains required `kind`, `label`, `longName`, `dexName` (`NetworkInfo` follows) but only `components.test.tsx`, `meta.test.ts`, `routes-wiring.test.tsx` are listed, and no `git add <each file ...>` clause as in T4/T2. `tsc -b` covers `app/**` and `test/**`, so Step 4's `pnpm verify` fails on 14 files that no task names: in `app/ui/pages/` the tests of AccountPage, MarketPairPage, TransactionPage, AccountAnalytics, AnalyticsFilters, SearchPage, LedgerPage, MarketsPage, ValidatorsPage, ValidatorPage, AmendmentPage and AmendmentsPage, and `app/server/amendment-view.test.ts` and `app/server/amendments-view.test.ts`; plus 5 named only later (`HomePage`, `NetworkPage`, `card-data`, `validators-view`, `validator-view` tests). Ruling: T5 gets the T4 clause ("every hand-built NetworkBrief/NetworkInfo of the tests, by name, as `git status --short` lists them"), or a shared `test/support/networks.ts` with the four constants.
- **C3 (T8)**: "`NetworkPage.tsx` (`networkHref(network, ...)`)" passes a `NetworkInfo`, which has no `displays` (T5), to a `NetworkViews` parameter; and `network-view.ts` reads `net.displays` from `NetworkInput["net"]` = `Pick<Network, "id" | "native" | "hasAmm" | "features">`, whose hand-built `XRPL`/`XAHAU` in `network-view.test.ts` (lines 56-57) are in no file list. Ruling: `Filters` passes `{ id: net, displays: data.displays }`; add `"displays"` to the Pick and `app/server/network-view.test.ts` to T8's files and `git add`.
- **C4 (T9)**: "`meta.publishers` hold labels" but `meta-validator.ts` writes `listedByText(publishers)`, which keys on the id `local` (test: `["local"]` gives "on the fixed list"; meta test expects "(on the fixed list)"). Labels would give "listed by Fixed list". Ruling: `meta.publishers` stays the raw `unl_lists` (ids); only `identity.unlPublishers`, row `unlPublishers`, `membership[].publisher` and the select labels are labels; keep the existing `publishers.length > 0` guard (else "()").
- **C5 (T4, `search.spec.ts` case)**: duplicates the existing "is a 404 for a network id that is neither XRPL's nor Xahau's" (id 1, both networks, no upstream call). Ruling: do not add it; extend the existing case with 21338 if wanted; correct Review Focus 4's citation.
- **C6 (T6)**: `AmmListPage`/`NoAmmPage` take only `data` and are rendered by `AmmListPage.test.tsx` through a bare `routed()` (no `/:net` layout), so "from `useNetwork()`" throws in every existing case; the NoAmmPage tests live in `AmmListPage.test.tsx`, not `components.test.tsx`; `AccountAnalytics.test.tsx` (3 calls of `dexWording({ hasAmm, features })`) needs `name` and is unlisted; `git add app/ui/pages` is a directory. Ruling: move those renders under `renderUnderNetwork`, put the NoAmmPage cases beside the existing ones, list `AccountAnalytics.test.tsx`, name the files.
- **C7 (T10)**: "the existing exact strings gain `:development`" misses the assertions that are not exact strings: `env.test.ts` (`toMatch(/^test-build:.../)`, and "names each switch once", which slices after the first colon), `features-off.spec.ts` line 18 (regex), `edge-cache.spec.ts` line 279 (regex; spec 8 counts two tests, it is three files). Ruling: update every assertion on the generation (`edge-cache.spec.ts` is already in the list).
- **C8 (T1)**: the `staging` variable in `meta.spec.ts` and the `"Staging"`/`"STAGING"`/`"staging "` cases in `predeploy-check.test.ts` would trip `no-staging`. Ruling: rename the variable; build the old word from halves in the "refuses to be asked for" case.

Totals: 29 pair rows (A), 11 task rows (B), 11 flag rows (C) = 51 rows; 8 conflicts (C1 to C8).

## Pre-flight rulings (controller)
Ruling: C1 (T2) existing predeploy cases "real host that only mentions invalid"/"another environment" break under the new rules — use a node var of an unknown host for the first; assert contains + length >= 1 for the rest — cost if wrong: a weaker assertion on the guard's message count.
Ruling: C2 (T5) NetworkBrief/NetworkInfo gain required fields; T5 also updates every hand-built literal in test files, by name (as T4's clause) — cost if wrong: a larger T5 diff.
Ruling: C3 (T8) pass { id, displays: data.displays } to networkHref and list network-view.test.ts — cost if wrong: none beyond T8's scope.
Ruling: C4 (T9) keep meta.publishers as ids (listedByText keys on "local") — cost if wrong: labels resolved later in the view.
Ruling: C5 (T4) drop the search.spec case that duplicates the existing network-id-1 test — cost if wrong: none (covered).
Ruling: C6 (T6) render AmmListPage/NoAmmPage tests under the layout; list AccountAnalytics.test; git add names files, not app/ui/pages — cost if wrong: none.
Ruling: C7 (T10) update the regex/slice assertions on the generation too (env.test, features-off, edge-cache.spec:279) — cost if wrong: none.
Ruling: C8 (T1) rename the `staging` variable in meta.spec and the "Staging" cases; build "staging" strings from halves in the no-staging test — cost if wrong: none.
Task 1: dispatched implementer (sonnet) BASE 6ed915b — report task-1-report.md
Task 1: implementer DONE commit 4c332f1 (verify green, 9805 tests); review dispatched (sonnet) on review-6ed915b..4c332f1.diff. Note: controller's plans commit de3d12c sits on top; Task 2 BASE = HEAD at dispatch.
Task 1: complete (commits 6ed915b..4c332f1, review clean)
Task 1: minor (deferred): no-staging regex \b misses identifiers like stagingUrl (plan-mandated); scan lists all test/fixtures before filtering, statSync ENOENT on a missing place; file name no-staging.test.ts carries the word
Task 2: dispatched implementer (sonnet) BASE de3d12c, with ruling C1
Task 2: implementer DONE_WITH_CONCERNS ec2779c (verify green 9852); concerns: URL with creds/query on right origin passes; guard doesn't check Worker name; README secrets wording. Review dispatched (sonnet).
Task 2: complete (commits de3d12c..ec2779c, review clean)
Task 2: minor (deferred): README/release.yml 'guard passes once secrets are set' contradicts 'cannot check secrets' (plan-mandated); data API URL with userinfo/query/hash on right origin passes; README certificate sentence unrequested; Configuration row XRPL_NODE_URL lists mainnet only (Task 11); redundant length>=1; guard doesn't check Worker name; tie guard LABELS to networks table once it exists
Task 3: dispatched implementer (sonnet) BASE ec2779c
Task 3: implementer DONE f436f89 (test 9861, verify green after a load-timeout rerun); review dispatched (sonnet).
Task 3: ⚠️ server env in client bundle — resolved: implementer's pnpm verify (incl. check:bundle and test/unit/*-bundle tests) exit 0 at f436f89.
Task 3: complete (commits ec2779c..f436f89, review clean)
Task 3: minor (deferred): shouldRevalidate=false not pinned by a test; ROOT_ROUTE_ID test asserts a constant; layout.spec substring checks weak (brief-specified)
Task 4: dispatched implementer (sonnet) BASE f436f89, with ruling C5
Task 4: implementer DONE d90163f (verify 9884, e2e 555 passed/11 skipped, worker-sandbox 14); review dispatched (sonnet).
Task 4: complete (commits f436f89..d90163f, review clean)
Task 4: minor (deferred): nameOf(context,id) three copies (tx/search/ledger routes) — optional shared helper
Ruling: Task 5 also tightens environment-sandbox.spec.ts:139 ('never activated' case) to assert the suggestion's label via anchors() — Task 5's switch change would make the page-wide toContain('XRPL Testnet') vacuous — cost if wrong: a few lines in Task 5's diff.
Task 5: dispatched implementer (sonnet) BASE d90163f, with ruling C2 + the spec:139 tightening
Task 5: implementer DONE 11dbcf9 (verify 9902, e2e 555/11, worker-sandbox 18); concern: clientLoaders value-import isNetworkId so app/server/networks.ts ships to browser (+0.6–0.7 KB). Review dispatched (sonnet).
Ruling: Task 5 Important (plan-mandated) — browser code value-imports isNetworkId from app/server/networks.ts, against the global constraint 'Browser files import nothing of app/server as values' — the constraint wins: isNetworkId (and the id list) live in app/ui/networks.ts, ids derived from NETWORK_NAMES' keys (also closes the Minor on NETWORK_IDS completeness); browser files import from there; app/server/networks.ts imports/re-exports it — cost if wrong: a small refactor in the fix round.
Task 5: fix round 1/5 started — resume implementer with: isNetworkId browser import.
Task 5: fix round 1/5 (1 addressed, 0 open; commits 11dbcf9..c4471c6)
Task 5: complete (commits d90163f..c4471c6, review clean after 1 fix round)
Task 5: minor (deferred): no sandbox test of net.search meta title; not-found.tsx dropped its ?? fallback; NetworkId union still declared in server (tied by types+test); plan text still says isNetworkId lives in server (overridden by ruling)
Task 6: dispatched implementer (sonnet) BASE c4471c6, with ruling C6 (+ note: isNetworkId from app/ui/networks)
Task 6: implementer DONE_WITH_CONCERNS 43c6621 (verify 9926, e2e 555/11); concerns: private dexLine(amm) extracted in network-volume.ts; AmmListPage.test builds its own layout route tree (sync helpers) instead of the async shared helper. Review dispatched (sonnet).
Task 6: complete (commits c4471c6..43c6621, review clean)
Task 6: minor (deferred): XAHAU/XAHAU_TESTNET test constants lack hasAmm:false/software xahaud; AmmListPage.test duplicates layout helper (sync variant of shared helper would dedupe); environment-sandbox.spec re-parses title (hoist tagsOf); og tx test passes before/after; labelOf alias
Task 7: dispatched implementer (sonnet) BASE 43c6621
Ruling: the sandbox desktop header wrapping to two rows (switch 267 px with testnet names + 72 px badge) is accepted — the approved TokensMpt board wraps the same way at 1440 px; production/development stay one row — cost if wrong: a later header-tightening polish.
Task 7: implementer DONE_WITH_CONCERNS 5892906 (verify 9940 on rerun, e2e 555/11). Review dispatched (sonnet).
Task 7: complete (commits 43c6621..5892906, review clean)
Task 7: minor (deferred): test names differ from the brief's wording; title-regex guard weak in environment-sandbox.spec.ts:100; redundant icon={null} (brief-mandated)
Task 8: dispatched implementer (sonnet) BASE 5892906, with ruling C3
Task 8: implementer DONE 7669505 (verify 9950, e2e 555/11). README ~2409 manual check list -> Task 11. Review dispatched (sonnet).
Task 8: complete (commits 5892906..7669505, review clean)
Task 8: minor (deferred): sandbox redirect spec doesn't assert no subrequest-cache lookup; it.each %j titles verbose; Display JSDoc restates networks.ts fact
Task 9: dispatched implementer (sonnet) BASE 7669505, with ruling C4
Task 9: implementer DONE_WITH_CONCERNS d9a78ff (verify 9969, e2e 555/11); publisher words moved to app/domain/publishers.ts (browser-safe); out-of-scope: UnlTag hidden text 'Listed by Fixed list', amendment-view tally '… on local' on Xahau Testnet, api-types public_key doc. Review dispatched (sonnet).
Ruling: spec 7.6 ('every place that shows a publisher's id uses it [the label]') is unmet outside Task 9's file list — AmendmentPage.tsx:327/amendment-view.ts:453 '…, on local', UnlTag 'Listed by Fixed list' (StatusMarks.tsx:110), ValidatorPage.tsx:108 mono label — fixed now as Task 9 fix round 1 by the same implementer, with tests; mainnet texts unchanged — cost if wrong: a few files outside the brief.
Task 9: fix round 1/5 started — amendment 'on local', UnlTag phrase, mono label.
Task 9: fix round 1/5 (3 addressed, 0 open; commits d9a78ff..c3d6cbe)
Task 9: complete (commits 7669505..c3d6cbe, review clean after 1 fix round)
Task 9: minor (deferred): stale comments validators-view.ts:84/validator-view.ts:63 (unlPublishers vs listedBy); ValidatorPage detects fixed list by label string; 'Listed by the fixed list' vs 'on the fixed list' wording; noticesOf 'No validator is trusted' with local ok + others unavailable (can't happen today); api-types public_key comment; >=3 lists + local double 'and'
Task 10: dispatched implementer (sonnet) BASE c3d6cbe, with ruling C7
Task 10: implementer DONE ebc908d (verify 9999, e2e 555/11, worker-sandbox 32). README generation format -> Task 11. Review dispatched (sonnet).
Task 10: complete (commits c3d6cbe..ebc908d, review clean)
Task 10: minor (deferred): og image row in sandbox spec passes without wrapper (brief-mandated); withHeader exported from logging.ts with request-id-specific doc; data-API key test sits in createSubrequestCache describe; a thrown render answers without noindex
Ruling: Task 11 also fixes the README items earlier tasks deferred to it: generation format (~140, ~166), the Configuration rows for XRPL_NODE_URL/XAHAU_NODE_URL (sandbox testnet nodes), the ?in=usd manual check (~2409: no USD view on XRPL Testnet), the worker-sandbox vitest project in the test-projects description, and the README/release.yml 'guard passes once the secrets are set' wording (the guard cannot see secrets) — cost if wrong: none (docs).
Task 11: dispatched implementer (sonnet) BASE ebc908d, with the README carry-over ruling
Task 11: implementer DONE_WITH_CONCERNS 63e15f7 (verify 9999, e2e 555/11); couldn't curl the testnet Clio (local TLS issuer error). Review dispatched (sonnet).
Task 11: complete (commits ebc908d..63e15f7, review clean)
Task 11: minor (deferred): README:2396 'edge cache key includes it, with the switches' omits environment; README:243 E8 nft_info in present tense; release.yml:7-9 mixes secrets with the CLOUDFLARE_DEPLOY variable; README:2514 'XRPL' vs bare 'XRPL'; validations item points to a page behind VALIDATORS; sandbox nft_info curl unverified (local TLS trust) — owner to run
ALL 11 TASKS COMPLETE. Final whole-branch review dispatched (opus) on 6ed915b..63e15f7.
Final review (opus): Ready to merge — Yes; no Critical/Important; all deferred minors triaged 'leave' or already fixed. New minors: (1) README reset runbook overstates (BUILD_ID reuse brings old chain back), (2) ValidatorRowView.unlPublishers dead data, (3) guard LABELS duplicate NETWORK_NAMES, (4) 'every response carries X-Robots-Tag' overstated (static assets), (5) network shape destructured in 4 routes.
Ruling: one final fix wave for minors 1, 2, 4, 5 (cheap; 5 prevents four-place edits as E8+ add NetworkBrief fields); 3 left as a follow-up — cost if wrong: a small cleanup commit.
Final fix wave dispatched (sonnet) BASE 63e15f7 — minors 1, 2, 4, 5 of the final review.
Final fix wave DONE: 1667652, 8d9dff1, 49634e6 (verify 10001, e2e 555/11). Scoped re-review dispatched (sonnet).
Final fix wave re-review: all 4 addressed, no new Critical/Important (63e15f7..49634e6).
Final fix wave: parked — README:2490 'keys hold the build id and nothing else' (edge key also holds environment+switches) — Ruling: the runbook's instruction is right and the nuance is minor; no second fix wave per process — cost if wrong: a precision nit in docs.
E7 COMPLETE (6ed915b..49634e6). Workspace kept until program end to collect rulings.
