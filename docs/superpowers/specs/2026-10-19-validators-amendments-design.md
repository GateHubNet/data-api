# Validators and amendments data (D1): design

Date: 2026-10-19. Status: proposed. Sub-project D1 of the public explorer (`GateHubNet/x-explorer`, foundation spec
`docs/superpowers/specs/2026-10-17-explorer-foundation-design.md` there). Builds on the Ripple v2 drop-in
(`2026-10-15-ripple-dropin-design.md`) and runs next to the AMM work on `feat/amm-data` (`2026-10-17-amm-data-design.md`), which it
does not touch. It is built before D2 (`2026-10-19-account-market-aggregates-design.md`).

## Context

The explorer's mock boards `Validators`, `Validator`, `Amendments` and `Amendment` (approved, in
`x-explorer/docs/superpowers/specs/2026-10-17-explorer-mock/`) show pages like xrpscan's: every validator with its domain, UNL
membership, software version, agreement, fee and amendment votes; one validator with its daily agreement and recent validations;
every amendment with its consensus and status; one amendment with every validator's vote, the yes share per flag ledger and its
majority history.

The data API collects part of this today. The `validations` worker writes every validation of `GH_VALIDATION_ENDPOINTS` into
`validations` (90-day TTL), with the amendment and fee votes, and the master-to-signing-key map into `validator_manifests`. It does not
keep the software version, the manifest's domain, the published UNL lists, domain verification, agreement, amendment state or
vote tallies, and no endpoint serves validators or amendments: `/v2/network/validators[/{pubkey}]` of `data.ripple.com` is listed as
out of scope in `docs/api-reference.md` and answers 404.

## Decisions (from the owner)

| Topic | Decision |
| --- | --- |
| Where | Extend `data-api-new`. The explorer reads it over HTTP like everything else. |
| Networks | Both, XRPL and Xahau, with the per-network rules below. |
| Pages | Like xrpscan's. The mock boards are approved. |
| Scope | Full: validators list, validator page, amendments list, amendment page, and the network overview tiles of the Validators board. |

## Owner decisions to confirm

The choices this spec makes that the owner should know, each with its reason. G1 to G5 name the gaps the explorer's validators pages
(E6) found in this spec; they are closed here.

- **Outbound HTTPS to validator domains.** The syncer fetches `/.well-known/xrp-ledger.toml` (`xahau.toml` on Xahau) from any public
  host that a verified manifest names, through the safe fetcher of 8.1. Domain verification needs it; an operator who restricts egress
  sets `GH_DOMAIN_VERIFICATION=false`, and domains then show `pending` (2.2, 8.3).
- **Agreement counts full validations only**, against the indexed validated chain. rippled counts only full validations toward
  validation and voting, and the Validator board says so; the validator history service counts partial ones too (2.5, 3.7).
- **Ledgers our collector did not see are left out for everybody**: fewer than quorum UNL validations recorded makes a ledger
  `unobserved`, so a collector outage never shows as validators missing ledgers (2.5).
- **Expired UNL lists are still used**, flagged `expired`, rather than showing an empty UNL; a list that fails verification is never
  used (2.1, 8.4).
- **The amendment metadata is a hand-kept file per network** (`config/amendments/<network>.json`: introduced, XLS, its URL,
  description, obsolete, retired). No node or ledger serves these facts; `amendments:check`, a gauge and a release checklist line keep it
  current (2.6).
- **Recent validations are kept 7 days** (`validator_validations`, near 1 GB on XRPL). That is enough for the "Recent validations"
  table; agreement and votes read the 90 days of `validations` (1.3, 1.5).
- **Deploy-order constraint.** D1 goes to a persistent environment only after the owner has merged `feat/amm-data`, or the owner
  accepts losing what D1 collected. That branch edits `001_baseline.sql` in place, the migration runner refuses a changed checksum, so a
  database created before the merge is recreated, and D1's validations, votes and first-seen history cannot be recomputed (Rollout).
- **G1: a verified domain's accounts.** From a TOML that verified, the `[[ACCOUNTS]].address` entries (valid classic addresses, at
  most 10) are read and served as `domain_verification.accounts`, for the page's account links. It is the only TOML field read besides
  `[[VALIDATORS]].public_key`; the addresses are what the domain claims, never fetched and not checked on the ledger (2.2, 8.2).
- **G2: `xls_url`** in the metadata file, accepted only under `https://github.com/XRPLF/XRPL-Standards/` and checked at boot, so the XLS
  tag can link to the standard (2.6).
- **G3 to G5.** The amendment detail repeats the list's envelope, so the amendment page needs one call fewer; a validator's `votes`
  include `unknown` amendments; `majority.ledger_index` and `tx_hash` are absent when the `EnableAmendment` is not indexed (2.7, 3.3,
  3.6).
- **A worker of its own (`validators`)**, not aggregator jobs: it needs the node and outbound HTTPS, has its own cadences and failure
  modes, keeps out of the aggregator that `feat/amm-data` changes, and `GH_WORKERS` switches it (section 2).
- **Quorum is derived** with rippled's formula from the trusted UNL and the negative UNL, not read from the node: public nodes report 0
  (3.1, F12).
- **The Xahau UNL is the default publisher's list** (`vl.xahau.org`), not the on-ledger `UNLReport`: it is what xahaud trusts out of the
  box (Non-goals).
- **A transient TOML failure keeps `verified` for 24 h**, so a website that blips does not flap the badge (2.2).
- **A validator that goes quiet collects misses for 24 h**, as the validator history service's do (2.5).
- **Deviations from `data.ripple.com`** (3.7): `scope=unl` by default lists offline UNL members (the original listed only validators
  seen in the last 60 s); domain-first order; paging; no `chain` key; `agreement_30d` and `partial` added. The original's `/manifests`,
  `/reports`, `/validator_reports` and `/rippled_versions` stay 404.
- **"First seen" means first seen by this deployment**; there is no agreement or vote history from before the collector ran (1.5).
- **Migration `002_validators_amendments.sql` and ADR-0012**; if `main` gets a migration or an ADR first, D1 and D2 take the next free
  numbers, D1 before D2 (1.4).

## Goals

- Every field the four boards show is served by an endpoint of section 3, with its source written down (section 4).
- The facts are the network's: votes counted the way rippled and xahaud count them, the quorum and thresholds of their source,
  UNL lists verified like a node verifies them.
- A validators list response, all of it, in under 200 ms on a cache miss; no request reads more than a few hundred thousand narrow rows.
- Outbound HTTP to third-party domains is safe (section 8.1).
- One additive migration that cannot collide with `feat/amm-data` (that branch's in-place change of the baseline still constrains the
  deploy order: Rollout).

## Non-goals

- A network crawler or topology (`/v2/network/topology*`), peer counts, node locations.
- The original's `/v2/network/validators/{pubkey}/manifests`, `/{pubkey}/reports`, `/v2/network/validator_reports` and
  `/v2/network/rippled_versions`: they stay 404. The versions summary of 3.1 covers what the boards need.
- Fields of `xrp-ledger.toml` / `xahau.toml` other than `[[VALIDATORS]].public_key` and, from a TOML that verified,
  `[[ACCOUNTS]].address` (countries, ASN, `attestation`, account descriptions).
- Xahau's on-ledger `UNLReport` objects as a UNL source (the default publisher's list is what xahaud trusts out of the box).
- Node-local state: `vetoed`, an operator's `[amendments]` / `[veto_amendments]`.
- Agreement or votes before the collector ran: they cannot be recomputed from ledgers.
- Predicting the outcome of fee voting.

## Facts this design relies on (checked 2026-10-19)

| # | Fact | Source |
| --- | --- | --- |
| F1 | A validator adds `sfServerVersion`, its fee votes and `sfAmendments` only to its validation of the **voting ledger**, `isVotingLedger()`: the ledger before a flag ledger, index % 256 = 255. xahaud adds the version only under `HardenedValidations` (enabled on both networks). | rippled `src/xrpld/app/consensus/RCLConsensus.cpp` `Adaptor::validate`; xahaud same file |
| F2 | The `validations` stream carries it as `server_version`, the UInt64 as decimal text, next to `master_key` (when the signing key is not the master key), `amendments`, `base_fee`, `reserve_base`, `reserve_inc` (drops; the `XRPFees` fields are mapped onto these names), `cookie`, `validated_hash`, `full`, `flags`, `signing_time`, `ledger_index`. | `NetworkOPsImp::pubValidation`, rippled develop and xahaud dev |
| F3 | rippled's encoding: bits 48–63 `0x183B`, 40–47 major, 32–39 minor, 24–31 patch, 16–23 release state (`0xC0` release, `0x80 \| n` rc n, `0x40 \| n` beta n). | rippled `src/libxrpl/protocol/BuildInfo.cpp` `encodeSoftwareVersion` |
| F4 | xahaud: the same layout, but major is year − 2023, minor the month, patch the day, and bits 0–15 the build number after `+`. `2026.10.13-release+4119` (the build of `wss://xahau.network`) has release byte 0, because `release` is a pre-release identifier that is neither `rc` nor `b`. | xahaud `src/libxrpl/protocol/BuildInfo.cpp`; `server_info` |
| F5 | A fee field is in a voting validation only when the validator's target differs from the value in force; absent means "keep it". | `FeeVoteImpl::doValidation`, both |
| F6 | When building the ledger after flag ledger F (index % 256 = 0), a node tallies the trusted, **full** validations of F − 1, negative-UNL members removed. The `EnableAmendment` and `SetFee` pseudo-transactions are in ledger F + 1. | `RCLConsensus::Adaptor::onClose`; `Validations.h` `getTrustedForLedger` (`trusted && full`); the Amendments object's `PreviousTxnLgrSeq` is 107540993 on XRPL and 26534401 on Xahau, both 256k + 1 |
| F7 | Each trusted validator's last vote is remembered for 24 h (`TrustedVotes`). `trusted` = UNL validators with a vote record; `threshold` = max(1, ⌊trusted × 80 / 100⌋); an amendment passes when yes > threshold (≥ when trusted = 1). | `AmendmentTable.cpp` `TrustedVotes`, `AmendmentSet`, both; `fixAmendmentMajorityCalc` is enabled on both networks |
| F8 | Majority must hold **14 days on XRPL, 5 days on Xahau**; 80/100 on both. | `SystemParameters.h`: rippled `kDefaultAmendmentMajorityTime = Weeks{2}`, xahaud `defaultAmendmentMajorityTime = days{5}` |
| F9 | An amendment's ID is SHA-512Half of its name. | `Feature.cpp` `registerFeature`; true for all 115 (XRPL) and 114 (Xahau) entries of `feature` |
| F10 | Public `feature` gives `{name, enabled, supported}` per ID and no vote counts; Xahau adds `majority` (close time). s1.ripple.com (rippled 3.4.1 behind Clio 2.8.0) does not know the name of the amendment that has majority on XRPL now (`98433DD0…CA76`): a node can lack names. | `feature` on `https://s1.ripple.com:51234/` and `https://xahau.network/` |
| F11 | Amendments object (index `7DB0788C020F02780A673DC74757F23823FA3014C1866E72CC4CD8B226CD6EF4`): `Amendments` (enabled IDs), `Majorities` `[{Majority: {Amendment, CloseTime}}]`. NegativeUNL (`2E8A59AA9D3B5B186B0B9E0F62E6C02587CA74A4D778938E957B6357D364B244`): `DisabledValidators` `[{DisabledValidator: {FirstLedgerSequence, PublicKey (hex)}}]`, `ValidatorToDisable`, `ValidatorToReEnable`; no object means none (XRPL answers `entryNotFound` today, Xahau has one disabled validator). FeeSettings (`4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651`): `BaseFeeDrops`, `ReserveBaseDrops`, `ReserveIncrementDrops`. | `ledger_entries.macro`, `Indexes.cpp`; `ledger_entry` on both networks |
| F12 | Quorum = max(⌈0.8 × (UNL − negative-UNL members on it)⌉, ⌈0.6 × UNL⌉). `server_info.validation_quorum` is 28 on s1/s2.ripple.com and **0** on xrplcluster.com and xahau.network. | `ValidatorList::calculateQuorum`; `server_info` |
| F13 | Default publishers. rippled: `https://vl.ripple.com` key `ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734`, `https://unl.xrplf.org` key `ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1`, threshold 0 = 1 below three publishers (so a validator on either list is trusted). xahaud: `https://vl.xahau.org` key `EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8`. | `cfg/validators-example.txt` of both |
| F14 | List format. v1: `{public_key, manifest, blob, signature, version: 1}`. v2: `{public_key, manifest, blobs_v2: [{blob, signature, manifest?}] (at most 5), version: 2}`. A blob is base64 JSON `{sequence, expiration, effective?, validators: [{validation_public_key (hex), manifest (base64)}]}`, times in Ripple-epoch seconds, signed by the signing key of the publisher's manifest. Refresh 5 min, overridden by `refresh_interval` (minutes, clamped 1 min–24 h); at most 3 redirects; retry 30 s after an error. Served today, all v1: vl.ripple.com sequence 85, 35 validators, expires 2027-04-06; unl.xrplf.org 2026070302, 35, 2027-07-03; vl.xahau.org 2026092401, 19, 2027-09-25. | rippled `ValidatorList.cpp` `parseBlobs`, `verify`; xahaud `ValidatorSite.cpp`; the three URLs |
| F15 | A manifest is an STObject `{PublicKey, MasterSignature, Sequence, Domain?, SigningPubKey, Signature}`, both signatures over `HashPrefix::Manifest` (`MAN\0`); sequence `0xFFFFFFFF` revokes. A domain must pass `isProperlyFormedTomlDomain` (4–128 characters, labels of `[A-Za-z0-9-]`, alphabetic TLD). `manifestReceived` gives `domain` and the manifest in hex; the `manifest` RPC gives `details.domain` and the manifest in base64. | `src/libxrpl/server/Manifest.cpp`, `StringUtilities.cpp`, `NetworkOPsImp::pubManifest`, the `manifest` handler |
| F16 | Domain verification is two-way: the manifest names the domain, and `https://{domain}/.well-known/xrp-ledger.toml` (XRPL) or `/.well-known/xahau.toml` (Xahau) lists the master key, base58, as `public_key` of a `[[VALIDATORS]]` entry. | xrpl.org `docs/references/xrp-ledger-toml`; `xahau.network/docs/infrastructure/identity` |
| F17 | Ripple's validator history service: per hour, `validated` = ledgers of the network's chain the validator signed, `missed` = the rest, `incomplete` while the chain is new; 24 h and 30 d add the hours; any validation, partial ones too, counts. `data.ripple.com` served `agreement_1h` / `agreement_24h` as `{missed, total, score (4 decimals), incomplete}` and listed only validators seen in the last 60 s. | `ripple/validator-history-service` `src/connection-manager/agreement.ts`, `chains.ts`, `src/shared/database/agreement.ts`; `rippled-historical-database` `lib/hbase/hbase-thrift/topology.js` `getValidators` |

