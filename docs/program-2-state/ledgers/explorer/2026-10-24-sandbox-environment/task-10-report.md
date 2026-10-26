# Task 10: Robots, the cache generation and Sentry - report

Status: DONE

Commit: `ebc908d feat(sandbox): the sandbox is noindex, its environment is in the cache generation and in Sentry`
(on `feat/explorer-pages-2`, not pushed; message as in the brief, last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

## What I implemented

- `app/server/environment.ts` (new): `withEnvironmentHeaders(response, env: Pick<Env, "ENVIRONMENT">)`. In the sandbox (`environmentOf(env.ENVIRONMENT) === "sandbox"`)
  it sets `X-Robots-Tag: noindex` and returns the same object when its headers can be changed, else a copy (`new Response(body, response)`) with
  the header. Elsewhere it returns `response` untouched. It reuses `withHeader` of `logging.ts` (see "Self-review": I exported it instead of
  writing the same try/catch a second time).
- `workers/app.ts`: `withRequestLog(request, async () => withEnvironmentHeaders(await withEdgeCache(...), env))`, so the wrapper is outside the
  edge cache (a stored copy gets the header on the way out; nothing stored differs between environments) and inside the request log (the
  `X-Request-Id` goes on top). Comment updated.
- `app/server/env.ts`: `cacheGeneration(env)` is `${BUILD_ID}:${environmentOf(ENVIRONMENT)}:${sorted switches}` (ruling 14: the normalised
  environment, so a value that is none of the three keys as development). Doc comment rewritten (the three parts, why the environment is in
  it, that the subrequest cache keeps `BUILD_ID` alone and why).
- `app/server/logging.ts`: `withSentry`'s options gain `environment: e.ENVIRONMENT`; `withHeader` is exported; the doc comment of
  `withSentryWhenConfigured` says what an event carries.
- `robots.txt` is untouched (the same in every environment).

## Tests (the ones the brief names, plus the generation assertions the controller ruling C7 asked for)

- `app/server/environment.test.ts` (unit, new): adds noindex in the sandbox to the same response (status, headers kept); sets it over a value the
  response already had; copies an immutable response (`Response.redirect("https://x/", 302)`, asserted immutable first) keeping status and
  headers and leaving the original alone; copies an immutable response with a body, status text and headers (headers whose `set` throws);
  changes nothing in development and production (same object, no header, also for a redirect); keeps the `noindex` a response has of its own
  outside the sandbox; reads a value that is no environment as development.
- `app/server/env.test.ts`: the exact strings gain `:development`; the regexes too; "names each switch once" no longer slices at the first colon
  (it splits the three parts); new "names the environment in the generation" (the brief's `test-build:sandbox:...` string, plus production),
  "is another generation in each environment" (3 distinct), "keys an environment that is none of the three as development" (ruling 14).
- `test/worker/features-off.spec.ts`: the exact string and the regex gain `:development`; new "names the environment in the generation".
- `test/worker/edge-cache.spec.ts`: the regex at ~280 gains `development:`; the key test asserts the environment part (`test-build:development:`,
  `test-build:sandbox:`) and that sandbox and development keys differ; the page-level "another switch value ... misses" test now also proves a
  sandbox Worker misses where a development one stored (and the development copy is still a HIT after); new "keys the same call under the
  sandbox's and production's data APIs apart" (two data API clients over `recordingCache()`, `https://xrpl.data.sandbox.gatehub.net` and
  `https://xrpl.data.gatehub.net`, `lastValidated()`: the keys are `GET https://xrpl.data.sandbox.gatehub.net/v2/last_validated` and
  `GET https://xrpl.data.gatehub.net/v2/last_validated`).
- `test/worker/entry.spec.ts`: the Sentry options `toMatchObject({ dsn, release: env.BUILD_ID, environment: env.ENVIRONMENT })`, and a sandbox env
  gives `environment: "sandbox"`.
- `test/worker/environment-sandbox.spec.ts` (`worker-sandbox`): `it.each` over `/xrpl`, the ledger `.data` URL, `/robots.txt`, the PNG of
  `/og/xrpl/tx/{PAYMENT}.png`, `/xrpl/nothing-here` (404), `/xrpl/network?in=usd` (302) each carry `X-Robots-Tag: noindex`; `robots.txt` has the
  same three Disallow lines as in development; "a page served from the edge cache carries it too" (first GET of `/xrpl/ledger/107720688` is
  noindex, the stored copy has no `X-Robots-Tag` (nothing stored differs), the second GET is `X-Cache: HIT` and noindex).
- `test/worker/layout.spec.ts` (development): "has no X-Robots-Tag on a page" over `/xrpl`, `/xahau`, `/doge` (404), `/robots.txt`, `/` (redirect).

## TDD evidence

RED (before any production code), `pnpm test app/server/environment app/server/env`:
- `app/server/environment.test.ts`: `Error: Cannot find module './environment' imported from .../environment.test.ts` (the module did not exist).
- `app/server/env.test.ts`: 7 failed, e.g. `expected 'test-build:ACCOUNT_ANALYTICS=on,AMM_D…' to be 'test-build:development:ACCOUNT_ANALYT…'`
  and `expected 1 to be 3` (the generation did not name the environment). `Tests 7 failed | 9 passed (16)`.
- `pnpm vitest run --project worker-sandbox test/worker/environment-sandbox.spec.ts -t "X-Robots-Tag"`: 6 failed (`/xrpl`, the `.data` URL,
  `/robots.txt`, the 404, the redirect, the edge-cache copy), 2 passed (the image, which carries its own `noindex` in every environment, and the
  robots.txt content check). Expected: nothing added the header.
- `pnpm vitest run --project worker test/worker/entry.spec.ts test/worker/edge-cache.spec.ts test/worker/layout.spec.ts`: 3 failed (the
  Sentry options without `environment`; the two edge-cache generation tests). `features-off.spec.ts` (`--project worker-off`): 2 failed.
  The sandbox/production subrequest-key test and the layout "no X-Robots-Tag" test pass before and after: they pin behaviour that already
  holds (the brief's "pins it").

GREEN:
- `pnpm test app/server/environment app/server/env` -> `Test Files 2 passed (2) / Tests 24 passed (24)`.
- `pnpm vitest run --project worker-sandbox` -> `Tests 32 passed (32)`; `--project worker` on entry, edge-cache, layout -> `Tests 180 passed (180)`;
  `--project worker-off test/worker/features-off.spec.ts` -> `Tests 7 passed (7)`.
- `pnpm verify` -> exit 0 (api:check, typecheck, `Test Files 218 passed (218)`, `Tests 9999 passed (9999)`, build, `bundle check passed`; every page
  within its budget, the largest `amm-pool` 152.8 KB of 160, `network` 151.3 of 160).
- `pnpm fixtures:check` -> `1051 generated fixture files are up to date`.
- `pnpm test:e2e` -> `555 passed, 11 skipped (8.3m)`, exit 0 (the `[ERROR]` lines in its log are the deliberate 503 fixtures of the failed-card specs).
- After `verify` I re-ordered one import in `edge-cache.spec.ts` (alphabetical); re-ran that file alone: 137 passed.

## Files changed

Created: `app/server/environment.ts`, `app/server/environment.test.ts`.
Modified: `workers/app.ts`, `app/server/env.ts`, `app/server/env.test.ts`, `app/server/logging.ts`, `test/worker/features-off.spec.ts`,
`test/worker/edge-cache.spec.ts`, `test/worker/entry.spec.ts`, `test/worker/environment-sandbox.spec.ts`, `test/worker/layout.spec.ts`.

## Self-review

- Completeness against the brief: wrapper, entry order, `cacheGeneration`, its doc comment, Sentry's `environment`, every named test. The controller
  ruling (all regex/slice assertions on the generation, not only the exact strings) is covered: `env.test.ts` regex and the `indexOf(":")` slice,
  `features-off.spec.ts` regex, `edge-cache.spec.ts:~280`. A repo-wide grep for `cacheGeneration|__build|test-build:` finds no other
  text assertion outside README.md and docs/.
- One decision beyond the brief's file list in spirit: `withHeader` in `logging.ts` already did exactly the "same object, else copy" job for
  `X-Request-Id`; I exported it and `environment.ts` imports it instead of a second copy of the try/catch. `logging.ts` was in the brief's file
  list anyway. If the reviewer prefers `environment.ts` to be self-contained, it is a six-line change.
- Where the copy path is exercised: the unit test (Node's `Response.redirect`, and a response whose `set` throws) and `entry.spec.ts`'s existing
  workerd case for `withHeader`. In the Worker the pages that reach the wrapper (fresh, HIT, STALE, 429) are built as new `Response`s, so the
  sandbox spec proves the end-to-end header; the immutable branch is a guard for a response that arrives with read-only headers.
- Nothing stored differs: the sandbox spec asserts the stored copy of the ledger page has no `X-Robots-Tag`.
- Pristine output: no new warnings in the focused runs; verify output as before.

## Concerns

- None blocking. README.md (lines ~140, ~166-167) still describes the generation as `BUILD_ID:switches` and cites `test-build:AMM_DATA=off,...`;
  that is Task 11's restructure (the brief for this task does not list README), so I left it. Task 11 should say the generation is
  `BUILD_ID:environment:switches`.
