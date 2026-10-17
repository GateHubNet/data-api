# NFTs and URITokens: design

Date: 2026-10-17. Status: proposed. This is family 2 of `2026-10-17-amendments-roadmap.md`. The shared rules there are binding.

## Scope (decided by the user)

The scope covers XRPL NFTokens (amendments NonFungibleTokensV1_1, NFTokenMintOffer, DynamicNFT) and Xahau URITokens (amendment URIToken). Both get all of the following:

- **Activity and sales:** mints, burns, modifies, offers (create, cancel, accept, removed), transfers, and accepted sales with price, seller, buyer, broker and broker fee. There are lists per NFT, per account and per issuer.
- **Ownership and collections:** the current owner of every NFT, holdings per account, and collections. A collection is the issuer plus the taxon on XRPL, and the issuer alone on Xahau. Each collection has supply, holder count, mints and burns.
- **Sales volume and stats:** NFT sales volume in the network-volume style (live, or day/week/month), and daily collection stats: sales count, volume, average and lowest sale price.

## How it looks on the ledger

The facts below were checked in `packages/shared/test/fixtures/{xrpl,xahau}/recorded`.

**XRPL NFTokens**

- **No NFT ids in the node's metadata.** The `ledger` metadata carries no `nftoken_id` or `offer_id` fields. NFT ids therefore come from `NFTokenPage` diffs.
  - A page's `NFTokens` array lists `{NFTokenID, URI}`.
  - Comparing the Previous and Final arrays across all page nodes of a transaction gives the ids that were added, removed or changed.
  - Pages can split and merge, so the comparison is made over the union of all page nodes in the transaction, never page by page.
- **The page key names the owner.** An `NFTokenPage` key is the owner's 20-byte AccountID followed by the low 96 bits of the NFTokenID. The owner of an NFT on a page is therefore the first 20 bytes of the page's `LedgerIndex`.
- **The NFTokenID encodes the NFT's attributes.** It is `Flags (2) | TransferFee (2) | Issuer (20) | scrambled Taxon (4) | Sequence (4)` bytes. The taxon is unscrambled with `taxon = scrambled XOR (384160001 × seq + 2459) mod 2^32`.
- **Offers.** An offer is an `NFTokenOffer` with `Owner`, `NFTokenID`, `Amount`, `Destination`, `Expiration` and `Flags`, where `lsfSellNFToken` = 1. When an offer is accepted or removed, it shows up as a `DeletedNode` carrying these fields.
- **Accepting offers.** `NFTokenAcceptOffer` carries `NFTokenSellOffer` and/or `NFTokenBuyOffer`. In brokered mode it carries both, plus `NFTokenBrokerFee`.
- **Minting with an offer.** `NFTokenMint` can carry `Amount`, `Destination` and `Expiration` (NFTokenMintOffer), which creates a sell offer in the same transaction. It can also carry `Issuer`, to mint on behalf of an authorized minter.
- **Modifying.** `NFTokenModify` (DynamicNFT) changes the `URI` of a mutable NFT.

**Xahau URITokens**

- **The object.** A `URIToken` object has the fields `Owner`, `Issuer`, `URI`, `Digest`, `Flags`, and optionally `Amount` and `Destination`, which together form the sell offer. Its id is the object's `LedgerIndex`.
- **Each transaction's effect:**
  - `URITokenMint` creates the object.
  - `URITokenBurn` deletes it.
  - `URITokenCreateSellOffer` sets `Amount` (and optionally `Destination`).
  - `URITokenCancelSellOffer` removes them.
  - `URITokenBuy` changes `Owner` and clears `Amount`; the previous fields hold the price and the seller.
- **Transfers without a sale.** A `Remit` can also move or mint URITokens. Any `Owner` change that does not come from a `URITokenBuy` is a transfer.

## 1. Storage

**Ledger tables**

| Table | Partition | ORDER BY | Holds |
|---|---|---|---|
| `nft_events` | P7 | `(nft_id, ledger_index, tx_index, event_index)` | One row per NFT event. Columns: `kind` (`nftoken`/`uritoken`), `event` (`mint`, `burn`, `modify`, `offer_create`, `offer_cancel`, `offer_removed`, `sale`, `transfer`), `issuer`, `taxon` (`Nullable`), `nft_flags`, `transfer_fee`, `uri`, `from_account`, `to_account`, `offer_id`, `is_sell_offer`, the amount (`currency`, `amount_issuer`, `amount`, `amount_f`), `destination`, `expiration`, `broker`, `broker_fee`, `royalty_est`, `tx_hash`, `tx_type` and `close_time`. `event_index` is the order of the event within its transaction. |
| `account_nft_events` | P7 | `(account, ledger_index, tx_index, event_index, nft_id)` | A narrow index: one row per account involved (owner, buyer, seller, broker, offer owner, issuer, minter). |
| `collection_nft_events` | P7 | `(issuer, taxon_key, ledger_index, tx_index, event_index, nft_id)` | A narrow index per collection. `taxon_key` is the taxon, or 0 on Xahau. |
| `nft_sales` | P6 | `(ledger_index, tx_index, event_index)` | A time-ordered narrow index of `sale` events, for network-wide sale lists and volume. |

