# ADR-0012: Validators and amendments data

**Status:** Accepted (2026-10-19). Design: [validators and amendments](../superpowers/specs/2026-10-19-validators-amendments-design.md). Amended (2026-10-24): the
testnets, in [the section at the end of this record](#amendment-2026-10-24-the-testnets) (the fixed validator list `local`, `retired` on XRPL, the family file on a testnet).
Design: [testnet profiles](../superpowers/specs/2026-10-24-testnet-profiles-design.md); the "plan rulings" below are those of
[its plan](../superpowers/plans/2026-10-24-testnet-profiles.md).

## Context
The explorer's Validators and Amendments boards need, per network, every validator (domain, UNL membership, software version, agreement,
fee and amendment votes) and every amendment (status, consensus, majority history). The data API collected part of this: the
`validations` worker writes every validation of `GH_VALIDATION_ENDPOINTS` and the master-to-signing-key map. It kept no software version,
no manifest domain, no published validator list, no domain verification, no agreement, no amendment state and no vote tallies, and the
original's `/v2/network/validators[/{pubkey}]` was listed as out of scope and answered 404 ([ADR-0010](0010-ripple-v2-wire-compatibility.md)).
Nothing in a node or a ledger serves an amendment's introducing version, its standard or its description, and public nodes report a
`validation_quorum` of 0.

## Decision
**A worker of its own.** `validators` is the fifth syncer worker (`GH_WORKERS`), not a set of aggregator jobs, because (1) it needs the
node and outbound HTTPS to third-party sites, which the aggregator needs neither of and boots without; (2) its cadences (flag rounds,
hours, re-check intervals) and failure modes (a publisher or a domain is down) are its own; (3) the aggregator's 30 s tick is shared by
the volume and stats jobs (and, on `feat/amm-data`, the AMM jobs), and the new jobs must neither compete for that budget nor change its
job order, which also keeps `aggregator.service.ts` untouched and the two branches apart; (4) an operator can switch the whole feature
on or off with `GH_WORKERS`. It runs an I/O loop (lists, domains, node polls) and a compute loop (`rounds`, `agreement`) with the
aggregator's job model.

**Agreement is counted over full validations against the indexed chain.** Per UTC hour, a validator agreed with a ledger of `ledgers`
when it fully validated that hash; a partial validation is a miss counted apart (`partial`). A ledger the collector did not see
(fewer than quorum UNL validations recorded) is `unobserved` and left out for everybody, so a collector outage never reads as validators
missing ledgers. Hours are written as version sets and are final only once the ingest has passed them without a gap.

**Expired lists are used and flagged; invalid ones never.** A publisher's list past its expiration is still the UNL, reported as
`expired` (a flagged old UNL is better than an empty one). A list that fails verification is not stored.

**Outbound HTTPS only through the safe fetcher.** Publisher lists and validator-domain TOML files are fetched over HTTPS on port 443, to
public addresses only, pinned to the address that was checked, with size and time limits and hand-followed redirects, each checked again
(`apps/syncer/src/validators/safe-fetch.ts`). A domain is fetched, and can be `verified`, only when it is that of a manifest whose signatures
the worker verified itself. The `domain` served is that of a validator's newest stored manifest, and only a properly formed one (rippled's
`isProperlyFormedTomlDomain`): any other is left out of `domain`, the manifest, the CSV and `toml_url`. An operator who cannot allow egress to
arbitrary public hosts sets `GH_DOMAIN_VERIFICATION=false` (domains then show `pending`) and keeps egress to the publishers.

**The quorum is derived, not read.** `max(⌈0.8 × (UNL − negative-UNL members on it)⌉, ⌈0.6 × UNL⌉)` over the trusted UNL, rippled's
rule, in integer arithmetic. The node's `validation_quorum` (0 on public nodes) is shown as `node` only when it is above 0.

**The Xahau UNL is the default publisher's list** (`vl.xahau.org`), not the on-ledger `UNLReport`: it is what xahaud trusts out of the box.

