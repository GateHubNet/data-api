# Display names: account toml checks, the toml store and the names batch (D4): design

Status: proposed (2026-10-24), program 2, sub-project D4. Repository `GateHubNet/data-api`, branch `feat/explorer-data-2` (stacked on
PR #20, `feat/account-investigation-data`).

- **Boards** (x-explorer `docs/superpowers/specs/2026-10-24-explorer-mock/`): `AccountNames.dc.html` (the four states, "How we know",
  the transaction table with names), `Account.dc.html` (names in every table, the header's domain line), `Delegation.dc.html` and
  `Validator.dc.html` (names in context; the validator's toml card), `Token.dc.html` (the `[[CURRENCIES]]` card, for D6).
- **Related specs**: spec #4 / ADR-0014 (PR #20: `account_names`, `account_labels`, `account_network_names`, `account_states`);
  `2026-10-19-validators-amendments-design.md` (D1: the safe fetcher §8.1, domain verification §2.2); the explorer's
  `2026-10-24-display-names-design.md` (E9, which reads what this adds); `2026-10-24-validator-toml-details-design.md` (D8) and
  `2026-10-24-issued-tokens-design.md` (D6), which read the toml store (section 8); the program overview
  (x-explorer `docs/superpowers/specs/2026-10-24-explorer-program-2-overview.md`).

## Owner decisions to confirm

| # | Decision | Recommendation |
|---|---|---|
| 1 | A sixth syncer worker, `tomls`, fetches the toml of every domain an account names (default `GH_WORKERS` gains it; `GH_DOMAIN_VERIFICATION=false` idles it). Outbound HTTPS grows from ~150 validator domains to every domain accounts name: tens of thousands of hosts. | Accept |
| 2 | A Domain names a domain only when its bytes are printable ASCII and, lower-cased, pass rippled's `isProperlyFormedTomlDomain`. `https://x.com`, a path, an IP, an IPFS hash name no domain and give no display name. | Accept (xrpl.org: "must match exactly") |
| 3 | An `[[ACCOUNTS]]` entry counts on a network when its `network` is absent or one of the network's names (XRPL `main`, `mainnet`; Xahau `main`, `mainnet`, `xahau`, `21337`; the testnets' from D-env). | Accept |
| 4 | The verified name is the entry's `desc` cleaned (`cleanTomlText`); a `desc` longer than 64 characters is not a name and the domain is used instead (nothing is cut). A `desc` can claim any name, so `domain` is always in the answer and the explorer shows it on hover. | Accept |
| 5 | An account network name without an account name is the display name (kind `account`); the settled order has no slot for it otherwise. | Accept |
| 6 | Re-checks: a toml read OK, after 24 h; a domain more accounts name than at its last check, at once (at most hourly); a transient failure (DNS, connect, TLS, timeout, 5xx, 429), after 1 h, the last good content kept 24 h; a definite failure, after 1, 2, 4, then 7 days. | Accept |
| 7 | Current domains come from a new ledger-derived table, `account_domains`, that keeps the newest row of each account (`ReplacingMergeTree(version)` ordered by account): a deliberate exception to ADR-0007's unique-key rule, safe because every deleted ledger is rewritten. A one-off SQL seed from `account_states` fills it for the ledgers PR #20's parsers wrote: no re-ingest. | Accept |
| 8 | Coverage: an account whose Domain was set before the state history starts and whose root has not changed since has no domain (so no verified name) until it changes or the history is complete (ADR-0015). The names answer carries no `coverage`. | Accept |
| 9 | The toml store keeps `[[ACCOUNTS]]`, `[[CURRENCIES]]`, `[[VALIDATORS]]`, `[[PRINCIPALS]]` names and `[METADATA]` `modified`/`expires`; never a principal's email or social handle, never `[[SERVERS]]` or `[ORGANIZATION]`; `expires` is kept, not acted on. Nothing in a toml is ever fetched. | Accept |
| 10 | A second new route, `GET /v2/toml/{domain}` (the boards' caption), serves what a domain's toml says as stored; the API never fetches on request. | Accept |
| 11 | The batch answers each requested address at its place: a repeated address is answered twice and counts towards the 100; an X-address is refused (400 `invalid ripple address`). | Accept |
| 12 | The batch's key is `labels` (the program's contract) where `/v2/accounts/{address}` says `account_labels`; the object is the same. | Accept |
| 13 | One new ADR for D4 (number by the plan) that amends ADR-0014 (a lookup endpoint after all) and gives ADR-0012's safe fetcher its second user; ADR-0014's status line says so. | Accept |
| 14 | Until an api has loaded the toml directory once, a domain gives no display name (unknown is not "not verified"); a failed `account_domains` read fails the batch (500) rather than answer without domains. | Accept |

## Goal

Every address the explorer shows can be shown by name. The data API (1) learns the current domain of every account from the ledger,
(2) reads that domain's toml through the safe fetcher and keeps what it says per domain, (3) decides each address's **display name**
(verified name, else account name, else unverified domain) and serves it for up to 100 addresses in one call, with the labels, and
(4) serves a domain's stored toml for the account page's "How we know", the validator card (D8) and the token page (D6).

## Scope and non-goals

In scope: the table of account domains and its parser, the `tomls` worker, the per-domain toml store and its writer, `GET
/v2/account_names`, `GET /v2/toml/{domain}`, the docs, ADR and tests.

Not in scope: search by name (needs a name index); editing names (ADR-0014's later admin service); a validator's toml details and
writing validator domains into the store (D8); the token answer built from `[[CURRENCIES]]` (D6); `[[SERVERS]]` (nodes deferred);
attestations; following any URL a toml holds (icons, attestation links, `unl`); names on `/v2/accounts/{address}` beyond PR #20; the
full-history backfill (ADR-0015's history spec).

## Terms

The glossary words: **display name**, **verified name**, **account name**, **account network name**, **unverified domain**, **label**,
**toml**, **principal** (x-explorer `GLOSSARY.md`). Two more, used below (proposed for `GLOSSARY.md`):

- **Account domain**: the domain an account's Domain field names, when it is one (decision 2), lower-cased.
- **Toml store**: what each domain's toml said at its last read, one row per domain and network (`domain_tomls`).

## 1. Data model

The next migration of `packages/shared/schema/` adds both tables (`IF NOT EXISTS`, runner constraints as in every file). Nothing is
added to the shared database: a toml is per network (`xrp-ledger.toml` and `xahau.toml` are different files) and so is an account's
Domain. `Table` gains `AccountDomains = 'account_domains'` and `DomainTomls = 'domain_tomls'`; `rows.ts` gains `AccountDomainsRow` and
`DomainTomlsRow`.

### 1.1 `account_domains` (ledger-derived, P7, `ORDER BY account`)

```sql
CREATE TABLE IF NOT EXISTS account_domains
(
  account      String,
  ledger_index UInt32,
  tx_index     UInt32,
  node_index   UInt16,
  version      UInt64,
  domain_hex   String,
  deleted      UInt8
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY account
SETTINGS non_replicated_deduplication_window = 1000, index_granularity = 1024;
```

- **A row** for each AccountRoot node of a transaction's metadata that has or had a Domain (3.1): `domain_hex` is the Domain after the
  transaction exactly as the ledger holds it (upper-case hex), `''` when it has none; `deleted` 1 for a deleted node.
- **`version`** = `ledger_index · 2^32 + tx_index · 2^16 + node_index` (a ledger has fewer than 65,536 transactions), written as text
  (it passes 2^53). The newest row of an account is its current domain; readers take `argMax(…, version)` and never `FINAL`.
- **Why `ORDER BY account` and not the unique key** (decision 7). A row is written for every change of an account that has a domain, so
  that an account whose Domain was set before the indexed history is learnt at its next change (a payment received is enough). Kept
  whole, that is a sizeable share of `account_states` (billions of rows over the full history), and the worker reads the current
  domain of every account (4.1). Ordered by account, merges keep one row per account and partition: about the number of accounts with
  a domain, times the partitions they were active in (low millions on XRPL, to be measured in the sandbox). Recovery and `--reprocess`
  delete by `ledger_index` and always write the deleted ledgers again, and the parser is deterministic, so a row merged away under a
  deleted one comes back with it. The table is in `LEDGER_KEYED_TABLES` (P7) and `CHILD_TABLES`.
- **`index_granularity = 1024`**: the batch reads up to 100 accounts by key (5.3); a granule of 1,024 rows keeps that read under
  ~100 k rows. `transactions` uses the same setting.

### 1.2 `domain_tomls` (written by the `tomls` worker, `ORDER BY domain`)

```sql
CREATE TABLE IF NOT EXISTS domain_tomls
(
  domain        String,
  toml_url      String,
  status        LowCardinality(String),
  reason        LowCardinality(String),
  status_code   UInt16,
  checked_at    DateTime64(3, 'UTC'),
  fetched_at    Nullable(DateTime64(3, 'UTC')),
  next_check_at DateTime('UTC'),
  failures      UInt16,
  modified      Nullable(DateTime('UTC')),
  expires       Nullable(DateTime('UTC')),
  accounts      Array(Tuple(address String, network String, desc String)),
  currencies    Array(Tuple(code String, issuer String, network String, fields String)),
  validators    Array(Tuple(public_key String, network String, fields String)),
  principals    Array(String)
)
ENGINE = ReplacingMergeTree(checked_at)
ORDER BY domain;
```

- One row per check. The newest row of a domain (largest `checked_at`) is its current word; merges keep it, and readers take
  `ORDER BY domain, checked_at DESC LIMIT 1 BY domain` or `argMax`, never `FINAL` (as `validator_domains`). Not ledger-derived: no
  partition, no dedup window, not in `LEDGER_KEYED_TABLES`.
- `domain` lower case; `toml_url` `https://{domain}{tomlPath}` (`/.well-known/xrp-ledger.toml`, on Xahau `/.well-known/xahau.toml`).
- `status` `ok` (fetched and read as TOML) or `failed`; `reason` `''` for `ok`, else the safe fetcher's failure (`dns_error`,
  `connect_error`, `tls_error`, `timeout`, `http_status`, `too_large`, `redirect_rejected`, `blocked_address`, `domain_invalid`) or
  `toml_invalid`; `status_code` the HTTP status of an `http_status`, else 0. `failures` counts consecutive failed checks.
- **The content** (`modified` to `principals`) is what the domain's toml says **in effect**: read at `fetched_at`; carried over by a
  transient failure within 24 h of `fetched_at`; empty, with `fetched_at` NULL, otherwise (4.4). A reader uses the content as it is.
- `fields` is the JSON object text of an entry's other scalar keys (3.3), for D6 and D8; `network` is the entry's `network` as
  written (a string trimmed and lower-cased, or an integer as its decimal text: Xahau files may write `network = 21337` bare), `''`
  when absent or of another type. Entries of every network are kept; readers filter (3.4).

## 2. Configuration and profile

- `NetworkProfile` gains `tomlNetworkNames: readonly string[]`, the `network` values that name it (decision 3), added by D4 to all four
  of D-env's profiles: `xrpl` `['main', 'mainnet']`, `xahau` `['main', 'mainnet', 'xahau', '21337']`, `xrpl-testnet` `['testnet']`,
  `xahau-testnet` `['testnet', '21338']`. The testnets keep D-env's two `tomlPath`s.
- Syncer: `WORKER_NAMES` gains `tomls` (last); `GH_WORKERS` defaults to `ingest,validations,fee_stats,aggregator,validators,tomls`. New
  `GH_TOML_RECHECK_MS` (default `86400000`, 24 h, at least 1): when a toml read OK is read again. Shared with D1:
  `GH_DOMAIN_VERIFICATION` (`false`: the worker starts, logs once that it is off, and checks nothing) and
  `GH_DOMAIN_FETCH_TIMEOUT_MS` (10 s). Fixed in code: the cadences and limits of section 4.
- API: nothing new. `GH_NAMES_AND_LABELS_RELOAD_MS` (60 s) also reloads the toml directory (5.3).

## 3. Parsing

### 3.1 `AccountDomainsParser` (`packages/shared/src/parsers/account-domains.parser.ts`)

Pure, like `AccountStatesParser`, whose node walk it shares. For each node of `meta.AffectedNodes` whose `LedgerEntryType` is
`AccountRoot`, in order:

| Node | Row when | `domain_hex` | `deleted` |
|---|---|---|---|
| `CreatedNode` | `NewFields.Domain` is set (no transaction does this today) | `NewFields.Domain` | 0 |
| `ModifiedNode` with `PreviousFields` | `FinalFields.Domain` or `PreviousFields.Domain` is set | `FinalFields.Domain`, else `''` | 0 |
| `DeletedNode` | `FinalFields.Domain` or `PreviousFields.Domain` is set | `''` | 1 |

- Why both sides: rippled lists a changed field's old value in `PreviousFields`, but a field that was **added** is not there (it had
  no old value), and a **removed** one is only there. So a Domain set for the first time shows as `FinalFields.Domain` alone, a cleared
  one as `PreviousFields.Domain` alone, a changed one as both, and any other change of an account with a domain as `FinalFields.Domain`
  alone. Every case writes the Domain after the transaction.
- A `ModifiedNode` without `PreviousFields` was only threaded and changed nothing: no row (as `account_states`). The result of the
  transaction does not matter (a failed transaction still changes the sender's root). A `Domain` that is not text, or not hex, is
  written as `''` and counted in the build's warnings, never thrown.
- Edge cases covered by tests: `AccountSet` setting, changing, clearing (`Domain: ""`) and repeating the same Domain; a payment that
  activates an account (no Domain, no row); an `AccountDelete` of an account with a domain; a payment received by a dormant account
  with a domain (the row that teaches the domain); a failed transaction; Xahau's `Import`, `SetHook` and `GenesisMint` (generic, no
  special case). No amendment matters: Domain exists from the first ledger; `AccountDelete` (XRPL `DeletableAccounts`) only adds
  deleted rows.

`buildLedgerRows` writes the rows (`accountDomains` in `LedgerRows`, `Table.AccountDomains` in `CHILD_TABLES`). A new parser version
(`PARSER_VERSION` moves; the plan numbers it), with its own constant `DOMAIN_PARSER_VERSION` and a line in the `rows.ts` history.

### 3.2 `accountDomainOf(hex)` (`packages/shared/src/tomls/account-domain.ts`)

The one rule for "the account domain" (decision 2), used by the worker and the api: `hex` of even length, at most 512 digits (the
Domain field holds at most 256 bytes); every byte printable ASCII (0x21 to 0x7E, so no space); the text lower-cased; the result when
`isProperlyFormedTomlDomain` accepts it, else `undefined`. Nothing is trimmed: the explorer's own `decodeDomain` shows the raw text.

### 3.3 Reading a toml: `readToml(text, profile)` (`packages/shared/src/tomls/toml-read.ts`)

Moves the parse of the validators' `toml-match.ts` (smol-toml, pinned, now a dependency of the shared package; the byte order mark;
`TomlInvalidError` with no word of the file) into the shared package; `matchToml` keeps its behaviour on top of it. `readToml` reads
only these keys and returns the row's content:

| Section | Kept | Rule |
|---|---|---|
| `[[ACCOUNTS]]` | `address`, `network`, `desc` | `address` a classic address with a valid checksum (X-address, bad checksum, non-text: skipped); `desc` through `cleanTomlText(desc, 256)`, `''` when absent or longer; a repeated address keeps its first entry; at most 1,000 entries, in file order |
| `[[CURRENCIES]]` | `code`, `issuer`, `network`, `fields` | `code` through `cleanTomlText(code, 40)`, entry skipped without one; `issuer` when a classic address with a valid checksum, else `''`; at most 200 |
| `[[VALIDATORS]]` | `public_key`, `network`, `fields` | `public_key` through `cleanTomlText(value, 128)`, entry skipped without one; at most 100 |
| `[[PRINCIPALS]]` | `name` only | `cleanTomlText(name, 100)`, dropped when it contains `@`, without repeats, in file order, at most 10. `email`, `social_*` and every other key are never read |
| `[METADATA]` | `modified`, `expires` | an offset date-time (its instant), a local date-time (read as UTC), a local date (00:00 UTC), or text in one of those ISO forms; `modified` dropped when before 2012-01-01 or more than a day after the fetch (D8's rule) |

- `fields`: the entry's other keys whose value is a string (through `cleanTomlText(value, 256)`), a finite number or a boolean, at most
  16 keys matching `^[A-Za-z0-9_]{1,32}$`, in file order, as JSON text (`{}` when none). For currencies these are `display_decimals`,
  `symbol` and the custom keys issuers use (`name`, `desc`, `asset_class`, `attestation`, `icon`, ...); for validators
  `owner_country`, `server_country`, `server_location`, `server_cloud`, `network_asn`, `unl`, `attestation`. They are text, never
  followed.
- `cleanTomlText(value: unknown, max: number): string | undefined` (`packages/shared/src/tomls/toml-text.ts`, D8's §1.4 rule, made
  here because D4 is built first): a string, NFC, characters of the categories Cc and Cf removed (controls, bidirectional overrides and
  isolates), runs of white space one space, trimmed; `undefined` when empty or longer than `max` code points. Nothing is cut.
- An unknown section, a key of another type, a nested table inside an entry: ignored. Custom keys never fail a file.

### 3.4 Which entries count on a network

`countsOn(entryNetwork, profile)`: true when `entryNetwork` is `''` or in `profile.tomlNetworkNames`. Applied by every reader (the
directory, `/v2/toml/{domain}`, D6, D8), never by the writer.

## 4. The `tomls` worker

`apps/syncer/src/tomls/`: `tomls.module.ts` (registered in `WORKER_MODULES`; it provides its own `SafeFetcher` with
`tomlsUserAgent()`, `gatehub-data-api/<version> (tomls)`), `tomls-worker.ts` (the loops), `domain-discovery.ts` (4.1),
`toml-checker.ts` (4.2–4.3), `toml-row.ts` (`nextTomlRow`, 4.4). It does not need the node (`NODE_CLIENT_WORKERS` unchanged).

### 4.1 Discovery: which domains

At start and every `TOML_DISCOVERY_INTERVAL_MS` (5 min), one read of the current domain of every account:

```sql
SELECT top_hex AS domain_hex, count() AS accounts
  FROM (SELECT account, argMax(domain_hex, version) AS top_hex, argMax(deleted, version) AS gone
          FROM account_domains GROUP BY account)
 WHERE top_hex != '' AND gone = 0
 GROUP BY top_hex
```

Each `domain_hex` goes through `accountDomainOf`; those that are no domain are dropped (counted); hex spellings of one domain add up.
The result is `Map<domain, accounts>`, the domains accounts name now. The worker keeps the previous map in memory: a domain whose count
grew is **named anew** (4.2). Budget: one read of the table, under 2 s and 1 GiB; `syncer_tomls_discovery_seconds` records it.

D8 writes the files the validators' checker fetched into the store too (its §2.2, through `recordToml`, 4.4), so a domain only a
validator names is in the store without this worker fetching it; this worker fetches account domains only.

### 4.2 The pass: which domains are due

A pass every 60 s after the previous one ended (D1's `PassLoop`):

1. The schedule of every stored domain, one read of four columns: `domain`, `argMax(next_check_at, checked_at)`, `max(checked_at)`,
   `argMax(failures, checked_at)`. Then, for the domains this pass checks (at most 300, a bound array, primary key), their newest row
   in full, which `nextTomlRow` carries over (4.4).
2. **Due**: no row; named anew and checked more than an hour ago; or `next_check_at` passed. Order: never checked, then named anew,
   then the oldest `next_check_at`, then the domain. At most `TOML_PASS_LIMIT` (300) a pass.
3. **Checks**: at most `TOML_FETCH_CONCURRENCY` (16) in flight, one fetch per domain, of `https://{domain}{tomlPath}` through the safe
   fetcher with D1's TOML limits (`tomlFetchLimits(GH_DOMAIN_FETCH_TIMEOUT_MS)`: 10 s overall, 256 KiB, 3 redirects, each checked
   again, https and port 443 only; no fall-back to the other file name). A file that arrives is read with `readToml`.
4. **Writes**: rows are buffered and inserted in batches of 50 and at the end of the pass (300 tiny inserts a minute would make parts).
   `stop()` starts nothing more, waits for the fetches under way, and writes what is done; a check not written is still due.

The first sweep after the deploy is the backlog: about 300 domains a minute, slower when many hosts time out (16 lanes × 6 a minute
when every fetch takes the full 10 s). `syncer_tomls_due` shows it.

### 4.3 What is never done

A domain is fetched only when an account's ledger Domain names it (or D1 verified a manifest naming it, through D8): never because a
request asked. Nothing a file holds is fetched. The file's text is parsed, never evaluated, and never stored: only the content of 3.3.
Logs name a domain (quoted and cut like D1's, it comes from the ledger), a reason, a status code; never a body, an error object or a
principal. A blocked fetch (`blocked_address`) is one `warn` line per pass with the count and at most five domains.

### 4.4 The row to store: `nextTomlRow(prev, check, now, recheckMs)`

| Check | `status`, `reason`, `status_code` | Content, `fetched_at` | `failures` | `next_check_at` |
|---|---|---|---|---|
| Read as TOML | `ok`, `''`, 0 | from the file, now | 0 | now + `GH_TOML_RECHECK_MS` (24 h) |
| Transient: `dns_error`, `connect_error`, `tls_error`, `timeout`, `http_status` 5xx or 429 | `failed`, the reason, its code | `prev`'s when `prev.fetched_at` is at most 24 h old, else empty and NULL | `prev + 1` | now + 1 h |
| Definite: anything else (4xx but 429, `toml_invalid`, `too_large`, `redirect_rejected`, `blocked_address`, `domain_invalid`) | `failed`, the reason, its code | empty, NULL | `prev + 1` | now + min(24 h × 2^(failures − 1), 7 days): 1, 2, 4, then 7 days |

The 24-hour grace is D1's (`DOMAIN_VERIFIED_GRACE_S`): a website that blips keeps its names. `recordToml(ch, { domain, tomlUrl,
text, fetchedAt, recheckMs, profile })` (`packages/shared/src/tomls/toml-store.ts`) is the `ok` row of a file in hand, read and
inserted; it throws `TomlInvalidError` and writes nothing for a text that is not TOML. The worker uses it for its `ok` rows, and D8's
validators checker calls it for the files it fetched (D8 §2.2).

### 4.5 Metrics and alerts

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `syncer_tomls_checks_total` | Counter | `outcome` | `ok` or the reason of every check |
| `syncer_tomls_domains` | Gauge | `status` | After each pass: discovered domains `ok`, `failed`, `unchecked` |
| `syncer_tomls_due` | Gauge | | Domains due and not checked yet at the end of a pass |
| `syncer_tomls_discovery_seconds` | Gauge | | Duration of the last discovery read |

Alerts (`docs/observability.md`): `syncer_tomls_due > 2000` for 2 h (the worker cannot keep up or is stuck);
`syncer_tomls_discovery_seconds > 10` for 30 min (the table outgrew the read; raise the interval or narrow it).

## 5. Display names and the batch

### 5.1 The rule: `displayNameOf` (`apps/api/src/names/display-name.ts`, pure)

Given the account domain `D` (3.2 of the current `account_domains` row, if any), the toml directory's entry of `D` (5.3), the account
name and the account network name:

1. **`verified`**: `D` is set and its toml in effect lists the address under `[[ACCOUNTS]]` in an entry that counts on this network
   (3.4). `text` is the first such entry's `desc` when it is non-empty and at most 64 characters (decision 4), else `D`.
2. **`account`**: the account name; else the account network name (decision 5).
3. **`domain`**: `D` is set and the directory has loaded at least once (decision 14). Not listed, a failed toml, a toml not read yet:
   all are "not verified", because nothing vouches for the domain.
4. Otherwise none.

The account names and labels are ADR-0014's in-memory sets, as served on `/v2/accounts/{address}`.

### 5.2 `GET /v2/account_names`

```
GET /v2/account_names?addresses=rA…,rB…,rC…,rD…
```

| Parameter | Rule |
|---|---|
| `addresses` | Required. 1 to 100 classic addresses separated by `,` (no spaces, no trimming), each checked with `isValidClassicAddress`. Repeated parameter: the first wins. A repeated address is answered at each place and counts towards the 100. Case matters (base58). |

Errors, in this order: 400 `addresses is required` (missing or empty); 400 `too many addresses - at most 100`; 400 `invalid ripple
address` (an empty element, an X-address, a bad checksum, anything else); 500 `unable to retrieve account names`. 401 and 429 as
everywhere. Unknown parameters are ignored.

```json
{ "result": "success", "count": 4,
  "account_names": [
    { "address": "rA…", "display_name": { "text": "Northpeak Treasury", "kind": "verified" }, "domain": "northpeak.example" },
    { "address": "rB…", "display_name": { "text": "Harborline Exchange", "kind": "account" },
      "account_name": "Harborline Exchange", "account_network_name": "hot wallet",
      "labels": { "advisory": { "description": "Withdrawals paused since 2026-10-01", "url": "https://…" } } },
    { "address": "rC…", "display_name": { "text": "lowtide.example", "kind": "domain" }, "domain": "lowtide.example" },
    { "address": "rD…" }
  ] }
```

- One entry per requested address, in request order; `count` is their number.
- Entry key order: `address, display_name?, domain?, account_name?, account_network_name?, labels?`; `display_name`: `text, kind`;
  `labels`: keyed in the `Enum8` order `scam, spam, advisory`, each `description, source?, url?`. Absent fields are left out, never
  `null`.
- `domain` is the account domain whatever its state (verified exactly when `kind` is `verified`); `account_name`,
  `account_network_name` and `labels` are served whenever they exist, whatever the display name is.
- Any address is answered: one that is no account on this network still has its name and labels (they belong to the address) and no
  domain.
- `Cache-Control`: the default `private, max-age=60`; errors `no-store`.

### 5.3 How the api answers (`apps/api/src/names/`)

A new `NamesModule` (in `ENDPOINT_MODULES`, before `NotFoundModule`) owns `NamesAndLabelsService` (moved from `accounts/`, one
instance and one reload timer; `AccountsModule` imports it) and:

- `AccountDomainsService.current(addresses)`: one read of `account_domains` for the distinct addresses,
  `SELECT account, argMax(domain_hex, version), argMax(deleted, version) … WHERE account IN {addresses:Array(String)} GROUP BY account`,
  each answer kept 60 s per address in `CacheService` so that only the misses are read.
- `DomainTomlsService`: the **directory**, loaded at start and every 60 s with the names: the newest row of each domain
  (`ORDER BY domain, checked_at DESC LIMIT 1 BY domain`) whose `accounts` is not empty, kept as `domain → Map<address, desc>` of the
  entries that count on this network (first entry per address). A failed reload keeps the last directory (logged at `warn`); before the
  first load `loaded` is false. And `get(domain)`: the newest row of one domain, read by key and kept 60 s (6.2, D6, D8).
- `DisplayNamesService.of(addresses)`: the two reads above and the in-memory names, put together with `displayNameOf`.
- `AccountNamesController` (`@RippleController('v2/account_names')`, `@RippleRoute('unable to retrieve account names')`) parses and
  answers; `account-names-object.ts` holds the key orders.

## 6. `GET /v2/toml/{domain}`

What the store says of one domain. The explorer's account page reads it for "How we know" and the toml facts; D8's validator card and
D6's token page may read it or the store directly (section 8).

- `{domain}` is lower-cased; 400 `invalid domain` when it is not a properly formed domain then. 404 `toml not found` when the store has
  no row (no account names it, or it has not been checked yet). 500 `unable to retrieve toml`.
- Only entries that count on this network are served, and only the fields below; `fields` stays in the store.

```json
{ "result": "success",
  "toml": {
    "domain": "northpeak.example",
    "toml_url": "https://northpeak.example/.well-known/xrp-ledger.toml",
    "status": "ok",
    "checked": "2026-10-24T07:12:09.410Z",
    "fetched": "2026-10-24T07:12:09.410Z",
    "modified": "2026-10-02T00:00:00Z",
    "accounts": [ { "address": "rA…", "desc": "Northpeak Treasury" }, { "address": "rE…", "desc": "Northpeak Payroll" } ],
    "currencies": [ { "code": "NPUSD", "issuer": "rA…", "display_decimals": 2, "name": "Northpeak Dollar" } ],
    "principals": [ "Mara Lindqvist", "Tomas Okafor" ],
    "validators": [ { "public_key": "nH…", "owner_country": "NO", "server_country": "DE", "unl": "https://vl.ripple.com" } ]
  } }
```

- `toml` key order: `domain, toml_url, status, reason?, status_code?, checked, fetched?, modified?, expires?, accounts?, currencies?,
  principals?, validators?`. `reason` for `failed` only, `status_code` for its `http_status`. `checked` and `fetched` are instants of
  receipt (`YYYY-MM-DDTHH:mm:ss.SSSZ`, as D1's), `modified` and `expires` wall times (`YYYY-MM-DDTHH:mm:ssZ`).
- `accounts[]`: `address, desc?`. `currencies[]`: `code, issuer?, display_decimals?, symbol?, name?, desc?` (the last four from
  `fields` when they are of the right type: an integer 0–30, text). `validators[]`: `public_key, owner_country?, server_country?,
  unl?` (D8 may add keys). A list without entries is left out.
- A `failed` toml within its grace carries the content still in effect; after a definite failure it has none.
- `Cache-Control`: the default.

## 7. Query bounds

| Read | Bound | Pinned by |
|---|---|---|
| Batch: `account_domains` by key, up to 100 accounts | at most one granule (1,024 rows) per address per part, plus one | `read_rows` e2e: 50,000 seeded accounts in four parts, 100 asked: `read_rows ≤ 100 × 4 × 1,024`; `EXPLAIN indexes = 1` shows the primary key condition |
| `/v2/toml/{domain}`, `DomainTomlsService.get` | one granule per part | `read_rows` ≤ `index_granularity` × parts; EXPLAIN shows the key |
| Directory reload (60 s per replica) | the whole of `domain_tomls`, three columns | `read_rows` = rows of the table; one read per reload |
| Discovery (5 min, syncer) | the whole of `account_domains`, four columns | `read_rows` = rows of the table |
| Pass: the schedule (60 s, syncer) | the whole of `domain_tomls`, four columns | `read_rows` = rows of the table |
| Pass: the full rows of the domains checked | at most 300 domains by key | EXPLAIN shows the key |

The batch's latency is that one keyed read (milliseconds) plus memory; the in-memory sets are ADR-0014's.

## 8. What D6 and D8 read from the store

The store is the one per-domain toml store of the program (decision 9). Through `DomainTomlsService.get(domain)` in the api (newest
row, kept 60 s), `readStoredTomls(ch, domains)` in `packages/shared/src/tomls/toml-store.ts` for a job (the newest row of each domain,
one read by key), `countsOn` (3.4), `cleanTomlText` (3.3) and `accountDomainOf` (3.2):

- **D6 (issued tokens)**: the issuer's account domain and that domain's `[[CURRENCIES]]` entries in effect (`code`, `issuer`,
  `network`, and `fields` with `display_decimals`, `symbol`, `name`, `desc`, `icon`, `asset_class`, `attestation` and the rest, as
  text or numbers). D6's §3.7 decides what matches a token. Token issuers are accounts, so their domains are discovered like every
  account's (4.1): D6 needs no fetch source of its own. D6's `tomlNetworkNames` is this profile list. A URL
  among the fields is text the explorer may link (https only), never fetched. `DisplayNamesService.of([issuer])` gives the issuer's
  display name.
- **D8 (validator toml details)**: the `[[VALIDATORS]]` entries (`public_key`, `network`, `fields` with the countries, `unl`,
  location, ASN), `principals`, `modified`, and the number of `[[ACCOUNTS]]` and `[[CURRENCIES]]` entries. D8 writes the files its
  checker fetched with `recordToml` (4.4), and its failed checks with `nextTomlRow` over the domain's row from `readStoredTomls`. The
  store's version column is `checked_at`, not `fetched_at` (the time of the content in effect, NULL when there is none), because failed
  checks write rows too, and the newest row is the domain's current word (with empty content after a definite failure). `modified` is
  `Nullable(DateTime('UTC'))`.

## 9. XRPL and Xahau

The same code on both, with the profile: the toml path (`xrp-ledger.toml`, `xahau.toml`), `tomlNetworkNames` (Xahau's own files write
`network = "21337"`), and the network's own `account_domains` and `domain_tomls`. Xahau's Hooks, `Import`, `GenesisMint` and
`URIToken` change AccountRoots the generic way (3.1). The names sets are ADR-0014's (account names and labels shared, network names
per network). The testnets (D-env) use the same files with `network = "testnet"`.

## 10. Backfill, seed and coverage

- **After the deploy**, the live syncer writes `account_domains` with every ledger. Ledgers written by an older parser have none.
- **The seed** (once per network, by the operator, documented in `docs/backfill.md` "Account domains seed"): for the ledgers PR #20's
  parsers wrote, the current domain of every account with a state row, from `account_states`, in 16 buckets of accounts to bound
  memory. `X` is `SELECT maxOrNull(ledger_index) FROM ledgers WHERE parser_version < <DOMAIN_PARSER_VERSION>`:

  ```sql
  INSERT INTO account_domains (account, ledger_index, tx_index, node_index, version, domain_hex, deleted)
  SELECT account, top.1, top.2, top.3,
         bitOr(bitShiftLeft(toUInt64(top.1), 32), bitOr(bitShiftLeft(toUInt64(top.2), 16), toUInt64(top.3))), hex, 0
    FROM (SELECT account,
                 argMax((ledger_index, tx_index, node_index), (ledger_index, tx_index, node_index)) AS top,
                 argMax(JSONExtractString(fields, 'Domain'), (ledger_index, tx_index, node_index)) AS hex,
                 argMax(deleted, (ledger_index, tx_index, node_index)) AS gone
            FROM account_states
           WHERE ledger_index <= {X:UInt32} AND cityHash64(account) % 16 = {bucket:UInt8}
           GROUP BY account)
   WHERE hex != '' AND gone = 0;
  ```

  The seed's row sits on the account's newest state row at or below `X`, so a later `--reprocess` of that ledger deletes it and the
  parser writes the same row back. Running it twice inserts the same rows again; the newest wins either way.
- **Coverage** (decision 8): from the state history's start (`STATE_PARSER_VERSION`'s coverage). An account dormant since before it
  is learnt at its next change. Complete once the history is filled from ledger 32570 and re-ingested with this parser.
- **No reprocess is needed** for D4. `domain_tomls` needs no backfill: the first sweep fills it (4.2).

## 11. Failure modes

| Failure | Effect | Shows as |
|---|---|---|
| A domain's host is down or slow | Transient: re-checked hourly; names kept 24 h, then the domain is "not verified" | `domain_tomls.reason`; `syncer_tomls_checks_total` |
| The `tomls` worker off, `GH_DOMAIN_VERIFICATION=false` or no egress | No toml is read: no verified names; domains show as kind `domain` | `syncer_tomls_due` growing (worker on), `/v2/toml` 404 |
| The worker behind (first sweep) | New domains show "not verified" until checked | `syncer_tomls_due` |
| The directory fails to load at boot | No `verified` and no `domain` kinds (decision 14); names and labels unchanged | api `warn` log |
| A directory reload fails later | The last directory stays | api `warn` log |
| `account_domains` read fails | The batch answers 500 `unable to retrieve account names` | API 5xx; the explorer shows addresses |
| A domain changes its toml to drop an account | Not verified at the next check (≤ 24 h; at once if another account names it anew) | |
| A hostile toml (huge, deep, many entries, control characters) | Capped by the fetcher (256 KiB), the parser (`toml_invalid`), the caps and `cleanTomlText` | |

## 12. Security

- **Egress** (decision 1): outbound HTTPS to every domain accounts name, only through the safe fetcher (D1 §8.1: public addresses only,
  pinned DNS, https and 443, 3 checked redirects, 256 KiB, 10 s, no cookies, fixed `User-Agent`). Anyone can set a Domain, so anyone
  can make the worker fetch one URL of a fixed shape on a host of their choice, once a day: the same exposure as validators' manifests,
  at larger scale. `docs/security.md` and `docs/deployment.md` say so; restricting egress means `GH_DOMAIN_VERIFICATION=false`.
- **Personal data**: a principal's name only; emails and social handles are never read, stored, logged or served (a test feeds a file
  with them and asserts their text is nowhere in the row, the logs or the answer).
- **Impersonation**: a verified name is whatever the domain's owner wrote; the answer always pairs it with `domain`, and the explorer
  shows the domain (E9). Labels are GateHub's and are served beside any name.
- **Spoofing in text**: `cleanTomlText` removes controls and bidirectional overrides, so a name cannot render as another's.
- The API never fetches; its parameters are bound (`Array(String)`, `String`).

## 13. Docs to update

- `docs/api-reference.md`: a section "Account names and tomls" with both routes (parameters, errors, examples, key orders,
  `Cache-Control`); the "Compatibility" list of routes the original did not have.
- ADR-0010: a new amendment ("display names", items numbered by the plan): `GET /v2/account_names` and `GET /v2/toml/{domain}` are new
  routes, and no route of the original changes.
- A new ADR (decision 13): Context (names the explorer shows everywhere, one call per page, verified names from tomls); Decision (the
  display name rule, `account_domains` ordered by account, the `tomls` worker and the store, the batch, the toml route); Consequences
  (egress, coverage, the ADR-0007 exception, ADR-0014's rejected lookup now accepted for batches). ADR-0014's status line: "Amended by"
  the new ADR (the plan numbers it); `docs/adr/README.md` table.
- `docs/data-model.md` (both tables, the exception), `docs/syncer.md` (a section "The tomls worker"), `docs/configuration.md`
  (`GH_WORKERS`, `GH_TOML_RECHECK_MS`, the shared `GH_DOMAIN_*`), `docs/observability.md` (metrics, alerts), `docs/security.md`,
  `docs/operations.md` (rollout, the seed, the explorer key's rate limit), `docs/backfill.md` (the seed, coverage),
  `docs/development.md` §6b (the numbering line), `docs/openapi.yaml` (regenerated), `GLOSSARY.md` (terms in the report).

## 14. Testing

**Unit** (`pnpm test`):
- `account-domains.parser.spec.ts`: every row of the table in 3.1, `version`, deep-frozen input, no row for a threaded node.
- `account-domain.spec.ts`: hex rules, case, length, non-ASCII, space, `https://`, IP, single label, 128/129 characters.
- `toml-read.spec.ts`, `toml-text.spec.ts`: each section and cap; BOM; not TOML; X-address and bad checksum skipped; repeated
  addresses; `network` as a string, as a bare integer (`21337`) and of another type; `desc` over 256 dropped; principals with `@` and the email/social keys never present anywhere in the output; `modified`
  forms and bounds; `fields` types, key pattern and the 16-key cap; NFC, Cc/Cf removal, bidi overrides.
- `toml-row.spec.ts`: `nextTomlRow` for ok, each transient reason inside and outside the grace, each definite reason, the backoff
  1/2/4/7 days, `failures`.
- `domain-discovery.spec.ts`, `toml-checker.spec.ts` (with a fake fetcher and store, as D1's `domain-checker.spec.ts`): due order,
  named anew (and its hourly limit), the 300 limit, 16 lanes, one fetch per domain, batched writes, stop, `GH_DOMAIN_VERIFICATION=false`.
- `display-name.spec.ts`: the order of 5.1, the network rule, `desc` of 64 and 65 characters, the network name alone, the directory not
  loaded.
- `account-names.controller.spec.ts`, `toml-object.spec.ts`: parameters and messages in order, key orders, duplicates, request order.

**E2e** (Docker, real ClickHouse):
- `packages/shared/test`: migrations (both tables, the partitioning of `account_domains` in `LEDGER_KEYED_TABLES`); `buildLedgerRows`
  against recorded ledgers. **To record** (`record:fixtures`, the manifests' `cases`): on XRPL an `AccountSet` that sets a Domain, one
  that changes it, one that clears it, an `AccountDelete` of an account with a Domain, a `Payment` received by an account with a
  Domain, a failed transaction of an account with a Domain; on Xahau an `AccountSet` with a Domain and an `Import`. The plan picks the
  ledgers.
- `apps/syncer/test/tomls-worker.e2e-spec.ts`: a local HTTPS server through `SafeFetchTestOptions` (as D1's): ok, 404, 503, timeout,
  invalid TOML, too large, redirect; rows written; re-check and grace; the seed SQL of section 10 over seeded `account_states`, then
  discovery.
- `apps/api/test/display-names.e2e-spec.ts`: seeded `account_domains`, `domain_tomls` and the names/labels tables; the exact answers of
  5.2 for every kind, labels, an X-address, 101 addresses, duplicates, order, `Cache-Control`, 401, unknown parameters; the `read_rows`
  bound and EXPLAIN of section 7; a directory that failed to load. `apps/api/test/toml.e2e-spec.ts`: 6's answers, 400, 404,
  the network rule, a failed toml inside and outside its grace.

## 15. Rollout

1. Apply the migration (both tables) before the syncer of this release starts: the ingest writes `account_domains` with every ledger,
   and a write to a missing table fails the batch.
2. Deploy the syncer (ingest with the new parser, the `tomls` worker) and the api.
3. Run the seed (section 10) on each network.
4. Wait for the first sweep (`syncer_tomls_due` near 0).
5. Check the explorer's API key: E9 adds one names call to most page renders (two on the account page); raise its
   `GH_RATE_LIMIT_KEYS` limit if its 429s rise.
6. Then E9's `NAMES` switch can go on in that environment.

**Depends on**: PR #20 (`account_names`, `account_labels`, `account_network_names`, `NamesAndLabelsService`, `account_states` for the
seed, the shared database); D1's safe fetcher and toml parse; D-env's testnet profiles (to which D4 adds `tomlNetworkNames`). **Relied on by**: E9; D6
(currencies, the issuer's verified domain and name); D8 (the store, `recordToml`, `cleanTomlText`); E10, E11, E13 through E9.
