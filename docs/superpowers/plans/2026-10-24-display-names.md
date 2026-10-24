# Display Names Data (D4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn every account's current domain from the ledger, read each domain's toml through the safe fetcher into a per-domain store, and serve display names for up to 100 addresses (`GET /v2/account_names`) and what a domain's toml says (`GET /v2/toml/{domain}`), on XRPL, Xahau and their testnets.

**Architecture:** Migration 012 adds `account_domains` (ledger-derived, the newest row of an account wins, written by a pure parser at parser version 6) and `domain_tomls` (one row per check, the newest row of a domain wins). The pure rules of the program's one toml store (`cleanTomlText`, `accountDomainOf`, `countsOn`, `readToml`, `okTomlRow`, `recordToml`, `readStoredTomls`) live in `packages/shared/src/tomls/`, where D6 and D8 read them. A sixth syncer worker, `tomls`, discovers the domains accounts name every 5 minutes and checks the due ones every 60 s through a `SafeFetcher` of its own, on D1's pass loop. A new api `NamesModule` takes over PR #20's `NamesAndLabelsService` and adds the keyed `account_domains` read, the in-memory toml directory, `displayNameOf`, and the two routes.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 (`@clickhouse/client`), pnpm 10 workspace, jest + ts-jest, testcontainers, supertest, `ripple-address-codec`, `smol-toml` 1.3.1 (pinned exactly, moved from the syncer to the shared package), Node `https`/`dns`/`net` (D1's safe fetcher).

**Spec:** `docs/superpowers/specs/2026-10-24-display-names-design.md` (cited as "spec §n" or "decision n"; the plan argues from the spec, executors read both). The explorer's side is E9 (x-explorer `docs/superpowers/specs/2026-10-24-display-names-design.md`); D6 and D8 read the store this builds (spec §8).

**Branch:** `feat/explorer-data-2` in `DAPI = /Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2` (stacked on PR #20). Before Task 1, these are on the branch: PR #20 (`account_names`, `account_labels`, `account_network_names`, `account_states`, `NamesAndLabelsService`, migrations 005–010, parser versions 3–4, ADR-0014, ADR-0015), D-env (`docs/superpowers/plans/2026-10-24-testnet-profiles.md`: the four network profiles) and D3 (`docs/superpowers/plans/2026-10-17-nft-data.md`: migration 011, `NFT_PARSER_VERSION = 5`, ADR-0016, an ADR-0010 amendment). Commit on this branch; never push.

## Global Constraints

- Setup once, in Task 1: `pnpm install` then `pnpm build` from `DAPI`. After a `package.json` change (Task 2): `pnpm install --offline` (smol-toml 1.3.1 is already in the store and the lockfile).
- The apps import the compiled `dist/` of `packages/shared`: after changing shared, `pnpm --filter @gatehub/data-api-shared build` before running app tests.
- Before each commit: `pnpm format`, `pnpm build`, `pnpm test`, and `pnpm --filter <package> test:e2e` of every package the task touched (`@gatehub/data-api-shared`, `@gatehub/data-api-service`, `@gatehub/data-syncer`; Docker), all exit 0. The first e2e run pulls `testcontainers/ryuk`; if that fails, run with `TESTCONTAINERS_RYUK_DISABLED=true` and say so in the report.
- Commits: Conventional Commits (`feat(shared): …`, `feat(syncer): …`, `feat(api): …`, `test: …`, `docs: …`), a body saying why, and the last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Name the files in `git add`; never `git add -A`, never `--amend`, never touch `.claude/`. Delete nothing you did not create in the task.
- Numbering (Task 3 and Task 4 check it first): migration `012_display_names.sql`, `DOMAIN_PARSER_VERSION = 6` (and `PARSER_VERSION` moves to 6), ADR `0017`, ADR-0010's Amendment 6 (after D3's 5; D5 takes 7). If D3 or PR #20 took more, use the next free value and change every reference of that task.
- Repo conventions (`docs/development.md` §5): table names only from `Table`; every user-derived value a bound parameter (`{addresses:Array(String)}`, `{domain:String}`); no `FINAL`; newest rows by `argMax(…)` or `ORDER BY … LIMIT 1 BY …`; aliases of aggregates never named like a column (D1's rule); config only through the config classes; everything new of `packages/shared` exported from `packages/shared/src/index.ts`.
- Times: `DateTime('UTC')` columns are unix seconds (integers), `DateTime64(3, 'UTC')` unix seconds with the milliseconds as a fraction (never integer milliseconds). `version` of `account_domains` is decimal text (it passes 2^53).
- Outbound HTTP only through D1's `SafeFetcher`, with `tomlFetchLimits(GH_DOMAIN_FETCH_TIMEOUT_MS)` (10 s, 256 KiB, 3 checked redirects, https and port 443). The api never fetches. Nothing a toml holds is ever fetched. A toml's text is parsed, never evaluated, never stored.
- Never read, store, log or serve a principal's `email` or social keys, `[[SERVERS]]` or `[ORGANIZATION]`. Logs name a domain (quoted and cut with D1's `quoted` rule), a reason and a status code; never a body, an error object, a principal or a desc.
- Fixed in code (spec §4): discovery every `TOML_DISCOVERY_INTERVAL_MS = 300_000`; a pass 60 s after the previous one ended; `TOML_PASS_LIMIT = 300`; `TOML_FETCH_CONCURRENCY = 16`; writes in batches of `TOML_WRITE_BATCH = 50` and at the end of a pass; transient re-check 1 h; content grace 24 h (`DOMAIN_VERIFIED_GRACE_S`); definite backoff 1, 2, 4, then 7 days; named anew checked at most hourly. Configurable: `GH_TOML_RECHECK_MS` (default `86400000`, at least 1); shared with D1: `GH_DOMAIN_VERIFICATION`, `GH_DOMAIN_FETCH_TIMEOUT_MS`.
- `tomlNetworkNames`: `xrpl` `['main', 'mainnet']`, `xahau` `['main', 'mainnet', 'xahau', '21337']`, `xrpl-testnet` `['testnet']`, `xahau-testnet` `['testnet', '21338']`.
- API answers: a key without a value is absent, never `null`; key orders are exported `*_KEYS` constants pinned by tests and by the reference's "Keys of …" lines; instants of receipt `fmtMillis` (`YYYY-MM-DDTHH:mm:ss.SSSZ`), wall times `fmtTime` (`YYYY-MM-DDTHH:mm:ssZ`). `Cache-Control` is the default (`private, max-age=60`); errors `no-store` (the filter does it). Messages exactly: 400 `addresses is required`, `too many addresses - at most 100`, `invalid ripple address`, `invalid domain`; 404 `toml not found`; 500 `unable to retrieve account names`, `unable to retrieve toml`.
- Metrics are syncer-only, prefix `syncer_`; the api adds none.
- Hand-written TOML texts in tests use `*.example` domains and fictional names; recorded ledgers are recorded, never written by hand.

## Review Focus

1. **A Domain field in any spelling.** `https://x.com`, a path, a port, an IP, an IPFS hash, upper case, a space, non-ASCII bytes, 129 characters: only a proper domain names one (lower-cased), the rest give no display name and no fetch. Tests: Task 1 `account-domain.spec.ts` `names no domain for a URL, a path, a port, an IP, an IPFS hash, a space or non-ASCII`; Task 7 `domain-discovery.spec.ts` `drops what names no domain and adds up the spellings of one domain`.
2. **A website that blips, then dies.** A 503 or a timeout within 24 h of the last read keeps the content (and so the verified name) with status `failed`; after 24 h, or after a 404, the domain is "not verified"; definite failures back off 1, 2, 4, 7 days. Tests: Task 6 `toml-row.spec.ts` `carries the content through a transient failure within 24 h of fetched_at` and `drops it a second later`; Task 9 `tomls-worker.e2e-spec.ts` `keeps a verified name through a 503 within the grace, and loses it after`.
3. **An api that does not know the store yet.** Before the toml directory loads there is no `verified` and no `domain` kind (names and labels are still served); a failed `account_domains` read is a 500, never an answer without domains. Tests: Task 11 `display-name.spec.ts` `gives no domain kind before the directory has loaded` and `display-names.service.spec.ts` `serves names and labels but no verified or domain kind while the directory has not loaded`; Task 12 `display-names.e2e-spec.ts` `keeps the last directory when a reload fails` and `answers 500 when account_domains cannot be read`.
4. **A hostile toml.** A `desc` with bidi overrides and controls, a `desc` of 65 characters, 5,000 accounts, a principal named with an email, `email` and `twitter` keys: text cleaned, never cut, capped, and no email or handle anywhere in the row, the logs or the answer. Tests: Task 2 `toml-read.spec.ts` `never keeps an email or a social handle`; Task 8 `toml-checker.spec.ts` `logs no body, principal or email`; Task 13 `toml.e2e-spec.ts` `serves no email or handle`.
5. **An entry's `network` on both networks and the testnets.** `network = 21337` bare on Xahau, `"MAIN"`, `"testnet"` on an XRPL mainnet file, absent: Xahau verifies the bare integer, XRPL mainnet ignores a testnet entry, a testnet profile counts `testnet`. Tests: Task 2 `keeps a bare integer network as its decimal text and lower-cases text`; Task 1 `counts-on.spec.ts`; Task 12 `verifies a Xahau account whose entry says network = 21337, and not an XRPL account whose entry says testnet`.

---

## Consumed from earlier work

| Piece | From | Where |
| --- | --- | --- |
| The four profiles `xrpl`, `xahau`, `xrpl-testnet`, `xahau-testnet` (`NetworkProfile` with `name`, `tomlPath`, …) | D-env | `packages/shared/src/network/network-profile.ts` |
| `isProperlyFormedTomlDomain(domain)` | D1 | `packages/shared/src/validators/manifest.ts` |
| `SafeFetcher`, `SafeFetchError`, `FetchFailure`, `tomlFetchLimits`, `SafeFetchTestOptions`, `validatorsUserAgent` | D1 | `apps/syncer/src/validators/safe-fetch.ts` |
| `isTransientReason(reason, statusCode)`, `DOMAIN_VERIFIED_GRACE_S`, `DomainReason` | D1 | `apps/syncer/src/validators/domain-checker.ts` |
| `PassLoop` (not exported today) | D1 | `apps/syncer/src/validators/validators-worker.ts` |
| `matchToml`, `TomlInvalidError` | D1 | `apps/syncer/src/validators/toml-match.ts` |
| `AccountStatesParser`, `account_states`, `STATE_PARSER_VERSION` | PR #20 | `packages/shared/src/parsers/account-states.parser.ts`, `rows.ts` |
| `buildLedgerRows`, `LedgerRows`, `LedgerDiagnostics`, `CHILD_TABLES`; `LEDGER_KEYED_TABLES` (P7) | ingest | `packages/shared/src/ingest/build-rows.ts`, `ingest-state.ts` |
| `NamesAndLabelsService` (`of(address)`), `NamesAndLabels`, `AccountLabels`, `ACCOUNT_NAMES`, `ACCOUNT_NETWORK_NAMES`, `ACCOUNT_LABELS` | PR #20 | `apps/api/src/accounts/` |
| `CacheService` (`wrap`, `get`, `set`), `RippleController`, `RippleRoute`, `badRequest`, `notFound`, `first`, `fmtTime`, `fmtMillis`, `ApiConfig.namesAndLabelsReloadMs`, `NETWORK_PROFILE` | api | `apps/api/src/common/`, `apps/api/src/config/api.config.ts` |
| `startHarness` (`network`, `sharedDatabase`), `accountAt`, `hashOf`, `readsOf`, `explain` | api tests | `apps/api/test/harness.ts`, `test/support/{amm,read-rows,plans}.ts` |
| `startTestWeb` (`serveToml`, `fetchOptions()`), `startMigratedClickHouse`, `quietLogger`, `waitFor`, `startValidatorsApp` (model) | syncer tests | `apps/syncer/test/support/validators-env.ts` |
| `startClickHouse`, `SAMPLE_ROWS`, `deepFreeze` | shared tests | `packages/shared/test/clickhouse-container.ts`, `test/sample-rows.ts`, `src/test-utils/deep-freeze.ts` |

