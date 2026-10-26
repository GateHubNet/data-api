# Explorer program 2: state of the build, for resuming it elsewhere

A snapshot of the run that builds explorer program 2 (sandbox, NFTs, display names, ledger objects and delegation, tokens, supply,
validators map, MPT) in the data API and the explorer, taken on 2026-10-26 to move the run to a cloud session. The work itself is
in two feature branches; this folder holds what lived only on the original machine: the per-plan ledgers (every ruling and deferred
finding), the implementer and reviewer instructions, the helper script and the progress notes.

## Where the work is

| Repository | Branch | Base | State |
|---|---|---|---|
| GateHubNet/data-api | `feat/explorer-data-2` (pushed) | `feat/account-investigation-data` (the owner's PR #20) | D-env done (8a0f648..5294876); D3 Task 1 at ed8edd3 |
| GateHubNet/explorer | `feat/explorer-pages-2` (pushed) | `master` | E7 done (6ed915b..49634e6) |

Specs and plans:
- Overview: explorer `docs/superpowers/specs/2026-10-24-explorer-program-2-overview.md` (sub-projects, build order, cross-cutting decisions).
- Data API specs/plans: `docs/superpowers/{specs,plans}/` on `feat/explorer-data-2` (D-env `2026-10-24-testnet-profiles`, D3 `2026-10-17-nft-data`,
  D4 `2026-10-24-display-names`, D5 `2026-10-24-ledger-objects-delegation`, D6 `2026-10-24-issued-tokens`, D7 `2026-10-24-supply`,
  D8 `2026-10-24-validator-toml-details`, D9 `2026-10-17-mpt-data`).
- Explorer specs/plans: `docs/superpowers/{specs,plans}/` on `feat/explorer-pages-2` (E7 `2026-10-24-sandbox-environment`,
  E8 `2026-10-24-nft-pages`, E9 `2026-10-24-display-names`, E10 `2026-10-24-ledger-object-pages`, E11 `2026-10-24-token-pages`,
  E12 `2026-10-24-supply-page`, E13 `2026-10-24-validators-map`, E14 `2026-10-24-mpt-page`).
- `kit/owner-decisions-all-specs.md`: every spec's "Owner decisions to confirm" table (the owner approved all recommendations).

## Where the run stopped (2026-10-26)

- Data API: D3 (NFTs) Task 1 "NFT fixtures and findings" is committed (a82875a) and its review came back "needs fixes".
  The controller ruled on the one Important finding: `offer_removed_other` stays Not found after 19,955 ledgers, and Task 4 builds
  the synthetic transaction. Fix round 1 (the minors) is committed as ed8edd3 and pushed. Its scoped re-review (a82875a..ed8edd3,
  `kit/REVIEWER.md` re-review mode, against `task-1-review.md`) has NOT run yet: run it first. When it is clean, write
  `Task 1: complete (commits a82875a..ed8edd3, review clean)` and continue with Task 2. The pre-flight rulings C1 to C11 and the
  Task 1 rulings in ledgers/data-api/2026-10-17-nft-data/progress.md apply. Carry the ledger's "Note for Tasks 3/4 dispatch" into
  those dispatches.
- Subagents can no longer write report files (the harness refuses them, FINDINGS.md included). Implementers and reviewers return
  their report as text, and the controller saves it as task-N-report.md (kit/IMPLEMENTER.md says so). The controller writes or
  corrects FINDINGS.md files itself (owner approval, 2026-10-26).
- Explorer: waiting. E8 (NFT pages) starts when D3 is complete; its Task 1 runs DATA_API_REPO=<data-api checkout> pnpm api:sync.
- Next, in order: data API D3, D4, D5, D6, D7, D8, D9; explorer E8 to E14, each En after its Dn.
- Then: a whole-branch review per plan (done for D-env and E7), and at the end PRs (one per sub-project, stacked) for the owner.

## The owner's standing decisions

- Plans are pre-approved: implement everything, in the build order above, subagent-driven in auto mode.
- Ask before any push, merge, PR merge or deploy (the owner asked for the two feature-branch pushes for this move). GateHubNet `master`
  changes only via PR. Push to GateHubNet as GitHub user `tadejgolobic`.
- Never read, print or set the npm token or `~/.npmrc`. Never stage or touch `.claude/`. Never `git clean`, `reset --hard`, `--amend` or
  a bare `git stash`. No `wrangler deploy` (except `--dry-run`) and no `wrangler secret`. Subagents never delete what they didn't create.
- Commit trailer, on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (controller ruling, even for subagents on
  other models). PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## The process (superpowers: subagent-driven-development)

Per plan: a pre-flight scan of the plan (a subagent appends a table and conflicts to the ledger; the controller rules on each), then per
task: extract the task's brief (`### Task N:` section) → dispatch an implementer with `kit/IMPLEMENTER.md` + brief + the plan's Global
Constraints → when it reports, build a review package (`git log/stat/diff -U10 BASE..HEAD` into one file) → dispatch a reviewer with
`kit/REVIEWER.md` → fix rounds (resume the implementer with Critical/Important findings verbatim, then a scoped re-review; at most 5) →
ledger lines (`Task N: complete (commits a..b, review clean)`, `Task N: minor (deferred): …`, `Ruling: … — … — cost if wrong: …`).
After the last task: a whole-branch review on the most capable model (it triages the deferred minors), one fix wave, one scoped
re-review. Reviewers and implementers never dispatch subagents. Models used: implementers and task reviewers Sonnet; final reviews and
risky reviews (e.g. syncer halting) Opus.

- `kit/sdd.sh` wraps the skill's scripts (`ws`, `brief`, `review`, `log`). Its paths are this machine's: set `S` to the
  subagent-driven-development skill's `scripts/` folder and the `dapi`/`exp` roots to the cloud checkouts (or re-create the three
  scripts: `sdd-workspace` makes `.superpowers/sdd/<plan-slug>/` with a self-ignoring `.gitignore`; `task-brief` copies one
  `### Task N:` section to `task-N-brief.md`; `review-package` writes the commit list, stat and `git diff -U10` to a file).
