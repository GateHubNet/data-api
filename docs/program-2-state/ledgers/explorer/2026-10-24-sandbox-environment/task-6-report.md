# Task 6 report: The words that name a network

Status: DONE_WITH_CONCERNS (two small deviations from the brief's letter, below; no blocker).
Commit: `43c6621` feat(sandbox): the pages that name a network in their own words read its name, label, long name and DEX (27 files, +388 -103).

## What was implemented

Every literal network word left in page text now reads the page's network (`name`, `label`, `longName`, `dexName`):

- `HomePage.tsx`: hero `Explore ${network.longName}`, status line `{network.label} · ledger`; `HOME_TITLES` removed. `net._index.tsx` `meta` passes `Explore ${ctx.network.longName}` to `homeMeta`.
- `card-data.ts`: `labelOf` is `network.label` (all six cards).
- `AmmListPage.tsx`: intro `Automated market maker pools on ${network.longName}. ...` from `useNetwork()`.
- `meta-amm-list.ts`: the description is built from `ctx.network.longName` (`descriptionOf(network)`), in every view.
- `net.amm.$pool.tsx`: note `${net.name} has no AMM, so this pool exists only on ${other.longName}.`
- `markets-view.ts`: `introOf(ammState, network)` (`network.dexName`, `network.name`), the "AMM share" tile's sub `${network.name} has no AMM`; `MarketsInput.network` gains `dexName`.
- `meta-markets.ts`, `meta-pair.ts`: `network.dexName`. `DEX_NAMES` removed from `meta.ts` (and its header comment), and from `META_EXPORTS` of `test/unit/meta-bundle.test.ts` (with its comment).
- `analytics-view.ts`: `dexWording(network: Pick<Network, "name" | "hasAmm" | "features">)`, lead `Order-book trades only; ${network.name} has no AMM.` (`analytics-load.ts` already passes the whole `Network`).
- `NetworkPage.tsx`: h1 `${network.name} network`; `NETWORK_TITLES` removed; `Totals` and `VolumeCard` take `networkName`.
- `network-volume.ts`: `ammWording(amm, networkName)` (the `none` texts).
- `NoAmmPage.tsx`: `useNetwork()` + `findNetwork(network.other, network.kind)`: `${name} has no AMM`, `The AMM amendment is not part of ${name} ... Trades on ${name} ...`, `See ${name} markets →`, `Switch to ${other.name} pools` (link to `ammListPath(other.id)`).
- `RouteErrorScreen.tsx`: `This explorer covers ${names joined with " and "}.` over `networkChoices(net.kind)`.

## Tests (each for a mainnet and a testnet network; mainnet texts are today's)

- `HomePage.test.tsx`: "Explore the XRP Ledger" / "XRPL mainnet · ledger #..." and "Explore XRPL Testnet" / "XRPL Testnet · ledger #..." (no "mainnet").
- `card-data.test.ts`: the pill of all six cards (transaction, ledger, account, validator, amendment, pool) for both mainnets and both testnets; the footers that name the network.
- `AmmListPage.test.tsx`: intro under XRPL Testnet; the file's pages now render under a `/:net` layout (see "Layout in tests"). `meta.test.ts`: `ammListMeta` description "on XRPL Testnet" in every view, Xahau Testnet's explanation.
- `markets-view.test.ts`: the three intros and the tile's sub for Xahau Testnet / XRPL Testnet. `meta.test.ts`: `marketsMeta` and `pairMeta` descriptions with "the XRPL Testnet DEX" and "the Xahau Testnet DEX".
- `analytics-view.test.ts`: `dexWording` of Xahau Testnet is `{ hint: "order book", lead: "Order-book trades only; Xahau Testnet has no AMM." }`; XRPL Testnet reads like XRPL. `AccountAnalytics.test.tsx` (controller ruling): its three `dexWording` cases take `name`.
- `NetworkPage.test.tsx`: h1 "XRPL Testnet network" / "Xahau Testnet network", none-state wording with "Xahau Testnet", hydration of the testnet pages (the `NETWORK_TITLES` assertions went). `network-volume.test.ts`: `ammWording(amm, name)` for every state; the none texts for "Xahau Testnet".
- `components.test.tsx`: NoAmmPage under Xahau Testnet ("Xahau Testnet has no AMM", "See Xahau Testnet markets →", "Switch to XRPL Testnet pools", the soon style with markets off, and the mainnet's words) through `renderUnderNetwork`; RouteErrorScreen with an unknown network: "... This explorer covers XRPL and Xahau." and "... XRPL Testnet and Xahau Testnet."
- `test/worker/environment-sandbox.spec.ts` (new describe "the pages that name their network"): `/xrpl` h1 "Explore XRPL Testnet", title "Explore XRPL Testnet · explorer", status line "XRPL Testnet · ledger", no "mainnet" / "XRP Ledger"; `/xahau/amm/{pool}` note "Xahau Testnet has no AMM, so this pool exists only on XRPL Testnet." (the pool of amm-pool.spec.ts's Xahau case); `/og/xrpl/tx/{hash}.png` is 200, image/png.

## TDD evidence

RED (before any source change; `pnpm test app/server/card-data app/server/markets-view app/server/analytics-view app/ui app/server/meta test/unit`, the brief's command widened to the other files I changed): `Test Files 10 failed | 24 passed`, `Tests 17 failed | 1489 passed`. The 17 failures were exactly the new testnet cases, for the expected reasons, e.g.
`expected [ 'XRPL Testnet mainnet', …(5) ] to deeply equal [ Array(6) ]` (card pill), `expected 'Explore the XRP Ledger' to be 'Explore XRPL Testnet'` (home), `are not in meta.ts ... it exports only what every page's tags are made with` (meta-bundle, `DEX_NAMES` removed from the list while still exported), plus the `dexWording`, markets intro/tile, meta descriptions, NetworkPage h1/none wording, `ammWording` none, NoAmmPage and RouteErrorScreen cases. The mainnet cases stayed green.

RED for the worker spec: with the four source files of the home hero/status, the pool note, the home meta and `labelOf` reverted (`git apply -R`, then re-applied), `pnpm vitest run --project worker-sandbox` failed 2 of 21: `expected 'Explore the XRP Ledger' to be 'Explore XRPL Testnet'` and the pool page text "...exists only on the XRP Ledger." (not the Testnet sentence). The OG test is a "renders" test and passes either way (the pill's words are card-data.test.ts's).

GREEN: the same focused command: `Test Files 100 passed (100)`, `Tests 3619 passed (3619)`; `pnpm vitest run --project worker-sandbox`: 21 passed.

## Full verification

- `pnpm verify` exit 0: api:check, typecheck, `Test Files 217 passed (217)`, `Tests 9926 passed (9926)` (every project, no worker-spec timeouts), build, check:bundle (budgets ok; network 151.1 KB of 160, market-pair 149.9 of 160, amm-pool 152.5 of 160, account analytics 152.7 of 160).
- `pnpm fixtures:check`: 1051 generated fixture files are up to date.
- `pnpm test:e2e` exit 0: 555 passed, 11 skipped (the `[ERROR]` lines in its log are the failing-upstream scenarios on purpose).
- Step 4 grep (`XRP Ledger|mainnet|"XRPL"|"Xahau"|on Xahau|Xahau (has|markets)|XRPL pools` over non-test app files): what is left is comments, the `NetworkKind` type and `app/ui/environment.ts`, the names table of `app/ui/networks.ts`, and `app/server/networks.ts` (docs of the fields). A wider grep for `XRPL` / `Xahau` as words in non-comment, non-test code finds only `XLS_PATH = "/XRPLF/XRPL-Standards/"` and the type-group tables' names; nothing to move to a field.

## Files changed (27)

`app/routes/net._index.tsx`, `app/routes/net.amm.$pool.tsx`, `app/server/{analytics-view,card-data,markets-view,meta,meta-amm-list,meta-markets,meta-pair}.ts` and their tests (`analytics-view`, `card-data`, `markets-view`, `meta`), `app/ui/pages/{AmmListPage,HomePage,NetworkPage,NoAmmPage,RouteErrorScreen,network-volume}.ts(x)` and the tests of `AccountAnalytics`, `AmmListPage`, `HomePage`, `NetworkPage`, `network-volume`, `app/ui/components/components.test.tsx`, `test/unit/meta-bundle.test.ts`, `test/worker/environment-sandbox.spec.ts`. Each named in `git add` (no directory).

## Layout in tests (controller ruling C6)

- `components.test.tsx` uses `renderUnderNetwork` (async, `findBy...`), as the brief's file list puts NoAmmPage there.
- `AmmListPage.test.tsx` has ~40 synchronous tests whose `mount` returns the router and the Retry loader's call count, and two server-then-hydrate tests that need a router that draws at once. The `renderUnderNetwork` helper (loader-based, returns neither) does not fit, so the file's own `mount`/`routed` helpers now build the same route tree the helper does (`NETWORK_ROUTE_ID` layout, `/:net`, `Outlet`) with the layout's data as `hydrationData`. Same structure, still synchronous. Say if you want the shared helper extended instead.

## Deviations and notes

1. `network-volume.ts`: `volumeChart` also called `ammWording(amm)` only for the DEX line's `dexLabel`/`dexShort`, which name no network. Rather than thread a `networkName` through `volumeChart` (17 test call sites, an argument it never uses) or pass a dummy, I extracted a private `dexLine(amm)` for those two fields; `ammWording` spreads it in each of the four states (the labels were repeated in each) and `volumeChart` calls it. No exported name added; the existing `ammWording` and `volumeChart` expectations are unchanged and green. Easy to undo if you prefer the parameter.
2. `labelOf` in `card-data.ts` is now a one-line alias of `network.label` (kept because the brief names it; six call sites).
3. Comments that quote example sentences with the mainnet words (`loader-errors.ts`, `RouteErrorScreen.tsx`, `meta-home.ts`, `net.amm.$pool.tsx` header) were left: they are the allowed "comment" remainder and still true on the mainnet.
4. No `prettier` is installed in the explorer; I kept the existing wrapping by hand.

## Self-review

- Brief complete: every file of the list and the §7.1 grep items are done; `HOME_TITLES`, `DEX_NAMES`, `NETWORK_TITLES` are gone with their test references; the controller rulings (layout in AmmListPage/NoAmmPage tests, `AccountAnalytics.test`, named files in the commit) are followed.
- Browser files import nothing of `app/server` as a value: `NoAmmPage`/`AmmListPage` import `findNetwork` / `useNetwork` from `app/ui` only (`amm-bundle.test.ts`, `check:bundle` green).
- Text is built as one template string in JSX (`{`Explore ${...}`}`), so the server HTML has one text node (no `<!-- -->` splits) and the existing worker specs' text matches stay valid.
- No new names exported; nothing outside the task touched; `.claude/` untouched.
