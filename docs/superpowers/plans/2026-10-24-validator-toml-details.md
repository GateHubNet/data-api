# Validator Toml Details (D8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve, from each validator's verified toml, its server and owner countries, the network and UNL the toml claims, and its domain's principals, last-modified date, accounts and currencies, as `toml` on `GET /v2/network/validators[/{key}]`; add the list's `country` filter and `GET /v2/network/validators/countries`.

**Architecture:** One additive migration adds five columns to D1's `validator_domains`. The rules (ISO country codes, the reading of a `[[VALIDATORS]]` entry) live in the shared package, so the syncer and D4's `/v2/toml/{domain}` apply the same ones. The domain checker reads the validator's entry through D4's `readToml` (under `matchToml`), writes its four facts with each verdict, re-checks verified pairs read before D8, and writes every file it fetched into D4's per-domain store (`domain_tomls`). The API directory reads the five columns; rows gain `toml`; the detail adds the domain's facts from D4's `DomainTomlsService`; the `country` filter and the countries aggregate are pure functions over the cached directory.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 (`@clickhouse/client`), pnpm 10 workspace, jest + ts-jest, testcontainers, supertest, `smol-toml` 1.3.1 (through D4's `readToml`), `prom-client`.

**Spec:** `docs/superpowers/specs/2026-10-24-validator-toml-details-design.md` (cited "spec §n"; the plan argues from the spec, executors read both). D4's spec `docs/superpowers/specs/2026-10-24-display-names-design.md` (cited "D4 §n") defines everything D8 reads of the toml store.

**Worktree and branch:** `/Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2`, branch `feat/explorer-data-2`. Before Task 1 the plans of D-env, D3, D4, D5, D6 and D7 are built on this branch (D4 above all: see "Consumed from earlier plans"). Nothing is pushed.

## Global Constraints

