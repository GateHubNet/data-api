# Validator toml details (D8): design

Status: proposed (2026-10-24), program 2, sub-project D8. Repository `data-api`, branch `feat/explorer-data-2`.

- Boards: `x-explorer/docs/superpowers/specs/2026-10-24-explorer-mock/Validators.dc.html` (the map "Where validators are", its
  countries table, "Unknown location: N", the attribution line, the Country filter, the country under each row) and
  `Validator.dc.html` (the card "From {domain}'s toml").
- Builds on: D1, `2026-10-19-validators-amendments-design.md` (the `validators` worker, `DomainChecker`, `matchToml`,
  `validator_domains`, the directory and the routes `/v2/network/validators[...]`); D4, `2026-10-24-display-names-design.md` (the
  per-domain toml store `domain_tomls`, `readToml`, `cleanTomlText`, `recordToml`, `DomainTomlsService`, `GET /v2/toml/{domain}`;
  its section 8 says what D8 reads; section 2.2 below).
- Its explorer half: E13, `x-explorer/docs/superpowers/specs/2026-10-24-validators-map-design.md`. Program overview:
  `x-explorer/docs/superpowers/specs/2026-10-24-explorer-program-2-overview.md`.

## Owner decisions to confirm

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Every fact comes only from a toml that **verified** (the manifest names the domain, and the file's `[[VALIDATORS]]` lists the master key), as D1's accounts do. An unverified domain's file is never read for anything, so its validator has an unknown location. | Keep |
| 2 | Country codes: the ISO 3166-1 alpha-2 codes assigned on 2026-10-24 plus `XK` (Kosovo, widely used, user-assigned); any case and surrounding spaces accepted; `UK` is read as `GB` (ISO reserves it for the United Kingdom). Anything else (`Germany`, `DEU`, `EU`, `ZZ`) counts as not given and is never served. | Keep |
| 3 | `GET /v2/network/validators/countries` is built for API clients. The explorer (E13) counts its map from the list it already loads, so a country's count always equals the rows its click shows; tests pin the route equal to that count. | Keep; the explorer can switch to the route with one call if preferred |
| 4 | `/v2/network/validators` gains a `country` filter (a code, or `unknown`), so the route and the list agree for every client. | Keep |
| 5 | Principals: names only. A name that contains `@` is dropped; at most 10, in file order. Emails are never stored, logged or served. | Keep |
| 6 | The validators domain checker writes every check of a file it fetched into D4's per-domain store (`domain_tomls`), failures included, so a domain only a validator names is in the store, and loses its content there when its file goes (D4's `tomls` worker fetches account domains only, as D4 §4.1 expects). | Keep |
| 7 | Verified pairs checked before D8 are due again (`toml_version`), so details appear within minutes of the deploy (at most an hour for a pair checked just before it), not up to 6 h later. | Keep |
| 8 | The toml's `network` and `unl` are served as the store keeps them (cleaned; `network` lower-cased by D4), as the toml's claims. Nothing checks them, a `unl` URL is never fetched, and the validator's entry is not filtered by D4's `countsOn` (the master key already names the validator; a `network` naming another network is shown, so the explorer can say so). | Keep |
| 9 | `toml` is the last key of a validator row, after `last_seen` (D1's order unchanged), and is `{}` when a file that verified gives none of the four fields. | Keep |
| 10 | The countries route's default scope is `unl`, like the list's. | Keep |
| 11 | The decision is recorded as an amendment of ADR-0012 (it changes what ADR-0012 says is read of a toml), not a new ADR. | Keep |

## Goal

Every fact the two boards show about a validator's toml is served by the validator routes, from the file that verified the
validator's domain: where the validator's server is and who owns it (countries), which network and UNL the toml says it follows, the
principals' names, when the file says it was last modified, and what else the domain's file lists (accounts, currencies). A new
aggregate counts the validators per server country.

## Scope

- Read, per validator, the `[[VALIDATORS]]` entry that lists its master key: `owner_country`, `server_country`, `network`, `unl`.
- Read, per domain (through D4's store): the principals' names, `[METADATA].modified`, the number of accounts listed, the currencies.
- Serve them as `toml` on the validator rows and the validator detail; add `country` to the list; add
  `GET /v2/network/validators/countries`.

## Non-goals

- `[[SERVERS]]`, `server_location`, `server_cloud`, `network_asn`, `attestation`, `[ORGANIZATION]`, `[METADATA].expires`, principals'
  emails and social fields. Nodes (and so `[[SERVERS]]`) are deferred by the owner.
- IP geolocation of any kind (no DB-IP, no node crawler). A validator's location is its toml's `server_country` or unknown.
- Checking the toml's claims: that the validator follows its `unl` or its `network`, that a currency exists on the ledger.
- History of a validator's countries; only the newest verified file counts.
- A `coverage` object: nothing here is derived from ledger history (the program's coverage shape is for history-derived lists).

## Facts this design relies on (checked 2026-10-24)

| # | Fact | Source |
| --- | --- | --- |
| T1 | `[[VALIDATORS]]` fields: `public_key` (base58 master key), `network` ("omitted means production"; `main`, `testnet`, others allowed), `owner_country`, `server_country` ("two-letter ISO-3166-2 country code", the page's example `"us"` is lower case), `unl` (an HTTPS URL of the list site the validator uses), plus `attestation`, `server_location`, `server_cloud`, `network_asn`. | xrpl.org `docs/references/xrp-ledger-toml` |
| T2 | `[METADATA].modified`: an offset date-time, `Z` and milliseconds recommended, zeros allowed for a hand-edited file. | same |
| T3 | `[[PRINCIPALS]]`: `name`, `email`, social handles. `[[CURRENCIES]]`: `code` (3 characters, 40 hex, or custom), `issuer`, `display_decimals`, `network`, `symbol`. `[[ACCOUNTS]]`: `address`, `network`, `desc`. | same |
| T4 | `xahau.toml` has the same sections (and `[ORGANIZATION]`); its `network` example is `"21337"` (Xahau mainnet's network ID); countries are "ISO-3166-2 country code". | `xahau.network/docs/infrastructure/identity/` |
| T5 | ISO 3166-1 alpha-2 is the two-letter country standard; ISO 3166-2 codes are subdivisions (`US-CA`). The docs' "ISO-3166-2" means the two-letter country code. `UK` is "exceptionally reserved" for the United Kingdom; `XK` is user-assigned and used for Kosovo by the EU and CLDR. | ISO 3166 Maintenance Agency |
| T6 | `smol-toml` (pinned 1.3.1; D4 moves the parse into the shared package, `readToml`) parses a TOML date or date-time into a `TomlDate`, a `Date` subclass that says whether it is a local date, a local date-time or an offset date-time. | the package's types; D4 §3.3 |

## 1. What is read from a verified toml

### 1.1 Per validator: its `[[VALIDATORS]]` entry

`matchToml(text, masterKey)` (`apps/syncer/src/validators/toml-match.ts`, on top of D4's `readToml` since D4) finds the first
`[[VALIDATORS]]` entry whose `public_key` equals the master key. It now also returns that entry's facts, only when the key is listed,
taken from the entry as `readToml` gives it (`public_key`, `network`, and `fields`, the JSON text of its other scalar keys):

| Field | From | Kept when | Stored as |
| --- | --- | --- | --- |
| `owner_country`, `server_country` | `fields` | `countryCodeOf(value)` gives a code (1.3) | the upper-case code; `''` when absent or not a code |
| `network` | the entry's `network` (D4: trimmed, lower-cased) | at most 32 characters | as stored (`main`, `testnet`, `21337`); `''` when absent |
| `unl` | `fields` | text that parses with `URL`, scheme `https:`, no user or password, at most 256 characters | the text; `''` otherwise |

The first matching entry wins; a second entry with the same key is ignored (today's rule). Nothing else of the entry is read
(`server_location`, `network_asn`, `attestation` stay in the store's `fields`). A Xahau file may write `network = 21337` bare: D4's
`readToml` keeps an integer `network` as its decimal text (D4 §1.2), so it is served as `"21337"`.

```ts
export interface ValidatorTomlEntry {
  ownerCountry: string;   // '' = not given or not a code
  serverCountry: string;
  network: string;
  unl: string;
  /** The country fields the file gives a value for that is not a code, for the metric and the log (1.3). */
  invalid: ('owner_country' | 'server_country')[];
}
export interface TomlMatch { listed: boolean; accounts: string[]; entry?: ValidatorTomlEntry } // `entry` only when listed
```

### 1.2 Per domain: through D4's store

The domain-level facts are the domain's, not a validator's, so they live in D4's per-domain toml store (2.2) and are read from it by
the API for the validator detail (4.2):

| Fact | Read from the store's current row of the domain (D4's `DomainTomlsService.get`) | Rule (D4 §3.3 applies it when it writes) |
| --- | --- | --- |
| Principals' names | `principals` | `[[PRINCIPALS]].name` through `cleanTomlText(name, 100)`, dropped when it contains `@`, without repeats, in file order, at most 10. `email` and every other key are never read. |
| Last modified | `modified` | `[METADATA].modified`: an offset date-time (its instant), a local date-time (read as UTC), a local date (00:00 UTC), or text in one of those ISO forms; dropped when before 2012-01-01 or more than a day after the fetch. |
| Accounts listed | `accounts` | their number (`accounts_listed`), every entry (D4 keeps valid classic addresses, a repeated one once), whatever its `network`, as D1's `domain_verification.accounts` (the addresses served, sorted, at most 10) takes them |
| Currencies | `currencies` | the entries that count on this network (D4's `countsOn`), `{code, issuer?}` in file order, at most 10 (`issuer` absent when D4 stored `''`); and their number (`currencies_listed`) |

The content is the row's as D4 keeps it: read at `fetched_at`, carried through a transient failure for 24 h, empty after a definite
one (D4 §1.2, §4.4).

### 1.3 Country codes

`packages/shared/src/validators/country.ts` (+ spec), used by the syncer (reading files) and the API (the `country` parameter):

- `ISO_COUNTRY_CODES: ReadonlySet<string>`: the 249 ISO 3166-1 alpha-2 codes assigned on 2026-10-24, and `XK`. A test pins its size
  (250), a sample of members (`US`, `DE`, `HK`, `XK`, `AQ`) and of non-members (`UK`, `EU`, `ZZ`, `AA`, `QM`, `XA`).
- `countryCodeOf(value: unknown): string | undefined`: a string, trimmed and upper-cased, `UK` read as `GB`; the result if it is in
  the set, else `undefined`. A string that is not a code is counted (`invalid`) and logged at `log` level once per change of a
  (validator, domain) pair's result, with the value quoted and cut to 16 characters, as D1 quotes manifest domains.

E13's generated country table holds the same 250 codes, from the same ISO list, written by hand on both sides (a new assignment is a
change to both).

### 1.4 Text from a file

Every text D8 serves has passed D4's `cleanTomlText(value, max)` (`packages/shared/src/tomls/toml-text.ts`, built by D4 to this
rule): a string, Unicode NFC, with the characters of the categories Cc and Cf removed (control characters, and the bidirectional
overrides and isolates, which could make a name read as another), runs of white space made one space, trimmed; `undefined` when
empty or longer than `max` code points. Nothing is cut: a text too long is not served, never a part of it.

## 2. Data model

### 2.1 `validator_domains` (D1, migration 002): five columns

The facts of 1.1 belong to the (validator, domain) pair whose check read them, so they go where its verdict is:

```sql
ALTER TABLE validator_domains
  ADD COLUMN IF NOT EXISTS owner_country  LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS server_country LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_network   String DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_unl       String DEFAULT '',
  ADD COLUMN IF NOT EXISTS toml_version   UInt8 DEFAULT 0;
```

- Engine, key and retention unchanged: `ReplacingMergeTree(checked_at)`, `ORDER BY (validation_public_key, domain)`, no partition, kept
  for ever (a few hundred rows). It is not a ledger table, so ADR-0007's ledger-index axis does not apply, and ingest recovery never
  touches it.
- The four facts are filled only on a `verified` row (like `accounts`) and are `''` on an `unverified` one.
- `toml_version` is what the checker read of the file: 0 for a row written before D8, `TOML_DETAILS_VERSION` (1, a constant of
  `packages/shared/src/validators/index.ts`) for every row D8's checker writes. A later change of what is read bumps it, and the
  verified pairs below it are checked again (3.3).
- `ValidatorDomainsRow` (`rows.ts`) gains `owner_country`, `server_country`, `toml_network`, `toml_unl`, `toml_version`.

### 2.2 D4's per-domain toml store

D4 builds the store D8 reads (`domain_tomls` in the network's database, `ReplacingMergeTree(checked_at)`, `ORDER BY domain`, one row
per check, the newest row the domain's current word; D4 §1.2), with everything D8 needs: `principals`, `modified`, `accounts`,
`currencies`, `validators` (`public_key`, `network`, `fields`), `fetched_at`. **D8 adds no column to it.** It uses:

- `readToml(text, profile)` (D4 §3.3) under `matchToml` (1.1); `countsOn` for the currencies (1.2);
- `recordToml(ch, { domain, tomlUrl, text, fetchedAt, recheckMs, profile })` (`packages/shared/src/tomls/toml-store.ts`), the `ok` row
  of a file in hand, and D4's `nextTomlRow(prev, check, now, recheckMs)` for a failed check (D4 §4.4), `prev` read with
  `readStoredTomls(ch, domains)` (the same file);
- `DomainTomlsService.get(domain)` in the API (the newest row, kept 60 s) for the detail (4.2).

**The checker writes its checks into the store** (decision 6), once per fetched domain in `checkDomain`, after `record` has written
the verdicts of its validators:

| Fetch | Store row |
| --- | --- |
| The text read as TOML (whatever the verdict for its validators: the file is the domain's newest) | `recordToml(...)`, `recheckMs` D4's `GH_TOML_RECHECK_MS` |
| A fetch failure or `toml_invalid` | D4's `nextTomlRow(prev, check, ...)`, `prev` the store's current row of the domain (one keyed read, D4's `readStoredTomls(ch, [domain])`) |
| `domain_invalid`, `manifest_unverified` (no fetch) | nothing |

So a domain named by a validator's manifest and by no account's `Domain` is in the store (D4's `tomls` worker fetches account domains
only, D4 §4.1), its content goes when its file goes, and a domain named by both has one current row, the newest check whoever made it.
A failed store write is logged and counted (`syncer_validators_toml_store_writes_total{outcome="error"}`) and does not fail the pass:
the verdicts are already written, and the next check writes the store again.

### 2.3 Migration

The next migration (`packages/shared/schema/`, number by the plan; after D4's, which creates `domain_tomls`): the `ALTER` of 2.1 alone.
It is idempotent, ends with its semicolon on its last line, and no other line ends with one (the runner's splitter). No shared-database
migration: nothing here is global (countries are a network's validators').

## 3. The domain checker (`apps/syncer/src/validators/domain-checker.ts`)

### 3.1 The check

- `judge(text, key)` returns `{ reason: '', accounts, entry }` for a listed key; `DomainCheck` gains `entry?: ValidatorTomlEntry`.
- `nextDomainRow(prev, check, now, recheckMs)` writes the entry's four facts and `toml_version = TOML_DETAILS_VERSION`:
  - `verified`: the facts of this check;
  - a definite failure: `''` for the four, as for `accounts`;
  - a transient failure within 24 h of the last success (D1's grace, still `verified`): the facts **and** `toml_version` of `prev`,
    unchanged, as `accounts` are; after 24 h, `''`.
- The store write (2.2) runs in `checkDomain` once per fetched domain, after `record` has written the rows of its validators.

### 3.2 Metrics and logs

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `syncer_validators_toml_fields_total` | Counter | `field` (`owner_country`, `server_country`, `network`, `unl`), `outcome` (`read`, `absent`, `invalid`) | Per verified check, what the entry gave |
| `syncer_validators_toml_store_writes_total` | Counter | `outcome` (`ok`, `error`) | Write-through inserts (2.2) |

A change of a pair's server country is logged with the result change D1 already logs (`Validator nHU…: domain "x.example" is verified,
server country DE`). Values from the file are quoted and cut (1.3); a principal's name is never logged. Alert (in
`docs/observability.md`): `rate(syncer_validators_toml_store_writes_total{outcome="error"}[15m]) > 0` for 30 minutes.

### 3.3 Which pairs are due

D1's rule (no row, or `next_check_at` passed) gains: **a `verified` row whose `toml_version` is below `TOML_DETAILS_VERSION` and
whose `checked_at` is more than an hour old** (`DOMAIN_TRANSIENT_RECHECK_S`). `storedDomains` reads `argMax(toml_version,
checked_at)`. Such pairs sort with the never-checked ones (first), within D1's limit of 100 checks a pass, a pass a minute: the verified
XRPL validators (about 150) are read again within two passes of the deploy, those checked in the hour before it within the hour after.
The hour stops a pair whose re-check met a transient failure (D1's grace keeps it `verified` with `prev`'s `toml_version`, 0) from being
fetched every minute while its website is down: it waits the transient hour, as D1's rule has it. Unverified pairs keep their schedule
(nothing would be read of their files).

## 4. Endpoints

### 4.0 The directory

- `readDomains` (`validator-directory.service.ts`) reads, per (key, domain), `argMax(owner_country, checked_at)`,
  `argMax(server_country, checked_at)`, `argMax(toml_network, checked_at)`, `argMax(toml_unl, checked_at)`,
  `argMax(toml_version, checked_at)`, with aliases unlike the column names (D1's rule).
- `DomainRow` gains `ownerCountry`, `serverCountry`, `tomlNetwork`, `tomlUnl`, `tomlVersion`; `DomainState` gains
  `toml?: { ownerCountry?, serverCountry?, network?, unl? }`, set only when the state is `verified` and `tomlVersion ≥ 1` (an empty
  object when all four are `''`).
- `DirectoryEntry` gains `toml?` (from its `domainState`) and `serverCountry?` (its `toml.serverCountry`), which the `country` filter
  and the countries route read.

### 4.1 `toml` on a validator row (`GET /v2/network/validators`, and the detail)

The last key of the row, after `last_seen`. `VALIDATOR_ROW_KEYS` gains `toml`; `TOML_KEYS = ['owner_country', 'server_country',
'network', 'unl']`.

```json
      "first_seen": "2026-07-21T08:00:12.004Z",
      "last_seen": "2026-10-24T15:42:51.204Z",
      "toml": { "owner_country": "NO", "server_country": "DE", "network": "main", "unl": "https://vl.ripple.com" }
    }
```

- Present when the domain is `verified` and was checked by D8's checker (`toml_version ≥ 1`); absent otherwise (no domain, `pending`,
  `unverified`, or verified before D8 and not checked again yet). `{}` when that file's entry gives none of the four.
- Each key absent when the file gives no valid value (1.1). Codes are upper-case ISO 3166-1 alpha-2.
- CSV: the flattening gives `toml.owner_country`, `toml.server_country`, `toml.network`, `toml.unl` columns.

### 4.2 `toml` on the validator detail (`GET /v2/network/validators/{key}`)

The row's `toml`, followed by the domain's facts from D4's store (1.2):

```json
  "toml": {
    "owner_country": "NO",
    "server_country": "DE",
    "network": "main",
    "unl": "https://vl.ripple.com",
    "principals": ["Mara Lindqvist", "Tomas Okafor"],
    "modified": "2026-10-02T00:00:00Z",
    "accounts_listed": 3,
    "currencies": [
      { "code": "USD", "issuer": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" },
      { "code": "EUR", "issuer": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }
    ],
    "currencies_listed": 2,
    "fetched": "2026-10-24T12:00:04.511Z"
  },
  "manifest": { "sequence": 4, "signing_key": "n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy", "signing_keys_seen": 4,
                "domain": "northpeak.example" },
```

- `TOML_DETAIL_KEYS = ['owner_country', 'server_country', 'network', 'unl', 'principals', 'modified', 'accounts_listed',
  'currencies', 'currencies_listed', 'fetched']`; `CURRENCY_KEYS = ['code', 'issuer']`.
- The domain's facts are added only where the row has `toml`, from the store's current row of the domain (lower case) when its
  content is in effect (`fetched_at` not NULL); otherwise they are all absent. `principals`, `currencies` absent when empty;
  `accounts_listed`, `currencies_listed` absent when 0; `modified` in the wall-time form `YYYY-MM-DDTHH:mm:ssZ`; `fetched` (the
  store's `fetched_at`) in the instant-of-receipt form, as D1 writes `checked`.
- Read with D4's `DomainTomlsService.get(domain)` (one keyed read of `domain_tomls`, kept 60 s); `ValidatorsModule` imports D4's
  module for it, and `validatorDetail` takes the row it returns. A failed read answers 500 `unable to retrieve validator(s)`, as any
  read of the route.
- D4's `GET /v2/toml/{domain}` serves `validators[]` with `owner_country?`, `server_country?` and `unl?` ("D8 may add keys"): D8 puts
  them through the same rules (1.1: `countryCodeOf`, the `unl` URL check) and adds `network?`, so the two routes never disagree on a
  validator's country.

### 4.3 `country` on `GET /v2/network/validators`

| Parameter | Default | Meaning |
| --- | --- | --- |
| `country` | | An ISO 3166-1 alpha-2 code, any case (`countryCodeOf`, so `uk` is `GB`): only the validators whose `toml.server_country` is it. `unknown` (any case): only those without one. Anything else: 400 `invalid country`. |

Checked after `q` and before `marker` (the order becomes `scope`, `publisher`, `amendment`, `q`, `country`, `marker`). It applies with
the scope and the other filters, on the cached directory, like them. A code with no validator lists none.

### 4.4 `GET /v2/network/validators/countries`

The validators of a scope per server country. Registered before `:key` in `validators.controller.ts`, as `summary` is.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `scope` | `unl` | As the list's: `unl`, the trusted UNL; `all`, the trusted UNL and every validator seen in the last 24 hours. Else 400 `invalid scope`. |

Other parameters are ignored. JSON only. Example (`scope=all` on XRPL; three of the 22 countries shown):

```json
{
  "result": "success",
  "scope": "all",
  "validators": 142,
  "unl": 35,
  "located": 125,
  "unknown": { "validators": 17, "unl": 1 },
  "count": 22,
  "countries": [
    { "country": "US", "validators": 27, "unl": 6 },
    { "country": "DE", "validators": 16, "unl": 5 },
    { "country": "NL", "validators": 10, "unl": 3 }
  ],
  "updated": "2026-10-24T15:42:53.002Z"
}
```

- `COUNTRIES_KEYS = ['result', 'scope', 'validators', 'unl', 'located', 'unknown', 'count', 'countries', 'updated']`;
  `COUNTRY_KEYS = ['country', 'validators', 'unl']`; `UNKNOWN_KEYS = ['validators', 'unl']`.
- `validators`: the scope's validators (the list's rows with the same `scope` and no filter); `unl`: of them on the trusted UNL;
  `located`: of them with a `toml.server_country`; `unknown`: the others (no domain, a domain not verified or not read yet, no valid
  `server_country`), with how many of them are on the UNL. `located + unknown.validators = validators`.
- `countries[]`: one entry per code with at least one validator; `validators` desc, then `unl` desc, then `country`. `count` is its
  length. Every count of the answer is what the list gives with the same `scope` and `country` (4.3); e2e tests pin that.
- `updated`: when the directory was built (the summary's `updated`).
- Built by `buildCountries(directory, scope)` (`apps/api/src/validators/countries-object.ts`, pure, + spec) from the cached directory:
  no read of its own.
- `Cache-Control: private, max-age=30` (`VALIDATORS_CACHE_CONTROL`, while `GH_CACHE_CONTROL` is not empty). Errors: 400 `invalid scope`;
  500 `unable to retrieve validator(s)`.

### 4.5 What `data.ripple.com` had

The original had no countries, no `toml` and no `country` filter. ADR-0010 gets three new items (numbers by the plan): the `toml` key
of a validator row and of the detail (added fields, the original's row unchanged), the `country` filter with its 400
`invalid country`, and the new route `/v2/network/validators/countries` with its message `unable to retrieve validator(s)`.

## 5. Performance and query bounds

| Read | Size | When |
| --- | --- | --- |
| Directory: `validator_domains` with five more `argMax` columns | a few hundred rows | each build (at most 1 per 10 s per replica), as today |
| Countries | in memory over the cached directory, O(validators) | per request |
| Detail: the store's row of one domain (D4's `DomainTomlsService.get`) | one granule per part (`ORDER BY domain`) | per detail request, kept 60 s per domain |
| Syncer: `storedDomains` with `toml_version` | the pairs of the pass's keys | once a pass, as today |
| Syncer: the store's current row of a domain whose fetch failed (for `nextTomlRow`) | one granule per part | per failed fetch (a handful a pass) |

Tests pin: D4's bound for `DomainTomlsService.get` (`read_rows` ≤ `index_granularity` × parts, EXPLAIN shows the key), now also
reached from the validator detail; `/countries` and a `country` filter make no ClickHouse query beyond the directory's (a spy on
`ClickHouseService.query` in the e2e suite); the directory's reads keep D1's bounds.

## 6. XRPL, Xahau and the sandbox

- The file is `/.well-known/xrp-ledger.toml` on XRPL and `/.well-known/xahau.toml` on Xahau (D1's network profile, `tomlPath`); the
  rules are the same. Xahau files often write `network` as a network ID (`21337`, bare or quoted): it is served as text, `"21337"`.
- The sandbox runs on XRPL Testnet and Xahau Testnet (D-env): the same code reads the testnets' validators' files; their `network` is
  typically `testnet` or `21338`. Nothing in D8 depends on the network but the file name.

## 7. Backfill, rollout and coverage

- **Nothing to re-ingest**, no parser version: nothing comes from ledgers.
- **Filling**: after the syncer starts, the verified pairs are due again (3.3) and are read within a few passes (minutes; at most an hour
  for a pair checked just before the deploy). Until a pair is read, its row has no `toml` and its validator counts as unknown. A new
  validator's facts come with its first verified check. The store fills for validator-only domains as the same checks run.
- **Deploy order**: migrate (the next migration), then the syncer, then the API. An API deployed first finds `toml_version` 0 everywhere:
  no `toml`, every validator unknown, no error. Rolling back the API removes the fields and the route; the columns need no undo.
- **The explorer's switch** `VALIDATORS_MAP` goes on in an environment once its data API serves D8 on both networks and
  `syncer_validators_toml_fields_total{outcome="read"}` has grown there (E13 Rollout).

## 8. Security and privacy

- Still D1's safe fetcher, unchanged, and still only the file named by a verified manifest's domain. Nothing in a file is fetched or
  followed: not `unl`, not a currency's issuer.
- More of the file is read, always as data: parsed with `smol-toml` (D4's `readToml`), never evaluated; every text cleaned (1.4) and
  length-bounded; codes checked against a fixed set. The API serves them as text; the explorer renders them as text.
- **Emails are never read** from `[[PRINCIPALS]]` (D4 reads only `name`, and drops a name with `@`), so no address reaches a table, a log
  or an answer. A principal's name is the domain's own publication (its file is public, and verified); it is served as the toml says
  it, never as GateHub's word. `docs/security.md` says so.
- The store write adds no fetch: the checker writes what it fetched anyway, so D4's egress figures are unchanged by D8.

## 9. Documentation to update (in the same change)

- `docs/api-reference.md`, "Validators and amendments": the row's `toml` (keys, rules, the `{}` case, the CSV columns), the detail's
  `toml`, the `country` parameter and its 400, the new route with its example, keys and rules.
- `docs/adr/0012-validators-and-amendments-data.md`: an amendment (D8) that the verified file's `[[VALIDATORS]]` entry is read, that the
  domain-level facts come from D4's store, and that the checker writes its checks there; `docs/adr/0010-...md`: the three items of 4.5.
- `docs/data-model.md` (the five columns; `domain_tomls` written by two workers), `docs/syncer.md` ("Domain verification": what is read,
  the due rule, the store writes), `docs/observability.md` (two metrics, one alert), `docs/security.md` (8), `docs/openapi.yaml`, and
  D4's section of the api-reference for `/v2/toml/{domain}`'s `validators[]` (4.2).

## 10. Testing

**Unit (shared, syncer, api)**

- `country.spec.ts`: the set (size, members, non-members); `countryCodeOf`: `"us"`, `" de "`, `"UK"` → `GB`, `"XK"`, `"EU"`, `"DEU"`,
  `"Germany"`, `"US-CA"`, `""`, a number, `null`.
- `toml-match.spec.ts`: the entry's four fields (valid, absent, invalid type, lower-case code, invalid code counted in `invalid`,
  `network` as an integer, `unl` with `http:`, with credentials, too long), the first of two entries with the key, no `entry` when the
  key is not listed, nothing read from another validator's entry. (`cleanTomlText`, principals and `modified` are D4's tests.)
- `domain-checker.spec.ts`: `nextDomainRow` writes the facts and `toml_version` on `verified`, clears them on a definite failure,
  keeps `prev`'s through a transient failure within 24 h and clears them after; the due rule (a verified row with `toml_version` 0
  checked more than an hour ago is due; one checked 10 minutes ago, and an unverified one, are not); the store write once per fetched
  domain, after the verdicts (`recordToml` for a file read as TOML, `nextTomlRow` for a failure, nothing for `domain_invalid` and
  `manifest_unverified`), and a failing store write counted, not failing the pass; the metrics' labels.
- `countries-object.spec.ts`: both scopes, the order, `located + unknown = validators`, `unl` counts, an empty directory, key order.
- `validators-query.spec.ts`: `country` (code, lower case, `UK`, `unknown`, `Unknown`, invalid, the check order after `q`).
- `validator-object.spec.ts`: `toml` last in the row, absent / `{}` / full; the detail's extras, their absent cases, key order.

**End to end (testcontainers ClickHouse)**

- `packages/shared/test/migrate.e2e-spec.ts`: the new migration applies after D4's, twice, and after a half-applied run.
- `apps/syncer/test/validators.e2e-spec.ts`: with the local HTTPS server and hand-written files (`xrp-ledger.toml` and `xahau.toml`
  fixtures with countries in lower case, an invalid code, `UK`, a Xahau `network = 21337`, principals with an email and a name with `@`,
  `modified` as a local date): the `validator_domains` columns and `toml_version`, a row of 002 (`toml_version` 0, verified, checked
  two hours ago) checked again in the next pass, the store's `ok` row written for a domain only a validator names, and its `failed`
  row (content gone) once that file answers 404.
- `apps/api/test/validators.e2e-spec.ts`, both networks: `toml` on rows and the detail (store facts present; absent without a store
  row and after a definite failure), D4's `/v2/toml/{domain}` `validators[]` with the same codes, CSV columns, `country` (each code of `/countries`, `unknown`, 400), `/countries` for both scopes with its counts equal to the
  list's for every country, `Cache-Control`, unknown parameters ignored, 400 `invalid scope`, an empty database (`validators` 0,
  `countries` empty), key orders; the read bounds of 5.
- **Fixtures**: no ledgers or transactions to record; the toml files are written by hand (real domains change), and
  `packages/shared/test/fixtures/README.md` lists them.

## Dependencies

- **D4** (built before D8): `domain_tomls`, `readToml`, `cleanTomlText`, `countsOn`, `recordToml`, `nextTomlRow`,
  `readStoredTomls`, `DomainTomlsService` and `/v2/toml/{domain}` (2.2), with D4's names. D8's migration comes after D4's.
- **D1** as built on this branch (the `validators` worker, the directory, the routes); PR #20 only through D4 and the numbering of
  migrations.
- **E13** reads `toml` on the list and the detail and filters by `toml.server_country` in the Worker.
