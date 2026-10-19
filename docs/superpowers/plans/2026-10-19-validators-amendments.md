# Validators and Amendments Data (D1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect validator versions, manifests, UNL lists, domain verification, ledger state, voting rounds and hourly agreement on XRPL and Xahau, and serve them at `/v2/network/validators[/summary|/{key}[/validations]]` and `/v2/network/amendments[/{name}]`.

**Architecture:** One additive migration (`002`) adds two columns and ten tables. The validations collector also writes the software version, raw manifests and two per-validator tables. A new syncer worker, `validators`, fetches and verifies UNL lists, checks validator domains through an SSRF-safe fetcher, polls ledger state and amendment names from the node, and runs two compute jobs (voting rounds, hourly agreement) that write version sets. A new API module builds a cached in-memory directory of every validator from parallel reads, and serves the six routes in the Ripple contract layer. The pure rules (versions, quorum, thresholds, UNL selection, vote records, manifests, list verification, amendment metadata) live in the shared package.

**Tech Stack:** TypeScript (strict), NestJS 10, ClickHouse 26.8 (`@clickhouse/client`), pnpm 10 workspace, jest + ts-jest, testcontainers, supertest, `ws`, `bignumber.js`, `ripple-binary-codec` 2.x, `ripple-keypairs` 2.x, `ripple-address-codec`, `smol-toml` 1.3.1 (pinned exactly), Node `https` / `dns` / `net`.

**Spec:** `/Users/golobitch/github.com/GateHubNet/data-api-new/.worktrees/explorer-data/docs/superpowers/specs/2026-10-19-validators-amendments-design.md` (cited as "spec §n" or "F<n>"; the plan argues from the spec, executors read both).

**Branch:** `feat/explorer-data` in the worktree `/Users/golobitch/github.com/GateHubNet/data-api-new/.worktrees/explorer-data` (= `main` plus the specs). D1 is the first plan of the explorer program: nothing has to be merged or built first. Never touch the main checkout `/Users/golobitch/github.com/GateHubNet/data-api-new` or `feat/amm-data` (read them only with `git -C … show`).

## Global Constraints

- Installs are offline; no npm token is needed. The pnpm store at `~/Library/pnpm/store/v10` holds every lockfile package (including `@gatehub/toolbox@0.2.6`, integrity matching) and `smol-toml@1.3.1` with its metadata. The worktree has no `node_modules`: Task 1 starts with `pnpm install --offline --frozen-lockfile`, then `pnpm build`. After a `package.json` change (Tasks 3 and 9) run `pnpm install --offline`. Only if an offline install fails, stop and report BLOCKED, naming the missing package (the owner then supplies a token).
- The first e2e run pulls the `testcontainers/ryuk` image from Docker Hub, which is reachable: allow that pull. If it fails, run the e2e suites with `TESTCONTAINERS_RYUK_DISABLED=true` and say so in the task report.
- Delete nothing you did not create in this task: no `rm` of existing files, no `git clean`, no `git checkout -- <other files>`, no database or container you did not start.
- The apps import the compiled `dist/` of `packages/shared`: after changing shared, run `pnpm --filter @gatehub/data-api-shared build` before running app tests.
- Before each commit: `pnpm format`, `pnpm build` (the typecheck of all three packages), `pnpm test`, and `pnpm --filter <package> test:e2e` of every package the task touched (Docker) exit 0.
- Commits use the repo's Conventional Commits style (`feat(shared): …`, `feat(syncer): …`, `feat(api): …`, `docs: …`, `test: …`), and every message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Schema changes go only into `packages/shared/schema/002_validators_amendments.sql`. Never edit `001_baseline.sql`. `003` and ADR-0013 belong to D2; this plan's ADR is `docs/adr/0012-validators-and-amendments-data.md`.
- Repo conventions (`docs/development.md` §5): table names only from the `Table` enum; every user-derived value bound as a query parameter; no `FINAL`; key-ordered reads; exact decimals with BigNumber; config only through the config classes; export everything new of `packages/shared` from `packages/shared/src/index.ts` (and from `packages/shared/src/network/index.ts` for anything a config class imports, because the config files import only `@gatehub/data-api-shared/dist/network`).
- Times: `DateTime('UTC')` for ledger and wall times (unix seconds), `DateTime64(3, 'UTC')` for times of receipt (inserted as unix seconds with the milliseconds as a fraction, never as an integer of milliseconds).
- Keys are base58 node public keys (`nH…` master, `n9…` signing) unless said otherwise; amendment IDs are upper-case 64 hex.
- Ledger numbers: voting ledger V = 256k − 1, flag ledger F = 256k, applied in A = 256k + 1. The votes of a round are those of V.
- Version sets (`validator_votes` + `amendment_tallies` for a round V; `validator_agreement_hourly` for an hour): each unit is written whole under one `version` (wall-clock milliseconds, greater than any version already stored for that unit), its sentinel row last (`amendment_id = ''` / `validation_public_key = ''`). A reader takes the newest sentinel's version per unit and keeps only that version's rows; no reader mixes two versions.
- Key mapping: every job and every API read that aggregates rows maps each key through the manifest map first (`validator_manifests`: per `ephemeral_key`, `argMax(master_key, seq)`); in SQL `transform(k, {ephemerals:Array(String)}, {masters:Array(String)}, k)`.
- Network profile values (both networks: 80 %, flag interval 256): XRPL software `rippled`, TOML `/.well-known/xrp-ledger.toml`, publishers `https://vl.ripple.com=ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734,https://unl.xrplf.org=ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1`, majority hold 1,209,600 s; Xahau `xahaud`, `/.well-known/xahau.toml`, `https://vl.xahau.org=EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8`, 432,000 s.
- Quorum, threshold and needed use integer arithmetic; native amounts, `pct` and `score` use BigNumber; no float reaches a served figure.
- The syncer makes outbound HTTP only through `SafeFetcher` (Task 7). It asks the node only `ledger_entry` (the three fixed indexes of Task 4), `server_info`, `feature` and `manifest` (with a stored key). Nothing in a validation message or a TOML file is ever fetched; of a TOML only `[[VALIDATORS]].public_key` and, from a TOML that verified, `[[ACCOUNTS]].address` are read, as data.
- API answers: a key with no value is absent, never `null`; times of receipt `YYYY-MM-DDTHH:mm:ss.SSSZ` (`fmtMillis`), ledger and wall times `YYYY-MM-DDTHH:mm:ssZ` (`fmtTime`), days `YYYY-MM-DD`; native amounts in whole units as exact decimal text (`"0.00001"`, `"1"`, `"0.2"`); counts are numbers; `pct` is a number to 2 decimals; agreement `score` is text to 4 decimals, half-up; key order is the task's exported `*_KEYS` constant, pinned by tests.
- API `Cache-Control` (only when `GH_CACHE_CONTROL` is not empty; errors keep `no-store`): `/v2/network/validators`, `/summary`, `/{key}` `private, max-age=30`; `/{key}/validations` `private, max-age=5`, with a `marker` `private, max-age=300`; `/v2/network/amendments`, `/{name}` `private, max-age=60`.
- These routes of the original stay `404 {"result":"error","message":"Cannot GET …"}`: `/v2/network/validators/{pubkey}/manifests`, `/v2/network/validators/{pubkey}/reports`, `/v2/network/validator_reports`, `/v2/network/rippled_versions`.
- Do not edit `apps/syncer/src/aggregator/aggregator.service.ts` (spec §2, reason 3: it keeps D1 apart from `feat/amm-data`).
- Data recorded from public sources (UNL lists, node answers) and the amendment metadata need outbound network. If it is unreachable, stop and report BLOCKED. Never hand-write data presented as recorded; hand-written TOML files and test-signed lists say so.
- Metrics are syncer-only, prefix `syncer_`; the API adds none.

## Review Focus

1. **A validation recorded under a signing key** (its manifest was not known yet) must count for the master key in votes, agreement and the directory, or a healthy validator shows missed ledgers and no votes. Tests: Task 11 `counts a vote recorded under the signing key for its master`; Task 12 `maps a signing-key validation to its master`; Task 13 `merges validator_seen rows of a signing key into its master`.
2. **Ledgers the collector did not see** (a reconnect, an outage): fewer than quorum UNL full validations recorded makes a ledger `unobserved` for everybody, never a miss; a window with more than 1 % unobserved, or a missing or non-final hour, is `incomplete`. Tests: Task 12 `leaves an under-recorded ledger out for everybody`; Task 13 `flags a window incomplete above 1 % unobserved`.
3. **Small trusted sets**: quorum, threshold and needed follow rippled exactly, with integers, at trusted 0, 1, 2 and 35 (needed 1, 1, 2, 29; quorum 28 of 35), so the page never says "one more needed" wrongly. Tests: Task 2 `consensus.spec.ts` tables; Task 14 `passes at trusted 1 with one yes`.
4. **A publisher or a website that fails**: an expired list is still used and flagged `expired`; a list that fails verification is never used; every publisher down still answers 200 (`unavailable`, nobody trusted, quorum 0); a TOML blip within 24 h keeps `verified`. Tests: Task 8 `keeps using an expired list` and `never stores a list that fails verification`; Task 9 `keeps verified through a transient failure within 24 h`; Task 13 `answers with every publisher unavailable`.
5. **SSRF through a validator domain**: a domain or a redirect target with any non-public address (IPv4-mapped IPv6 included), or a DNS answer that changes between the check and the connect, is refused before a byte is sent. Tests: Task 7 `refuses every blocked range`, `connects to the address it checked`, `checks every redirect from the top`.

---

### Task 1: Migration 002 and row types

**Files:**
- Create: `packages/shared/schema/002_validators_amendments.sql`
- Modify: `packages/shared/src/clickhouse/tables.ts` (ten names), `packages/shared/src/clickhouse/rows.ts` (two changed types, ten new ones), `packages/shared/src/clickhouse/schema.spec.ts` (accept `ALTER TABLE` statements), `packages/shared/test/sample-rows.ts`, `packages/shared/test/migrate.e2e-spec.ts`, `docs/data-model.md` (§3 tables, §5 migration list, §6 retention)
- Test: `packages/shared/src/clickhouse/schema.spec.ts`, `packages/shared/test/migrate.e2e-spec.ts`

**Interfaces:**
- Produces (Tasks 3–17; D2 takes `003` after this file): `Table.ValidatorValidations = 'validator_validations'`, `Table.ValidatorSeen = 'validator_seen'`, `Table.UnlLists = 'unl_lists'`, `Table.UnlPublishers = 'unl_publishers'`, `Table.ValidatorDomains = 'validator_domains'`, `Table.NetworkState = 'network_state'`, `Table.AmendmentFeatures = 'amendment_features'`, `Table.ValidatorVotes = 'validator_votes'`, `Table.AmendmentTallies = 'amendment_tallies'`, `Table.ValidatorAgreementHourly = 'validator_agreement_hourly'`; row types `ValidatorValidationsRow`, `ValidatorSeenRow`, `UnlListsRow`, `UnlPublishersRow`, `ValidatorDomainsRow`, `NetworkStateRow`, `AmendmentFeaturesRow`, `ValidatorVotesRow`, `AmendmentTalliesRow`, `ValidatorAgreementHourlyRow` (fields = columns in DDL order; `DateTime` → `UnixSeconds`, `DateTime64(3)` → `UnixSecondsMs`, `UInt64` → `UInt64Value`, `Nullable(T)` → `T | null`, `Array(String)` → `string[]`, the named tuples → `{ amendment: string; since: UnixSeconds }[]` and `{ validation_public_key: string; first_ledger: number }[]`); `ValidationsRow.server_version: UInt64Value | null` (last field); `ValidatorManifestsRow` gains `domain: string; manifest: string; source: 'stream' | 'rpc' | 'unl'`.

The tables, exactly (spec §1.3; columns in this order):

| Table | Engine, key, partition, TTL, settings | Columns |
| --- | --- | --- |
| `validations` | `ALTER … ADD COLUMN IF NOT EXISTS` | `server_version SimpleAggregateFunction(any, Nullable(UInt64))` |
| `validator_manifests` | one `ALTER` with three `ADD COLUMN IF NOT EXISTS` | `domain String DEFAULT ''`, `manifest String DEFAULT ''` (upper hex), `source LowCardinality(String) DEFAULT 'stream'` |
| `validator_validations` | `AggregatingMergeTree`, `PARTITION BY intDiv(ledger_index, 100000)`, `ORDER BY (validation_public_key, ledger_index, ledger_hash)`, `TTL toDateTime(last_datetime) + INTERVAL 7 DAY`, `SETTINGS ttl_only_drop_parts = 1, non_replicated_deduplication_window = 100` | `validation_public_key LowCardinality(String)`, `ledger_index UInt32`, `ledger_hash String`, `count SimpleAggregateFunction(sum, UInt64)`, `first_datetime SimpleAggregateFunction(min, DateTime64(3, 'UTC'))`, `last_datetime SimpleAggregateFunction(max, DateTime64(3, 'UTC'))`, `ephemeral_public_key SimpleAggregateFunction(any, String)`, `signing_time SimpleAggregateFunction(any, UInt32)`, `full SimpleAggregateFunction(max, UInt8)`, `server_version SimpleAggregateFunction(any, Nullable(UInt64))` |
| `validator_seen` | `AggregatingMergeTree`, `ORDER BY validation_public_key`, no TTL, `SETTINGS non_replicated_deduplication_window = 100` | `validation_public_key String`, `first_seen SimpleAggregateFunction(min, DateTime64(3, 'UTC'))`, `last_seen SimpleAggregateFunction(max, DateTime64(3, 'UTC'))`, `last_ledger_index SimpleAggregateFunction(max, UInt32)` |
| `unl_lists` | `ReplacingMergeTree(fetched_at)`, `ORDER BY (publisher, sequence)` | `publisher LowCardinality(String)`, `publisher_key String`, `sequence UInt64`, `version UInt8`, `effective Nullable(DateTime('UTC'))`, `expiration DateTime('UTC')`, `validators Array(String)`, `blob_sha256 String`, `fetched_at DateTime64(3, 'UTC')`, `response String CODEC(ZSTD(3))` |
| `unl_publishers` | `ReplacingMergeTree(checked_at)`, `ORDER BY publisher` | `publisher LowCardinality(String)`, `url String`, `publisher_key String`, `configured UInt8`, `threshold UInt8`, `checked_at DateTime64(3, 'UTC')`, `status LowCardinality(String)`, `error LowCardinality(String)`, `last_ok_at Nullable(DateTime64(3, 'UTC'))` |
| `validator_domains` | `ReplacingMergeTree(checked_at)`, `ORDER BY (validation_public_key, domain)` | `validation_public_key String`, `domain String`, `status LowCardinality(String)`, `reason LowCardinality(String)`, `status_code UInt16`, `toml_url String`, `checked_at DateTime64(3, 'UTC')`, `verified_at Nullable(DateTime64(3, 'UTC'))`, `next_check_at DateTime('UTC')`, `accounts Array(String)` |
| `network_state` | `ReplacingMergeTree(polled_at)`, `ORDER BY ledger_index`, `TTL toDateTime(polled_at) + INTERVAL 100 DAY` | `ledger_index UInt32`, `ledger_hash String`, `polled_at DateTime64(3, 'UTC')`, `amendments Array(String)`, `majorities Array(Tuple(amendment String, since DateTime('UTC')))`, `negative_unl Array(Tuple(validation_public_key String, first_ledger UInt32))`, `to_disable String`, `to_reenable String`, `base_fee UInt64`, `reserve_base UInt64`, `reserve_inc UInt64`, `node_quorum UInt32` |
| `amendment_features` | `ReplacingMergeTree(polled_at)`, `ORDER BY amendment_id` | `amendment_id String`, `name String`, `supported UInt8`, `polled_at DateTime64(3, 'UTC')` |
| `validator_votes` | `ReplacingMergeTree(version)`, `ORDER BY (ledger_index, validation_public_key)` | `ledger_index UInt32`, `validation_public_key String`, `ledger_hash String`, `close_time DateTime('UTC')`, `full UInt8`, `amendments Array(LowCardinality(String))`, `base_fee Nullable(UInt64)`, `reserve_base Nullable(UInt64)`, `reserve_inc Nullable(UInt64)`, `server_version Nullable(UInt64)`, `version UInt64` |
| `amendment_tallies` | `ReplacingMergeTree(version)`, `ORDER BY (amendment_id, ledger_index)` | `ledger_index UInt32`, `amendment_id String`, `close_time DateTime('UTC')`, `yes UInt16`, `trusted UInt16`, `threshold UInt16`, `unl_size UInt16`, `observed UInt16`, `unl Array(String)`, `negative_unl Array(String)`, `base_fee UInt64`, `reserve_base UInt64`, `reserve_inc UInt64`, `version UInt64` |
| `validator_agreement_hourly` | `ReplacingMergeTree(version)`, `ORDER BY (hour, validation_public_key)`, `TTL hour + INTERVAL 400 DAY` | `hour DateTime('UTC')`, `validation_public_key String`, `agreed UInt32`, `missed UInt32`, `partial UInt32`, `last_seen DateTime64(3, 'UTC')`, `ledgers UInt32`, `unobserved UInt32`, `gaps UInt32`, `unl_size UInt16`, `quorum UInt16`, `final UInt8`, `version UInt64` |

