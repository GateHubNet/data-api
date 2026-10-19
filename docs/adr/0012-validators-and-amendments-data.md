# ADR-0012: Validators and amendments data

**Status:** Accepted (2026-10-19). Design: [validators and amendments](../superpowers/specs/2026-10-19-validators-amendments-design.md).

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
