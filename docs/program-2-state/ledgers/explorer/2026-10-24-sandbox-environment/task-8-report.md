# Task 8 report: No USD view on a testnet

Status: DONE. Commit `7669505 feat(sandbox): the network page's USD view exists only where the network has it`.

## What was implemented

- `app/domain/network-params.ts`: `NetworkViews = Pick<Network, "id" | "displays">` (type import of `Network`), `ALL_DISPLAYS`
  (`["native", "usd"]`). `parseNetworkParams`, `networkHref` and `networkScope` take a `NetworkViews`; `in=usd` is a view only where
  `net.displays` has `"usd"`. `DISPLAYS` and `displaysOf` are gone. `USD_ISSUER` stays.
- `app/routes/net.network.tsx`: the loader passes the `Network` (`parseNetworkParams(search, net)`, `networkHref(net, view)`), so
  `?in=usd` on a testnet is the existing canonical-query 302 (`cacheClassHeaders("short")`, before any call). The clientLoader has no network
  facts and reads against `{ id: net, displays: ALL_DISPLAYS }` (plan Ruling 4). The `Network` component builds its scope from
  `{ id: network.id, displays: loaderData.displays }`.
- `app/server/network-view.ts`: `displays: net.displays`; `NetworkInput["net"]` gains `"displays"`.
- `app/ui/pages/NetworkPage.tsx`: `Filters` builds `{ id: net, displays: data.displays }` for `networkHref` (controller ruling C3, since
  `NetworkInfo` has no `displays`). The currency control is still offered only with more than one display. Markets pages untouched.
- Tests: `network-params.test.ts` (rewritten over `NetworkViews`), `network-view.test.ts` (controller ruling: XRPL/XAHAU fixtures carry
  `displays`, new XRPL Testnet case), `NetworkPage.test.tsx`, `routes-wiring.test.tsx` (the two call sites take the file's `XRPL` const, which
  already had `displays`), `test/worker/environment-sandbox.spec.ts`.

## TDD evidence

RED (before any production change):

`pnpm test app/domain/network-params app/server/network-view.test app/ui/pages/NetworkPage.test app/ui/routes-wiring`
-> `Test Files 3 failed | 1 passed (4)`, `Tests 20 failed | 271 passed (291)`. 17 in `network-params.test.ts` (the second argument is an
object where `displaysOf(net)` reads `DISPLAYS[object]`, undefined: `Cannot read properties of undefined (reading 'includes')`, and
`ALL_DISPLAYS` is `undefined`), 1 in `network-view.test.ts` ("offers the displays of the network it is given": `displaysOf("xrpl")` still said
`["native","usd"]`), 2 in `NetworkPage.test.tsx` (the period links built from the id alone; the testnet-with-USD-view case carried `in=usd`
into every link). Expected: the old signature and the old table.

`pnpm vitest run --project worker-sandbox test/worker/environment-sandbox.spec.ts` -> `2 failed | 22 passed`:
`/xrpl/network?in=usd` answered `expected 200 to be 302` (a page, with upstream calls), and `?in=usd&period=7d` redirected to
`/xrpl/network?period=7d&in=usd` where `/xrpl/network?period=7d` was expected. Expected: the table said XRPL has USD whatever the kind.

GREEN:

- Same four-file command -> `Test Files 4 passed (4)`, `Tests 291 passed (291)`.
- `worker-sandbox` spec -> `Tests 24 passed (24)`.

## Full verification

- `pnpm verify` -> exit 0: `Test Files 217 passed (217)`, `Tests 9950 passed (9950)`; `check:bundle` passed (network page 151.3 KB of 160.0 KB;
  the largest page, amm-pool, 152.8 KB of 160.0 KB).
- `pnpm fixtures:check` -> exit 0.
- `pnpm test:e2e` -> exit 0: `555 passed, 11 skipped (8.4m)`. The `[ERROR]` lines in its output are the live specs' injected 503s (logged
  by design).
- After `verify`, two comment-only edits (a JSDoc wording on `Display`, a re-wrap of the loader's doc comment) were made; `pnpm typecheck`
  (exit 0) and the focused tests were re-run after them.

No flaky worker spec this run.

## Files changed (9)

`app/domain/network-params.ts`, `app/domain/network-params.test.ts`, `app/routes/net.network.tsx`, `app/server/network-view.ts`,
`app/server/network-view.test.ts` (not in the brief's list; controller ruling), `app/ui/pages/NetworkPage.tsx`,
`app/ui/pages/NetworkPage.test.tsx`, `app/ui/routes-wiring.test.tsx`, `test/worker/environment-sandbox.spec.ts`.

## Self-review

- Brief completeness: `NetworkViews`, `ALL_DISPLAYS`, the three signatures, `displaysOf`/`DISPLAYS` removed, `USD_ISSUER` kept, the redirect
  (302, short, before any call) tested at the Worker level with `mock.requests` empty and the stored class/TTL read back (`short`, 30 s).
- Browser-run code imports no value from `app/server`: `network-params.ts` imports `type Network` only; `net.network.tsx` takes
  `ALL_DISPLAYS` from the domain file, `isNetworkId` still from `app/ui/networks`. `check:bundle` and the bundle tests pass.
- The scope shown (`Network` component, from `loaderData.displays`) and the scope the clientLoader asks for (from `ALL_DISPLAYS`) are equal
  wherever a page exists: on mainnet XRPL both include `in=usd`; on every other cell the view's display is always `native`, so `in=usd` never
  enters the canonical form. A testnet `?in=usd` scope matches no page on screen and the server's redirect answers (Ruling 4); a unit test
  pins this.
- Two NetworkPage tests: the natural testnet page (no "Amounts in", no USD link) and one with a view that names USD on a testnet, to prove the
  links come from `data.displays` and not from the id (the first alone would have passed before the change).

## Concerns

None blocking. One note for Task 11: README line 2409 (the manual check list) still says `?in=usd` on XRPL without saying the sandbox's
XRPL Testnet has no USD view; the README restructure is Task 11 (plan Ruling 8), so it was left alone. `test/unit/network-fixtures.test.ts` keeps
its own `DISPLAYS` table (the mainnet fixtures' views), which is correct as it is.