Ledger numbers used throughout: **voting ledger** V = 256k − 1, **flag ledger** F = 256k, **applied in** A = 256k + 1. The boards' "flag
ledger" is F; the votes are those of V.

## 1. What is collected

### 1.1 Today

| Table | Has | Lacks |
| --- | --- | --- |
| `validations` | per (ledger hash, master key): times of receipt, `full`, `flags`, `signing_time`, `amendments` (JSON text), `base_fee`, `reserve_base`, `reserve_inc`, `load_fee` | the software version |
| `validator_manifests` | `ephemeral_key`, `master_key`, `seq` (highest wins) | the domain, the raw manifest |

The amendment and fee votes the boards need are already in `validations`. What is missing is the version, the manifest's domain and
raw bytes, a per-validator index of validations, a first-seen time that outlives the 90-day TTL, and everything that does not come
from the validations stream (UNL lists, domains, ledger state, names).

### 1.2 Collector changes (`apps/syncer/src/validations/validations-collector.ts`)

- **`server_version`**: read from the message (F2) with the existing `uint64()` helper and written to the new column
  `validations.server_version`. The other stream fields (`cookie`, `validated_hash`, `data`) stay unused.
- **Manifests**: `handleManifest` and the `manifest` RPC lookup also keep `domain` and the raw manifest, normalised to upper-case hex
  (the stream gives hex, the RPC base64), in the new columns `validator_manifests.domain` and `.manifest`, and `source` (`stream` or
  `rpc`). The highest-`seq` rule is unchanged.
- **Two more tables per flush**, derived from the rows of that flush:
  - `validator_validations`: the same row per (ledger, validator), keyed by validator, narrow (1.3);
  - `validator_seen`: one row per master key in the flush: `min(first_datetime)`, `max(last_datetime)`, `max(ledger_index)`.
- **Flush order**: manifests, `validations`, `validator_validations`, `validator_seen`. Each table has its own pending rows: a failed
  insert keeps that table's rows for the next flush (merged by key, bounded by `MAX_BUFFERED_ROWS` each) and does not re-send the tables
  that succeeded. The inserts into `validator_validations` and `validator_seen` carry `insert_deduplication_token`
  `vc:<bootId>:<table>:<flushSeq>` and both tables have `non_replicated_deduplication_window = 100`, so a retried insert is dropped.
  Errors are counted as `syncer_validations_errors_total{stage="flush_by_validator"|"flush_seen"}`.
- Nothing else changes: the master-key resolution, the 20 s flush, the shutdown budget.

### 1.3 Tables

All in the new migration `packages/shared/schema/002_validators_amendments.sql` (1.4). Times are `DateTime('UTC')` for ledger and wall
times, `DateTime64(3, 'UTC')` for times of receipt; keys are base58 node public keys (`nH…` master, `n9…` signing) unless said
otherwise; amendment IDs upper-case hex.

**Written by the collector**

| Table | Engine, key, partition, TTL | Columns |
| --- | --- | --- |
| `validations` (changed) | unchanged | + `server_version SimpleAggregateFunction(any, Nullable(UInt64))` |
| `validator_manifests` (changed) | unchanged (`ReplacingMergeTree(seq)`, `ORDER BY ephemeral_key`) | + `domain String DEFAULT ''`, `manifest String DEFAULT ''` (hex), `source LowCardinality(String) DEFAULT 'stream'` (`stream`, `rpc`, `unl`) |
| `validator_validations` | `AggregatingMergeTree`, `ORDER BY (validation_public_key, ledger_index, ledger_hash)`, `PARTITION BY intDiv(ledger_index, 100000)`, `TTL toDateTime(last_datetime) + INTERVAL 7 DAY`, `ttl_only_drop_parts = 1`, `non_replicated_deduplication_window = 100` | `validation_public_key LowCardinality(String)`, `ledger_index UInt32`, `ledger_hash String`, `count SimpleAggregateFunction(sum, UInt64)`, `first_datetime SimpleAggregateFunction(min, DateTime64(3, 'UTC'))`, `last_datetime SimpleAggregateFunction(max, DateTime64(3, 'UTC'))`, `ephemeral_public_key SimpleAggregateFunction(any, String)`, `signing_time SimpleAggregateFunction(any, UInt32)`, `full SimpleAggregateFunction(max, UInt8)`, `server_version SimpleAggregateFunction(any, Nullable(UInt64))` |
| `validator_seen` | `AggregatingMergeTree`, `ORDER BY validation_public_key`, no TTL, `non_replicated_deduplication_window = 100` | `validation_public_key String`, `first_seen SimpleAggregateFunction(min, DateTime64(3, 'UTC'))`, `last_seen SimpleAggregateFunction(max, DateTime64(3, 'UTC'))`, `last_ledger_index SimpleAggregateFunction(max, UInt32)` |

`validator_validations` serves the "Recent validations" table and the newest activity of each validator; 7 days are enough for that and
keep it near 1 GB on XRPL (about 4 M rows a day). Agreement and votes read `validations` (2.4, 2.5), which already holds 90 days.

**Written by the `validators` worker (section 2)**