Every statement is `IF NOT EXISTS` (re-runnable), ends with its semicolon on its last line, and no other line (comments included) ends with one. None of the new tables is a ledger table: none goes into `CHILD_TABLES` or `LEDGER_KEYED_TABLES`.

- [ ] **Step 1: Install, then write the failing tests.** First `pnpm install --offline --frozen-lockfile` and `pnpm build` from the worktree root (if the offline install fails, stop and report BLOCKED naming the missing package).
  - `schema.spec.ts`: the statement rule counts lines matching `/^(CREATE|ALTER)\s/i` (not only `CREATE`); a terminator is followed by a blank line, the next `CREATE`/`ALTER`, or the end.
  - `migrate.e2e-spec.ts`: `SHAPES` gains the ten tables (partition `intDiv(ledger_index, 100000)` for `validator_validations`, `''` for the others; versions `fetched_at`, `checked_at`, `polled_at`, `version` as above); `SAMPLE_ROWS` gains one typed row per table (so the existing "round-trips through the table" and "exactly the tables of the Table enum" tests cover them); new tests:
    - `it('keeps the collector tables on a dedup window of 100')`: `engine_full` of `validator_validations` and `validator_seen` contains `non_replicated_deduplication_window = 100`, and `validator_validations` contains `ttl_only_drop_parts = 1`.
    - `it('expires validator_validations after 7 days, network_state after 100 and the hourly agreement after 400')`: `create_table_query` matches `toIntervalDay(7)`, `toIntervalDay(100)`, `toIntervalDay(400)`.
    - `it('fills the added columns for a row written without them')`: a `validator_manifests` row inserted with only the three old columns reads back `domain ''`, `manifest ''`, `source 'stream'`; a `validations` row without `server_version` reads `NULL`.
    - `it('validator_validations: sightings merge: counts add up, first is the min, last the max, full the max')` and `it('validator_seen: min of first_seen, max of last_seen and of last_ledger_index')` (insert two rows of one key, `OPTIMIZE … FINAL`, compare).
    - `it('(f) completes 002 after it failed half way')`: on a fresh database `ctl_half`, apply `001` alone (a temp `GH_SCHEMA_DIR` holding a copy of it), run the first half of 002's statements by hand (split as the runner does: on `/;\s*$/m`, dropping `--` lines), then `runMigrations` with the real directory: `applied` is `['002_validators_amendments.sql']` and all twelve statements' effects are present.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- schema` passes until the file exists, then `pnpm --filter @gatehub/data-api-shared test:e2e -- migrate` fails on the missing tables and the `Table` enum entries.
- [ ] **Step 3: Write the migration, the enum entries and the row types.** Header comment states the runner's constraints like `001`. `sample-rows.ts` keys every new table in `TableRows`.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared test` and `pnpm --filter @gatehub/data-api-shared test:e2e` exit 0.
- [ ] **Step 5: Commit.** `git add packages/shared/schema/002_validators_amendments.sql packages/shared/src/clickhouse packages/shared/test docs/data-model.md` — `feat(shared): migration 002 for validators and amendments data`.

---

### Task 2: Shared validator rules

**Files:**
- Modify: `packages/shared/src/network/network-profile.ts` (profile fields), `packages/shared/src/network/network-profile.spec.ts`, `packages/shared/src/network/index.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/src/network/unl-publishers.ts`, `packages/shared/src/validators/{index,server-version,consensus,unl,records}.ts` and a `*.spec.ts` next to each

**Interfaces:**
- Produces:
  ```ts
  // NetworkProfile gains
  software: 'rippled' | 'xahaud';
  tomlPath: '/.well-known/xrp-ledger.toml' | '/.well-known/xahau.toml';
  defaultUnlPublishers: string;            // the GH_UNL_PUBLISHERS default text of Global Constraints
  majorityHoldSeconds: number;             // 1_209_600 | 432_000
  amendmentThresholdPercent: 80;
  flagInterval: 256;
  // network/unl-publishers.ts (importable from dist/network)
  interface UnlPublisherConfig { id: string; url: string; publicKey: string /* upper hex */ }
  function parseUnlPublishers(text: string): UnlPublisherConfig[];   // '' -> []; throws Error('GH_UNL_PUBLISHERS entry <n>: <why>')
  function publisherIdOf(url: string): string;                       // 'https://vl.ripple.com/' -> 'vl.ripple.com'
  function defaultUnlThreshold(publishers: number): number;          // n < 3 -> 1, else floor(n / 2) + 1
  // validators/server-version.ts
  interface ServerVersion { version: string; build?: number; triple: [number, number, number]; release: boolean; stage: number }
  function decodeServerVersion(raw: string | bigint, software: 'rippled' | 'xahaud'): ServerVersion | undefined;
  function parseVersionTriple(text: string): [number, number, number] | undefined;
  function compareTriples(a: [number, number, number], b: [number, number, number]): number;
  function compareVersions(a: ServerVersion, b: ServerVersion): number;   // newest first: triple, then stage
  // validators/consensus.ts
  function quorumOf(unlSize: number, negativeOnUnl: number): number;
  function amendmentThreshold(trusted: number, percent?: number): number;
  function amendmentNeeded(trusted: number, percent?: number): number;
  function amendmentPasses(yes: number, trusted: number, percent?: number): boolean;
  function isVotingLedger(index: number): boolean;
  function votingLedgerAtOrAfter(index: number): number;
  function nextFlagLedger(index: number): number;
  // validators/unl.ts
  interface StoredUnlList { publisher: string; sequence: number; version: number; effective?: number; expiration: number; validators: string[]; fetchedAt: number } // unix s
  interface ListInUse { list: StoredUnlList; expired: boolean }
  function listInUse(lists: readonly StoredUnlList[], publisher: string, t: number): ListInUse | undefined;
  function trustedUnl(lists: readonly StoredUnlList[], publishers: readonly string[], threshold: number, t: number): Set<string>;
  // validators/records.ts
  interface VoteRow { ledger_index: number; validation_public_key: string; close_time: number; full: number; amendments: string[];
                      base_fee: string | null; reserve_base: string | null; reserve_inc: string | null; server_version: string | null }
  interface RoundMembership { unl: ReadonlySet<string>; negativeUnl: ReadonlySet<string> }
  const RECORD_LIFETIME_SECONDS = 86_400;
  function recordOf(rows: readonly VoteRow[], roundLedger: number, roundClose: number,
                    membership?: ReadonlyMap<number, RoundMembership>): VoteRow | undefined;
  ```

Rules the tests pin:
- `parseUnlPublishers`: comma separated `url=key`, split at the **last** `=`; `https://` URLs only; key 66 hex starting `ED`, `02` or `03` (case-insensitive, returned upper); no URL and no key twice.
- `decodeServerVersion` (F3, F4): undefined unless bits 48–63 are `0x183B` and the text is decimal digits. Bits 40–47 major, 32–39 minor, 24–31 patch, 16–23 release byte. rippled: `major.minor.patch`; byte `0xC0` release; `(b & 0xC0) === 0x80` → `-rc${b & 0x3F}`; `(b & 0xC0) === 0x40` → `-b${b & 0x3F}`; `release` only for `0xC0`. xahaud: `(major + 2023).minor.patch`, the same suffixes, `build` = bits 0–15 when non-zero, `release` for any byte that is neither rc nor beta. `stage` ranks release 3 > rc 2 > beta 1 > other 0, with the higher N first inside a stage.
- `quorumOf(u, n)` = max(⌈4(u − n)/5⌉, ⌈3u/5⌉) with integers (F12). `amendmentThreshold(t)` = max(1, ⌊t × 80 / 100⌋); `amendmentNeeded(t)` = `t <= 1 ? 1 : threshold + 1`; `amendmentPasses(y, t)` = `t === 1 ? y >= threshold : y > threshold` (F7).
- `listInUse` (spec §2.1): no rows of the publisher → undefined; `t` before its first `fetchedAt` → its lowest-sequence row; else the highest `sequence` with `(effective ?? −∞) <= t < expiration`; when none is current, the highest-sequence row with `expired: true`.
- `trustedUnl`: validators on at least `threshold` of the lists in use of `publishers` at `t`.
- `recordOf` (F7, spec §2.4 step 4): among `rows` (one key), the highest `ledger_index` with `full === 1`, `ledger_index <= roundLedger` and `close_time >= roundClose − 86_400`; with `membership`, only rows whose round has an entry with the key in `unl` and not in `negativeUnl`. A record with no amendments votes for none.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  expect([quorumOf(35, 0), quorumOf(35, 3), quorumOf(19, 1), quorumOf(2, 0), quorumOf(1, 0), quorumOf(0, 0)]).toEqual([28, 26, 15, 2, 1, 0]);
  expect([0, 1, 2, 35].map((t) => [amendmentThreshold(t), amendmentNeeded(t)])).toEqual([[1, 1], [1, 1], [1, 2], [28, 29]]);
  expect([amendmentPasses(0, 0), amendmentPasses(1, 1), amendmentPasses(1, 2), amendmentPasses(2, 2), amendmentPasses(28, 35), amendmentPasses(29, 35)])
    .toEqual([false, true, false, true, false, true]);
  expect(decodeServerVersion('1745992596280311808', 'rippled')).toMatchObject({ version: '3.4.1', release: true });
  expect(decodeServerVersion('1745991501042745344', 'rippled')).toMatchObject({ version: '2.5.0-rc1', release: false });
  expect(decodeServerVersion('1745991501038682112', 'rippled')).toMatchObject({ version: '2.5.0-b3', release: false });
  expect(decodeServerVersion('1745992622238863383', 'xahaud')).toMatchObject({ version: '2026.10.13', build: 4119, release: true });
  expect(decodeServerVersion('1311676707215769600', 'rippled')).toBeUndefined();   // prefix 0x1234
  expect([parseVersionTriple('1.12.0'), parseVersionTriple('2024.4.21'), parseVersionTriple('v1')]).toEqual([[1, 12, 0], [2024, 4, 21], undefined]);
  expect([isVotingLedger(107748095), nextFlagLedger(107748183), nextFlagLedger(107748352), votingLedgerAtOrAfter(107748096)])
    .toEqual([true, 107748352, 107748608, 107748351]);
  ```
  Plus: `parseUnlPublishers` of both profile defaults → ids `vl.ripple.com`, `unl.xrplf.org`, `vl.xahau.org`; `http://` refused; a key with `04` prefix or 64 digits refused; a duplicate URL or key refused; `''` → `[]`; `defaultUnlThreshold` 1, 2, 3, 4 → 1, 1, 2, 3. `listInUse`: before the first fetch, current by sequence, a future `effective` skipped, all expired → newest with `expired: true`. `trustedUnl`: threshold 1 of two lists is the union, 2 the intersection. `recordOf`: a row at exactly `roundClose − 86_400` counts and one a second older does not; a partial row is skipped; with membership, a row from a round where the key was on the negative UNL, or not yet on the UNL, is skipped. Profile: the six new fields of both profiles equal the Global Constraints values.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- validators network` fails: modules not found.