- **A migration is needed: `016_validator_toml_details.sql`** (spec §2.3), the `ALTER` of spec §2.1 alone. No parser version (nothing is ledger-derived: spec §7), no shared-database migration, no new ADR: ADR-0012 is amended in place (spec decision 11). Task 1 checks `016` is still the next free number.
- Commands (root `package.json`): `pnpm install` once if `node_modules` is missing; before every commit `pnpm format`, `pnpm build`, `pnpm test`, and the e2e suite of every package the task touched: `pnpm --filter @gatehub/data-api-shared test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e`, `pnpm --filter @gatehub/data-api-service test:e2e` (Docker; narrow with `-- <pattern>` while iterating, the whole suite before the commit). The apps import the compiled `dist/` of `packages/shared`: run `pnpm --filter @gatehub/data-api-shared build` after changing it.
- Never edit an applied migration (`002_validators_amendments.sql`, D4's `012`). Table names only from `Table`; every value bound as a query parameter; no `FINAL`; an `argMax` alias never equals a column name (D1's rule, `readDomains`).
- Times: `DateTime64(3)` values are inserted as unix seconds with the milliseconds as a fraction; answers write instants of receipt with `instant()` (`YYYY-MM-DDTHH:mm:ss.SSSZ`) and wall times with `fmtTime` (`YYYY-MM-DDTHH:mm:ssZ`).
- Country codes are exactly `ISO_COUNTRY_CODES` (Task 2: the 249 ISO 3166-1 alpha-2 codes assigned on 2026-10-24 and `XK`, 250), served upper case; `UK` is read as `GB`; anything else (`Germany`, `DEU`, `EU`, `ZZ`, `US-CA`) counts as not given and is never served.
- Facts come only from a file that **verified** the pair (spec decision 1). Nothing a toml holds is ever fetched (`unl`, an issuer, an icon). Principals: names only, a name with `@` dropped (D4 applies it), never logged. Emails are never read, stored, logged or served. A value from a file in a log line is quoted and cut to 16 characters.
- Every answer object's key order is an exported `*_KEYS` constant, and `docs/api-reference.md` "Validators and amendments" has its `Keys of <object>, in order: …` line, which `apps/api/src/validators/api-reference.spec.ts` ties to the constant: a task that adds or changes a constant changes its line in the same commit.
- Answers: a key with no value is absent, never `null`; `toml` is the last key of a validator row, after `last_seen`; no `coverage` object anywhere (spec Non-goals).
- Errors: 400 `invalid country`, 400 `invalid scope`, 500 `unable to retrieve validator(s)` (the routes' `FAILURE`). `/v2/network/validators/countries` sends `VALIDATORS_CACHE_CONTROL` (`private, max-age=30`) while `GH_CACHE_CONTROL` is not empty.
- D4's pieces are used by their names and never redefined or forked; where D8 extends one (`matchToml`, `toml-object.ts`), it changes it in place. D8's `TOML_KEYS` (`apps/api/src/validators/validator-object.ts`, spec §4.1's name) is not D4's `TOML_KEYS` (`apps/api/src/names/toml-object.ts`): import each by its path.
- Test data: toml files are hand-written and say so in their first line; domains are `*.example` (the e2e TLS certificate's names: `a.example` … `e.example`, `northpeak.example`).
- Commits: Conventional Commits (`feat(shared): …`, `feat(syncer): …`, `feat(api): …`, `docs: …`), a body saying why, and the last line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Name the files in `git add` (never `-A`), never `--amend`, never touch `.claude/`.

## Review Focus

1. **Odd values in a real file**: a Xahau `network = 21337` (bare or quoted), countries in lower case or with spaces, `UK`, `Germany`, a number, an `http:` or credentialed `unl`. Expected: `"21337"`, upper-case codes, `GB`, the field absent (never a 500, never a partial value), counted `invalid` and quoted in the log. Pinned by Task 2 `toml-entry.spec.ts` ("reads every odd value of a real file") and Task 4's e2e "reads the hand-written files of both networks".
2. **A website that blips right after the deploy**: a pair verified before D8 (`toml_version` 0) whose re-check meets a transient failure must stay `verified` with its old facts and version, and must wait the transient hour, not be fetched every minute. Pinned by Task 3 `keeps prev's facts and toml_version through a transient failure within 24 h` and Task 4 `isDomainDue: a verified pair below the version that failed transiently 10 minutes ago is not due`.
3. **The route and the list disagreeing**: every count of `/countries` (both scopes, `unknown` included, a verified-but-not-read pair counted as unknown) must equal what `GET /v2/network/validators?scope=…&country=…` lists. Pinned by Task 8's e2e `counts what the list lists, for every country and unknown, in both scopes`.
4. **Personal data leaking**: a principal with an `email` and a name with `@` must leave no `@` text in `validator_domains`, `domain_tomls`, a log line or an answer. Pinned by Task 4's e2e `stores no email and no name with @` and Task 6's e2e `serves no @ anywhere in the detail`.
5. **The store behind the detail**: no store row, a definite failure (content gone), and a store read that fails. Expected: the row's `toml` alone, the row's `toml` alone, and 500 `unable to retrieve validator(s)` (never a detail that silently lacks its facts). Pinned by Task 6's e2e `has the row's toml alone without a store row and after a definite failure` and `answers 500 when the store read fails`.

---

## Consumed from earlier plans

Names and signatures as D4's plan (`docs/superpowers/plans/2026-10-24-display-names.md`) produces them; read each in its file before using it (D4 is built when this plan runs).

| Piece | From | Where |
| --- | --- | --- |
| `matchToml(text, masterKey)` as D4 left it (parsing with `parseTomlText`); `TomlInvalidError` (moved to the shared package, re-exported by `toml-match.ts`). D4's ruling 3: "D8's `matchToml` passes its fetch time" | D4 Task 2 | `apps/syncer/src/validators/toml-match.ts`; `packages/shared/src/tomls/toml-read.ts` |
| `readToml(text, profile: Pick<NetworkProfile, 'name'>, fetchedAt: UnixSeconds): TomlContent`; `TomlValidator { public_key; network; fields }` (`network` cleaned and lower-cased, an integer as its decimal text; `fields` the JSON object text of the entry's other scalar keys, strings through `cleanTomlText(value, 256)`, at most 16); at most 100 validators kept | D4 Task 2 | `packages/shared/src/tomls/toml-read.ts` |
| `countsOn(entryNetwork, profile: Pick<NetworkProfile, 'tomlNetworkNames'>)`; `NetworkProfile.tomlNetworkNames` | D4 Task 1 | `packages/shared/src/tomls/counts-on.ts` |
| `tomlUrlOf(domain, profile)`; `recordToml(ch, { domain, tomlUrl, text, fetchedAt: UnixSecondsMs, recheckMs, profile }): Promise<DomainTomlsRow>` (throws `TomlInvalidError`, writing nothing, for a text that is not TOML); `readStoredTomls(ch, domains): Promise<Map<string, DomainTomlsRow>>`; `STORED_TOMLS_SQL` | D4 Task 6 | `packages/shared/src/tomls/toml-store.ts` |
| `nextTomlRow(prev, check: TomlCheck, now: UnixSecondsMs, recheckMs)`; `TomlCheck = { domain; tomlUrl } & ({ content } \| { reason: TomlFailure; statusCode? })`; `TomlFailure = FetchFailure \| 'toml_invalid'` | D4 Task 6 | `apps/syncer/src/tomls/toml-row.ts` |
| `Table.DomainTomls`; `DomainTomlsRow` (`checked_at` the version; `fetched_at: UnixSecondsMs \| null` the content in effect; `modified: UnixSeconds \| null`; `accounts: TomlAccount[]`; `currencies: TomlCurrency[]` (`code`, `issuer`, `network`, `fields`); `principals: string[]`); migration `012` | D4 Task 3 | `packages/shared/src/clickhouse/{tables,rows}.ts` |
| `SyncerConfig.tomlRecheckMs` (`GH_TOML_RECHECK_MS`, 86,400,000) | D4 Task 8 | `apps/syncer/src/config/syncer.config.ts` |
| `NamesModule` exporting `DomainTomlsService` with `get(domain): Promise<DomainTomlsRow \| undefined>` (`readStoredTomls`, kept 60 s per domain, a miss too) | D4 Task 10 | `apps/api/src/names/names.module.ts`, `domain-tomls.service.ts` |
| `GET /v2/toml/{domain}`: `tomlObject(row, profile)`, `TOML_VALIDATOR_KEYS = ['public_key', 'owner_country', 'server_country', 'unl']`; its reference check of the "Account names and tomls" section; its e2e suite | D4 Tasks 13, 14 | `apps/api/src/names/toml-object.ts`, `apps/api/src/names/api-reference.spec.ts`, `apps/api/test/toml.e2e-spec.ts` |
| `readsOf`, `explain` (the read-bound helpers of the api e2e suites) | api tests | `apps/api/test/support/` |
| D1 as built: `DomainChecker`, `nextDomainRow`, `storedDomains`, `judge`, `isTransientReason`, `DOMAIN_TRANSIENT_RECHECK_S`, `DOMAIN_VERIFIED_GRACE_S`; the directory (`readDomains`, `DomainRow`, `DomainState`, `DirectoryEntry`, `assembleDirectory`); `validator-object.ts`; `validators-query.ts`; `validators.controller.ts`; the e2e helpers `seedFleet`, `insertDomains`, `bootDomains`, `putManifest`, `putList`, `web.serveToml` | D1 | `apps/syncer/src/validators/`, `apps/api/src/validators/`, `apps/*/test/` |

---

### Task 1: Migration 016, the toml columns of `validator_domains`

**Files:**
- Create: `packages/shared/schema/016_validator_toml_details.sql`
- Modify: `packages/shared/test/migrate.e2e-spec.ts` (a `describe('migration 016')`), `docs/data-model.md` (the `validator_domains` section and §5's migration list)
- Test: `packages/shared/test/migrate.e2e-spec.ts`

**Interfaces:**
- Consumes: the runner (`runMigrations`), `statementsOf`, `SAMPLE_ROWS[Table.ValidatorDomains]` as D1 left it.
- Produces (Tasks 3–8): five columns of `validator_domains`, exactly:

```sql
ALTER TABLE validator_domains
  ADD COLUMN IF NOT EXISTS owner_country  LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS server_country LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_network   String DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_unl       String DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_version   UInt8 DEFAULT 0;
```

The file's header comment is 010's (what it adds and why: spec §2.1; the runner's constraints, verbatim). The row type gains the columns in Task 3, not here (its builders and seeds change with it).

- [ ] **Step 1: Check the number.** `ls packages/shared/schema/` must end at `015_*.sql` (D7). If D3–D7 took more, use the next free number for the file and `MIGRATION_016` below, and say so in the commit body.
- [ ] **Step 2: Write the failing tests** in `migrate.e2e-spec.ts`, following `describe('migration 004')` (a temp `GH_SCHEMA_DIR`, `copyReal`), with `const MIGRATION_016 = '016_validator_toml_details.sql'`:
  - `it('is one ALTER of validator_domains that adds the five columns')`: `statementsOf(file)` has length 1, starts with `ALTER TABLE validator_domains`, and holds `ADD COLUMN IF NOT EXISTS` five times, once each for `owner_country`, `server_country`, `toml_network`, `toml_unl`, `toml_version`.
  - `it('applies 016 to a database migrated before it, and then nothing')` (database `ctl_016_after`): apply every real file but 016; insert `SAMPLE_ROWS[Table.ValidatorDomains]`; apply 016 (`applied: [MIGRATION_016]`); `system.columns` gives the types `LowCardinality(String)`, `LowCardinality(String)`, `String`, `String`, `UInt8`; `SELECT owner_country, server_country, toml_network, toml_unl, toml_version FROM validator_domains` reads `''`, `''`, `''`, `''`, `0` for the old row; a third run applies nothing.
  - `it('completes 016 after a half-applied run')` (database `ctl_016_half`): every real file but 016, then `ALTER TABLE validator_domains ADD COLUMN owner_country LowCardinality(String) DEFAULT ''` by hand, then `runMigrations` applies 016 and all five columns exist.
- [ ] **Step 3: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate`: FAIL, the file is missing.
- [ ] **Step 4: Write the migration**, and in `docs/data-model.md` the five columns under `validator_domains` (spec §2.1: filled only on a `verified` row; `toml_version` 0 before D8, `TOML_DETAILS_VERSION` after) and the line for 016 in §5.
- [ ] **Step 5: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared test:e2e` and `pnpm test` exit 0 (the whole-schema test "(a)" applies 016 too).
- [ ] **Step 6: Commit.** `git add packages/shared/schema/016_validator_toml_details.sql packages/shared/test/migrate.e2e-spec.ts docs/data-model.md` — `feat(shared): migration 016, the toml columns of validator_domains` (body: the facts belong to the pair whose check read them; additive, no undo).

---

### Task 2: Shared rules: country codes and a validator's toml entry

**Files:**
- Create: `packages/shared/src/validators/country.ts`, `packages/shared/src/validators/country.spec.ts`, `packages/shared/src/validators/toml-entry.ts`, `packages/shared/src/validators/toml-entry.spec.ts`
- Modify: `packages/shared/src/validators/index.ts` (export both)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 3, 4, 7, 9):

```ts
// country.ts
export const ISO_COUNTRY_CODES: ReadonlySet<string>;          // the 250 codes below
export function countryCodeOf(value: unknown): string | undefined; // a string, trimmed, upper-cased, UK read as GB; in the set, else undefined

// toml-entry.ts
export const TOML_DETAILS_VERSION = 1;                         // what the checker reads of a file (spec §2.1); exported by index.ts
export const TOML_FIELDS = ['owner_country', 'server_country', 'network', 'unl'] as const;
export type TomlField = (typeof TOML_FIELDS)[number];
export interface ValidatorTomlEntry {
  ownerCountry: string;  // '' = not given or not a code
  serverCountry: string;
  network: string;       // as D4 stored it ('main', 'testnet', '21337'); '' when absent
  unl: string;
  /** The fields the file gives a value for that the rules refuse, each with the value as a log line shows it. */
  invalid: { field: TomlField; shown: string }[];
}
export function tomlUnlOf(value: unknown): string | undefined;      // text that parses with URL, protocol https:, no username or password, at most 256 characters: the text as written
export function tomlNetworkOf(value: unknown): string | undefined;  // text of 1 to 32 characters (code points)
/** The facts of one `[[VALIDATORS]]` entry as `readToml` gives it (spec §1.1). Never throws: a `fields` that is not a JSON object reads as none. */
export function validatorTomlEntryOf(entry: { network: string; fields: string }): ValidatorTomlEntry;
/** A value from a file as a log line shows it: its text (`String(value)`), the first 16 code points and `...` when longer, in JSON quotes. */
export function shownValue(value: unknown): string;
```

`ISO_COUNTRY_CODES` holds exactly these 250: the 249 ISO 3166-1 alpha-2 codes assigned on 2026-10-24 and `XK` last (E13's generated table holds the same 250, written by hand from this list):

```
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK
```

`validatorTomlEntryOf` reads `owner_country` and `server_country` from `fields` through `countryCodeOf`, `unl` from `fields` through `tomlUnlOf`, `network` from the entry through `tomlNetworkOf`; a field that is present (any value, any type) and refused goes into `invalid` with `shownValue(value)`; an absent one is `''` and not invalid. Nothing else of `fields` is read.

- [ ] **Step 1: Write the failing tests.**
  - `country.spec.ts`: `it('holds the 250 codes')`: size 250; has `US`, `DE`, `HK`, `XK`, `AQ`; lacks `UK`, `EU`, `ZZ`, `AA`, `QM`, `XA`. `it.each` for `countryCodeOf`: `'us'`→`'US'`, `' de '`→`'DE'`, `'UK'`→`'GB'`, `'uk'`→`'GB'`, `'XK'`→`'XK'`; `'EU'`, `'DEU'`, `'Germany'`, `'US-CA'`, `''`, `49`, `null`, `undefined` → `undefined`.
  - `toml-entry.spec.ts`:
    - `it('reads the four fields of an entry')`: `{ network: 'main', fields: '{"owner_country":"NO","server_country":"de","unl":"https://vl.ripple.com"}' }` → `{ ownerCountry: 'NO', serverCountry: 'DE', network: 'main', unl: 'https://vl.ripple.com', invalid: [] }`.
    - `it('reads every odd value of a real file')` (Review Focus 1): `network: '21337'` → `'21337'`; `server_country: ' fi '` → `'FI'`; `owner_country: 'UK'` → `'GB'`; `server_country: 'Germany'` → `''` with `{ field: 'server_country', shown: '"Germany"' }`; `owner_country: 49` → `''` with `shown: '"49"'`; `unl: 'http://vl.example'`, `'https://u:p@vl.example'`, `'not a url'` and `` `https://vl.example/${'a'.repeat(240)}` `` (257 characters) → `''` and invalid; `network` of 33 characters → `''` and invalid; `server_country: 'Bundesrepublik Deutschland'` → `shown: '"Bundesrepublik D..."'`.
    - `it('takes an absent field as not given, not invalid')`: `{ network: '', fields: '{}' }` → all four `''`, `invalid: []`.
    - `it('reads a fields text that is not a JSON object as none')`: `fields: 'nope'` and `'[1]'` → all `''`, `invalid: []`.
    - `it('reads nothing else of the entry')`: `server_location`, `network_asn`, `attestation` in `fields` change nothing.
    - `it('is version 1')`: `TOML_DETAILS_VERSION === 1`; `TOML_FIELDS` as above.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- country toml-entry`: FAIL, modules missing.
- [ ] **Step 3: Write `country.ts` and `toml-entry.ts`, and export them from `validators/index.ts`.**
- [ ] **Step 4: Run them to verify they pass**, then `pnpm --filter @gatehub/data-api-shared build`, `pnpm build`, `pnpm test`.
- [ ] **Step 5: Commit.** `git add packages/shared/src/validators/country.ts packages/shared/src/validators/country.spec.ts packages/shared/src/validators/toml-entry.ts packages/shared/src/validators/toml-entry.spec.ts packages/shared/src/validators/index.ts` — `feat(shared): ISO country codes and the reading of a validator's toml entry` (body: one rule for the syncer and `/v2/toml/{domain}`, so the two routes never disagree on a country; ruling R2).

---

### Task 3: The checker reads the entry and writes it with each verdict

**Files:**
- Modify: `apps/syncer/src/validators/toml-match.ts` (+ `toml-match.spec.ts`), `apps/syncer/src/validators/domain-checker.ts` (`judge`, `DomainCheck`, `nextDomainRow`, `storedDomains`), `apps/syncer/src/validators/domain-checker.spec.ts`, `packages/shared/src/clickhouse/rows.ts` (`ValidatorDomainsRow`), `packages/shared/test/sample-rows.ts`, `apps/api/test/support/validators-seed.ts` (`insertDomains` defaults)

**Interfaces:**
- Consumes: Task 1's columns; Task 2's `validatorTomlEntryOf`, `ValidatorTomlEntry`, `TOML_DETAILS_VERSION`; D4's `readToml`, `TomlValidator`, `TomlInvalidError`.
- Produces (Tasks 4–6):
  - `matchToml(text: string, masterKey: string, profile: Pick<NetworkProfile, 'name'>, fetchedAt: UnixSeconds): TomlMatch` (spec §1.1 "on top of D4's `readToml`"; D4's ruling 3): reads the file with `readToml(text, profile, fetchedAt)` (which throws `TomlInvalidError` for a text that is not TOML); `listed` when a `validators` entry's `public_key` equals the master key; `accounts` the `accounts` entries' addresses, once each, sorted, the first `MAX_ACCOUNTS` (D1's rule, unchanged); `TomlMatch` gains `entry?: ValidatorTomlEntry`, set only when `listed`: `validatorTomlEntryOf` of the **first** entry with the key (a second one is ignored; no other entry is read). `readToml` keeps at most 100 `[[VALIDATORS]]` entries, so a key listed past the 100th is not listed (no published file comes near it).
  - `DomainCheck` gains `entry?: ValidatorTomlEntry`; `judge(text, key, profile, fetchedAt)` returns `{ reason: '', accounts, entry }` for a listed key; `checkDomain` passes the injected profile (its type widened to `Pick<NetworkProfile, 'tomlPath' | 'name'>`) and `Math.floor(now)`.
  - `ValidatorDomainsRow` gains, after `accounts`: `owner_country: string; server_country: string; toml_network: string; toml_unl: string; toml_version: number;`.
  - `nextDomainRow(prev, check, now, recheckMs)` fills them:

| Check | `owner_country`, `server_country`, `toml_network`, `toml_unl` | `toml_version` |
| --- | --- | --- |
| verified | the entry's (`''` for what it lacks; all `''` without an entry) | `TOML_DETAILS_VERSION` |
| definite failure, `manifest_unverified`, `domain_invalid` | `''` | `TOML_DETAILS_VERSION` |
| transient failure, `prev` verified within `DOMAIN_VERIFIED_GRACE_S` (D1's grace: still `verified`) | `prev`'s | `prev`'s |
| transient failure otherwise | `''` | `TOML_DETAILS_VERSION` |

  - `storedDomains` reads, per pair, `argMax(owner_country, checked_at) AS stored_owner_country`, `stored_server_country`, `stored_toml_network`, `stored_toml_unl`, `argMax(toml_version, checked_at) AS stored_toml_version` (aliases unlike the columns), into the `ValidatorDomainsRow` it gives `nextDomainRow` as `prev`.
  - `insertDomains` (API e2e seed) defaults the five to `''` and `0` (a row from before D8).

- [ ] **Step 1: Write the failing tests.**
  - `toml-match.spec.ts` (spec §10; every call gains the profile and a fetch time): `it('gives the facts of the entry that lists the key')`; `it('takes the first of two entries with the key')`; `it('gives no entry when the key is not listed')`; `it('reads nothing of another validator\'s entry')` (an entry for another key with `server_country = "US"` leaves the match's `''`); `it('reads a bare network = 21337 as "21337"')`; `it('counts an invalid code and an http unl in invalid')`. Accounts and `listed` keep their D1 tests.
  - `domain-checker.spec.ts` (`describe('nextDomainRow')`, extend): `it('writes the facts and toml_version 1 on verified')`; `it('writes empty facts and toml_version 1 on a definite failure')`; `it('keeps prev\'s facts and toml_version through a transient failure within 24 h')` (Review Focus 2: `prev` verified 2 h ago with `toml_version` 0 and `server_country 'DE'` → the row is `verified`, `server_country 'DE'`, `toml_version 0`); `it('clears them after the grace')` (`prev` verified 25 h ago → `unverified`, `''`, version 1); `it('writes empty facts for manifest_unverified and domain_invalid')`. Every existing expectation of a whole row gains the five keys.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- toml-match domain-checker`: FAIL (no `entry`, rows lack the keys).
- [ ] **Step 3: Implement** the interfaces above, the row type, `SAMPLE_ROWS[Table.ValidatorDomains]` (`owner_country: 'NO'`, `server_country: 'DE'`, `toml_network: 'main'`, `toml_unl: 'https://vl.ripple.com'`, `toml_version: 1`, so the round-trip test covers them) and `insertDomains`.
- [ ] **Step 4: Run the tests to verify they pass**: `pnpm --filter @gatehub/data-api-shared build`, `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-api-shared test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e -- validators`, `pnpm --filter @gatehub/data-api-service test:e2e -- validators` (the seed compiles and D1's answers are unchanged).
- [ ] **Step 5: Commit.** `git add apps/syncer/src/validators/toml-match.ts apps/syncer/src/validators/toml-match.spec.ts apps/syncer/src/validators/domain-checker.ts apps/syncer/src/validators/domain-checker.spec.ts packages/shared/src/clickhouse/rows.ts packages/shared/test/sample-rows.ts apps/api/test/support/validators-seed.ts` — `feat(syncer): the domain checker reads the validator's toml entry with its verdict`.

---

### Task 4: The checker's pass: the due rule, the store write-through, metrics and logs

**Files:**
- Modify: `apps/syncer/src/validators/domain-checker.ts` (`isDomainDue`, `dueFirst`, `checkDomain`, `record`, `logChange`, the constructor's injected types), `apps/syncer/src/modules/prometheus/prometheus.service.ts` (two counters), `apps/syncer/src/validators/domain-checker.spec.ts`, `apps/syncer/test/validators.e2e-spec.ts` (`describe('toml details (D8)')` inside "domain verification"), `packages/shared/test/fixtures/README.md` (a "Toml files" section)
- Create: `packages/shared/test/fixtures/tomls/validator-details.xrp-ledger.toml`, `packages/shared/test/fixtures/tomls/validator-details.xahau.toml`

**Interfaces:**
- Consumes: Task 3; D4's `tomlUrlOf`, `recordToml`, `readStoredTomls`, `nextTomlRow`, `TomlCheck`, `TomlInvalidError`, `Table.DomainTomls`, `SyncerConfig.tomlRecheckMs` (the checker's `CheckerConfig` gains `'tomlRecheckMs'`).
- Produces:
  - `export function isDomainDue(stored: ValidatorDomainsRow | undefined, now: number): boolean`: no row; or `next_check_at <= now`; or `status === 'verified' && toml_version < TOML_DETAILS_VERSION && checked_at <= now - DOMAIN_TRANSIENT_RECHECK_S` (spec §3.3). `dueFirst` keeps the due pairs in two groups: never checked and below the version first (by key, then domain), then the rest by `next_check_at` (D1's order); still at most `DOMAIN_PASS_LIMIT`.
  - The write-through (spec §2.2), in `checkDomain`, once per fetched domain, after `record` has written its validators' rows and only when the checker is not stopped; `domain` is the group's domain lower-cased, `tomlUrl` `tomlUrlOf(domain, profile)`, `now` the pass's time (unix seconds with the milliseconds):

| Fetch | Store row |
| --- | --- |
| text read (`recordToml` succeeds), whatever the verdicts | `recordToml(this.ch, { domain, tomlUrl, text, fetchedAt: now, recheckMs: cfg.tomlRecheckMs, profile })` |
| text that is not TOML (`recordToml` throws `TomlInvalidError`), or a fetch failure | `nextTomlRow(prev, { domain, tomlUrl, reason, statusCode }, now, cfg.tomlRecheckMs)` (`reason` `'toml_invalid'`, or the fetch's `FetchFailure` and its status code) inserted with `ch.insert(Table.DomainTomls, [row])`, `prev` = `(await readStoredTomls(this.ch, [domain])).get(domain)` |
| `domain_invalid`, `manifest_unverified` (no fetch) | nothing |

  A store write that throws is caught: `syncer_validators_toml_store_writes_total{outcome="error"}` and one `warn` line naming the domain (quoted) and the error's name, never its message; the pass goes on. A write that succeeds counts `outcome="ok"`.
  - `PrometheusService` gains `validatorsTomlFieldsTotal` (`syncer_validators_toml_fields_total`, labels `field`, `outcome`: `read`, `absent`, `invalid`) and `validatorsTomlStoreWritesTotal` (`syncer_validators_toml_store_writes_total`, label `outcome`: `ok`, `error`). `record` counts, for each check with `reason === ''` and an `entry`, each of `TOML_FIELDS`: `invalid` when listed in `entry.invalid`, `read` when its value is not `''`, else `absent`.
  - `logChange` logs when the status, reason, status code **or any of the four facts** differ from `prev` (or there is no `prev`), as `Validator {key}: domain "{domain}" is {status}{why}`, then `, server country {CODE}` for a verified row with one, then `; ignored {field} {shown}, …` for the check's `entry.invalid`. Never a principal, never a file body.

The two fixture files (hand-written; the e2e replaces `__KEY_1__` and `__KEY_2__` with its master keys):

```toml
# validator-details.xrp-ledger.toml: hand-written test data (D8), not recorded from any real domain.
[METADATA]
modified = 2026-10-02

[[PRINCIPALS]]
name = "Mara Lindqvist"
email = "mara@northpeak.example"

[[PRINCIPALS]]
name = "ops@northpeak.example"

[[PRINCIPALS]]
name = "Tomas Okafor"

[[VALIDATORS]]
public_key = "__KEY_1__"
owner_country = "no"
server_country = " de "
unl = "https://vl.ripple.com"
server_location = "Frankfurt"

[[VALIDATORS]]
public_key = "__KEY_2__"
network = "main"
owner_country = "UK"
server_country = "Germany"
unl = "http://vl.example"

[[ACCOUNTS]]
address = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"

[[CURRENCIES]]
code = "USD"
issuer = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
```

```toml
# validator-details.xahau.toml: hand-written test data (D8), not recorded from any real domain.
[[VALIDATORS]]
public_key = "__KEY_1__"
network = 21337
server_country = "fi"
owner_country = "EE"
```

- [ ] **Step 1: Write the failing unit tests** (`domain-checker.spec.ts`, with its fake store, fetcher and metrics):
  - `describe('isDomainDue')`: `it('is due: no row; next check passed; verified below the version and checked more than an hour ago')`; `it('is not due: verified below the version checked 10 minutes ago; unverified below the version; verified at the version before its next check')`; `it('a verified pair below the version that failed transiently 10 minutes ago is not due')` (Review Focus 2: the grace row written then has `toml_version` 0 and `checked_at` 10 min ago).
  - `it('checks the pairs below the version with the never-checked ones, before the others')`.
  - `describe('the store write-through')`: `it('writes the file it read once per domain, after the verdicts of its validators')` (two validators of one domain: one `domain_tomls` insert, made after the `validator_domains` insert); `it('writes nextTomlRow over the stored row for a fetch failure and for a file that is not TOML')`; `it('writes nothing for domain_invalid and manifest_unverified')`; `it('counts a failed store write and finishes the pass')` (the fake's insert into `domain_tomls` throws: the pass resolves with its count, `outcome="error"` is 1, one warn line without the error's message).
  - `it('counts each field of a verified check as read, absent or invalid')`.
  - `it('logs a change of server country and the ignored values, never a principal')`: the logger fake's lines equal `['Validator nH…: domain "northpeak.example" is verified, server country DE']` and, for the second key, `… is verified; ignored server_country "Germany", unl "http://vl.example"`; a second identical pass logs nothing.
- [ ] **Step 2: Write the failing e2e tests** (`validators.e2e-spec.ts`, `describe('toml details (D8)')`, the files read from `packages/shared/test/fixtures/tomls/` with the keys put in):
  - `it('reads the hand-written files of both networks')`: XRPL, `northpeak.example` naming key 1 and key 2: `validator_domains` holds key 1 `NO`/`DE`/`''`/`https://vl.ripple.com`/1 and key 2 `GB`/`''`/`main`/`''`/1; on Xahau (`profile: getNetworkProfile('xahau')`, `/.well-known/xahau.toml` on `b.example`) key 1 holds `EE`/`FI`/`21337`/`''`/1.
  - `it('checks a pair verified before D8 again in the next pass')`: a stored row `verified`, `toml_version` 0, `checked_at` 2 h ago, `next_check_at` in 4 h: one pass fetches and writes version 1.
  - `it('writes the store row of a domain only a validator names, and its failed row once the file is gone')`: after a pass, `domain_tomls`' newest row of `a.example` is `ok` with `fetched_at` set and principals `['Mara Lindqvist', 'Tomas Okafor']`; the file then answers 404 and the clock passes `next_check_at`: the newest row is `failed`, `http_status`, 404, `fetched_at` NULL, `principals` `[]`.
  - `it('stores no email and no name with @')` (Review Focus 4): no `@` in any text column of the two tables' rows (`SELECT * … FORMAT JSONEachRow`), and none in the lines the worker logged (the test's logger option).
- [ ] **Step 3: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- domain-checker` and `pnpm --filter @gatehub/data-syncer test:e2e -- validators`: FAIL.
- [ ] **Step 4: Implement** the interfaces above; the fixtures and the README's section (each file, what it holds, "hand-written, D8").
- [ ] **Step 5: Run the tests to verify they pass**, then the Global Constraints' commands.
- [ ] **Step 6: Commit.** `git add` the files above — `feat(syncer): validator tomls are read again after D8 and written through to the toml store` (body: spec decisions 6 and 7; a domain only a validator names gets a store row; the hour stops a failing site from being fetched every minute).

---

### Task 5: `toml` on the validator rows

**Files:**
- Modify: `apps/api/src/validators/validator-directory.service.ts` (`readDomains`), `apps/api/src/validators/directory.ts` (`DomainRow`, `DomainState`, `DirectoryEntry`, `domainStateOf`, the entry's assembly), `apps/api/src/validators/validator-object.ts` (`TOML_KEYS`, `VALIDATOR_ROW_KEYS`, `ValidatorRow`, `rowOf`), `apps/api/src/validators/api-reference.spec.ts` (the map), `docs/api-reference.md` (two `Keys of` lines), `apps/api/src/validators/directory.spec.ts`, `apps/api/src/validators/validator-object.spec.ts`, `apps/api/test/validators.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 3's columns as written.
- Produces (Tasks 6–8):
  - `readDomains` reads `argMax(owner_country, checked_at) AS newest_owner_country`, `newest_server_country`, `newest_toml_network`, `newest_toml_unl`, `argMax(toml_version, checked_at) AS newest_toml_version`.
  - `DomainRow` gains `ownerCountry: string; serverCountry: string; tomlNetwork: string; tomlUnl: string; tomlVersion: number`.
  - `export interface TomlFacts { readonly ownerCountry?: string; readonly serverCountry?: string; readonly network?: string; readonly unl?: string }`; `DomainState.toml?: TomlFacts`, set only when the state is `verified` and `tomlVersion >= 1`, each fact absent when `''` (all four `''` → `{}`).
  - `DirectoryEntry` gains `toml?: TomlFacts` (its `domainState.toml`) and `serverCountry?: string` (its `toml.serverCountry`).
  - `export const TOML_KEYS = ['owner_country', 'server_country', 'network', 'unl'] as const;` `VALIDATOR_ROW_KEYS` gains `'toml'` after `'last_seen'`; `ValidatorRow.toml?: TomlObject` (`{ owner_country?, server_country?, network?, unl? }`), built by `tomlOf(facts: TomlFacts): TomlObject`.
  - `docs/api-reference.md`: the line `Keys of a validator row, in order: …` ends `…, first_seen, last_seen, toml`; a new line `Keys of toml on a validator row, in order: \`owner_country, server_country, network, unl\`.`; `api-reference.spec.ts` maps `'toml on a validator row': TOML_KEYS`.

- [ ] **Step 1: Write the failing tests.**
  - `directory.spec.ts`: `it('gives a verified domain read by D8 its toml facts')`; `it('gives toml {} for a verified domain whose file gives none of the four')`; `it('gives no toml to a verified domain read before D8, an unverified one and a pending one')`; `it('sets serverCountry from the toml')`.
  - `validator-object.spec.ts`: `it('has toml last, after last_seen')`; `it('leaves toml out without facts, writes {} for empty facts, and every key it has')`; the key-constants test gains `TOML_KEYS`.
  - `validators.e2e-spec.ts`, a describe on a fleet whose `northpeak.example` rows carry `NO`/`DE`/`main`/`https://vl.ripple.com`/1 and `shoreline.example` `''`×4/1, plus a Xahau one with `toml_network '21337'`: `it('serves toml on the rows: full, {}, and none for the others')`; `it('serves a Xahau network ID as text')` (`"21337"`); `it('writes the toml columns into the CSV')` (`format=csv`: headers `toml.owner_country`, `toml.server_country`, `toml.network`, `toml.unl`); every existing key-order assertion of a row uses the new `VALIDATOR_ROW_KEYS`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- directory validator-object api-reference`: FAIL.
- [ ] **Step 3: Implement** the interfaces and the two reference lines.
- [ ] **Step 4: Run the tests to verify they pass**, then `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-api-service test:e2e -- validators`.
- [ ] **Step 5: Commit.** `git add` the files above — `feat(api): toml facts on the validator rows`.

---

### Task 6: The detail's `toml`: the domain's facts from D4's store

**Files:**
- Create: `apps/api/src/validators/domain-toml-facts.ts`, `apps/api/src/validators/domain-toml-facts.spec.ts`
- Modify: `apps/api/src/validators/validator-object.ts` (`TOML_DETAIL_KEYS`, `CURRENCY_KEYS`, `validatorDetail`), `apps/api/src/validators/validators.controller.ts` (`detail`), `apps/api/src/validators/validators.module.ts` (imports D4's `NamesModule`), `apps/api/src/validators/api-reference.spec.ts`, `docs/api-reference.md` (two lines), `apps/api/src/validators/validator-object.spec.ts`, `apps/api/test/validators.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 5 (`DirectoryEntry.toml`, `tomlOf`); D4's `DomainTomlsService.get(domain)`, `countsOn`, `DomainTomlsRow`; `NETWORK_PROFILE`.
- Produces:

```ts
// domain-toml-facts.ts: the one place that reads D4's row
export interface DomainTomlFacts {
  principals: readonly string[];                         // as stored (D4: names, at most 10), less any holding `@`: D4's writer drops them, the reader drops them again
  modified: number | null;                               // unix seconds
  accountsListed: number;                                // every [[ACCOUNTS]] entry, whatever its network
  currencies: readonly { code: string; issuer: string }[]; // the entries that count on this network (countsOn), file order, all of them
  fetchedAt: number;                                     // unix seconds with a millisecond fraction
}
/** `undefined` without a row and when its content is not in effect (`fetched_at` NULL: a definite failure, or past the grace). */
export function domainTomlFactsOf(row: DomainTomlsRow | undefined, profile: Pick<NetworkProfile, 'tomlNetworkNames'>): DomainTomlFacts | undefined;

// validator-object.ts
export const TOML_DETAIL_KEYS = ['owner_country', 'server_country', 'network', 'unl', 'principals', 'modified', 'accounts_listed', 'currencies', 'currencies_listed', 'fetched'] as const;
export const CURRENCY_KEYS = ['code', 'issuer'] as const;
export function validatorDetail(entry: DirectoryEntry, amendments: ListedAmendments, facts?: DomainTomlFacts): ValidatorDetail;
```

  The detail's `toml` (spec §4.2) is the row's `toml` followed, when `facts` is given, by: `principals` (absent when empty), `modified` (`fmtTime`, absent when null), `accounts_listed` (absent when 0), `currencies` (the first 10, `{ code, issuer? }`, `issuer` absent when `''`; absent when empty), `currencies_listed` (their whole number; absent when 0), `fetched` (`instant(fetchedAt)`). Without the row's `toml`, no store read and no `toml`.
  - `detail()` reads the store only when the resolved entry has `toml`: `facts = domainTomlFactsOf(await this.tomls.get(entry.domain.toLowerCase()), this.profile)`. A rejected read propagates (the route's 500).
  - Reference lines: `Keys of toml on the validator answer, in order: \`owner_country, server_country, network, unl, principals, modified, accounts_listed, currencies, currencies_listed, fetched\`.` and `Keys of a toml currency, in order: \`code, issuer\`.`; mapped in `api-reference.spec.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `domain-toml-facts.spec.ts`: `it('is undefined without a row and when fetched_at is null')`; `it('keeps the currencies that count on this network, in file order')` (entries with `network` `''`, `main`, `testnet` on XRPL: the first two); `it('counts every account whatever its network')`; `it('drops a principal holding @')`.
  - `validator-object.spec.ts`: `it('adds the domain\'s facts after the row\'s toml, in TOML_DETAIL_KEYS order')`; `it('leaves out empty principals and currencies, zero counts and a null modified')`; `it('cuts the currencies at 10 and counts them all')` (12 → 10 served, `currencies_listed` 12); `it('writes an issuer of \'\' as no issuer')`; `it('has no toml and reads no facts for a row without toml')`.
  - `validators.e2e-spec.ts` (a `domain_tomls` row seeded for `northpeak.example` with principals, `modified`, three accounts, two counting currencies and one `testnet`, `fetched_at`): `it('serves the store\'s facts on the detail')`; `it('has the row\'s toml alone without a store row and after a definite failure')` (Review Focus 5: `shoreline.example` without a row; then a newer `failed` row with `fetched_at` NULL for `northpeak.example`); `it('answers 500 when the store read fails')` (only the read of `domain_tomls` made to reject, as the suite's "when ClickHouse fails" describe makes its reads reject: 500 `unable to retrieve validator(s)`, `no-store`); `it('reads the store once by key and keeps it 60 s')` (`readsOf(h, Table.DomainTomls, …)`: one read, and `explain(h, 'indexes = 1', STORED_TOMLS_SQL, { domains: ['northpeak.example'] })` shows the key on `domain`; a second detail within 60 s reads nothing); `it('serves no @ anywhere in the detail')` (Review Focus 4: a store row written by hand with the principal `ops@northpeak.example` beside `Mara Lindqvist`: the detail serves `principals: ['Mara Lindqvist']`, and `JSON.stringify(body)` holds no `@`).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement**: the adapter, `validatorDetail`'s third parameter, the controller (inject D4's `DomainTomlsService` and `NETWORK_PROFILE`), `ValidatorsModule` importing `NamesModule`, the reference lines.
- [ ] **Step 4: Run the tests to verify they pass**, then `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-api-service test:e2e`.
- [ ] **Step 5: Commit.** `git add` the files above — `feat(api): the validator detail serves its domain's toml facts from the toml store`.

---

### Task 7: The `country` filter of the list

**Files:**
- Modify: `apps/api/src/validators/validators-query.ts` (`ListRequest`, `parseListQuery`, `selected`), `apps/api/src/validators/validators-query.spec.ts`, `apps/api/src/validators/validators.controller.ts` (`@ApiQuery` and the order comment), `docs/api-reference.md` (the parameter row and the order sentence), `apps/api/test/validators.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 2's `countryCodeOf`; Task 5's `DirectoryEntry.serverCountry`.
- Produces (Task 8): `ListRequest.country?: string` (an upper-case code, or `'unknown'`); checked after `q` and before `marker` (order `scope`, `publisher`, `amendment`, `q`, `country`, `marker`, `limit`): `'unknown'` in any case → `'unknown'`; else `countryCodeOf(value)`; else 400 `invalid country`. `selected` keeps, with a code, the entries whose `serverCountry` is it; with `'unknown'`, those without one; with the scope and the other filters.

- [ ] **Step 1: Write the failing tests.** `validators-query.spec.ts`: `it.each` `country=DE`, `de`, `UK` (→ `GB`), `unknown`, `Unknown`; `it('refuses any other country with 400 invalid country')` (`ZZ`, `DEU`, `Germany`, `EU`); `it('checks in the order scope, publisher, amendment, q, country, marker, limit')` (extend D1's case: a bad `q` wins over a bad `country`, a bad `country` over a bad `marker`); `it('filters by server country and by unknown, with the scope')`. E2e: `it('lists the validators of a country and those of unknown location')`; `it('lists none for a code with no validator')`; `it('answers 400 invalid country')`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement**, with the reference's row (`country` | | An ISO 3166-1 alpha-2 code, any case (`uk` is `GB`): only the validators whose `toml.server_country` is it. `unknown`, any case: only those without one. Anything else: 400 `invalid country`.) and the order sentence.
- [ ] **Step 4: Run the tests to verify they pass**, then the commands.
- [ ] **Step 5: Commit.** `git add` the files above — `feat(api): a country filter on the validators list`.

---

### Task 8: `GET /v2/network/validators/countries`

**Files:**
- Create: `apps/api/src/validators/countries-object.ts`, `apps/api/src/validators/countries-object.spec.ts`
- Modify: `apps/api/src/validators/validators-query.ts` (export `inScope`, `parseScope`), `apps/api/src/validators/validators.controller.ts` (the route, after `summary`, before `:key`), `apps/api/src/validators/api-reference.spec.ts` (the module and three objects), `docs/api-reference.md` (a section `### \`GET /v2/network/validators/countries\`` after the list's), `apps/api/test/validators.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 7's `ListRequest`, `selected`; Task 5's `serverCountry`; `instant`; `VALIDATORS_CACHE_CONTROL`, `routeCacheControl`.
- Produces:

```ts
// validators-query.ts
export function inScope(entry: Pick<DirectoryEntry, 'unl' | 'seen24h'>, scope: Scope): boolean; // the one scope rule, used by selected()
export function parseScope(query: Query): Scope;  // 'unl' by default; else 400 invalid scope
// countries-object.ts (pure)
export const COUNTRIES_KEYS = ['result', 'scope', 'validators', 'unl', 'located', 'unknown', 'count', 'countries', 'updated'] as const;
export const COUNTRY_KEYS = ['country', 'validators', 'unl'] as const;
export const UNKNOWN_KEYS = ['validators', 'unl'] as const;
export interface CountriesBody { result: 'success'; scope: Scope; validators: number; unl: number; located: number;
  unknown: { validators: number; unl: number }; count: number; countries: { country: string; validators: number; unl: number }[]; updated: string }
export function buildCountries(directory: Pick<Directory, 'ordered' | 'builtAt'>, scope: Scope): CountriesBody;
```

  Counted over `directory.ordered` entries `inScope`: `unl` of them on the UNL, `located` with a `serverCountry`, `unknown` the rest; `countries` one per code, `validators` desc, then `unl` desc, then `country`; `count` its length; `updated` `instant(builtAt / 1000)`. JSON only (no `@Csv`), other parameters ignored, `Cache-Control` as the list.

- [ ] **Step 1: Write the failing tests.** `countries-object.spec.ts`: `it('counts both scopes')`; `it('orders by validators, then unl, then code')`; `it('adds located and unknown up to validators')`; `it('counts the UNL members of each country and of unknown')`; `it('answers an empty directory with zeros and no country')`; `it('lists its keys in the order of the constants')`. E2e (both networks): `it('counts what the list lists, for every country and unknown, in both scopes')` (Review Focus 3: for each `countries[]` entry and `unknown`, `GET /v2/network/validators?scope=…&country=…&limit=1000` lists `validators` rows of which `unl` are on the UNL; a verified pair at `toml_version` 0 is in `unknown`); `it('reads nothing beyond the directory')` (the ClickHouse spy: a `/countries` and a `?country=DE` after a list request within 10 s make no query); `it('defaults to unl, refuses another scope, ignores other parameters')`; `it('is JSON with format=csv too')`; `it('sends Cache-Control: private, max-age=30')`; `it('answers an empty database: validators 0, no country')`; `it('is not read as a validator key')` (`/v2/network/validators/countries` is the aggregate, not 400 `invalid validator key`).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement**; the reference section (purpose, the parameter table, spec §4.4's example, the rules, the three `Keys of` lines `Keys of the countries answer, in order: …`, `Keys of a country, in order: …`, `Keys of unknown, in order: …`, errors, `Cache-Control`); `api-reference.spec.ts` checks `countries-object` among the modules and maps the three.
- [ ] **Step 4: Run the tests to verify they pass**, then the commands.
- [ ] **Step 5: Commit.** `git add` the files above — `feat(api): GET /v2/network/validators/countries`.

---

### Task 9: `/v2/toml/{domain}`'s validators through the same rules

**Files:**
- Modify: `apps/api/src/names/toml-object.ts` (D4's `tomlObject` and `TOML_VALIDATOR_KEYS`) and `toml-object.spec.ts`, `apps/api/test/toml.e2e-spec.ts` (D4's), `docs/api-reference.md` (the "Account names and tomls" section's key line of a `validators[]` entry, which D4's `apps/api/src/names/api-reference.spec.ts` ties to `TOML_VALIDATOR_KEYS`)

**Interfaces:**
- Consumes: Task 2's `validatorTomlEntryOf`.
- Produces: `TOML_VALIDATOR_KEYS = ['public_key', 'owner_country', 'server_country', 'network', 'unl']` (ruling R3); each `validators[]` entry's four facts come from `validatorTomlEntryOf(entry)`, absent when `''`. D4's other rules for the route (only entries that count on this network, `fields` never served) are unchanged.

- [ ] **Step 1: Write the failing tests.** The object's spec: `it('serves a validator entry through D8\'s rules')` (XRPL: `fields` `{"owner_country":"no","server_country":"Germany","unl":"http://x.example"}`, `network` `'main'` → `{ public_key, owner_country: 'NO', network: 'main' }`; Xahau: `network` `'21337'` → `network: '21337'`); `it('orders an entry public_key, owner_country, server_country, network, unl')`. `toml.e2e-spec.ts`: `it('gives a validator the same countries as the validator routes')` (a verified pair whose `validator_domains` row says `DE` at version 1, and the domain's store row whose entry for the key has `fields` `{"server_country":"de"}`: `/v2/toml/{domain}` and `/v2/network/validators/{key}` both say `DE`).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement**, and the key line of D4's section.
- [ ] **Step 4: Run the tests to verify they pass**, then the commands.
- [ ] **Step 5: Commit.** `git add` the files above — `feat(api): /v2/toml/{domain} reads its validators with the validator routes' rules` (body: spec §4.2's last point; the two routes never disagree on a country).

---

### Task 10: Docs, ADRs, the OpenAPI document, the full check and the deploy notes

**Files:**
- Modify: `docs/adr/0012-validators-and-amendments-data.md` (status line, an amendment section), `docs/adr/0010-ripple-v2-wire-compatibility.md` (an amendment with three items), `docs/adr/README.md` (the 0010 and 0012 rows), `docs/api-reference.md` (prose of the row's and the detail's `toml`; the compatibility list), `docs/syncer.md` ("Domain verification"), `docs/observability.md` (§4 metrics, §6 alert), `docs/security.md`, `docs/data-model.md` (`domain_tomls` is written by two workers), `docs/openapi.yaml` (regenerated)

**Interfaces:**
- Consumes: everything above.
- Produces: the documents; E13's Task 1 syncs `docs/openapi.yaml` and reads `docs/api-reference.md` from this branch.

- [ ] **Step 1: ADR-0012, amended in place** (spec decision 11; the ADR README's rule: "An amendment is appended to the ADR it amends and says so in its status line"). Status: `Accepted (2026-10-19). Amended 2026-10-24: validator toml details (D8, [design](../superpowers/specs/2026-10-24-validator-toml-details-design.md)).` Append `## Amendment (2026-10-24): validator toml details (D8)`: what is read of a verified file (the `[[VALIDATORS]]` entry's four fields and their rules; nothing else, nothing fetched), the domain-level facts from D4's store, the checker's write-through and the `toml_version` re-check, migration 016 (additive, deploy order migrate → syncer → API, rollback without undo), and its consequences (an API before the syncer: no `toml`, every validator unknown; emails never read). `docs/adr/README.md`: 0012's status "Accepted (amended: D8, validator toml details)".
- [ ] **Step 2: ADR-0010.** Read the highest `## Amendment N` (expected 9, D7's: D3 took 5, D4 6, D5 7, D6 8) and the highest item number; append `## Amendment N+1 (2026-10-24): validator toml details` with the next three items (spec §4.5): the `toml` key of a row and of the detail (added fields, the original's row unchanged); the `country` filter with its 400 `invalid country`; the new route `/v2/network/validators/countries` with its message `unable to retrieve validator(s)`. The README's 0010 row names it.
- [ ] **Step 3: The other documents** (spec §9): the api-reference's prose (the row's `toml`: when present, `{}`, the CSV columns and the `[Object]` column of an empty one; the detail's facts and when they are absent; the compatibility list of routes the original did not have); `syncer.md` "Domain verification" (what is read, the due rule, the store writes, the two metrics); `observability.md` (the two metrics; the alert `rate(syncer_validators_toml_store_writes_total{outcome="error"}[15m]) > 0` for 30 minutes); `security.md` (spec §8: still the safe fetcher; emails never read; a principal's name is the domain's publication, served as the toml says it); `data-model.md` (`domain_tomls` written by the `tomls` worker and the validators checker).
- [ ] **Step 4: Regenerate `docs/openapi.yaml`** with `docs/development.md` §8's commands, keeping its header comment; the diff adds `/v2/network/validators/countries` and the `country` parameter.
- [ ] **Step 5: The full check.** From the worktree root: `pnpm install` (only if `node_modules` is missing), `pnpm build`, `pnpm test`, `pnpm --filter @gatehub/data-api-shared test:e2e`, `pnpm --filter @gatehub/data-api-service test:e2e`, `pnpm --filter @gatehub/data-syncer test:e2e`: every one exits 0.
- [ ] **Step 6: Write the deploy notes** (in the commit body and the task report), per network (spec §7): (1) apply migration 016 (`pnpm ch:migrate`) before the syncer of this release starts; (2) deploy the syncer: the verified pairs are read again within a few passes (at most an hour), the store fills for validator-only domains; (3) deploy the API (an API before the syncer answers with no `toml` and every validator unknown, no error); (4) no reprocess, no backfill; (5) watch `syncer_validators_toml_fields_total{outcome="read"}` grow and the store-write alert stay quiet; (6) then E13's `VALIDATORS_MAP` may go on in that environment.
- [ ] **Step 7: Commit.** `git add docs/adr/0012-validators-and-amendments-data.md docs/adr/0010-ripple-v2-wire-compatibility.md docs/adr/README.md docs/api-reference.md docs/syncer.md docs/observability.md docs/security.md docs/data-model.md docs/openapi.yaml` — `docs: validator toml details (D8): ADR-0012 amendment, ADR-0010 items, reference, operations` (body: the deploy notes of Step 6).

---

## Rulings

- **R1 (spec §1.1 vs §3.2).** `ValidatorTomlEntry.invalid` names any of the four fields with the value as a log shows it (`{ field, shown }[]`), where the spec's type names the two country fields alone: its metric counts `invalid` for all four fields, and its log line quotes the value.
- **R2 (spec §1.1 vs §4.2).** The rules of §1.1 live in the shared package (`validatorTomlEntryOf`, Task 2), not in the syncer's `toml-match.ts`: §4.2 needs the same rules in the API for `/v2/toml/{domain}`. `matchToml` and the route both call it.
- **R3 (D4 §6 "D8 may add keys").** A `validators[]` entry of `/v2/toml/{domain}` is ordered `public_key, owner_country?, server_country?, network?, unl?`, the order of the row's `toml`; `network` goes before `unl`.
- **R4 (spec §2.1 vs §3.1).** Every row D8's checker writes has `toml_version = TOML_DETAILS_VERSION`, failures included, except a transient failure within D1's grace, which keeps `prev`'s facts and version (spec §3.1); the due rule (§3.3) reads only verified rows, so a failure's version is never acted on.
- **R5 (spec §5's bound, D4 §5.3).** The detail's store read is D4's `DomainTomlsService.get` (its 60 s cache and key read); D8 adds no read of its own and pins only that it is one keyed read, then none for 60 s.
- **Migration:** needed (spec §2.3), numbered `016` in build order after D7's `015`.
- **R6.** **`pnpm lint` is not run** (consistency pass): the repository has no ESLint configuration (`docs/development.md` §4; D-env's Global Constraints), so `eslint --fix` fails; the checks before a commit and at the end are `pnpm format`, `pnpm build`, `pnpm test` and the `test:e2e` suites.

**Interface the next plan relies on:** E13 reads `toml` on `GET /v2/network/validators` rows (`TOML_KEYS`: `owner_country?`, `server_country?`, `network?`, `unl?`) and on `GET /v2/network/validators/{key}` (`TOML_DETAIL_KEYS`, currencies `{ code, issuer? }`), as `docs/api-reference.md` documents them after Task 10, and its country table holds exactly Task 2's `ISO_COUNTRY_CODES`.
