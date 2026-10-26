-- =============================================================================
-- GateHub Data API: NFTs and URITokens (D3, spec 2026-10-17-nft-data-design.md section 1). Additive to 001_baseline.sql,
-- one database per network.
--
-- Five ledger-derived tables, written by ingest with the ledger's other rows from parser version 5 on (NFT_PARSER_VERSION
-- in rows.ts): nft_events, its copies by account, by collection and, for the sales, in ledger order (account_nft_events,
-- collection_nft_events, nft_sales), and the narrow nft_touches the aggregator scans. A ledger written by an older parser
-- has no rows in them; they stay empty for those ledgers until --reprocess rewrites them. They carry the dedup window of
-- every ledger-derived table, so a ledger written twice by the same writer run is deduplicated on insert.
--
-- Four aggregate tables, written by the aggregator only, ReplacingMergeTree(version), no partition: nfts (the state of
-- every NFT), account_nfts (one row per owner an NFT ever had, held = 1 for the current one), nft_collections and
-- nft_collection_holders. Readers keep the newest version of each key without FINAL. They are not ledger tables.
-- Plus nft_dirty, the ledger ranges whose NFTs must be rebuilt after a re-ingest.
--
-- Values: ids are 64 upper-case hex digits. kind is nftoken (XRPL) or uritoken (Xahau). taxon_key is the taxon on XRPL
-- and 0 on Xahau, serial the id's sequence on XRPL and 0 on Xahau. An absent string is the empty string, an absent
-- number NULL. Amounts are exact decimal text in whole units (the _f columns are Float64 shadows for sums and
-- comparisons); the native currency has currency XRP or XAH and an empty amount_issuer. transfer_fee is in 1/100000.
--
-- Every statement is IF NOT EXISTS, so the file can simply be run again.
--
-- Runner constraints (see src/clickhouse/migrate.ts): the file is split on a semicolon at the end of a line,
-- and lines starting with two dashes are dropped. So every statement ends with its semicolon on its last
-- line, and no other line, comment lines included, may end with one.
-- =============================================================================

