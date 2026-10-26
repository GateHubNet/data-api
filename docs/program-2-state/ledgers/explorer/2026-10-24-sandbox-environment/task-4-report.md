# Task 4 report: the facts of a network per environment, and the CTIDs

Status: DONE. Commit `d90163f feat(sandbox): a network's facts and names by kind, and CTIDs of the testnets` on `feat/explorer-pages-2`.

## What was implemented

- `app/ui/networks.ts`: `NETWORK_NAMES: Record<NetworkKind, Record<NetworkId, { name; label; longName; dexName }>>` (type imports only: `NetworkId`, `NetworkKind`). The rest of the file (`NETWORK_CHOICES`, `DEFAULT_NETWORK`, `findNetwork`) is untouched; Task 5 changes it.
- `app/server/networks.ts` (head comment: the only place that knows a network's URLs and facts; the names are `app/ui/networks.ts`'s):
  - `Network` gains `kind`, `label`, `longName`, `dexName`, `displays: readonly Display[]`; `name` is `string`; `ctidNetworkId: 0 | 21337 | 1 | 21338`. `Display` is an `import type` from `app/domain/network-params.ts`.
  - `NetworkEntry = Pick<Network, "id" | "kind" | "native" | "ctidNetworkId" | "other" | "hasAmm" | "software" | "displays"> & { dataApiUrlVar; nodeUrlVar }`; `NETWORKS: Record<NetworkKind, Record<NetworkId, NetworkEntry>>` with the Global Constraints' facts (mainnet xrpl `XRP`/0/AMM/rippled/`["native","usd"]`, mainnet xahau `XAH`/21337/no AMM/xahaud/`["native"]`, testnet xrpl `XRP`/1/AMM/rippled/`["native"]`, testnet xahau `XAH`/21338/no AMM/xahaud/`["native"]`).
  - `networkOf(id, env)` takes `NETWORKS[networkKindOf(environmentOf(env.ENVIRONMENT))][id]`, spreads `NETWORK_NAMES[kind][id]`, the two URLs and `featuresOf(env)`.
  - `networkIdOfCtid(networkId, kind)`; `isNetworkId` unchanged (it reads the mainnet table's keys; the paths are the same in every environment).
- `app/server/resolve.ts`: `resolveCtid` decides the owner with `networkIdOfCtid(decoded.networkId, net.kind)` (doc comment says so).
- Routes: `net.tx.$id.tsx` and `net.search.tsx` pass `network.kind` to the "covered" test; their `nameOf`, and `net.ledger.$id.tsx`'s, are now `nameOf(context, id)` = `networkOf(id, getEnv(context)).name`. `net.amm.$pool.tsx`, `net.validators.$key.tsx`, `net.amendments.$name.tsx`, `net.account.$address.tsx` name the other network from `networkOf(net.other, getEnv(context))` instead of `findNetwork` (the helpers `validatorFailure`, `amendmentFailure`, `notAnAccount` take `context` first; the `?.`/`?? id` fallbacks are gone since `networkOf` always answers). `findNetwork` stays imported only where a `meta`/component still uses it (Task 5).
- `PublicNetwork` needed no change: it is `Omit<Network, "dataApiUrl" | "nodeUrl">`, so it carries the new fields.
- `vitest.config.ts`: `sandboxBindings = { ...testBindings, ENVIRONMENT: "sandbox" }`, project `worker-sandbox` (`include: test/worker/**/*-sandbox.spec.ts`, `provide: { workerBindings: sandboxBindings }`); `worker` excludes `*-sandbox.spec.ts`.
- Hand-built `Network`/`PublicNetwork` of the tests got the mainnet values of the new fields: `test/support/under-network.tsx` (`XRPL`), `app/ui/use-network.test.tsx`, `app/ui/routes-wiring.test.tsx` and `app/ui/components/components.test.tsx` (`XRPL`, `XAHAU`), `scripts/amm-info-reader.test.ts`, and the expectation in `app/server/network-route.test.ts`. The partial `NetworkInfo`/`NetworkBrief`-shaped fixtures of the page tests (`{ id, name, native, software }`) were left alone: they are Task 5/6's types.

## Controller ruling applied

Pre-flight C5: the `search.spec.ts` case "a CTID of XRPL Testnet is not covered" was NOT added (the existing "is a 404 for a network id that is neither XRPL's nor Xahau's, on either network" test already pins network id 1 in development). `test/worker/search.spec.ts` is unchanged.

## Tests

New/changed:
- `app/server/networks.test.ts`: the two `describes` tests now expect the full shape; `it.each([development mainnet, production mainnet, sandbox testnet, "Sandbox" mainnet])("networkOf in %s gives the %s facts and names")` over both ids with the Global Constraints' cells written out in the test (not read from the module); URLs come from the env whatever its environment; `networkIdOfCtid` by kind (the brief's two arrays), "gives every network of a kind a CTID id of its own", agreement with `networkOf` in all three environments, unknown ids, the other kind's ids.
- `app/server/network-route.test.ts`: `publicNetwork` carries the testnet names/facts of the sandbox and still no URL.
- `test/worker/environment-sandbox.spec.ts` (new, visitors `198.51.100.x`): the brief's five cases (`/xrpl/tx` breadcrumb "XRPL Testnet / Ledger …" and CTID `…0001`; `/xahau/tx` CTID `…535A`; search of a XRPL Testnet CTID 302s to the hash; search of a mainnet CTID is "not covered" (on both networks, nobody asked); search of a Xahau Testnet CTID on `/xrpl` offers "Xahau Testnet"), plus cases I added for lines this task changed and would otherwise be untested: `/xrpl/tx` with a mainnet CTID is not covered (the tx route's `covered`), and the "other network an offer names" group (search hash, tx hash, ledger hash both ways, account never activated on Xahau, AMM pool on Xahau, validator, amendment: each offer says "Xahau Testnet"/"XRPL Testnet").

