# ADR-0016: NFT and URIToken data: events from page and entry diffs, state folded from history, one coverage rule

**Status:** Accepted. Amends [ADR-0010](0010-ripple-v2-wire-compatibility.md#amendment-5-2026-10-24-nfts-and-uritokens) (Amendment 5, items 73 to 78). Builds on
[ADR-0007](0007-ledger-index-axis-and-secondary-tables.md) (the ledger axis, full copies), [ADR-0008](0008-no-aggregate-materialized-views.md),
[ADR-0013](0013-account-and-market-aggregates.md) (version sets, self-contained runners) and
[ADR-0015](0015-historical-account-state-from-clickhouse.md) (state from history). The design is in
[the NFT spec](../superpowers/specs/2026-10-17-nft-data-design.md), program 2 sub-project D3.

## Context
The explorer's NFT boards (the list of collections, a collection, one NFT, an account's NFTs, search) need, on both networks, every event of an
NFT, its current owner, what an account holds, the collections with their supply and holders, the sales with prices, and the network's NFT
sales volume. Two facts of the ledgers make that more than a table per object:

- An **XRPL NFToken** is not a ledger entry: it is an element of the `NFTokens` array of an `NFTokenPage` entry, pages split and merge, the owner is
  in the first 20 bytes of the page's key, and the ledger stream's metadata carries no NFT id (the `tx` command adds `nftoken_id`). A
  **Xahau URIToken** is an entry, whose id is a hash of its issuer and URI, so the same issuer and URI give the same id again after a burn.
- A price is an amount in any currency, and a volume or a collection's worth needs one currency.

And the history cannot be assumed whole: NFTs are indexed from the first ledger a parser that knows them wrote, so every list has to say how
much of the past it holds.

## Decision
1. **Events come from diffs, with one parser for both networks.** `NftParser` (`packages/shared/src/parsers/nft.parser.ts`) acts on the
   `NFTokenPage` and `NFTokenOffer` nodes of a transaction's metadata or on its `URIToken` nodes, so it needs no network. On XRPL the ids are
   compared over the **union of all the page nodes** of the transaction, never page by page (a split or merge moves ids between pages and is no
   event); the owner comes from the page key; taxon, serial, flags and transfer fee are decoded from the id. Sales are told from the accepted
   offers (direct, and brokered with the broker's cut and an estimated royalty); on Xahau from the `URIToken` diffs and the transaction type (a
   `URITokenBuy` price is the transaction's `Amount`, not the offer's; `Remit` moves and mints). An amount that is an MPT amount skips its event
   and counts it (`syncer_nft_skipped_total`).
2. **Five ledger tables, full copies.** Migration 011 adds `nft_events` (by NFT), `account_nft_events` and `collection_nft_events` (full copies,
   one per account involved and one per collection: [ADR-0007](0007-ledger-index-axis-and-secondary-tables.md)), `nft_sales` (the sales in
   ledger order) and the narrow `nft_touches` (which NFTs a transaction had an event of, in ledger order, what the aggregator scans). They are in
   `CHILD_TABLES` and `LEDGER_KEYED_TABLES`; **parser version 5** (`NFT_PARSER_VERSION`, a gate constant of its own: gates compare with it, never
   with `PARSER_VERSION`) writes them, and a ledger written by an older parser has no rows in them until it is ingested again.
3. **State is folded from the history** ([ADR-0015](0015-historical-account-state-from-clickhouse.md)'s approach). `foldNftEvents` is one pure
   function over an NFT's events, used by the `nft_state` job, which rebuilds the `nfts` row and the `account_nfts` rows (one per owner an NFT
   ever had, `held` 1 for the current one) of the NFTs touched since its cursor, and by the API's detail route, which folds the NFT's own
   events **at read time**, so a detail is fresh at the commit of its ledger. `nfts` serves the lists of a collection and of an account only.
4. **Aggregates are version sets** (`ReplacingMergeTree(version)`, no `FINAL`: [ADR-0003](0003-no-final-on-list-queries.md),
   [ADR-0008](0008-no-aggregate-materialized-views.md)), four tables (`nfts`, `account_nfts`, `nft_collections`, `nft_collection_holders`), in
   neither `CHILD_TABLES` nor `LEDGER_KEYED_TABLES`, so ingest recovery never deletes from them. A **re-ingest** reaches them through `nft_dirty`:
   the `agg_dirty` hook of `nft_state` appends the slice's ledger range (it rebuilds nothing), and the job works through the oldest range under
   its budget, in steps of 10,000 ledgers, resumably. The collections are recomputed by a second job, `nft_collections`.
5. **Collection stats are a query, not a job.** `GET /v2/nft_collections/{c}/stats` groups the events of one collection's prefix by UTC day over a
   window of at most 366 days. A daily statistics job (holders or supply over time) is deferred.
