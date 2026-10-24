# NFTs and URITokens: design

Date: 2026-10-17, revised 2026-10-24. Status: revised (2026-10-24), program 2, sub-project D3. Family 2 of `2026-10-17-amendments-roadmap.md`,
whose shared rules stay binding where this page does not say otherwise. Built on PR #20 (`feat/account-investigation-data`): its parser
versions, migrations and state tables are the baseline here.

- **Boards** (x-explorer `docs/superpowers/specs/2026-10-24-explorer-mock/`): `Nfts.dc.html`, `NftCollection.dc.html`, `Nft.dc.html`.
- **Explorer side:** x-explorer `docs/superpowers/specs/2026-10-24-nft-pages-design.md` (E8), and the program page
  `2026-10-24-explorer-program-2-overview.md` there.
- **Related here:** the plan `../plans/2026-10-17-nft-data.md` (written for the first version; the plan of this revision replaces it),
  ADR-0007 (ledger axis), ADR-0008 (no aggregate views), ADR-0010 (wire contract), ADR-0011 (the AMM pattern this follows), ADR-0015
  (state from history), `2026-10-17-xahau-native-design.md` (relies on the URIToken events, section 2.4).

## Owner decisions to confirm

The choices this revision made, and every change from the 2026-10-17 version. Each is built as written unless the owner says otherwise.