**Aggregate tables**

These are rebuilt by the aggregator and use `ReplacingMergeTree(version)` version sets.

| Table | ORDER BY | Holds |
|---|---|---|
| `nfts` | `nft_id` | The current state of each NFT. Columns: `kind`, `issuer`, `taxon`, `owner`, `uri`, `flags`, `transfer_fee`, `minted_ledger`, `minted_by`, `burned`, `last_ledger`, `sale_count`, `last_sale_amount` and `version`. Rebuilt for the NFTs whose events changed since the watermark, and for `agg_dirty` ranges. |
| `account_nfts` | `(owner, nft_id)` | Holdings. One version set per owner, recomputed for the owners whose holdings changed. A reader keeps only the rows whose version is the latest for that owner. |
| `nft_collections` | `(kind, issuer, taxon_key)` | Collection totals: `minted`, `burned`, `supply`, `holders`, `first_mint`, `last_mint`, `sales_count`, `volume_native` and `version`. |
| `nft_daily` | `(kind, issuer, taxon_key, day)` | Daily stats per collection: `sales_count`, `volume_native`, `avg_price_native`, `min_price_native`, `mints`, `burns`, `unique_buyers`, `unique_sellers`, `config_version` and `version`. There is also a per-day sentinel. |

**Volume:** a new metric, `nft_volume`, joins the existing `volume_live` / `volume_daily` sets. Its components are collections with sales in the window.

## 2. Parsing

There is one new pure parser, `packages/shared/src/parsers/nft.parser.ts`. It runs on successful transactions only.

1. **XRPL NFT ids and owners.** These come from the `NFTokenPage` diffs, as described above.
   - An id added in the transaction with no owner before is a `mint`, with `to_account` = the page owner.
   - An id removed with no new owner is a `burn`.
   - An id whose owner changed is a `sale` or a `transfer`. It is a sale when it comes from an accepted offer with a non-zero amount, and a transfer otherwise.
   - A changed `URI` is a `modify`.
2. **XRPL offers.**
   - A `NewNode` of type `NFTokenOffer` is an `offer_create`, with `offer_id` = its `LedgerIndex`. This includes offers created by `NFTokenMint`.
   - A `DeletedNode` of type `NFTokenOffer` in an `NFTokenCancelOffer` is an `offer_cancel`.
   - A `DeletedNode` in an `NFTokenAcceptOffer` is the offer that was accepted. Its amount becomes the sale's price. It is also recorded as an `offer_removed` event, which keeps offer lifecycles complete.
   - A `DeletedNode` in any other transaction (a burn, expiry cleanup, and so on) is `offer_removed`.
3. **XRPL sales**
   - **Direct mode** (a sell or a buy offer):
     - price = the offer's `Amount`;
     - seller = the previous owner;
     - buyer = the new owner.
   - **Brokered mode** (both offers):
     - price = the buy offer's amount;
     - seller = the sell offer's owner;
     - buyer = the buy offer's owner;
     - broker = the transaction's `Account`;
     - `broker_fee` = `NFTokenBrokerFee`.
   - **Royalty:** `royalty_est` = price × `TransferFee` / 100000. It is computed only when the issuer is neither seller nor buyer.