---

### Task 1: Toml text, account domains and the network rule

**Files:**
- Create: `packages/shared/src/tomls/toml-text.ts`, `packages/shared/src/tomls/account-domain.ts`, `packages/shared/src/tomls/counts-on.ts`, `packages/shared/src/tomls/index.ts`, and `toml-text.spec.ts`, `account-domain.spec.ts`, `counts-on.spec.ts` beside them
- Modify: `packages/shared/src/network/network-profile.ts` (the field, its four values), `packages/shared/src/network/network-profile.spec.ts`, `packages/shared/src/index.ts` (`export * from './tomls'`)

**Interfaces:**
- Consumes: D-env's four profiles; D1's `isProperlyFormedTomlDomain`.
- Produces (Tasks 2, 6–13; D6 and D8 by these names):
  ```ts
  // NetworkProfile gains
  /** The `network` values of a toml entry that name this network (spec §3.4), lower case. */
  tomlNetworkNames: readonly string[];
  // toml-text.ts
  export function cleanTomlText(value: unknown, max: number): string | undefined;
  // account-domain.ts
  export const MAX_DOMAIN_HEX = 512;
  export function accountDomainOf(hex: string): string | undefined;
  // counts-on.ts
  export function countsOn(entryNetwork: string, profile: Pick<NetworkProfile, 'tomlNetworkNames'>): boolean;
  ```

Rules:
- `cleanTomlText` (spec §3.3, Ruling 1): not a string → `undefined`; else NFC; every character of the categories Cc and Cf that is not white space removed (`/(?!\s)[\p{Cc}\p{Cf}]/gu`); every run of white space (`/\s+/gu`, which includes tab, newline, NBSP and U+FEFF) one space; trimmed; `undefined` when empty or longer than `max` code points (`[...text].length`). Nothing is cut.
- `accountDomainOf` (spec §3.2, decision 2): `hex` matches `/^(?:[0-9A-Fa-f]{2})+$/` and has at most `MAX_DOMAIN_HEX` digits; every byte 0x21–0x7E; the text lower-cased; that text when `isProperlyFormedTomlDomain` accepts it, else `undefined`. Nothing is trimmed.
- `countsOn`: `entryNetwork === ''` or `profile.tomlNetworkNames.includes(entryNetwork)` (the writer stored it lower-cased, Task 2).

- [ ] **Step 1: Prepare, then write the failing tests.** `pnpm install` and `pnpm build` in `DAPI` first. Then:
  ```ts
  // toml-text.spec.ts
  expect(cleanTomlText('  Northpeak\tTreasury \n', 64)).toBe('Northpeak Treasury');
  expect(cleanTomlText('North‮peak', 64)).toBe('Northpeak');                      // a bidi override (Cf) goes
  expect(cleanTomlText('a ‎ b\u0007c', 64)).toBe('a bc');                          // Cf and Cc go, the spaces collapse
  expect(cleanTomlText('é', 1)).toBe('é');                                         // NFC: one code point
  expect([cleanTomlText('x'.repeat(64), 64), cleanTomlText('x'.repeat(65), 64)]).toEqual(['x'.repeat(64), undefined]);
  expect(cleanTomlText('😀'.repeat(64), 64)).toBe('😀'.repeat(64));                      // code points, not UTF-16 units
  expect([cleanTomlText('', 9), cleanTomlText(' \u0007 ', 9), cleanTomlText(42, 9), cleanTomlText(undefined, 9)]).toEqual([undefined, undefined, undefined, undefined]);
  // account-domain.spec.ts (hex = Buffer.from(text, 'latin1').toString('hex').toUpperCase())
  expect(accountDomainOf('4578616D706C652E434F4D')).toBe('example.com');               // "Example.COM"
  expect(accountDomainOf(hex('example.com').toLowerCase())).toBe('example.com');
  expect(accountDomainOf(hex(`${'a'.repeat(63)}.${'b'.repeat(60)}.com`))).toBe(`${'a'.repeat(63)}.${'b'.repeat(60)}.com`); // 128
  expect(accountDomainOf(hex(`${'a'.repeat(63)}.${'b'.repeat(61)}.com`))).toBeUndefined();                                // 129
  ```
  `it('names no domain for a URL, a path, a port, an IP, an IPFS hash, a space or non-ASCII')` over `https://x.com`, `x.com/path`, `x.com:443`, `localhost`, `1.2.3.4`, `ex ample.com`, ` example.com`, `exämple.com` (latin1 byte 0xE4), `bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi`; and `''`, `'ABC'` (odd), `'ZZ'`, 514 hex digits → all `undefined`. `counts-on.spec.ts`: XRPL `''`, `main`, `mainnet` true, `testnet`, `21337`, `xahau` false; Xahau `21337`, `xahau`, `main` true, `testnet` false; `xrpl-testnet` `testnet` true, `main` false; `xahau-testnet` `21338`, `testnet` true, `21337` false. `network-profile.spec.ts`: each profile's `tomlNetworkNames` equals the Global Constraints value.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- tomls network-profile`: modules not found, the profile field missing.
- [ ] **Step 3: Implement the three modules and the profile field** in the files above; `tomls/index.ts` re-exports them.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared test` exits 0; `pnpm build` exits 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/shared/src/tomls packages/shared/src/network/network-profile.ts packages/shared/src/network/network-profile.spec.ts packages/shared/src/index.ts
  git commit -m "feat(shared): toml text cleaning, the account domain rule and tomlNetworkNames" -m "Names come from a domain's toml only when the Domain field names a proper domain and the entry counts on this network; the rules live in the shared package for the worker, the api, D6 and D8." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 2: Reading a toml (`readToml`)

**Files:**
- Create: `packages/shared/src/tomls/toml-read.ts`, `packages/shared/src/tomls/toml-read.spec.ts`
- Modify: `packages/shared/package.json` (dependency `"smol-toml": "1.3.1"`), `apps/syncer/package.json` (remove `smol-toml`: nothing in the syncer imports it after this task), `pnpm-lock.yaml` (by `pnpm install --offline`), `packages/shared/src/tomls/index.ts`, `apps/syncer/src/validators/toml-match.ts` (parse with `parseTomlText`; `export { TomlInvalidError } from '@gatehub/data-api-shared'` so `domain-checker.ts` keeps its import)

**Interfaces:**
- Consumes: Task 1 `cleanTomlText`.
- Produces (Tasks 6, 8; D6 and D8):
  ```ts
  export class TomlInvalidError extends Error;          // name 'TomlInvalidError', message 'the file is not valid TOML' (moved from the syncer)
  /** The parsed document; a leading U+FEFF is dropped. Throws TomlInvalidError, which holds no word of the file. */
  export function parseTomlText(text: string): Record<string, unknown>;
  export interface TomlAccount { address: string; network: string; desc: string }
  export interface TomlCurrency { code: string; issuer: string; network: string; fields: string }
  export interface TomlValidator { public_key: string; network: string; fields: string }
  export interface TomlContent {
    modified: UnixSeconds | null; expires: UnixSeconds | null;
    accounts: TomlAccount[]; currencies: TomlCurrency[]; validators: TomlValidator[]; principals: string[];
  }
  export const EMPTY_TOML_CONTENT: Readonly<TomlContent>;   // nulls and empty lists, frozen
  export const TOML_LIMITS = { accounts: 1_000, currencies: 200, validators: 100, principals: 10, fieldKeys: 16 } as const;
  export const MODIFIED_FLOOR_S = 1_325_376_000;            // 2012-01-01T00:00:00Z
  /** What the file says, by spec §3.3. `profile` is read by no rule (the writer keeps every network's entries; Ruling 3). */
  export function readToml(text: string, profile: Pick<NetworkProfile, 'name'>, fetchedAt: UnixSeconds): TomlContent;
  ```

Rules (spec §3.3; entries are those of a table array or an array of inline tables, as `toml-match.ts` reads them today):
- `[[ACCOUNTS]]`: `address` trimmed, kept when `isValidClassicAddress` (X-address, bad checksum, non-text: entry skipped); a repeated address keeps its first entry; `desc` = `cleanTomlText(desc, 256) ?? ''`; at most 1,000 kept, file order.
- `[[CURRENCIES]]`: `code` = `cleanTomlText(code, 40)`, entry skipped without one; `issuer` trimmed when a valid classic address, else `''`; at most 200.
- `[[VALIDATORS]]`: `public_key` = `cleanTomlText(value, 128)`, entry skipped without one; at most 100.
- `[[PRINCIPALS]]`: only `name`, through `cleanTomlText(name, 100)`, dropped when it contains `@`, without repeats, file order, at most 10. No other key of a principal is read.
- `network` of every entry: a string → `cleanTomlText(value, 64)?.toLowerCase() ?? ''`; an integer number → its decimal text; anything else or absent → `''`.
- `fields` (currencies, validators): the entry's keys other than the kept ones (`code`, `issuer`, `network` / `public_key`, `network`), in file order, matching `/^[A-Za-z0-9_]{1,32}$/`, whose value is a string (through `cleanTomlText(value, 256)`, dropped when `undefined`), a finite number or a boolean; at most 16 such keys; `JSON.stringify` of them (`'{}'` when none).
- `[METADATA]` `modified`, `expires`: a smol-toml `TomlDate` (offset date-time: its instant; local date-time: read as UTC; local date: 00:00 UTC; a local time alone: dropped), or a string that `new TomlDate(text.trim())` reads as one of those three; unix seconds (`Math.floor(getTime() / 1000)`), else `null`. `modified` is `null` when before `MODIFIED_FLOOR_S` or more than 86,400 s after `fetchedAt`.
- An unknown section, a key of another type, a nested table inside an entry: ignored; never a failure.

- [ ] **Step 1: Write the failing tests** (`toml-read.spec.ts`, hand-written texts, fetchedAt `1_792_800_000` (2026-10-24T00:00:00Z)): a byte order mark is read; `'a = '` throws `TomlInvalidError` whose message does not contain `a =`; an X-address and a bad checksum in `[[ACCOUNTS]]` skipped, a repeated address keeps its first `desc`; `desc` of 256 kept, 257 → `''`; 1,005 accounts keep the first 1,000; `it('keeps a bare integer network as its decimal text and lower-cases text')` (`network = 21337` → `'21337'`, `network = " MAIN "` → `'main'`, `network = true` → `''`); a currency without `code` skipped, an invalid `issuer` → `''`; `fields` of `{ display_decimals = 2, symbol = "N$", name = "Northpeak Dollar", "bad key" = 1, nested = { a = 1 }, list = [1] }` → `'{"display_decimals":2,"symbol":"N$","name":"Northpeak Dollar"}'`; 20 scalar keys keep the first 16; `it('never keeps an email or a social handle')`: a file with `[[PRINCIPALS]] name = "Mara Lindqvist" email = "mara@northpeak.example" twitter = "@mara"` and a principal named `"ops@northpeak.example"` → `principals` `['Mara Lindqvist']`, and `JSON.stringify(result)` contains neither `mara@`, `@mara` nor `ops@`; principals repeated and 12 of them → 10 without repeats; `modified` as `2026-10-02T00:00:00Z`, `2026-10-02T00:00:00` (local, UTC), `2026-10-02` (00:00 UTC), the text `"2026-10-02"` → `1790899200`, `2011-12-31` → `null`, fetchedAt + 86,401 → `null`, `12:00:00` → `null`; `expires` kept whatever its value. `toml-match.spec.ts` stays as it is and must still pass.
- [ ] **Step 2: Run it to verify it fails.** `pnpm --filter @gatehub/data-api-shared test -- toml-read`: module not found.
- [ ] **Step 3: Move the dependency and implement.** Edit both `package.json` files, `pnpm install --offline`, write `toml-read.ts` (parse with smol-toml's `parse`; dates with its `TomlDate`), then point `toml-match.ts` at `parseTomlText` and re-export `TomlInvalidError`.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared build && pnpm --filter @gatehub/data-api-shared test && pnpm --filter @gatehub/data-syncer test` exit 0.
- [ ] **Step 5: Commit.**
  ```bash
  git add packages/shared/package.json apps/syncer/package.json pnpm-lock.yaml packages/shared/src/tomls apps/syncer/src/validators/toml-match.ts
  git commit -m "feat(shared): readToml, the store's reading of a toml, with the parse moved from the syncer" -m "Only the keys the spec lists are read, every text is cleaned and capped, and a principal's email or handle is never read; D8's matchToml will read its entries from here." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
  ```

