# Brief: implementation plans for explorer program 2

The owner approved the sixteen specs (with every recommended decision) and chose **subagent-driven execution in auto mode**: a fresh
implementer subagent per task, a task reviewer after each, a whole-branch review at the end. You write the plan(s) a fleet of
implementers will execute task by task, each implementer seeing only its own task's text. Write them so that works.

## How to write a plan

Follow the writing-plans skill exactly: `/Users/golobitch/Library/Application Support/Claude/local-agent-mode-sessions/0ed8c108-8b2a-4845-88c5-ee89977cd684/49390995-b6a1-478f-ad4c-04cfbe476eaf/rpm/plugin_01JETPTMWTgidsotmEhVkQTG/skills/writing-plans/SKILL.md`
(read it first: the header with Goal / Architecture / Tech Stack / Spec, **Global Constraints**, **Review Focus**, then
`### Task N: <name>` sections with Files, Interfaces (Consumes / Produces), checkbox steps: failing test → run → implement → run →
commit). The execution scripts extract a task by its `### Task N:` heading, so use exactly that heading form, numbered from 1.
Models to imitate for this codebase's level of detail: DAPI `docs/superpowers/plans/2026-10-19-validators-amendments.md`, EXP
`docs/superpowers/plans/2026-10-19-validators-amendments-pages.md`.

- A step is done when an implementer can write exactly one reasonable thing from it: exact files, exact names and signatures, the
  spec's exact values, the test names with their assertions. No function bodies the signature and tests already determine; a body
  only for an algorithm they don't (e.g. a ClickHouse query whose shape matters, a parser's tricky edge case).
- Right-size tasks: each one carries its own test cycle and is worth a reviewer's gate; fold docs, config and scaffolding into the
  task whose deliverable needs them. Expect 8–16 tasks per plan; split where a reviewer could reject one part and approve another.
- Each task's Interfaces block names what it consumes from earlier tasks (and from earlier sub-projects, by file and symbol) and
  what it produces for later ones. A later task may rely only on what an earlier task (or an earlier sub-project's plan) produces.
- Every task ends with a commit step: conventional message (`feat(api): …`, `feat(syncer): …`, `feat(shared): …`, `feat(ui): …`,
  `test: …`, `docs: …`, the repo's existing style), body explaining why, and the trailer line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--amend`, never `git add -A` (name the files), never touch `.claude/`.
- The last task of every plan: docs (README / api-reference / ADRs / glossary as the spec lists) if not already folded in, the full
  verification commands, and a summary of what the owner must do to deploy (migration, reprocess, switch).

## Repositories, branches and tracks

- **Data API**: `DAPI = /Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2`, branch `feat/explorer-data-2`
  (stacked on the owner's PR #20). **Explorer**: `EXP = /Users/golobitch/github.com/GateHubNet/x-explorer-worktrees/explorer-pages-2`,
  branch `feat/explorer-pages-2`. All work is committed on these branches, never pushed by an implementer.
- Two tracks run in parallel, one per repository, each in build order:
  data API: D-env → D3 → D4 → D5 → D6 → D7 → D8 → D9; explorer: E7 → E8 → E9 → E10 → E11 → E12 → E13 → E14.
  An explorer sub-project En starts only after its data API counterpart Dn is complete, because its **first task syncs the API
  description**: `DATA_API_REPO=<DAPI> pnpm api:sync` (copies `docs/openapi.yaml`, regenerates `app/server/openapi.d.ts`), then adds
  the response types (`app/server/api-types.ts`) and shape checks for the new endpoints, then generates fixtures for them as the
  spec says. (E7 syncs nothing new from D-env unless its spec needs it.)
- Commands. Data API: `pnpm install` (once), `pnpm build`, `pnpm lint`, `pnpm test` (unit), `pnpm --filter @gatehub/data-api-shared test:e2e`,
  `pnpm --filter @gatehub/data-api-service test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e` (real ClickHouse via
  testcontainers; Docker is available), narrower with `-- <pattern>`. Explorer: `pnpm install` (once), `pnpm test`, `pnpm typecheck`,
  `pnpm verify` (api:check + typecheck + test + build + check:bundle), `pnpm fixtures:check`, `pnpm test:e2e` (Playwright, builds the
  Worker). Check the exact script names in each `package.json` and cite them.

## Numbering (assign in build order; verify at build time)

Plans name the expected numbers, and each such task's first step checks they are still the next free ones (if PR #20 or an earlier
sub-project took more, use the next free value and update every reference in that task):
- Per-network ClickHouse migrations (`packages/shared/schema/`, highest today 010): D3 → `011`, D4 → `012`, D5 → `013`,
  D6 → `014`, D7 → `015`, D8 → `016` only if its spec needs a migration (else none), D9 → the next free (`017` or `016`).
  D-env adds none unless its spec says so. Shared-database migrations (`schema-shared/`, highest 002): only if a spec adds one.
- Parser versions (`packages/shared/src/clickhouse/rows.ts`, today PARSER_VERSION 4, STATE 3, PATH 4, AMM 2): each new gate takes
  the next number and PARSER_VERSION moves to it: `NFT_PARSER_VERSION = 5` (D3), `DOMAIN_PARSER_VERSION = 6` (D4),
  `OBJECT_PARSER_VERSION = 7` (D5), `TOKEN_PARSER_VERSION = 8` (D6), `MINT_PARSER_VERSION = 9` (D7), `MPT_PARSER_VERSION = 10` (D9).
- ADRs (`docs/adr/`, highest today 0015): each new ADR takes the next free number in build order (D3 first if it writes one, then
  D4, D5, D6, D7, D9; D8 amends ADR-0012 in place).
- Explorer feature switches: as the specs name them (`NFTS`, `NAMES`, `LEDGER_OBJECTS`, `DELEGATION`, `TOKENS`, `SUPPLY`,
  `VALIDATORS_MAP`, `MPT`), each added to every block of `wrangler.jsonc` per E7's environment names (E7 renames staging → sandbox
  first; plans after E7 use `sandbox`).

## What the plans may rely on

The specs are the authority; read your spec(s) fully, plus the specs they depend on (the overview
`EXP/docs/superpowers/specs/2026-10-24-explorer-program-2-overview.md` lists them all), and the code you plan against. Where a spec
leaves a choice open, decide it in the plan (that is the plan's job) and note it in the plan's Global Constraints or the task. If you
find a real conflict between specs or between a spec and the code, rule on it in the plan (the earlier spec in build order wins;
record the ruling in a "Rulings" list at the end of the plan) — don't edit specs.

Review Focus (required by the skill): the five input classes or failure modes the spec implies that most likely bite a real user,
each with the test that pins it added to the owning task. Think: both networks and testnets, empty and huge answers, coverage
incomplete, node fallback failing, hex/odd currency codes, burned/removed objects, X-addresses, a names call failing, switches off.

## Rules

- Write only your plan file(s) (paths in your task). Read anything. No code edits, no commits, no installs, builds, tests or
  servers, no git commands that change state, no subagents.
- Report (final message, under 250 words): status, the paths, task count and line count per plan, the rulings you made, and any
  cross-plan interface the next plan must honour (exact file + symbol).
