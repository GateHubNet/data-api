# Task 5 report: the names where there is no layout data

Status: DONE (see "Concerns" for two small notes). Commit `11dbcf9`.

## What was implemented

- `app/ui/networks.ts` (§5's API, type imports only):
  - `NetworkBrief = { id; kind; name; label; longName; dexName }` and `NetworkInfo = NetworkBrief & Pick<PublicNetwork, "native" | "software">`.
  - `networkChoices(kind): readonly NetworkBrief[]` (xrpl, xahau; built once from `NETWORK_NAMES`), `findNetwork(segment, kind)`, `DEFAULT_NETWORK_ID: NetworkId = "xrpl"`. `NETWORK_CHOICES` and `DEFAULT_NETWORK` are gone.
  - `findNetwork` has two overload signatures over the one body: a `NetworkId` gives a `NetworkBrief` (it always names one), any other `string | undefined` gives `NetworkBrief | undefined`. That is only a type: it lets the three places that draw "the default network" (`root.tsx`'s and `net.tsx`'s `ErrorBoundary`, `not-found.tsx`) write `findNetwork(DEFAULT_NETWORK_ID, kind)` / `findNetwork(loaderData.net, kind)` with no `!` or fallback. Behaviour is the plan's.
- `app/ui/components/NetworkSwitch.tsx`: lists `networkChoices(networkKindOf(useEnvironment()))`.
- `app/root.tsx`: `meta` describes `Look up any ledger, transaction or account on ${a.longName} and ${b.longName}.` over `networkChoices(networkKindOf(loaderData?.environment ?? "development"))`; `ErrorBoundary` draws `findNetwork(DEFAULT_NETWORK_ID, networkKindOf(useEnvironment()))`.
- `app/routes/net.tsx`: `meta` tells an unknown network by `isNetworkId(params.net ?? "")`; `ErrorBoundary` draws `findNetwork(params.net, kind)` or the default network of that kind (`unknownNetwork` and the cookie as before).
- `app/routes/not-found.tsx`: the loader keeps `net: isNetworkId(first) ? first : DEFAULT_NETWORK_ID`; the component draws `findNetwork(loaderData.net, networkKindOf(useEnvironment()))`.
- `app/server/meta.ts`: `metaContext(net, matches)` returns the `/:net` layout's `network` (with the layout's `origin`) when its id is `net`, else `undefined` (also `undefined` for an absent segment, a missing layout, a non-string origin). The `findNetwork` import is gone from the file.
- `app/routes/net.search.tsx`: `meta` names `metaContext(params.net, matches)?.network`.
- The five clientLoaders (`net.network.tsx`, `net.validators.tsx`, `net.validators.$key.tsx`, `net.amendments.tsx`, `net.amendments.$name.tsx`): `const net = params.net ?? ""; if (!isNetworkId(net)) return serverLoader();` and `net` is the id (Ruling 4). `isNetworkId` is a value import from `app/server/networks.ts` (pure; imports only `app/ui` modules).
- Source code that built a `NetworkInfo` by picking `{ id, name, native, software }` out of a `Network` now picks `{ id, kind, name, label, longName, dexName, native, software }` (required fields of the type): the loaders of `net.validators.tsx`, `net.amendments.tsx`, `net.amendments.$name.tsx` and `publicOf` in `net.validators.$key.tsx`. All four files are in the plan's list.

## Controller rulings