- [ ] **Step 3: Implement the five modules and the profile fields.** Export `unl-publishers` from `src/network/index.ts`, and `src/validators/index.ts` from `src/index.ts`.
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared test` exits 0.
- [ ] **Step 5: Commit.** `git add packages/shared/src` — `feat(shared): versions, quorum, thresholds, UNL selection and vote records`.

---

### Task 3: Node keys, manifests and UNL list verification

**Files:**
- Modify: `packages/shared/package.json` (dependencies `ripple-binary-codec` `^2.11.0`, `ripple-keypairs` `^2.0.0`, `ripple-address-codec` `^5.0.0`, all already in `pnpm-lock.yaml`; then `pnpm install --offline`), `packages/shared/scripts/record-fixtures.ts` (`--unl` mode), `packages/shared/test/fixtures/README.md` (a "UNL lists" section: source URL, date, sequence, count)
- Create: `packages/shared/src/validators/{node-key,manifest,unl-list}.ts` with specs, `packages/shared/src/test-utils/validator-keys.ts` (test-only, excluded from `dist` by `tsconfig.json`), recorded `packages/shared/test/fixtures/xrpl/unl/vl.ripple.com.json`, `…/xrpl/unl/unl.xrplf.org.json`, `…/xahau/unl/vl.xahau.org.json`

**Interfaces:**
- Consumes: Task 2 profiles (`defaultUnlPublishers`).
- Produces:
  ```ts
  // node-key.ts
  function isNodePublicKey(text: string): boolean;               // ripple-address-codec decodeNodePublic accepts it, first byte 02/03/ED
  function nodePublicKeyFromHex(hex: string): string | undefined; // 66 hex (any case), first byte 02/03/ED -> base58
  function nodePublicKeyToHex(base58: string): string;            // upper hex
  // manifest.ts
  const REVOKED_SEQUENCE = 0xffff_ffff;
  interface Manifest { masterKey: string; masterKeyHex: string; sequence: number; revoked: boolean;
                       signingKey?: string; signingKeyHex?: string; domain?: string; hex: string /* upper */ }
  class ManifestError extends Error { readonly reason = 'manifest_invalid' }
  function decodeManifest(bytes: string, encoding: 'hex' | 'base64'): Manifest;   // throws ManifestError
  function verifyManifest(m: Manifest): boolean;
  function isProperlyFormedTomlDomain(domain: string): boolean;
  // unl-list.ts
  type UnlFailure = 'invalid_format' | 'untrusted_key' | 'manifest_invalid' | 'revoked' | 'signature_invalid' | 'blob_invalid';
  class UnlListError extends Error { constructor(readonly reason: UnlFailure, message?: string) }
  interface UnlBlob { sequence: number; effective?: number; expiration: number /* unix s */; blobSha256: string /* upper hex of the decoded blob */;
                      validators: { masterKey: string; manifest?: string /* base64 */ }[] }
  interface VerifiedUnlList { version: 1 | 2; publisherKey: string; manifest: Manifest; blobs: UnlBlob[]; refreshIntervalMinutes?: number }
  function verifyUnlList(body: unknown, configuredKey: string): VerifiedUnlList;  // throws UnlListError
  function classifyUnlBlob(blob: UnlBlob, newestStoredSequence: number | undefined, nowSeconds: number): 'new' | 'unchanged' | 'stale' | 'expired';
  // test-utils/validator-keys.ts (tests of shared, syncer and api import it by relative path)
  interface TestKey { publicKeyHex: string; base58: string; sign(messageHex: string): string }
  function testKey(label: string, algorithm?: 'ed25519' | 'ecdsa-secp256k1'): TestKey;   // deterministic: entropy = sha256(label)[0..16]
  function makeManifest(o: { master: TestKey; signing?: TestKey; sequence: number; domain?: string }): string;           // upper hex, signed
  function makeUnlBlob(o: { sequence: number; expiration: number; effective?: number; validators: { master: TestKey; manifestHex?: string }[] }): string; // base64; times unix s
  function makeUnlResponse(o: { publisher: TestKey; publisherSigning: TestKey; manifestSequence?: number; version?: 1 | 2;
                                blobs: { blob: string; signer?: TestKey }[]; refreshInterval?: number }): Record<string, unknown>;
  ```

Rules (F14, F15, spec §2.1):
- A manifest is an STObject `{PublicKey, MasterSignature, Sequence, Domain?, SigningPubKey, Signature}` decoded with `ripple-binary-codec` `decode`; `encode(decode(hex))` must equal the input, else `manifest_invalid`. Both signatures verify (`ripple-keypairs` `verify`) over `4D414E00` (`MAN\0`) + `encode` of the object without `Signature` and `MasterSignature`: `MasterSignature` with `PublicKey`, `Signature` with `SigningPubKey`. Sequence `0xFFFFFFFF` is revoked: only the master signature, no signing key. `Domain` is hex of ASCII. The decoder does not judge the domain; `isProperlyFormedTomlDomain` does: length 4–128 and `/^((?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/`.
- `verifyUnlList`, in rippled's order: (1) JSON with `public_key`, `manifest`, `version`: 1 means `blob` and `signature` and no `blobs_v2`; any other version is read as 2 and means `blobs_v2` of 1 to 5 entries `{blob, signature, manifest?}` and no `blob`/`signature`; else `invalid_format`. (2) `public_key` equals `configuredKey`, case-insensitive, else `untrusted_key`. (3) the publisher manifest decodes, its `PublicKey` is that key, it verifies, else `manifest_invalid`; revoked → `revoked`; a v2 entry's own `manifest`, when present and of a higher sequence, replaces the publisher manifest for that blob. (4) each `signature` (hex) verifies over the base64-decoded blob with the manifest's signing key, else `signature_invalid`. (5) each blob is JSON with integer `sequence`, `expiration`, optional `effective`, and `validators` whose entries have a 33-byte hex `validation_public_key`; `expiration > effective`; else `blob_invalid`. Times are Ripple-epoch seconds (+ 946,684,800 → unix). `refresh_interval` (minutes) is read from the body.
- `classifyUnlBlob`: sequence below the newest stored → `stale`; equal → `unchanged`; `expiration <= now` → `expired`; else `new`.
- `record-fixtures --unl --network xrpl|xahau [--out dir]`: GETs each default publisher URL of the profile (Node `https`, at most 3 redirects) and saves the body as served to `test/fixtures/<network>/unl/<id>.json`.

- [ ] **Step 1: Record the fixtures and write the failing tests.** Run `pnpm --filter @gatehub/data-api-shared record:fixtures -- --unl --network xrpl` and `… --network xahau`. Tests:
  - `manifest.spec.ts`: every validator manifest inside the recorded blobs decodes and verifies, and its `masterKey` is the entry's `validation_public_key` in base58; flipping one byte of `Sequence` → `verifyManifest` false; a revoked manifest made with `makeManifest({ sequence: REVOKED_SEQUENCE })` decodes with `revoked: true` and verifies; a manifest with domain `localhost` verifies but `isProperlyFormedTomlDomain('localhost')` is false; `isProperlyFormedTomlDomain` accepts `northpeak.example`, `a-b.example.com` and refuses `-a.com`, `a-.com`, `1.2.3.4`, `a.com:443`, `a.com/x`, `a.c0m`, `abc`.
  - `unl-list.spec.ts`: each recorded list verifies with its profile key: version 1, one blob, and the values recorded (F14 on 2026-10-19: vl.ripple.com sequence 85 with 35 validators, unl.xrplf.org 2026070302 / 35, vl.xahau.org 2026092401 / 19; assert what was recorded and write it in the fixtures README). Each reason from a mutated copy: another configured key → `untrusted_key`; a byte of the publisher manifest's signature → `manifest_invalid`; a byte of the blob signature → `signature_invalid`; a test-signed v2 with 6 blobs, and a v2 body that also has `blob` → `invalid_format`; a blob without `expiration`, with `expiration <= effective`, or with a 32-byte key → `blob_invalid`; a revoked publisher manifest → `revoked`. `classifyUnlBlob`: 84 vs stored 85 → `stale`, 85 → `unchanged`, an expiration in the past → `expired`, a future `effective` → `new`.
  - `node-key.spec.ts`: hex ↔ base58 round trip of the recorded master keys; `isNodePublicKey` false for a classic address, a truncated key and `summary`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- validators` fails: modules not found.
- [ ] **Step 3: Implement the three modules and the test utilities.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-shared test` exits 0; `pnpm build` exits 0.
- [ ] **Step 5: Commit.** `git add packages/shared pnpm-lock.yaml` — `feat(shared): manifest and UNL list verification, recorded lists`.

---

### Task 4: Amendment metadata

**Files:**
- Create: `packages/shared/src/validators/amendments-config.ts` (+ spec), `packages/shared/src/validators/amendments-check.ts` (pure findings, + spec), `packages/shared/src/validators/ledger-objects.ts`, `packages/shared/config/amendments/xrpl.json`, `packages/shared/config/amendments/xahau.json`, `packages/shared/scripts/amendments-check.ts`
- Modify: `packages/shared/package.json` (script `"amendments:check": "ts-node scripts/amendments-check.ts"`), `packages/shared/src/validators/index.ts`, `docs/operations.md` (a "Keep the amendment metadata current" routine and the release checklist line: a rippled or xahaud release with new amendments gets its entries before the deploy)

**Interfaces:**
- Consumes: Task 2 `NetworkProfile`; `NodeClient` (shared) in the script.
- Produces:
  ```ts
  const AMENDMENTS_OBJECT_INDEX = '7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4';
  const NEGATIVE_UNL_OBJECT_INDEX = '2E8A59AA9D3B5B186B0B9E0F62E6C02587CA74A4D778938E957B6357D364B244';
  const FEE_SETTINGS_OBJECT_INDEX = '4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651';
  interface AmendmentMeta { name: string; id: string; introduced?: string; xls?: string; xls_url?: string; description?: string;
                            enabled?: { ledger_index?: number; date?: string }; obsolete?: true; retired?: true }
  interface AmendmentsConfig { network: NetworkName; updated: string; amendments: AmendmentMeta[];
                               byId: ReadonlyMap<string, AmendmentMeta>; byName: ReadonlyMap<string, AmendmentMeta> }
  function amendmentId(name: string): string;                                   // SHA-512Half(name), upper hex (F9)
  function parseAmendmentsConfig(raw: unknown, profile: NetworkProfile): AmendmentsConfig;   // throws Error('Invalid amendments config: <where>: <why>')
  function loadAmendmentsConfig(profile: NetworkProfile, path?: string): AmendmentsConfig;   // default config/amendments/<network>.json next to config/markets
  interface AmendmentsCheckFindings { missingNames: string[]; unnamedIds: string[]; contradictions: { name: string; file: number; indexed: number }[] }
  function amendmentsCheckFindings(i: { config: AmendmentsConfig; nodeFeatures: { id: string; name?: string }[]; ledgerIds: string[];
                                        votedIds?: string[]; enabledEvents?: { id: string; ledgerIndex: number }[] }): AmendmentsCheckFindings;
  ```

File rules (spec §2.6, G2), each checked by `parseAmendmentsConfig`; `<where>` is the top-level key or `amendments[<i>] (<name>)`:
- Top level exactly `network` (= the profile's name), `updated` (`YYYY-MM-DD`), `amendments`; unknown keys refused, in entries and in `enabled` too.
- `name` required, unique, `/^[A-Za-z][A-Za-z0-9_]{0,63}$/`; the ID is computed, never written.
- `introduced`: XRPL `/^\d+\.\d+\.\d+$/` (rippled semver), Xahau `/^\d{4}\.\d{1,2}\.\d{1,2}$/` (xahaud date version).
- `xls`: `/^XLS-\d+$/`. `xls_url`: parsed with `new URL`: protocol `https:`, host `github.com`, no port, no username or password, pathname starting `/XRPLF/XRPL-Standards/`.
- `description`: one line, at most 200 characters. `enabled`: `ledger_index` (positive integer) and/or `date` (`YYYY-MM-DD`), at least one. `obsolete: true`; `retired: true` only on Xahau.

Initial content (written while executing this task, from the sources the spec names): XRPL from xrpl.org's known-amendments page and the rippled release notes, every name of rippled develop's `features.macro` included (`VoteBehavior::Obsolete` and withdrawn ones such as `CryptoConditionsSuite`, `NonFungibleTokensV1`, `fixNFTokenDirV1`, `fixNFTokenNegOffer` marked `obsolete`); Xahau from xahaud's `features.macro` and release notes, `obsolete` for XRPL-era names Xahau never uses, and `retired: true` exactly for `MultiSign`, `TrustSetAuth`, `FeeEscalation`, `PayChan`, `CryptoConditions`, `TickSize`, `fix1368`, `Escrow`, `fix1373`, `EnforceInvariants`, `SortedDirectories`, `fix1201`, `fix1512`, `fix1523`, `fix1528`. `enabled` only for amendments enabled before the indexed history. A name the node lacks (F10: s1.ripple.com does not know `98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76`) is found by hashing the names of the latest `features.macro`.

`amendments:check --network xrpl|xahau [--endpoint <wss>] [--clickhouse]`: `feature` and `ledger_entry` of `AMENDMENTS_OBJECT_INDEX` (`ledger_index: 'validated'`) on the endpoint (default the profile's first default endpoint); with `--clickhouse` also the newest round's voted IDs (`amendment_tallies`) and the indexed `EnableAmendment` events with flags 0 (`tx_by_type` → `transactions`) of the `GH_CLICKHOUSE_*` database. It prints the three lists of findings and exits 1 when any is non-empty.

- [ ] **Step 1: Write the failing tests.**
  ```ts
  expect(amendmentId('AMM')).toBe('8CC0774A3BF66D1D22E76BBDA8E8A232E6B6313834301B3B23E8601196AE6455');
  expect(amendmentId('XChainBridge')).toBe('C98D98EE9616ACD36E81FDEB8D41D349BF5F1B41DD64A0ABC1FE9AA5EA267E9C');
  expect(amendmentId('MultiSign')).toBe('4C97EBA926031A7CF7D7B36FDE3ED66DDA5421192D63DE53FFB46E43B9DC8373');
  expect(amendmentId('fixNFTokenNegOffer')).toBe('36799EA497B1369B170805C078AEFE6188345F9B3E324C21E9CA3FF574E3C3D6');
  expect(amendmentId('CryptoConditionsSuite')).toBe('86E83A7D2ECE3AD5FA87AB2195AE015C950469ABF0B72EAACED318F74886AE90');
  ```
  `parseAmendmentsConfig`: the shipped files load for their profiles; `xls_url` `https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0030-automated-market-maker` accepted; refused, each with a message naming the entry: `http://github.com/XRPLF/XRPL-Standards/x`, `https://gitlab.com/XRPLF/XRPL-Standards/x`, `https://github.com:8443/XRPLF/XRPL-Standards/x`, `https://u:p@github.com/XRPLF/XRPL-Standards/x`, `https://github.com/XRPLF/other/x`; a duplicate name, an unknown key (`foo`), a 201-character description, `retired` on XRPL, `introduced: '2024.4.21'` on XRPL and `'1.12.0'` on Xahau, `network: 'xahau'` in the XRPL file. `amendmentsCheckFindings`: a node name missing from the file → `missingNames`; a ledger ID named neither by the file nor by the node → `unnamedIds`; a file `enabled.ledger_index` differing from an indexed event → `contradictions`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-shared test -- amendments` fails: module not found.
- [ ] **Step 3: Implement the loader, the findings, the script and write both files.**
- [ ] **Step 4: Run the tests, then the check.** `pnpm --filter @gatehub/data-api-shared test` exits 0; `pnpm --filter @gatehub/data-api-shared amendments:check -- --network xrpl` and `-- --network xahau` exit 0 (if an ID remains that no source names, report it in the hand-back instead of inventing a name).
- [ ] **Step 5: Commit.** `git add packages/shared docs/operations.md` — `feat(shared): amendment metadata per network and amendments:check`.

---

### Task 5: Configuration and metrics

**Files:**
- Modify: `apps/syncer/src/config/syncer.config.ts` (+ spec), `apps/api/src/config/api.config.ts` (+ spec), `apps/syncer/src/modules/prometheus/prometheus.service.ts` (+ spec), `apps/syncer/.env.example`, `apps/api/.env.example`, `deploy/.env.prod.example`, `docker-compose.yaml`, `docker-compose.prod.yaml`, `docs/configuration.md` (§4, §5, §7 and the "Keeping this page true" list), `docs/observability.md` (§4 metrics, §6 alerts)

**Interfaces:**
- Consumes: Task 2 `parseUnlPublishers`, `defaultUnlThreshold`, `NetworkProfile.defaultUnlPublishers` (through `dist/network`).
- Produces:
  ```ts
  // SyncerConfig
  WORKER_NAMES = ['ingest', 'validations', 'fee_stats', 'aggregator', 'validators'];   // default GH_WORKERS follows
  unlPublishers: string;            // GH_UNL_PUBLISHERS: unset -> profile.defaultUnlPublishers; set but empty -> '' (no lists)
  unlThreshold: number = 0;         // GH_UNL_THRESHOLD, 0 .. number of publishers
  unlRefreshMs: number = 300000;    // GH_UNL_REFRESH_MS, >= 1
  domainVerification: boolean = true;       // GH_DOMAIN_VERIFICATION (true/false/1/0)
  domainRecheckMs: number = 21600000;       // GH_DOMAIN_RECHECK_MS, >= 1
  domainFetchTimeoutMs: number = 10000;     // GH_DOMAIN_FETCH_TIMEOUT_MS, >= 1
  amendmentsConfig: string = '';            // GH_AMENDMENTS_CONFIG, '' = the shipped file
  function unlPublishersOf(cfg: SyncerConfig): UnlPublisherConfig[];
  function unlThresholdOf(cfg: SyncerConfig): number;   // 0 -> defaultUnlThreshold(publishers)
  // ApiConfig
  amendmentsConfig: string = '';            // GH_AMENDMENTS_CONFIG (@MaybeEmptyText)
  // PrometheusService gains (property: metric name, type, labels)
  validatorsUnlFetchesTotal: syncer_validators_unl_fetches_total, Counter, [publisher, outcome]
  validatorsUnlExpirySeconds: syncer_validators_unl_expiry_seconds, Gauge, [publisher]
  validatorsUnlSize: syncer_validators_unl_size, Gauge, [publisher]
  validatorsDomainChecksTotal: syncer_validators_domain_checks_total, Counter, [outcome]
  validatorsNodePollsTotal: syncer_validators_node_polls_total, Counter, [request, outcome]
  validatorsJobsTotal: syncer_validators_jobs_total, Counter, [job, outcome]
  validatorsAgreementLagSeconds: syncer_validators_agreement_lag_seconds, Gauge
  validatorsRoundsLagLedgers: syncer_validators_rounds_lag_ledgers, Gauge
  amendmentsWithoutMetadata: syncer_amendments_without_metadata, Gauge
  validatorValidationsFlushedTotal: syncer_validator_validations_flushed_total, Counter, [table]
  ```
  (Help texts from spec §6.) The worker module is registered in Task 8; until then an enabled `validators` is warned about and skipped by `selectWorkerModules`.

- Compose: dev and prod syncers get `GH_UNL_PUBLISHERS: ${XRPL_UNL_PUBLISHERS:-<the XRPL default text>}` (Xahau the same with its default), because an empty value means "no lists"; syncers and apis get `GH_AMENDMENTS_CONFIG: ${XRPL_AMENDMENTS_CONFIG:-}` / `${XAHAU_AMENDMENTS_CONFIG:-}` with a commented `volumes:` line as for the markets config; `x-syncer-env` passes `GH_UNL_THRESHOLD:`, `GH_UNL_REFRESH_MS:`, `GH_DOMAIN_VERIFICATION:`, `GH_DOMAIN_RECHECK_MS:`, `GH_DOMAIN_FETCH_TIMEOUT_MS:`. `.env.example` files document each variable with its default; `GH_WORKERS` examples list five workers.
- Alerts (`docs/observability.md`): `syncer_validators_unl_expiry_seconds < 7 * 86400`; `syncer_validators_agreement_lag_seconds > 7200` for 30 min; `syncer_validators_rounds_lag_ledgers > 1024` for 30 min; `rate(syncer_validators_jobs_total{outcome="error"}[15m]) > 0` for 30 min; `syncer_amendments_without_metadata > 0` for a day.

- [ ] **Step 1: Write the failing tests.** `syncer.config.spec.ts`: defaults (`workers` = `'ingest,validations,fee_stats,aggregator,validators'`, `unlPublishers` = the network's default text for `GH_NETWORK=xahau` too, the numbers above); `GH_UNL_PUBLISHERS=''` → `unlPublishersOf` `[]`; invalid values fail the boot with a message naming the variable: `GH_UNL_PUBLISHERS=http://x=ED…`, a 64-digit key, a duplicate; `GH_UNL_THRESHOLD=3` with two publishers; `GH_DOMAIN_VERIFICATION=maybe`; `GH_DOMAIN_RECHECK_MS=0`; `unlThresholdOf` 0 → 1 with two publishers. `api.config.spec.ts`: `GH_AMENDMENTS_CONFIG` defaults to `''` and keeps a path. `prometheus.service.spec.ts`: the ten names and label sets appear in `getMetrics()`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- config prometheus` and `pnpm --filter @gatehub/data-api-service test -- api.config` fail on the missing properties.
- [ ] **Step 3: Implement the config fields, the helpers, the metrics, compose, env examples and docs.**
- [ ] **Step 4: Run the tests to verify they pass.** Both packages' `test` exit 0; `pnpm build` exits 0; the `docs/configuration.md` "Keeping this page true" script prints every new name, and each has a row.
- [ ] **Step 5: Commit.** `git add apps deploy docker-compose.yaml docker-compose.prod.yaml docs/configuration.md docs/observability.md` — `feat(syncer): configuration and metrics of the validators worker`.

---

### Task 6: Collector: versions, raw manifests, per-validator tables

**Files:**
- Modify: `apps/syncer/src/validations/validations-collector.ts` (+ `validations-collector.spec.ts`), `apps/syncer/test/validations.e2e-spec.ts`, `docs/syncer.md` §5

**Interfaces:**
- Consumes: Task 1 `ValidatorValidationsRow`, `ValidatorSeenRow`, the changed `ValidationsRow` / `ValidatorManifestsRow`; Task 5 `validatorValidationsFlushedTotal`.
- Produces: `validationRowFrom(...)` now sets `server_version` (from `msg.server_version` with the existing `uint64()`, else `null`); exported pure `byValidatorRowFrom(row: ValidationsRow): ValidatorValidationsRow` and `seenRowFrom(row: ValidationsRow): ValidatorSeenRow`; `flush()` writes `validator_manifests`, `validations`, `validator_validations`, `validator_seen` in that order.

Behaviour (spec §1.2):
- `handleManifest` also keeps `msg.domain` (text) and `msg.manifest` (hex, upper-cased) with `source: 'stream'`; the `manifest` RPC lookup keeps `answer.details.domain` and `answer.manifest` (base64 → upper hex) with `source: 'rpc'`. The highest-`seq` rule is unchanged.
- `record()` also merges the sighting into two more buffers: by `${master}|${ledger_index}|${ledger_hash}` (count sum, first min, last max, `full` max, the other fields of the first sighting) and by master key (`first_seen` min, `last_seen` max, `last_ledger_index` max).
- Each of the two tables keeps its own pending batches. A flush first re-sends the batches of earlier failed flushes (oldest first, each with its own token), then the new batch with token `vc:<bootId>:<table>:<flushSeq>` (`bootId` = `randomUUID()` at construction, `flushSeq` + 1 per flush). A failed batch stays pending unchanged (so a replay of a batch that did land is dropped by the dedup window) and is counted `syncer_validations_errors_total{stage="flush_by_validator"|"flush_seen"}`. Pending rows per table are capped at `maxBufferedRows` (the oldest batch dropped first, counted `buffer_full`). A failure of one table neither stops the tables after it nor re-sends the tables that succeeded; `flush()` still rejects when the `validations` insert failed, after trying the others.
- Nothing else changes: the master-key resolution, the 20 s flush, the shutdown budget.

- [ ] **Step 1: Write the failing tests.** Unit (fake `ClickHouseService` recording `insert(table, rows, opts)`): `writes server_version as exact digits` (`'1745992596280311808'`; absent → `null`); `keeps the domain and the raw manifest of a stream manifest` (hex upper, `source 'stream'`); `keeps them from the manifest RPC, base64 to hex` (`source 'rpc'`); `writes the four tables in order`; `re-sends a failed validator_validations batch with its own token before the new one` (tokens `vc:<boot>:validator_validations:1` then `…:2`); `does not re-send a table that succeeded when another failed`; `one validator_seen row per master: min first, max last, max ledger`. E2E (real ClickHouse, existing harness): the four tables hold the rows of a flush; a replay of a batch with its token adds nothing (`sum(count)` unchanged); `server_version` reads back exactly.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- validations-collector` fails on the missing fields and inserts.
- [ ] **Step 3: Implement the collector changes.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` and `pnpm --filter @gatehub/data-syncer test:e2e -- validations` exit 0.
- [ ] **Step 5: Commit.** `git add apps/syncer docs/syncer.md` — `feat(syncer): validator versions, raw manifests and per-validator tables in the collector`.

---

### Task 7: The safe fetcher

**Files:**
- Create: `apps/syncer/src/validators/safe-fetch.ts` (+ `safe-fetch.spec.ts`), `apps/syncer/test/support/tls.ts` (exports `TEST_TLS = { key, cert }` read from the two files below; its header comment holds the `openssl req -x509` command that made them), `apps/syncer/test/support/tls/example.key`, `apps/syncer/test/support/tls/example.crt` (self-signed, SAN `DNS:*.example`, test-only)
- Modify: `docs/security.md` (§1 trust boundaries, §9: outbound HTTPS to arbitrary public hosts and its rules; §10 checklist), `docs/deployment.md` (egress: the publishers, and validator domains or `GH_DOMAIN_VERIFICATION=false`)

**Interfaces:**
- Consumes: Task 3 `isProperlyFormedTomlDomain`.
- Produces:
  ```ts
  type FetchFailure = 'domain_invalid' | 'dns_error' | 'blocked_address' | 'connect_error' | 'tls_error' | 'timeout'
                    | 'http_status' | 'too_large' | 'redirect_rejected';
  class SafeFetchError extends Error { readonly reason: FetchFailure; readonly statusCode?: number; readonly addressClass?: string }
  interface FetchLimits { timeoutMs: number; maxBytes: number; maxRedirects: number }
  const UNL_FETCH_LIMITS: FetchLimits = { timeoutMs: 20_000, maxBytes: 1_048_576, maxRedirects: 3 };
  const tomlFetchLimits = (timeoutMs: number): FetchLimits => ({ timeoutMs, maxBytes: 262_144, maxRedirects: 3 });
  interface SafeFetchTestOptions { resolve?: (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;
                                   allowAddress?: (address: string, family: 4 | 6) => boolean; ca?: string | Buffer; connectPort?: number }
  function blockedRangeOf(address: string): string | undefined;   // the CIDR that blocks it, undefined for a public address
  const SAFE_FETCHER = Symbol('SAFE_FETCHER');
  class SafeFetcher {
    constructor(userAgent: string, test?: SafeFetchTestOptions);
    get(url: string, limits: FetchLimits, accept: string): Promise<{ url: string; body: Buffer }>;   // throws SafeFetchError
  }
  ```

Rules (spec §8.1), all fixed in code:
- URL: `https:`, port 443 (absent or `:443`), no username or password, host passing `isProperlyFormedTomlDomain`. First URL: any of these broken → `domain_invalid`. Redirect target: another scheme, port or credentials, or a fourth redirect → `redirect_rejected`; otherwise its host is checked from the top like the first URL (syntax → `domain_invalid`, DNS → `dns_error` / `blocked_address`). `HTTP_PROXY`/`HTTPS_PROXY` are ignored (no agent from the environment).
- DNS: all A and AAAA records resolved before connecting (`dns.promises.resolve4` + `resolve6`; none → `dns_error`); refused (`blocked_address`, with the range as `addressClass`) if **any** address is in: IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`; IPv6 `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `100::/64`, `64:ff9b::/96`, `2002::/16`; `::ffff:0:0/96` judged by its IPv4 (both dotted and hex forms).
- Pinning: the request's `lookup` returns the checked address (no second DNS query), with SNI `servername` and `Host` the domain; default trust store (or `test.ca`), certificate checked against the domain, no override.
- Limits: overall timeout across redirects → `timeout`; only status 200 accepted (else `http_status` with `statusCode`; 3xx followed by hand); body cap enforced while reading, and a `Content-Length` above it refused before reading → `too_large`; no cookies; headers `Accept: <accept>` and `User-Agent: gatehub-data-api/<version of apps/syncer/package.json> (validators)`; TLS failures → `tls_error`; socket failures → `connect_error`.
- `SafeFetchTestOptions` exist only for tests (passed through the worker's options token, Task 8); no environment variable can loosen a rule. `connectPort` replaces only the TCP port connected to, not the URL rule.

- [ ] **Step 1: Write the failing tests** (`safe-fetch.spec.ts`; local HTTPS servers on 127.0.0.1 with `TEST_TLS`, `test` options resolving `*.example` to them, `allowAddress` admitting loopback, `ca` the test cert, `connectPort` the server's port):
  - `it('refuses every blocked range')`: `blockedRangeOf` returns the range for one address inside each range above (`10.1.2.3`, `100.64.0.1`, `169.254.1.1`, `172.31.255.255`, `198.19.0.1`, `::1`, `fd00::1`, `fe80::1`, `2001:db8::1`, `64:ff9b::1`, `2002::1`, `::ffff:127.0.0.1`, `::ffff:7f00:1`, …) and `undefined` for `8.8.8.8`, `172.32.0.1`, `2606:4700::1111`.
  - `it('refuses a host with one private address among public ones')` (default policy, a resolver returning `93.184.216.34` and `10.0.0.1`) → `blocked_address`, no connection made.
  - `it('connects to the address it checked')`: a resolver that answers `127.0.0.1` on its first call and `127.0.0.2` after: one resolve per hop, the server sees the request, `Host: a.example`.
  - `it('checks every redirect from the top')`: 3 redirects followed; a 4th → `redirect_rejected`; to `http://` or `:8443` → `redirect_rejected`; to a host resolving to a blocked address (default `allowAddress`) → `blocked_address`.
  - `too_large` for a 300 KiB body under the TOML limits and for a `Content-Length: 2000000` under the list limits; `timeout` for a server that never answers (limits `timeoutMs: 200`); `http_status` with 404 and 503; `tls_error` without `ca`; `HTTPS_PROXY=http://127.0.0.1:1` set changes nothing; the `User-Agent` and `Accept` headers; no `Cookie` header after a `Set-Cookie`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- safe-fetch` fails: module not found.
- [ ] **Step 3: Implement `safe-fetch.ts`** with `node:https`, `node:dns`, `node:net` (`BlockList` or explicit prefix checks).
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` exits 0.
- [ ] **Step 5: Commit.** `git add apps/syncer/src/validators/safe-fetch.ts apps/syncer/src/validators/safe-fetch.spec.ts apps/syncer/test/support docs/security.md docs/deployment.md` — `feat(syncer): SSRF-safe fetcher for UNL lists and validator TOML files`.

---

### Task 8: The validators worker and UNL lists

**Files:**
- Create: `apps/syncer/src/validators/validators.module.ts`, `validators.options.ts`, `validators-worker.ts` (+ spec), `unl-fetcher.ts` (+ spec), `stored-lists.ts`; `apps/syncer/test/validators.e2e-spec.ts`; `apps/syncer/test/support/validators-env.ts` (a local HTTPS publisher/TOML server with `TEST_TLS`, a fake node websocket server answering by `command`, the `SafeFetchTestOptions` for `*.example`, a migrated ClickHouse)
- Modify: `apps/syncer/src/worker-registry.ts` (`validators: ValidatorsModule`; `NODE_CLIENT_WORKERS` gains `'validators'`) (+ spec), `docs/syncer.md` (a section "The validators worker": the two loops, why a worker, and §2.1), `docs/operations.md` (rotating a publisher key: change `GH_UNL_PUBLISHERS`, restart; the old publisher becomes `configured = 0`)

**Interfaces:**
- Consumes: Task 2 `parseUnlPublishers`, `listInUse`; Task 3 `verifyUnlList`, `classifyUnlBlob`, `decodeManifest`, `verifyManifest`; Task 5 `unlPublishersOf`, `unlThresholdOf`, the metrics; Task 7 `SafeFetcher`, `UNL_FETCH_LIMITS`.
- Produces:
  ```ts
  const VALIDATORS_WORKER_OPTIONS = Symbol('VALIDATORS_WORKER_OPTIONS');
  interface ValidatorsWorkerOptions { now?: () => number; logger?: Pick<Logger, 'log' | 'warn' | 'error'>; fetch?: SafeFetchTestOptions;
                                      start?: { unl?: boolean; domains?: boolean; state?: boolean; compute?: boolean } /* default all true */ }
  function readStoredLists(ch: ClickHouseService, publishers: readonly string[]): Promise<StoredUnlList[]>;
  type UnlOutcome = 'ok' | 'unchanged' | 'stale' | 'expired' | UnlFailure | FetchFailure;
  class UnlFetcher {
    registerPublishers(): Promise<void>;          // at start: a row per configured publisher; configured = 0 for stored ones no longer configured
    fetchOnce(id: string): Promise<UnlOutcome>;
    start(): void; stop(): Promise<void>;
  }
  @Injectable() class ValidatorsWorker implements OnApplicationBootstrap, OnModuleDestroy { stop(): Promise<void> }
  ```

Behaviour (spec §2.1):
- Fetch at start, then every `GH_UNL_REFRESH_MS` or the response's `refresh_interval` minutes clamped to 1 min–24 h; after a failure 30 s, doubling to 10 min; one fetch per publisher at a time; through `SafeFetcher.get(url, UNL_FETCH_LIMITS, 'application/json')`, JSON parsed after the cap (`invalid_format` when not JSON).
- Attempt outcome: the response is rejected whole on steps 1–5; then each blob is classified: every `new` blob is one `unl_lists` row (`publisher` id, `publisher_key` upper hex, `sequence`, `version`, `effective`, `expiration`, `validators` base58 sorted, `blob_sha256`, `fetched_at`, `response` the JSON as served); outcome `ok` if any blob was new, else `unchanged` if any was unchanged, else the first blob's `stale`/`expired`. Every validator manifest inside a written blob is decoded and verified and written to `validator_manifests` with `source: 'unl'` (revoked ones have no signing key and are skipped; an invalid one is skipped, logged and counted `outcome="validator_manifest_invalid"`).
- Every attempt writes the publisher's `unl_publishers` row: `url`, `publisher_key`, `configured 1`, `threshold` (= `unlThresholdOf`), `checked_at`, `status` `ok` (outcome `ok`/`unchanged`) or `error`, `error` the outcome code or `''`, `last_ok_at` now when ok, else kept. The start row of a publisher with no stored row is `status 'ok', error '', last_ok_at NULL`; of a stored one, its stored values.
- Metrics after each attempt: `syncer_validators_unl_fetches_total{publisher, outcome}`; `…_unl_expiry_seconds{publisher}` = expiration of the list in use − now (negative when expired); `…_unl_size{publisher}` = its validators. A publisher's status is logged only when it changes.
- `ValidatorsWorker`: on bootstrap (unless `start.unl === false`) `registerPublishers()` then `UnlFetcher.start()`; registers `ShutdownSignals` `'validators'`; `stop()` stops every loop, waits at most 2 s. Tasks 9–12 add their loops here. `ValidatorsModule` provides `SAFE_FETCHER` (`new SafeFetcher(userAgent, options.fetch)`), `UnlFetcher`, `ValidatorsWorker`; it injects `SyncerConfig`, `NETWORK_PROFILE`, `NODE_CLIENT`, `ClickHouseService`, `PrometheusService`, `ShutdownSignals` from the core module.

- [ ] **Step 1: Write the failing tests.** Unit (`unl-fetcher.spec.ts`, fake fetcher and ClickHouse): `waits refresh_interval minutes, clamped to 1 min and 24 h` (0 → 60 s, 2000 → 86 400 s); `backs off 30 s doubling to 10 min after failures`; `maps each outcome to the publisher row and the metric`. `worker-registry.spec.ts`: `validators` is registered and reads the node client. E2E (`validators.e2e-spec.ts`, publisher `https://unl.example` serving test-signed lists, `GH_UNL_PUBLISHERS` keyed to the test publisher):
  - `it('stores a new list, its validator manifests and an ok publisher row')`;
  - `it('writes nothing for the same sequence again')` (outcome `unchanged`, one `unl_lists` row);
  - `it('never stores a list that fails verification')` (a tampered signature: `error 'signature_invalid'`, the earlier list still the only row);
  - `it('keeps using an expired list')` (the newest served list is expired: `error 'expired'`; `listInUse` of the stored rows is the old list with `expired: true`; the expiry gauge is negative);
  - `it('marks a publisher no longer configured')` (restart with another `GH_UNL_PUBLISHERS`: the old row has `configured 0`).
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- unl-fetcher worker-registry` and `pnpm --filter @gatehub/data-syncer test:e2e -- validators` fail: modules not found.
- [ ] **Step 3: Implement the module, options, worker, fetcher and `readStoredLists`** (`readStoredLists` reads `unl_lists` of the given publishers deduped by `(publisher, sequence)` with `argMax(…, fetched_at)`).
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` and `test:e2e -- validators` exit 0.
- [ ] **Step 5: Commit.** `git add apps/syncer docs/syncer.md docs/operations.md` — `feat(syncer): validators worker fetching and verifying UNL lists`.

---

### Task 9: Domain verification

**Files:**
- Create: `apps/syncer/src/validators/toml-match.ts` (+ spec), `apps/syncer/src/validators/domain-checker.ts` (+ spec)
- Modify: `apps/syncer/package.json` (`"smol-toml": "1.3.1"`, exact; then `pnpm install --offline`), `pnpm-lock.yaml`, `validators.module.ts`, `validators-worker.ts` (a pass every 60 s while `GH_DOMAIN_VERIFICATION` is true), `apps/syncer/test/validators.e2e-spec.ts`, `docs/syncer.md` (§2.2)

**Interfaces:**
- Consumes: Task 3 `decodeManifest`, `verifyManifest`, `isProperlyFormedTomlDomain`; Task 7 `SafeFetcher`, `tomlFetchLimits`, `SafeFetchError`; Task 8 `readStoredLists`; Task 2 `listInUse`; `NODE_CLIENT`.
- Produces:
  ```ts
  class TomlInvalidError extends Error {}
  function matchToml(text: string, masterKey: string): { listed: boolean; accounts: string[] };   // throws TomlInvalidError
  type DomainReason = '' | 'not_listed' | 'toml_invalid' | 'too_large' | 'redirect_rejected' | 'blocked_address' | 'domain_invalid'
                    | 'manifest_unverified' | 'http_status' | 'dns_error' | 'connect_error' | 'tls_error' | 'timeout';
  function isTransientReason(reason: DomainReason, statusCode?: number): boolean;   // dns/connect/tls/timeout, http_status 5xx or 429
  function nextDomainRow(prev: ValidatorDomainsRow | undefined,
                         check: { key: string; domain: string; tomlUrl: string; reason: DomainReason; statusCode?: number; accounts?: string[] },
                         now: number /* unix s */, recheckMs: number): ValidatorDomainsRow;
  class DomainChecker { pass(): Promise<number> }   // returns the checks made
  ```

Rules (spec §2.2, G1):
- Which validators: the masters on a list in use (`listInUse` at now for each configured publisher) ∪ `validator_seen` with `last_seen` in the last 30 days. For each, its newest manifest (highest `seq` per `master_key`). No raw bytes (`manifest = ''`, rows from before 002): ask the node `{ command: 'manifest', public_key: <master> }` (timeout 5 s, no retries) at most once per 10 minutes per key, and store the answer (`ephemeral_key` = `details.ephemeral_key`, `seq`, `domain` = `details.domain`, `manifest` base64 → hex) with `source: 'rpc'`; it is checked in a later pass. With raw bytes: `decodeManifest` + `verifyManifest` + matching master key, else reason `manifest_unverified` (the stream's word is not enough). No domain: no check, no row.
- Domain syntax first (`isProperlyFormedTomlDomain`), else `domain_invalid`, before any DNS query.
- Due: no row for (key, domain), or `next_check_at <= now` (a changed domain is a new pair). Never-checked first, then the oldest `next_check_at`; at most 100 per pass, at most 4 fetches in flight, one fetch per domain per pass (shared by the validators naming it).
- Fetch `https://{domain}{profile.tomlPath}` (no fall-back to the other name) with `tomlFetchLimits(GH_DOMAIN_FETCH_TIMEOUT_MS)`, accept `application/toml, text/plain, */*`.
- `matchToml`: parse with `smol-toml`; listed when a `[[VALIDATORS]]` entry's `public_key`, trimmed, equals the master key. Accounts only when listed: each `[[ACCOUNTS]].address`, trimmed, kept when `isValidClassicAddress` (from `xrpl`) holds (X-addresses, bad checksums, missing or non-string addresses skipped), deduped, sorted, the first 10. Every other field is ignored.
- `nextDomainRow`: verified → `status 'verified'`, `reason ''`, `status_code 0`, `verified_at` now, `accounts`, next check now + `recheckMs` (6 h default). Definite failure (`not_listed`, `toml_invalid`, `too_large`, `redirect_rejected`, `blocked_address`, `domain_invalid`, `manifest_unverified`, `http_status` 4xx except 429) → `unverified` with the reason (`status_code` for `http_status`), `verified_at` kept, `accounts []`, next now + `recheckMs`. Transient → when the previous row is `verified` and its `verified_at` is within 24 h, it stays `verified` with `verified_at` and `accounts` unchanged; otherwise `unverified` with the reason and no accounts; next now + 1 h. `toml_url` the URL fetched (or that would be), `checked_at` now.
- Metric `syncer_validators_domain_checks_total{outcome}` (`verified` or the reason); a domain's result is logged when it changes; a blocked fetch is logged at `warn` with the domain and `addressClass`, never the body.

- [ ] **Step 1: Write the failing tests.** `toml-match.spec.ts`: listed among many `[[VALIDATORS]]`; not listed; invalid TOML → `TomlInvalidError`; accounts: a valid address kept, a bad checksum, an X-address, a duplicate, a missing and a numeric `address` skipped, 12 valid → the first 10 sorted, none read when not listed. `domain-checker.spec.ts` (`nextDomainRow`): verified; each definite reason; `it('keeps verified through a transient failure within 24 h')` (accounts and `verified_at` unchanged, next check + 1 h); after 24 h of failures → `unverified 'timeout'`, `accounts []`; 429 transient, 404 definite. E2E: `verified` with accounts from a hand-written TOML at `https://northpeak.example/.well-known/xrp-ledger.toml`; `not_listed`; `http_status 404`; a manifest with a tampered signature → `manifest_unverified` without a fetch; a pre-002 manifest row → the fake node's `manifest` answer is stored with `source 'rpc'`, then checked; `GH_DOMAIN_VERIFICATION=false` → no rows; Xahau fetches `/.well-known/xahau.toml`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- toml-match domain-checker` fails: modules not found.
- [ ] **Step 3: Implement `matchToml`, `nextDomainRow` and `DomainChecker`; add the pass to the worker.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` and `test:e2e -- validators` exit 0.
- [ ] **Step 5: Commit.** `git add apps/syncer pnpm-lock.yaml docs/syncer.md` — `feat(syncer): validator domain verification with accounts from a verified TOML`.

---

### Task 10: Ledger state, amendment names and the metadata gauge

**Files:**
- Create: `apps/syncer/src/validators/network-state-poller.ts` (+ spec), recorded `packages/shared/test/fixtures/{xrpl,xahau}/network-state/{amendments,negative_unl,fee_settings,server_info,feature}.json`
- Modify: `packages/shared/scripts/record-fixtures.ts` (`--network-state` mode), `packages/shared/test/fixtures/README.md`, `validators.module.ts` (`AMENDMENTS_CONFIG` provider: `loadAmendmentsConfig(profile, cfg.amendmentsConfig || undefined)`, so an invalid file fails the boot), `validators-worker.ts` (state poll every 60 s; feature poll at start and every 10 min), `apps/syncer/test/validators.e2e-spec.ts`, `docs/syncer.md` (§2.3)

**Interfaces:**
- Consumes: Task 4 `*_OBJECT_INDEX`, `loadAmendmentsConfig`; Task 3 `nodePublicKeyFromHex`; `NODE_CLIENT`; Task 5 metrics.
- Produces:
  ```ts
  const AMENDMENTS_CONFIG = Symbol('AMENDMENTS_CONFIG');   // syncer-side provider in validators.module.ts
  function networkStateRowFrom(amendments: { ledger_index: number; ledger_hash?: string; node?: Record<string, unknown> },
                               negativeUnl: Record<string, unknown> | undefined, feeSettings: Record<string, unknown>,
                               validationQuorum: number | undefined, polledAt: number): NetworkStateRow;
  function featureRowsFrom(result: unknown, polledAt: number): AmendmentFeaturesRow[];
  class NetworkStatePoller { pollState(): Promise<boolean>; pollFeatures(): Promise<boolean>; updateMetadataGauge(): Promise<void> }
  ```

Rules (spec §2.3, F11):
- `pollState`: `ledger_entry { index: AMENDMENTS_OBJECT_INDEX, ledger_index: 'validated' }`; its `ledger_index` L is then used for `ledger_entry` of NegativeUNL and FeeSettings (`entryNotFound` = empty) and for `server_info` (`validation_quorum`, 0 when absent). Timeout 5 s, retries 0; a failure writes nothing (the next poll is the retry). One `network_state` row: `amendments` (`Amendments`), `majorities` (`Majorities[].Majority.{Amendment, CloseTime}`, CloseTime Ripple epoch → unix), `negative_unl` (`DisabledValidators[].DisabledValidator.{PublicKey hex → base58, FirstLedgerSequence}`), `to_disable` / `to_reenable` (`ValidatorToDisable` / `ValidatorToReEnable` hex → base58, `''` when none), fees in drops from `BaseFeeDrops` / `ReserveBaseDrops` / `ReserveIncrementDrops` or the legacy `BaseFee` (hex UInt64) / `ReserveBase` / `ReserveIncrement`.
- `pollFeatures`: `feature` → one `amendment_features` row per ID (`name` `''` when absent, `supported`).
- Each request counted `syncer_validators_node_polls_total{request: 'amendments'|'negative_unl'|'fee_settings'|'server_info'|'feature', outcome: 'ok'|'error'}`.
- `updateMetadataGauge` (after each feature poll): `syncer_amendments_without_metadata` = the IDs in the newest `amendment_features` rows, the newest `network_state` `amendments` and `majorities`, and the newest round's tallies (`amendment_tallies`, Task 11; none yet is fine) that `AMENDMENTS_CONFIG.byId` lacks; one `warn` per new ID (`amendment <ID> has no metadata entry`), remembered in memory.
- `record-fixtures --network-state --network xrpl|xahau --endpoint <wss>`: saves the four node answers above and `feature`, at most 2 requests in flight.

- [ ] **Step 1: Record the fixtures and write the failing tests.** Record with `--endpoint wss://s2.ripple.com` and `wss://xahau.network`. Unit: `networkStateRowFrom` over the recorded fixtures of each network (XRPL: the recorded NegativeUNL answer, `entryNotFound` on 2026-10-19 → empty; Xahau: one disabled validator, its key base58, `first_ledger`); a legacy FeeSettings `{ BaseFee: '000000000000000A', ReserveBase: 10000000, ReserveIncrement: 2000000 }` → `10`, `10000000`, `2000000`; `featureRowsFrom` keeps a nameless ID with `name ''`. E2E (fake node answering the recorded fixtures): one `network_state` row at the answered ledger; NegativeUNL `entryNotFound` → empty arrays; a `server_info` timeout → no row, `outcome="error"` counted; `feature` → `amendment_features` rows; an ID without metadata → gauge 1 and one warning, not repeated on the next poll.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- network-state` fails: module not found.
- [ ] **Step 3: Implement the poller, the provider and the two timers.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` and `test:e2e -- validators` exit 0.
- [ ] **Step 5: Commit.** `git add apps/syncer packages/shared/scripts packages/shared/test/fixtures docs/syncer.md` — `feat(syncer): ledger state, amendment names and the metadata gauge`.

---

### Task 11: Voting rounds and the compute loop

**Files:**
- Create: `apps/syncer/src/validators/compute-loop.ts` (+ spec), `apps/syncer/src/validators/tally.ts` (+ spec), `apps/syncer/src/validators/rounds.job.ts`, `apps/syncer/src/validators/seen-seed.ts`
- Modify: `validators-worker.ts` (seed, then start the compute loop with `[rounds]`), `apps/syncer/test/synthetic-chain.ts` (option `closeTime?: (index: number) => number`, unix seconds, written as `close_time` / `parent_close_time` in Ripple-epoch seconds), `apps/syncer/test/validators.e2e-spec.ts`, `docs/syncer.md` (§2.4, compute loop)

**Interfaces:**
- Consumes: Task 2 `trustedUnl`, `recordOf`, `quorumOf`, `amendmentThreshold`, `votingLedgerAtOrAfter`, `VoteRow`, `RoundMembership`; Task 5 `unlPublishersOf`, `unlThresholdOf`; Task 8 `readStoredLists`; Task 1 row types.
- Produces:
  ```ts
  interface ComputeTick { now: number /* ms */; deadline: number /* ms */; signal: AbortSignal }
  interface ComputeJob { readonly name: 'rounds' | 'agreement'; readonly budgetMs: number; run(tick: ComputeTick): Promise<void> }
  class ComputeLoop { constructor(jobs: ComputeJob[], o?: { intervalMs?: number /* 60_000 */; tickBudgetMs?: number /* 20_000 */;
                      shutdownWaitMs?: number /* 2_000 */; metrics?: PrometheusService; logger?: …; now?: () => number });
                      start(): void; tick(): Promise<void>; stop(): Promise<void> }
  const ROUND_DELAY_SECONDS = 120; const ROUNDS_BUDGET_MS = 5_000;
  function tallyRound(i: { round: number; closeTime: number; votes: VoteRow[]; history: VoteRow[]; membership: ReadonlyMap<number, RoundMembership>;
                           unl: ReadonlySet<string>; negativeUnl: ReadonlySet<string>; majorities: readonly string[];
                           fees: { base_fee: string; reserve_base: string; reserve_inc: string }; version: number }):
                         { tallies: AmendmentTalliesRow[] /* sentinel last */; quorum: number; observed: number };
  class RoundsJob implements ComputeJob { name: 'rounds' }
  function seedValidatorSeen(ch: ClickHouseService): Promise<boolean>;   // true when it seeded
  ```

Rules (spec §2, §2.4, F6, F7):
- `ComputeLoop`: the aggregator's job model without its file: jobs run in order each tick (rounds 5 s, then agreement 10 s, Task 12) inside a 20 s tick; each job's deadline = min(tick deadline, its start + budget); a job that throws is logged and counted (`syncer_validators_jobs_total{job, outcome: 'error'}`) and the next still runs (`outcome: 'ok'` otherwise); no overlap (a tick while one runs is skipped with a warning); shutdown aborts the signal and waits at most 2 s.
- `seedValidatorSeen`, once at start when `validator_seen` is empty: `INSERT INTO validator_seen SELECT validation_public_key, min(first_datetime), max(last_datetime), max(ledger_index) FROM validations GROUP BY validation_public_key`.
- Ready round V: `ledgers` has a committed ledger ≥ V and now ≥ close(V) + 120 s (close of the first committed ledger above V when V itself is missing). Oldest first. First round: `votingLedgerAtOrAfter(max(lowest ledger_index > 0 of the oldest active `validations` partition (from `system.parts`), lowest `ledgers.ledger_index`))`; then the newest stored round (newest sentinel) + 256. Until the deadline.
- Round V: (1) H = hash of V in `ledgers`. (2) Votes: `SELECT transform(validation_public_key, …) AS k, argMin(full, first_datetime), argMin(amendments, first_datetime), argMin(base_fee, …), argMin(reserve_base, …), argMin(reserve_inc, …), argMin(server_version, …) FROM validations WHERE ledger_hash = {H} GROUP BY k` (a primary-key lookup; the earliest sighting's values; `amendments` JSON text → array, `''` → `[]`); one `validator_votes` row each with `ledger_index` V, `ledger_hash` H, `close_time` close(V). Validations of another hash at V are ignored. (3) UNL(V) = `trustedUnl` of the stored lists at close(V) (configured publishers, `unlThresholdOf`); nUNL(V) = `negative_unl` of the newest `network_state` row with `ledger_index <= V` (none: empty). (4) History: the `validator_votes` rows and sentinels of the rounds with `close_time >= close(V) − 86 400`, version-filtered; membership from the sentinels' `unl` / `negative_unl`, plus V's own. (5) `tallyRound`: records with `recordOf(…, membership)` for each u ∈ UNL(V); `trusted` = members with a record; `yes(a)` = records containing a; `threshold` = `amendmentThreshold(trusted)`; `observed` = members with a full validation of H in this round; `unl_size` = |UNL(V)|; one row per amendment with yes > 0 or in the newest `network_state` `majorities`, then the sentinel (`amendment_id ''`, `unl`, `negative_unl`, fees). (6) Fees in force at V: the newest `SetFee` with `ledger_index <= V` (`tx_by_type` `tx_type = 'SetFee'` → `transactions.tx_json`: `BaseFeeDrops`/`ReserveBaseDrops`/`ReserveIncrementDrops`, or legacy `BaseFee` hex/`ReserveBase`/`ReserveIncrement`), else the newest `network_state`. (7) Insert `validator_votes`, then `amendment_tallies` with the sentinel last, all with one `version`.
- A V missing from `ledgers` (an ingest gap): only a sentinel, `observed 0`, `trusted 0`, `threshold 1`, `unl_size` |UNL(V)|, `close_time` of the first committed ledger above V; no vote rows.
- A round whose `observed` is below `quorumOf(|UNL|, |nUNL ∩ UNL|)` logs at `warn`: `round ${V}: recorded ${observed} of ${unl_size} UNL validations, below quorum ${quorum}`. Gauge `syncer_validators_rounds_lag_ledgers` = newest committed voting ledger − newest stored round.

- [ ] **Step 1: Write the failing tests.** Unit (`tally.spec.ts`): the 24 h carry (a record from 23 h ago counts, 25 h ago not); a negative-UNL round does not refresh a record; a validator joining the UNL counts only records from rounds it was on; an amendment in `majorities` with no yes gets a row with `yes 0`; the sentinel is last; trusted 35 → threshold 28. `compute-loop.spec.ts`: order, budgets, a failing job does not stop the next, no overlap, shutdown waits at most 2 s. E2E (synthetic chain through the real `LedgerWriter`, `closeTime` 4 s apart ending two hours ago, two voting ledgers; validations inserted for 4 UNL validators of a test-signed list and 1 other; clock past close + 120 s):
  - `it('writes votes and tallies of each round, sentinel last')` (yes, trusted 4, threshold 3, observed, fees from a seeded `SetFee`);
  - `it('counts a vote recorded under the signing key for its master')` (a `validator_manifests` row maps it);
  - `it('ignores validations of another hash at V')`;
  - `it('writes an observed-0 sentinel for a voting ledger the ingest lacks')`;
  - `it('resumes from the newest stored round after a restart')` (a new job instance writes only the next round);
  - `it('seeds validator_seen once from validations')` (and not when it has rows).
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- tally compute-loop` fails: modules not found.
- [ ] **Step 3: Implement the loop, the tally, the job and the seeding; wire them into the worker.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` and `test:e2e -- validators` exit 0.
- [ ] **Step 5: Commit.** `git add apps/syncer docs/syncer.md` — `feat(syncer): voting rounds and amendment tallies`.

---

### Task 12: Hourly agreement

**Files:**
- Create: `apps/syncer/src/validators/agreement.ts` (+ spec), `apps/syncer/src/validators/agreement.job.ts`
- Modify: `validators-worker.ts` (the compute loop runs `[rounds, agreement]`), `apps/syncer/test/validators.e2e-spec.ts`, `docs/syncer.md` (§2.5)

**Interfaces:**
- Consumes: Task 11 `ComputeJob`, `ComputeLoop`; Task 2 `trustedUnl`, `quorumOf`; Task 8 `readStoredLists`.
- Produces:
  ```ts
  const HOUR_DELAY_SECONDS = 600; const AGREEMENT_BUDGET_MS = 10_000; const TRACK_CARRY_SECONDS = 86_400;
  function gapsOf(indices: readonly number[] /* sorted L(h) */, before?: number, after?: number): number;
  interface HourAgreementInput { hour: number; ledgers: number; observed: number; gaps: number; unl: ReadonlySet<string>; quorum: number;
                                 perKey: ReadonlyMap<string, { agreed: number; partialOnly: number }>; seenInHour: ReadonlyMap<string, number /* s */>;
                                 previous: readonly ValidatorAgreementHourlyRow[]; final: boolean; version: number }
  function agreementRows(i: HourAgreementInput): ValidatorAgreementHourlyRow[];   // tracked validators, then the sentinel
  class AgreementJob implements ComputeJob { name: 'agreement' }
  ```

Rules (spec §2.5, F6, F17):
- Reference: the indexed validated chain (`ledgers`); only full validations agree. Per UTC hour h: L(h) = ledgers with `close_time` in [h, h + 1 h) (deduped by `ledger_index`); UNL(h), nUNL(h) at h + 1 h; quorum(h) = `quorumOf(|UNL|, |nUNL ∩ UNL|)`.
- Observed ledger: a ledger of L(h) whose hash has full validations recorded from at least quorum(h) UNL members (keys mapped). The others are `unobserved` (|L(h)| − observed) and count for nobody.
- `gapsOf`: (last − first + 1) − |L(h)|, plus the missing indices between the last committed ledger before the hour (`before`) and `first`, and between `last` and the first committed ledger after it (`after`); an hour with no ledgers counts the missing indices between `before` and `after`. (The spec's formula, extended to the hour's edges so that a gap at a boundary keeps the hour from being final.)
- Tracked validators: UNL(h) ∪ those with any validation received in h ∪ those of hour h − 1 (version-filtered) whose `last_seen` is within 24 h of h + 1 h. Per tracked k: `agreed` = observed ledgers with a full validation of their hash by k; `partial` = observed ledgers where k has only a partial one; `missed` = observed − agreed; `last_seen` = the newest receipt known (this hour, else the previous row). Sentinel (`validation_public_key ''`): `ledgers` (observed), `unobserved`, `gaps`, `unl_size`, `quorum`, `final`.
- The read, for a window of hours (one hour, or a whole UTC day while more than 24 hours behind), from the spec with two changes: the hashes come from a deduped `ledgers` subquery bounded by `ledger_index BETWEEN {first} AND {last}` and the window's `close_time` (a day's 21,600 hashes would not fit the HTTP query string as an array parameter), and each hash carries its hour (`toStartOfHour(close_time)`):
  ```sql
  WITH l AS (SELECT ledger_hash, any(toStartOfHour(close_time)) AS hour FROM ledgers
              WHERE ledger_index BETWEEN {first:UInt32} AND {last:UInt32}
                AND close_time >= {h0:DateTime} AND close_time < {h1:DateTime} GROUP BY ledger_hash),
  v AS (SELECT ledger_hash, transform(validation_public_key, {eph:Array(String)}, {mas:Array(String)}, validation_public_key) AS k,
               max(full) AS f
          FROM validations
         WHERE last_datetime >= {from:DateTime64(3)} AND last_datetime < {to:DateTime64(3)}   -- [h0 - 10 min, h1 + 2 h)
           AND ledger_hash IN (SELECT ledger_hash FROM l)
         GROUP BY ledger_hash, k),
  obs AS (SELECT ledger_hash FROM v WHERE f = 1 AND has({unl:Array(String)}, k)
           GROUP BY ledger_hash HAVING count() >= {quorum:UInt16})
  SELECT l.hour AS hour, v.k AS k, countIf(v.f = 1) AS agreed, countIf(v.f = 0) AS partial_only
    FROM v INNER JOIN l USING ledger_hash
   WHERE v.ledger_hash IN (SELECT ledger_hash FROM obs)
   GROUP BY hour, k
  ```
  plus the observed count per hour from `obs`, and "seen in h": `max(last_datetime)` per mapped key and hour of the rows received in [h0, h1). Day mode is used only when every hour of the day has the same UNL and quorum; otherwise that day goes hour by hour.
- Ready hour: it ended at least 10 minutes ago and the newest committed ledger closed at or after its end. Written once with `final = 1` when `gaps = 0`; with gaps, `final = 0` and recomputed at most once an hour while `validations` still holds it. Oldest first (the tracked set carries); start: the first hour after the oldest `validations` partition that `ledgers` covers. Gauge `syncer_validators_agreement_lag_seconds` = now − end of the newest final hour.

- [ ] **Step 1: Write the failing tests.** Unit (`agreement.spec.ts`): `agreementRows` — `it('leaves an under-recorded ledger out for everybody')` (3 of quorum 4 recorded: `unobserved 1`, nobody's `missed` grows); a partial-only validator → `partial 1`, `missed 1`; a validator quiet this hour but seen 23 h before the hour's end is tracked with `missed = observed`, at 25 h it is dropped; sentinel last; `gapsOf([5,6,8], 4, 9)` = 1, `gapsOf([5,6], 2, 9)` = 4, `gapsOf([], 4, 9)` = 4. E2E (synthetic chain, `closeTime` 30 s apart over three past hours; validations for 4 UNL members and 1 other):
  - `it('computes final hours with agreed, missed and partial')`;
  - `it('maps a signing-key validation to its master')`;
  - `it('writes an hour with a gap as not final and recomputes it once the gap is filled')` (the missing ledger written later, clock + 1 h);
  - `it('waits for an hour until 10 minutes after its end and the ingest has passed it')`;
  - `it('computes a day per query while more than 24 hours behind')` (same rows as hour by hour);
  - `it('resumes after a restart without rewriting final hours')`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-syncer test -- agreement` fails: module not found.
- [ ] **Step 3: Implement `agreement.ts` and `AgreementJob`; add the job to the loop.**
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-syncer test` and `test:e2e -- validators` exit 0.
- [ ] **Step 5: Commit.** `git add apps/syncer docs/syncer.md` — `feat(syncer): hourly validator agreement against the indexed chain`.

---

### Task 13: The validator directory and `/v2/network/validators/summary`

**Files:**
- Create: `apps/api/src/validators/validators.module.ts`, `directory.ts` (types and the pure `assembleDirectory`) (+ `directory.spec.ts`), `agreement-windows.ts` (+ spec), `validator-directory.service.ts`, `summary-object.ts` (+ spec), `cache-control.ts`, `validators.controller.ts` (the summary route), `apps/api/test/validators.e2e-spec.ts`, `apps/api/test/support/validators-seed.ts`
- Modify: `apps/api/src/app.module.ts` (`ValidatorsModule` in `ENDPOINT_MODULES`, before `NotFoundModule`), `apps/api/src/app.module.spec.ts`, `docs/api-reference.md` (a "Validators and amendments" section: the formats, the Cache-Control table, where the data come from, and `GET /v2/network/validators/summary`)

**Interfaces:**
- Consumes: Tasks 1–3 (row types, `decodeServerVersion`, `compareVersions`, `quorumOf`, `listInUse`, `trustedUnl`, `recordOf`, `nextFlagLedger`, `testKey` for seeds); `CacheService`, `ClickHouseService`, `ApiConfig`, `NETWORK_PROFILE`; `fmtTime`, `fmtMillis`, `compact`.
- Produces (Tasks 14–16):
  ```ts
  interface AgreementWindow { missed: number; total: number; score?: string; incomplete: boolean; partial: number }
  interface DailyAgreement extends AgreementWindow { date: string }
  interface Drops { base_fee: string; reserve_base: string; reserve_inc: string }   // drops as text
  interface DomainState { status: 'verified' | 'unverified' | 'pending'; reason?: string; statusCode?: number; tomlUrl: string;
                          checked?: number; verified?: number /* unix s with ms fraction */; accounts?: string[] }
  interface DirectoryEntry {
    key: string; domain?: string; signingKey?: string;
    manifest?: { sequence: number; signingKey?: string; signingKeysSeen: number; domain?: string };
    domainState?: DomainState; currentIndex?: number; partial?: boolean;
    agreement1h: AgreementWindow; agreement24h: AgreementWindow; agreement30d: AgreementWindow; daily: DailyAgreement[];
    unl: boolean; unlLists: string[]; negativeUnl: boolean;
    version?: ServerVersion; serverVersion?: string; versionLatest?: boolean;
    record?: VoteRow; recordFees?: Drops; countedRecord?: VoteRow;
    firstSeen?: number; lastSeen?: number; seen24h: boolean; listed: boolean;
  }
  interface RoundInfo { ledgerIndex: number; closeTime: number; unlSize: number; trusted: number; threshold: number; observed: number;
                        unl: string[]; negativeUnl: string[]; fees: Drops }
  interface PublisherState { id: string; url: string; publicKey: string; status: 'ok' | 'expired' | 'unavailable';
                             list?: StoredUnlList; seen24h?: number; lastError?: string; lastErrorAt?: number }
  interface Directory {
    builtAt: number /* ms */; head?: { ledgerIndex: number; closeTime?: number; meanIntervalSeconds?: number };
    state?: { ledgerIndex: number; amendments: string[]; majorities: { amendment: string; since: number }[];
              negativeUnl: { key: string; firstLedger: number }[]; toDisable?: string; toReenable?: string; fees: Drops; nodeQuorum: number };
    publishers: PublisherState[]; threshold?: number /* absent without a publisher row */; trusted: ReadonlySet<string>;
    quorum: { value: number; unlSize: number; negativeOnUnl: number; node?: number };
    entries: ReadonlyMap<string, DirectoryEntry>;   // every master key of validator_seen ∪ the lists in use
    ordered: DirectoryEntry[];                      // the listed entries in list order
    signingToMaster: ReadonlyMap<string, string>; newestRound?: RoundInfo; newestFinalHour?: number; latest?: ServerVersion;
  }
  class ValidatorDirectoryService { get(): Promise<Directory> }   // CacheService, 10 s, one build in flight at a time
  interface HourSentinel { final: boolean; ledgers: number; unobserved: number }   // an hour with no sentinel is missing
  interface KeyHour { agreed: number; missed: number; partial: number }             // a tracked key's row of that hour
  function agreementWindow(sentinels: ReadonlyMap<number, HourSentinel>, rows: ReadonlyMap<number, KeyHour>,
                           from: number, toExclusive: number): AgreementWindow;     // hours are unix s
  function routeCacheControl(config: ApiConfig, value: string): string | undefined;   // undefined when GH_CACHE_CONTROL is ''
  const SUMMARY_KEYS = ['result', 'ledger_index', 'close_time', 'validators', 'unl', 'quorum', 'negative_unl', 'negative_unl_pending',
    'fees', 'next_flag_ledger', 'latest_version', 'versions', 'versions_unknown', 'agreement_through', 'votes_through_ledger', 'updated'];
  const PUBLISHER_KEYS = ['id', 'url', 'public_key', 'status', 'sequence', 'version', 'expiration', 'fetched', 'validators', 'seen_24h',
    'last_error', 'last_error_at'];
  // apps/api/test/support/validators-seed.ts: typed insert helpers per table and a `fleet(network, size)` builder of valid keys (testKey)
  ```

The directory (spec §3.0, §9), built from parallel reads, every aggregating read key-mapped and version sets filtered to the sentinel's version:
- manifests: per `ephemeral_key` `argMax(master_key, seq)` (the map); per master its newest row (`seq`, `ephemeral_key`, `domain`) and `uniqExact(ephemeral_key)` (`signingKeysSeen`); `domain` and `signingKey` of an entry come from it.
- `validator_seen`: `min(first_seen)`, `max(last_seen)` per key, merged into the master; `seen24h` = `last_seen` within 24 h; `listed` = on a list in use, or `last_seen` within 30 days.
- `validator_validations` with `ledger_index >= head − 300` (head = the larger of the newest committed ledger and the newest `network_state` ledger): `currentIndex` = the newest ledger, `partial` = no full validation there.
- `validator_agreement_hourly`, hours from the start of the UTC day 29 days before the newest final hour's day through that hour: the three windows and the 30 daily entries (spec §2.5 "Windows": 1 h = the newest final hour; 24 h = the 24 hours ending there; 30 d = the 720; `total` = Σ (agreed + missed), `missed`, `partial`, `score` = (total − missed) / total to 4 decimals half-up, absent at total 0; `incomplete` when an hour of the window is missing or not final, or Σ unobserved > 1 % of Σ (ledgers + unobserved); a day not complete in 24 final hours is incomplete).
- `validator_votes` + `amendment_tallies` sentinels: the newest round (`RoundInfo`); each key's `record` = `recordOf(rows, V, close(V))` (3.0: everybody) and, for the newest round's UNL members, `countedRecord` with the 24 h sentinels' membership; `recordFees` = the fees of the record's round's sentinel; `version` = the key's newest non-null `server_version` of the last 30 days, decoded with the profile's `software`; `latest` = the highest triple among release builds of trusted members' rows in the last 24 h; `versionLatest` = triple ≥ latest (false without one).
- `validator_domains` newest per (key, domain) for the entry's domain (none → `pending`; `tomlUrl` = `https://{domain}{tomlPath}`); `unl_lists` + `unl_publishers` (newest per publisher, `configured = 1`, ordered by id; `threshold` from them): `listInUse` per publisher (`ok`, `expired`, or `unavailable` without a list), `trusted` = `trustedUnl` at now, `unlLists` sorted ids naming the key; newest `network_state`; head ledger, close time and the mean interval of the last 1,000 committed ledgers.
- `quorum.value` = `quorumOf(|trusted|, |nUNL ∩ trusted|)`; `node` only when the node reported above 0.
- List order (`ordered`): with a domain first, by lower-case domain then key; then the rest by key.

The summary (spec §3.1), keys in `SUMMARY_KEYS` order: `ledger_index`, `close_time` (the newest committed ledger; else the newest `network_state` ledger without `close_time`); `validators {seen_24h, unl_seen_24h, others_seen_24h, all}` (`all` = |trusted ∪ seen in 24 h|); `unl {trusted, threshold, publishers[]}` (publisher keys in `PUBLISHER_KEYS` order: `sequence`, `version`, `expiration` (`fmtTime`), `fetched` (`fmtMillis`), `validators` of the list in use; `seen_24h`; `last_error`, `last_error_at` (`fmtMillis`) when the newest attempt failed); `quorum {value, unl_size, negative_unl, node?}`; `negative_unl [{validation_public_key, first_ledger}]`; `negative_unl_pending {to_disable?, to_reenable?}` only when either is set; `fees {base_fee, reserve_base, reserve_inc}` (whole units); `next_flag_ledger {ledger_index, voting_ledger, expected?}` (the multiple of 256 above `ledger_index`; `expected` = `close_time` + (flag − ledger) × the mean interval, `fmtTime`); `latest_version`; `versions [{version, unl, all}]` newest first (`unl` over trusted members, `all` over validators seen in 24 h); `versions_unknown {unl, all}`; `agreement_through` (end of the newest final hour, `fmtTime`); `votes_through_ledger` (newest round V); `updated` (`fmtMillis(builtAt)`). No parameters. Errors: 500 `unable to retrieve validator(s)`. `Cache-Control: private, max-age=30`.

- [ ] **Step 1: Write the failing tests.** Unit: `agreement-windows.spec.ts` — `score` `"0.9998"` for missed 4 / total 22,096 and `"1.0000"` for 0 / 921, half-up at the 5th decimal, absent at total 0; `it('flags a window incomplete above 1 % unobserved')` (1.0 % not, 1.1 % yes); a missing or non-final hour → incomplete; daily entries oldest first, a day of 23 final hours incomplete. `directory.spec.ts` (pure assembly from crafted reads) — `it('merges validator_seen rows of a signing key into its master')`; record vs counted record differ for a member on the negative UNL; `recordFees` fills absent fee fields; `latest` ignores rc and non-UNL builds. `summary-object.spec.ts` — keys in `SUMMARY_KEYS` order, `node` absent at 0, `negative_unl_pending` only when set, `next_flag_ledger` of 107748183 is 107748352 / 107748351. E2E (`validators.e2e-spec.ts`, both networks, seeds through `validators-seed.ts`): the summary of a 35-member fleet (quorum 28, publishers ok and expired, a failed attempt's `last_error`, versions, a negative UNL member with a pending re-enable); `it('answers with every publisher unavailable')` (200, `trusted 0`, `quorum.value 0`, `status 'unavailable'`); an empty database → 200 with exactly `result`, `validators` (all 0), `unl {trusted: 0, publishers: []}`, `quorum {value: 0, unl_size: 0, negative_unl: 0}`, `negative_unl: []`, `versions: []`, `versions_unknown {unl: 0, all: 0}`, `updated`; `Cache-Control: private, max-age=30`, and none with `GH_CACHE_CONTROL=''`; a ClickHouse failure → 500 `unable to retrieve validator(s)` with `no-store`; two requests within 10 s make one build; `read_rows` of the directory's `validator_validations`, `validator_agreement_hourly` and `validator_votes` reads over a bulk of four parts stays within the window's rows plus a granule per part (the R106 pattern of `test/support/read-rows.ts`); Xahau versions with `build`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- validators` fails: modules not found.
- [ ] **Step 3: Implement the module, the directory, the windows, the summary route and the reference section** (the reference's example is the e2e seed's real answer; its key lines read "Keys of the summary, in order: …" and "Keys of a publisher, in order: …").
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` and `pnpm --filter @gatehub/data-api-service test:e2e -- validators app` exit 0.
- [ ] **Step 5: Commit.** `git add apps/api docs/api-reference.md` — `feat(api): validator directory and /v2/network/validators/summary`.

---

### Task 14: `/v2/network/amendments` and `/v2/network/amendments/{name}`

**Files:**
- Create: `apps/api/src/validators/amendment-status.ts` (+ spec), `amendment-object.ts` (+ spec), `amendments.service.ts`, `amendments.controller.ts`, `apps/api/test/amendments.e2e-spec.ts`
- Modify: `apps/api/src/validators/validators.module.ts` (controller, service, `AMENDMENTS_CONFIG` = `loadAmendmentsConfig(profile, config.amendmentsConfig || undefined)`: an invalid file fails the boot), `docs/api-reference.md` (the two routes)

**Interfaces:**
- Consumes: Task 4 `loadAmendmentsConfig`, `AmendmentsConfig`, `amendmentId`; Task 2 `amendmentThreshold`, `amendmentNeeded`, `amendmentPasses`, `nextFlagLedger`, `parseVersionTriple`, `compareTriples`; Task 13 `ValidatorDirectoryService`, `Directory`, `routeCacheControl`.
- Produces (Task 15):
  ```ts
  const AMENDMENTS_CONFIG = Symbol('AMENDMENTS_CONFIG');   // API-side provider
  type AmendmentStatus = 'enabled' | 'majority' | 'voting' | 'obsolete' | 'unknown';
  interface AmendmentView { id: string; name?: string; status: AmendmentStatus; retired?: true; meta?: AmendmentMeta; nodeSupported?: boolean;
    votes?: { ledgerIndex: number; yes: number; trusted: number; needed: number; pct: number };
    majority?: { since: number; ledgerIndex?: number; txHash?: string; expectedActivation: number };
    enabled?: { ledgerIndex?: number; date: string; txHash?: string; source: 'ledger' | 'metadata' };
    history: { event: 'got_majority' | 'lost_majority' | 'enabled'; ledgerIndex: number; date: number; txHash: string }[] }
  interface AmendmentsAssembly { amendments: AmendmentView[] /* list order */; byId: ReadonlyMap<string, AmendmentView>;
    counts: Record<AmendmentStatus, number>; directory: Directory }
  class AmendmentsService { get(): Promise<AmendmentsAssembly>;                                       // cached 10 s
                            find(assembly: AmendmentsAssembly, ref: string): AmendmentView | undefined; // name exact, else unique case-insensitive; 64 hex any case
                            rounds(view: AmendmentView, directory: Directory): Promise<RoundPoint[]> } // per id, cached 10 s
  interface RoundPoint { ledgerIndex: number; flagLedger: number; date: number; yes: number; trusted: number; threshold: number; passes: boolean }
  const AMENDMENTS_BODY_KEYS = ['result', 'ledger_index', 'rules', 'round', 'next_flag_ledger', 'counts', 'count', 'amendments'];
  const ROUND_KEYS = ['ledger_index', 'date', 'unl_size', 'trusted', 'threshold', 'needed', 'observed'];
  const AMENDMENT_ROW_KEYS = ['id', 'name', 'status', 'retired', 'introduced', 'xls', 'xls_url', 'description', 'node_supported', 'votes', 'majority', 'enabled'];
  const AMENDMENT_VOTES_KEYS = ['ledger_index', 'yes', 'trusted', 'needed', 'pct'];
  const MAJORITY_KEYS = ['since', 'ledger_index', 'tx_hash', 'expected_activation'];
  const ENABLED_KEYS = ['ledger_index', 'date', 'tx_hash', 'source'];
  const AMENDMENT_DETAIL_KEYS = ['ledger_index', 'rules', 'round', 'next_flag_ledger', ...AMENDMENT_ROW_KEYS, 'unl_votes', 'other_votes', 'rounds', 'history', 'result'];
  const UNL_VOTE_KEYS = ['validation_public_key', 'domain', 'vote', 'version', 'version_supports', 'last_seen'];
  const ROUND_POINT_KEYS = ['ledger_index', 'flag_ledger', 'date', 'yes', 'trusted', 'threshold', 'passes'];
  const HISTORY_KEYS = ['event', 'ledger_index', 'date', 'tx_hash'];
  ```

Rules (spec §2.7, §3.5, §3.6, G2, G3, G5):
- Universe: the newest `network_state` `amendments` and `majorities`, the newest `amendment_features` IDs, the metadata IDs, and every ID in `validator_votes.amendments` of the last 30 days (version-filtered). `name`: the file's, else the node's non-empty one, else absent.
- Status, first match: `enabled` — in `amendments`, or `retired: true` in the file (then `retired: true`, and no `enabled` object unless the ledger has one); `majority` — in `majorities`; `obsolete` — `obsolete: true` in the file, or the node reports `supported: false` and no UNL validator votes yes in the newest round; `voting` — named by the node or the file, or voted for by any validator in the last 30 days; `unknown` — the rest (an ID with no name anywhere).
- `votes` (for `majority`, `voting`, `unknown`, when a round is stored): from the newest round: `yes` (its tally row, 0 without one), `trusted` (sentinel), `needed` = `amendmentNeeded(trusted)`, `pct` = yes / trusted × 100 to 2 decimals half-up (0 when trusted is 0).
- `majority`: `since` = the `Majorities` close time; `ledger_index`, `tx_hash` from the newest indexed `EnableAmendment` with `tfGotMajority` (`0x00010000`) of the ID, absent when none; `expected_activation` = since + `profile.majorityHoldSeconds`.
- `enabled`: an indexed `EnableAmendment` with flags 0 → `{ledger_index, date: fmtTime(close_time), tx_hash, source: 'ledger'}`; else the file's `enabled` → `{ledger_index?, date: 'YYYY-MM-DD', source: 'metadata'}`; else none.
- History: every indexed `EnableAmendment` of the ID (`tx_by_type` `tx_type = 'EnableAmendment'` → `transactions`, `tx_json.Amendment` and `.Flags`), `tfGotMajority` → `got_majority`, `tfLostMajority` (`0x00020000`) → `lost_majority`, flags 0 → `enabled`, oldest first; read in the 10 s assembly.
- List order: `majority` by `expected_activation`; `voting` by yes desc, then name (an unnamed one by its ID, after the named); `unknown` by ID; `enabled` by enabled ledger desc (no ledger last, then name); `obsolete` by name. Groups in that order.
- Envelope (A and AD): `ledger_index` (the summary's), `rules {threshold_percent: 80, majority_hold_seconds, flag_interval: 256}`, `round` (newest stored round, `ROUND_KEYS`, `date` = `fmtTime(close(V))`, `needed` = `amendmentNeeded(trusted)`), `next_flag_ledger` (as the summary's). `counts` covers all statuses whatever `status` filters; `count` = rows returned.
- A: `status` = comma list of the five words (empty = all), else 400 `invalid status`; `format=csv` → `amendments.csv`. Errors: 500 `unable to retrieve amendments`. `Cache-Control: private, max-age=60`.
- AD: `{name}` = a name (exact, else case-insensitive when unique) or a 64-hex ID (any case); else 404 `amendment not found`. JSON only. After the envelope and the row: `unl_votes` — every member of the newest round's sentinel `unl`, in the validators list order, `{validation_public_key, domain?, vote, version?, version_supports?, last_seen?}`, `vote` `yes`/`no` from its `countedRecord`, `none` without one; `version_supports` = the version's triple ≥ `parseVersionTriple(introduced)` when both are known; `other_votes` — validators not in that `unl`, seen in 24 h, with a `record`, same shape; `rounds` — one per stored round of the last 30 days, oldest first, `{ledger_index, flag_ledger: V + 1, date, yes (0 without a row), trusted, threshold, passes: amendmentPasses(yes, trusted)}`, for an `enabled` amendment only the rounds before its enabled ledger (none when that ledger is unknown); `history`; `result: 'success'`. Errors: 404 as above; 500 `unable to retrieve amendments`.

- [ ] **Step 1: Write the failing tests.** Unit (`amendment-status.spec.ts`): each status from crafted sources, first match wins (a named amendment in `majorities` is `majority`; `supported: false` with a UNL yes vote stays `voting`; retired Xahau names are `enabled` with `retired`); the list order; `pct` 88.57 for 31 / 35 and 11.43 for 4 / 35. `amendment-object.spec.ts`: keys in the constants' order, absent keys left out. E2E (`amendments.e2e-spec.ts`, both networks; `EnableAmendment` rows seeded into `tx_by_type` and `transactions`): every status present and the `counts`; a majority with an indexed `got_majority` has `ledger_index` and `tx_hash`, one without has neither (G5); `xls_url` served (G2); `enabled.source` `ledger` and `metadata`; `status=voting,majority` filters and `status=nope` → 400 `invalid status`; CSV `amendments.csv`; AD by exact name, by a unique case variant, by a lower-case ID; an unknown name → 404 `amendment not found`; `it('repeats the list envelope on the detail')` (`ledger_index`, `rules`, `round`, `next_flag_ledger` deep-equal A's, G3); `unl_votes` yes / no / none and `version_supports` false; `other_votes`; `rounds` length = stored rounds in the window, a round without a row has `yes 0`; `it('passes at trusted 1 with one yes')`; `history` oldest first; `rules.majority_hold_seconds` 1209600 on XRPL and 432000 on Xahau; `Cache-Control: private, max-age=60`; 500 `unable to retrieve amendments`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- amendment` fails: modules not found.
- [ ] **Step 3: Implement the status rules, the service, the objects, the controller and the reference subsections** (real answers of the e2e seed as examples; key lines "Keys of the amendments answer, in order: …", "Keys of an amendment row, in order: …", "Keys of the amendment answer, in order: …", "Keys of a UNL vote, in order: …", "Keys of a round, in order: …", "Keys of a history event, in order: …").
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` and `test:e2e -- amendments` exit 0.
- [ ] **Step 5: Commit.** `git add apps/api docs/api-reference.md` — `feat(api): /v2/network/amendments and /v2/network/amendments/{name}`.

---

### Task 15: `/v2/network/validators` and `/v2/network/validators/{key}`

**Files:**
- Create: `apps/api/src/validators/validator-key.ts` (+ spec), `validator-object.ts` (+ spec), `validators-query.ts` (+ spec)
- Modify: `apps/api/src/validators/validators.controller.ts` (the list and `:key`; `summary` stays declared before `:key`), `apps/api/test/validators.e2e-spec.ts`, `docs/api-reference.md` (the two routes and "Differences from data.ripple.com")

**Interfaces:**
- Consumes: Task 13 `ValidatorDirectoryService`, `Directory`, `DirectoryEntry`, `routeCacheControl`; Task 14 `AmendmentsService` (`get`, `find`); Task 3 `isNodePublicKey`, `nodePublicKeyFromHex`; `limitParam`, `first`, `decodeMarker`, `encodeMarker`, `setLinkHeader`, `Csv`.
- Produces (Task 16):
  ```ts
  function parseValidatorKey(raw: string): string;   // base58 master or signing key, or 66 hex (02/03/ED) -> base58; else badRequest('invalid validator public key')
  function resolveValidator(directory: Directory, key: string): DirectoryEntry;   // via signingToMaster; else notFound('Validator not found')
  const LIST_BODY_KEYS = ['result', 'count', 'marker', 'validators'];
  const VALIDATOR_ROW_KEYS = ['validation_public_key', 'domain', 'current_index', 'agreement_1h', 'agreement_24h', 'partial', 'unl', 'agreement_30d',
    'signing_key', 'domain_verification', 'unl_lists', 'negative_unl', 'version', 'version_build', 'version_latest', 'server_version', 'fee_vote',
    'amendment_votes', 'first_seen', 'last_seen'];
  const AGREEMENT_KEYS = ['missed', 'total', 'score', 'incomplete', 'partial'];
  const DOMAIN_VERIFICATION_KEYS = ['status', 'reason', 'status_code', 'toml_url', 'checked', 'verified', 'accounts'];
  const FEE_VOTE_KEYS = ['ledger_index', 'base_fee', 'reserve_base', 'reserve_inc'];
  const DETAIL_AMENDMENT_VOTES_KEYS = ['ledger_index', 'yes', 'votes'];
  const VOTE_ENTRY_KEYS = ['id', 'name', 'status', 'vote'];
  const DETAIL_TAIL_KEYS = ['manifest', 'daily_agreement', 'result'];
  const MANIFEST_KEYS = ['sequence', 'signing_key', 'signing_keys_seen', 'domain'];
  const DAILY_KEYS = ['date', 'missed', 'total', 'score', 'incomplete', 'partial'];
  ```

Row (spec §3.2): `validation_public_key`; `domain?`; `current_index?`; `agreement_1h`, `agreement_24h` (always, `AGREEMENT_KEYS`); `partial?` (kind of the newest validation); `unl` (boolean); `agreement_30d`; `signing_key?` (newest manifest's); `domain_verification?` (absent without a domain; `checked` absent while `pending`, `verified` = the last success, `reason` only for `unverified`, `status_code` only for `http_status`, `accounts` last, only with `verified` and non-empty); `unl_lists` (sorted ids); `negative_unl` (boolean, the current negative UNL); `version?`, `version_build?` (Xahau, after `version`), `version_latest?` (with `version`), `server_version?` (decimal text); `fee_vote?` (`{ledger_index: record's V, base_fee, reserve_base, reserve_inc}`, whole units, a field absent from the validation filled from `recordFees`); `amendment_votes?` (`{ledger_index, yes: [{id, name?}]}` in the record's order; absent without a record); `first_seen?`, `last_seen?` (`fmtMillis`).

List parameters, checked in this order: `scope` (`unl` default: the trusted UNL, seen or not; `all`: the trusted UNL plus every validator seen in 24 h; else 400 `invalid scope`); `publisher` (an id of the summary's publishers: only validators on its list in use; else 400 `invalid publisher`); `amendment` (a name `AmendmentsService.find` knows, or 64 hex: only validators whose `record` has it; else 400 `invalid amendment`); `q` (case-insensitive substring of `domain`, `validation_public_key` or `signing_key`; more than 100 characters → 400 `invalid search`); `marker` (`[group 0|1, sort text, master key]`, types `UInt16, String, String`; 400 `invalid marker`); `limit` (200, max 1000); `format=csv` → `validators.csv` (rows flattened). Order: `Directory.ordered` (group 0 with a domain by lower-case domain, then key; group 1 by key). `Link` header with the marker. Errors: 500 `unable to retrieve validator(s)`. `Cache-Control: private, max-age=30`.

Detail (spec §3.3, G4): `parseValidatorKey`, `resolveValidator` (any key of `entries`, so a validator seen more than 30 days ago answers). The row's keys with `amendment_votes` always present and gaining `votes`: one entry per amendment in status `voting`, `majority` or `unknown`, in the amendments list order, `{id, name?, status, vote}`, `vote` `yes`/`no` from the record or `none` without one (then `amendment_votes` has no `ledger_index` and `yes: []`); then `manifest?` (`MANIFEST_KEYS`), `daily_agreement` (30 entries, oldest first, `DAILY_KEYS`), `result: 'success'`. JSON only. `Cache-Control: private, max-age=30`.

- [ ] **Step 1: Write the failing tests.** Unit: `validator-key.spec.ts` — a master and a signing key accepted; 66 hex upper and lower with `02`, `03`, `ED` converted; `04…`, 64 and 68 hex, a classic address, `summary` → 400 `invalid validator public key`. `validators-query.spec.ts` — order domain-first case-insensitive then key; marker resumes after its row; `q` of 101 characters → 400. `validator-object.spec.ts` — keys in `VALIDATOR_ROW_KEYS` order; `fee_vote` filled from `recordFees` (`"0.000012"`, `"1"`, `"0.2"`); `accounts` only with `verified`. E2E (seeded fleet, both networks): `scope=unl` includes an offline UNL member; `scope=all` adds the seen-in-24-h others; `scope=x` → 400 `invalid scope`; `publisher` filter and 400 `invalid publisher`; `amendment` by name and by ID, 400 `invalid amendment`; `q` on a domain, a master key and a signing key; markers of `limit=1,2,3` concatenate to the unpaged list; `marker=%%%` → 400 `invalid marker`; CSV `validators.csv`; unknown parameters ignored; `Cache-Control: private, max-age=30`; detail by master, by signing key (answer names the master), by 66 hex; unknown key → 404 `Validator not found`; a validator seen 40 days ago → 200; `votes` holds an `unknown` amendment without `name` (G4); no record → `{yes: [], votes: [... 'none']}` without `ledger_index`; `manifest.signing_keys_seen`; 30 `daily_agreement` entries; `domain_verification.accounts` (G1); Xahau `version_build`; `/v2/network/validators/<key>/manifests`, `/<key>/reports`, `/v2/network/validator_reports`, `/v2/network/rippled_versions` → 404 `Cannot GET …`.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- validator` fails: modules not found.
- [ ] **Step 3: Implement key parsing, the query, the objects and the two routes; write the reference subsections** (real e2e answers; key lines "Keys of a validator row, in order: …", "Keys of an agreement window, in order: …", "Keys of domain_verification, in order: …", "Keys of fee_vote, in order: …", "Keys of amendment_votes on the validator answer, in order: …", "Keys of a vote entry, in order: …", "Keys of the validator answer after the row, in order: …", "Keys of manifest, in order: …", "Keys of a daily agreement, in order: …"; and the spec §3.7 table as "Differences from data.ripple.com").
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` and `test:e2e -- validators` exit 0.
- [ ] **Step 5: Commit.** `git add apps/api docs/api-reference.md` — `feat(api): /v2/network/validators and /v2/network/validators/{key}`.

---

### Task 16: `/v2/network/validators/{key}/validations`

**Files:**
- Create: `apps/api/src/validators/validator-validations.service.ts`, `validation-row-object.ts` (+ spec)
- Modify: `apps/api/src/validators/validators.controller.ts` (`:key/validations`), `apps/api/test/validators.e2e-spec.ts`, `apps/api/test/paged-reads.e2e-spec.ts` (the new page over a bulk; its plan), `docs/api-reference.md`

**Interfaces:**
- Consumes: Task 15 `parseValidatorKey`, `resolveValidator`; Task 13 `ValidatorDirectoryService`, `routeCacheControl`; shared `readGrowingCap`; `keysetClause`, `decodeMarker`, `paginate`, `setLinkHeader`, `Csv`, `fmtTime`, `fmtMillis`; `test/support/read-rows.ts`, `test/support/plans.ts`.
- Produces:
  ```ts
  const VALIDATIONS_BODY_KEYS = ['result', 'validation_public_key', 'count', 'marker', 'validations'];
  const VALIDATION_ROW_KEYS = ['ledger_index', 'ledger_hash', 'validated', 'validated_hash', 'full', 'signing_key', 'signing_time',
    'first_datetime', 'last_datetime', 'count'];
  class ValidatorValidationsService { page(master: string, o: { limit: number; marker?: string; descending: boolean }): Promise<{ rows: ValidationRow[]; marker?: string }> }
  ```

Rules (spec §3.4): the validations of the last 7 days of the resolved master key (the path key resolved like the detail; the read takes the master key's rows: rows the collector recorded under a signing key while its manifest was unknown are not listed here, while agreement and votes do count them). Parameters: `limit` 200 (max 1000); `marker` `[ledger_index, ledger_hash]` (`UInt32, String`; 400 `invalid marker`); `descending` true unless its text matches `/false/i`; `format=csv` → `<key> - validations.csv`. Row: `validated` = `matches` (the `ledgers` hash at that index), `different` (with `validated_hash`), or `unknown` (no `ledgers` row); `full` boolean; `signing_key` = the first sighting's `ephemeral_public_key`; `signing_time` = `fmtTime(signing_time + 946684800)`; `first_datetime`, `last_datetime` `fmtMillis`; `count` the sum. The page uses the R106 shape: an inner key-ordered capped read, the partial sightings added up outside it, grown with `readGrowingCap` when duplicates fill the room; then one `ledgers` lookup by the page's indices.

```sql
SELECT ledger_index, ledger_hash, sum(count) AS count,
       toUnixTimestamp64Milli(min(first_datetime)) AS first_ms, toUnixTimestamp64Milli(max(last_datetime)) AS last_ms,
       argMin(ephemeral_public_key, first_datetime) AS signing_key, argMin(signing_time, first_datetime) AS signing_time,
       max(full) AS full, sum(count()) OVER () AS rows_read
  FROM (SELECT ledger_index, ledger_hash, count, first_datetime, last_datetime, ephemeral_public_key, signing_time, full
          FROM validator_validations
         WHERE validation_public_key = {key:String} AND last_datetime >= {since:DateTime64(3)} [AND <keysetClause on ledger_index, ledger_hash>]
         ORDER BY validation_public_key DESC, ledger_index DESC, ledger_hash DESC      -- ASC when descending=false
         LIMIT {cap:UInt32})
 GROUP BY ledger_index, ledger_hash
 ORDER BY ledger_index DESC, ledger_hash DESC
 LIMIT {page:UInt32}                                                                   -- limit + 1
```

Errors: 400 `invalid validator public key`, 404 `Validator not found`, 400 `invalid marker`; 500 `unable to retrieve validator(s)`. `Cache-Control: private, max-age=5`; with a `marker`, `private, max-age=300`.

- [ ] **Step 1: Write the failing tests.** Unit (`validation-row-object.spec.ts`): keys in `VALIDATION_ROW_KEYS` order; `validated_hash` only with `different`; `signing_time` 814567890 → `'2025-10-23T20:51:30Z'`; `first_datetime` keeps its milliseconds. E2E: newest first; `descending=false` oldest first; markers of `limit=1` and `limit=2` concatenate to the unpaged list; `matches`, `different` (with `validated_hash`) and `unknown`; two partial sightings (merges stopped, two inserts) add up to `count 3`; a row older than 7 days left out; CSV `<key> - validations.csv`; `Cache-Control` 5 and, with a marker, 300; a signing key in the path answers the master's rows; errors as above. `paged-reads.e2e-spec.ts`: a 201-row page over the bulk of four parts reads about a granule per part (`readsOf` bound as for the other pages), and `expectBoundedInOrderRead` holds for its inner read.
- [ ] **Step 2: Run them to verify they fail.** `pnpm --filter @gatehub/data-api-service test -- validation-row` fails: module not found.
- [ ] **Step 3: Implement the service, the object and the route; write the reference subsection** (real e2e answer; "Keys of the validations answer, in order: …", "Keys of a validation, in order: …").
- [ ] **Step 4: Run the tests to verify they pass.** `pnpm --filter @gatehub/data-api-service test` and `test:e2e -- validators paged-reads` exit 0.
- [ ] **Step 5: Commit.** `git add apps/api docs/api-reference.md` — `feat(api): /v2/network/validators/{key}/validations`.

---

### Task 17: Reference check, ADRs, OpenAPI and the remaining docs

**Files:**
- Create: `apps/api/src/validators/api-reference.spec.ts`, `docs/adr/0012-validators-and-amendments-data.md`
- Modify: `docs/api-reference.md` (Compatibility: the new endpoints listed among those the original did not have (amendments) or serves differently (validators); the out-of-scope table keeps, of the validators routes, only `/v2/network/validators/{pubkey}/manifests`, `/{pubkey}/reports`, `/v2/network/validator_reports`, `/v2/network/rippled_versions`), `docs/adr/README.md`, `docs/adr/0010-ripple-v2-wire-compatibility.md` (an amendment: the spec §3.7 deviations), `docs/openapi.yaml` (regenerated, `docs/development.md` §8), `README.md` (layout line and endpoint table: the validators and amendments rows, five workers), `docs/README.md`, `docs/development.md` and `docs/architecture.md` (five workers), `docs/deployment.md` and `docs/operations.md` (the Rollout of spec: the deploy-order constraint, the order migrate → syncer → api, the filling table)

**Interfaces:**
- Consumes: every `*_KEYS` constant of Tasks 13–16.
- Produces (for E6): the built `docs/api-reference.md` "Validators and amendments" section that E6's fixture generator follows, at this task's commit; report that commit's hash in the hand-back for E6 to pin.

ADR-0012 (Context, Decision, Consequences, short): a worker of its own and why (spec §2 reasons 1–4); agreement over full validations against the indexed chain, unobserved ledgers left out; expired lists used and flagged, invalid ones never; outbound HTTPS through the safe fetcher (and `GH_DOMAIN_VERIFICATION=false`); quorum derived, not read; the Xahau UNL from the default publisher, not `UNLReport`; the hand-kept metadata files; 7-day recent validations; version sets; migration 002 and the deploy-order constraint with `feat/amm-data` (a database created before that merge is recreated, and D1's collected data cannot be recomputed).

- [ ] **Step 1: Write the failing test.** `api-reference.spec.ts` reads `docs/api-reference.md`, takes every line of the "Validators and amendments" section of the form ``Keys of <object>, in order: `a`, `b?`, …`` and asserts, for each `<object>` of a fixed map (`the summary` → `SUMMARY_KEYS`, `a publisher` → `PUBLISHER_KEYS`, `a validator row` → `VALIDATOR_ROW_KEYS`, … one entry per constant of Tasks 13–16), that the names with `?` stripped equal the constant, and that every constant of the map has its line.
- [ ] **Step 2: Run it to verify it fails or passes for the right reason.** `pnpm --filter @gatehub/data-api-service test -- api-reference`: a line that drifted from its constant, or a missing one, fails; fix the reference (never the constant) until it passes.
- [ ] **Step 3: Write ADR-0012 and the ADR-0010 amendment, update the docs, regenerate `docs/openapi.yaml`** (keeping its header comment) with the command of `docs/development.md` §8.
- [ ] **Step 4: Run the whole suite.** `pnpm build`, `pnpm test`, and the three `test:e2e` exit 0; `git diff --stat docs/openapi.yaml` shows the six new paths.
- [ ] **Step 5: Commit.** `git add apps/api/src/validators/api-reference.spec.ts docs README.md` — `docs: validators and amendments reference, ADR-0012 and the rollout`.
