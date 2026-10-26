# Task 2 report: the deployed blocks, and the guard that holds them

Status: DONE_WITH_CONCERNS (two small notes below, neither blocks). Commit `ec2779c` `ci(sandbox): the sandbox and production blocks with their hosts, and a guard that knows them` (branch feat/explorer-pages-2, not pushed).

## Step 1: where the route lives in a build

Outcome A. With the `sandbox` block holding `"routes": [{ "pattern": "explorer.sandbox.gatehub.net", "custom_domain": true }]`, `CLOUDFLARE_ENV=sandbox pnpm build` writes it into `build/server/wrangler.json`:

```
$ node -e '... console.log(JSON.stringify(c.routes), c.name, c.targetEnvironment)'
[{"pattern":"explorer.sandbox.gatehub.net","custom_domain":true}] x-explorer-sandbox sandbox
```

`pnpm exec wrangler deploy --dry-run` (no deploy; `--outdir` to the scratchpad) follows `.wrangler/deploy/config.json` to that file, uploads it and lists `env.ENVIRONMENT ("sandbox")` and the other bindings, then "--dry-run: exiting now." So `checkBuild` passes nothing and `deployProblems` reads `config.routes`. The third parameter `routes` stays as the interface says (default `config.routes`) and has one test; README's guard paragraph says the plugin writes the routes into the build file.

## What was implemented

- `wrangler.jsonc`: top level gets `ENVIRONMENT: "development"`; `sandbox` and `production` get `routes`, `ENVIRONMENT`, the real data API URLs, the node URLs of the Global Constraints' table (namespaces 1000/1001/1002 were already there). The head comment says what each block is, and has lost "until the hosts are decided" and "They have no routes yet".
- `scripts/predeploy-guard.ts`: `DEPLOYED` and `KNOWN_NODES` (exported, as in the brief), `deployProblems(config, asked, routes = config.routes)`. New rules, after today's, in this order: `ENVIRONMENT` (not set / other value, through `quoted`), each data API URL (only when `urlProblem` found nothing: origin equal and path "" or "/"), each node URL on a `KNOWN_NODES` host (only when `urlProblem` found nothing: other network first, then other kind), the routes (none / each route to another pattern / the host's route without `custom_domain: true`, a bare string counts as not a custom domain). They apply only to a known environment. `checkBuild`'s summary is now `build/server/wrangler.json is the Worker <name> for <env> (<XRPL Testnet and Xahau Testnet | XRPL and Xahau>) on <host>; its upstreams are <the sandbox's | production's>, every switch is on or off, and it is not served from workers.dev`; it is empty when anything is refused (before, it was set but never printed then).
- `app/server/env.ts`: `ENVIRONMENT: "development" | "sandbox" | "production"` in `Env`. `vitest.config.ts`: `ENVIRONMENT: "development"` in `testBindings` (so the `worker` and `worker-off` projects have it; `offBindings` spreads it).
- The 12 hand-built `Env`s of the tests (found by `tsc -b`) gained `ENVIRONMENT: "development"`: `app/server/{analytics-load,capture,clients,env,network-route,networks}.test.ts`, `test/worker/{data-api,edge-cache,market-fixtures,node-rpc,route-headers,upstream}.spec.ts`.
- `.github/workflows/release.yml`: comment of step 3 (the guard passes, production's hosts and route being set, once the secrets are set; the deploy stays behind `CLOUDFLARE_DEPLOY`; only production is deployed from the workflow).
- `README.md`, "The pipeline and deploying" only, plus three stale lines that the blocks made false: CI item 3 (same wording as release.yml); the plugin paragraph (route among the flattened keys); the guard's rules (the four new ones, with the example messages, the Clio caveat, that the routes are read from the build file); the success line (both summaries); "Hosts and routes" (the table of the three blocks, the route, the custom-domain certificate note, the table is `DEPLOYED`); the stray paragraph "The data API hosts ... are placeholders ... until the hosts are decided" under Secrets removed. Also corrected: "Getting started" ("placeholders ... until the hosts are decided" -> the top level's, on purpose), the Configuration table row ("placeholders for now"), and the Tests description of `predeploy-check.test.ts`. Task 11 rewrites those sections; I only made them true at this commit.

Controller ruling C1 applied: "does not take a real host that only mentions invalid for a placeholder" now uses `XRPL_NODE_URL` (an unknown host, which the new rules leave alone) and still expects `[]`; "refuses a build for another environment" and the `checkBuild` "another environment" case assert that the reasons contain the target-environment reason and have length >= 1 (not an exact length). The exact seven reasons of a fully wired-to-the-other build are pinned by a new case.

## Tests