- (C2) `NetworkBrief`/`NetworkInfo` gained required fields; every hand-built literal of them in the tests is updated (the mainnet values of `kind`, `label`, `longName`, `dexName`). Files, by the literal they hold:
  - `NetworkInfo` (`{ id, name, native, software }` to the full shape): `app/server/amendment-view.test.ts`, `app/server/amendments-view.test.ts`, `app/server/validator-view.test.ts`, `app/server/validators-view.test.ts`, `app/server/meta.test.ts` (six literals), `app/ui/pages/AccountAnalytics.test.tsx`, `AccountPage.test.tsx`, `AmendmentPage.test.tsx`, `AmendmentsPage.test.tsx`, `AnalyticsFilters.test.tsx`, `HomePage.test.tsx`, `LedgerPage.test.tsx`, `MarketPairPage.test.tsx`, `MarketsPage.test.tsx`, `NetworkPage.test.tsx`, `TransactionPage.test.tsx`, `ValidatorPage.test.tsx`, `ValidatorsPage.test.tsx`, `app/ui/routes-wiring.test.tsx` (the `XRPL`/`XAHAU` constants were Task 4's; the five inline `network:` literals are new here).
  - `NetworkBrief` (`{ id, name }` to the full shape): `app/server/card-data.test.ts` (`XRPL`, `XAHAU`), `app/ui/pages/SearchPage.test.tsx` (`XRPL`, `XAHAU`), and `MetaContext` in `app/server/meta.test.ts`.
  - Left alone on purpose, because their types are their own and `tsc` accepts them: the `{ id, name }` literals typed `NetworkName` (`search-view.test.ts`, `transaction-view.test.ts`, `AccountPage.test.tsx`'s `NeverActivatedData.other`) and the `Input["network"]`/`AmmPoolInput["net"]` literals of `markets-view`, `pair-view`, `amm-view` and `AmmPoolPage` tests.
- The "never activated" case of `test/worker/environment-sandbox.spec.ts` (`/xahau/account`) no longer ends with a page-wide `toContain("XRPL Testnet")`. It asserts the suggestion's own label through `anchors()`/`offer()`: `offer(html, \`Look for ${shortAddress(address)} on XRPL Testnet\`)` is `/xrpl/account/${address}` (this replaced the bare `hrefs()` check too). `shortAddress` is imported from `app/domain/format`.

## Tests

New or changed (all asserted against the brief's values):
- `app/ui/networks.test.ts` (new, `components` project): the names table (every cell), `networkChoices("testnet")` = `[["xrpl","testnet","XRPL Testnet"],["xahau","testnet","Xahau Testnet"]]` and the mainnet pair, the full shape of one choice per kind, `findNetwork` by kind and nothing else (`"xrp"`, `undefined`, `"XRPL"` give `undefined`), `DEFAULT_NETWORK_ID`.
- `app/ui/components/components.test.tsx`: `NetworkSwitch` names the networks of the environment (`it.each`: sandbox gives `XRPL Testnet`/`Xahau Testnet`; production, development and no root give `XRPL`/`Xahau`; the hrefs stay `/xrpl`, `/xahau`), through `renderUnderNetwork(…, { environment })`.
- `app/server/meta.test.ts`: `metaContext` is the layout's network with its origin; takes a testnet layout (`name` `XRPL Testnet`, `suffixOf` `XRPL Testnet · explorer`, `transactionMeta` title `… · XRPL Testnet · explorer` and description ending ` · XRPL Testnet ledger 102,186,243`); is `undefined` without a layout/network/origin, for a layout of another id (both ways), and for an absent segment.
- `app/ui/routes-wiring.test.tsx`, new `describe("root.tsx")` (Ruling 12): `meta` with `loaderData` `{ environment: "sandbox" }` gives `… on XRPL Testnet and Xahau Testnet.`, with production, development or none `… on the XRP Ledger and Xahau.`; `ErrorBoundary` under root data `"sandbox"` has the switch `XRPL Testnet`/`Xahau Testnet` and the link `Go to the XRPL Testnet home`; under production, development and no data it has `XRPL`/`Xahau` and `Go to the XRPL home`.
- `test/worker/environment-sandbox.spec.ts`, new `describe("the names where there is no layout data")`: `/xrpl` switch reads `XRPL Testnet`, `Xahau Testnet` (with hrefs `/xrpl`, `/xahau`); `/xrpl/tx/PAYMENT` title is `Payment AACAFC…FD40 · XRPL Testnet · explorer` and the description ends ` · XRPL Testnet ledger 102,186,243` (Ruling 9); `/xrp` (404) has the testnets in its switch and `Go to the XRPL Testnet home`. One more than the brief: `/xahau/nothing` (the not-found route, which the brief's list changes but no case reached) keeps Xahau Testnet (`Go to the Xahau Testnet home`) and has the testnets in its switch.

### TDD evidence

RED, before any implementation (tests first):
- `pnpm test app/ui/networks app/server/meta` → `Tests 7 failed`: `networkChoices is not a function` (two cases), `findNetwork(...)?.longName` `expected undefined to be 'Xahau Testnet'`, `DEFAULT_NETWORK_ID` `expected undefined to be 'xrpl'`, `metaContext > takes the layout's network, with its testnet names` `expected 'XRPL' to be 'XRPL Testnet'`, `is nothing when the layout is of another network` `expected { network: { id: 'xahau', name: 'Xahau' }, origin: … } to be undefined`, and the layout-network case. Expected: the module has no `networkChoices`/`DEFAULT_NETWORK_ID`, and `metaContext` builds the network from the static table.
- `pnpm exec vitest run --project components app/ui/components/components.test.tsx app/ui/routes-wiring.test.tsx -t "NetworkSwitch|root.tsx"` → `3 failed | 5 passed`: `names the networks of the environment: sandbox` and `draws its error page with the environment's switch` (`expected [ 'XRPL', 'Xahau' ] to deeply equal [ 'XRPL Testnet', 'Xahau Testnet' ]`), `describes the environment's networks` (description names the XRP Ledger). Expected: the switch and the root were static.
- `pnpm exec vitest run --project worker-sandbox` → `4 failed | 14 passed`: the three brief cases plus the not-found case (`expected [ [ '/xrpl', 'XRPL' ], …(1) ] to deeply equal [ [ '/xrpl', 'XRPL Testnet' ], …(1) ]`; `expected 'Payment AACAFC…FD40 · XRPL · explorer' to be 'Payment AACAFC…FD40 · XRPL Testnet · …'`). The tightened "never activated" case was green already: Task 4 made the label read the other network's name, and the page-wide `toContain` could not have told.

GREEN:
- `pnpm test app/ui app/server/meta` → `Test Files 64 passed (64), Tests 2107 passed (2107)`.
- `pnpm exec vitest run --project worker-sandbox` → `Test Files 1 passed, Tests 18 passed (18)`.
- `pnpm verify` → exit 0: api:check; typecheck clean (no errors after the literals were updated); test `Test Files 217 passed (217), Tests 9902 passed (9902)` (no worker spec timed out); build; check:bundle `bundle check passed` (home 135.5, ledger 135.4, transaction 137.7, account 140.9, markets 134.7, amendments 140.1, amendment 148.5, amm 144.5 KB of 150/160 KB; network 151.4, market-pair 150.3, validators 149.8, validator 149.9, amm-pool 152.9, account analytics 153.0 KB of 160 KB).
- `pnpm fixtures:check` → `1051 generated fixture files are up to date`.
- `pnpm test:e2e` → exit 0, `555 passed, 11 skipped` (8.3 min), the same counts as Task 4: the development pages keep their names.

## Files changed

Source: `app/ui/networks.ts`, `app/ui/components/NetworkSwitch.tsx`, `app/root.tsx`, `app/routes/net.tsx`, `app/routes/not-found.tsx`, `app/server/meta.ts`, `app/routes/net.search.tsx`, `app/routes/net.network.tsx`, `app/routes/net.validators.tsx`, `app/routes/net.validators.$key.tsx`, `app/routes/net.amendments.tsx`, `app/routes/net.amendments.$name.tsx`.
Tests: `app/ui/networks.test.ts` (new), `app/ui/components/components.test.tsx`, `app/server/meta.test.ts`, `app/ui/routes-wiring.test.tsx`, `test/worker/environment-sandbox.spec.ts`, and the literal updates of C2 in `app/server/{amendment-view,amendments-view,validator-view,validators-view,card-data}.test.ts` and `app/ui/pages/{AccountAnalytics,AccountPage,AmendmentPage,AmendmentsPage,AnalyticsFilters,HomePage,LedgerPage,MarketPairPage,MarketsPage,NetworkPage,SearchPage,TransactionPage,ValidatorPage,ValidatorsPage}.test.tsx`.

## Self-review

- Completeness against the brief: every file of the list is changed; every place of "where each name comes from" is done; the three tests per area named by the brief exist and went RED first.
- No page text writes a network as a literal in the files this task owns (`grep` of `app/ui/components`, `root.tsx`, `net.tsx`, `not-found.tsx`, `NotFoundPage.tsx` finds none). The one left is `RouteErrorScreen`'s `This explorer covers XRPL and Xahau.`, which the plan gives to Task 6 (`networkChoices(net.kind)`).
- `NetworkBrief` is a plain type now (no `Pick<PublicNetwork,…>`), so `Shell`, `Header`, `SearchBox`, `NotFoundPage`, `RouteErrorScreen` keep taking it and a layout's `PublicNetwork` is assignable.
- Pattern kept: hooks for the environment mirror `useFeatures`; `metaContext` reads the layout's loader data the way it read the origin before.

## Concerns

- The five clientLoaders and `net.tsx`'s `meta` now import `isNetworkId` as a value from `app/server/networks.ts`, as the plan says. That module is pure and light (the `NETWORKS` table; imports of `app/ui/*` only), so it ships to the browser. The initial JavaScript of the dashboards is 0.6 to 0.7 KB gzip above Task 4's report (network 150.7 to 151.4 KB, account analytics 152.4 to 153.0 KB, amm-pool 152.3 to 152.9 KB); I did not measure what part of that is the table, as opposed to the new `networkChoices` code and the boundaries' hooks. Every page is inside its budget; the tightest is `account analytics` at 153.0 of 160 KB (7.0 KB left), and `market-pair`, `validators`, `validator` and `amendment` are at 148 to 150 KB of their 160 KB.
- `findNetwork` has an overload (see above); it adds nothing to the plan's list of names.

## Commit

`11dbcf9 feat(sandbox): the switch, the error pages and the tags name the environment's networks` on `feat/explorer-pages-2` (36 files, 362 insertions, 138 deletions; the verification above was run on exactly this tree before committing).

## Fix round 1: `isNetworkId` out of the browser's value imports

Finding (Important): the five clientLoaders and `net.tsx`'s `meta` imported `isNetworkId` as a value from `app/server/networks.ts`, so the `NETWORKS` table shipped to the browser, against the Global Constraint "Browser files import nothing of `app/server` as values". Controller ruling: the constraint wins over the task text.

### What changed

- `app/ui/networks.ts` now defines `isNetworkId(s): s is NetworkId` (`Object.hasOwn(NETWORK_NAMES.mainnet, s)`: exact, case-sensitive, own keys only) and derives the id list from the names table: `NETWORK_IDS = Object.keys(NETWORK_NAMES.mainnet) as NetworkId[]`. The earlier `["xrpl", "xahau"] as const satisfies …` list, which only checked membership, is gone; `networkChoices` is built from the derived list.
- `app/server/networks.ts` no longer defines `isNetworkId`: it imports the ui one and re-exports it (`export { isNetworkId }`), so the Worker's routes (`network-route.ts`, the payments CSV and OG resource routes) keep their import and there is one definition.
- Browser-run route modules import it from `../ui/networks`: `net.network.tsx`, `net.validators.tsx`, `net.validators.$key.tsx`, `net.amendments.tsx`, `net.amendments.$name.tsx` (the clientLoaders), `net.tsx` (`meta`) and `not-found.tsx` (its loader is server code, but the module is a route's). What remains of `../server/networks` as values in `app/routes` is `networkOf`/`networkIdOfCtid` used inside loaders (stripped from the browser build, as before this task) and the two resource routes.
- Tests: the `isNetworkId` cases moved to `app/ui/networks.test.ts` (accepts the two ids; rejects `""`, `XRPL`, `Xahau`, `doge`, `"xrpl "`, `constructor`, `toString`, `__proto__`, `hasOwnProperty`; accepts exactly the keys of the table in both kinds, the switch lists them in the table's order, and both kinds have the same ids). `app/server/networks.test.ts` keeps one case: the server's `isNetworkId` is the ui function, and every id it accepts has a network in each environment's kind (`networkOf` for development, sandbox, production).

### Covering tests and verification

- `pnpm typecheck`: no errors.
- `pnpm test app/ui/networks app/server/networks app/ui/routes-wiring app/server/meta` → `Test Files 4 passed (4), Tests 253 passed (253)`.
- `pnpm exec vitest run --project worker-sandbox` → `Test Files 1 passed, Tests 18 passed (18)`.
- `pnpm verify` → exit 0: `Test Files 217 passed (217), Tests 9904 passed (9904)` (two more than before: the moved and the new `isNetworkId` cases net out to +2), build, `bundle check passed`.
- `pnpm fixtures:check` → "1051 generated fixture files are up to date". `pnpm test:e2e` → exit 0, `555 passed, 11 skipped` (8.4 min).

### Bundle, before and after (initial JavaScript per page, gzip)

Every page loses one file (the `app/server/networks.ts` chunk) and 0.34 KB:

| page | before | after |
|---|---|---|
| account analytics (tightest, budget 160) | 153.0 KB (153,029 B) | 152.7 KB (152,687 B) |
| amm-pool | 152.9 KB (152,924 B) | 152.6 KB (152,585 B) |
| network | 151.4 KB (151,434 B) | 151.1 KB (151,086 B) |
| market-pair | 150.3 KB (150,284 B) | 149.9 KB (149,947 B) |
| validator | 149.9 KB (149,881 B) | 149.5 KB (149,543 B) |
| validators | 149.8 KB (149,775 B) | 149.4 KB (149,434 B) |
| amendment | 148.5 KB (148,454 B) | 148.1 KB (148,111 B) |
| account (lookup, budget 150) | 140.9 KB | 140.5 KB |
| transaction | 137.7 KB | 137.4 KB |
| home | 135.5 KB | 135.2 KB |

Against Task 4's report the dashboards are still about 0.3 KB above it (network 150.7 to 151.1, account analytics 152.4 to 152.7, amm-pool 152.3 to 152.6): that is Task 5's own browser code (`networkChoices`, the derived list, the boundaries' environment hooks), not the table. The tightest page now has 7.3 KB left of 160.