| # | Choice | Why / recommendation |
|---|---|---|
| 1 | **Changed:** a new parser version with its own gate constant `NFT_PARSER_VERSION`; the tables come in the next migration, not in the baseline. | Version 3 and migrations 005–010 are PR #20's, and the baseline is deployed. The plan assigns the numbers. |
| 2 | **New:** every list and aggregate answer carries `coverage {from_ledger_index, complete}`; the NFT detail, history and offers carry the NFT's own (complete when its mint is indexed) (section 4). | The brief's shape. Per NFT, a token minted after the coverage start has its whole life in the index. |
| 3 | **Changed:** `nft_daily` and its job are dropped. `/nft_collections/{c}/stats` is a query-time aggregate over the collection's events, at most 366 days (section 5.10). | The brief defers history charts that need a new daily statistics job; one collection's 30 days is a cheap prefix read. |
| 4 | **Kept, narrowed:** `nft_volume` is a metric of the existing volume jobs, with the live periods `day`, `7day` and `30day` only (the board's), one component per collection, in the native currency. | No new job; the board's chart and tiles read it. Three live sets, not five. |
| 5 | **New:** a narrow ledger table `nft_touches` (ledger order) feeds the aggregator, as `amm_pool_touches` does. | The jobs need "which NFTs changed in these ledgers" without scanning the wide tables. |
| 6 | **Changed:** `account_nfts` holds one row per (owner, NFT) with `held`, rewritten per NFT, not one version set per owner. | A 120k-NFT owner no longer rewrites 120k rows when one NFT moves. |
| 7 | **Changed:** the NFT detail is folded at read time from the NFT's own events, not read from the `nfts` table. | Fresh at commit time like the AMM history; `nfts` serves the collection and holdings lists only. |
| 8 | **New:** `nft_collection_holders` and `GET /v2/nft_collections/{c}/holders`. | The brief asks for a collection Holders tab (the board has a Holders count only). Recommend: build it; it is written by the collections job at no extra read. |
| 9 | Collection routes: XRPL takes `{issuer}/{taxon}`, Xahau `{issuer}`; the other form answers 404 `collection not found`. Literal sub-routes are registered before the taxon form. | One key per network; a taxon is digits, so `nfts`, `holders`, `sales` and `stats` can never be read as one. |
| 10 | **Changed:** `/v2/nft_collections` gains `descending` and `total` (the collections the filter matches); sort `volume`, `supply`, `holders`. | The board sorts both ways and says "of 38,511 collections". |
| 11 | **Changed:** `/v2/nft_sales` filters by `currency=CUR[+issuer]` (the payments form), not `currency` + `issuer`. | `issuer` means the NFT's issuer everywhere else in these objects. |
| 12 | **Corrected:** the royalty estimate of a brokered sale is the fee on the price less the broker fee (rippled `NFTokenAcceptOffer::acceptOffer`); none when the issuer is the seller or the buyer. | The 2026-10-17 text took it on the whole price. |
| 13 | **Corrected:** a `URITokenBuy`'s price is the transaction's `Amount` (what the seller receives, xahaud `URIToken.cpp`), not the offer's. | The buyer may pay more than asked. |
| 14 | Prices stay in their own currency; `converted_amount` (native) is added where the asset has a daily native rate (`DailyRates`, D2's data). A sale without a rate counts in sales, not in volume. | "Conversion only if existing rate data supports it." |
| 15 | The node fallback for an NFT the index does not have belongs to the explorer; this API answers `nft not found` and reads no node. | As for transactions and AMM pools: the API serves the index. |
| 16 | `event` filters take a comma list; account roles are `issuer`, `minter`, `from`, `to`, `broker`, `offer_owner`, `destination`. | The board's "Show offer events" is one call; the roles name what the events record. |
| 17 | Coverage ignores gaps in the stored ledgers, as the state history's does. | Gaps are an operational fault with their own checks (`operations.md`). |
| 18 | Xahau's amendment metadata file gets `URIToken`'s enable ledger (the network's first ledger); without a known enable ledger `complete` is always false. | Xahau enabled URITokens at genesis, so no `EnableAmendment` exists to read. |
| 19 | A URIToken burned and minted again by the same issuer with the same URI is the same id (xahaud keys it on issuer and URI): its state follows the newest events. | New fact, found in xahaud's `URIToken.cpp`. |
| 20 | **New (consistency pass):** the coverage service is the program's one rule (section 4): a feature without an amendment starts at `NetworkProfile.firstLedger` (new: XRPL 32,570, Xahau genesis, none on the testnets), a feature the network cannot have is `complete: true`, enable ledgers come only from the amendments data (testnets: `complete: false` without an indexed `EnableAmendment`), and `coverage` is the key after `result` on every new endpoint. | D5, D6, D7 and D9 need these cases; D3 builds the service first, so it defines them once. |

## Goal

Ingest, store and serve XRPL NFTokens (amendments NonFungibleTokensV1_1, NFTokenMintOffer, DynamicNFT) and Xahau URITokens (URIToken, and
`Remit`): every event, the current owner of every NFT, holdings, collections with supply and holders, sales with prices, and the network's
NFT sales volume, so that the explorer's three NFT boards, its account NFTs tab and its search are served.

## Scope and non-goals

In scope, on both networks: the events (mint, burn, modify, offer create, cancel and removal, sale, transfer), lists per NFT, per account,
per collection and for the network; current state per NFT, holdings, collections, holders; the network's NFT volume (live and daily); a
collection's per-day stats over a window; coverage on every list and aggregate.

Not in scope: fetching or resolving URIs (IPFS, metadata, images, names); floor prices from open offers; rarity; reading the node (the
explorer's fallback, decision 15); NFT volume per currency; a new daily statistics job (decision 3); MPT-priced NFT offers (the ledger has
none; one would be skipped and counted).

## How it looks on the ledger

Checked in `packages/shared/test/fixtures/{xrpl,xahau}/recorded` and in the sources named; the plan's first task re-checks each on the
recordings it adds and writes `FINDINGS.md`.

**XRPL NFTokens**
- **No NFT ids in the `ledger` metadata.** The ledger stream's metadata has no `nftoken_id` / `offer_id` (those are added by `tx` only). Ids
  come from `NFTokenPage` diffs: a page's `NFTokens` lists `{NFToken: {NFTokenID, URI?}}`. Previous arrays are in `PreviousFields`
  (modified), final ones in `FinalFields` / `NewFields`, a deleted page's in `FinalFields`. Pages split and merge, so ids are compared over
  the union of all page nodes of the transaction, never page by page.
- **The page key names the owner:** the first 20 bytes of an `NFTokenPage` `LedgerIndex` are the owner's AccountID.
- **The id encodes the NFT:** `Flags (2) | TransferFee (2) | Issuer (20) | scrambled Taxon (4) | Sequence (4)`. The sequence is the
  **serial**; `taxon = scrambled XOR ((384160001 × serial + 2459) mod 2^32)`. Flags: `lsfBurnable` 0x0001, `lsfOnlyXRP` 0x0002,
  `lsfTrustLine` 0x0004, `lsfTransferable` 0x0008, `lsfMutable` 0x0010. `TransferFee` is in 1/100000 (`5000` = 5%).
- **Offers** are `NFTokenOffer` entries (`Owner`, `NFTokenID`, `Amount`, `Destination?`, `Expiration?`, `Flags` with `lsfSellNFToken` = 1);
  an accepted, cancelled, expired-and-removed or burned-with offer is a `DeletedNode` with these fields.
- **Sales.** `NFTokenAcceptOffer` with one offer (direct): the price is that offer's `Amount`, the seller its owner (a sell offer) or the
  previous NFT owner (a buy offer). With both (brokered): the price is the buy offer's `Amount`, the seller the sell offer's owner, the buyer
  the buy offer's owner, the broker the transaction's `Account`, `NFTokenBrokerFee` the broker's cut. The issuer's cut is `TransferFee` of
  the amount left after the broker's cut (all of it in direct mode), and only when the issuer is neither seller nor buyer (rippled
  `src/libxrpl/tx/transactors/nft/NFTokenAcceptOffer.cpp`, `acceptOffer` and the bridged branch). An accepted offer of zero moves the NFT
  without a price: a **transfer**.
- **Minting.** `NFTokenMint` may carry `Issuer` (an authorized minter mints for the issuer) and, since NFTokenMintOffer (ledger 94166785),
  `Amount`, `Destination`, `Expiration`: a sell offer created in the same transaction. `NFTokenModify` (DynamicNFT, ledger 96724737) changes
  the `URI` of an NFT with `lsfMutable`. A burn may delete the NFT's offers in the same transaction.

**Xahau URITokens**
- **The entry** `URIToken`: `Owner`, `Issuer`, `URI`, `Digest?`, `Flags` (`lsfBurnable` 0x0001), and the one sell offer as `Amount?` and
  `Destination?`. Its id is its `LedgerIndex`, a hash of the issuer and the URI: the id encodes nothing else, and the same issuer and URI give
  the same id again after a burn (decision 19).
- **Effects** (xahaud `src/xrpld/app/tx/detail/URIToken.cpp`): `URITokenMint` creates it (`Issuer` = `Owner` = the sender), with a sell
  offer when it carries `Amount` (and `Destination`); `URITokenBurn` deletes it; `URITokenCreateSellOffer` sets `Amount` (`Destination`);
  `URITokenCancelSellOffer` clears them; `URITokenBuy` sends the transaction's `Amount` (at least the asked amount) to the owner, clears the
  offer and sets `Owner` to the buyer. `Remit` moves URITokens (`URITokenIDs`) and can mint one (`MintURIToken`) for the destination.

**Enablement ledgers relied on** (`packages/shared/config/amendments/*.json`): XRPL NonFungibleTokensV1_1 75443457 (2022-10-31),
fixNFTokenRemint 84206081, NFTokenMintOffer 94166785, DynamicNFT 96724737; Xahau URIToken at genesis (decision 18: the file gains the
ledger, which the plan reads from the node). The coverage reads the first of each network's two (section 4).

## 1. Storage

All new tables are in one new migration (the next number; additive, `CREATE TABLE IF NOT EXISTS`, the runner's semicolon rule). `kind` is
`Enum8('nftoken' = 1, 'uritoken' = 2)`; `event` is `Enum8('mint' = 1, 'burn' = 2, 'modify' = 3, 'offer_create' = 4, 'offer_cancel' = 5,
'offer_removed' = 6, 'sale' = 7, 'transfer' = 8)`. Ids are 64 upper-case hex digits. `taxon_key` is the taxon on XRPL and 0 on Xahau;
`serial` is the id's sequence on XRPL and 0 on Xahau. An absent string is `''`, an absent number `NULL`. Amounts are exact decimal text in
whole units with an `_f` shadow where SQL sums or compares them; the native currency has `currency` `XRP`/`XAH` and `amount_issuer` `''`.

### 1.1 Ledger tables

Written by ingest through `LedgerWriter`, in `CHILD_TABLES` and `LEDGER_KEYED_TABLES`, with `non_replicated_deduplication_window = 1000`,
deleted by recovery and `--reprocess` partition by partition.

```sql
CREATE TABLE IF NOT EXISTS nft_events
(
  nft_id        String,
  ledger_index  UInt32,
  tx_index      UInt32,
  event_index   UInt16,                  -- the event's place in its transaction (section 2.5)
  tx_hash       String,
  tx_type       LowCardinality(String),
  close_time    DateTime('UTC'),
  kind          Enum8('nftoken' = 1, 'uritoken' = 2),
  event         Enum8('mint' = 1, 'burn' = 2, 'modify' = 3, 'offer_create' = 4, 'offer_cancel' = 5,
                      'offer_removed' = 6, 'sale' = 7, 'transfer' = 8),
  issuer        String,
  taxon         Nullable(UInt32),
  taxon_key     UInt32,
  serial        UInt32,
  nft_flags     UInt32,
  transfer_fee  UInt16,
  uri           String,                  -- hex as on the ledger: the new URI of a mint or modify, else ''
  digest        String,                  -- URITokens
  account       String,                  -- who did it: the offer's owner for an offer event, else the sender
  from_account  String,                  -- the owner before (burn, sale, transfer)
  to_account    String,                  -- the owner after (mint, sale, transfer)
  offer_id      String,                  -- the NFTokenOffer's LedgerIndex; on Xahau the URIToken id
  is_sell_offer UInt8,
  amount        String,                  -- the offer's amount, or the sale's price
  amount_f      Float64,
  currency      LowCardinality(String),
  amount_issuer String,
  destination   String,
  expiration    Nullable(DateTime('UTC')),
  broker        String,
  broker_fee    String,
  royalty_est   String,
  removed_by    LowCardinality(String)   -- offer_removed: 'sale', 'burn', 'transfer' or 'other'
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (nft_id, ledger_index, tx_index, event_index)
SETTINGS non_replicated_deduplication_window = 1000;
```

| Table | Partition | ORDER BY | Holds |
|---|---|---|---|
| `nft_events` | P7 | `(nft_id, ledger_index, tx_index, event_index)` | Every event, the columns above. Read by an NFT's detail, history and offers. |
| `account_nft_events` | P7 | `(account, ledger_index, tx_index, event_index)` | A full copy of each event per account it involves, plus `roles Array(LowCardinality(String))` (section 2.6). An account with two roles in an event has one row. |
| `collection_nft_events` | P7 | `(issuer, taxon_key, ledger_index, tx_index, event_index)` | A full copy of every event, by collection. Read by the collection's sales and stats and by the collections job. |
| `nft_sales` | P6 | `(ledger_index, tx_index, event_index)` | A full copy of the `sale` events, in ledger order: the network's sales list and the volume metric. |
| `nft_touches` | P6 | `(ledger_index, tx_index, nft_id)` | Narrow: `ledger_index`, `tx_index`, `nft_id`, `issuer`, `taxon_key`, `serial`; one row per NFT a transaction had an event of. The aggregator's watermark and dirty scans. |

Full copies, not narrow keys into `nft_events`: that table is ordered by NFT, so keys of a list would land in scattered granules, as
`account_exchanges` and `account_amm_liquidity` are copies for the same reason (ADR-0007).

### 1.2 Aggregate tables

Written by the aggregator only, `ReplacingMergeTree(version)`, no partition, not ledger tables (recovery never deletes from them; a re-ingest
reaches them through `agg_dirty`, section 3.4). `version` is the ClickHouse clock in milliseconds, above the key's newest. **Readers keep
the newest version of each key without `FINAL`** (`ORDER BY <key>, version DESC LIMIT 1 BY <key>`), and filter what a key can lose
between versions (`burned`, `held`) after that, as `amm_pools` readers do.

```sql
CREATE TABLE IF NOT EXISTS nfts
(
  issuer String, taxon_key UInt32, serial UInt32, nft_id String,
  kind Enum8('nftoken' = 1, 'uritoken' = 2), taxon Nullable(UInt32), nft_flags UInt32, transfer_fee UInt16,
  owner String,                                         -- '' when burned, or when no indexed event names it
  owner_ledger Nullable(UInt32), owner_tx String, owner_time Nullable(DateTime('UTC')),
  uri String, digest String,
  minted_ledger Nullable(UInt32), minted_tx String, minted_time Nullable(DateTime('UTC')), minted_by String, minted_to String,
  burned UInt8, burned_ledger Nullable(UInt32), burned_tx String, burned_time Nullable(DateTime('UTC')), burned_by String,
  sale_count UInt32,
  last_sale_ledger Nullable(UInt32), last_sale_tx String, last_sale_time Nullable(DateTime('UTC')),
  last_sale_amount String, last_sale_currency LowCardinality(String), last_sale_amount_issuer String,
  first_ledger UInt32, last_ledger UInt32,             -- the oldest and newest indexed event the row has seen
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (issuer, taxon_key, serial, nft_id);
```

| Table | ORDER BY | Holds |
|---|---|---|
| `nfts` | `(issuer, taxon_key, serial, nft_id)` | The state of every NFT with an indexed event (above). A collection is a prefix, ordered by serial on XRPL. |
| `account_nfts` | `(owner, issuer, taxon_key, serial, nft_id)` | `held UInt8` and `version`: one row for every account an NFT ever had as owner in the index, `held = 1` for the current one. A holding is the newest row of a key with `held = 1`; holdings are grouped by collection. |
| `nft_collections` | `(issuer, taxon_key)` | `kind`, `taxon Nullable(UInt32)`, `supply`, `holders`, `minted`, `burned`, `sales_count` (`UInt64`), `volume_native` (exact text) and `volume_native_f`, `first_mint_ledger`, `first_mint_tx`, `first_mint_time`, `last_mint_*` (nullable), `last_ledger`, `version`. |
| `nft_collection_holders` | `(issuer, taxon_key, owner)` | `held UInt32`, `version`. Each recompute of a collection writes every current holder and a `held = 0` row for each holder of its newest set that is gone; a reader keeps the newest row per owner with `held > 0`. Written before the collection's `nft_collections` row. |

Plus one internal table, `nft_dirty` (`from_ledger UInt32, to_ledger UInt32, created_at DateTime64(3)`, `ReplacingMergeTree(created_at)`,
`ORDER BY (from_ledger, to_ledger)`): ledger ranges whose NFTs must be rebuilt, as `agg_dirty` is for hours (section 3.4).

`supply` counts the collection's NFTs in `nfts` that are not burned (an NFT first seen after its mint counts); `minted` and `burned` count
the indexed mint and burn events; with complete coverage `supply = minted − burned`. `holders` counts the distinct non-empty owners of
those NFTs. `sales_count` counts every sale, `volume_native` the converted price of the sales with a rate (section 3.3).

## 2. Parsing

One pure parser, `packages/shared/src/parsers/nft.parser.ts` (`NftParser.parse(t, ctx): { events: ParsedNftEvent[]; skipped: number }`),
and `packages/shared/src/util/nftoken-id.ts` (`decodeNFTokenId(id)`: flags, transfer fee, issuer, taxon, serial; `pageOwner(index)`). It
runs on successful transactions only, takes deep-frozen input, and is wired into `buildLedgerRows` with the five tables. A new parser version
(`NFT_PARSER_VERSION` in `rows.ts`, the first version that writes them; gates compare with it, never with `PARSER_VERSION`). A ledger written
by an older version has no NFT rows.

### 2.1 XRPL ids and owners (from `NFTokenPage` diffs, over the union of the transaction's pages)

| Before → after | Event |
|---|---|
| absent → on a page of owner O | `mint`, `to_account` O, `account` the sender (`minted_by`); issuer, taxon, serial, flags, fee from the id |
| on owner A → absent | `burn`, `from_account` A, `account` the sender (the issuer burning a burnable NFT, or A) |
| owner A → owner B ≠ A | `sale` when an accepted offer with a non-zero amount moved it, else `transfer` |
| same owner, different `URI` | `modify`, the new `uri` |
| same owner and URI, another page | nothing (a split or merge) |

### 2.2 XRPL offers
- A created `NFTokenOffer` is `offer_create` (`offer_id` its index, `account` its `Owner`, amount, destination, expiration), including the one
  an `NFTokenMint` makes.
- A deleted one is `offer_cancel` in an `NFTokenCancelOffer`; `offer_removed` otherwise, with `removed_by` `sale` (an
  `NFTokenAcceptOffer`), `burn` (an `NFTokenBurn`) or `other` (removed by another transaction, such as an expired offer cleaned up).

### 2.3 XRPL sales
- Direct: price the accepted offer's `Amount`; seller and buyer as in "How it looks". Brokered: the buy offer's `Amount`, the broker the
  sender, `broker_fee` the `NFTokenBrokerFee`.
- `royalty_est` = (price − broker fee) × `TransferFee` / 100000, rounded to the currency's precision (native: drops, down), only when the fee
  is not 0 and the issuer is neither seller nor buyer; `''` otherwise. It is an estimate: the issuer's balance change is the fact, and the
  golden tests compare the two on every recorded sale.

### 2.4 URITokens (from `URIToken` diffs and the transaction type)

| Diff | Event |
|---|---|
| created | `mint` (`to_account` the `Owner`, `account` the sender), then `offer_create` when it has `Amount` (`Remit`'s `MintURIToken` too) |
| deleted | `offer_removed` (`removed_by` `burn`) when it had `Amount`, then `burn` (`from_account` the `Owner`) |
| `Owner` changed in a `URITokenBuy` | `offer_removed` (`removed_by` `sale`), then `sale`: price the transaction's `Amount`, seller the previous `Owner`, buyer the sender |
| `Owner` changed otherwise (`Remit`) | `transfer`, and `offer_removed` (`removed_by` `transfer`) when `Amount` was cleared with it |
| `Amount` set or changed, same owner | `offer_create` (`offer_id` the URIToken id, `is_sell_offer` 1, `destination`) |
| `Amount` cleared, same owner | `offer_cancel` |

URITokens have no taxon, serial or transfer fee (`royalty_est` `''`); `issuer` is the entry's `Issuer`.

### 2.5 Event order, amounts, skips
- `event_index` counts the transaction's events in this order: offer cancels and removals (in `AffectedNodes` order), then mints, sales,
  transfers, burns and modifies (by `nft_id`), then offer creations (in `AffectedNodes` order). Newest-first lists so show a sale above the
  offers it removed, and a mint's offer above the mint.
- Amounts use the existing amount helpers (`ParseContext`'s native currency). An MPT amount (none is possible today) skips the event and
  counts it in `skipped` (`diagnostics.nftSkipped`, metric `syncer_nft_skipped_total`).

### 2.6 Accounts of an event (`account_nft_events.roles`)

`issuer` (on mint, burn and sale only, so an issuer's history is not every offer on its NFTs), `minter` (the sender of a mint when it is
not the issuer), `from`, `to`, `broker`, `offer_owner` (the owner of a created, cancelled or removed offer), `destination` (an offer's).

## 3. Aggregation

Two new jobs and one new volume metric, with the roadmap's rules: committed ledgers only (scans capped at the newest `ledgers` row), version
sets, R86 finality, budgets (R83), failed-last ordering (R87), runners in files of their own (`*.job-runner.ts` behind
`AggregateJobDeps`), errors counted and logged, never stopping the loop.

### 3.1 `nft_state` (every tick, budget `AGGREGATOR_NFT_STATE_BUDGET_MS` = 3000, after `amm_pools`)
- **Fold.** `foldNftEvents(events)` (`packages/shared/src/aggregate/nft-state.ts`, pure) turns an NFT's events, oldest first, into its
  state: the owner after the newest `mint`/`sale`/`transfer` (cleared by a `burn`, set again by a later `mint`: decision 19), `uri` after
  the newest mint or modify, the mint, burn and last-sale facts, `sale_count`, `first_ledger`, `last_ledger`, and every account it ever had
  as owner. Offer events count for `first_ledger` / `last_ledger` only. The API's detail route uses the same function (section 5.3).
- **Live.** A cursor (in memory; found again at start as the ledger before the oldest `nft_touches` row above its NFT's newest
  `nfts.last_ledger`, else the committed head) and `nftsChangedSince(cursor, head, NFT_STATE_BATCH = 500)`: NFTs with a touch above
  what their newest `nfts` row has seen, oldest first. Each is rebuilt from its `nft_events` (a prefix read) and written under one new
  version: its `nfts` row and one `account_nfts` row per owner it ever had (`held` 1 for the current one). A failed batch is halved, as
  `amm_pools` does; the cursor moves past a batch once it is written.
- **Dirty.** Then, in what is left of the budget, the oldest `nft_dirty` range: the NFTs with a touch in its first
  `NFT_DIRTY_STEP_LEDGERS` (10,000) ledgers, and those whose `nfts` row's `first_ledger` or `last_ledger` lies there, are rebuilt in
  batches; an NFT with no event left is removed from `nfts` with a lightweight `DELETE` (and its `account_nfts` rows get `held = 0`). The
  range is then replaced by its remainder (insert the remainder, delete the old row), so progress survives a restart.
- **Collections due.** The collection keys of every rebuilt NFT go to an in-memory queue for 3.2.

### 3.2 `nft_collections` (budget `AGGREGATOR_NFT_COLLECTIONS_BUDGET_MS` = 3000, every 5th tick: `NFT_COLLECTIONS_EVERY_TICKS`)
- Takes the queued keys, 50 at a time (`NFT_COLLECTIONS_BATCH`), oldest first. At start the queue is filled by one grouped read of `nfts`:
  the collections whose newest NFT version is above their `nft_collections` version (`collectionsBehind`).
- A recompute reads the collection's `nfts` prefix (newest per NFT: supply, holders and the holders' counts) and its `collection_nft_events`
  (mint and burn counts, first and last mint, sales with their converted prices, section 3.3), and writes the `nft_collection_holders` rows,
  then the `nft_collections` row, under one version. A collection with no NFT left is deleted from both.

### 3.3 Prices in the native currency, and `nft_volume`
- **One conversion.** A sale's price in an issued currency is converted at its asset's native rate of the sale's UTC day, read through
  `DailyRates.rateRowsSql` (the day's `native_rates_daily` set, else computed on read); a native price is itself; a price with no rate
  that day has no converted value. The collections job, the volume metric, `/stats` and every sale's `converted_amount` use this one SQL
  (`nftSalesNativeSql` in `packages/shared/src/query/nft-prices.ts`), so a collection's volume is the same everywhere.
- **`nft_volume`** joins `VOLUME_METRICS`. `livePeriodsOf('nft_volume')` is `day`, `7day`, `30day`; daily sets as the other metrics. A
  component is a collection (`component` = `<issuer>` on Xahau, `<issuer>/<taxon>` on XRPL; `base_currency` the native currency), its
  `amount` the converted volume of its sales with a rate and `count` those sales; the row's `count` (the sentinel's) is every sale of the
  window. Components are read from `nft_sales` by the window's committed ledger range. Its sets carry `NFT_VOLUME_CONFIG_VERSION` (1), not
  the markets config's version, so a markets change does not recompute them; `volume_backfill` fills its closed days newest first.
- **Load.** The live job gains three sets (fifteen in all, stalest first); the scheduling test (`aggregator.schedule.spec.ts`) is extended
  to show the live sets are not starved with `nft_state` and `nft_collections` registered.

### 3.4 Re-ingest: the `agg_dirty` hook
`hooksOfSlice` gains `nft_state`: it appends the slice's ledger range to `nft_dirty` (idempotent; it never rebuilds NFTs itself, so a day
of 2022's busiest NFT ledgers cannot hold a tick). The slice's daily `nft_volume` sets are recomputed with the other metrics, as today. A
hook failure is counted as `nft_state_dirty` and fails the slice.

### 3.5 Observability
Gauges `syncer_nft_state_lag_ledgers` (head − live cursor), `syncer_nft_dirty_ledgers` (the ledgers in `nft_dirty`),
`syncer_nft_collections_pending` (the queue); counter `syncer_nft_skipped_total`; the usual `syncer_aggregator_errors_total{job}`.

## 4. Coverage

`FeatureCoverageService` (`apps/api/src/common/feature-coverage.service.ts`, new here and the one coverage service of program 2: D5, D6,
D7 and D9 register their features with it and define no rule of their own) answers `coverage(feature)` for `{ parserVersion,
amendment? }`; NFTs are `{ NFT_PARSER_VERSION, 'NonFungibleTokensV1_1' }` on XRPL and `{ NFT_PARSER_VERSION, 'URIToken' }` on Xahau (by
the network's family, so D-env's testnet profiles take their mainnet's amendment).

- `from_ledger_index`: one more than the newest stored ledger a parser older than `parserVersion` wrote, or the oldest stored ledger when
  there is none (the rule of `StateLedgerService`, which moves onto the shared helper `newestLedgerBelowVersion`). Gaps do not matter
  (decision 17).
- `complete`: `from_ledger_index` ≤ E, the feature's start ledger:
  - **With an amendment**, E is its enable ledger as `/v2/network/amendments/{name}` reports it (`enabled.ledger_index` of the amendments
    assembly: the indexed `EnableAmendment`, else, on a mainnet, the metadata file). Never a constant in code. A testnet ignores the
    metadata file's enable ledgers (D-env §6), so there E is only an indexed `EnableAmendment`. No E known: `false`.
  - **Without an amendment** (a feature as old as the network, such as D6's trust lines or D7's reserves; `amendment` left out), E is the
    network's first ledger, `NetworkProfile.firstLedger` (new, added here to D-env's four profiles): XRPL 32,570 (ADR-0015's first
    ledger), Xahau its genesis ledger (the plan reads it from a full-history node's `complete_ledgers`; the same ledger decision 18 records
    for `URIToken`), none on the testnets, whose history before the sandbox's first boot is not indexed (D-env §12): `false` there.
  - **A feature the network cannot have** (a later spec's profile flag says so: D5's `hasDelegation`, D9's `hasMpt`): `complete: true`
    with the service's `from_ledger_index` for its parser version, and its routes read no table (nothing can be missing).
- Both are kept 60 s (`FEATURE_COVERAGE_CACHE_MS`), per feature. With no stored ledger, `from_ledger_index` is left out and `complete` is false.
- **Per NFT** (detail, history, offers): the same `from_ledger_index`; `complete` is true when the feature's is, or when the NFT's mint is
  indexed (its `minted` ledger is at or above `from_ledger_index`). Later specs apply the same per-item rule to their objects (D5).
- **Placement, for every new answer of program 2 derived from ledger history** (lists, aggregates, and details read from history):
  `"coverage": { "from_ledger_index": 96100001, "complete": false }`, in this key order, is the key right after `result`. An answer
  whose parts have coverages of their own (D7's `/v2/network/supply`) puts each part's `coverage` as the last key of that part instead,
  and a part that needs no history has none. A lookup that lists nothing (D4's names batch, D5's `ledger_objects/{id}`, D9's `?ids=`)
  and an answer not derived from ledger history (D4's tomls, D8's validator fields) carry none. Not in the CSV.

## 5. API

Everything uses the contract layer: `@RippleController`, `@RippleRoute('<message>')`, `limit` (200, max 1000), markers (the base64url key
of the last row) and `Link`, `@Csv`, absent keys left out, key order pinned by tests, `Cache-Control: private, max-age=60`. Routes with a CSV
form are exportable with no change (`ExportableRoutes`); those over time take `start` and `end`. Module `apps/api/src/nft/`
(`nft.module.ts`, controllers `NftsController`, `NftCollectionsController` (literal sub-routes before the taxon form, pinned by
`nft.module.spec.ts` as `amm.module.spec.ts` pins the AMM order), `NftSalesController`; objects in `nft-objects.ts` with key order in its
header), `AccountNftsController` in `AccountsModule`, and `nft_volume` in the volume controller.

**Common checks** (in this order where they apply): 400 `invalid nft id` (not 64 hex digits; any case is accepted and upper-cased),
`invalid issuer address`, `invalid taxon` (not a decimal UInt32), `invalid start date format`, `invalid end date format`, `invalid event`
(a member of the comma list is not an event), `invalid role`, `invalid type`, `invalid sort`, `invalid marker`. An account's address is not
checked (as `/accounts/{a}/path_payments`: an address that is none has an empty list).

### 5.1 Objects

- **Nft**: `nft_id, kind, issuer, taxon?, serial?, flags, transfer_fee?, owner?, owner_since?, uri?, digest?, minted?, burned, burned_at?,
  sale_count, last_sale?`. `owner_since`, `minted`, `burned_at` are `{ledger_index, tx_hash, executed_time}` plus `by` and `to` on `minted`,
  `by` on `burned_at`; `last_sale` is `{amount, currency, amount_issuer?, converted_amount?, ledger_index, tx_hash, executed_time}`. `uri` is
  hex as on the ledger. `owner` is absent for a burned NFT and when no indexed event names it.
- **NftEvent**: `nft_id, kind, issuer, taxon?, serial?, ledger_index, tx_index, event_index, tx_hash, tx_type, executed_time, event, account?,
  from?, to?, offer_id?, is_sell_offer?, amount?, currency?, amount_issuer?, converted_amount?, destination?, expiration?, broker?,
  broker_fee?, royalty_est?, removed_by?, uri?`. `converted_amount` on sales only.
- **NftSale**: `nft_id, kind, issuer, taxon?, serial?, ledger_index, tx_index, event_index, tx_hash, executed_time, seller, buyer, mode
  ("direct" | "brokered"), amount, currency, amount_issuer?, converted_amount?, broker?, broker_fee?, royalty_est?`.
- **NftOffer**: `offer_id, is_sell_offer, owner, amount, currency, amount_issuer?, destination?, expiration?, created_ledger, created_tx_hash,
  created_time`.
- **Collection**: `issuer, taxon?, kind, supply, holders, minted, burned, sales_count, volume_native, first_mint?, last_mint?, last_ledger`
  (`first_mint` / `last_mint` as `{ledger_index, tx_hash, executed_time}`; `volume_native` exact text).
- **CollectionDay**: `date, sales_count, volume_native, avg_price_native?, min_price_native?, mints, burns`. **Holder**: `owner, held`.

Times are `YYYY-MM-DDTHH:mm:ssZ`; amounts exact text; `converted_amount` and the `*_native` values are the native currency, text with at
most 6 decimals (drops). `flags` is the number; `transfer_fee` the number in 1/100000.

### 5.2 `GET /v2/nfts/{nft_id}`

The NFT folded from its indexed events (decision 7). `{result, coverage, nft}`; 404 `nft not found` when the index has no event of it; 500
`unable to retrieve nft`. No CSV.

```json
{ "result": "success", "coverage": { "from_ledger_index": 75443457, "complete": true },
  "nft": { "nft_id": "00081388D7A2…0000101F", "kind": "nftoken", "issuer": "rLULtF…", "taxon": 1, "serial": 4127, "flags": 8,
           "transfer_fee": 5000, "owner": "rHciXf…", "owner_since": { "ledger_index": 107701201, "tx_hash": "67F9…", "executed_time": "2026-10-20T17:01:12Z" },
           "uri": "697066733A2F2F…", "minted": { "ledger_index": 86201334, "tx_hash": "1E6B…", "executed_time": "2024-03-14T12:00:41Z", "by": "rLULtF…", "to": "rLULtF…" },
           "burned": false, "sale_count": 7,
           "last_sale": { "amount": "1250", "currency": "XRP", "converted_amount": "1250", "ledger_index": 107701201, "tx_hash": "67F9…", "executed_time": "2026-10-20T17:01:12Z" } } }
```

### 5.3 `GET /v2/nfts/{nft_id}/history`

| Parameter | Default | Meaning |
|---|---|---|
| `start`, `end` | all | window |
| `event` | all | comma list of events |
| `descending` | false | |
| `limit`, `marker` | 200, max 1000 | marker `(ledger_index, tx_index, event_index)` |
| `format` | json | `csv`: `<nft_id> - nft history.csv` |

`{result, coverage, count, marker?, events: [NftEvent]}`. A prefix read of `nft_events`, the event filter inside the capped read. 404
`nft not found` when the index has no event of the NFT; 500 `unable to retrieve nft history`.

### 5.4 `GET /v2/nfts/{nft_id}/offers`

The open offers: created and not since cancelled, removed or accepted, worked out at read time from the NFT's offer events (grouped by
`offer_id`, the newest event of each must be its `offer_create`). On Xahau there is at most one, the entry's. `type` (`sell`, `buy`, empty
for both; else 400 `invalid type`), `limit`, `marker` (`(created_ledger, created tx_index, event_index)`), newest first; no CSV.
`{result, coverage, count, marker?, offers: [NftOffer]}`. An expired offer is listed until it is removed (the explorer marks it). 404
`nft not found`; 500 `unable to retrieve offers`.

### 5.5 `GET /v2/accounts/{address}/nfts`

The NFTs the account holds: the newest `account_nfts` row of each of its keys with `held = 1`, joined to the newest `nfts` row, grouped by
collection then serial. `issuer`, `taxon` (with `issuer` only; alone 400 `invalid taxon`), `limit`, `marker` (`(issuer, taxon_key, serial,
nft_id)`), `format` (`<address> - nfts.csv`). `{result, coverage, count, marker?, nfts: [Nft]}`; 500 `unable to retrieve nfts`.

### 5.6 `GET /v2/accounts/{address}/nft_history`

`start`, `end`, `event`, `role` (comma list of the roles of 2.6), `descending`, `limit`, `marker`, `format` (`<address> - nft history.csv`).
`{result, coverage, count, marker?, events: [NftEvent]}` from `account_nft_events`, filters inside the capped read; 500 `unable to retrieve
nft history`.

### 5.7 `GET /v2/nft_collections`

| Parameter | Default | Meaning |
|---|---|---|
| `issuer` | all | the collections of one issuer (a prefix) |
| `sort` | `volume` | `volume`, `supply`, `holders` |
| `descending` | true | `false` for the smallest first |
| `limit`, `marker` | 200, max 1000 | marker `(sort value, issuer, taxon_key)` |
| `format` | json | `csv`: `nft collections.csv` |

`{result, coverage, total, count, marker?, collections: [Collection]}`; `total` is how many collections the filter matches. Ties by issuer
and taxon ascending. The newest row of every collection (some 40,000 on XRPL) is read and sorted per request; the answer is cached 60 s in the
API (`CacheService`, per query). 500 `unable to retrieve collections`.

```json
{ "result": "success", "coverage": { "from_ledger_index": 75443457, "complete": true }, "total": 38511, "count": 1, "marker": "…",
  "collections": [{ "issuer": "rLULtF…", "taxon": 1, "kind": "nftoken", "supply": 10000, "holders": 3812, "minted": 10000, "burned": 0,
                    "sales_count": 41208, "volume_native": "18400000.5",
                    "first_mint": { "ledger_index": 86201334, "tx_hash": "1E6B…", "executed_time": "2024-03-14T12:00:41Z" },
                    "last_mint": { "ledger_index": 107120044, "tx_hash": "9A10…", "executed_time": "2026-10-14T08:02:11Z" },
                    "last_ledger": 107701201 }] }
```

### 5.8 `GET /v2/nft_collections/{issuer}/{taxon}` (XRPL) and `GET /v2/nft_collections/{issuer}` (Xahau)

`{result, coverage, collection}`; 404 `collection not found` (none, or the other network's form: decision 9); 500 `unable to retrieve
collection`. The sub-routes below take the same key, check that the collection exists first (its `nft_collections` row, so a collection
younger than the collections job's last run is 404 for up to five minutes, as a new AMM pool is for a minute), and answer the same 404.

### 5.9 Collection lists: `…/nfts`, `…/holders`, `…/sales`

- **`/nfts`**: the collection's NFTs by serial (Xahau: by id), the newest `nfts` row of each, burned left out unless `include_burned`
  (boolean). `owner` (an address) reads `account_nfts` instead, by its prefix and the collection. Marker `(serial, nft_id)`. `format`
  `<issuer>[ <taxon>] - nfts.csv`. `{result, coverage, count, marker?, nfts: [Nft]}`; 500 `unable to retrieve nfts`.
- **`/holders`**: the newest set of `nft_collection_holders`, `held` descending then `owner`. Marker `(held, owner)`. `format` `… -
  holders.csv`. `{result, coverage, count, marker?, holders: [Holder]}`; 500 `unable to retrieve holders`.
- **`/sales`**: the `sale` events of `collection_nft_events` (the filter inside the capped read) as NftSale, with `start`, `end`,
  `descending`, `limit`, `marker` `(ledger_index, tx_index, event_index)`, `format` `… - sales.csv`. `{result, coverage, count, marker?,
  sales: [NftSale]}`; 500 `unable to retrieve sales`.

A filter that drops rows after the newest-version step (`burned`, `held`) reads again with more room while the inner read came back full
and the page is short (`readNewestPage`, `packages/shared/src/query/newest-page.ts`, the newest-version sibling of `readDistinctPage`).

### 5.10 `GET /v2/nft_collections/{key}/stats`

One row per UTC day of the window with a sale, a mint or a burn: a `GROUP BY` day over the collection's prefix of `collection_nft_events`
in the window's ledger range, prices converted as in 3.3. `start` (required), `end` (default now), `descending`; the window is at most 366
days (400 `invalid window - use at most 366 days`); no marker (a year is at most 366 rows), `format` `… - stats.csv`. A day without a row had
no activity. `{result, coverage, count, days: [CollectionDay]}`; 500 `unable to retrieve stats`.

```json
{ "result": "success", "coverage": { "from_ledger_index": 75443457, "complete": true }, "count": 1,
  "days": [{ "date": "2026-10-19T00:00:00Z", "sales_count": 46, "volume_native": "20240.5", "avg_price_native": "440.01",
             "min_price_native": "180", "mints": 0, "burns": 0 }] }
```

`avg_price_native` is the volume over the sales with a rate; both price fields are absent on a day with no such sale.

### 5.11 `GET /v2/nft_sales`

The network's sales from `nft_sales`: `start`, `end`, `currency` (`XRP` or `CUR+issuer`, the form of `/v2/payments/{currency}`; its errors),
`descending`, `limit`, `marker`, `format` (`nft sales.csv`). `{result, coverage, count, marker?, sales: [NftSale]}`; 500 `unable to
retrieve sales`.

```json
{ "result": "success", "coverage": { "from_ledger_index": 75443457, "complete": true }, "count": 1, "marker": "…",
  "sales": [{ "nft_id": "000827103B94…", "kind": "nftoken", "issuer": "rLULtF…", "taxon": 1, "serial": 812, "ledger_index": 107701201,
              "tx_index": 14, "event_index": 2, "tx_hash": "67F9…", "executed_time": "2026-10-20T17:01:12Z", "seller": "rBbW6…",
              "buyer": "rHciXf…", "mode": "brokered", "amount": "1250", "currency": "XRP", "converted_amount": "1250",
              "broker": "rPEhZx…", "broker_fee": "25", "royalty_est": "61.25" }] }
```

### 5.12 `GET /v2/network/nft_volume`

The contract of `/v2/network/exchange_volume` (live and historical modes, `interval`, `exchange_currency` / `exchange_issuer`, `limit`,
`marker`, `format` `nft_volume.csv`), with `live` one of `day`, `7day`, `30day` (400 `invalid period - use: day, 7day, 30day`), and
`coverage` after `result`. A component is `{issuer, taxon?, count, amount, rate, converted_amount}` (`amount` in the native currency, `count`
the collection's sales with a rate); the row's `count` is every sale. Components by converted amount, largest first; on a network without
sales, rows have no components. 500 `error getting data`.

```json
{ "result": "success", "coverage": { "from_ledger_index": 75443457, "complete": true }, "count": 1,
  "rows": [{ "components": [{ "issuer": "rLULtF…", "taxon": 1, "count": 412, "amount": "181200.5", "rate": "1.0000000", "converted_amount": "181200.5" }],
             "count": 1290, "exchange": { "currency": "XRP" }, "total": "412600.25", "exchange_rate": "1.0000000",
             "start_time": "2026-10-19T17:01:00Z", "end_time": "2026-10-20T17:01:00Z" }] }
```

## 6. Query bounds (pinned by EXPLAIN and `read_rows` tests)

| Read | Bound | Test |
|---|---|---|
| history, offers, detail | the NFT's prefix of `nft_events` | `expectBoundedInOrderRead`; a 10k-event NFT's 200-row page |
| account history, collection sales | the account's or collection's prefix, `readDistinctPage` | `paged-reads.e2e-spec.ts` over four parts |
| network sales, volume components | a ledger range of `nft_sales` | the same |
| account NFTs, collection NFTs, holders | the prefix of `account_nfts` / `nfts` / `nft_collection_holders`, `readNewestPage` | 120k NFTs for one owner: a 200-row page reads at most a few granules per part |
| collections list | all newest rows of `nft_collections` | read rows ≤ rows of the table; cached 60 s |
| stats | the collection's prefix within ≤ 366 days of ledgers | a 400-day `start` is a 400 before any read |
| coverage | `ledgers` (as the state coverage), cached 60 s | one query per minute per feature |

Every read is capped at the newest committed ledger, and no list uses `FINAL` (ADR-0003).

## 7. XRPL and Xahau

| | XRPL | Xahau |
|---|---|---|
| kind | `nftoken` | `uritoken` |
| collection key | issuer + taxon (`/{issuer}/{taxon}`) | issuer (`/{issuer}`) |
| taxon, serial, transfer fee, royalty | from the id | none |
| offers | many, sell and buy (`NFTokenOffer`) | one sell offer on the entry |
| brokered sales | yes | no |
| modify | `NFTokenModify` | no |
| other movers | none | `Remit` (transfer, mint) |
| coverage amendment | NonFungibleTokensV1_1 (75443457) | URIToken (genesis) |

Each network's API answers the other's id or key with its own 404s: an XRPL id on Xahau is `nft not found`.

## 8. Rollout, backfill and reprocess

1. Apply the migration before the syncer of the release (the writer inserts into the five ledger tables with every ledger) and before the
   API. Coverage then starts at the first ledger the new parser writes.
2. Fill the history with `range-ingest --reprocess` from 75443457 on XRPL and from the first ledger on Xahau, or as part of the history
   spec's re-ingest from ledger 32570 (one reprocess serves both). Each range is marked in `agg_dirty`, and `nft_state` works through
   `nft_dirty` under its budget: watch `syncer_nft_dirty_ledgers` fall to 0. `nft_volume`'s daily sets are filled by `volume_backfill`.
3. Coverage turns `complete` once no ledger at or above the enable ledger was written by an older parser.
4. The explorer turns its `NFTS` switch on in an environment once that environment's API serves these routes on both networks and the lag
   gauges are near 0 (E8, rollout); the coverage notices cover the history still missing.

## 9. Docs to update

- `docs/api-reference.md`: a new section "NFTs" with every route, object and key order above; the conventions' list of extras; the
  coverage shape (a "Coverage" convention, used by later features: its placement, its start ledger with and without an amendment, the
  testnets, a feature a network cannot have).
- `docs/data-model.md`: the migration, the five ledger tables, the four aggregates and `nft_dirty`; the relationships diagram; the table count.
- `docs/syncer.md`: the two jobs in the aggregator table, the `nft_volume` metric, the hook, the gauges.
- `docs/operations.md` and `docs/backfill.md`: the NFT re-ingest, the gauges, the coverage check (`SELECT maxOrNull(ledger_index) FROM ledgers
  WHERE parser_version < <NFT_PARSER_VERSION>`).
- `docs/openapi.yaml` regenerated; `docs/architecture.md`'s module list.
- **ADR-0010**: an amendment listing the new routes as extras, the `coverage` field, `nft_volume`'s periods and component, and the CSV names.
- **A new ADR** (the next number): NFT and URIToken data: events from page and entry diffs, state folded from history (ADR-0015's approach),
  query-time collection stats instead of a daily job, the coverage shape and its rule.
- `packages/shared/config/amendments/xahau.json`: `URIToken`'s enable ledger (decision 18).

## 10. Testing

**Fixtures.** Record real ledgers with `record-fixtures --txs` (at most 2 requests in flight) into `packages/shared/test/fixtures/xrpl/nft/`
and `xahau/uritoken/`, each with `manifest.json` and `FINDINGS.md`:
- XRPL: mint; mint with offer (NFTokenMintOffer, ≥ 94166785); mint on behalf (`Issuer`); burn; burn that removes offers; modify (≥ 96724737);
  sell offer create / cancel; buy offer create; sale by sell offer; sale by buy offer; brokered sale with royalty; sale in an issued
  currency; a zero-amount accept (transfer); a page split in one transaction with a mint; an expired offer removed by another transaction.
- Xahau: mint; mint with `Amount` and `Destination`; create / cancel sell offer; buy (an `Amount` above the asked); burn with an offer; a
  `Remit` transfer; a `Remit` with `MintURIToken`; a burn and re-mint of one id, if one is found (else synthetic).
- `FINDINGS.md` confirms: the page-key owner rule against `account_nfts` on the node; taxon unscrambling against every mint's
  `NFTokenTaxon`; the royalty against the issuer's balance change; the URITokenBuy price against the seller's change; Xahau's first ledger.

**Unit and golden.** `nftoken-id.spec` (decode, unscramble, page owner); `nft.parser.spec` per case and these invariants over every fixture:
ids equal the union of page diffs; at most one owner per NFT after each transaction; `(nft_id, event_index)` unique per transaction;
decoded fields equal the mint's fields; an independent oracle (`packages/shared/test/nft-oracle.ts`) gives the same events; deep-frozen input;
`tec` results give none. `foldNftEvents` spec (re-mint, burn, offers only, out-of-coverage first event). At least 10 hand-made mutants killed.

**Ingest e2e.** The fixtures land in all five tables; fault injection and recovery leave no orphans; range-ingest redo leaves no duplicates;
a ripple-mock ledger gives none; `LEDGER_KEYED_TABLES` matches the schema's partitioning.

**Aggregator e2e and unit.** `nft_state`: holdings move seller → buyer; a burn leaves holdings; idempotent; 120k NFTs of one owner rebuilt
across ticks under budget; the dirty path survives a restart mid-range; the collections queue is refilled at start. `nft_collections`:
supply = minted − burned on full coverage, holders, the holders set with gone holders, volume equal to the sum of the `nft_volume` daily
components and to `/stats` over the same days. `nft_volume`: live periods, daily sets, unrated sales in the row count only. Scheduling: the
live volume sets are not starved.

**Coverage service.** `feature-coverage.service.spec.ts`: an amendment feature before and after its enable ledger; the metadata
file's ledger on a mainnet and ignored on a testnet profile (`complete: false` without an indexed `EnableAmendment`); a feature without
an amendment against `firstLedger` on XRPL and Xahau, and on a testnet profile (`false`); no stored ledger; the 60 s cache.
`network-profile.spec.ts`: `firstLedger` of the four profiles.

**API e2e.** For each route: the shared list tests (empty, marker pages concatenated equal the unpaged list, descending, unknown params,
CSV and `Link`, 401), every filter and error in order, pinned key order, coverage (incomplete before the enable ledger, complete after, per
NFT), the route order of `nft_collections`, both networks (the other network's ids and keys 404), EXPLAIN and `read_rows` bounds (section 6),
open offers equal to the oracle.

**Live check.** About 300 recent ledgers on each network in an isolated compose project: every route; three XRPL owners' holdings against
the node's `account_nfts` restricted to NFTs touched in the range; three URITokens' owner and amount against `ledger_entry`.

## 11. Out of scope

URI resolution and metadata; floor prices; rarity; per-currency NFT volume; the node fallback (the explorer's); holders or supply over time
(a daily statistics job, deferred by the owner).
