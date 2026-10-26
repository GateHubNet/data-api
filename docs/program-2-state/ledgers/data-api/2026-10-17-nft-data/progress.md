# SDD ledger — plan: docs/superpowers/plans/2026-10-17-nft-data.md
BASE (plan start): f59102e

## Pre-flight scan

Scope: the plan (876 lines) and the spec (revised 2026-10-24) against the code at HEAD f59102e (D-env a254fa5..f59102e on the branch). Read-only; nothing was built or run (two arithmetic and hash checks with `node -e`). Legend: agree, CONFLICT (needs a ruling before the task runs), NOTE (a gap the implementer will hit, or a risk). The conflicts are numbered C1..C14 and their rulings are in section D.

### A. Pairs of tasks that share a file or an interface

| # | Tasks | Produces / consumes | Finding |
| --- | --- | --- | --- |
| P1 | T1 -> T4 | `xrpl/nft` set, 16 `manifest.cases`, FINDINGS (id example, royalty figure) -> parser `it` per case | agree: T1's 16 case names are exactly T4's list. The id example checks out by hand (0xA9ECC907 XOR ((384160001 x 106293080 + 2459) mod 2^32) = 500; the product is above 2^53). See C8 for how T1 finds the conditioned cases. |
| P2 | T1 -> T5 | `xahau/uritoken` set, 9 case names -> Xahau `it` list | agree: same 9 names, `uritoken_remint` with the `synthetic-` fallback on both sides. |
| P3 | T1 -> T3 | FINDINGS: Xahau first ledger 1, ledger 2 on 2023-10-30 -> `firstLedger` 1, `xahau.json` URIToken `enabled {1, 2023-10-30}`, Ruling 3 | agree. Checked: SHA512Half("URIToken") = ECF412BE...AC32 and SHA512Half(0x0066) = 7DB0788C...6EF4, as T1 says. |
| P4 | T1 -> T6 | every recorded and `synthetic-` transaction -> oracle and invariants | agree. |
| P5 | T1 -> T7 | the two directories -> seeds `xrpl-nft`, `xahau-uritoken` (`SeedName`, `DIRS`, `SEED_NETWORK` exist in `apps/api/test/support/fixtures.ts`; D-env added the two testnet seeds there, no clash) | agree. NOTE: `xahau/recorded` already holds real URITokenBuy / URITokenCreateSellOffer / Remit ledgers, so T7's wiring changes existing snapshots (P19). |
| P6 | T1 -> T9, T12, T13, T14 | seeds -> aggregator and API e2e | agree. NOTE: T12's "mint not indexed" test (`sell_offer_create`'s NFT) holds only if that NFT's mint is outside the recorded ledgers; T1's FINDINGS should say it. |
| P7 | T2 -> T3 | `NFT_PARSER_VERSION = 5` -> `COVERAGE_FEATURES.nfts` | agree. |
| P8 | T2 -> T7 | five ledger tables with a dedup window -> `CHILD_TABLES`, `LEDGER_KEYED_TABLES` | CONFLICT C1: T2 creates the tables, T7 registers them; `ledger-writer.e2e-spec.ts` "schema contract" (lines 1092-1110) fails in between. |
| P9 | T2 <-> T7 (`rows.ts`) | `NFT_PARSER_VERSION` (T2) / `PARSER_VERSION` -> 5 (T7) | agree (T2's comment "which Task 7 moves to it"). Literal-4 asserts: see T7. |
| P10 | T2 -> T8 | `Table.Nfts/AccountNfts/NftDirty/NftTouches`, `NftsRow`, `AccountNftsRow`, `NftDirtyRow` | agree. |
| P11 | T2 -> T11 | `NftCollectionsRow`, `NftCollectionHoldersRow` | agree. |
| P12 | T2 <-> T15 (`docs/data-model.md`) | table list, count, migration list | NOTE: T2 says "§3 the ten tables, §5 the migration list". The file has the migration list in its opening paragraph and in §5; the five ledger tables belong to §2 ("Ledger-derived (23)" group, "55 tables" count -> 28 / 65), only the four aggregates and `nft_dirty` to §3. The `ledgers.parser_version` paragraph (line 108) needs "5" too. |
| P13 | T3 -> T12 | `Coverage`, `COVERAGE_KEYS`, `itemCoverage('nfts', created)` | agree on names; CONFLICT C7 on the e2e (needs `network_state` seeded and the 60 s cache cleared). |
| P14 | T3 -> T13, T14 | `coverage('nfts')` | agree; same C7 for the `complete: true` cases. |
| P15 | T3 <-> T12 (`app.module.ts`) | `FeatureCoverageModule` in `imports` (T3); `NftModule` in `ENDPOINT_MODULES` (T12) | agree; `app.module.spec.ts` only pins NotFoundModule last. |
| P16 | T3 <-> T14 | `FeatureCoverageService` injected into `VolumeController` | agree (global module); the controller constructor changes. |
| P17 | T4 -> T5 | `nft.parser.ts` / spec created, then extended | agree (T5 only adds the URIToken half). |
| P18 | T4 -> T6 | `NftParser`, `ParsedNftEvent`, `rolesOf` -> oracle, invariants | agree. |
| P19 | T4, T5 -> T7 | `NftParser`, `rolesOf`, `ParsedNftEvent` -> five row arrays | agree on the mapping (T7 adds `tx_hash`, `tx_type`, `close_time`, `amount_f`). CONFLICT C4 on what else T7 must touch. |
| P20 | T5 -> T6 | Xahau cases -> oracle | agree. |
| P21 | T4 -> T8 | `NftEventName`, `NftKind` -> `NftEventRead` | agree. |
| P22 | T4 -> T12 | `NftRole`, `NftEventName`, `NFT_ROLES` -> `rolesParam`, `eventsParam` | agree. |
| P23 | T7 -> T8, T9 | `buildLedgerRows` rows -> e2e that fold and rebuild | agree (T7 runs before T8). |
| P24 | T8 -> T9 | nine state functions, `NftKey`, `CollectionKey`, constants -> `NftStateFunctions` | agree: the nine names of T9's interface are all produced by T8. Abort: `NftRebuildAborted` is not added to `failed()` (C3). |
| P25 | T8 -> T11 | `CollectionKey`, tables | agree. |
| P26 | T8 -> T12 | `foldNftEvents`, `NftEventRead`, `NftFold` -> detail | CONFLICT C6: the last sale cannot be keyed for `convertedSalePrices`. |
| P27 | T8 -> T13 | `NftFold` <- `nftFoldOfRow(NftsRow)` | agree (`owners []`, `created_ledger` undefined as T13 says). |
| P28 | T9 -> T11 | `AggregatorNfts`, budgets, `NFT_COLLECTIONS_EVERY_TICKS`, `onRebuilt` | agree on names; CONFLICT C3: no `nftCollectionsFunctions` option, no abort class. |
| P29 | T9 <-> T11 (`aggregator.service.ts`, `aggregator.schedule.spec.ts`, `aggregator-nfts.e2e-spec.ts`) | job after `amm_pools`; job after `amm_daily` | agree: the tick list in T11 (`... stats_dirty, amm_daily, nft_collections, rates_daily ...`) matches the order in the code (`stats_live`/`stats_dirty` sit between `markets_live` and `amm_daily`). |
| P30 | T7 <-> T9 (`prometheus.service.ts`) | `nftSkippedTotal` (T7); three gauges (T9) | agree, no overlap. |
| P31 | T9 <-> T10 (`aggregator.service.spec.ts`, `aggregator.schedule.spec.ts`, `aggregator.module.spec.ts`) | `nft_state` (T9); `nft_volume` in `VOLUME_METRICS` (T10) | CONFLICT C2 (counts 12/6 -> 15/8) and C3 (module spec). |
| P32 | T10 -> T11 | `nftSalesNativeSql` | agree. |
| P33 | T10 -> T12 | `convertedSalePrices(keys)` | CONFLICT C6 (key of the last sale). |
| P34 | T10 -> T13 | `nftSalesNativeSql`, `convertedSalePrices` | agree. |
| P35 | T10 -> T14 | `NFT_LIVE_PERIODS`; sentinel `count` = every sale (Ruling 11) -> `toVolumeRow` | agree on the contract; CONFLICT C9: the sentinel is skipped by `sumParts` and the bucket is built in `volume.service.ts`, which T14 does not list. |
| P36 | T10 <-> T11 (`aggregator.service.ts`) | `volumeBackfill` per-metric version (T10); job registration (T11) | agree, different regions. |
| P37 | T11 -> T12 | `recomputeCollections`, `collectionsBehind` -> `buildNftAggregates` in `test/support/nfts.ts` | NOTE: T12's Consumes omits T11 (the support file needs it); order is fine. |
| P38 | T11 -> T13 | `nft_collections`, `nft_collection_holders` sets | agree; the 404-until-the-job-runs rule matches spec 5.8. |
| P39 | T12 -> T13 | objects, params, readers, `nft.module.ts` controller order | agree (T12 "listed in the order Task 13 pins"). |
| P40 | T12 -> T14 | same, plus `NftModule` provides/exports `NftAccountsService` | agree. |
| P41 | T13 -> T14 | `readNewestPage`, `nftFoldOfRow`, `NFTS_BODY_KEYS` | agree; account `nfts` body = `NFTS_BODY_KEYS`. |
| P42 | T12, T13, T14 (`paged-reads.e2e-spec.ts`, `nft-objects.ts`, `nft-params.ts`, `nft.module.ts`) | successive additions | agree: no function is defined twice (`collectionSortParam` / `STATS_MAX_DAYS` only in T13; `issuerParam`, `taxonParam`, `rolesParam` from T12 reused by T14). |
| P43 | T3, T12, T13, T14 -> T15 | `*_KEYS` constants -> `api-reference.spec.ts` | CONFLICT C9b: T15 maps "an NFT volume component -> its keys" but T14 produces only a TypeScript interface, no runtime constant (and no body-keys constant for `nft_volume`). |
| P44 | T3, T4, T8, T10, T11, T13 (`packages/shared/src/index.ts`) | six append-only export blocks = 15 pairs | agree: no name clashes (`SqlPart`, `SaleKey`, `NewestPage`, `NftKind`, `CollectionKey`, `NftPoint` appear nowhere else in `packages` or `apps`). |

### B. One row per task

| Task | Own text (tests vs code, files, names vs Interfaces) and spec values | Finding |
| --- | --- | --- |
| T1 | Case table, tests, README rows and commit agree with each other; spec values 94166785 / 96724737 / Xahau ledger 1 agree. | CONFLICT C8: Step 1 uses `record:fixtures --want ... --scan 5000` to find conditioned cases, but `--want` keeps only the first successful transaction of each wanted type and stops when every type is found (header of `record-fixtures.ts`, fixtures README); `--ledgers` is a comma list, no ranges. It cannot find `mint_on_behalf`, `burn_removes_offers`, `brokered_sale_royalty`, `sale_issued_currency`, `transfer_zero_amount`, `page_split_with_mint`, `uritoken_buy_above_ask`, ... "Pick the hash from the scratch ledgers" has almost no ledgers to pick from. `SCRATCH=$(mktemp -d)` does not survive between shell calls. |
| T2 | DDL columns, keys, partitions and engines match spec 1.1 / 1.2 (P6 for `nft_sales` and `nft_touches`, P7 for the rest, dedup 1000, `nft_dirty` on `created_at`); Ruling 1 (`actor`) and Ruling 15 (nullable `first_mint_*`) resolve ambiguities of the spec. | CONFLICT C1 (with T7). NOTE: `it('applies 011 again with no change')` duplicates the existing test (b) "a second run applies nothing", and the new dedup test duplicates the updated `DEDUP_TABLES` test; docs sections: see P12. `schema.spec.ts` needs no edit (it reads the schema dir). |
| T3 | Interfaces, rule and tests agree (E, `from <= E`, kinds, cache key, 60 s). Spec 4 / D-env 12 agree: `firstLedger` is `undefined` on BOTH testnets (explicit key on all four profiles), so a no-amendment feature is `complete: false` there; XRPL 32570, Xahau 1. | NOTE: `NetworkProfile.firstLedger` is a required property, so `FOUR` in `network-profile.spec.ts` (typed `Omit<NetworkProfile, 'definitionsFallback'>`) fails to compile until it has `firstLedger` in all four rows; `toMatchObject` needs the key present, which the plan's "explicit value" gives. `packages/shared/src/network/index.ts` needs no change (re-exports `network-profile`). D-env already added `firstCommittedLedger(ch)` to `ingest-state.ts`: reuse it in `coverageFrom` or keep the `ORDER BY ... LIMIT 1` knowingly. C7 for the assumption behind E. `isAvailable` and D-env's `.kind` / `.displayName` are listed as consumed but no D3 task uses them. |
| T4 | Interfaces, rules and the 16 case tests agree; roles, order (Ruling 2), `royalty_est` rules match spec 2.1-2.6; `Math.imul(...) + 2459 >>> 0` is correct precedence. | CONFLICT C5: "before ids are `PreviousFields.NFTokens` of a modified page" - a modified page whose `NFTokens` did not change (a link-only change, the neighbour of a split) has no such field, and all its NFTs would read as minted. Spec has the same wording. NOTE: successful-only (spec 2.5) means an expired offer removed by a failed `NFTokenAcceptOffer` (`tecEXPIRED`) is never seen; check in FINDINGS whether `offer_removed_other` is then only AccountDelete, and what `/offers` shows for such an offer. |
| T5 | Tests and rules agree with spec 2.4; `URITokenBuy` price = tx `Amount`, offer_id = URIToken id. | NOTE: `nft_flags` (entry `Flags`, lsfBurnable) and `uri` for URIToken events are not stated, and `Nft.flags` is always present: rule `nft_flags` = the entry's `Flags`, `uri` on mint like XRPL. |
| T6 | Oracle written from spec, no import of the parser or `nftoken-id.ts`; 6 invariants; 10 mutants. | agree. `xahau/recorded` has real URIToken/Remit transactions, so "a transaction without an NFT node gives nothing" only covers those without nodes; the equivalence test covers the rest. |
| T7 | Rows (5 tables), counts, roles and tests agree with spec 1.1 / 2.6; seeds named as in T1. | CONFLICT C4: `LedgerWriteResult` (`ledger-writer.ts`) is what carries `ammUnclassified` to `live-runner.ts` and `range-ingest.ts`, and is not in the Files; existing asserts break: `toEqual({ ammUnclassified: 0 })` (`build-rows.spec.ts` 1312, 1334, 1361; `ledger-writer.e2e-spec.ts` 731, 785, 786), `expect(PARSER_VERSION).toBe(4)` and the three `.toBe(4)` (`build-rows.spec.ts` 1317-1320), and the snapshots in `ingest/__snapshots__/build-rows.spec.ts.snap` (new empty arrays in every `LedgerRows`, and real NFT rows for Xahau ledger 26540188). |
| T8 | Fold rules, state functions and the `nfts` / `account_nfts` writes agree with spec 3.1 and with T2's columns; names agree with T9's interface. | CONFLICT C6 (`last_sale` has no `tx_index`, `event_index`). `NftRebuildAborted` needs a place in `failed()` (C3). |
| T9 | Budgets, order, gauges, hook agree with spec 3.1, 3.4, 3.5 and with the code order (`volume_*`, `amm_pools`, then `nft_state`). `hooksOfSlice` now returns early without `aggregates`: the plan's Ruling 16 change is needed and is stated. | CONFLICT C3. NOTE: `rates.ledgersClosedIn` takes `(Date, Date)`, the plan writes `(start, end)` in seconds. |
| T10 | SQL, components, `NFT_VOLUME_CONFIG_VERSION`, live periods agree with spec 3.3. `metric` is `LowCardinality(String)` in `volume_daily` / `volume_live`: no DDL change needed. `toString(Decimal)` trailing zeros: the plan pins it with tests (`"1250"`, `"61.25"`). | CONFLICT C2. NOTE: `setRows` writes sentinel `count` 0; the plan's sentinel = every sale needs a new parameter (not stated). |
| T11 | Job rules, batch 50, queue, cadence agree with spec 3.2; the schedule test list is right. | CONFLICT C3 (functions option; abort class). |
| T12 | Keys of NFT / event / sale / offer objects and the three body-key constants equal spec 5.1-5.4 key for key; 404 / 500 messages and check order agree; Ruling 10 (boolean) is a plan decision. | CONFLICT C6 and C7. NOTE: the coverage 60 s cache (`feature-coverage:nfts`) and the 10 s amendments cache hide a `ledgers` row inserted mid-suite: the tests need the `cache-controllers.ts` clear route or a harness per case. |
| T13 | COLLECTION / DAY / HOLDER keys and bodies equal spec 5.7-5.10; 366 days and the 400 message agree; `readNewestPage` SQL is consistent with its description. | NOTE (C14): `/holders` is ordered `held DESC, owner`, not by the table key `(issuer, taxon_key, owner)`; it reads the collection's whole holders prefix per page, which spec 6 does not say (it lists holders under `readNewestPage`'s few granules). State the bound (holders of one collection) in T13 and test it. `CacheService` is a 10,000-entry FIFO: per-issuer keys `nft-collections:<issuer>` are request-driven and can evict the coverage keys. |
| T14 | Sales, account NFTs, account history and `nft_volume` agree with spec 5.5, 5.6, 5.11, 5.12 (error texts, `NFT_LIVE_PERIODS` message). | CONFLICT C9 (`volume.service.ts`, `volume.service.spec.ts` missing; no key constants for the volume component and body). NOTE: `splitAsset` splits at `+`, `|`, `.` only, not at a space: Ruling 8's space must be mapped to `+` before it; `parseAsset` takes `XAH` as native on Xahau, so `currency=XRP` there needs an issuer. |
| T15 | Docs, ADR and commands agree with spec 9; `Amendment 5`, ADR-0016 and item numbering match the code (`ls docs/adr` ends at 0015; ADR-0010 status says "Amended four times", highest heading "Amendment 4"). | CONFLICT C10: `docs/observability.md` section 4 (the metric catalog and the job-label lists of `syncer_aggregator_runs_total` / `errors_total`, also `operations.md` line 33) is not in the Files. NOTE: `operations.md` SQL names the production databases; D-env's convention (sandbox: `xrpl_testnet.` / `xahau_testnet.`) should be used in the new coverage check. The "real answer of the e2e seed" examples have no test (only `d2-example` blocks are checked). `docs/openapi.yaml` was not regenerated by D-env: "no other change" in the diff is unverified. |