- Restore the ledgers before continuing: copy `ledgers/data-api/<plan>/*` to `<data-api checkout>/.superpowers/sdd/<plan>/` and
  `ledgers/explorer/<plan>/*` to `<explorer checkout>/.superpowers/sdd/<plan>/` (git-ignored there). The final reviews read every
  `Ruling:` and `minor (deferred)` line.
- `kit/PROGRESS.md`: the spec- and plan-phase notes (each drafter's and planner's report: interfaces, numbering, rulings).
- `kit/SPEC-BRIEF.md`, `kit/PLAN-BRIEF.md`, `kit/CONSISTENCY.md`: the briefs the specs and plans were written from.

## Facts about the environment that the tasks rely on

- Data API: pnpm 10, Node 22+ (24 used); `pnpm install --frozen-lockfile` needs `NPM_TOKEN` for the private `@gatehub/toolbox`;
  e2e suites (`pnpm --filter @gatehub/data-api-shared|data-api-service|data-syncer test:e2e`) need Docker (testcontainers,
  `clickhouse/clickhouse-server:26.8.14.3`); `pnpm format` rewrites three untouched files (`clickhouse.module.ts`, `util/helpers.ts`,
  `util/time.ts`) — format only the files you change; there is no working lint.
- Explorer: pnpm 10, Node 24; `pnpm verify`, `pnpm fixtures:check`, `pnpm test:e2e` (Playwright chromium, `wrangler dev`); three
  worker-project specs time out at 5 s under load — re-run a failing one alone before calling it a regression.
- Recording fixtures reads public nodes (s1/s2.ripple.com, xrplcluster.com, xahau.network, s.altnet.rippletest.net, xahau-test.net,
  clio.altnet.rippletest.net); pace requests, they throttle.

## Inputs the owner still owes (asked at the end of the program)

- XRPL Testnet amendment majority hold: 1,800 s, inferred from 7 EnableAmendment pairs (ask Ripple to confirm); Xahau Testnet: the
  software default of 5 days.
- Sandbox env file: `GH_CORS_ORIGINS` left empty; the explorer key's rate budget 6000.
- The page a visitor follows to ask GateHub to change an account name (E9).