-- One row per event (spec section 2): event_index is the event's place in its transaction (section 2.5), uri the hex
-- of the new URI of a mint or a modify (else empty), account who did it (the offer's owner for an offer event, else the
-- sender), from_account the owner before (burn, sale, transfer), to_account the owner after (mint, sale, transfer),
-- offer_id the NFTokenOffer's LedgerIndex (on Xahau the URIToken id), amount the offer's amount or the sale's price,
-- removed_by (offer_removed only) sale, burn, transfer or other. Read by an NFT's detail, history and offers.
CREATE TABLE IF NOT EXISTS nft_events
(
  nft_id        String,
  ledger_index  UInt32,
  tx_index      UInt32,
  event_index   UInt16,
  tx_hash       String,
  tx_type       LowCardinality(String),
  close_time    DateTime('UTC'),
  kind          Enum8('nftoken' = 1, 'uritoken' = 2),
  event         Enum8('mint' = 1, 'burn' = 2, 'modify' = 3, 'offer_create' = 4, 'offer_cancel' = 5, 'offer_removed' = 6, 'sale' = 7, 'transfer' = 8),
  issuer        String,
  taxon         Nullable(UInt32),
  taxon_key     UInt32,
  serial        UInt32,
  nft_flags     UInt32,
  transfer_fee  UInt16,
  uri           String,
  digest        String,
  account       String,
  from_account  String,
  to_account    String,
  offer_id      String,
  is_sell_offer UInt8,
  amount        String,
  amount_f      Float64,
  currency      LowCardinality(String),
  amount_issuer String,
  destination   String,
  expiration    Nullable(DateTime('UTC')),
  broker        String,
  broker_fee    String,
  royalty_est   String,
  removed_by    LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (nft_id, ledger_index, tx_index, event_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- A full copy of each event per account it involves: account is the account the row is for, actor the account of the
-- event (the account column of nft_events), roles the account's roles in it (issuer, minter, from, to, broker,
-- offer_owner, destination; spec section 2.6). An account with two roles in an event has one row.
CREATE TABLE IF NOT EXISTS account_nft_events
(
  account       String,
  nft_id        String,
  ledger_index  UInt32,
  tx_index      UInt32,
  event_index   UInt16,
  tx_hash       String,
  tx_type       LowCardinality(String),
  close_time    DateTime('UTC'),
  kind          Enum8('nftoken' = 1, 'uritoken' = 2),
  event         Enum8('mint' = 1, 'burn' = 2, 'modify' = 3, 'offer_create' = 4, 'offer_cancel' = 5, 'offer_removed' = 6, 'sale' = 7, 'transfer' = 8),
  issuer        String,
  taxon         Nullable(UInt32),
  taxon_key     UInt32,
  serial        UInt32,
  nft_flags     UInt32,
  transfer_fee  UInt16,
  uri           String,
  digest        String,
  actor         String,
  from_account  String,
  to_account    String,
  offer_id      String,
  is_sell_offer UInt8,
  amount        String,
  amount_f      Float64,
  currency      LowCardinality(String),
  amount_issuer String,
  destination   String,
  expiration    Nullable(DateTime('UTC')),
  broker        String,
  broker_fee    String,
  royalty_est   String,
  removed_by    LowCardinality(String),
  roles         Array(LowCardinality(String))
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (account, ledger_index, tx_index, event_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- A full copy of every event, by collection (issuer and taxon_key). Read by the collection's sales and stats and by the
-- collections job.
CREATE TABLE IF NOT EXISTS collection_nft_events
(
  nft_id        String,
  ledger_index  UInt32,
  tx_index      UInt32,
  event_index   UInt16,
  tx_hash       String,
  tx_type       LowCardinality(String),
  close_time    DateTime('UTC'),
  kind          Enum8('nftoken' = 1, 'uritoken' = 2),
  event         Enum8('mint' = 1, 'burn' = 2, 'modify' = 3, 'offer_create' = 4, 'offer_cancel' = 5, 'offer_removed' = 6, 'sale' = 7, 'transfer' = 8),
  issuer        String,
  taxon         Nullable(UInt32),
  taxon_key     UInt32,
  serial        UInt32,
  nft_flags     UInt32,
  transfer_fee  UInt16,
  uri           String,
  digest        String,
  account       String,
  from_account  String,
  to_account    String,
  offer_id      String,
  is_sell_offer UInt8,
  amount        String,
  amount_f      Float64,
  currency      LowCardinality(String),
  amount_issuer String,
  destination   String,
  expiration    Nullable(DateTime('UTC')),
  broker        String,
  broker_fee    String,
  royalty_est   String,
  removed_by    LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 10000000)
ORDER BY (issuer, taxon_key, ledger_index, tx_index, event_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- A full copy of the sale events, in ledger order: the network's sales list and the volume metric.
CREATE TABLE IF NOT EXISTS nft_sales
(
  nft_id        String,
  ledger_index  UInt32,
  tx_index      UInt32,
  event_index   UInt16,
  tx_hash       String,
  tx_type       LowCardinality(String),
  close_time    DateTime('UTC'),
  kind          Enum8('nftoken' = 1, 'uritoken' = 2),
  event         Enum8('mint' = 1, 'burn' = 2, 'modify' = 3, 'offer_create' = 4, 'offer_cancel' = 5, 'offer_removed' = 6, 'sale' = 7, 'transfer' = 8),
  issuer        String,
  taxon         Nullable(UInt32),
  taxon_key     UInt32,
  serial        UInt32,
  nft_flags     UInt32,
  transfer_fee  UInt16,
  uri           String,
  digest        String,
  account       String,
  from_account  String,
  to_account    String,
  offer_id      String,
  is_sell_offer UInt8,
  amount        String,
  amount_f      Float64,
  currency      LowCardinality(String),
  amount_issuer String,
  destination   String,
  expiration    Nullable(DateTime('UTC')),
  broker        String,
  broker_fee    String,
  royalty_est   String,
  removed_by    LowCardinality(String)
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, event_index)
SETTINGS non_replicated_deduplication_window = 1000;

-- Narrow: one row per NFT a transaction had an event of. The aggregator's watermark and dirty scans read it by ledger.
CREATE TABLE IF NOT EXISTS nft_touches
(
  ledger_index UInt32,
  tx_index     UInt32,
  nft_id       String,
  issuer       String,
  taxon_key    UInt32,
  serial       UInt32
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, nft_id)
SETTINGS non_replicated_deduplication_window = 1000;

-- The state of every NFT with an indexed event (spec section 1.2). owner is empty when the NFT is burned or when no
-- indexed event names it; first_ledger and last_ledger are the oldest and the newest indexed event the row has seen.
CREATE TABLE IF NOT EXISTS nfts
(
  issuer                  String,
  taxon_key               UInt32,
  serial                  UInt32,
  nft_id                  String,
  kind                    Enum8('nftoken' = 1, 'uritoken' = 2),
  taxon                   Nullable(UInt32),
  nft_flags               UInt32,
  transfer_fee            UInt16,
  owner                   String,
  owner_ledger            Nullable(UInt32),
  owner_tx                String,
  owner_time              Nullable(DateTime('UTC')),
  uri                     String,
  digest                  String,
  minted_ledger           Nullable(UInt32),
  minted_tx               String,
  minted_time             Nullable(DateTime('UTC')),
  minted_by               String,
  minted_to               String,
  burned                  UInt8,
  burned_ledger           Nullable(UInt32),
  burned_tx               String,
  burned_time             Nullable(DateTime('UTC')),
  burned_by               String,
  sale_count              UInt32,
  last_sale_ledger        Nullable(UInt32),
  last_sale_tx            String,
  last_sale_time          Nullable(DateTime('UTC')),
  last_sale_amount        String,
  last_sale_currency      LowCardinality(String),
  last_sale_amount_issuer String,
  first_ledger            UInt32,
  last_ledger             UInt32,
  version                 UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (issuer, taxon_key, serial, nft_id);

-- One row for every account an NFT ever had as owner in the index, held = 1 for the current one. A holding is the newest
-- row of a key with held = 1.
CREATE TABLE IF NOT EXISTS account_nfts
(
  owner     String,
  issuer    String,
  taxon_key UInt32,
  serial    UInt32,
  nft_id    String,
  held      UInt8,
  version   UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (owner, issuer, taxon_key, serial, nft_id);

-- One row per collection (issuer, and taxon_key on XRPL): supply counts its NFTs that are not burned, minted and burned
-- the indexed mint and burn events, volume_native the converted price of the sales with a rate.
CREATE TABLE IF NOT EXISTS nft_collections
(
  issuer            String,
  taxon_key         UInt32,
  kind              Enum8('nftoken' = 1, 'uritoken' = 2),
  taxon             Nullable(UInt32),
  supply            UInt64,
  holders           UInt64,
  minted            UInt64,
  burned            UInt64,
  sales_count       UInt64,
  volume_native     String,
  volume_native_f   Float64,
  first_mint_ledger Nullable(UInt32),
  first_mint_tx     String,
  first_mint_time   Nullable(DateTime('UTC')),
  last_mint_ledger  Nullable(UInt32),
  last_mint_tx      String,
  last_mint_time    Nullable(DateTime('UTC')),
  last_ledger       UInt32,
  version           UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (issuer, taxon_key);

-- Each recompute of a collection writes every current holder and a held = 0 row for each holder of its newest set that
-- is gone; a reader keeps the newest row per owner with held above 0.
CREATE TABLE IF NOT EXISTS nft_collection_holders
(
  issuer    String,
  taxon_key UInt32,
  owner     String,
  held      UInt32,
  version   UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (issuer, taxon_key, owner);

-- The ledger ranges whose NFTs must be rebuilt after a re-ingest, as agg_dirty is for hours.
CREATE TABLE IF NOT EXISTS nft_dirty
(
  from_ledger UInt32,
  to_ledger   UInt32,
  created_at  DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(created_at)
ORDER BY (from_ledger, to_ledger);