`scripts/predeploy-check.test.ts`: `good(env)` now builds the environment's exact values (DEPLOYED host/data APIs, the node URLs of the table, ENVIRONMENT, route); new cases: the passing configs of both environments; `DEPLOYED` and `KNOWN_NODES` pinned literally; `ENVIRONMENT` (missing, other values, quoting, cut at 80); data APIs (other environment, a path, `/v2`, a trailing `/`, other port/host/suffix, swapped network, no double report after a placeholder); nodes (other kind both ways in both environments, other network, network wins over kind, every `KNOWN_NODES` entry in the right/wrong environment and variable, host read as the URL does, unknown hosts incl. `constructor`/`__proto__`, no double report); routes (the three texts, `routes` missing/`[]`/`null`, pattern variants, an extra route beside the right one, non-list values, a zone is fine, the third parameter); the seven reasons in order of a build of the other environment; older rules first; unknown environment gets none of the new kinds; one reason per placeholder / plain-http URL of the four URLs in both environments; `checkBuild`'s summary for both environments exactly, and a wrong/missing route; the real `wrangler.jsonc` blocks pass the guard as `unstable_readConfig` reads them (name, routes, ENVIRONMENT too), one block does not pass for the other (>= 7 reasons), the top level is `development` with no route and `.invalid` data APIs.

TDD evidence:
- RED (tables and the `routes` parameter added as stubs, so that the file loads): `pnpm test scripts/predeploy-check` -> `Tests 31 failed | 134 passed (165)`. Failing as expected, the new rules passing everything: all 11 `ENVIRONMENT` cases, the data API cases (`expected [] to deeply equal [ 'XRPL_DATA_API_URL is ...' ]`), the node cases, the route cases (`expected [] to deeply equal [ "the build has no route for ..." ]`), the seven-reason case (`expected [ Array(1) ] to deeply equal [ …(7) ]`), `checkBuild > says what it checked` (old summary `... its upstream URLs are https hosts that can resolve ...`), and `does not let the block of one environment pass for the other` (`expected 1 to be greater than or equal to 7`). (Before that stub step the file did not load at all: `DEPLOYED` was undefined.)
- GREEN: `pnpm test scripts/predeploy-check test/unit/no-staging` -> `Test Files 2 passed (2) | Tests 168 passed (168)`.
- `pnpm verify` -> exit 0: api:check, typecheck, test `Test Files 214 passed (214) | Tests 9852 passed (9852)` (no flaky timeout this run), build, check:bundle "bundle check passed" (largest: account analytics 152.4 KB of 160; no page figure changed in a way that matters). `pnpm fixtures:check` -> "1051 generated fixture files are up to date".
- By hand, builds then `pnpm exec tsx scripts/predeploy-check.ts <env>`: sandbox exit 0 with `... Worker x-explorer-sandbox for sandbox (XRPL Testnet and Xahau Testnet) on explorer.sandbox.gatehub.net; its upstreams are the sandbox's, ...`; production exit 0 with `... x-explorer-production for production (XRPL and Xahau) on explorer.gatehub.net; its upstreams are production's, ...`; the production build checked as `sandbox` exit 1, printing the seven reasons. `wrangler deploy` was never run (only `--dry-run`).

## Files changed (19)

`wrangler.jsonc`, `app/server/env.ts`, `vitest.config.ts`, `scripts/predeploy-guard.ts`, `scripts/predeploy-check.test.ts`, `.github/workflows/release.yml`, `README.md`, and the 12 tests above.

## Self-review

- Completeness against the brief: every listed file; interface exact (`DEPLOYED`, `KNOWN_NODES`, `deployProblems(config, asked, routes?)`); all message texts verbatim and pinned whole in tests; Step 1 recorded.
- `pnpm exec wrangler types` was re-run (typecheck does it) so `ENVIRONMENT` is in the generated `Cloudflare.Env`; that file is gitignored.
- No `staging` word anywhere (the one test case that names the old environment builds it from halves); `test/unit/no-staging` passes over the new README text.
- Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as the plan's rules say (as in Task 1), not the session reminder's model line.

## Concerns (neither blocks)

1. A data API URL with credentials, a query or a hash on the right origin (`https://user:pass@xrpl.data.sandbox.gatehub.net`, `...?x=1`) passes, because the rule is, as written, "origin equal and path `""` or `/`". If the owner wants "exactly the environment's", add `username`, `password`, `search`, `hash` to that condition (one line and a test); I kept to the spec.
2. The guard does not check that the Worker `name` is `x-explorer-<env>` (not in spec 4's list). A sandbox build with production's name would be refused only by the person reading the summary line, which prints the name.
3. The release.yml/README phrase "the guard passes once the secrets are set" follows the brief; strictly the guard cannot see secrets (it passes once the hosts are set; the deploy needs the secrets), and the wording says both.