TDD evidence:
- RED (unit): `pnpm test app/server/networks` against the old `networks.ts`/updated test: `Tests 9 failed | 26 passed (35)`: e.g. `networkOf > describes the XRP Ledger` ("expected { id: 'xrpl', name: 'XRPL', …(8) } to deeply equal { id: 'xrpl', kind: 'mainnet', …(13) }"), the four `networkOf in %s` cells, `knows the network of a CTID id by kind` ("expected [ 'xrpl', 'xahau', undefined, …(1) ] to deeply equal [ 'xrpl', 'xahau', 'xrpl', 'xahau' ]"), `knows no testnet for the mainnet id 0` ("expected 'xrpl' to be undefined"). Expected: the old table has no kind and the old `networkIdOfCtid` ignores its second argument.
- RED (sandbox spec): the implementation was already in when the spec was written, so the old behaviour was reproduced by pinning `const kind: NetworkKind = "mainnet"` in `networkOf` (then restored from a saved copy; diff checked): `pnpm exec vitest run --project worker-sandbox` → `Tests 6 failed (6)` (e.g. "expected 'Payment AACAFC…FD40 · XRPL · explorer…' to contain 'CTID C6173D03003F0001'", "expected 302 to be 404", "expected 404 to be 302"). The later "other network" cases were written after and failed first on the 404 screen's own sentence, which is Task 5's (see below); their assertions were narrowed to the offers.
- GREEN: `pnpm test app/server/networks test/worker/search test/worker/resolve` → `Test Files 3 passed, Tests 125 passed`; `pnpm exec vitest run --project worker-sandbox` → `Test Files 1 passed, Tests 14 passed`; `pnpm exec vitest run --project worker test/worker/environment-sandbox` → "No test files found" (the `worker` project excludes it).
- Full: `pnpm verify` → exit 0 (api:check, typecheck, test `Test Files 216 passed, Tests 9884 passed`, build, check:bundle: all pages within budget; largest dashboards network 150.7 KB / account analytics 152.4 KB / amm-pool 152.3 KB of 160 KB, lookup pages ≤ 140.2 KB of 150 KB). `pnpm fixtures:check` → "1051 generated fixture files are up to date". `pnpm test:e2e` → exit 0, `555 passed, 11 skipped` (8.3 min; the `[ERROR]` lines in the log are the failure-card scenarios' expected logs). No worker spec timed out.

## Files changed

`app/server/networks.ts`, `app/server/networks.test.ts`, `app/ui/networks.ts`, `app/server/resolve.ts`, `app/server/network-route.test.ts`, `app/routes/net.tx.$id.tsx`, `net.search.tsx`, `net.ledger.$id.tsx`, `net.amm.$pool.tsx`, `net.validators.$key.tsx`, `net.amendments.$name.tsx`, `net.account.$address.tsx`, `test/support/under-network.tsx`, `test/worker/environment-sandbox.spec.ts` (new), `vitest.config.ts`, `app/ui/use-network.test.tsx`, `app/ui/routes-wiring.test.tsx`, `app/ui/components/components.test.tsx`, `scripts/amm-info-reader.test.ts`.

## Self-review

- Completeness against the brief: every listed file and interface is done; `search.spec.ts` deliberately untouched (ruling C5).
- `Network.name` widened from `"XRPL" | "Xahau"` to `string`; typecheck found nothing relying on the literal types.
- Server value-imports the UI's `NETWORK_NAMES` and `environment.ts` (allowed direction); `app/ui/networks.ts` still imports types only. Bundle budgets unchanged in practice.
- `README.md` still lists only `worker`/`worker-off` (its sandbox "Tests" paragraph is a later task's, per the plan's README task).
- No `staging` introduced.

## Concerns / notes for later tasks

- The 404 screens ("We couldn't find … on …") and the `net.tsx`/`not-found` pages still read the static `findNetwork` names, so in the sandbox a 404 of `/xahau/amendments/x` says "on Xahau" while the offer says "XRPL Testnet". That is Task 5's (names where there is no layout data); the sandbox spec asserts the offers only, not that sentence. Likewise the `net.amm.$pool.tsx` note ("… exists only on the XRP Ledger.") is Task 6's.
- `app/ui/networks.ts` `NETWORK_CHOICES` still holds literal `XRPL`/`Xahau` (gone in Task 5).
- Not a regression, but worth knowing: `displaysOf` in `app/domain/network-params.ts` still has its own `DISPLAYS` table; `Network.displays` is the new source and Task 8 moves the readers.