| Table | Engine, key, TTL | Columns |
| --- | --- | --- |
| `unl_lists` | `ReplacingMergeTree(fetched_at)`, `ORDER BY (publisher, sequence)` | `publisher LowCardinality(String)` (id, e.g. `vl.ripple.com`), `publisher_key String` (hex), `sequence UInt64`, `version UInt8` (1 or 2), `effective Nullable(DateTime('UTC'))`, `expiration DateTime('UTC')`, `validators Array(String)` (master keys, base58, sorted), `blob_sha256 String`, `fetched_at DateTime64(3, 'UTC')`, `response String CODEC(ZSTD(3))` (the JSON as served) |
| `unl_publishers` | `ReplacingMergeTree(checked_at)`, `ORDER BY publisher` | `publisher`, `url String`, `publisher_key String`, `configured UInt8`, `threshold UInt8` (the trusted-set threshold in force), `checked_at DateTime64(3, 'UTC')`, `status LowCardinality(String)` (`ok`, `error`), `error LowCardinality(String)` (reason code, `''` when ok), `last_ok_at Nullable(DateTime64(3, 'UTC'))` |
| `validator_domains` | `ReplacingMergeTree(checked_at)`, `ORDER BY (validation_public_key, domain)` | `validation_public_key String`, `domain String`, `status LowCardinality(String)` (`verified`, `unverified`), `reason LowCardinality(String)`, `status_code UInt16` (HTTP status when `reason = 'http_status'`, else 0), `toml_url String`, `checked_at DateTime64(3, 'UTC')`, `verified_at Nullable(DateTime64(3, 'UTC'))` (last success), `next_check_at DateTime('UTC')`, `accounts Array(String)` (the `[[ACCOUNTS]]` addresses of the last TOML that verified, sorted, at most 10; empty when `unverified`) |
| `network_state` | `ReplacingMergeTree(polled_at)`, `ORDER BY ledger_index`, `TTL toDateTime(polled_at) + INTERVAL 100 DAY` | `ledger_index UInt32`, `ledger_hash String`, `polled_at DateTime64(3, 'UTC')`, `amendments Array(String)`, `majorities Array(Tuple(amendment String, since DateTime('UTC')))`, `negative_unl Array(Tuple(validation_public_key String, first_ledger UInt32))`, `to_disable String`, `to_reenable String` (base58, `''` when none), `base_fee UInt64`, `reserve_base UInt64`, `reserve_inc UInt64` (drops), `node_quorum UInt32` (0 = the node reports none) |
| `amendment_features` | `ReplacingMergeTree(polled_at)`, `ORDER BY amendment_id` | `amendment_id String`, `name String`, `supported UInt8`, `polled_at DateTime64(3, 'UTC')` |
| `validator_votes` | `ReplacingMergeTree(version)`, `ORDER BY (ledger_index, validation_public_key)`, no TTL | `ledger_index UInt32` (V), `validation_public_key String`, `ledger_hash String` (validated hash of V), `close_time DateTime('UTC')` (of V), `full UInt8`, `amendments Array(LowCardinality(String))`, `base_fee Nullable(UInt64)`, `reserve_base Nullable(UInt64)`, `reserve_inc Nullable(UInt64)` (drops, NULL when absent from the validation), `server_version Nullable(UInt64)`, `version UInt64` |
| `amendment_tallies` | `ReplacingMergeTree(version)`, `ORDER BY (amendment_id, ledger_index)`, no TTL | `ledger_index UInt32` (V), `amendment_id String` (`''` = the round's sentinel), `close_time DateTime('UTC')`, `yes UInt16`, `trusted UInt16`, `threshold UInt16`, `unl_size UInt16`, `observed UInt16`; filled on the sentinel only: `unl Array(String)`, `negative_unl Array(String)`, `base_fee`, `reserve_base`, `reserve_inc UInt64` (drops in force); `version UInt64` |
| `validator_agreement_hourly` | `ReplacingMergeTree(version)`, `ORDER BY (hour, validation_public_key)`, `TTL hour + INTERVAL 400 DAY` | `hour DateTime('UTC')`, `validation_public_key String` (`''` = the hour's sentinel), `agreed UInt32`, `missed UInt32`, `partial UInt32`, `last_seen DateTime64(3, 'UTC')`, sentinel only: `ledgers UInt32`, `unobserved UInt32`, `gaps UInt32`, `unl_size UInt16`, `quorum UInt16`, `final UInt8`; `version UInt64` |

`validator_votes`, `amendment_tallies` and `validator_agreement_hourly` are **version sets**, the pattern of `volume_daily` and
`amm_daily`: a round (or hour) is written whole under one `version` (wall-clock milliseconds), sentinel last; a reader takes the
sentinel's version and keeps only the rows of that version. A rewrite after a crash is a newer set; no reader mixes two.

All names join the `Table` enum and the row types join `rows.ts`; none is a ledger table (none is in `CHILD_TABLES` or
`LEDGER_KEYED_TABLES`), so ingest recovery never deletes them.

### 1.4 Migration

- **File**: `packages/shared/schema/002_validators_amendments.sql`. It is the documented way to change the schema
  (`docs/data-model.md` §5: "add `002_*.sql`").
- **Contents**: two `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements (`validations`, `validator_manifests`) and ten
  `CREATE TABLE IF NOT EXISTS`. Every statement can run again, so a file that failed halfway is re-run safely. Every statement ends with
  its semicolon on its last line and no other line ends with one (the runner's splitter).
- **No file collision with `feat/amm-data`.** That branch changes `001_baseline.sql` in place and adds no file; it does not touch
  `validations` or `validator_manifests`. 002 depends only on those two tables of 001, so either merge order works for the files: a
  database recreated from the AMM baseline applies 002 after it, and a database that already applied today's 001 applies 002 on its
  own. The database is another matter: once the AMM baseline is merged, the migration runner refuses a database that applied today's
  001 (an applied file whose checksum changed, `packages/shared/src/clickhouse/migrate.ts`), so such a database is recreated, and D1's
  collected data with it. Hence the deploy-order constraint of the Rollout.
- **Numbers.** D1 is built first and takes `002`; D2 takes `003_account_market_aggregates.sql`. Should another branch land a migration
  on `main` first, D1 and D2 take the next free numbers, D1 before D2, before they are merged (neither is applied anywhere yet, so a
  rename is safe).
- The design record is `docs/adr/0012-validators-and-amendments-data.md` (0011 is the AMM ADR of `feat/amm-data`, 0013 D2's; the same
  rule applies: if `main` gets another ADR first, the next free numbers, D1 before D2).

### 1.5 Retention and backfill

| Data | Kept | Filled at first start from |
| --- | --- | --- |
| `validations` | 90 days (unchanged) | — |
| `validations.server_version` | with the row | nothing: versions appear from the first voting ledger after the new collector starts (at most ~17 min) |
| `validator_validations` | 7 days | nothing: the recent-validations table starts at the deploy |
| `validator_seen` | for ever | seeded once by the worker when the table is empty: `INSERT INTO validator_seen SELECT validation_public_key, min(first_datetime), max(last_datetime), max(ledger_index) FROM validations GROUP BY validation_public_key` (min and max are idempotent, so a re-run is harmless) |
| `validator_votes`, `amendment_tallies` | for ever | the rounds of the retained `validations` for which `ledgers` has V (2.4) |
| `validator_agreement_hourly` | 400 days | the hours of the retained `validations` for which `ledgers` covers the hour (2.5) |
| `unl_lists`, `unl_publishers`, `validator_domains`, `amendment_features` | for ever (small) | the first fetch, poll or check |
| `network_state` | 100 days | the first poll |

History before the collector ran has no agreement and no votes; "first seen" means first seen by this deployment.

## 2. Background jobs: the `validators` worker

A fifth syncer worker, `validators` (`GH_WORKERS`; the default list becomes `ingest,validations,fee_stats,aggregator,validators`), in
`apps/syncer/src/validators/`. It has two loops of its own:

- an **I/O loop** that fetches UNL lists (2.1), checks domains (2.2) and polls the node (2.3), each on its own timer;
- a **compute loop**, once a minute, that runs two ClickHouse jobs with the aggregator's job model (per-job budget, jobs that fail are
  logged and counted and retried at the next tick, no overlap, shutdown aborts the slice in flight and waits at most 2 s): `rounds`
  (2.4, budget 5 s) and `agreement` (2.5, budget 10 s), in that order, inside a 20 s tick.

**Why a worker and not aggregator steps.**

1. It needs the node and outbound HTTPS to third-party sites. The aggregator needs neither and boots while every node is down.
2. Its cadences (flag rounds, hours, re-check intervals) and failure modes (a publisher or a domain is down) are its own.
3. The aggregator's 30 s tick is shared by the volume, stats and (on `feat/amm-data`) AMM jobs. These jobs must neither compete for that
   budget nor change its job order, and keeping out of `aggregator.service.ts` keeps the two branches apart.
4. An operator can switch the whole feature on or off with `GH_WORKERS`.

The compute jobs still follow the aggregator's rules: their tables are recomputable from stored data (within retention), written as
version sets, and a unit is final only once the ingest has passed it.

The worker uses the shared `NodeClient` (`GH_NODE_ENDPOINTS`), so it is made whenever this worker is enabled; ClickHouse through
`ClickHouseService`; outbound HTTP only through the safe fetcher of 8.1.

**Key mapping.** Every job and every API read maps a key through the manifest map first (an `ephemeral_key` of
`validator_manifests` becomes its `master_key`; in SQL `transform(k, {ephemerals:Array(String)}, {masters:Array(String)}, k)`), so a
validation recorded under a signing key before its manifest was known is counted for the right validator.

### 2.1 UNL lists

- **Publishers**: `GH_UNL_PUBLISHERS`, `url=publicKeyHex` pairs (defaults per network in section 5, F13). A publisher's id is its URL
  without the scheme and trailing slash (`vl.ripple.com`). `GH_UNL_THRESHOLD` (0 = rippled's rule: 1 below three publishers, else
  ⌊n / 2⌋ + 1) sets how many current lists must name a validator for it to be **trusted**.
- **Fetch**: at start, then every `GH_UNL_REFRESH_MS` (5 min) or the response's `refresh_interval` minutes clamped to 1 min–24 h, as
  rippled does. After a failure: 30 s, doubling to 10 min. Through the safe fetcher (8.1): HTTPS only, 20 s timeout, at most 1 MiB, at
  most 3 redirects. One fetch per publisher at a time.
- **Verification**, in the order rippled's `ValidatorList::verify` uses (F14, F15); each failure is a reason code:
  1. The body is JSON with `public_key`, `manifest` and `version` 1 (`blob`, `signature`, no `blobs_v2`) or 2 (`blobs_v2` of 1 to 5
     entries, no `blob`/`signature`; any other version is read as 2, like rippled). Else `invalid_format`.
  2. `public_key` (case-insensitive) equals the configured key. Else `untrusted_key`.
  3. The publisher manifest decodes (`ripple-binary-codec`), its `PublicKey` is that key, its master signature and signing signature
     verify over `MAN\0` + the manifest without its two signature fields (`ripple-keypairs`). Else `manifest_invalid`; sequence
     `0xFFFFFFFF` is `revoked`. A v2 entry's own `manifest`, when present, replaces the publisher manifest for that blob if its
     sequence is higher.
  4. Each blob's `signature` (hex) verifies over the base64-decoded blob with the manifest's signing key. Else `signature_invalid`.
  5. The blob is JSON with integer `sequence`, `expiration`, optional `effective`, and a `validators` array whose entries have a
     33-byte hex `validation_public_key`. `expiration > effective`. Else `blob_invalid`.
  6. Sequence lower than the newest stored for the publisher: `stale`; equal: unchanged, nothing written; `expiration` ≤ now: `expired`.
- **Writes**: each new verified blob is one `unl_lists` row (keys converted to base58 with `ripple-address-codec` `encodeNodePublic`).
  Every validator manifest inside a blob is decoded and verified like the publisher's and written to `validator_manifests` with
  `source = 'unl'` (an invalid one is skipped and counted). Every attempt writes the publisher's `unl_publishers` row (`ok` or `error`
  with the reason; `last_ok_at` kept). At start the worker writes a row for every configured publisher and sets `configured = 0` for
  stored publishers no longer configured.
- **Current list of a publisher at time t**: the row with the highest `sequence` whose `effective` (none = always) ≤ t and
  `expiration` > t. When none is current, the newest row is used and reported as `expired` (8.4: better a flagged old UNL than none).
- **Trusted UNL at t**: validators on at least `threshold` of the current lists of the configured publishers. For a time before the
  first stored fetch, the oldest stored list stands in.

### 2.2 Domain verification

- **Which domains**: for every validator that is on a stored list or in `validator_seen` with `last_seen` in the last 30 days, the
  domain of its newest manifest (highest `seq` per master key) whose raw bytes the worker has verified itself (F15). The stream's
  manifests are not trusted for this on the node's word: a manifest that does not verify gives `manifest_unverified`. A validator whose
  newest stored manifest has no raw bytes (rows from before 002) is asked of the node (`manifest` with the master key) at most once
  per 10 minutes, and the answer is stored with `source = 'rpc'`.
- **Domain syntax** first: rippled's `isProperlyFormedTomlDomain` (F15). This rejects IP literals, ports, paths and single labels
  before any DNS query. Else `domain_invalid`.
- **Fetch** `https://{domain}/.well-known/xrp-ledger.toml` (XRPL) or `https://{domain}/.well-known/xahau.toml` (Xahau, F16; no
  fall-back to the other name). Through the safe fetcher: 10 s overall timeout (`GH_DOMAIN_FETCH_TIMEOUT_MS`), at most 256 KiB, at most
  3 redirects, each to `https://` on port 443 and checked like the first URL. At most 4 checks in flight, one per domain at a time, at
  most 100 per pass, a pass every 60 s.
- **Match**: parse TOML (`smol-toml`, pinned); find a `[[VALIDATORS]]` entry whose `public_key`, trimmed, equals the master key.
- **Accounts** (G1), only when the match succeeded, so only from a TOML that verified: the `address` of each `[[ACCOUNTS]]` entry,
  trimmed, kept when it is a classic address with a valid checksum (`isValidClassicAddress` of `ripple-address-codec`), without
  duplicates, sorted, the first 10; any other entry (an X-address, a bad checksum, a missing or non-string `address`) is skipped. They
  are stored in `validator_domains.accounts` and served as `domain_verification.accounts` (3.2). They are what the verified domain
  claims: nothing checks them on the ledger, and nothing fetches them. Every other field of the file (and of the entries: `network`,
  `desc`) is ignored.
- **Results and reasons** (`validator_domains`):

  | Result | Reason | Next check |
  | --- | --- | --- |
  | `verified` | `''` | `GH_DOMAIN_RECHECK_MS` (6 h) |
  | `unverified` | `not_listed` (TOML read, no entry with the key), `toml_invalid`, `too_large`, `redirect_rejected`, `blocked_address`, `domain_invalid`, `manifest_unverified`, `http_status` with 4xx except 429 | 6 h |
  | `unverified` | transient: `dns_error`, `connect_error`, `tls_error`, `timeout`, `http_status` 5xx or 429 | 1 h |

  A transient failure within 24 h of the last success keeps `verified` (with `verified_at` and `accounts` unchanged). A website that
  blips does not flap the badge. After 24 h of failures it is `unverified` with the transient reason, and without accounts.
- **Due**: no row for (key, domain), `next_check_at` ≤ now, or the validator's domain changed (a new pair). A new domain is checked within
  the next pass.

### 2.3 Network state and amendment names

- Every **60 s**: `ledger_entry` of the Amendments object with `ledger_index: "validated"`. Its `ledger_index` L is then used for
  `ledger_entry` of NegativeUNL and FeeSettings (one consistent ledger; `entryNotFound` = empty), and `server_info`
  (`validation_quorum`). One `network_state` row. RPC timeout 5 s, no retries; the next poll is the retry. NegativeUNL keys are hex in the
  ledger and are stored base58.
- Every **10 min**, and at start: `feature`. One `amendment_features` row per entry.
- Each request is counted (`syncer_validators_node_polls_total{request, outcome}`).

### 2.4 Voting rounds and tallies (`rounds` job)

A round is a voting ledger V. It is **ready** when `ledgers` holds V and now ≥ close(V) + 120 s (validations flushed, late
sightings in). Rounds are processed oldest first. The first is the first V at or after the lowest `ledger_index` of the oldest
`validations` partition that `ledgers` also covers; then the newest stored round + 256. A V that `ledgers` lacks (a gap of the
ingest) gets a sentinel with `observed = 0` and no vote rows.

For round V:

1. H = `ledgers.ledger_hash` of V.
2. **Votes**: `SELECT validation_public_key, argMin(full, first_datetime), argMin(amendments, first_datetime), argMin(base_fee, first_datetime), argMin(reserve_base, first_datetime), argMin(reserve_inc, first_datetime), argMin(server_version, first_datetime) FROM validations WHERE ledger_hash = {H} GROUP BY ledger_hash, validation_public_key`
   (a primary-key lookup; the earliest sighting's values, as `ValidationsService` reads them); keys mapped to master keys. One
   `validator_votes` row each. Validations of another hash at V are ignored, as rippled ignores them (F6).
3. **UNL(V)** = the trusted UNL at close(V) (2.1); **nUNL(V)** = `negative_unl` of the newest `network_state` row with
   `ledger_index` ≤ V (none: empty).
4. **Record** of each u in UNL(V) (F7): u's newest `validator_votes` row with `full = 1` and `close_time` ≥ close(V) − 24 h, from a
   round V′ ≤ V at which u was in UNL(V′) and not in nUNL(V′) (read from the sentinels of the last 24 h). A record with no
   amendments is a record that votes for none.
5. `trusted` = UNL members with a record; `yes(a)` = records containing a; `threshold` = max(1, ⌊trusted × 80 / 100⌋);
   `observed` = UNL members with a full validation of H in this round; `unl_size` = |UNL(V)|.
6. **Fees in force at V**: the newest `SetFee` pseudo-transaction with `ledger_index` ≤ V in `transactions` (through `tx_by_type`),
   its `BaseFeeDrops`/`ReserveBaseDrops`/`ReserveIncrementDrops` or the legacy `BaseFee`/`ReserveBase`/`ReserveIncrement`. Without one in
   the index, the newest `network_state` row.
7. Write the `amendment_tallies` set: one row per amendment with yes > 0 or listed in `Majorities` of the newest `network_state` row,
   then the sentinel (with `unl`, `negative_unl`, the fees).

Per round this is three small reads and two inserts. A backfill of 90 days (about 7,600 XRPL rounds) runs in the 5 s budget a minute
(section Rollout).

### 2.5 Agreement (`agreement` job)

**What counts.** Our reference is the ingest's validated chain (`ledgers`), which the ingest only accepts `validated` and
hash-chained. That is stricter than the validator history service's chain heuristic (F17). Only **full** validations agree, as rippled
counts only full validations toward validation and voting (F6, `numTrustedForLedger` / `getTrustedForLedger`), and as the Validator
board says ("Partial validations do not count toward agreement"). The validator history service counts partial ones; we do not.

Per UTC hour h:

- **L(h)**: the ledgers of `ledgers` with `close_time` in [h, h + 1 h); `gaps` = (last − first + 1) − |L(h)|.
- **UNL(h)**, **nUNL(h)** as in 2.4 at h + 1 h; **quorum(h)** = max(⌈0.8 × (|UNL| − |nUNL ∩ UNL|)⌉, ⌈0.6 × |UNL|⌉) (F12).
- **Observed ledger**: L ∈ L(h) whose hash has full validations recorded from at least quorum(h) UNL members. A validated ledger had
  that many on the network, so fewer recorded means our recording is incomplete: a collector reconnect, a gap. The ledger is left out
  for everybody and counted in `unobserved`. A collector outage never shows as validators missing ledgers.
- **Tracked validators**: UNL(h) ∪ those seen in h (any validation received in h) ∪ those of hour h − 1 whose `last_seen` is
  within 24 h of h + 1 h. A validator that goes quiet keeps collecting misses for a day, as the validator history service's do
  (its chain keeps the keys it saw).
- **Per tracked validator k**: `agreed` = observed ledgers for whose hash k has a full validation; `partial` = observed ledgers for
  which k has only a partial validation of that hash; `missed` = observed − agreed (partial ones included); `last_seen` = the newest
  receipt time known (this hour or the previous row).
- **Sentinel**: `ledgers` (observed), `unobserved`, `gaps`, `unl_size`, `quorum`, `final`.

**The read** for one hour (the validations of a ledger are partitioned by the day they were received in, so the window bounds the
partitions):

```sql
WITH v AS (
  SELECT ledger_hash, transform(validation_public_key, {eph:Array(String)}, {mas:Array(String)}, validation_public_key) AS k,
         max(full) AS f, max(last_datetime) AS seen
    FROM validations
   WHERE last_datetime >= {from:DateTime64(3)} AND last_datetime < {to:DateTime64(3)}     -- [h - 10 min, h + 2 h)
     AND ledger_hash IN {hashes:Array(String)}                                         -- the hashes of L(h)
   GROUP BY ledger_hash, k),
obs AS (
  SELECT ledger_hash FROM v WHERE f = 1 AND has({unl:Array(String)}, k)
   GROUP BY ledger_hash HAVING count() >= {quorum:UInt16})
SELECT k, countIf(f = 1) AS agreed, countIf(f = 0) AS partial_only
  FROM v WHERE ledger_hash IN (SELECT ledger_hash FROM obs)
 GROUP BY k
```

plus "seen in h": `max(last_datetime)` per key of the rows received in [h, h + 1 h), from the same partitions.

**Final hours.** An hour is ready when it ended at least 10 minutes ago and the newest committed ledger closed at or after its end.
It is written once, `final = 1`, when `gaps` = 0. An hour with gaps is written with `final = 0` and recomputed at most once an hour
while `validations` still holds it (a range ingest may fill the gap). Hours are computed oldest first: the tracked set carries from
the hour before. The start is the first hour after the oldest `validations` partition that `ledgers` covers. While more than 24 hours
behind, the job computes a whole UTC day per query (the same read grouped by hour, one partition scan per day); after that one hour
per query.

**Windows** (API): 1 h = the newest final hour; 24 h = the 24 final hours ending there; 30 d = 720. For validator k: `total` =
Σ (agreed + missed) of its rows, `missed` = Σ missed, `partial` = Σ partial, `score` = (total − missed) / total to 4 decimals
(half-up), absent when total = 0. `incomplete` is true when the window has an hour that is missing or not final, or when the
unobserved ledgers of its hours exceed 1 % of their validated ledgers (a few unobserved ledgers after a collector reconnect do not
flag a month).

### 2.6 Amendment metadata

- **Where**: `packages/shared/config/amendments/xrpl.json` and `xahau.json`, next to the markets config; `GH_AMENDMENTS_CONFIG`
  overrides the path (API and syncer). Loaded and validated at boot; an invalid file fails the boot naming the entry, like the markets
  config.
- **Shape**:

  ```json
  {
    "network": "xrpl",
    "updated": "2026-10-19",
    "amendments": [
      { "name": "AMM", "introduced": "1.12.0", "xls": "XLS-30",
        "xls_url": "https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0030-automated-market-maker",
        "description": "Automated market makers: pools that trade two assets against each other.",
        "enabled": { "ledger_index": 86836481, "date": "2024-03-22" } },
      { "name": "CryptoConditionsSuite", "introduced": "0.60.0", "obsolete": true }
    ]
  }
  ```

  `name` required, unique; the ID is computed (F9), never written. `introduced`: rippled semver (`1.12.0`) on XRPL, xahaud date
  version (`2024.4.21`) on Xahau. `xls`: `XLS-<n>`, optional (Xahau entries normally have none). `xls_url` (G2): optional, the
  address of the standard (its folder has a slug the number does not give); checked at boot with the URL parser: scheme `https:`, host
  `github.com`, no port, user or password, path under `/XRPLF/XRPL-Standards/`, else the file is invalid. `description`: one line, at
  most 200 characters. `enabled`: `ledger_index` and/or `date` (`YYYY-MM-DD`), only for amendments enabled before the indexed history (an
  indexed `EnableAmendment` wins over it). `obsolete: true`: the amendment can no longer be voted in by current software (XRPL: the
  `VoteBehavior::Obsolete` and withdrawn ones such as `CryptoConditionsSuite`, `NonFungibleTokensV1`, `fixNFTokenDirV1`,
  `fixNFTokenNegOffer`; Xahau: XRPL-era names on xahaud's feature list that Xahau never uses). `retired: true` (Xahau only): behaviour
  always on although the ledger does not list it: the names in xahaud's `XRPL_RETIRE` that are not in the Amendments object, on
  2026-10-19 `MultiSign`, `TrustSetAuth`, `FeeEscalation`, `PayChan`, `CryptoConditions`, `TickSize`, `fix1368`, `Escrow`, `fix1373`,
  `EnforceInvariants`, `SortedDirectories`, `fix1201`, `fix1512`, `fix1523`, `fix1528`. Unknown keys are refused.
- **Initial content**: written by the plan from xrpl.org's known-amendments page and rippled release notes (XRPL), and xahaud's
  `features.macro` and release notes (Xahau).
- **Kept current**:
  1. `pnpm --filter @gatehub/data-api-shared amendments:check --network xrpl|xahau` (a script next to `record-fixtures.ts`) calls
     `feature` and `ledger_entry` on a public node. It prints the names the node knows that the file lacks, the IDs in the ledger
     (enabled or majority) or in current votes with no name in the file or the node, and entries whose `enabled` contradicts an indexed
     `EnableAmendment`. It exits 1 if it found any.
  2. The worker's gauge `syncer_amendments_without_metadata` and one warning per new ID.
  3. A release checklist line in `docs/operations.md`: a rippled or xahaud release with new amendments gets its entries before the
     deploy.
- **Missing from the file**: the amendment is still served with its status and votes. `name` comes from the node and is absent when
  the node does not know it either (F10); `introduced`, `xls`, `xls_url` and `description` are absent.

### 2.7 Amendment status

Sources: the newest `network_state` row (enabled, majorities), `amendment_features`, the metadata file, the votes of the last 30
days. First match wins:

| Status | When |
| --- | --- |
| `enabled` | in `Amendments`; or `retired: true` in the file (then `retired: true` in the answer and no `enabled` object unless the ledger has one) |
| `majority` | in `Majorities` |
| `obsolete` | `obsolete: true` in the file; or the node reports `supported: false` and no UNL validator votes for it in the newest round |
| `voting` | known by name (node or file), or voted for by any validator in the last 30 days |
| `unknown` | none of these but seen in a vote or the ledger: an ID with no name anywhere |

**Majority details**: `since` = the `Majorities` close time. `ledger_index` and `tx_hash` come from the newest indexed `EnableAmendment`
with `tfGotMajority` (`0x00010000`) for the ID, and are absent when there is none (G5: the majority was gained before the indexed
history, or the ingest has not reached that ledger yet). `expected_activation` = since + the hold (F8, the network profile's
`majorityHoldSeconds`: 1,209,600 XRPL, 432,000 Xahau). The amendment is enabled at the first flag ledger after it, in F + 1.

**History**: every indexed `EnableAmendment` of the ID (`tx_by_type` prefix `EnableAmendment`, then `transactions`, `tx_json` fields
`Amendment` and `Flags`): `tfGotMajority` → `got_majority`, `tfLostMajority` (`0x00020000`) → `lost_majority`, flags 0 → `enabled`.
There are a few hundred such transactions on XRPL in all, read once and cached (3.0).

## 3. Endpoints

### 3.0 Common

- New API module `apps/api/src/validators/`: `validators.controller.ts` (`@RippleController('v2/network/validators')`: `summary` is
  registered before `:key`), `amendments.controller.ts` (`@RippleController('v2/network/amendments')`), and the services of 3.1–3.6.
  Ripple contract layer throughout: `RippleErrorFilter`, `@RippleRoute`, API key, rate limit, `limitParam`, base64url markers with the
  `Link` header, CSV with flattening, unknown parameters ignored.
- **The directory.** `ValidatorDirectoryService` builds the table of every validator in one go, from the parallel reads of section 9,
  and keeps it in `CacheService` for 10 s. Its entries are: on a stored list, or in `validator_seen` with `last_seen` in the last
  30 days. List, summary, detail and the amendment page read it, so one request costs at most one build per replica per 10 s.
  `AmendmentsService` caches its assembly (3.5) for 10 s too.
- Formats: keys absent when they have no value, never `null`. Instants of receipt (`first_seen`, `last_seen`, `first_datetime`,
  `last_datetime`, `fetched`) use the validations format `YYYY-MM-DDTHH:mm:ss.SSSZ`. Ledger and wall times use `YYYY-MM-DDTHH:mm:ssZ`;
  days `YYYY-MM-DD`. Native amounts are whole units as exact decimal text (`"0.00001"`, `"1"`, `"0.2"`). Counts are numbers;
  `pct` is a number to 2 decimals; agreement `score` is text to 4 decimals (the original's form, F17). Key order is the order written
  below, pinned by tests.
- **Cache-Control** (the live-route rule of R108: `private`, a TTL of the route; none when `GH_CACHE_CONTROL` is empty; errors
  `no-store`):

  | Route | `Cache-Control` |
  | --- | --- |
  | `/v2/network/validators`, `/summary`, `/{key}` | `private, max-age=30` |
  | `/v2/network/validators/{key}/validations` | `private, max-age=5`; with a `marker`: `private, max-age=300` |
  | `/v2/network/amendments`, `/{name}` | `private, max-age=60` |

- **Per network**: the paths are the same on both hosts. Network profile values: XRPL — software `rippled`, TOML `xrp-ledger.toml`,
  publishers vl.ripple.com and unl.xrplf.org (threshold 1), hold 14 days, version scheme rippled. Xahau — `xahaud`, `xahau.toml`,
  vl.xahau.org, 5 days, xahaud scheme. Both: 80 %, 256.
- **Versions** (F3, F4): `server_version` whose top 16 bits are not `0x183B` has no `version`. XRPL:
  `major.minor.patch`, plus `-rcN` / `-bN` from the release byte. Xahau: `(major + 2023).minor.patch`, the same suffixes, and
  `version_build` = bits 0–15 when non-zero. **Latest** = the highest (major, minor, patch) among the release builds reported by
  trusted-UNL validators in the last 24 h (XRPL release byte `0xC0`; Xahau any byte without the rc/b bits). A validator's
  `version_latest` is true when its triple is ≥ latest.
- **Votes and fees of a validator**: its **record**, the newest `validator_votes` row with `full = 1` within 24 h before the newest
  stored round (F7 applied to everybody, trusted or not). `fee_vote` fills a field the validation left out with the fee in force at
  that round (F5).

### 3.1 `GET /v2/network/validators/summary`

The network overview of the Validators board. No parameters. 500 `unable to retrieve validator(s)`.

```json
{
  "result": "success",
  "ledger_index": 107748183,
  "close_time": "2026-10-19T15:42:51Z",
  "validators": { "seen_24h": 142, "unl_seen_24h": 35, "others_seen_24h": 107, "all": 142 },
  "unl": {
    "trusted": 35,
    "threshold": 1,
    "publishers": [
      { "id": "vl.ripple.com", "url": "https://vl.ripple.com",
        "public_key": "ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734",
        "status": "ok", "sequence": 85, "version": 1, "expiration": "2027-04-06T17:51:34Z",
        "fetched": "2026-10-19T15:40:02.114Z", "validators": 35, "seen_24h": 35 },
      { "id": "unl.xrplf.org", "url": "https://unl.xrplf.org",
        "public_key": "ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1",
        "status": "ok", "sequence": 2026070302, "version": 1, "expiration": "2027-07-03T00:00:00Z",
        "fetched": "2026-10-19T15:40:02.380Z", "validators": 35, "seen_24h": 35 }
    ]
  },
  "quorum": { "value": 28, "unl_size": 35, "negative_unl": 0, "node": 28 },
  "negative_unl": [],
  "fees": { "base_fee": "0.00001", "reserve_base": "1", "reserve_inc": "0.2" },
  "next_flag_ledger": { "ledger_index": 107748352, "voting_ledger": 107748351, "expected": "2026-10-19T15:53:52Z" },
  "latest_version": "3.4.1",
  "versions": [ { "version": "3.4.1", "unl": 30, "all": 88 }, { "version": "3.4.0", "unl": 4, "all": 27 } ],
  "versions_unknown": { "unl": 1, "all": 27 },
  "agreement_through": "2026-10-19T15:00:00Z",
  "votes_through_ledger": 107748095,
  "updated": "2026-10-19T15:42:53.002Z"
}
```

- `ledger_index`, `close_time`: the newest committed ledger (when the ingest has none, the newest `network_state` ledger, without
  `close_time`).
- `validators.all` = |trusted UNL ∪ seen in 24 h|. Seen = `validator_seen.last_seen` in the last 24 h.
- `unl.publishers[]`: `status` `ok` (a current list), `expired` (only an expired list, still used, 2.1), `unavailable` (never
  fetched), plus `last_error` and `last_error_at` when the newest attempt failed.
- **Quorum is derived** with rippled's formula over the trusted UNL and the current negative UNL (F12). `node` is the node's
  `validation_quorum` when it reports one above 0: public nodes report 0 (xrplcluster.com, xahau.network), so it cannot be the
  source.
- `negative_unl[]`: `{validation_public_key, first_ledger}`; `negative_unl_pending` `{to_disable?, to_reenable?}` is added when
  either is set.
- `next_flag_ledger`: the multiple of 256 above `ledger_index`. `expected` = `close_time` + (flag − ledger) × the mean interval of the
  last 1,000 committed ledgers.
- `versions`: the versions of trusted-UNL members (`unl`) and of validators seen in 24 h (`all`), newest first; validators with no
  known version are in `versions_unknown`.
- `agreement_through`: end of the newest final hour. `votes_through_ledger`: the newest stored round. `updated`: when the directory
  was built.

### 3.2 `GET /v2/network/validators`

| Parameter | Default | Meaning |
| --- | --- | --- |
| `scope` | `unl` | `unl`: the trusted UNL (listed now, seen or not). `all`: the trusted UNL plus every validator seen in the last 24 h. Else 400 `invalid scope`. |
| `publisher` | | A publisher id of the summary: only validators on its current list. Else 400 `invalid publisher`. |
| `amendment` | | A name or 64-hex ID: only validators whose record votes yes for it. Not a known name and not 64 hex: 400 `invalid amendment`. |
| `q` | | Case-insensitive substring of `domain`, `validation_public_key` or `signing_key`; at most 100 characters, else 400 `invalid search`. |
| `limit` | 200 (max 1000) | |
| `marker` | | From the previous page. 400 `invalid marker`. |
| `format` | json | `csv`: file `validators.csv`. |

**Order**: validators with a domain first, by domain (lower-case), then master key; then those without, by master key. Marker =
`[group (0/1), sort text, master key]`. The list is small: the explorer may ask for `limit=1000` once and page in the browser.

```json
{
  "result": "success",
  "count": 1,
  "marker": "WzAsIm5vcnRocGVhay5leGFtcGxlIiwibkhVLi4uIl0",
  "validators": [
    {
      "validation_public_key": "nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6",
      "domain": "northpeak.example",
      "current_index": 107748183,
      "agreement_1h": { "missed": 0, "total": 921, "score": "1.0000", "incomplete": false, "partial": 0 },
      "agreement_24h": { "missed": 4, "total": 22096, "score": "0.9998", "incomplete": false, "partial": 1 },
      "partial": false,
      "unl": true,
      "agreement_30d": { "missed": 152, "total": 662880, "score": "0.9998", "incomplete": false, "partial": 9 },
      "signing_key": "n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy",
      "domain_verification": { "status": "verified", "toml_url": "https://northpeak.example/.well-known/xrp-ledger.toml",
                               "checked": "2026-10-19T12:00:04.511Z", "verified": "2026-10-19T12:00:04.511Z",
                               "accounts": ["rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"] },
      "unl_lists": ["unl.xrplf.org", "vl.ripple.com"],
      "negative_unl": false,
      "version": "3.4.1",
      "version_latest": true,
      "server_version": "1745992596280311808",
      "fee_vote": { "ledger_index": 107748095, "base_fee": "0.000012", "reserve_base": "1", "reserve_inc": "0.2" },
      "amendment_votes": { "ledger_index": 107748095,
                           "yes": [ { "id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76" } ] },
      "first_seen": "2026-07-21T08:00:12.004Z",
      "last_seen": "2026-10-19T15:42:51.204Z"
    }
  ]
}
```

- The first seven keys are the original's row (`validation_public_key`, `domain`, `current_index`, `agreement_1h`, `agreement_24h`,
  `partial`, `unl`; see 3.7). `current_index` and `partial` are the ledger and the kind of the newest validation (from the last 300
  ledgers of `validator_validations`), absent when there is none.
- `domain_verification` is absent when the manifest has no domain. `status` is `verified`, `unverified` (with `reason`, and
  `status_code` for `http_status`) or `pending` (not checked yet). `verified` is the last success. `accounts` (G1) comes last, only
  with `verified`: the `[[ACCOUNTS]]` addresses of the TOML that verified (2.2), absent when it lists none. Keys in order: `status,
  reason?, status_code?, toml_url, checked?, verified?, accounts?` (`checked` absent while `pending`).
- `unl_lists` holds the ids of the publishers whose current list names the validator, sorted; `negative_unl` is true while it is on
  the current negative UNL.
- `version_build` follows `version` on Xahau. `fee_vote` and `amendment_votes` are absent without a record (3.0); a yes entry has
  `name` when one is known.
- Errors: 400 as above; 500 `unable to retrieve validator(s)`.

### 3.3 `GET /v2/network/validators/{key}`

`key`: a master or a signing key, base58 (`n…`), or 66 hex (as lists and the negative UNL write them). A signing key resolves through
the manifest map. Not one of these forms: 400 `invalid validator public key`; not in the directory nor in `validator_seen`:
404 `Validator not found`. JSON only. The answer is the flat object, as the original's was:

- the list row's keys (3.2), with two differences: `amendment_votes` is always present, and it gains `votes`, one entry per amendment
  in status `voting`, `majority` or `unknown` (G4: unknown amendments are voted on too), `{id, name?, status, vote}` with `vote` `yes`,
  `no` or `none` (no record; then `amendment_votes` has no `ledger_index` and an empty `yes`); an `unknown` entry has no `name`;
- then `manifest`: `{sequence, signing_key, signing_keys_seen, domain?}`, absent without a manifest. `signing_keys_seen` = distinct
  `ephemeral_key`s stored for the master key (the board's "signing key rotated" is that minus 1);
- then `daily_agreement`: the 30 UTC days ending with the day of the newest final hour, oldest first,
  `{date, missed, total, score?, incomplete, partial}`; a day not complete in hours is `incomplete`;
- then `result: "success"`.

`amendment_votes` in its place among the row's keys, and the keys after the row's:

```json
{
  "amendment_votes": {
    "ledger_index": 107748095,
    "yes": [ { "id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76" } ],
    "votes": [
      { "id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76", "status": "majority", "vote": "yes" },
      { "id": "C98D98EE9616ACD36E81FDEB8D41D349BF5F1B41DD64A0ABC1FE9AA5EA267E9C", "name": "XChainBridge", "status": "voting",
        "vote": "no" } ] },
  "manifest": { "sequence": 4, "signing_key": "n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy", "signing_keys_seen": 4,
                "domain": "northpeak.example" },
  "daily_agreement": [ { "date": "2026-09-20", "missed": 2, "total": 22101, "score": "0.9999", "incomplete": false, "partial": 0 } ],
  "result": "success"
}
```

Errors: as above; 500 `unable to retrieve validator(s)`.

### 3.4 `GET /v2/network/validators/{key}/validations`

The validator's validations of the last 7 days (`validator_validations`), newest first.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `limit` | 200 (max 1000) | |
| `marker` | | `[ledger_index, ledger_hash]` of the last row. 400 `invalid marker`. |
| `descending` | true | `false` lists oldest first. |
| `format` | json | `csv`: file `<key> - validations.csv`. |

```json
{ "result": "success", "validation_public_key": "nHUkp7WhouVMobBUKGrV5FNqjsdD9zKP5jpGnnLLnYxUQSGAwrZ6", "count": 2,
  "marker": "WzEwNzc0ODE4MCwiNzdDMC4uLiJd",
  "validations": [
    { "ledger_index": 107748183, "ledger_hash": "A1B2…", "validated": "matches", "full": true,
      "signing_key": "n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy", "signing_time": "2026-10-19T15:42:51Z",
      "first_datetime": "2026-10-19T15:42:51.204Z", "last_datetime": "2026-10-19T15:42:51.390Z", "count": 3 },
    { "ledger_index": 107748180, "ledger_hash": "77C0…", "validated": "different", "validated_hash": "0F9E…", "full": true,
      "signing_key": "n9MzwWa4dwdZkRzj6XmihBG4ymGtMPd12cLjfhKwx5Hoqeu6WEgy", "signing_time": "2026-10-19T15:42:39Z",
      "first_datetime": "2026-10-19T15:42:39.801Z", "last_datetime": "2026-10-19T15:42:39.801Z", "count": 1 } ] }
```

Row keys, in order: `ledger_index, ledger_hash, validated, validated_hash?, full, signing_key, signing_time, first_datetime,
last_datetime, count` (hashes shortened in the example).

`validated`: `matches` (the hash of `ledgers` at that index), `different` (with `validated_hash`), `unknown` (no `ledgers` row: not
indexed yet, or outside the indexed history). `signing_time` converts the validator's Ripple-epoch seconds. The page is read with the
R106 shape (an inner `ORDER BY … LIMIT page + room` on the key, partial sightings added up outside it), then one `ledgers` lookup by
the page's indices. Errors: those of 3.3, 400 `invalid marker`; 500 `unable to retrieve validator(s)`.

### 3.5 `GET /v2/network/amendments`

Every amendment the network knows (enabled, majority, voting, obsolete, unknown); about 120 on XRPL, so no paging.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `status` | all | Comma list of `enabled`, `majority`, `voting`, `obsolete`, `unknown`. Else 400 `invalid status`. |
| `format` | json | `csv`: file `amendments.csv`. |

```json
{
  "result": "success",
  "ledger_index": 107748183,
  "rules": { "threshold_percent": 80, "majority_hold_seconds": 1209600, "flag_interval": 256 },
  "round": { "ledger_index": 107748095, "date": "2026-10-19T15:36:31Z", "unl_size": 35, "trusted": 35,
             "threshold": 28, "needed": 29, "observed": 35 },
  "next_flag_ledger": { "ledger_index": 107748352, "voting_ledger": 107748351, "expected": "2026-10-19T15:53:52Z" },
  "counts": { "enabled": 97, "majority": 1, "voting": 7, "obsolete": 11, "unknown": 0 },
  "count": 116,
  "amendments": [
    { "id": "98433DD001A5737F773D74F8CA2A25A065089C73B2E611C760BAF369E4FECA76", "status": "majority",
      "votes": { "ledger_index": 107748095, "yes": 31, "trusted": 35, "needed": 29, "pct": 88.57 },
      "majority": { "since": "2026-10-09T09:34:30Z", "ledger_index": 107540993,
                    "tx_hash": "1717BD8BE3FED93C142C8CD38DA5AD1208A0E9AE4E24F0F7ED545FC750BCA20A",
                    "expected_activation": "2026-10-23T09:34:30Z" } },
    { "id": "C98D98EE9616ACD36E81FDEB8D41D349BF5F1B41DD64A0ABC1FE9AA5EA267E9C", "name": "XChainBridge", "status": "voting",
      "introduced": "2.0.0", "xls": "XLS-38", "node_supported": true,
      "votes": { "ledger_index": 107748095, "yes": 4, "trusted": 35, "needed": 29, "pct": 11.43 } },
    { "id": "8CC0774A3BF66D1D22E76BBDA8E8A232E6B6313834301B3B23E8601196AE6455", "name": "AMM", "status": "enabled",
      "introduced": "1.12.0", "xls": "XLS-30",
      "xls_url": "https://github.com/XRPLF/XRPL-Standards/tree/master/XLS-0030-automated-market-maker", "node_supported": true,
      "enabled": { "ledger_index": 86836481, "date": "2024-03-22T13:04:00Z",
                   "tx_hash": "3D5B5E1A0C2E8F4A6B7C9D0E1F2A3B4C5D6E7F8091A2B3C4D5E6F708192A3B4C", "source": "ledger" } }
  ]
}
```

(The IDs are the real ones and the majority entry is mainnet's on 2026-10-19, nameless because the polled node does not know it,
F10. The vote counts, the AMM ledger, date and hash, and the `introduced`/`xls` values only illustrate the shape.)

- Row keys, in order: `id, name?, status, retired?, introduced?, xls?, xls_url?, description?, node_supported?, votes?, majority?,
  enabled?`. `majority` is `{since, ledger_index?, tx_hash?, expected_activation}` (G5: `ledger_index` and `tx_hash` only when the
  `EnableAmendment` is indexed, 2.7).
  `node_supported` is the node's `supported` when it lists the ID. `votes` (statuses `majority`, `voting`, `unknown`) comes from the
  newest round: `needed` = threshold + 1 (1 when trusted ≤ 1), `pct` = yes / trusted. `enabled.source` is `ledger` (an indexed
  `EnableAmendment`) or `metadata`; `date` is the close time of that transaction, or the file's day.
- `round` describes the newest stored round. `counts` covers all statuses whatever `status` filters.
- **Order**: `majority` by `expected_activation`; `voting` by yes desc, then name; `unknown` by ID; `enabled` by enabled ledger desc
  (no ledger last, then name); `obsolete` by name.
- Errors: 400 `invalid status`; 500 `unable to retrieve amendments`.

### 3.6 `GET /v2/network/amendments/{name}`

`name`: a name (exact, else case-insensitive when that is unique) or a 64-hex ID (any case). Unknown: 404 `amendment not found`.
JSON only. The answer starts with the envelope of 3.5 (G3): `ledger_index`, `rules`, `round` and `next_flag_ledger`, the same values as
the list's, so a page of one amendment needs no list call for them. Then the amendment row of 3.5, then:

- `unl_votes`: every trusted-UNL validator of the newest round, ordered like the validators list:
  `{validation_public_key, domain?, vote, version?, version_supports?, last_seen?}`. `vote` is `yes` / `no` from its counted record,
  or `none` (no record in 24 h, so not in `trusted`). `version_supports` compares the validator's version with `introduced` when both
  are known (the board's "its version lacks it").
- `other_votes`: validators not on the trusted UNL, seen in the last 24 h and holding a record, same shape.
- `rounds`: one entry per stored round of the last 30 days (about 2,600), oldest first:
  `{ledger_index, flag_ledger, date, yes, trusted, threshold, passes}`, `passes` = yes > threshold (or ≥ when trusted = 1). Empty for
  an amendment enabled before the window. A round without a row for the amendment has `yes` 0.
- `history`: the `EnableAmendment` events of 2.7, oldest first, `{event, ledger_index, date, tx_hash}`.
- `result: "success"`.

Errors: 404 `amendment not found`; 500 `unable to retrieve amendments`.

### 3.7 What `data.ripple.com` did differently

The original served `/v2/network/validators[/{pubkey}]` (`api/routes/network/getValidators.js`, `topology.js`; F17). Deliberately different here, recorded
in ADR-0010 and the api-reference:

| Original | Here |
| --- | --- |
| Lists only validators whose last validation is less than 60 s old | `scope=unl` (default, includes offline UNL members) or `all` (adds validators seen in 24 h) |
| No paging | `limit` (200, max 1000), `marker`, `Link` |
| Sorted by chain, UNL first, 24 h score, domain, key | Domain-first alphabetical, then key (the board's order) |
| Row `{validation_public_key, domain, chain, current_index, agreement_1h, agreement_24h, partial, unl}` | The same keys in the same order, without `chain` (one network per deployment), then the new ones; agreement objects keep `{missed, total, score, incomplete}` and add `partial`; `agreement_30d` added |
| `unl` = on Ripple's main or altnet list | `unl` = on the trusted UNL of the configured publishers; `unl_lists` names them |
| `domain` from its own domain check | `domain` from the validator's manifest, `domain_verification` says whether the TOML confirms it |
| Agreement against the ledgers its chain logic saw | Against the indexed validated chain, full validations only, unobserved ledgers left out (2.5) |
| Messages `Validator not found`, `unable to retrieve validator(s)`; CSV `validators.csv` | Kept; new 400s for the new parameters |
| `/manifests`, `/reports`, `/validator_reports`, `/rippled_versions` | Still 404 |

No original route existed for amendments; those are new.

## 4. Interface with the explorer

Which field each board element reads. "S" = `/v2/network/validators/summary`, "L" = `/v2/network/validators`, "D" =
`/v2/network/validators/{key}`, "VV" = `…/{key}/validations`, "A" = `/v2/network/amendments`, "AD" = `/v2/network/amendments/{name}`.

**Validators board** (calls S, L, A with `status=voting,majority` for the filter's options):

| Element | Field |
| --- | --- |
| Tile "Validators seen, last 24 h" | S `validators.seen_24h`; sub-line `unl_seen_24h`, `others_seen_24h` |
| Tile "On the default UNL" | S `validators.unl_seen_24h` / `unl.trusted`; the publishers' names from `unl.publishers[].id` |
| Tile "Quorum" | S `quorum.value` of `quorum.unl_size` |
| Tile "Negative UNL" | S `negative_unl.length` |
| Tile "Base / owner reserve", base fee | S `fees.reserve_base`, `fees.reserve_inc`, `fees.base_fee` (× 1,000,000 for drops) |
| Tile "Next flag ledger", "in ~N min" | S `next_flag_ledger.ledger_index`, `.expected` |
| Version chart and table | S `versions[]` (`unl`, `all`), `versions_unknown`; "Other" is the explorer's grouping |
| Scope chips UNL / All and their counts | L `scope=unl` / `scope=all`; counts S `unl.trusted`, `validators.all` |
| Search box | L `q` |
| "Votes yes for" options and filter | A amendments with `status` voting or majority; L `amendment` |
| Row name, sub-line | L `domain`, else `validation_public_key` (short) |
| "verified" / "not verified" badge | L `domain_verification.status` (`verified` / `unverified`; none for `pending` or no domain) |
| UNL tag and its title | L `unl`, `unl_lists` |
| Version, "latest" badge | L `version` (+ `version_build`), `version_latest` |
| Agreement 24 h | L `agreement_24h.score` |
| Fee votes base / owner / fee, arrows | L `fee_vote.reserve_base`, `.reserve_inc`, `.base_fee` against S `fees`; "—" when `fee_vote` is absent |
| Amendment votes "N yes" and list | L `amendment_votes.yes[]` (`name`, else the ID) |
| Last seen | L `last_seen` |
| Paging | L `limit=1000`, paged in the page, or `marker` |

**Validator board** (calls D, VV with `limit=10`, S):

| Element | Field |
| --- | --- |
| Title, "Domain verified" badge, note | D `domain`, `domain_verification.status`, `.toml_url` |
| Accounts the domain lists (links) | D `domain_verification.accounts` (G1; none drawn when absent) |
| UNL tag, "UNL membership" lines | D `unl`, `unl_lists[]` |
| Master public key, current signing key | D `validation_public_key`, `signing_key` |
| Manifest sequence, rotations | D `manifest.sequence`, `manifest.signing_keys_seen − 1` |
| Version, latest | D `version`, `version_latest` |
| First seen, last seen, "ledger #" | D `first_seen`, `last_seen`, `current_index` |
| Agreement tiles 1 h, 24 h, 30 days | D `agreement_1h`, `agreement_24h`, `agreement_30d` (`score`, `missed`, `total`) |
| Daily agreement chart and table | D `daily_agreement[]` (`date`, `score`, `total`, `missed`) |
| Fee votes "Its vote", "Now" | D `fee_vote`; S `fees` |
| Amendment votes table | D `amendment_votes.votes[]` (`name`/`id`, `status`, `vote`; `unknown` amendments included, G4); the status text ("Activating, in N days", "Voting · x %") from A |
| Recent validations | VV `ledger_index`, `ledger_hash`, `signing_time` (to the second; `first_datetime` has milliseconds), `full` → Full/Partial, `validated` |
| "Older →" | VV `marker` |

**Amendments board** (calls A):

| Element | Field |
| --- | --- |
| "Activating soon" banner | the `majority` rows: `name`/`id`, `majority.expected_activation`, `votes.yes` of `votes.trusted`, `majority.since`, `rules.majority_hold_seconds` |
| Intro sentence | `rules.threshold_percent`, `rules.majority_hold_seconds`, `next_flag_ledger` |
| Status chips and counts | `counts`, client-side filter (or `status`) |
| Rank, name, XLS tag, introduced | position, `name`, `xls` (a link to `xls_url` when present, G2), `introduced` |
| Consensus bar, "x % · y / z UNL" | `votes.pct`, `votes.yes`, `votes.trusted`; tick at `rules.threshold_percent` |
| Status pill | `status`: enabled → Activated, majority → "Activating, in N days" from `expected_activation`, voting, obsolete; unknown → shown with its ID |
| Enabled on | `enabled.date`, `enabled.ledger_index` |

**Amendment board** (calls AD, S; AD carries the list's envelope, G3):

| Element | Field |
| --- | --- |
| Name, status pill, ID | `name`, `status`, `majority.expected_activation`, `id` |
| Specification, introduced in | `xls`, `xls_url`; `introduced` with the network's software name |
| Majority since, activates on | `majority.since`, `majority.ledger_index` (absent when not indexed, G5), `majority.expected_activation` |
| Description | `description` |
| Consensus figure, bar, sentences | `votes.pct`, `votes.yes`, `votes.trusted`, `votes.needed` (spare = yes − needed) |
| Yes votes per flag ledger, chart and change table | `rounds[]` (`flag_ledger`, `date`, `yes`, `trusted`, `passes`) |
| History | `history[]`; "Enabled, expected" from `majority.expected_activation` |
| Votes of the UNL validators | `unl_votes[]`; "N yes · M no on {publishers}" from the votes and S `unl.publishers[].id` |
| Other validators | `other_votes[]`; "of N other validators seen" from S `validators.others_seen_24h` |

**Network board**: its Validators card keeps `/v2/ledgers/{hash}/validations`. To show domains instead of keys, it can join on
`validation_public_key` with L (cached).

The explorer writes its response types by hand (its foundation spec, §12); its fixtures follow the built `docs/api-reference.md` of
`feat/explorer-data` at a pinned commit, not the examples of section 3. The explorer's own edge-cache classes apply. These routes are
live data (they change every minute and every flag round): the validator routes fit its "live" class, the amendment routes (kept
60 s) its `minute` class. The API's `Cache-Control` above is the upper bound it may use.

## 5. Configuration

**Syncer** (`SyncerConfig`, validated at boot like the others):

| Variable | Default | Meaning |
| --- | --- | --- |
| `GH_WORKERS` | `ingest,validations,fee_stats,aggregator,validators` | Adds the `validators` worker. |
| `GH_UNL_PUBLISHERS` | XRPL: `https://vl.ripple.com=ED2677ABFFD1B33AC6FBC3062B71F1E8397C1505E1C42C64D11AD1B28FF73F4734,https://unl.xrplf.org=ED42AEC58B701EEBB77356FFFEC26F83C1F0407263530F068C7C73D392C7E06FD1`; Xahau: `https://vl.xahau.org=EDA46E9C39B1389894E690E58914DC1029602870370A0993E5B87C4A24EAF4A8E8` | Comma separated `url=key` pairs, split at the last `=`. `https://` URLs only; the key is 66 hex digits starting `ED`, `02` or `03`; no URL or key twice. Empty: no lists, every validator untrusted (section 7). |
| `GH_UNL_THRESHOLD` | `0` | Lists that must name a validator for it to be trusted; 0 = rippled's rule; at most the number of publishers. |
| `GH_UNL_REFRESH_MS` | `300000` | List refresh when the list gives no `refresh_interval`. |
| `GH_DOMAIN_VERIFICATION` | `true` | `false` skips domain checks (a host without outbound HTTPS); domains then show `pending`. |
| `GH_DOMAIN_RECHECK_MS` | `21600000` | Re-check interval of a definite result. |
| `GH_DOMAIN_FETCH_TIMEOUT_MS` | `10000` | Overall timeout of one TOML fetch, redirects included. |
| `GH_AMENDMENTS_CONFIG` | the shipped `config/amendments/<network>.json` | Metadata file (2.6). |

Fixed in code, not variables: the poll cadences of 2.3, the 2.2 limits (256 KiB, 3 redirects, 4 in flight, 100 per pass), the 1 MiB
and 20 s of 2.1, the job budgets, the 120 s round delay and 10-minute hour delay, the hold and threshold per network (network
profile).

**API** (`ApiConfig`): `GH_AMENDMENTS_CONFIG` as above. Nothing else; the API reads publishers and thresholds from `unl_publishers`.

**Compose**: `XRPL_UNL_PUBLISHERS`, `XAHAU_UNL_PUBLISHERS` and `XRPL_AMENDMENTS_CONFIG`, `XAHAU_AMENDMENTS_CONFIG` (empty = the
defaults) become the variables above. `GH_UNL_*` and `GH_DOMAIN_*` are added to the syncer's list, `GH_AMENDMENTS_CONFIG` to both. Also
`.env.example` files and `docs/configuration.md` with its check.

## 6. Observability

Metrics (syncer, prefix `syncer_`):

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `syncer_validators_unl_fetches_total` | Counter | `publisher, outcome` | `ok`, `unchanged`, and every reason code of 2.1 |
| `syncer_validators_unl_expiry_seconds` | Gauge | `publisher` | Seconds until the current list expires (negative when expired) |
| `syncer_validators_unl_size` | Gauge | `publisher` | Validators on the current list |
| `syncer_validators_domain_checks_total` | Counter | `outcome` | `verified` and every reason code of 2.2 |
| `syncer_validators_node_polls_total` | Counter | `request, outcome` | `amendments`, `negative_unl`, `fee_settings`, `server_info`, `feature`; `ok` / `error` |
| `syncer_validators_jobs_total` | Counter | `job, outcome` | `rounds`, `agreement`; `ok` / `error` |
| `syncer_validators_agreement_lag_seconds` | Gauge | | Now − end of the newest final hour |
| `syncer_validators_rounds_lag_ledgers` | Gauge | | Newest committed voting ledger − newest stored round |
| `syncer_amendments_without_metadata` | Gauge | | Amendments seen (node, ledger, votes) without a metadata entry |
| `syncer_validator_validations_flushed_total` | Counter | `table` | Rows written to `validator_validations` / `validator_seen` |

Logs: a publisher's status is logged when it changes (not on every retry); a domain's result when it changes; a round whose
`observed` is below quorum at `warn` (`round 107748095: recorded 25 of 35 UNL validations, below quorum 28`); a blocked fetch at `warn`
with the domain and the address class (never the response body); a new amendment ID without metadata once.

Alerts (`docs/observability.md`): `syncer_validators_unl_expiry_seconds < 7 × 86400`; `syncer_validators_agreement_lag_seconds > 7200`
for 30 min; `syncer_validators_rounds_lag_ledgers > 1024` for 30 min; `rate(syncer_validators_jobs_total{outcome="error"}[15m]) > 0`
for 30 min; `syncer_amendments_without_metadata > 0` for a day.

The API adds no metric: its routes are in `api_http_requests_total` and the duration histogram.

## 7. Failure modes

| Failure | Effect | Shows as |
| --- | --- | --- |
| A publisher is down or serves an invalid list | Its last list stays current until it expires, then is used as `expired`; with several publishers the others still count | S `unl.publishers[].status`, `last_error`; the metrics |
| Every publisher unavailable since the first start | No trusted UNL: `unl` false everywhere, `scope=unl` empty, quorum 0, tallies `trusted` 0 | S `status: "unavailable"` |
| A validator's TOML unreachable or wrong | `unverified` with the reason; transient ones keep `verified` for 24 h | L/D `domain_verification` |
| `GH_DOMAIN_VERIFICATION=false` or no egress | Domains `pending` | L/D |
| The node's `feature` fails or lacks a name | Names from the metadata file, else none; statuses from the ledger objects and votes | A `name` absent, `node_supported` absent |
| `ledger_entry` polls fail | The last `network_state` row stays in use; statuses, fees and the negative UNL go stale | S/A `ledger_index` older; metric |
| No `validations` worker (or its nodes down) | No new validations: hours have no observed ledgers (`incomplete`, totals stop growing); records expire after 24 h, so `trusted` falls to 0 and votes go absent; `last_seen` stops | S `agreement_through`, `updated`; L agreement `incomplete` |
| Ingest behind or off | Rounds and hours wait for `ledgers` (not ready); `validated: "unknown"` on recent validations | `rounds_lag_ledgers`, `agreement_lag_seconds` |
| A gap in `ledgers` | Its rounds get `observed = 0` sentinels; its hours are `final = 0` with `gaps` and retried hourly | `incomplete` |
| ClickHouse slow or down | Jobs fail and retry next tick; the collector keeps its buffers (existing behaviour); the API answers 500 with its message | metrics; 500 `unable to retrieve validator(s)` / `unable to retrieve amendments` |
| The `validators` worker not enabled | The collector parts still run; lists, domains, state, rounds, agreement stay empty or stale; the API answers with what it has | S fields absent or stale |
| The database is recreated (for instance at the AMM merge, Rollout) | Everything D1 collected is gone and cannot be recomputed: `validations`, votes, tallies, agreement, `validator_seen`, the stored lists. Collection restarts from the deploy, as on a first start | `first_seen` from the recreation; agreement `incomplete` and votes absent until the windows refill |

## 8. Security

### 8.1 The safe fetcher (`apps/syncer/src/validators/safe-fetch.ts`)

The only way the worker makes HTTP requests: UNL lists and TOML files.

- **Scheme and port**: `https:` only, port 443 only, no credentials in the URL. No proxy from the environment (`HTTP(S)_PROXY` is
  ignored).
- **DNS**: the host is resolved (all A and AAAA records) before connecting. The request is refused (`blocked_address`) if **any**
  address is not public: IPv4 `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`,
  `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`; IPv6 `::/128`, `::1/128`, `fc00::/7`,
  `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `100::/64`, `64:ff9b::/96`, `2002::/16`; and `::ffff:0:0/96` judged by its IPv4.
- **Pinning**: the connection goes to a checked address (the agent's `lookup` returns it), with SNI and `Host` the domain. A DNS
  answer that changes between check and connect cannot redirect the request (DNS rebinding).
- **TLS**: the default trust store, certificate checked against the domain; no override.
- **Redirects**: followed by hand, at most 3, each target checked again from the top (scheme, port, syntax, DNS). Anything else is
  `redirect_rejected`.
- **Limits**: overall timeout (20 s lists, 10 s TOML), body cap (1 MiB lists, 256 KiB TOML) enforced while reading, only status 200
  accepted, no cookies, `Accept` and a fixed `User-Agent: gatehub-data-api/<version> (validators)`.
- **Tests only**: the resolver, the address policy and the CA are options of the worker's options token (the pattern of
  `VALIDATIONS_COLLECTOR_OPTIONS`). No environment variable can loosen them.

### 8.2 What is fetched from where

- **Domains come only from manifests whose signatures the worker verified** (2.2); the stream's or RPC's word is not enough. Nothing
  in a validation message (keys, hashes, cookies) and nothing in a TOML file (its `unl` field, URLs) is ever fetched.
- **Publisher URLs come only from `GH_UNL_PUBLISHERS`**; a list is believed only under the configured key, signed through its
  manifest (2.1).
- The TOML is parsed, never evaluated. Only `[[VALIDATORS]].public_key` is read, and, from a TOML that verified, `[[ACCOUNTS]].address`
  (G1, 2.2): checked as classic addresses, at most 10, stored and served as text, never fetched or followed. The fetch is the same
  (the safe fetcher of 8.1, its SSRF rules unchanged). Parse errors are `toml_invalid`. List JSON is parsed after the size cap.
- The node is asked only fixed commands (`ledger_entry` with the three fixed indexes, `server_info`, `feature`, `manifest` with a
  stored key).

### 8.3 API

The parameters are validated as in 3.2–3.6 and bound as query parameters. `q` matching runs on the cached directory, not in SQL. No
new secret. The syncer now needs **outbound HTTPS to arbitrary public hosts**: `docs/security.md` and `docs/deployment.md` say so; an
operator who restricts egress allows the publishers and sets `GH_DOMAIN_VERIFICATION=false`.

### 8.4 Integrity choices

An expired list is still used, flagged (2.1), rather than showing an empty UNL. A list that fails verification is never used. A
validator's domain is shown even when unverified, always with its status.

## 9. Performance

| Read | Table, key | Size (XRPL) | When |
| --- | --- | --- | --- |
| Directory: first/last seen | `validator_seen`, `GROUP BY` the key | ~1,000 keys × unmerged parts | each build (≤ 1 per 10 s per replica) |
| Directory: newest activity (`current_index`, `partial`) | `validator_validations`, `ledger_index >= head − 300` per key | ~100 k rows | each build |
| Directory: agreement windows | `validator_agreement_hourly`, `hour` range of 720 h, `sumIf` per window | ~300 k rows of UInt32 | each build |
| Directory: records and versions | `validator_votes`, `ledger_index` range: 24 h (records), 30 d (`argMaxIf` version) | ~30 k / ~800 k narrow rows | each build |
| Directory: manifests, domains, lists, state | `validator_manifests`, `validator_domains`, `unl_lists`/`unl_publishers`, newest `network_state` | a few thousand rows | each build |
| Amendment page rounds | `amendment_tallies`, prefix `(amendment_id)` and `('')` over 30 d | ~2,600 + 2,600 rows | per request (cached 10 s) |
| EnableAmendment history | `tx_by_type` prefix `EnableAmendment` → `transactions` keys | a few hundred rows | per 10 s |
| Recent validations page | `validator_validations` key range, R106 shape; `ledgers` by index | ~page + room | per request |
| Round job | `validations` by `ledger_hash` (primary key) | ~200 rows | once per round |
| Hour job | `validations`, one day's partition(s), three columns | ~4 M rows | once per final hour; per day during catch-up |

The directory build runs its reads in parallel and merges in memory: well under 100 ms; with the 10 s cache a list answer is a filter
and a slice of the cached table. The 200 ms budget holds on a miss. The e2e suite pins `read_rows` bounds for the directory reads and
the recent-validations page, and EXPLAINs the key-ordered reads (the house pattern, R106).

## Testing

- **Unit (shared and syncer)**:
  - version decoding, rippled (release, rc, beta, foreign prefix) and xahaud (year offset, build number, `-release`), from the
    encodings of F3/F4;
  - manifest decoding and verification against recorded manifests: a valid one, a tampered field, a revoked sequence, a bad domain;
  - list verification, v1 and v2, over the recorded lists of the three publishers (`packages/shared/test/fixtures/{xrpl,xahau}/unl/`):
    each reason code from a mutated copy (untrusted key, bad manifest, bad signature, stale, same sequence, expired, future
    `effective`, more than 5 blobs, v1 fields in v2);
  - the safe fetcher's address policy (every range of 8.1, IPv4-mapped IPv6), redirect handling, size and time limits, against a local
    server with the test options;
  - TOML matching (listed, not listed, invalid, many entries) and the accounts of G1 (a valid address, a bad checksum, an X-address,
    a duplicate, a missing `address`, more than 10, none read from a TOML that did not verify, kept through a transient failure);
  - quorum, threshold and needed (F7, F12, including trusted = 1 and 2);
  - the round logic: the 24 h carry and expiry, negative-UNL rounds not refreshing a record, a validator joining the UNL;
  - the agreement logic on synthetic hours: observed rule, partial, tracked carry, gaps;
  - status rules of 2.7 and the metadata loader (shape, unique names, unknown keys, IDs = SHA-512Half(name) for a list of known pairs,
    `xls_url` accepted under `https://github.com/XRPLF/XRPL-Standards/` and refused with `http:`, another host, a port, credentials or
    another path);
  - `SyncerConfig`: the new variables, valid and invalid.
- **End to end (testcontainers ClickHouse, as the repo does)**:
  - `packages/shared/test/migrate.e2e-spec.ts`: 002 applies on top of 001, a second run applies nothing, and a run after a statement
    failed halfway completes; the table list equals the `Table` enum;
  - `apps/syncer/test/validations.e2e-spec.ts`: the collector writes `server_version`, the manifest's domain and raw bytes,
    `validator_validations` and `validator_seen`; a failed insert of one table is retried alone and deduplicated;
  - a new `apps/syncer/test/validators.e2e-spec.ts`: on a synthetic chain (ledgers through the real `LedgerWriter`, validations
    including a voting ledger every 256), with a fake node (websocket server answering `ledger_entry`, `server_info`, `feature`,
    `manifest`) and a local HTTPS server for lists and TOML files: rounds and tallies, hours and their finality, gaps, the seeding of
    `validator_seen`, restarts resuming from the stored sets;
  - a new `apps/api/test/validators.e2e-spec.ts` and `amendments.e2e-spec.ts` on both networks: every route's shape and key order,
    each error message, markers that concatenate to the unpaged list, CSV, `Cache-Control`, unknown parameters ignored, an empty
    database, Xahau's hold and version format; `domain_verification.accounts`, `xls_url`, the envelope of the amendment detail equal to
    the list's, `unknown` amendments in a validator's `votes`, and a majority without an indexed `EnableAmendment` (no `ledger_index`,
    no `tx_hash`); `read_rows` bounds and EXPLAINs as in `paged-reads.e2e-spec.ts`.
- **Fixtures**: `record-fixtures.ts` gets a `--unl` mode that saves the three publishers' responses and a `--network-state` mode that
  saves `feature` and the three `ledger_entry` answers of both networks (at most 2 requests in flight). TOML files are written by hand,
  since real domains change. `packages/shared/test/fixtures/README.md` records the source and date of each.

## Rollout

1. **Deploy-order constraint (for the owner).** D1 is deployed to a persistent environment only after the owner has merged
   `feat/amm-data`, or the owner accepts the loss below. That branch edits `001_baseline.sql` in place, and the migration runner refuses
   an applied file whose checksum changed (`Migration 001_baseline.sql was modified after being applied`,
   `packages/shared/src/clickhouse/migrate.ts`). So a database created before that merge must be recreated when it is merged, which the
   AMM design asks for anyway. D1 would lose with it what it collected and cannot recompute: the validations (`validations`, 90 days,
   from which votes and agreement are back-filled), `validator_votes`, `amendment_tallies`, `validator_agreement_hourly`, the
   `validator_seen` first-seen history, the stored UNL lists and the domain results. D2's tables are recomputable and set no such
   constraint. A throwaway environment (development, tests) may run D1 before the merge.
2. **Deploy order**: `migrate-<network>` (applies 002), then `syncer-<network>` (new collector, `validators` worker), then
   `api-<network>`. An API that comes first answers from empty tables (no errors: the tables exist). Everything is additive: rolling
   back the API removes the routes, removing `validators` from `GH_WORKERS` stops the worker, and 002 needs no undo.
3. **Before the deploy**: the metadata files are filled (2.6) and `amendments:check` passes; `GH_WORKERS` is updated where it is set
   explicitly; egress to the publishers (and to validator domains, or `GH_DOMAIN_VERIFICATION=false`) is open.
4. **Filling**, after the syncer starts (estimates; the metrics of section 6 show progress):

   | Data | Ready after |
   | --- | --- |
   | UNL lists, network state, amendment names | the first fetch and poll: seconds to 1 minute |
   | First seen | the seeding scan of `validations`: about a minute |
   | Domain verification | passes of up to 100 checks a minute: minutes for a few hundred domains |
   | Versions | the first voting ledger after the new collector: at most ~17 minutes |
   | Votes and tallies | the backfill of the retained rounds (up to ~7,600 on XRPL), 5 s a minute: about 1–2 hours |
   | Agreement 1 h / 24 h / 30 d | a day per query during catch-up, 10 s a minute: about 1–2 hours for 90 days. Each window is complete once the collector has run, and the ledgers are indexed, for that long: 30 d agreement needs 30 days of both |
   | Recent validations per validator | from the deploy on (7-day window) |

5. **Documentation** in the same change: `docs/api-reference.md` (a "Validators and amendments" section; the out-of-scope table keeps
   only the routes of the Non-goals), `docs/data-model.md`, `docs/syncer.md`, `docs/configuration.md`, `docs/observability.md`,
   `docs/security.md`, `docs/deployment.md`, `docs/operations.md` (metadata upkeep, publisher key rotation), ADR-0012, ADR-0010 (3.7),
   `docs/openapi.yaml`, the `.env.example` files and the compose files.