---

### Task 3: Migration 012 and the row types

**Files:**
- Create: `packages/shared/schema/012_display_names.sql`
- Modify: `packages/shared/src/clickhouse/tables.ts`, `packages/shared/src/clickhouse/rows.ts`, `packages/shared/test/sample-rows.ts`, `packages/shared/test/migrate.e2e-spec.ts`, `docs/data-model.md` (the two tables, `account_domains`' exception to ADR-0007, the migration list), `docs/development.md` (§6b's "numbered after the last one" line names `012_display_names.sql`)

**Interfaces:**
- Produces (Tasks 4–13; D6, D8):
  ```ts
  Table.AccountDomains = 'account_domains'; Table.DomainTomls = 'domain_tomls';
  export type TomlReason = '' | 'dns_error' | 'connect_error' | 'tls_error' | 'timeout' | 'http_status' | 'too_large'
    | 'redirect_rejected' | 'blocked_address' | 'domain_invalid' | 'toml_invalid';
  export interface AccountDomainsRow { account: string; ledger_index: number; tx_index: number; node_index: number;
    version: string; domain_hex: string; deleted: number }
  export interface DomainTomlsRow { domain: string; toml_url: string; status: 'ok' | 'failed'; reason: TomlReason; status_code: number;
    checked_at: UnixSecondsMs; fetched_at: UnixSecondsMs | null; next_check_at: UnixSeconds; failures: number;
    modified: UnixSeconds | null; expires: UnixSeconds | null;
    accounts: TomlAccount[]; currencies: TomlCurrency[]; validators: TomlValidator[]; principals: string[] }
  ```

The SQL is spec §1.1 and §1.2 exactly (both `CREATE TABLE IF NOT EXISTS`, columns in that order, `account_domains` `ReplacingMergeTree(version)`, `PARTITION BY intDiv(ledger_index, 10000000)`, `ORDER BY account`, `SETTINGS non_replicated_deduplication_window = 1000, index_granularity = 1024`; `domain_tomls` `ReplacingMergeTree(checked_at)`, `ORDER BY domain`). The header comment states the runner's constraints like `005`: every statement ends with its semicolon on its last line, no other line (comments included) ends with one. Neither table goes into `LEDGER_KEYED_TABLES` here (Task 4 adds `account_domains` with its parser).

- [ ] **Step 1: Check the number, then write the failing tests.** `ls packages/shared/schema`: the highest must be `011_*`; if not, take the next free number for this task's file and the docs. Then `migrate.e2e-spec.ts`: `SHAPES` gains `[Table.AccountDomains]: { engine: 'ReplacingMergeTree', version: 'version', partition: P7, order: 'account' }` and `[Table.DomainTomls]: { engine: 'ReplacingMergeTree', version: 'checked_at', partition: '', order: 'domain' }`; `SAMPLE_ROWS` one typed row each (the round-trip and "exactly the tables of the Table enum" tests then cover them; the `domain_tomls` row has one entry in each tuple array); and
  - `it('keeps account_domains on granules of 1024 with a dedup window of 1000')`: `engine_full` contains `index_granularity = 1024` and `non_replicated_deduplication_window = 1000`.
  - `it('account_domains: a merge keeps the newest row of an account in a partition')`: rows of one account with `version` `'462445970643419141'` (ledger 107671593, tx 3, node 5) and `'462445970643419142'`, `OPTIMIZE TABLE … FINAL`, one row left, the second's `domain_hex`.
  - `it('domain_tomls: a merge keeps the newest check of a domain with its tuples')`: two rows of `northpeak.example`, `checked_at` 1761300000.123 and 1761300060.456, after `OPTIMIZE … FINAL` one row, the second, whose `accounts` reads back as `[{ address, network, desc }]` objects.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate`: the tables and enum entries are missing.
- [ ] **Step 3: Write the migration, the enum entries, the row types, the sample rows and the two docs.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared test` and `test:e2e -- migrate` exit 0.
- [ ] **Step 5: Commit.** `git add packages/shared/schema/012_display_names.sql packages/shared/src/clickhouse/tables.ts packages/shared/src/clickhouse/rows.ts packages/shared/test/sample-rows.ts packages/shared/test/migrate.e2e-spec.ts docs/data-model.md docs/development.md` — `feat(shared): migration 012, account_domains and domain_tomls` (body: the two tables of display names; `account_domains` is ordered by account so merges keep about one row per account, the ADR-0007 exception of decision 7), trailer.

---

### Task 4: `AccountDomainsParser` and the ledger rows (parser version 6)

**Files:**
- Create: `packages/shared/src/parsers/account-domains.parser.ts`, `packages/shared/src/parsers/account-domains.parser.spec.ts`
- Modify: `packages/shared/src/parsers/account-states.parser.ts` (the node walk exported and used by both), `packages/shared/src/ingest/build-rows.ts`, `packages/shared/src/ingest/build-rows.spec.ts`, `packages/shared/src/ingest/__snapshots__/build-rows.spec.ts.snap` (regenerated, Step 4), `packages/shared/src/ingest/ingest-state.ts`, `packages/shared/src/ingest/ingest-state.spec.ts`, `packages/shared/src/clickhouse/rows.ts`, `packages/shared/src/index.ts`; any syncer e2e that lists per-table counts by name (`apps/syncer/test/live-runner.e2e-spec.ts`, `range-ingest.e2e-spec.ts`) if it fails on the new table

**Interfaces:**
- Consumes: Task 3 `AccountDomainsRow`, `Table.AccountDomains`.
- Produces (Tasks 5, 7, 9, 10; D6 reads `account_domains`):
  ```ts
  // account-states.parser.ts
  export interface ChangedAccountRoot { op: 'CreatedNode' | 'ModifiedNode' | 'DeletedNode'; node_index: number; node: Readonly<Record<string, any>> }
  /** The AccountRoot nodes of `meta.AffectedNodes`, in order, without a ModifiedNode that has no PreviousFields (only threaded). */
  export function changedAccountRoots(t: ParserTx): ChangedAccountRoot[];
  // account-domains.parser.ts
  export interface ParsedAccountDomain { account: string; node_index: number; domain_hex: string; deleted: boolean; invalid: boolean }
  export class AccountDomainsParser { parse(t: ParserTx, _ctx: ParseContext): ParsedAccountDomain[] }
  /** ledger_index · 2^32 + tx_index · 2^16 + node_index, as decimal text (BigInt). */
  export function accountDomainVersion(ledgerIndex: number, txIndex: number, nodeIndex: number): string;
  // rows.ts
  export const PARSER_VERSION = 6; export const DOMAIN_PARSER_VERSION = 6;
  // build-rows.ts
  LedgerRows.accountDomains: AccountDomainsRow[];  LedgerDiagnostics.invalidDomains: number;
  // CHILD_TABLES gains [Table.AccountDomains, 'accountDomains'] (last); LEDGER_KEYED_TABLES gains { table: Table.AccountDomains, partitionSize: P7 } (last)
  ```

Rows (spec §3.1), per node of `changedAccountRoots(t)`; the account is `NewFields.Account` (created) or `FinalFields.Account`; "set" means the key is present:

| Node | Row when | `domain_hex` | `deleted` |
| --- | --- | --- | --- |
| `CreatedNode` | `NewFields.Domain` set | `NewFields.Domain` | 0 |
| `ModifiedNode` | `FinalFields.Domain` or `PreviousFields.Domain` set | `FinalFields.Domain`, else `''` | 0 |
| `DeletedNode` | `FinalFields.Domain` or `PreviousFields.Domain` set | `''` | 1 |

A `Domain` that is not a string, or not `/^(?:[0-9A-Fa-f]{2})*$/`, is written as `''` with `invalid: true` (summed into `diagnostics.invalidDomains`; never thrown, Ruling 8). The transaction's result does not matter; no type is special-cased (Xahau's `Import`, `SetHook`, `GenesisMint`, `URIToken*` are read like any other). `rows.ts` history gains: "6: account domains (`account_domains`): the Domain of every account root that has or had one, after each change. Ledgers written with an older version have none; the seed of `docs/backfill.md` fills the current domains of the state history's ledgers." `AccountStatesParser` keeps its behaviour on `changedAccountRoots`.