**The amendment metadata is a hand-kept file per network** (`packages/shared/config/amendments/<network>.json`: introducing version, XLS
and its URL, description, `obsolete`, `retired`). `amendments:check` compares it with a node and the database, a gauge
(`syncer_amendments_without_metadata`) and a release-checklist line keep it current, and a file that does not load fails the boot.

**Recent validations are kept 7 days** (`validator_validations`, about 1 GB on XRPL); agreement and votes read the 90 days of `validations`.

**Version sets.** A voting round (`validator_votes` + `amendment_tallies`) and an hour (`validator_agreement_hourly`) are each written whole
under one `version`, the sentinel row last; a reader keeps only the newest sentinel's version of each unit, so no read mixes two.

**Migration `002_validators_amendments.sql` and the deploy-order constraint.** The migration is additive (two `ALTER TABLE` statements
adding four columns with `ADD COLUMN IF NOT EXISTS`, and ten `CREATE TABLE IF NOT EXISTS`) and needs no undo. It is deployed in the order `migrate-<network>`, `syncer-<network>`,
`api-<network>`. D1 goes to a persistent environment only after the owner has merged `feat/amm-data`, or the owner accepts the loss
below: that branch edits `001_baseline.sql` in place, the migration runner refuses an applied file whose checksum changed, so a database
created before that merge is recreated, and with it what D1 collected and cannot recompute (the 90 days of `validations` from which votes
and agreement are back-filled, `validator_votes`, `amendment_tallies`, `validator_agreement_hourly`, the first-seen history, the stored
lists, the domain results, and the polled ledger states of `network_state`, whose negative UNL and majorities the rounds and the hours
read).