4. **URITokens.** These come from `URIToken` node diffs and the transaction type:
   - `NewNode` is `mint`;
   - `DeletedNode` is `burn`;
   - `Amount` set or changed is `offer_create`, with `offer_id` = the URITokenID;
   - `Amount` removed without an owner change is `offer_cancel`;
   - an `Owner` change in a `URITokenBuy` is a `sale`, with price from the previous `Amount` (or the transaction's `Amount`), seller = the previous `Owner`, and buyer = `Account`;
   - any other `Owner` change, for example by `Remit`, is a `transfer`.
5. **Amounts.** These use the existing amount helpers. Native is in drops; an IOU is a currency and issuer. On XRPL NFT prices cannot be MPTs; if an MPT ever appears it is skipped and counted.
6. **Deep-frozen input.** One `event_index` sequence is kept per transaction. Every event is attributed to the right accounts for `account_nft_events`.

## 3. API

Every route uses the shared contract: limit 200/1000, markers, the `Link` header, CSV, Ripple errors with `unable to retrieve <thing>`, and pinned key order. An NFT id is 64 hex characters on both networks; any other value gives 400 `invalid nft id`.

| Route | Params | Response |
|---|---|---|
| `GET /v2/nfts/:nft_id` | — | `{result, nft:{nft_id, kind, issuer, taxon?, owner?, uri?, flags, transfer_fee, minted_ledger, minted_by, burned, sale_count, last_sale?}}`; 404 `nft not found` |
| `GET /v2/nfts/:nft_id/history` | `start`, `end`, `event`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, events:[NftEvent]}` |
| `GET /v2/nfts/:nft_id/offers` | `type=sell\|buy` | `{result, offers:[{offer_id, is_sell_offer, owner, amount, destination?, expiration?, created_ledger}]}`. These are open offers, worked out from the NFT's events: created and not yet cancelled, removed or accepted. |
| `GET /v2/accounts/:address/nfts` | `issuer`, `taxon`, `limit`, `marker`, `format` | `{result, count, marker?, nfts:[Nft]}` (holdings) |
| `GET /v2/accounts/:address/nft_history` | `start`, `end`, `event`, `role=owner\|buyer\|seller\|broker\|issuer`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, events:[NftEvent]}` |
| `GET /v2/nft_collections` | `issuer`, `sort=volume\|supply\|holders` (default `volume`), `limit`, `marker`, `format` | `{result, count, marker?, collections:[Collection]}` |
| `GET /v2/nft_collections/:issuer` and `/:issuer/:taxon` | — | `{result, collection: Collection}`; 404 `collection not found` |
| `GET /v2/nft_collections/:issuer[/:taxon]/nfts` | `owner`, `include_burned`, `limit`, `marker`, `format` | the collection's NFTs |
| `GET /v2/nft_collections/:issuer[/:taxon]/sales` | `start`, `end`, `descending`, `limit`, `marker`, `format` | the collection's sale events |
| `GET /v2/nft_collections/:issuer[/:taxon]/stats` | `start`, `end`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, days:[CollectionDay]}` |
| `GET /v2/nft_sales` | `start`, `end`, `currency`, `issuer`, `descending`, `limit`, `marker`, `format` | network-wide sale events |
| `GET /v2/network/nft_volume` | the same params and semantics as `/v2/network/exchange_volume`, including live periods hour/day/3day/7day/30day | `rows` whose components are collections, as `{issuer, taxon?, count, amount, currency, rate, converted_amount}` |

**Native conversion.** Native-converted values use `RatesService` daily native rates, as volumes do. A sale in an IOU without a rate counts in `sales_count` but not in `volume_native`.

## 4. Aggregation

There are four jobs, `nfts`, `account_nfts`, `nft_collections` and `nft_daily`, plus the `nft_volume` metric. They all follow the roadmap's shared rules:

- `nfts` and `account_nfts` work incrementally from a watermark, like `amm_pools`.
- `nft_collections` recomputes the collections touched by the changed NFTs.
- `nft_daily` and `nft_volume` work like `volume_daily` and its metrics, on a cadence.

## 5. Testing

- **Fixtures.** Record real ledgers for each case below, and write `FINDINGS.md`, confirming the page-key owner rule and the taxon unscrambling against `nft_info`-style decoding.
  - **XRPL cases:** mint, mint with offer, mint on behalf (`Issuer`), burn, modify, sell offer create/cancel, buy offer, direct sale (sell offer accepted, buy offer accepted), brokered sale, a page split, a burn that removes offers, an IOU-priced sale, and a sale with royalty.
  - **Xahau cases:** mint, sell offer, cancel, buy, burn, and a `Remit` transfer.
- **Golden tests, with invariants.**
  - Every id the parser reports matches the union of the page diffs.
  - Every NFT has at most one owner after each transaction.
  - `NFTokenID` decoding matches the transaction fields (`Issuer`, `NFTokenTaxon`, `TransferFee`) on every mint.
  - An independent oracle reproduces the parser's output.
- **Ingest, API and aggregator tests** follow the same pattern as the AMM plan: recovery and redo, real duplicates, EXPLAIN and `read_rows` bounds, list semantics, an empty answer on the other network, version sets and budgets.

## 6. Out of scope

- NFT metadata fetching (URI resolution, IPFS).
- Floor prices from open offers.
- Rarity.
