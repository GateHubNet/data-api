## Global Constraints

- Install once, in Task 1: `pnpm install --frozen-lockfile` (its postinstall runs `wrangler types`); `pnpm exec playwright install chromium` if the end-to-end suite needs it.
- Before every commit `pnpm verify` exits 0 (api:check, typecheck, test with every project, build, check:bundle) and `pnpm fixtures:check` still passes (no fixture changes in this plan). Tasks 4 to 10 also run `pnpm test:e2e`: the suite runs the top level, development, whose pages must not change.
- Commits: Conventional Commits with the repo's scopes (`refactor(sandbox): …`, `feat(sandbox): …`, `ci(sandbox): …`, `test(sandbox): …`, `docs(sandbox): …`), a body that says why, and the last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--amend`, never `git add -A` or `git add .` (name the files), never touch `.claude/`. Delete nothing you did not create.
- The three environments, exactly (§1):

  | | top level | `sandbox` | `production` |
  |---|---|---|---|
  | Worker `name` | `x-explorer` | `x-explorer-sandbox` | `x-explorer-production` |
  | route (custom domain) | none | `explorer.sandbox.gatehub.net` | `explorer.gatehub.net` |
  | `ENVIRONMENT` | `"development"` | `"sandbox"` | `"production"` |
  | `XRPL_DATA_API_URL` | `https://xrpl.data.example.invalid` | `https://xrpl.data.sandbox.gatehub.net` | `https://xrpl.data.gatehub.net` |
  | `XAHAU_DATA_API_URL` | `https://xahau.data.example.invalid` | `https://xahau.data.sandbox.gatehub.net` | `https://xahau.data.gatehub.net` |
  | `XRPL_NODE_URL` | `https://s1.ripple.com:51234/` | `https://clio.altnet.rippletest.net:51234/` | `https://s1.ripple.com:51234/` |
  | `XAHAU_NODE_URL` | `https://xahau.network/` | `https://xahau-test.net/` | `https://xahau.network/` |
  | `VISITOR_LIMITER` namespace | `1000` | `1001` | `1002` |

  Every block lists `ENVIRONMENT` and the five switches (`vars` are not inherited); the switches stay "on" at the top level and "off" in `sandbox` and `production` (D3). The XRPL node of a deployed environment must be a Clio (D9).
- The names, exactly (§5): mainnet `xrpl` `XRPL` / `XRPL mainnet` / `the XRP Ledger` / `the XRP Ledger DEX`; mainnet `xahau` `Xahau` / `Xahau mainnet` / `Xahau` / `the Xahau DEX`; testnet `xrpl` `XRPL Testnet` / `XRPL Testnet` / `XRPL Testnet` / `the XRPL Testnet DEX`; testnet `xahau` `Xahau Testnet` / `Xahau Testnet` / `Xahau Testnet` / `the Xahau Testnet DEX` (`name` / `label` / `longName` / `dexName`).
- The facts, exactly (§5): mainnet `xrpl` `XRP`, CTID 0, AMM, `rippled`, displays `["native", "usd"]`; mainnet `xahau` `XAH`, 21337, no AMM, `xahaud`, `["native"]`; testnet `xrpl` `XRP`, 1, AMM, `rippled`, `["native"]`; testnet `xahau` `XAH`, 21338, no AMM, `xahaud`, `["native"]`. `other`, `dataApiUrlVar`, `nodeUrlVar` are the same in both kinds; the paths stay `/xrpl` and `/xahau`.
- Amounts keep their codes `XRP` and `XAH` (D5). No URL of one environment appears in the other's pages, and no link between them (D7).
- No page text writes a network as a literal (`"XRPL"`, `"Xahau"`, "the XRP Ledger", "mainnet"): it reads `name`, `label`, `longName` or `dexName` of the page's network, or the names table by kind. The top level (development) shows the mainnet names, so every existing test of a mainnet word stays.
- `app/ui/environment.ts` imports nothing; `app/ui/networks.ts` imports types only. Browser files import nothing of `app/server` as values (the bundle tests of `test/unit/*-bundle.test.ts`).
- After Task 1, the word "staging" appears nowhere in `app/`, `workers/`, `scripts/`, `test/` (but `test/fixtures/`), `.github/`, `README.md`, `wrangler.jsonc`, `package.json`, `playwright.config.ts`, `vitest.config.ts`, `vite.config.ts` (D14); a test that must name it builds it from halves (`"stag" + "ing"`). `GLOSSARY.md`, `docs/` and the git history keep their words.
- Budgets (ruling R19): every page under 150,000 bytes gzip (lookup pages) or 160,000 (dashboards), with the manifest; `pnpm check:bundle`.