- [ ] **Step 1: Check the number, then write the failing tests.** `grep -n "export const PARSER_VERSION" packages/shared/src/clickhouse/rows.ts` must say 5; if not, the constant is the next number. `account-domains.parser.spec.ts`, hand-made metadata, the input deep-frozen (`deepFreeze`):
  - AccountSet setting a Domain (`FinalFields.Domain`, `PreviousFields: { Sequence }`) → one row with that hex; changing (both sides) → the final; clearing (`PreviousFields.Domain` only) → `''`; the same Domain again (`FinalFields.Domain`, `PreviousFields: { Sequence, Balance }`) → a row with it.
  - a Payment that creates an account (`CreatedNode` without `Domain`) → no row; a `CreatedNode` with `NewFields.Domain` → a row.
  - an `AccountDelete` of an account with a Domain (`DeletedNode`, `FinalFields.Domain`) → `{ domain_hex: '', deleted: true }`.
  - a Payment received by a dormant account with a Domain (`ModifiedNode`, `PreviousFields: { Balance }`) → its row; a failed transaction (`tecPATH_DRY`) of a sender with a Domain → its row; a threaded `ModifiedNode` (no `PreviousFields`) → none.
  - `it.each(['Import', 'SetHook', 'GenesisMint'])('reads a %s like any transaction')`: a `ModifiedNode` with `FinalFields.Domain` gives its row.
  - `Domain: 42` and `Domain: 'ZZ'` → `''` with `invalid: true`.
  - `expect(accountDomainVersion(107671593, 3, 5)).toBe('462445970643419141')`; `accountDomainVersion(4294967295, 65535, 65535)` is `'18446744073709551615'`.
  `build-rows.spec.ts`: `describe('account_domains')` — a ledger with the setting AccountSet at tx 3, node 5 gives `{ account, ledger_index, tx_index: 3, node_index: 5, version: '462445970643419141', domain_hex, deleted: 0 }`, and `diagnostics.invalidDomains` counts the invalid ones. `ingest-state.spec.ts`: `it('lists account_domains once, partitioned like account_states (P7)')`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- account-domains build-rows ingest-state`.
- [ ] **Step 3: Implement** the walk, the parser, the version constants and history, the `LedgerRows` field, `CHILD_TABLES`, `LEDGER_KEYED_TABLES` (and the counts in their doc comments).
- [ ] **Step 4: Regenerate the snapshot and run everything.** `pnpm --filter @gatehub/data-api-shared test -- build-rows -u`; read the snapshot diff: only `accountDomains` arrays, `invalidDomains: 0` and `parser_version: 6` may change, else stop and fix the code. Then `pnpm --filter @gatehub/data-api-shared build`, `pnpm test`, and the three `test:e2e` suites exit 0 (a syncer e2e that counts rows per table by name gains `account_domains`).
- [ ] **Step 5: Commit.** `git add packages/shared/src/parsers packages/shared/src/ingest packages/shared/src/clickhouse/rows.ts packages/shared/src/index.ts` (and any syncer e2e changed, by name) — `feat(shared): account_domains rows, parser version 6` (body: the current domain of every account is learnt from the ledger; a row for every change of an account that has a domain, so a dormant account is learnt at its next change), trailer.

---

### Task 5: Recorded ledgers of account domains

**Files:**
- Create: `packages/shared/test/fixtures/xrpl/account-domains/` and `packages/shared/test/fixtures/xahau/account-domains/` (`<index>.json.gz`, `manifest.json` with a hand-written `cases` object, `server_definitions.json`, `server_info.json`, as `record-fixtures.ts` writes them), `packages/shared/test/account-domains.e2e-spec.ts`
- Modify: `packages/shared/test/fixtures/README.md` (the two directories in the table; a section "Account domains": endpoint, date, the cases, and which were not found)

**Interfaces:**
- Consumes: Task 4 (`buildLedgerRows`, `accountDomains`), `FixtureLedgerSource.fromDir`, `LedgerWriter`, `startClickHouse`, `runMigrations`.
- Produces: the recorded cases, read by name from the manifests' `cases`.

The cases (`cases` keys exactly these):

| Case | Network | What the transaction is |
| --- | --- | --- |
| `accountset_sets_domain` | xrpl, xahau | an `AccountSet` whose sender's `ModifiedNode` has `FinalFields.Domain` and `PreviousFields` without `Domain` |
| `accountset_changes_domain` | xrpl | `FinalFields.Domain` and a different `PreviousFields.Domain` |
| `accountset_clears_domain` | xrpl | `PreviousFields.Domain` and no `FinalFields.Domain` |
| `account_delete_with_domain` | xrpl | an `AccountDelete` whose `DeletedNode` has `FinalFields.Domain` |
| `failed_tx_with_domain` | xrpl | a `tec*` transaction whose sender has `FinalFields.Domain` |
| `import` | xahau | an `Import` (`--want Import --scan 3000`) |

Already recorded, read in place (no copy): xrpl `recorded/107671317.json.gz`, tx `B244AF0904E22964D1AF89FD213AA8502ADF65FEED95185C6B62961DB9DC2571` (a Payment to `rf82s1CDagppvM6ATqc1nSrL6GackzHJrm`, Domain `test.com`); xahau `recorded/26540187.json.gz`, tx `00F5098EB67BB5E4E177D02F5B492DD5BF215DFF1677EFBD8542394387EBC866` (a Payment to `rGsbGtyrXoPSocAWcngrQZqm6AaQmocw5B`, Domain `n1737.bisdaknode1701-1750.ovh`).

- [ ] **Step 1: Find the transactions.** A throw-away script in the session's scratchpad (never committed) walks back from the validated head of `wss://s2.ripple.com` (XRPL) and `wss://xahau.network` (Xahau), one expanded `ledger` at a time with a 75 ms pause, at most 5,000 ledgers each, and prints the first hash that matches each case's predicate above. Network unreachable: stop and report BLOCKED. A case not found within 5,000 ledgers is not recorded: its hand-made unit case of Task 4 stays its only test, and the README section says so.
- [ ] **Step 2: Record them.** `pnpm --filter @gatehub/data-api-shared record:fixtures -- --network xrpl --endpoint wss://s2.ripple.com --out test/fixtures/xrpl/account-domains --txs <hashes>` (and the Xahau one); then write `cases` (`{ ledger, hash, type, note }`, the note naming the account and the Domain before → after) into each `manifest.json` by hand.
- [ ] **Step 3: Write the e2e test** (`account-domains.e2e-spec.ts`, real ClickHouse): build and write (through `LedgerWriter`) the ledgers of both new directories and the two already recorded; for each case, the account's newest row (`argMax(domain_hex, version)`, `argMax(deleted, version)`) is what the table above says (set/change: the final hex; clear: `''`; delete: `deleted = 1`; failed and payment: the hex; `import`: rows only for AccountRoots with a Domain); `deleteLedgerRange` of the newest case ledger and a rewrite give the same rows (`it('comes back the same after a ledger is deleted and written again')`).
- [ ] **Step 4: Run it.** `pnpm --filter @gatehub/data-api-shared test:e2e -- account-domains` exits 0.
- [ ] **Step 5: Commit.** `git add packages/shared/test/fixtures/xrpl/account-domains packages/shared/test/fixtures/xahau/account-domains packages/shared/test/fixtures/README.md packages/shared/test/account-domains.e2e-spec.ts` — `test: recorded ledgers of Domain changes on XRPL and Xahau` (body: the parser's rows are checked against what the networks wrote, not only hand-made metadata), trailer.

---

### Task 6: The toml store's rows

**Files:**
- Create: `packages/shared/src/tomls/toml-store.ts`, `packages/shared/src/tomls/toml-store.spec.ts`, `packages/shared/test/toml-store.e2e-spec.ts`, `apps/syncer/src/tomls/toml-row.ts`, `apps/syncer/src/tomls/toml-row.spec.ts`
- Modify: `packages/shared/src/tomls/index.ts`

**Interfaces:**
- Consumes: Task 2 `readToml`, `TomlContent`, `EMPTY_TOML_CONTENT`, `TomlInvalidError`; Task 3 `DomainTomlsRow`, `Table.DomainTomls`; D1 `isTransientReason`, `DOMAIN_VERIFIED_GRACE_S`, `FetchFailure`.
- Produces (Tasks 8, 10, 13; D6 reads `readStoredTomls`, D8 calls `recordToml`, `readStoredTomls`, `nextTomlRow`):
  ```ts
  // packages/shared/src/tomls/toml-store.ts
  export function tomlUrlOf(domain: string, profile: Pick<NetworkProfile, 'tomlPath'>): string;   // `https://${domain}${tomlPath}`
  export function okTomlRow(o: { domain: string; tomlUrl: string; content: TomlContent; now: UnixSecondsMs; recheckMs: number }): DomainTomlsRow;
  /** The `ok` row of a file in hand, read and inserted; throws TomlInvalidError and writes nothing for a text that is not TOML. */
  export function recordToml(ch: Pick<ClickHouseService, 'insert'>, o: { domain: string; tomlUrl: string; text: string;
    fetchedAt: UnixSecondsMs; recheckMs: number; profile: Pick<NetworkProfile, 'name'> }): Promise<DomainTomlsRow>;
  export const STORED_TOMLS_SQL: string;
  /** The newest row of each of `domains` that has one, by key; no query for an empty list. */
  export function readStoredTomls(ch: Pick<ClickHouseService, 'query'>, domains: readonly string[]): Promise<Map<string, DomainTomlsRow>>;
  // apps/syncer/src/tomls/toml-row.ts
  export const TOML_TRANSIENT_RECHECK_S = 3_600;
  export const TOML_BACKOFF_MAX_S = 604_800;
  export type TomlFailure = FetchFailure | 'toml_invalid';
  export type TomlCheck = { domain: string; tomlUrl: string } & ({ content: TomlContent } | { reason: TomlFailure; statusCode?: number });
  export function nextTomlRow(prev: DomainTomlsRow | undefined, check: TomlCheck, now: UnixSecondsMs, recheckMs: number): DomainTomlsRow;
  ```

Rules (spec §4.4; `next_check_at` is a whole second, `Math.ceil(now + seconds)`; `domain` lower-cased in every row):
- `okTomlRow`: `status 'ok'`, `reason ''`, `status_code 0`, `checked_at` and `fetched_at` `now`, `failures 0`, `next_check_at` now + `recheckMs / 1000`, the content. `nextTomlRow` with `content` is exactly `okTomlRow` (Ruling 2).
- A failure: `status 'failed'`, the reason, `status_code` the HTTP status for `http_status` else 0, `failures` `(prev?.failures ?? 0) + 1`, `checked_at` now.
  - transient (`isTransientReason(reason, statusCode)`): `next_check_at` now + 3,600; the content and `fetched_at` of `prev` when `prev.fetched_at !== null && now − prev.fetched_at <= DOMAIN_VERIFIED_GRACE_S`, else `EMPTY_TOML_CONTENT` and `fetched_at null`.
  - definite (anything else, `toml_invalid` included): empty content, `fetched_at null`, `next_check_at` now + `min(86_400 × 2^(failures − 1), TOML_BACKOFF_MAX_S)`.
- `STORED_TOMLS_SQL`: `SELECT domain, toml_url, status, reason, status_code, toUnixTimestamp64Milli(checked_at) AS checked_ms, toUnixTimestamp64Milli(fetched_at) AS fetched_ms, toUnixTimestamp(next_check_at) AS next_check, failures, toUnixTimestamp(modified) AS modified_s, toUnixTimestamp(expires) AS expires_s, accounts, currencies, validators, principals FROM ${Table.DomainTomls} WHERE domain IN {domains:Array(String)} ORDER BY domain, checked_at DESC LIMIT 1 BY domain`; numbers read back with `Number()`, milliseconds divided by 1000, `NULL` kept as `null`.

- [ ] **Step 1: Write the failing tests.** `toml-row.spec.ts` (now = 1_761_300_000.5, recheck 86_400_000): ok → content, `fetched_at` now, failures 0, next `1_761_386_401`; `it.each(['dns_error', 'connect_error', 'tls_error', 'timeout', ['http_status', 503], ['http_status', 429]])`: `it('carries the content through a transient failure within 24 h of fetched_at')` (prev ok with `fetched_at` now − 86_400 → content kept, `fetched_at` prev's, status `failed`, failures prev + 1, next now + 3,600) and `it('drops it a second later')` (now − 86_401 → empty, `null`); definite `['http_status', 404]`, `toml_invalid`, `too_large`, `redirect_rejected`, `blocked_address`, `domain_invalid` → empty, `null`, `status_code` 404 only for the first; `it('backs off 1, 2, 4, then 7 days')`: failures 1..5 → next − now ceil'd = 86_400, 172_800, 345_600, 604_800, 604_800; no prev → failures 1. `toml-store.spec.ts`: `tomlUrlOf('northpeak.example', xahau)` is `https://northpeak.example/.well-known/xahau.toml`; `okTomlRow` fields. `toml-store.e2e-spec.ts` (real ClickHouse): `recordToml` of a valid text writes one row that `readStoredTomls` gives back equal (domain `NorthPeak.Example` stored lower-case); a text that is not TOML rejects with `TomlInvalidError` and the table stays empty; of two rows of a domain the newer is returned; a domain without rows is absent from the map; `readStoredTomls(ch, [])` makes no query.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- toml-store` and `pnpm --filter @gatehub/data-syncer test -- toml-row`.
- [ ] **Step 3: Implement both files.**
- [ ] **Step 4: Run the tests to verify they pass.** Shared build, `pnpm test`, `pnpm --filter @gatehub/data-api-shared test:e2e -- toml-store` exit 0.
- [ ] **Step 5: Commit.** `git add packages/shared/src/tomls packages/shared/test/toml-store.e2e-spec.ts apps/syncer/src/tomls/toml-row.ts apps/syncer/src/tomls/toml-row.spec.ts` — `feat(shared): the toml store's rows: okTomlRow, recordToml, readStoredTomls and nextTomlRow` (body: one rule for the row of a check, which the tomls worker and D8's validators checker both write), trailer.

---

### Task 7: Domain discovery, the worker's options and metrics

**Files:**
- Create: `apps/syncer/src/tomls/domain-discovery.ts`, `apps/syncer/src/tomls/domain-discovery.spec.ts`, `apps/syncer/src/tomls/tomls.options.ts`
- Modify: `apps/syncer/src/modules/prometheus/prometheus.service.ts` (four metrics), `apps/syncer/src/modules/prometheus/prometheus.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 `accountDomainOf`; Task 3 `Table.AccountDomains`.
- Produces (Tasks 8, 9):
  ```ts
  // tomls.options.ts
  export const TOMLS_WORKER_OPTIONS = Symbol('TOMLS_WORKER_OPTIONS');
  export const TOMLS_SAFE_FETCHER = Symbol('TOMLS_SAFE_FETCHER');
  export interface TomlsWorkerOptions { now?: () => number; logger?: Pick<Logger, 'log' | 'warn' | 'error'>; fetch?: SafeFetchTestOptions;
    start?: { discovery?: boolean; checks?: boolean } }
  // domain-discovery.ts
  export const TOML_DISCOVERY_INTERVAL_MS = 300_000;
  export const DISCOVERY_SQL: string;   // spec §4.1 exactly, with ${Table.AccountDomains}
  export function domainsOf(rows: readonly { domain_hex: string; accounts: number | string }[]): { domains: Map<string, number>; dropped: number };
  /** The domains of `next` named by more accounts than in `previous`; none when there is no previous map (Ruling 5). */
  export function grownDomains(previous: ReadonlyMap<string, number> | undefined, next: ReadonlyMap<string, number>): string[];
  @Injectable() export class DomainDiscovery {
    discover(): Promise<void>;                       // one read; replaces `current`; adds grown domains to the named-anew set; sets the gauge
    readonly current: ReadonlyMap<string, number>;   // empty before the first discovery
    readonly ready: Promise<void>;                   // settles after the first discover() call, whatever it came to
    namedAnew(domain: string): boolean;
    checked(domain: string): void;                   // a checked domain is no longer named anew
  }
  // PrometheusService gains
  tomlsChecksTotal (Counter 'syncer_tomls_checks_total', ['outcome']); tomlsDomains (Gauge 'syncer_tomls_domains', ['status']);
  tomlsDue (Gauge 'syncer_tomls_due'); tomlsDiscoverySeconds (Gauge 'syncer_tomls_discovery_seconds')
  ```

`DomainDiscovery` injects `ClickHouseService` (`query`), `PrometheusService` (`tomlsDiscoverySeconds`) and the optional `TOMLS_WORKER_OPTIONS` (`now`, `logger`). A failed read rejects and leaves `current` as it was. The number of dropped hex values is logged once per discovery when above 0 (a count, no values).

- [ ] **Step 1: Write the failing tests** (`domain-discovery.spec.ts`, fake ClickHouse): `it('drops what names no domain and adds up the spellings of one domain')` — rows `{ hex('Example.com'), 2 }`, `{ hex('example.com'), 3 }`, `{ hex('https://x.com'), 4 }` → `{ 'example.com' => 5 }`, dropped 1; `grownDomains(undefined, m)` is `[]`; `grownDomains(new Map([['a.example', 2]]), new Map([['a.example', 3], ['b.example', 1], ['c.example', 1]]))` sorts to `['a.example', 'b.example', 'c.example']`, a count that fell or stayed is not there; `discover()` twice: the second marks the grown domain, `checked(d)` clears it; the read's statement is `DISCOVERY_SQL`; the gauge holds the read's seconds (fake clock); a failed read rejects and keeps `current`. `prometheus.service.spec.ts`: the four names are registered.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- domain-discovery prometheus`.
- [ ] **Step 3: Implement** the options, the discovery and the metrics.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` exits 0.
- [ ] **Step 5: Commit.** `git add apps/syncer/src/tomls/domain-discovery.ts apps/syncer/src/tomls/domain-discovery.spec.ts apps/syncer/src/tomls/tomls.options.ts apps/syncer/src/modules/prometheus` — `feat(syncer): discovery of the domains accounts name` (body: one read of account_domains every 5 minutes; a domain more accounts name is checked again soon), trailer.

---

### Task 8: The toml checker

**Files:**
- Create: `apps/syncer/src/tomls/toml-checker.ts`, `apps/syncer/src/tomls/toml-checker.spec.ts`
- Modify: `apps/syncer/src/config/syncer.config.ts` (`tomlRecheckMs`), `apps/syncer/src/config/syncer.config.spec.ts`

**Interfaces:**
- Consumes: Task 2 `readToml`, `TomlInvalidError`; Task 6 `readStoredTomls`, `nextTomlRow`, `tomlUrlOf`; Task 7 `DomainDiscovery`, the metrics, `TOMLS_WORKER_OPTIONS`, `TOMLS_SAFE_FETCHER`; D1 `SafeFetcher.get`, `SafeFetchError`, `tomlFetchLimits`.
- Produces (Task 9):
  ```ts
  // SyncerConfig gains: `GH_TOML_RECHECK_MS`: when a toml read OK is read again (ms). @ConfigValue() @IntValue({ min: 1 })
  tomlRecheckMs: number = 86_400_000;
  // toml-checker.ts
  export const TOML_PASS_LIMIT = 300; export const TOML_FETCH_CONCURRENCY = 16; export const TOML_WRITE_BATCH = 50;
  export const TOML_NAMED_ANEW_AFTER_S = 3_600;
  export const TOML_SCHEDULE_SQL: string;
  export interface TomlSchedule { nextCheckAt: UnixSeconds; checkedAt: UnixSecondsMs; failures: number }
  export function dueDomains(o: { discovered: ReadonlyMap<string, number>; schedule: ReadonlyMap<string, TomlSchedule>;
    namedAnew: (domain: string) => boolean; now: UnixSecondsMs; limit?: number }): string[];
  @Injectable() export class TomlChecker { pass(): Promise<number>; stop(): Promise<void> }   // pass resolves with the checks written
  ```

The pass (spec §4.2):
1. `TOML_SCHEDULE_SQL`: `SELECT domain, toUnixTimestamp(argMax(next_check_at, checked_at)) AS next_check, toUnixTimestamp64Milli(max(checked_at)) AS checked_ms, argMax(failures, checked_at) AS fails FROM ${Table.DomainTomls} GROUP BY domain`.
2. `dueDomains`, over the discovered domains only (Ruling 6): due when it has no schedule, or `namedAnew(d)` and `now − checkedAt > 3,600`, or `nextCheckAt <= now`. Order: no schedule first, then named anew, then the oldest `nextCheckAt`, then the domain; the first `limit` (300).
3. `readStoredTomls(ch, due)` for `prev`; at most 16 fetches in flight, one per domain, `fetcher.get(tomlUrlOf(d, profile), tomlFetchLimits(cfg.domainFetchTimeoutMs), 'application/toml, text/plain, */*')`; a body is `readToml(body.toString('utf8'), profile, now)` (a `TomlInvalidError` is `toml_invalid`); a `SafeFetchError` is its `reason` and `statusCode`; any other throw is `connect_error` (counted by error name, one warn line per pass, as D1 does). The row is `nextTomlRow(prev, check, now, cfg.tomlRecheckMs)`; `discovery.checked(d)`.
4. Rows are buffered and inserted in batches of 50 and at the end. `stop()` starts nothing more, waits for the fetches under way and writes what is done.
- Metrics: `tomlsChecksTotal.inc({ outcome })` per check (`ok` or the reason); after the pass `tomlsDomains` `{status: 'ok'|'failed'|'unchecked'}` over the discovered domains (schedule `failures === 0` is ok, Ruling 4, updated by the rows written) and `tomlsDue` = due − checked.
- Logs: one `log` line per pass `Tomls: <n> checked (<ok> ok, <failed> failed), <due> still due`; blocked fetches one `warn` per pass `Tomls: <n> fetches blocked (blocked_address): <at most five quoted domains>`. Never a body, an error object, a principal or a desc.

- [ ] **Step 1: Write the failing tests** (`toml-checker.spec.ts`, fake fetcher and store as D1's `domain-checker.spec.ts`; `syncer.config.spec.ts`: the default `86400000`, `0` refused): due order (never checked, named anew, oldest next, domain); `it('checks a named-anew domain at most hourly')` (checked 3,599 s ago: not due; 3,601: due); 450 discovered never checked → 300 fetched; `it('has at most 16 fetches in flight')` (40 fetches that resolve on demand: the most open at once is 16); one fetch per domain; `it('writes in batches of 50 and at the end')` (120 checks → inserts of 50, 50, 20); `stop()` during a pass: no fetch starts after it, the ones under way are written; a body that is not TOML → `toml_invalid`; a stored domain that is not discovered is never fetched; the metrics after a pass; `it('logs no body, principal or email')` (a file with `[[PRINCIPALS]] name = "Mara" email = "mara@northpeak.example"` and a 503 body `secret-body`: no logged line contains `mara`, `secret-body` or `@`); the blocked warn names five domains of seven.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- toml-checker syncer.config`.
- [ ] **Step 3: Implement** the config property and the checker (injecting `SyncerConfig`, `NETWORK_PROFILE`, `ClickHouseService`, `PrometheusService`, `TOMLS_SAFE_FETCHER`, `DomainDiscovery`, optional `TOMLS_WORKER_OPTIONS`).
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` exits 0.
- [ ] **Step 5: Commit.** `git add apps/syncer/src/tomls/toml-checker.ts apps/syncer/src/tomls/toml-checker.spec.ts apps/syncer/src/config/syncer.config.ts apps/syncer/src/config/syncer.config.spec.ts` — `feat(syncer): the toml checker and GH_TOML_RECHECK_MS` (body: at most 300 due domains a pass, 16 at a time, written in batches so a minute's checks make few parts), trailer.

---

### Task 9: The `tomls` worker

**Files:**
- Create: `apps/syncer/src/tomls/tomls-worker.ts`, `apps/syncer/src/tomls/tomls-worker.spec.ts`, `apps/syncer/src/tomls/tomls.module.ts`, `apps/syncer/src/tomls/tomls.module.spec.ts`, `apps/syncer/src/core/pass-loop.ts` (D1's `PassLoop` and `Loop`, moved and exported), `packages/shared/src/tomls/account-domains-seed.ts`, `apps/syncer/test/support/tomls-env.ts`, `apps/syncer/test/tomls-worker.e2e-spec.ts`
- Modify: `apps/syncer/test/support/tls.ts` and `apps/syncer/test/support/tls/example.crt`, `tls/example.key` (the SAN gains `DNS:ok.example,DNS:missing.example,DNS:down.example,DNS:slow.example,DNS:bad.example,DNS:big.example,DNS:moved.example`, by the command in `tls.ts`'s comment, run again: a host not in the SAN fails with `tls_error`), `apps/syncer/src/validators/validators-worker.ts` (imports `PassLoop`), `apps/syncer/src/validators/safe-fetch.ts` (`tomlsUserAgent`), `apps/syncer/src/config/syncer.config.ts` (`WORKER_NAMES` gains `'tomls'` last; the `GH_WORKERS` doc), `apps/syncer/src/worker-registry.ts` (`tomls: TomlsModule`), `apps/syncer/src/worker-registry.spec.ts`, `packages/shared/src/tomls/index.ts`, `docker-compose.prod.yaml` (`GH_TOML_RECHECK_MS:` in `x-syncer-env`), `deploy/.env.prod.example` (`GH_WORKERS` with `tomls`, `GH_TOML_RECHECK_MS=86400000` and its comment), `docs/configuration.md` (`GH_WORKERS` default and "six workers", `GH_TOML_RECHECK_MS`, `GH_DOMAIN_VERIFICATION` and `GH_DOMAIN_FETCH_TIMEOUT_MS` now also the tomls worker's)

**Interfaces:**
- Consumes: Tasks 6–8; D1 `SafeFetcher`.
- Produces (Task 14 docs; operators):
  ```ts
  export const TOMLS_PASS_INTERVAL_MS = 60_000; export const TOMLS_STOP_WAIT_MS = 2_000;
  @Injectable() export class TomlsWorker implements OnApplicationBootstrap, OnModuleDestroy { stop(): Promise<void> }
  @Module({ providers: [{ provide: TOMLS_SAFE_FETCHER, useFactory: (o?) => new SafeFetcher(tomlsUserAgent(), o?.fetch) }, DomainDiscovery, TomlChecker, TomlsWorker] })
  export class TomlsModule {}
  export function tomlsUserAgent(): string;   // `gatehub-data-api/<version of apps/syncer/package.json> (tomls)`
  // core/pass-loop.ts
  export interface Loop { stop(): Promise<void> }
  export class PassLoop implements Loop { constructor(name, pass, end, everyMs, logger); start(): void; stop(): Promise<void> }
  // packages/shared/src/tomls/account-domains-seed.ts
  export const ACCOUNT_DOMAINS_SEED_BUCKETS = 16;
  export const ACCOUNT_DOMAINS_SEED_SQL: string;   // spec §10's statement exactly, `{X:UInt32}` and `{bucket:UInt8}`
  ```

`TomlsWorker` (spec §4, §2): with `GH_DOMAIN_VERIFICATION=false` it logs once `Toml checks are off (GH_DOMAIN_VERIFICATION=false): no toml is read` and starts nothing. Otherwise, per `options.start`: a discovery `PassLoop` every `TOML_DISCOVERY_INTERVAL_MS`, and a check `PassLoop` every 60 s whose pass first awaits `discovery.ready`. It registers with `ShutdownSignals` as `tomls`; `stop()` stops both and waits at most `TOMLS_STOP_WAIT_MS`. `NODE_CLIENT_WORKERS` does not change. `validatorsUserAgent` and `tomlsUserAgent` share one helper of `safe-fetch.ts`.

- [ ] **Step 1: Write the failing tests.** Unit: `worker-registry.spec.ts` (`tomls` is registered, last; the default `GH_WORKERS` is `ingest,validations,fee_stats,aggregator,validators,tomls`; a syncer of only `tomls` makes no node client); `tomls-worker.spec.ts` (verification off: one log line, no pass; on: discovery before the first check pass; stop ends both loops); `tomls.module.spec.ts` (the module builds with the core stub; its fetcher's user agent ends ` (tomls)`). E2e `tomls-worker.e2e-spec.ts` with `startTestWeb` (its `fetchOptions()` through `TOMLS_WORKER_OPTIONS.fetch`), `startMigratedClickHouse`, a fake clock, `GH_DOMAIN_FETCH_TIMEOUT_MS=500`, and `account_domains` rows naming `ok.example` (a TOML listing an account), `missing.example` (404), `down.example` (503), `slow.example` (no answer), `bad.example` (`a = `), `big.example` (300 KiB), `moved.example` (a 302 to `http://moved.example/`):
  - one pass writes one row per domain: `ok` with its accounts; `failed` `http_status` 404; `failed` `http_status` 503; `timeout`; `toml_invalid`; `too_large`; `redirect_rejected`;
  - with `GH_TOML_RECHECK_MS=3600000` for the suite: `ok.example` is not fetched again at +59 min and is at +1 h 1 s;
  - `it('keeps a verified name through a 503 within the grace, and loses it after')`: read OK at T0; from then on it answers 503; the pass at T0 + 1 h 1 s writes `failed` with the content and `fetched_at` T0; the pass at T0 + 24 h 1 s writes `failed` with no content and `fetched_at` NULL;
  - named anew: two more `account_domains` rows naming `ok.example`, the next discovery and pass (clock + 1 h 1 s) check it although its `next_check_at` is a day away;
  - the seed: `account_states` rows of three accounts at ledgers ≤ X (one whose `fields` JSON has `Domain` = hex of `seed.example`, one deleted with a Domain, one with `Domain` `''`) and `ledgers` rows with `parser_version` 5 up to X; `ACCOUNT_DOMAINS_SEED_SQL` for buckets 0..15; discovery finds exactly `{ 'seed.example' => 1 }`; running the seed twice changes nothing discovery sees.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- worker-registry tomls` and `test:e2e -- tomls-worker`.
- [ ] **Step 3: Implement** the move of `PassLoop`, the user agent, the worker, the module, the registry and config lines, the seed constant, the e2e support (`startTomlsApp`, modelled on `startValidatorsApp`, workers `['tomls']`), and the compose, env and configuration lines.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-syncer test:e2e` exit 0 (the validators suites too: `PassLoop` moved).
- [ ] **Step 5: Commit.** `git add apps/syncer/src/tomls apps/syncer/src/core/pass-loop.ts apps/syncer/test/support/tls.ts apps/syncer/test/support/tls/example.crt apps/syncer/test/support/tls/example.key apps/syncer/src/validators/validators-worker.ts apps/syncer/src/validators/safe-fetch.ts apps/syncer/src/config/syncer.config.ts apps/syncer/src/worker-registry.ts apps/syncer/src/worker-registry.spec.ts apps/syncer/test/support/tomls-env.ts apps/syncer/test/tomls-worker.e2e-spec.ts packages/shared/src/tomls docker-compose.prod.yaml deploy/.env.prod.example docs/configuration.md` — `feat(syncer): the tomls worker, the sixth worker` (body: it reads the toml of every domain accounts name through a safe fetcher of its own; GH_DOMAIN_VERIFICATION=false idles it), trailer.

---

### Task 10: `NamesModule`, account domains and the toml directory

**Files:**
- Create: `apps/api/src/names/names.module.ts`, `apps/api/src/names/account-domains.service.ts`, `apps/api/src/names/account-domains.service.spec.ts`, `apps/api/src/names/domain-tomls.service.ts`, `apps/api/src/names/domain-tomls.service.spec.ts`
- Move (`git mv`): `apps/api/src/accounts/{names-and-labels.service,account-names,account-network-names,account-labels}.ts` to `apps/api/src/names/`; fix every import (`grep -rn "names-and-labels.service\|account-labels\|account-names'\|account-network-names" apps`)
- Modify: `apps/api/src/accounts/accounts.module.ts` (imports `NamesModule`; `NamesAndLabelsService` leaves its providers), `apps/api/src/accounts/accounts.controller.ts` (imports), `apps/api/src/app.module.ts` (`NamesModule` in `ENDPOINT_MODULES`, after `ExportsModule`, before `NotFoundModule`)

**Interfaces:**
- Consumes: Task 1 `accountDomainOf`, `countsOn`; Task 3 `Table.AccountDomains`, `DomainTomlsRow`; Task 6 `readStoredTomls`; `CacheService`; `ApiConfig.namesAndLabelsReloadMs`; `NETWORK_PROFILE`.
- Produces (Tasks 11–13; D6, D8: `ValidatorsModule` imports `NamesModule` for `DomainTomlsService`):
  ```ts
  // account-domains.service.ts
  export const ACCOUNT_DOMAINS_SQL: string;   // SELECT account, argMax(domain_hex, version) AS top_hex, argMax(deleted, version) AS gone
                                              //   FROM account_domains WHERE account IN {addresses:Array(String)} GROUP BY account
  export const ACCOUNT_DOMAIN_TTL_MS = 60_000;
  @Injectable() export class AccountDomainsService {
    /** The account domain of each distinct address (accountDomainOf of the newest row; undefined for none, deleted or not a domain). Rejects when the read fails. */
    current(addresses: readonly string[]): Promise<Map<string, string | undefined>>;
  }
  // domain-tomls.service.ts
  export const TOML_DIRECTORY_SQL: string;    // SELECT domain, accounts FROM (SELECT domain, accounts FROM domain_tomls
                                              //   ORDER BY domain, checked_at DESC LIMIT 1 BY domain) WHERE notEmpty(accounts)
  export const DOMAIN_TOML_TTL_MS = 60_000;
  @Injectable() export class DomainTomlsService implements OnModuleInit, OnModuleDestroy {
    readonly loaded: boolean;                                       // false until the first directory load succeeded
    listed(domain: string): ReadonlyMap<string, string> | undefined; // address → desc of the entries that count here, the first per address
    get(domain: string): Promise<DomainTomlsRow | undefined>;       // the newest row (readStoredTomls), kept 60 s per domain, a miss too
  }
  @Module({ providers: [NamesAndLabelsService, AccountDomainsService, DomainTomlsService], exports: [same] }) export class NamesModule {}
  ```

`AccountDomainsService` keeps each address's answer 60 s in `CacheService` under `account-domain:<address>` (no domain cached as `''`) and reads only the misses, in one statement. `DomainTomlsService` loads the directory at init and every `namesAndLabelsReloadMs`; a failed load is a `warn` (`Could not load the toml directory, keeping the last one: <message>`) and keeps the last one; the boot never fails on it. `NamesAndLabelsService` keeps its one instance and timer (the module is a singleton, imported by `AccountsModule` and listed in `ENDPOINT_MODULES`).

- [ ] **Step 1: Write the failing tests** (fake ClickHouse and a real `CacheService`): `current` — a newest row with a domain hex → the domain; `deleted` → `undefined`; `''` → `undefined`; `https://…` → `undefined`; an address with no row → `undefined`; a second call within 60 s reads nothing for the cached addresses and only the misses after; a repeated address is read once; a failed read rejects. `DomainTomlsService` — before init `loaded` is false and `listed` undefined; a first load that fails leaves `loaded` false, warns, and does not reject `onModuleInit`; after a load, `listed('northpeak.example')` holds only entries whose `network` counts (`''`, `main`; not `testnet`), the first `desc` of a repeated address; a later failed reload keeps the directory and warns once; `get` reads once per 60 s and caches a miss.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- names`.
- [ ] **Step 3: Move the files, implement the services and the module, wire the two modules.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` and `test:e2e -- account-names account-labels account-network-names accounts` exit 0 (the moved names still answer on `/v2/accounts/{address}`).
- [ ] **Step 5: Commit.** `git add apps/api/src/names apps/api/src/accounts apps/api/src/app.module.ts` — `feat(api): NamesModule, the account domain read and the toml directory` (body: the names and labels move to the module that answers names; the directory holds what each toml says of its accounts, reloaded every 60 s), trailer.

---

### Task 11: `displayNameOf` and `DisplayNamesService`

**Files:**
- Create: `apps/api/src/names/display-name.ts`, `apps/api/src/names/display-name.spec.ts`, `apps/api/src/names/display-names.service.ts`, `apps/api/src/names/display-names.service.spec.ts`
- Modify: `apps/api/src/names/names.module.ts` (provides and exports `DisplayNamesService`)

**Interfaces:**
- Consumes: Task 10 services; `NamesAndLabelsService.of(address)` (`account_name`, `account_network_name`, `account_labels`).
- Produces (Task 12; D6 calls `DisplayNamesService.of([issuer])`):
  ```ts
  export type DisplayNameKind = 'verified' | 'account' | 'domain';
  export interface DisplayName { text: string; kind: DisplayNameKind }
  export const VERIFIED_DESC_MAX = 64;
  export interface DisplayNameInput { address: string; domain?: string; listed?: ReadonlyMap<string, string>; directoryLoaded: boolean;
    accountName?: string; accountNetworkName?: string }
  export function displayNameOf(i: DisplayNameInput): DisplayName | undefined;
  export interface AccountNameData { address: string; display_name?: DisplayName; domain?: string; account_name?: string;
    account_network_name?: string; labels?: AccountLabels }
  @Injectable() export class DisplayNamesService { of(addresses: readonly string[]): Promise<AccountNameData[]> }  // request order, a repeat at each place
  ```

The rule (spec §5.1): `verified` when `domain` is set and `listed?.has(address)`, text the listed `desc` when it is 1 to 64 code points, else the domain; else `account` with the account name, else with the account network name (decision 5); else `domain` when `domain` is set and `directoryLoaded`; else none. `of` makes one `current()` call for the distinct addresses, reads `loaded` and `listed(domain)`, and `NamesAndLabelsService.of` per address; `labels` is that service's `account_labels` object as it is (keyed scam, spam, advisory).

- [ ] **Step 1: Write the failing tests.** `display-name.spec.ts`: listed with desc `Northpeak Treasury` → `{ text: 'Northpeak Treasury', kind: 'verified' }`; desc of 64 → it; of 65 → the domain; desc `''` → the domain; listed but an account name too → still verified; not listed with an account name → `account`; only a network name → `{ text: 'hot wallet', kind: 'account' }`; not listed, no names, loaded → `{ text: domain, kind: 'domain' }`; `it('gives no domain kind before the directory has loaded')` → `undefined`; no domain, no names → `undefined`. `display-names.service.spec.ts` (fakes): `of(['rA', 'rB', 'rA'])` returns three entries in that order with one `current` call for `['rA', 'rB']`; `domain` present whatever the kind; labels passed through; a rejecting `current` rejects; `it('serves names and labels but no verified or domain kind while the directory has not loaded')` (`loaded` false: the listed account gets its account name, the domain-only account no `display_name`, both keep `domain` and labels).
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- display-name`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` exits 0.
- [ ] **Step 5: Commit.** `git add apps/api/src/names` — `feat(api): the display name rule` (body: verified name, else account name or network name, else unverified domain; a domain is never a name before the api has read the store), trailer.

---

### Task 12: `GET /v2/account_names`

**Files:**
- Create: `apps/api/src/names/account-names.controller.ts`, `apps/api/src/names/account-names.controller.spec.ts`, `apps/api/src/names/account-names-object.ts`, `apps/api/src/names/account-names-object.spec.ts`, `apps/api/test/display-names.e2e-spec.ts`
- Modify: `apps/api/src/names/names.module.ts` (the controller)

**Interfaces:**
- Consumes: Task 11 `DisplayNamesService`, `AccountNameData`; `first`, `badRequest`, `RippleController`, `RippleRoute`.
- Produces (Task 14 reference; E9 reads the answer):
  ```ts
  export const MAX_ADDRESSES = 100;
  export function parseAddresses(query: Query): string[];   // throws the three 400s, in the order of spec §5.2
  export const ACCOUNT_NAMES_BODY_KEYS = ['result', 'count', 'account_names'];
  export const ACCOUNT_NAME_ENTRY_KEYS = ['address', 'display_name', 'domain', 'account_name', 'account_network_name', 'labels'];
  export const DISPLAY_NAME_KEYS = ['text', 'kind'];
  export const LABEL_KEYS = ['description', 'source', 'url'];
  export function accountNameObject(data: AccountNameData): Record<string, unknown>;   // keys in order, absent ones left out
  @RippleController('v2/account_names') export class AccountNamesController   // @Get() @RippleRoute('unable to retrieve account names')
  ```

`parseAddresses`: `first(query, 'addresses')` undefined or `''` → `addresses is required`; split on `,` (no trimming); more than 100 → `too many addresses - at most 100`; any element that `isValidClassicAddress` refuses (an empty one, an X-address, a bad checksum) → `invalid ripple address`. The answer is `{ result: 'success', count, account_names }`.

- [ ] **Step 1: Write the failing tests.** Unit: `parseAddresses` messages in order (missing, `''`, 101 valid → too many, `rA,,rB` → invalid, an X-address → invalid, `addresses[]=` arrays read their first); `accountNameObject` key orders, absent keys left out, labels in scam, spam, advisory order with `description, source?, url?`. E2e `display-names.e2e-spec.ts` (harness, `GH_NAMES_AND_LABELS_RELOAD_MS=100`): seed `account_domains`, `domain_tomls` (via `recordToml`), `account_names`, `account_network_names`, `account_labels` so that the four accounts of spec §5.2 answer exactly its example (verified with `domain`; named with network name and an advisory label with source and url; `lowtide.example` unverified; nothing); a repeated address answered at each place; request order kept; an X-address → 400 `invalid ripple address`; 101 → 400 `too many addresses - at most 100`; no key → 401; an unknown parameter ignored; `Cache-Control: private, max-age=60` and `no-store` on a 400; an address that is no account still gets its name and labels; `it('verifies a Xahau account whose entry says network = 21337, and not an XRPL account whose entry says testnet')` (a Xahau harness sharing the shared database); `it('keeps the last directory when a reload fails')` (after a load, `RENAME TABLE domain_tomls TO domain_tomls_away`, wait two reloads: the verified name is still served; rename back); `it('answers 500 when account_domains cannot be read')` (renamed away: 500 `unable to retrieve account names`, `Cache-Control: no-store`; rename back); the bound: 50,000 accounts in four inserts with `SYSTEM STOP MERGES account_domains`, 100 asked: `readsOf(h, Table.AccountDomains, …)` sums to at most `100 * 4 * 1024` rows, and `explain(h, 'indexes = 1', ACCOUNT_DOMAINS_SQL, { addresses })` shows the primary key condition on `account`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- account-names` and `test:e2e -- display-names`.
- [ ] **Step 3: Implement the parser, the object and the controller** (Swagger `@ApiOperation` and `@ApiQuery` for `addresses`).
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` and `test:e2e -- display-names` exit 0.
- [ ] **Step 5: Commit.** `git add apps/api/src/names apps/api/test/display-names.e2e-spec.ts` — `feat(api): GET /v2/account_names` (body: one call names up to 100 addresses for a page of the explorer, with the domain and the labels), trailer.

---

### Task 13: `GET /v2/toml/{domain}`

**Files:**
- Create: `apps/api/src/names/toml.controller.ts`, `apps/api/src/names/toml-object.ts`, `apps/api/src/names/toml-object.spec.ts`, `apps/api/test/toml.e2e-spec.ts`
- Modify: `apps/api/src/names/names.module.ts` (the controller)

**Interfaces:**
- Consumes: Task 10 `DomainTomlsService.get`; Task 1 `countsOn`; D1 `isProperlyFormedTomlDomain`; `fmtMillis`, `fmtTime`.
- Produces (Task 14; E9 reads it; D8 adds validator keys):
  ```ts
  export const TOML_KEYS = ['domain', 'toml_url', 'status', 'reason', 'status_code', 'checked', 'fetched', 'modified', 'expires',
    'accounts', 'currencies', 'principals', 'validators'];
  export const TOML_ACCOUNT_KEYS = ['address', 'desc'];
  export const TOML_CURRENCY_KEYS = ['code', 'issuer', 'display_decimals', 'symbol', 'name', 'desc'];
  export const TOML_VALIDATOR_KEYS = ['public_key', 'owner_country', 'server_country', 'unl'];
  export function tomlObject(row: DomainTomlsRow, profile: Pick<NetworkProfile, 'tomlNetworkNames'>): Record<string, unknown>;
  @RippleController('v2/toml') export class TomlController   // @Get(':domain') @RippleRoute('unable to retrieve toml')
  ```

Spec §6: `{domain}` lower-cased, 400 `invalid domain` unless `isProperlyFormedTomlDomain`; no row → 404 `toml not found`. Only entries that count; `reason` only for `failed`, `status_code` only for `http_status`; `fetched` only with content; `modified`, `expires` `fmtTime`; `desc` and `issuer` only when not `''`; currency `display_decimals` from `fields` when an integer 0–30, `symbol`, `name`, `desc` when text; validator `owner_country`, `server_country`, `unl` when text; a list without entries is left out; never anything else of `fields`. `{ result: 'success', toml }`.

- [ ] **Step 1: Write the failing tests.** `toml-object.spec.ts`: key orders; a `failed` `http_status` row carries `reason` and `status_code`, a `timeout` row no `status_code`; `display_decimals: 31` and `"2"` left out; a `testnet` entry absent on XRPL. E2e `toml.e2e-spec.ts`: the stored row of `northpeak.example` answers spec §6's example exactly; `NorthPeak.Example` answers the same; `https://x.com` (encoded) and `x` → 400 `invalid domain`; an unknown domain → 404 `toml not found`; a `failed` toml within its grace carries its content, after a definite failure none; `it('serves no email or handle')` (stored from a file with them: the body contains no `@`); default `Cache-Control`; `readsOf(h, Table.DomainTomls, …)` of one request is at most `8192 ×` the table's active parts, and `explain(h, 'indexes = 1', STORED_TOMLS_SQL, { domains: ['northpeak.example'] })` shows the key on `domain`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- toml-object` and `test:e2e -- toml`.
- [ ] **Step 3: Implement the object and the controller** (Swagger decorators).
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` and `test:e2e -- toml` exit 0.
- [ ] **Step 5: Commit.** `git add apps/api/src/names apps/api/test/toml.e2e-spec.ts` — `feat(api): GET /v2/toml/{domain}` (body: what a domain's toml says as stored, for "How we know" on the account page; the api never fetches), trailer.

---

### Task 14: Reference, ADR-0017, OpenAPI, the docs and the whole check

**Files:**
- Create: `docs/adr/0017-display-names.md`, `apps/api/src/names/api-reference.spec.ts`, `packages/shared/src/tomls/account-domains-seed.spec.ts`
- Modify: `docs/api-reference.md` (a section "Account names and tomls" with both routes: parameters, errors in order, the examples as the e2e answers them, the key lines; the "Compatibility" list of routes the original did not have), `docs/adr/0010-ripple-v2-wire-compatibility.md` ("Amendment 6 (2026-10-24): display names", expected after D3's Amendment 5, items numbered on from the highest item in the file: `GET /v2/account_names` and `GET /v2/toml/{domain}` are new routes, the batch's key `labels` where `/v2/accounts/{address}` says `account_labels` (decision 12), no route of the original changes), `docs/adr/0014-address-names-and-labels-in-a-shared-database.md` (status line: "Amended by ADR-0017: a batch lookup of names after all"), `docs/adr/README.md` (the row of 0017; 0010's and 0014's status cells), `docs/openapi.yaml` (regenerated, `docs/development.md` §8, keeping its header comment), `docs/syncer.md` (a section "The tomls worker": discovery, the pass, the schedule table of §4.4, what is never done; six workers in the diagram), `docs/observability.md` (the four metrics, the two alerts of §4.5), `docs/security.md` and `docs/deployment.md` (egress to every domain accounts name, `GH_DOMAIN_VERIFICATION=false`), `docs/operations.md` (the rollout of §15; the explorer key's rate limit), `docs/backfill.md` (section "Account domains seed": `ACCOUNT_DOMAINS_SEED_SQL` verbatim, the `X` query, 16 buckets, coverage of §10), `docs/architecture.md` and `README.md` (six workers; the two routes in the endpoint table), `GLOSSARY.md` (check that **Account domain** and **Toml store** are there as the spec words them; add what is missing)

**Interfaces:**
- Consumes: every `*_KEYS` constant of Tasks 12–13; `ACCOUNT_DOMAINS_SEED_SQL`.
- Produces: the reference section E9's types and fixtures are written from; report the commit hash for E9 to pin.

ADR-0017 (Context, Decision, Consequences, short; spec §13): names the explorer shows everywhere, one batch per page, verified names from tomls; the display name rule, `account_domains` ordered by account, the `tomls` worker and the per-domain store, the batch, the toml route; egress to tens of thousands of hosts, coverage from the state history (ADR-0015), the ADR-0007 exception, ADR-0014's rejected lookup now accepted for batches, D1's safe fetcher's second user.

- [ ] **Step 1: Check the numbers, then write the failing tests.** `ls docs/adr`: the highest must be `0016`; if not, the ADR is the next free number, everywhere in this task; `grep -n '^## Amendment' docs/adr/0010-*.md` gives the amendment number to take. Then `api-reference.spec.ts` (as `validators/api-reference.spec.ts`): the "Account names and tomls" section's lines ``Keys of <object>, in order: `a`, `b?`, …`` equal, `?` stripped, `ACCOUNT_NAMES_BODY_KEYS` ("the answer"), `ACCOUNT_NAME_ENTRY_KEYS` ("an entry"), `DISPLAY_NAME_KEYS` ("display_name"), `LABEL_KEYS` ("a label"), `TOML_KEYS` ("toml"), `TOML_ACCOUNT_KEYS`, `TOML_CURRENCY_KEYS`, `TOML_VALIDATOR_KEYS`, and every constant has its line. `account-domains-seed.spec.ts`: `docs/backfill.md` contains `ACCOUNT_DOMAINS_SEED_SQL` verbatim.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- api-reference` and `pnpm --filter @gatehub/data-api-shared test -- account-domains-seed`.
- [ ] **Step 3: Write the docs and the ADR, regenerate `docs/openapi.yaml`.**
- [ ] **Step 4: Run the whole suite.** `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-api-shared test:e2e`, `pnpm --filter @gatehub/data-api-service test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e` exit 0; `git diff --stat docs/openapi.yaml` shows `/v2/account_names` and `/v2/toml/{domain}`.
- [ ] **Step 5: Commit.** `git add docs README.md GLOSSARY.md apps/api/src/names/api-reference.spec.ts packages/shared/src/tomls/account-domains-seed.spec.ts` — `docs: display names reference, ADR-0017, the tomls worker and the rollout`, trailer. In the hand-back, give this commit's hash and the deploy summary:
  - **Deploy (per network, sandbox then production):** 1. apply migration 012 before the syncer of this release starts (the ingest writes `account_domains` with every ledger; a missing table fails the batch); 2. deploy the syncer (parser version 6, the `tomls` worker in the default `GH_WORKERS`; where `GH_WORKERS` is set explicitly add `tomls`; open HTTPS egress or set `GH_DOMAIN_VERIFICATION=false`) and the api; 3. run the seed of `docs/backfill.md` once per network (16 buckets); 4. wait for `syncer_tomls_due` near 0 (the first sweep, about 300 domains a minute); 5. raise the explorer key's `GH_RATE_LIMIT_KEYS` limit if its 429s rise; 6. then E9's `NAMES` switch may go on there. No reprocess. Coverage: an account dormant since before the state history has no domain until its next change.

---

## Rulings

1. **`cleanTomlText`'s order** (spec §3.3 lists "Cc and Cf removed" before "runs of white space one space"): white space is kept through the removal and collapsed after it, so `Northpeak\tTreasury` reads `Northpeak Treasury`, not `NorthpeakTreasury`. A tab is a control character and white space; the spec's purpose (no controls, one space between words) needs this order.
2. **The worker's `ok` rows are batched** (spec §4.2 step 4) and built by the same `okTomlRow` that `recordToml` writes (spec §4.4 says the worker "uses" `recordToml`, which inserts one row per call). `recordToml` stays the one-file write D8's checker calls.
3. **`readToml(text, profile, fetchedAt)`**: the `modified` bound of §3.3 needs the fetch time, so it is a required third argument; `profile` stays in the signature the spec and D8 name, and no rule reads it (the writer keeps every network's entries; readers filter with `countsOn`). D8's `matchToml` passes its fetch time.
4. **The domains gauge without a fifth column**: `failures = 0` exactly when the newest row is `ok` (an ok row resets it), so `syncer_tomls_domains{status}` comes from the schedule's four columns of §4.2.
5. **No domain is "named anew" at the first discovery after a start**: there is no previous map, and counting every domain as grown would re-check every domain checked more than an hour ago at each restart.
6. **The worker checks discovered domains only**: a stored domain no account names any more (or one only D8 writes) is not fetched by it (spec §4.1: "this worker fetches account domains only").
7. **`nextTomlRow` lives in `apps/syncer/src/tomls/toml-row.ts`** as spec §4 says; it needs D1's `isTransientReason` and `FetchFailure`, which are the syncer's. D8's checker imports it from there.
8. **An invalid `Domain` is counted in `LedgerDiagnostics.invalidDomains`** ("the build's warnings", spec §3.1) and nowhere else: no metric, no log; the row is written with `''`.
9. **An entry's `network` text is cleaned** (`cleanTomlText(value, 64)`, lower-cased), not only trimmed: it is served on `/v2/toml` and by D8, so it gets the same control and bidi removal as every other text.
10. **Recorded cases**: the plan picks two ledgers already recorded (the Payments to accounts with a Domain) and has the rest found by a bounded scan of 5,000 ledgers per network; a case not found there is covered by its hand-made unit case only, and the fixtures README says so.
11. **The e2e test certificate names the worker's test hosts** (consistency pass): `startTestWeb` verifies TLS against `TEST_TLS.cert`, whose SAN lists only `a.example`…`e.example`, `unl.example`, `northpeak.example` and `www.northpeak.example` (D1, `tls.ts`); Task 9's seven fetched hosts are added the way `tls.ts` says (the command run again, both files committed), so their failures are the intended ones and not `tls_error`. D8's tests use the existing names.
12. **`pnpm lint` is not run** (consistency pass): the repository has no ESLint configuration (`docs/development.md` §4; D-env's Global Constraints), so `eslint --fix` fails; the checks before a commit and at the end are `pnpm format`, `pnpm build`, `pnpm test` and the `test:e2e` suites.