### C. Other flags

| # | Flag | Where |
| --- | --- | --- |
| C1 | Registration of the five tables is deferred past the migration: Global says "test:e2e of every package the task touched exit 0" but T2 Step 5 runs only `migrate`; the full shared e2e fails at `ledger-writer.e2e-spec.ts` "schema contract". | T2 / T7 |
| C2 | Adding `nft_volume` to `VOLUME_METRICS` changes 12 live / 6 daily sets to 15 / 8, and `volume.job.ts`'s `componentsOf` switch has no default. Existing asserts: `aggregator.service.spec.ts` 1181, 1208, 1576, 1678, 1721, 1773, 2240, 2293, 2295, 2334 and its expected set labels; `aggregator.module.spec.ts` 102, 103, 132 (also "every live set has config_version 42"); `aggregator.schedule.spec.ts` 456-460 (`Array(12)`, `Array(6)`, `slice(0, 18)`); `aggregator-volumes.e2e-spec.ts` 316. None is in T10's Files; T10 Step 4 expects `aggregator-volumes` to pass unchanged. | T10 |
| C3 | `aggregator.module.spec.ts` `fakeMetrics()` has none of the three new gauges: the first run throws, `aggregatorErrorsTotal.inc` is called, and "not.toHaveBeenCalled" fails (file not in T9's Files). `AggregatorService.failed()` swallows only the listed `*Aborted` classes: `NftRebuildAborted` (T8) and T11's recompute abort would be logged and counted at shutdown. T11 has no `nftCollectionsFunctions` option (T9 adds only `nftStateFunctions`), so its schedule test cannot inject fakes. | T9 / T11 |
| C4 | See T7 row. Also `range-ingest.ts` types its metrics `Pick<PrometheusService, 'ammUnclassifiedTotal'>`. | T7 |
| C5 | See T4 row. | T4 |
| C6 | `convertedSalePrices(keys)` needs `ledger_index:tx_index:event_index`; `NftFold.last_sale` is `NftPoint & {amount, currency, amount_issuer}` with only ledger, hash and time, and the `nfts` row has the same. List routes (`nftFoldOfRow`) therefore cannot show `converted_amount` on `last_sale`; the plan does not say so (spec 5.1 shows it on the detail only). | T8 / T10 / T12 / T13 |
| C7 | `AmendmentView.enabled` is built only when the status is `enabled`, i.e. the amendment id is in the newest `network_state.amendments` (or the name is `retired`) - `assembleAmendments`. With no validators data the NFT amendments are `voting` and `complete` is never true, mainnet metadata or not. T12's "complete once ledger 75443457 / 1 is the first indexed one" needs `insertState(..., amendments: [id])` (`validators-seed.ts`). The T15 live check runs `GH_WORKERS=ingest,aggregator`, so coverage there is `complete: false` for the same reason (no 500; expected). | T3 / T12 / T15 |
| C8 | See T1 row. | T1 |
| C9 | `sumParts` skips the sentinel and `VolumeService.live` / `history` build the bucket, so "row `count` = sentinel" needs `volume.service.ts` (+ `volume.service.spec.ts`) and a field on `VolumeBucket`. C9b: no `NFT_VOLUME_COMPONENT_KEYS` / body keys constant for T15's mapping. | T14 / T15 |
| C10 | See T15 row. | T15 |
| C11 | Global Constraints mandate the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; the session's attribution line is `Claude Sonnet 5.5`. A trailer that names the wrong model is a defect. | Global |
| C12 | `pnpm format` is `prettier --write "{apps,packages}/**/src/**/*.ts"`: the many new files in `packages/shared/test/` and `apps/*/test/` are not formatted by it (the apps have their own `format` that includes `test/`; shared has none). | Global |
| C13 | Xahau `--from 1` (Ruling 3, T15 step 2) stores ledger 1 with `close_time` 0: `volumeBackfill` starts at `utcDayStart(firstClose)` = 1970-01-01, about 19,000 empty closed days per metric (now four metrics); existing behaviour, but the plan makes it the required rollout. Low. | T15 |
| C14 | See T13 row (`/holders` order and read bound; cache keys). | T13 |

Commands and paths: every `pnpm` script named by the plan exists (`build`, `test`, `format`, `ch:migrate`, `record:fixtures`, the three `test:e2e`); `pnpm lint` is correctly avoided (Ruling 20; root script exists but there is no ESLint config). `CLICKHOUSE_HTTP_PORT` / `CLICKHOUSE_NATIVE_PORT` are in `docker-compose.yaml`; `GH_WORKERS`, `GH_SYNC_START_LEDGER` exist; `api:sync` exists in x-explorer. Every path the plan says to modify exists (checked one by one); every path it says to create is free (`apps/api/src/nft`, `docs/adr/0016-*`, `011_*.sql`). Misfits: `packages/shared/src/network/index.ts` (no change needed), data-model section numbers (P12), `docs/observability.md` (missing, C10).

D-env facts the plan has right: four profiles with `family`, `kind`, `displayName`, `acceptedNodeNetworkIds`; `loadAmendmentsConfig(profile, path?)` reads `<family>.json` and drops `enabled` unless the file's `network` equals the profile name (so `xahau-testnet` loses the new `URIToken` ledger 1, as planned); migrations end at 010, `PARSER_VERSION` 4 (`STATE` 3, `PATH` 4, `AMM` 2), ADR 0015, ADR-0010 Amendment 4. D-env facts the plan does not know: `firstCommittedLedger()` in `ingest-state.ts`; `networkOf` exported from `range-ingest.ts` (no use); XRPL `retired` entries keep `enabled` (not NFT amendments); the sandbox runbook convention for SQL database names.

### D. Suggested rulings

1. C1: T2 also registers the five tables in `LEDGER_KEYED_TABLES` (P6/P7/P7/P6/P6) and `CHILD_TABLES`, with the five `LedgerRows` keys filled as `[]`; T7 then only fills them.
2. C2: add the four spec files and `aggregator-volumes.e2e-spec.ts` to T10's Files; counts 12 -> 15 live, 6 -> 8 daily; the "config_version 42" check applies to the non-NFT metrics.
3. C3: T9 adds `NftRebuildAborted` to `failed()` and the three gauges to `fakeMetrics()` (`aggregator.module.spec.ts` in Files); T11 adds `nftCollectionsFunctions?: Partial<NftCollectionsFunctions>` and uses the same abort class.
4. C4: add `ledger-writer.ts` (`LedgerWriteResult.nftSkipped`), the snapshot file and the listed asserts to T7; review the snapshot diff (only empty arrays plus real NFT rows for Xahau ledger 26540188).
5. C5: before ids = `PreviousFields.NFTokens` if present, else the node's own `FinalFields.NFTokens` (modified and deleted pages); add a synthetic link-only-change test.
6. C6: add `tx_index` and `event_index` to `NftFold.last_sale` (in memory only); list routes show no `converted_amount` on `last_sale`, said in T13.
7. C7: T12 seeds `network_state` with the amendment id and clears the caches between the coverage tests; T15 says the live check needs the `validators` worker for `complete: true`.
8. C8: T1 scans with a throwaway script over `ledger` (`transactions`, `expand`) for the conditions, then records with `--txs`; `--want` only to confirm a type exists.
9. C9: T14 Files gain `volume.service.ts` (+spec); `VolumeBucket` gets the sentinel count; T14 exports `NFT_VOLUME_COMPONENT_KEYS` and `NFT_VOLUME_BODY_KEYS` for T15.
10. C10: T15 Files gain `docs/observability.md` (and the job lists in `operations.md` line 33); T2's data-model sections follow P12.
11. C11: use the attribution trailer the controller gives.
12. T3: add `firstLedger` to the four rows of `FOUR`; reuse `firstCommittedLedger`; drop `network/index.ts` from the Files.
13. T5: `nft_flags` = the entry's `Flags`.
14. C14: T13 states and tests the holders bound; cap per-issuer cache keys or skip the cache for a filtered list.

Worktree note at scan time: 10 tracked files were modified and uncommitted, none by this scan (comments in `api.config.ts`, `syncer.config.ts` and `account-flags.ts`; `fixXahauTestnetGenesis` marked `obsolete` in `xahau.json`; additions to `amendment-status.spec.ts` and `live-runner.e2e-spec.ts`; ADR-0012, `development.md` and `operations.md` wording). None changes a finding above. Rows in this scan: 59 (44 pair rows, P44 standing for 15 pairs; 15 task rows).

## Pre-flight rulings (controller)
Ruling: C1 (T2/T7) T2 also registers the 5 new dedup tables in LEDGER_KEYED_TABLES, CHILD_TABLES and LedgerRows (as []) so ledger-writer.e2e's schema contract holds under T2's full test:e2e — cost if wrong: none.
Ruling: C2 (T10) nft_volume moves the live/daily volume sets 12/6 -> 15/8; T10's Files gain aggregator.service.spec, aggregator.module.spec, the schedule spec and the aggregator-volumes e2e asserts — cost if wrong: none.
Ruling: C3 (T9/T11) fix all three: fakeMetrics() gains the 3 NFT gauges, failed() swallows NftRebuildAborted, and an nftCollectionsFunctions option exists as the tasks need — cost if wrong: none.
Ruling: C4 (T7) T7's Files gain ledger-writer.ts (LedgerWriteResult), the build-rows snapshot, and the literal-4 / {ammUnclassified:0} asserts — cost if wrong: none.
Ruling: C5 (T4) modified NFTokenPages whose PreviousFields lack NFTokens (link-only changes) take the before-ids from FinalFields, so they are not read as mints — cost if wrong: a parser edge; pinned by a test.
Ruling: C6 (T8/T10/T12) NftFold.last_sale carries tx_index and event_index so convertedSalePrices can join — cost if wrong: none.
Ruling: C7 (T12) tests seed the amendment into network_state (enabled exists only if listed there) and clear the coverage cache — cost if wrong: none.
Ruling: C8 (T1) find the conditioned cases with a throwaway scan script (not committed), then record them with record:fixtures --txs — cost if wrong: none.
Ruling: C9 (T14/T15) T14's Files gain VolumeService (sentinel count); T15 adds NFT volume key constants for its mapping — cost if wrong: none.
Ruling: C10 (T15) create the missing docs/observability.md section/file references the plan names or point to where metrics are documented; fix the data-model §3/§5 references — cost if wrong: docs only.
Ruling: C11 trailer stays 'Co-Authored-By: Claude Opus 5.5' (session ruling) — cost if wrong: attribution.
Task 1: dispatched implementer (sonnet) BASE 5294876 (after D-env fix wave), with ruling C8
Task 1: implementer BLOCKED before commit — the harness refused its Write of FINDINGS.md ('Subagents should return findings as text, not write report files'); it returned both texts. OWNER approved (2026-10-26): the controller wrote both FINDINGS.md verbatim; implementer resumed to test and commit.
Ruling: from now on implementers return their full report as text (subagent report files are blocked by the harness); the controller saves it as task-N-report.md — cost if wrong: none (bookkeeping).
Task 1: implementer DONE_WITH_CONCERNS a82875a (nft-fixtures 53/53; shared unit 1736; build ok). Review dispatched (sonnet).