6. **A price is converted once.** `nftSalesNativeSql` is the one conversion of a sale's price into the native currency, at the rate of the sale's
   UTC day (D2's `DailyRates`: the day's `native_rates_daily` set, else computed on read; a native price is itself; with no rate there is no
   converted value). The collections job, the `nft_volume` metric, the stats and every `converted_amount` use it, so a collection's volume is
   the same everywhere. `nft_volume` joins the volume jobs (live periods `day`, `7day`, `30day`, a component per collection) with a config
   version of its own, so a markets-config change does not recompute it.
7. **The program's coverage rule, with one implementation.** Every answer derived from the NFT history carries
   `"coverage": { "from_ledger_index": N, "complete": bool }`, the key right after `result` (not in the CSV). `FeatureCoverageService` is its one
   implementation: features are registered by name with the parser version that writes them and where they start (`COVERAGE_FEATURES`), and
   later features add entries and define no rule of their own. `from_ledger_index` is one above the newest stored ledger that an older parser
   wrote; `complete` is `from_ledger_index` at or below the feature's start: the **enable ledger of its amendment**, read from the amendments data
   and never a constant in code (`NonFungibleTokensV1_1` on XRPL, `URIToken` on Xahau, where it is ledger 1, the genesis), or, for a feature as
   old as the network, `NetworkProfile.firstLedger` (XRPL 32,570, Xahau 1, none on the testnets); a feature a network cannot have is
   `complete: true`. The testnets ignore the metadata file's enable ledgers. The detail, history and offers of one NFT state their own: complete
   when its mint is indexed. A failed read of the coverage fails the route.
8. **No node fallback.** An NFT the index does not have is `nft not found`; the API reads no node for NFTs. A fallback is the explorer's.

## Consequences
- The explorer's boards are served by key-ordered prefix reads (an NFT, an account, a collection, a ledger range of sales), each bounded by
  `read_rows` tests, and the detail is as fresh as the commit. One function folds an NFT, one SQL converts a price, one service says what is
  covered.
- **The history needs a reprocess.** Complete coverage means every ledger from the enable ledger written by parser version 5: on XRPL from ledger
  75,443,457, on Xahau from ledger 1. It is one `range-ingest --reprocess` of each network, best done once with the program's other parser
  versions ([backfill](../backfill.md#nft-re-ingest)). The testnets are not backfilled and stay `complete: false`.
- **Storage.** An event is stored in up to four tables (by NFT, by collection, once for each account it involves, a sale again in ledger order):
  a brokered sale is up to seven rows (`nft_events` 1, `collection_nft_events` 1, `account_nft_events` 4 for the issuer, the seller, the buyer and
  the broker, `nft_sales` 1). The aggregates are version sets that grow until merged.
- **The aggregates lag the ledgers**: holdings by up to a tick, collections and holders by up to five minutes (and, after a rollout, until the
  first fill of `nft_collections` has drained: first in first out, one 3 s run every five minutes, about 150 collections for XRPL's large ones). A collection's `volume_native` uses the
  rates known at its last recompute; the daily `nft_volume` sets are the settled figures. A fresh collection is 404 on its own routes until its
  first recompute.
- **The cursor of `nft_state` is in memory and placed at each start** from the tables, without a table of its own: a cursor read from a database
  with no ledger goes to the ledger before the first one stored, and one more than 10,000 ledgers behind the head (a restart while a re-ingest
  is digested) hands the ledgers after it to `nft_dirty` and starts at the head, so the dirty sweep, not the live path, carries that backlog. Each
  such restart hands the stretch over once more ([operations](../operations.md#the-nft-data)); persisting the cursor would avoid that, at the cost
  of a table and a migration.
- **Decisions owed to the owner before the backfill.** These rulings of the build follow the spec's letter; changing one after the NFT history is
  filled needs a reprocess of the NFT ledgers, before it a small change of the parser and its oracle:
  1. An offer consumed by any `NFTokenAcceptOffer` is `removed_by: sale`, a zero-amount accept (a `transfer`, no sale) included; `transfer`, as
     for a Xahau `Remit`, is the alternative.
  2. A `modify` has no roles (spec §2.6: the issuer only on a mint, a burn or a sale), so it is in no account's NFT history; the owner, or the
     issuer, could be given a role in it.
  3. An `NFTokenAcceptOffer` priced with an MPT amount (impossible in the ledger today) skips its `offer_removed` and its `sale` and counts them
     (`syncer_nft_skipped_total`); no `transfer` takes the sale's place, so the stored owner would not follow such a sale.
  4. A Xahau `URITokenBuy` at an `Amount` of 0 is a `sale` at 0 (spec §2.4), counted in `sales_count`; on XRPL a zero-amount accept is a
     `transfer`.
- **A failed transaction is read for the offers it deletes.** A `tec` transaction changes nothing of its own, but rippled deletes the expired
  offers a failed `NFTokenAcceptOffer` met (`tecEXPIRED`); the parser reads each `NFTokenOffer` a failed transaction deletes as an
  `offer_removed` with `removed_by: other`, and nothing else of it, so `/offers` does not list a deleted offer.
- Rejected: one version set per owner (a holder of 120,000 NFTs would rewrite them all when one moves); a daily statistics job now; reading the
  node's `account_nfts`.
