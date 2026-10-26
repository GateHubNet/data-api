# Task 11 report: the README, the bundle figures, the verification and the rollout

Status: DONE (one concern, below). Commit `63e15f7` docs(sandbox): the sandbox in the README, its checklist, the production checks and the bundle figures (BASE `ebc908d`).
Files: `README.md`, `.github/workflows/release.yml` (the controller ruling names the second; the brief names only the first).

## 1. What was implemented

### Step 1: the measurement (before anything was written)
`pnpm build && pnpm check:bundle` at `ebc908d` (clean tree), and again at `6ed915b` (BASE of the plan: `git archive` into the scratchpad with the worktree's `node_modules` linked, built and
checked there, then removed) so that the table has a clean "before". The README's last full table is E5's; `6ed915b` is 10 to 48 bytes above it, so both are named.

| page | before `6ed915b` (files) | after `ebc908d` (files) | change |
|---|---:|---:|---:|
| home | 134,840 (15) | 135,022 (14) | +182 |
| ledger | 134,700 (19) | 134,920 (18) | +220 |
| transaction | 137,001 (20) | 137,221 (19) | +220 |
| account | 140,184 (24) | 140,388 (23) | +204 |
| network | 150,736 (26) | 151,316 (26) | +580 |
| markets | 133,954 (13) | 134,506 (13) | +552 |
| market-pair | 149,594 (27) | 150,136 (27) | +542 |
| validators | 149,078 (26) | 149,282 (25) | +204 |
| validator | 149,195 (26) | 149,687 (26) | +492 |
| amendments | 139,433 (19) | 139,627 (18) | +194 |
| amendment | 147,761 (23) | 148,248 (23) | +487 |
| amm | 143,839 (22) | 144,419 (22) | +580 |
| amm-pool | 152,250 (35) | 152,791 (35) | +541 |
| account analytics | 152,354 (25) | 152,559 (24) | +205 |
| manifest (check's `gzipSync`) | 1,885 | 1,869 | -16 |
| manifest (`gzip -9 -c ... \| wc -c`) | 1,914 | 1,897 | -17 |

Largest growth 580 bytes: under the kilobyte of spec 13. Why (measured per file, not guessed): the `shell` chunk +522 (124,376 to 124,898) because the header now draws the
badge's `Pill`, which was a 321-byte chunk of its own that nine pages loaded (they lost a file: +182 to +220), and the five pages that did not load it (network, markets, pair, the two AMM pages)
take the shell's growth without a chunk to give back (+541 to +580); validator and amendment also load a new 280-byte `publishers` chunk (+492, +487); root +16, `/:net` layout +30; the CSS is
not counted by the check (it counts JavaScript). The client files do not contain the build id (grep of `build/client` for the commit), so the figures hold at the README's commit.

### Step 2: the README (all of §14, plus the ruling's carry-overs)
- Getting started: "Developing against the sandbox" (`.dev.vars` with the four URLs, `ENVIRONMENT=sandbox` and the key placeholder; the switches stay the top level's; the tests never read `.dev.vars`).
- Scripts: `pnpm test` row names `worker-off` and `worker-sandbox`; `test:e2e` row says development; the deploy row lists the new guard rules and that the sandbox is deployed by hand.
- Configuration: `ENVIRONMENT` row; per-environment URL rows (the Global Constraints' table) with the XRPL node-must-be-a-Clio note (ruling: the node rows); `DATA_API_KEY` per Worker.
- Switches: the conditions say "the environment's data API" and give the sandbox variants (`AMM_DATA`, `VALIDATORS`, `AMM_PAGES`); the sandbox's rule for a condition that asks for complete coverage (D15, §9);
  the cache generation is `BUILD_ID:environment:switches` with the example `3f2a9c1:sandbox:...` (ruling: ~140, ~166), and the paragraph on the tests that spell it out (three files now).
- The data API and the node: `networks.ts` row (facts by kind), a new `environment.ts` row, a new "The environment and the networks" paragraph with the facts-and-names table by kind, CTIDs, no USD view, Xahau Testnet's
  fixed list; "The XRPL node must be a Clio" (§10).
- Facts that other sections stated for the mainnets only: the transaction page's and the search page's CTID rows, the network page's `in` row (no USD on a testnet).
- SEO and link previews: the names in the tags, the pill (`label`), the sandbox's `X-Robots-Tag: noindex` on every response (`withEnvironmentHeaders`, outside the edge cache; `robots.txt` the same everywhere).
- Tests: the `worker-sandbox` project and `*-sandbox.spec.ts` (ruling), the rename test (named without the old word: the README is scanned), `app/ui/environment.test.ts` and `networks.test.ts`; "the three share one Vite server".
- End-to-end tests: `E2E_BASE_URL`, `E2E_DATA_API_URL`, `E2E_FEATURES_OFF` are for production; a paragraph says why the suite is not run against the sandbox and that its a11y scans do not see the badge (`tokens.test.ts` pins its contrast).
- The pipeline: the release step now says the guard passes because the hosts and the route are set (it cannot see secrets) and the deploy needs the secrets and `CLOUDFLARE_DEPLOY` (README and `.github/workflows/release.yml`, ruling);
  Secrets per environment; new "The sandbox" paragraph and "A testnet reset" runbook (`BUILD_ID=$(git rev-parse --short=12 HEAD)-reset<n> pnpm deploy:sandbox`); the rollout rewritten to §15 (the old one ran the end-to-end suite against the sandbox).
- Checklists: "Sandbox checklist" replaced by the **sandbox checklist**, the **production checks** and the **build figures**, each item of today kept with its text, sent where §14's table sends it ("both" items are in both lists, with that
  environment's stack); the new items: the sandbox's certificate, the badge/names/CTID on each kind of page, `curl -sI .../xrpl | grep -i x-robots-tag`, `nft_info` on the sandbox's and on production's XRPL node (`objectNotFound`, not
  `unknownCmd`), Sentry's `environment: sandbox`; the production checks' intro says how and when they run (§14's last paragraph). The `?in=usd` check is out of the sandbox's network-page item (ruling) and stays in production's.
- The E7 figures table and its reading, after E5's, beside "The client bundle check".

### Step 5: the rollout (the owner does it; nothing of it was done here)
1. D-env first: the sandbox's data APIs answer on `xrpl.data.sandbox.gatehub.net` and `xahau.data.sandbox.gatehub.net`, with the sandbox explorer's key in their `GH_API_KEYS` and `GH_RATE_LIMIT_KEYS`.
2. `pnpm exec wrangler secret put DATA_API_KEY --env sandbox` (and `SENTRY_DSN`, optional), `pnpm deploy:sandbox` (the guard passes: the hosts and the route are set), then the sandbox checklist.
3. The switches on in the sandbox one by one, by their conditions (§9), each a commit and `pnpm deploy:sandbox`.
4. Production once its data APIs answer on `xrpl.data.gatehub.net` and `xahau.data.gatehub.net`: `pnpm exec wrangler secret put DATA_API_KEY --env production`, `pnpm deploy:production` with every switch off, the production checks;
   the release workflow's deploy only once the repository variable `CLOUDFLARE_DEPLOY` is `true`.
5. If a Worker named `x-explorer-staging` exists in the Cloudflare account, remove it in the dashboard (§2); nothing in the repository refers to it (this sentence is in the report, not the README, because the rename test scans the README).
6. After a testnet reset: `BUILD_ID=$(git rev-parse --short=12 HEAD)-reset<n> pnpm deploy:sandbox` once the data API serves the new chain (§11).

## 2. Verification (all at the final tree; the commit changes only the README and release.yml)
- `pnpm verify`: exit 0. api:check ok; typecheck ok; `pnpm test`: **218 files, 9999 tests passed** (unit, components, worker, worker-off, worker-sandbox; no timeouts this run); build ok; `check:bundle` passed with the figures above, identical to the first measurement.
- `pnpm fixtures:check`: "1051 generated fixture files are up to date", unchanged.
- `pnpm test:e2e`: **555 passed, 11 skipped** (8.3 min), exit 0.
- `test/unit/no-staging.test.ts` (3 tests) passes over the rewritten README; also inside `pnpm verify`.
- TDD does not apply (documentation); the checks that apply are the ones above. Commands in the README were checked where they could be: `nft_info` on `https://s1.ripple.com:51234/` with a made-up id answers
  `"error":"objectNotFound"` and "This is a clio server" (the same command is in the production check).

## 3. Self-review
- Completeness against the brief: every section it names is done; every item of today's checklist is in exactly one list or, for the "both" items, in the sandbox and production lists (the 38 `- [ ]` items of `ebc908d` all have their title in the new lists, four of them retitled "production"; there are 50 now: 5 new sandbox items, 1 new production item, and 6 items that belong to both, in both lists);
  the ruling's five carry-overs are done (generation format at two places and the paragraph on the tests that spell it out, node rows, `?in=usd` check, `worker-sandbox` in the test description, "the guard passes once the secrets are set" in README and release.yml).
- The word the rename test forbids is nowhere in the README (the test file is named by description; the `x-explorer-...` Worker name is only in this report).
- Facts checked against the code: the `NETWORKS`/`NETWORK_NAMES` table, `cacheGeneration`, `withEnvironmentHeaders` placement in `workers/app.ts`, Sentry's `environment`, `vitest.config.ts`'s `sandboxBindings`, the sandbox spec's cases, the titles'
  suffix (`suffixOf`), the search sentence (`search-view.ts`), `publishers.ts`'s words, `resolveBuildId` taking `BUILD_ID`.
- Items adapted rather than copied (a judgement, flagged): in the sandbox list, the network-page item drops `?in=usd` and the e2e-suite sentence (production's list keeps them), the validations item says "the testnet's validator list" instead of the
  fixtures' 35 and 25, the validators item names the fixed list, the 503-against-no-D1 item runs a local Worker (as §14 says), the markets items say "once `MARKETS` is on in the sandbox", and the sandbox's `actNotFound` item names the Clio.

## 4. Concerns
- **Could not run the sandbox's `nft_info` command from this machine.** `curl` to `https://clio.altnet.rippletest.net:51234/` fails here with "SSL certificate problem: unable to get local issuer certificate" (and an earlier plain try returned nothing,
  consistent with spec §10's "the Clio drops connections after a few quick requests"). I did not use `-k`. The production command was verified; the sandbox's is the same command on the other host. If the owner's curl has the same trust problem,
  the checklist item needs a CA or a check from another machine; whether the Worker's own `fetch` trusts that certificate is the sandbox checklist's first real question (spec §10 says it answered on 2026-10-24).
- Scratchpad hygiene: this task wrote `build.log`, `bundle.log`, `verify.log`, `e2e.log`, `files.ts`, `pill.ts`, `edit_readme.py`, `e7-figures.md`, `a-*.txt`, `b-*.txt` and `base-*.log/out` in the shared scratchpad; the first four names may have overwritten older logs of the same name there.
- Nothing else open. The README is long and hand-wrapped as before; I did not reflow anything I did not change.