### Deviations and decisions made while building it
- **`gapsOf` is edge-aware** (ruling P10; a deliberate deviation from spec 2.5's formula). Spec 2.5 counts the ledger indices missing between an hour's
  first and last ledger. Here the indices missing between the hour and the nearest committed ledger before and after it count too, so a
  ledger missing at the border of two hours keeps both from being final. An hour that borders a gap is not final.
- **The safe fetcher blocks more special-purpose ranges than spec 8.1 lists** (a deliberate widening): on top of the nine IPv6 ranges of the
  spec, `::/96`, `64:ff9b:1::/48`, `2001::/23`, `fec0::/10`, `3fff::/20`, `5f00::/16` and `100:0:0:1::/64`, and `::ffff:0:0:0/96` (SIIT)
  is judged by its IPv4 like `::ffff:0:0/96`.
- **List verification follows rippled.** The structure rules of a manifest apply (only the fields rippled's `deserializeManifest`
  knows). Every blob is verified with the highest-sequence publisher manifest seen, the one of the body and the one the worker has
  already seen (`knownManifest`), so a body that replays an older manifest cannot bring back a superseded signing key; a revocation is
  remembered in-process (a restart forgets one that stored nothing: the next response has to show it again). Lists are told apart by `publisher_key`: "in use now"
  (the trusted UNL, a publisher's status, the newest stored sequence a blob is compared with) takes the lists served under the key the
  publisher is configured with, and a historical read (a round or an hour in the past) keeps every key, each trusted in its time.
- **Voting rounds that `ledgers` lacked and later gained** (for example by a range ingest) are recomputed, together with the rounds up to
  24 h after them, whose vote records may be carried from the late one. A follower that is itself a late round is left to its own unit.
- **`validator_seen` is seeded in the background**, one `INSERT ... SELECT` per partition of `validations`, newest first, so a statement
  fits the ClickHouse request timeout and the boot is neither delayed nor failed. It runs when the table is empty or when its oldest
  `first_seen` is more than an hour newer than the oldest validation (an interrupted seeding shows at the next start).
- **The below-quorum warning of a round counts the observed UNL members that are not on the negative UNL**, whose validations rippled
  discounts; so the count in the warning can be below the stored `observed`.
- **Recent validations merge the rows recorded under the master's signing keys** (ruling P9: a validation recorded before its manifest was
  known is the master's), with one bounded inner read per key and a sum outside them; the read grows its room while partial rows fill it.
- **The manifest map is computed inside each statement that maps keys** (`KEY_MAP_WITH` and `mappedKey` of `packages/shared`), not
  sent with it as the query parameters the plan named: the client puts parameters in the URL, about 122 bytes a manifest, and
  `validator_manifests` keeps every manifest the stream brings, so some 9,000 manifests (which anyone can broadcast) would pass the 1 MiB
  of a URL ClickHouse takes and fail every route and job of D1. The newest manifest of a master is `argMax(…, (seq, notEmpty(manifest)))`
  (`NEWEST_MANIFEST_ORDER`): a row of 001 and the row with the raw manifest share a `seq` until a merge.
- **An hour with an empty UNL is not written.** It would be final with nothing observed; the hour waits for a validator list.
- **Deviations from `data.ripple.com`** are the amendment to [ADR-0010](0010-ripple-v2-wire-compatibility.md) and the "Differences" of the
  routes in [api-reference](../api-reference.md#validators-and-amendments).

## Consequences
**Positive**
- The boards' data is served from tables, with no call to a node or a third-party site on the request path; each unit (list, domain,
  round, hour) fails and recovers on its own, and the feature switches off with `GH_WORKERS`.
- Everything the compute jobs write is recomputable from `validations`, `ledgers`, the stored lists and `network_state` (the negative UNL
  and the majorities that the rounds and the hours read) within retention, and is written as a version set, so a crash is invisible and a
  late ledger is repaired.
- Additive: removing `validators` from `GH_WORKERS` stops the worker, rolling back the API removes the routes, and `002` needs no undo.

**Negative / trade-offs**
- The syncer needs outbound HTTPS to arbitrary public hosts ([security](../security.md#outbound-https-to-arbitrary-public-hosts-syncer)),
  or loses domain verification.
- "First seen" means first seen by this deployment; there is no agreement or vote history from before the collector ran, and 30-day
  agreement needs 30 days of both the collector and the index.
- The amendment metadata needs upkeep at every rippled or xahaud release ([operations](../operations.md#keep-the-amendment-metadata-current)).
- The deploy-order constraint with `feat/amm-data` above, and the syncer needs migration `002` applied before it starts (see
  [deployment](../deployment.md#rolling-out-the-validators-and-amendments-data)).
- The explorer's agreement differs from the validator history service's (full validations only, observed ledgers only), and the routes
  `/manifests`, `/reports`, `/validator_reports` and `/rippled_versions` of the original stay 404.

## Amendment (2026-10-24): the testnets

[ADR-0009](0009-one-deployment-per-network.md#amendment-2026-10-24-testnets) adds XRPL Testnet and Xahau Testnet as networks of their own. The validators and amendments
data follow the profile of the network, with three additions: a validator list that is configuration, not a publisher's; `retired` on XRPL; and one metadata file per
protocol family. They add no migration and no parser version.

### Decision
- **XRPL Testnet has one list publisher**, `https://vl.altnet.rippletest.net`, with the key
  `ED264807102805220DA0F312E71FC2C69E1552C9C5790F6C25E3729DEB573D5860` (the profile's `defaultUnlPublishers`). The `validators` worker fetches, verifies and
  stores its list as it does Ripple's. The recorded list (2026-10-25) is a version 1 list with one blob, sequence 59 and 6 validators.
- **Xahau Testnet has no publisher, and trusts a fixed list.** Its nodes trust the four master keys of the `[validators]` section of their configuration, with no
  `[validator_list_sites]`. The keys are the profile's `defaultUnlValidators`, and the profile's comment names where they come from: `store/etc/validators-xahau.txt` of
  `Xahau/Xahau-Testnet-Docker`, last changed in commit `01ed74b5ebf34b27c8d5635b6d03972cc23346da` (2024-10-25) and unchanged at `87eeb5db5f81f0d0b526f6365e2aede14cd2559d`
  (2025-12-18, the head when it was read):

  ```
  nHBoJCE3wPgkTcrNPMHyTJFQ2t77EyCAqcBRspFCpL6JhwCm94VZ
  nHUVv4g47bFMySAZFUKVaXUYEmfiUExSoY4FzwXULNwJRzju4XnQ
  nHBvr8avSFTz4TFxZvvi4rEJZZtyqE3J6KAAcVWVtifsE7edPM7q
  nHUH3Z8TRU57zetHbEPr1ynyrJhxQCwrJvNjr4j1SMjYADyW1WWe
  ```

  Without a trusted set no Xahau Testnet validator would be on the UNL, and the amendment tallies and the validators pages of the sandbox would say nothing.
- **`GH_UNL_VALIDATORS`** (syncer; comma separated validator master keys in base58, `n…`) holds such a list. Unset or `default` is the network's `defaultUnlValidators`
  (the four keys on Xahau Testnet, none elsewhere); empty is none. Each entry is trimmed, must decode as a node public key and may not repeat; a bad entry fails the
  boot with `GH_UNL_VALIDATORS entry <n>: must be a validator public key (n…)` or `GH_UNL_VALIDATORS entry <n>: repeats a key`. An entry in the `ED…` hex form is refused.
  `GH_UNL_PUBLISHERS` gains the same spelling, `default` (trimmed, any case): the network's default publishers, as unset; empty still means no lists. A publisher URL whose id
  is `local` is refused (`GH_UNL_PUBLISHERS entry <n>: the id "local" is reserved`).
- **The fixed list is stored as the list of the publisher `local`**, so that the tally, the agreement, the directory and the API read it with no branch of their own.
  At start the fetcher writes a `unl_publishers` row for `local` (no URL, no key, `configured` 1, the threshold in force, `status` `ok`) and a `unl_lists` row when the newest
  stored `local` list differs from the configured keys, sorted, or none is stored: the next sequence (1 when none), `version` 1, `publisher_key` `''`, `effective` the time of
  writing, `expiration` 4294967295 (2106-02-07T06:28:15Z, the `DateTime` maximum: a fixed list does not expire), the keys sorted, and as `blob_sha256` the upper-case hex SHA-256 of
  the sorted keys joined by newlines (as a publisher's blob hash is written). A restart with the same keys writes nothing, so the history of the list stays what it was and
  a round or an hour of the past reads the list that was in force; changed keys write sequence + 1; an emptied list marks a stored `local` `configured` 0. `local` is never
  fetched: no timer, no metric of a fetch. The domain checker adds the fixed list's keys to the masters it checks, so a fixed-list validator no list has shown is checked as the
  directory shows it.
- **The threshold counts the lists.** `GH_UNL_THRESHOLD` counts lists that must name a validator: the publishers, plus one when the fixed list is not empty (rippled counts its
  local list the same way). `0` is rippled's rule over that count (1 below three lists), and the boot bound is the number of lists (`GH_UNL_THRESHOLD must be between 0 and the
  number of lists (<n>)`): XRPL 2, Xahau 1, XRPL Testnet 1, Xahau Testnet 1 by default, so a validator on the fixed list alone is trusted at threshold 1.
- **The API shows `local`.** `/v2/network/validators/summary` lists `local` among `unl.publishers` in the directory's order (by id), with empty `url` and `public_key` and no
  `expiration`; a validator on the fixed list has `unl: true` and `unl_lists: ["local"]` in `/v2/network/validators` and `/v2/network/validators/{key}`. On Xahau Testnet the
  summary says `trusted` 4, `threshold` 1 ([api-reference](../api-reference.md#get-v2networkvalidatorssummary)). [ADR-0010](0010-ripple-v2-wire-compatibility.md) item 44 gains
  the sentence about `local`.
- **The amendment metadata is a hand-kept file per family**, not per network: `packages/shared/config/amendments/xrpl.json` and `xahau.json`. A testnet reads its family's file
  (`loadAmendmentsConfig` reads `config/amendments/<family>.json`) and drops its `enabled` entries, which are mainnet's ledgers and dates, keeping the names, versions, XLS links,
  descriptions, `obsolete` and `retired`. The file's `network` may be the profile's name or its family (`"xrpl"` for `xrpl-testnet`); anything else is refused as before
  (`"xahau" is not the network of this deployment, "xrpl-testnet"`); the `enabled` entries are kept only when `network` is the profile's own name, so an operator can give a
  testnet a file of its own (`GH_AMENDMENTS_CONFIG`, `"network": "xrpl-testnet"`). `AmendmentsConfig.network` is the profile's name, so the caches and gauges are unchanged. On a
  testnet an amendment's `enabled` comes from the indexed `EnableAmendment` (`source: "ledger"`) or is absent: it is still `enabled` (it is in the ledger's `Amendments`), with no ledger
  or date, and no testnet answer says `source: "metadata"`.
- **`retired` is valid on XRPL.** rippled's `features.macro` marks 15 amendments `XRPL_RETIRE`: `MultiSign`, `TrustSetAuth`, `FeeEscalation`, `PayChan`, `CryptoConditions`,
  `TickSize`, `fix1368`, `Escrow`, `fix1373`, `EnforceInvariants`, `SortedDirectories`, `fix1201`, `fix1512`, `fix1523` and `fix1528`. Their code is unconditional, and a ledger begun
  after their retirement never lists them: XRPL Testnet's `Amendments` object lacks exactly these 15 of mainnet's (checked 2026-10-24), so without the mark they would read
  `voting` there. The loader's rule that `retired` is for Xahau only is gone (the `introduced` patterns stay by software), and `xrpl.json` marks the 15 `"retired": true`, keeping their
  `enabled`. `amendmentStatus` already read `inLedger || retired` as enabled and shows a retired amendment's `enabled` only when the ledger has it, so no mainnet status changes; XRPL
  Testnet shows the 15 as `enabled` without a date.
- **`amendments:check --network xrpl-testnet|xahau-testnet`** checks the family file against the testnet's node, with the testnet's default endpoint. With the `enabled` entries dropped, its
  third list (enabled ledgers that differ from the indexed `EnableAmendment`) is always empty on a testnet.
- **The majority hold of each testnet is its profile's `majorityHoldSeconds`**, which feeds `expected_activation`. Neither network publishes it, and the values were checked when the profiles were built:

  | | Value | Where it came from |
  | --- | --- | --- |
  | XRPL Testnet | 1,800 s (30 minutes), **inferred** | Not the 14 days of mainnet. Seven amendments whose got-majority (`tfGotMajority`, flags 65536) and enabling `EnableAmendment` pseudo-transactions were read on `clio.altnet.rippletest.net` on 2026-10-24, by walking the `Amendments` object back through `PreviousTxnID` (the newest ones, back to ledger 14635521), were each enabled exactly 768 ledgers (three flag intervals, 39 to 43 minutes) after gaining a majority. The hold is tested at each flag ledger, which bounds it to 1711 s < hold <= 2359 s over the seven; 30 minutes is the round value in that range. An example: `0F48FF56…540B` gained its majority in ledger 21394177 (tx `F7077524E6D29D05EB8CAAA24B6B2F2623911D52D9D92F6C21088F914D404B63`) and was enabled in ledger 21394945 (tx `7A730EDFD2E4E248B1E0F0D30928172381E200D9BA543502B21F075CA1FD30E3`). The setting is not published: the owner may want to confirm it with Ripple. |
  | Xahau Testnet | 432,000 s (5 days), the software default, **not verified on the chain** | `Xahau/Xahau-Testnet-Docker@87eeb5db…` sets no `[amendment_majority_time]` (`store/etc/xahaud.cfg`, commit `1dd22588ce2dd8826488e6da1b65e304776a95a1`), so xahaud's `defaultAmendmentMajorityTime`, `days{5}` in `include/xrpl/protocol/SystemParameters.h` of `Xahau/xahaud@5c05e107c0211dcedb7adcf73dab1f6012747fe7`, applies. No pair could be read: `xahau-test.net` holds about 5.7 days of ledgers, and its `Amendments` object last changed in ledger 13236737, before them. The real testnet's validators may configure otherwise. |

  The design assumed 14 days and 5 days "as on mainnet, to verify"; the first was wrong. The majority hold of XRPL mainnet (1,209,600 s) and Xahau (432,000 s) are unchanged.
- **Names the testnets have that mainnet lacks** (2026-10-24, `Amendments` of each validated ledger). XRPL Testnet: nothing (82 enabled, all on mainnet). Xahau Testnet: 14, of which
  13 were already named in `xahau.json` (`AMMClawback`, `EscrowDestinationCancel`, `HookAPISerializedType240`, `HookOnV2`, `HookOnV2_1`, `HooksUpdate2`, `NamedHooks`, `OnChainManifests`,
  `PWALoader`, `RNG`, `fixEnforceNFTokenTrustline`, `fixNFTokenPageLinks`, `fixNFTokenReserve`) and one, `AB6612F1B9C2EAB6F687512297D9960B13B869EFF97E77D85A0574DFF97FD1EE`, was
  not. It is `fixXahauTestnetGenesis` (`amendmentId` of the name is that ID, and the node's `feature` names it), from `XRPL_FIX (XahauTestnetGenesis, …)` in `features.macro` of the
  `testnet` and `tmp-dev` branches of `Xahau/xahaud` (commit `f70eaba37`, "testnet genesis fix", 2026-10-16; "Xahau testnet (NetworkID 21338) only"). It is **not on `dev`**, because the
  testnet runs a build of its own (`2026.10.16-tmp-dev`), and no release carries it, so its entry has no `introduced`.

### Decisions made while building it
- **Mainnet's answers do change, by one additive key.** The design said the `retired` marks change no mainnet answer; they add `"retired": true` to the 15 rows of XRPL's
  amendments (`amendment-status.ts` sets it whether or not the ledger lists the ID, and `amendment-object.ts` emits it). Statuses, `enabled` objects and every other key are as before.
  Nothing to reprocess.
- **The threshold's bound is the number of lists** (plan ruling 7), not of publishers: Xahau Testnet has 0 publishers and 1 list.
- **The domain checker counts the fixed list** (plan ruling 8): its own loop takes the masters of the lists in use of the URL publishers, matched by key, which `local`'s `''` never matches;
  it adds the fixed list's keys.
- **Trust at threshold 1 is tested where it is decided** (plan ruling 11): `stored-lists.spec.ts`, over the `ListContext` that now includes `local`, not `tally.spec.ts` and
  `agreement.spec.ts`, which receive the trusted UNL as a set.
- **The local list's hash is upper-case hex** (plan ruling 12), as a publisher's `blob_sha256` is.

### Consequences
**Positive**
- Xahau Testnet's validators, tallies and agreement work like any network's, with nothing but configuration; the tally, the agreement and the directory read `local` with no branch of their own.
- The history of the fixed list is kept: a past round reads the list that was in force.
- One file of names and descriptions per protocol; a testnet's enablement comes from its own ledger.

**Negative / trade-offs**
- The fixed list is configuration. If Xahau Testnet's operators change their `[validators]`, the profile's default or `GH_UNL_VALIDATORS` has to follow by hand, and the comment of the
  profile names the file to compare.
- The testnets' majority holds are an inference (XRPL Testnet) and a software default (Xahau Testnet); a wrong one shows `expected_activation` too early or too late, never a status.
- Mainnet's XRPL rows gain a `retired` key, and the family file is shared: every name of the file is a row on every network of the family, so a name that only one of them has, such as
  `fixXahauTestnetGenesis`, is a row on the other too. Unmarked, it would be a permanent `voting` row with 0 votes on Xahau mainnet, whose node does not know it. The file therefore marks it
  `obsolete: true`, as it does `AMMClawback` and `HookOnV2`: Xahau mainnet's board shows it `obsolete`, Xahau Testnet's `enabled` (its ledger lists the ID, and that rule comes first), and
  `syncer_amendments_without_metadata` stays 0.
- An unnamed ID on a testnet is `unknown` until the file names it, as on mainnet; `amendments:check --network <testnet>` after a new build of a testnet's node finds the names to add ([operations](../operations.md#keep-the-amendment-metadata-current)).
