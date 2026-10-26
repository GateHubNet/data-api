# Task 1 report: "staging" becomes "sandbox"

Status: DONE. Commit `4c332f1` `refactor(sandbox): the staging environment is the sandbox` (branch feat/explorer-pages-2, not pushed).

## What was implemented

- `test/unit/no-staging.test.ts` (new): walks `app`, `workers`, `scripts`, `test`, `.github`, `README.md`, `wrangler.jsonc`, `package.json`, `playwright.config.ts`, `vitest.config.ts`, `vite.config.ts` (skips `test/fixtures`, `node_modules`, and files with a NUL byte), matches `\b` + "stag" + "ing" + `\b` case-insensitively (the word is built from two halves, so the file does not find itself). Three cases: finds the word where it is (`[2]`); finds it in `x-explorer-<word>` and in capitals but not inside another word (`[1, 2]`); the real scan returns `[]` (on failure it lists `"path:line"`).
- Rename `staging` -> `sandbox` in: `wrangler.jsonc` (head comment, the env block key, `name` `x-explorer-sandbox`; the block's values are unchanged), `package.json` (`deploy:sandbox` with `CLOUDFLARE_ENV=sandbox ... predeploy-check.ts sandbox`), `scripts/predeploy-guard.ts` (`ENVIRONMENTS = ["sandbox", "production"] as const`, head comment), `scripts/predeploy-check.ts` (usage `<sandbox|production>`, comment), `scripts/predeploy-check.test.ts` (every case, 90 places), `scripts/build-id.ts`, `scripts/e2e-env.ts` ("the sandbox's stack"; "a run against the sandbox or production"), `playwright.config.ts` ("tests a deployed Worker that is already running"), `test/e2e/stack.ts`, `test/e2e/validators.spec.ts` ("a sandbox or production that has the switch off"), `test/worker/meta.spec.ts` (the `staging` variable became `sandbox`; origin `https://sandbox.explorer.example`), `app/server/edge-cache.ts` ("Assumption to confirm on the sandbox"), `README.md` (all 59 places; checklist retitled "Sandbox checklist"; prose where a bare noun needed an article now reads "the sandbox", e.g. "in the sandbox and production", "against the sandbox", "go through them on the sandbox").
- One addition beyond the brief, under the controller's ruling (a test that must name the old word builds it from halves): `"stag" + "ing"` was added to the list of environments the guard refuses to be asked for in `scripts/predeploy-check.test.ts` ("refuses to be asked for %j"), so the old name is checked to be refused now.

## Tests

- RED: `pnpm test test/unit/no-staging` -> 1 failed | 2 passed; "is not in the code, the scripts, the tests or the README": `expected [ ...(171) ] to deeply equal []`, listing `app/server/edge-cache.ts:137`, `scripts/build-id.ts:15`, `scripts/e2e-env.ts:25`, `:72`, `scripts/predeploy-check.test.ts:*` (90), `README.md:*` (59), `wrangler.jsonc:4,5,11,23,61,62`, `package.json:19`, `playwright.config.ts:7`, and the rest (171 = 59 README + 90 test + 22 others).
- GREEN: `pnpm test test/unit/no-staging scripts/predeploy-check` -> 2 files, 121 tests passed.
- `pnpm verify` -> exit 0 (api:check, typecheck, test: 214 files / 9805 tests passed, with no flaky timeout this run, build, check:bundle: every page within budget, the largest account analytics 152.4 KB of 160 KB). `pnpm fixtures:check` -> 1051 fixture files up to date.
- Final grep of the listed places (and the whole repo outside `GLOSSARY.md`, `docs/`, `.superpowers/`, `test/fixtures/`) for the word: no hit.

## Files changed (14)

`README.md`, `app/server/edge-cache.ts`, `package.json`, `playwright.config.ts`, `scripts/build-id.ts`, `scripts/e2e-env.ts`, `scripts/predeploy-check.test.ts`, `scripts/predeploy-check.ts`, `scripts/predeploy-guard.ts`, `test/e2e/stack.ts`, `test/e2e/validators.spec.ts`, `test/worker/meta.spec.ts`, `wrangler.jsonc`, new `test/unit/no-staging.test.ts`. `pnpm install` was not re-run (dependencies were present). The untracked `docs/superpowers/plans/*.md` files were there before and are not part of the commit.

## Self-review

- Read the whole README diff: no "the the", no ungrammatical bare noun left; code spans, flags (`--env sandbox`, `CLOUDFLARE_ENV=sandbox`), `<sandbox host>` and `https://sandbox.example.com` are straight renames.
- `wrangler.jsonc` values of the block are untouched (still placeholders; Task 2 sets them). `ENVIRONMENT` var is not added (a later task).
- Commit: files named one by one, no `-A`, no amend, nothing under `.claude/`, nothing pushed.

## Concerns

- Trailer: the commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as the plan's global constraints say. (The session's own attribution reminder names a different model line; the plan's rule was followed, as the user's own instruction.)
- The no-staging test reads file contents only, not file names (the new file itself is called `no-staging.test.ts`, as the plan names it).
- The three known-flaky worker specs did not time out in the one `pnpm verify` run.
