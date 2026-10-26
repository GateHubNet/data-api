# Task 3 report: The environment, in the Worker and the browser

Status: DONE. Commit `f436f89` feat(sandbox): ENVIRONMENT decides the kind of network, and reaches the browser through the root.

## What I implemented

- `app/ui/environment.ts` (no imports): `Environment`, `NetworkKind`, `environmentOf(value: unknown)` (only the exact strings "sandbox" and "production" are taken; anything else is "development"), `networkKindOf(environment)` ("testnet" for the sandbox, "mainnet" otherwise).
- `app/root.tsx`: `RootLoaderData`, `loader({ context })` returning `{ environment: environmentOf(getEnv(context).ENVIRONMENT) }` (names no cache class), `export const shouldRevalidate = () => false`.
- `app/ui/use-network.ts`: `ROOT_ROUTE_ID = "root"` and `useEnvironment()`, which mirrors `useFeatures`: a `try` around `useRouteLoaderData(ROOT_ROUTE_ID)?.environment` through `environmentOf`, "development" where the data or the router is missing, never throws.
- `test/support/under-network.tsx`: `UnderNetworkOptions.environment?: Environment`. When given, the `/:net` layout is wrapped in a pathless root route (`id: ROOT_ROUTE_ID`, `loader: () => ({ environment })`). When absent the route tree is exactly as before, so no existing component test changes behaviour.

## Tests

- `app/ui/environment.test.ts`: the three values; anything else (undefined, "", the built "stag"+"ing", "Sandbox", 1) is development; the kinds per environment.
- `app/ui/use-network.test.tsx` (`useEnvironment`): `ROOT_ROUTE_ID` is "root"; gives the root's environment ("sandbox"); a malformed root value ("Sandbox") gives development; development without root data, with empty root data, without a router, never throws (a route ErrorBoundary is never reached); and the test helper's `environment` option (production given, development absent). The last one is one test beyond the brief, to cover the new helper option.
- `test/worker/layout.spec.ts`: "hands the browser the environment in the root's data": `GET /xrpl.data?_routes=root` answers 200 and the body contains `"environment"` and `"development"`.

## TDD evidence

RED: `pnpm test app/ui/environment app/ui/use-network`
```
FAIL |components| app/ui/environment.test.ts
Error: Failed to resolve import "./environment" from "app/ui/environment.test.ts". Does the file exist?
FAIL |components| app/ui/use-network.test.tsx > useEnvironment > is the id the root has in the route tree
AssertionError: expected undefined to be 'root'
... TypeError: useEnvironment is not a function (4 tests failed)
```
Expected: the module and the hook did not exist yet.

GREEN: `pnpm test app/ui/environment app/ui/use-network test/worker/layout`
```
Test Files  3 passed (3)
     Tests  36 passed (36)
```

Full: `pnpm test` passed, 215 files, 9861 tests. `pnpm verify` exit 0 (api:check, typecheck, test, build, check:bundle: every page within budget, the largest 152.4 KB for account analytics against 160 KB; the pages that were close before are unchanged within the root data's few bytes). `pnpm fixtures:check`: "1051 generated fixture files are up to date".

Note on a first full run: the first `pnpm verify` failed 16 worker specs across 14 files, every one "Test timed out in 5000ms" (load average 8 to 14 on the machine). Re-running `pnpm test` gave 215/215 files passing, and the next `pnpm verify` exited 0. I did not run the e2e suite (Task 3 does not require it; Tasks 4 to 10 do).

## Files changed

`app/ui/environment.ts` (new), `app/ui/environment.test.ts` (new), `app/root.tsx`, `app/ui/use-network.ts`, `app/ui/use-network.test.tsx`, `test/support/under-network.tsx`, `test/worker/layout.spec.ts`.

## Self-review

- Completeness against the brief: all named interfaces exist with the given names and signatures; the commit message is the brief's, with the trailer the global constraints name (Opus 5.5).
- `app/ui/environment.ts` imports nothing; the browser side imports nothing of `app/server` as values (`root.tsx` imports `getEnv` for the loader, as `net.tsx` imports `network-route`; the loader is a server-only export, and the `test/unit/*-bundle` tests and `check:bundle` pass).
- No "staging" in the added files (the test builds it from halves).
- `useEnvironment` goes through `environmentOf`, so a root value that is not one of the three is development, not a cast.

## Concerns

None blocking. The root `shouldRevalidate = () => false` also means a client-side navigation never re-reads the environment; that is the intent (spec §6).
