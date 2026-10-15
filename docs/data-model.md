# Data model & ClickHouse schema

This is the definitive reference for the GateHub XRPL Data API storage layer.

All DDL lives in [`packages/shared/schema`](../packages/shared/schema):

- [`001_tables.sql`](../packages/shared/schema/001_tables.sql) — the 11 base tables.
- [`002_materialized_views.sql`](../packages/shared/schema/002_materialized_views.sql) — 4 analytics target tables + 6 materialized views that feed them.

It is applied by `pnpm ch:migrate` (see [Migrations](#migrations)). Rows are written by the
syncer's [`ClickHouseDataProcessorService`](../apps/syncer/src/processor/clickhouse-data-processor.service.ts),
which maps the output of the parser suite (`packages/shared/src/parsers/*.ts`) into table rows.

---

## 1. Conventions

These conventions hold across every table unless noted.

### Engines

| Engine | Used by | Why |
| --- | --- | --- |
| `ReplacingMergeTree(version)` | All 11 base tables | The natural-identity sort key + a `version` column make ingestion idempotent: re-processing a ledger writes rows with the same key, and background merges keep only the highest-`version` copy. |
| `AggregatingMergeTree` | `exchange_candles_1m` | Holds partial aggregate *states* (`argMin`/`argMax` for OHLC open/close, `SimpleAggregateFunction` for high/low/volume). Merges combine states for the same key. |
| `SummingMergeTree` | `payment_volume_daily`, `exchange_volume_daily`, `stats_daily` | Merges sum the numeric columns for rows sharing the sort key, so a `GROUP BY` over the sort key (or a plain `sum()`) yields the rolled-up total. |

### `version = ledger_index`

Every base table is `ReplacingMergeTree(ledger_index)`. `ledger_index` is monotonic on the
XRPL, so "newest write wins" = "latest ledger wins". This matters most for `issuers`, whose
key is `(issuer, currency, counterparty)` (not unique per ledger): the highest `ledger_index`
is the most recent trustline snapshot. For the per-transaction tables the key is already unique
per transaction/node, so the version simply guarantees an exact re-insert collapses to one row.

### `PARTITION BY toYYYYMM(date)`

Every time-series table is partitioned by month of its primary `DateTime` column (`date`,
`close_time`, `minute`, or `day`). This gives:

- Partition pruning on time-range queries.
- Cheap retention: `ALTER TABLE ... DROP PARTITION '202401'` removes a whole month in O(1)
  instead of a row-by-row delete.

`issuers` is the only base table with **no** `PARTITION BY` — it is a latest-state snapshot, not
a time series, so there is nothing to prune by month.

### Time = unix seconds, UTC

All `DateTime` columns store UTC unix seconds. The syncer converts XRPL "ripple time" to unix
seconds before insert and formats it via `toClickHouseDateTime`. (Escrow `cancel_after` /
`finish_after` are converted from ripple time to unix seconds in the parser; other ripple-time
fields such as paychannel `expiration`/`cancel_after` are stored as the raw `UInt32` they arrive
as.)

### Amounts = `Float64`

Amount/volume columns are `Float64` for fast aggregation (sums, OHLC, VWAP). This trades exact
decimal fidelity for speed. **Full-fidelity values live in `transactions.tx_json`** (the raw
transaction JSON) and `transactions.meta_json` (the raw metadata) — anything needing exact
string amounts reads those. Drop amounts (XRP native) are converted to whole XRP via
`dropsToXrp` in the parsers before becoming `Float64`.

### `LowCardinality(String)` for codes

Low-cardinality enumerated columns (currency codes, transaction types, results, change types,
client tags) are `LowCardinality(String)`, which dictionary-encodes them for smaller storage and
faster filtering. High-cardinality strings (addresses, hashes, issuers, `tx_json`) are plain
`String`.

---

## 2. The CTID idempotency model

### What the CTID is

The **CTID** (Concise Transaction Identifier, XLS-37d) is a deterministic, globally-unique id
derived from `(ledger_index, tx_index, network_id)`. See
[`packages/shared/src/util/ctid.ts`](../packages/shared/src/util/ctid.ts):

```ts
getTxCtid(ledgerIndex, txIndex, networkId)
  => 'C' + ledgerIndexHex(7) + txIndexHex(4) + networkIdHex(4)   // 16-char hex string
```

- `ledgerIndex` → 7 hex chars (range-checked `0 … 0x0FFFFFFF`).
- `txIndex` → 4 hex chars (the transaction's position within the ledger; required — throws if
  missing).
- `networkId` → 4 hex chars (mainnet vs. a side network).

`getNodeCtid(...)` appends `.NNNN` (zero-padded node index) for a per-node row, though the
multi-row tables key on `tx_hash + node_index` directly rather than this composite string.

### Why it's the ReplacingMergeTree sort key

`transactions` and `payments` use `ORDER BY ctid`. Because the CTID is a pure function of
`(ledger, tx, network)`, re-processing the same transaction always produces the **same** key.
`ReplacingMergeTree(ledger_index)` then collapses the duplicate keys during background merges,
keeping the highest-`ledger_index` copy (which, for a given ctid, is byte-identical anyway).

The multi-row tables (`exchanges`, `balance_changes`, `affected_accounts`, `offers`) achieve the
same property with a composite key that includes `tx_hash` and `node_index` — i.e. the natural
identity of each affected-node row inside a transaction.

### What it guarantees on replay

This is the fix for review finding **C4**: the old Elasticsearch pipeline used auto-generated
random `_id`s, so any replay produced duplicate documents. With CTID-keyed
`ReplacingMergeTree`:

- A crashed/restarted backfill re-ingesting a ledger range → no double counting.
- An overlapping live + backfill window covering the same ledgers → no double counting.
- A manual re-run of any ledger range → no double counting.

The syncer reinforces this two ways: child rows carry their natural key, and ClickHouse
`insert_deduplicate` collapses identical re-inserted *blocks*. On a mid-batch crash, child rows
may be written without their ledger "commit marker"; the next run simply re-ingests those ledgers
and dedup makes it a no-op.

### Read-side implication: the API does NOT use `FINAL` on list endpoints

`ReplacingMergeTree` only guarantees dedup *eventually*, after a background merge. Between the
insert and the merge there can be transient duplicate rows. The API handles this deliberately:

- **List / range endpoints do NOT use `FINAL`.** Scanning with `FINAL` forces a merge-on-read
  across all parts and is expensive. Instead the API accepts that a freshly-ingested row might
  momentarily appear twice; background merges collapse it shortly after. For list traffic this is
  the right tradeoff (throughput over instantaneous exactness on the newest rows).
- **`FINAL` is kept only on selective single-row lookups**, where the cost is bounded and
  correctness matters immediately. Confirmed in the codebase:
  - `transactions.service.ts`: `FROM transactions FINAL WHERE hash = {hash} LIMIT 1`
  - `accounts.service.ts`: `FROM accounts_created FINAL WHERE account = {a} LIMIT 1`
  - `ledgers.service.ts`: `FROM ledgers FINAL WHERE … LIMIT 1`
- **Aggregations dedup explicitly via `argMax`** rather than `FINAL`. The network
  top-currencies / trustline rollup (`network.service.ts`) reads
  `argMax(balance, ledger_index)` in a subquery (grouped by `issuer, currency, counterparty`) to
  pick each trustline's latest balance before summing — equivalent to `FINAL` for that query but
  far cheaper.

**The tradeoff, stated plainly:** list endpoints favor speed and may show a transient duplicate
on the very newest rows until merges run; point lookups and rollups pay a small, bounded cost to
be exact. Never reach for `FINAL` on a scan-heavy list path.

---

## 3. Base tables

Each table below lists every column, its engine, sort key (= dedup key), partitioning, and the
parser/source that populates it. Defaults shown are the SQL `DEFAULT`s.

### 3.1 `ledgers`

**Purpose:** one row per validated ledger; the cursor source for backfill (`getInsertedLedgers`
queries it to skip already-ingested ledgers). Written as the per-batch "commit marker" after all
child rows.

| Column | Type | Meaning |
| --- | --- | --- |
| `ledger_index` | `UInt32` | Ledger sequence number. Also the dedup version. |
| `ledger_hash` | `String` | Ledger hash (`ledger_hash` or `hash` from the source). |
| `parent_hash` | `String` | Hash of the parent ledger. |
| `account_hash` | `String` | State (account) tree root hash. |
| `transaction_hash` | `String` | Transaction tree root hash. |
| `total_coins` | `String` | Total XRP drops in existence (kept as string — full fidelity). |
| `close_time` | `DateTime` | Ledger close time (UTC unix seconds). Partition key source. |
| `close_time_human` | `String` | Human-readable close time as delivered. |
| `close_time_resolution` | `UInt16` | Close-time rounding resolution. |
| `close_flags` | `UInt32` | Ledger close flags. |
| `closed` | `UInt8` DEFAULT 1 | Always 1 (validated/closed). |
| `parent_close_time` | `DateTime` | Parent ledger close time (falls back to `close_time`). |
| `tx_count` | `UInt32` DEFAULT 0 | Number of parsed transactions in the ledger. |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `ledger_index` — **PARTITION BY**
`toYYYYMM(close_time)`. **Source:** ledger header from the syncer worker (not a parser).

### 3.2 `transactions`

**Purpose:** the raw, full-fidelity transaction store. Holds the complete `tx_json` and
`meta_json`; every other per-transaction table is a projection/derivation of these. Bloom-filter
indexes on `hash` and `account` make point lookups and account scans cheap.

| Column | Type | Meaning |
| --- | --- | --- |
| `ctid` | `String` | CTID — dedup key. From `getTxCtid(ledger_index, meta.TransactionIndex, networkId)`. |
| `hash` | `String` | Transaction hash. Bloom-filter indexed (`idx_hash`). |
| `ledger_index` | `UInt32` | Ledger sequence. Also dedup version. |
| `tx_index` | `UInt16` | Position within the ledger (`meta.TransactionIndex`). |
| `tx_type` | `LowCardinality(String)` | `TransactionType` (e.g. `Payment`, `OfferCreate`). |
| `account` | `String` | Sending account. Bloom-filter indexed (`idx_account`). |
| `destination` | `String` DEFAULT '' | `Destination` if present, else `''`. |
| `result` | `LowCardinality(String)` | `meta.TransactionResult` (e.g. `tesSUCCESS`). |
| `date` | `DateTime` | Close time of the containing ledger (UTC unix seconds). |
| `tx_json` | `String` | Full raw transaction JSON — the canonical full-fidelity record. |
| `meta_json` | `String` | Full raw transaction metadata JSON. |

**Indexes:** `idx_hash` (bloom_filter, GRANULARITY 4), `idx_account` (bloom_filter, GRANULARITY 4).
**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `ctid` — **PARTITION BY**
`toYYYYMM(date)`. **Source:** raw transaction (every tx gets a row); written in
`clickhouse-data-processor.service.ts` directly from `tx.rawTransaction`.

### 3.3 `payments`

**Purpose:** one row per successful `Payment` (excluding payments to self, which the parser
treats as exchanges/no-ops). Amounts are `Float64`; feeds `payment_volume_daily` and
`stats_daily`.

| Column | Type | Meaning |
| --- | --- | --- |
| `ctid` | `String` | CTID — dedup key. |
| `tx_hash` | `String` | Transaction hash. |
| `source` | `String` | Sending account (`Account`). |
| `destination` | `String` | Receiving account (`Destination`). |
| `currency` | `LowCardinality(String)` | Delivered currency (`XRP` or the IOU code). |
| `issuer` | `String` DEFAULT '' | IOU issuer (resolved from RippleState; empty for XRP). |
| `amount` | `Float64` | Payment amount (`Amount`, drops→XRP for native). |
| `delivered_amount` | `Float64` | `DeliveredAmount`/`delivered_amount` (falls back to `Amount`). |
| `source_currency` | `LowCardinality(String)` DEFAULT '' | `SendMax` currency, else first source balance-change currency. |
| `max_amount` | `Float64` DEFAULT 0 | `SendMax` value. |
| `fee` | `Float64` | Transaction fee (drops→XRP). |
| `source_tag` | `Nullable(UInt32)` | `SourceTag`. |
| `destination_tag` | `Nullable(UInt32)` | `DestinationTag`. |
| `invoice_id` | `String` DEFAULT '' | `InvoiceID`. |
| `date` | `DateTime` | Ledger close time. |
| `ledger_index` | `UInt32` | Ledger sequence. Dedup version. |
| `tx_index` | `UInt16` | Position within the ledger. |
| `client` | `LowCardinality(String)` DEFAULT '' | Client tag from a `client` memo (`FromClientParser`). |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `ctid` — **PARTITION BY**
`toYYYYMM(date)`. **Source:** `PaymentParser` (`payment.parser.ts`), `ParsedPayment`. Issuer is
resolved from the affected `RippleState` nodes (`setIssuer`).

### 3.4 `exchanges`

**Purpose:** one row per filled offer node (DEX trade) inside a `Payment` or `OfferCreate`. The
base/counter pair is ordered canonically by the parser so a market always sorts the same way.
Feeds `exchange_candles_1m` and `exchange_volume_daily`.

| Column | Type | Meaning |
| --- | --- | --- |
| `tx_hash` | `String` | Transaction hash. |
| `node_index` | `UInt16` | Index of the affected Offer node within the tx. |
| `base_currency` | `LowCardinality(String)` | Base currency (canonical ordering). |
| `base_issuer` | `String` DEFAULT '' | Base issuer (empty for XRP). |
| `base_amount` | `Float64` | Base side traded amount. |
| `counter_currency` | `LowCardinality(String)` | Counter currency. |
| `counter_issuer` | `String` DEFAULT '' | Counter issuer (empty for XRP). |
| `counter_amount` | `Float64` | Counter side traded amount. |
| `rate` | `Float64` | Exchange rate (from `BookDirectory` quality, inverted to match canonical ordering). |
| `buyer` | `String` | Buying party (swaps with seller under canonical ordering). |
| `seller` | `String` | Selling party. |
| `taker` | `String` | Transaction sender (the taker). |
| `provider` | `String` | Offer owner (the maker), `FinalFields.Account`. |
| `sequence` | `UInt32` | Offer sequence number. |
| `date` | `DateTime` | Ledger close time. |
| `tx_type` | `LowCardinality(String)` | `Payment` or `OfferCreate`. |
| `tx_index` | `UInt16` | Position within the ledger. |
| `ledger_index` | `UInt32` | Ledger sequence. Dedup version. |
| `client` | `LowCardinality(String)` DEFAULT '' | Client tag. |
| `autobridged_currency` | `String` DEFAULT '' | Autobridged leg currency (OfferCreate bridged through XRP). |
| `autobridged_issuer` | `String` DEFAULT '' | Autobridged leg issuer. |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY**
`(base_currency, base_issuer, counter_currency, counter_issuer, date, tx_hash, node_index)` —
**PARTITION BY** `toYYYYMM(date)`. **Source:** `ExchangeParser` (`exchanges.parser.ts`),
`ParsedExchange[]`. Derived from `ModifiedNode`/`DeletedNode` Offer nodes that have
`PreviousFields.TakerPays`/`TakerGets`.

### 3.5 `balance_changes`

**Purpose:** one row per affected balance leg of a transaction (the fee leg, exchange legs,
RippleState high/low legs, and escrow/paychannel legs). `type` classifies the leg.

| Column | Type | Meaning |
| --- | --- | --- |
| `account` | `String` | Account whose balance changed. |
| `counterparty` | `String` DEFAULT '' | The other party of a RippleState (trustline) leg. |
| `currency` | `LowCardinality(String)` | Currency of the change (`XRP` or IOU). |
| `change` | `Float64` | Signed delta. |
| `final_balance` | `Float64` | Balance after the change. |
| `type` | `LowCardinality(String)` DEFAULT '' | Leg classification (see below). |
| `date` | `DateTime` | Ledger close time. |
| `ledger_index` | `UInt32` | Ledger sequence. Dedup version. |
| `tx_index` | `UInt16` | Position within the ledger. |
| `node_index` | `Int16` | Affected-node index; `-1` for the synthetic fee leg. |
| `tx_hash` | `String` | Transaction hash. |
| `client` | `LowCardinality(String)` DEFAULT '' | Client tag. |

`type` values: `fee`, `exchange`, `intermediary`, `payment_source`, `payment_destination`,
`escrow_create`, `escrow_cancel`, `escrow_finish`, `paychannel_fund`, `paychannel_payout`, or
`''`.

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY**
`(account, currency, date, tx_hash, node_index)` — **PARTITION BY** `toYYYYMM(date)`.
**Source:** `BalanceChangesParser` (`balance-changes.parser.ts`), `ParsedBalanceChange[]`. Parses
`AccountRoot` and `RippleState` nodes; cross-references `Escrow`/`PayChannel` nodes to label
escrow/paychannel legs. Note: the table stores only the core columns above — the parser's
extended escrow/paychannel fields (`escrow_balance_change`, `paychannel_*`, etc.) are computed for
classification but not persisted as columns here.

### 3.6 `affected_accounts`

**Purpose:** an account-activity index — one row per `(account, transaction)`, for every account
touched by a transaction's metadata. Powers "transactions for account" lookups.

| Column | Type | Meaning |
| --- | --- | --- |
| `account` | `String` | An account affected by the transaction (XRPL `r...` addresses only). |
| `tx_result` | `LowCardinality(String)` | `meta.TransactionResult`. |
| `tx_type` | `LowCardinality(String)` | Transaction type. |
| `date` | `DateTime` | Ledger close time. |
| `ledger_index` | `UInt32` | Ledger sequence. Dedup version. |
| `tx_index` | `UInt16` | Position within the ledger. |
| `tx_hash` | `String` | Transaction hash. |
| `client` | `LowCardinality(String)` DEFAULT '' | Client tag. |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `(account, date, tx_hash)` —
**PARTITION BY** `toYYYYMM(date)`. **Source:** `AffectedAccountsParser`
(`affected-accounts.parser.ts`), via `getAffectedAccounts(metadata)`.

### 3.7 `accounts_created`

**Purpose:** one row per newly created account (an `AccountRoot` `CreatedNode`).

| Column | Type | Meaning |
| --- | --- | --- |
| `account` | `String` | The created account. Dedup key. |
| `parent` | `String` | Funding account (`Account` of the creating tx). |
| `balance` | `Float64` | Starting balance (drops→XRP). |
| `date` | `DateTime` | Ledger close time. |
| `ledger_index` | `UInt32` | Ledger sequence. Dedup version. |
| `tx_index` | `UInt16` | Position within the ledger. |
| `tx_hash` | `String` | Creating transaction hash. |
| `client` | `LowCardinality(String)` DEFAULT '' | Client tag. |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `account` — **PARTITION BY**
`toYYYYMM(date)`. **Source:** `AccountsCreatedParser` (`accounts-created.parser.ts`). Feeds
`stats_daily`.

### 3.8 `offers`

**Purpose:** the offer lifecycle — one row per affected Offer node across create / partial-fill /
fill / cancel / replace events.

| Column | Type | Meaning |
| --- | --- | --- |
| `tx_type` | `LowCardinality(String)` | `Payment`, `OfferCreate`, or `OfferCancel`. |
| `node_type` | `LowCardinality(String)` | `CreatedNode` / `ModifiedNode` / `DeletedNode`. |
| `account` | `String` | Offer owner. |
| `offer_sequence` | `UInt32` | Offer's `Sequence`. |
| `expiration` | `Nullable(UInt32)` | Offer `Expiration`. |
| `book_directory` | `String` | Order-book directory id. |
| `tx_hash` | `String` | Transaction hash. |
| `date` | `DateTime` | Ledger close time. |
| `ledger_index` | `UInt32` | Ledger sequence. Dedup version. |
| `tx_index` | `UInt16` | Position within the ledger. |
| `node_index` | `UInt16` | Affected-node index. |
| `prev_offer_sequence` | `Nullable(UInt32)` | Predecessor offer sequence (on replace). |
| `next_offer_sequence` | `Nullable(UInt32)` | Successor offer sequence. |
| `taker_pays_currency` | `LowCardinality(String)` | TakerPays currency. |
| `taker_pays_value` | `Float64` | TakerPays value. |
| `taker_gets_currency` | `LowCardinality(String)` | TakerGets currency. |
| `taker_gets_value` | `Float64` | TakerGets value. |
| `rate` | `Float64` DEFAULT 0 | Offer quality/rate from `BookDirectory`. |
| `pays_change` | `Float64` DEFAULT 0 | Change in TakerPays vs. previous fields. |
| `gets_change` | `Float64` DEFAULT 0 | Change in TakerGets vs. previous fields. |
| `change_type` | `LowCardinality(String)` DEFAULT '' | `create` / `partial_fill` / `fill` / `cancel` / `replace` / `unfunded_cancel` / `unfunded_partial_fill`. |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `(account, date, tx_hash, node_index)`
— **PARTITION BY** `toYYYYMM(date)`. **Source:** `OffersParser` (`offers.parser.ts`),
`ParsedOffer[]`.

### 3.9 `issuers`

**Purpose:** the latest trustline balance snapshot per `(issuer, currency, counterparty)`.
Derived from RippleState nodes — no `account_lines` RPC (fixes review finding **H6**). Newest
ledger wins.

| Column | Type | Meaning |
| --- | --- | --- |
| `issuer` | `String` | IOU issuer (the side issuing the currency). |
| `currency` | `LowCardinality(String)` | Currency code. |
| `counterparty` | `String` | Trustline holder. |
| `balance` | `Float64` | Outstanding balance held (absolute value). |
| `date` | `DateTime` | Close time of the snapshot's ledger. |
| `ledger_index` | `UInt32` | Snapshot ledger. **Dedup version — newest wins.** |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `(issuer, currency, counterparty)` —
**PARTITION BY** *(none — latest-state snapshot, not a time series)*. **Source:** `IssuersParser`
(`issuers.parser.ts`). Issuer vs. counterparty is decided by the sign of the signed RippleState
balance. The API reads the latest balance with `argMax(balance, ledger_index)` rather than
`FINAL`.

### 3.10 `escrows`

**Purpose:** one row per successful escrow transaction (`EscrowCreate` / `EscrowCancel` /
`EscrowFinish`).

| Column | Type | Meaning |
| --- | --- | --- |
| `tx_hash` | `String` | Transaction hash. Dedup key. |
| `tx_type` | `LowCardinality(String)` | Escrow tx type. |
| `account` | `String` | Sending account. |
| `owner` | `String` DEFAULT '' | Escrow owner (`Account` or `Owner`). |
| `destination` | `String` DEFAULT '' | Escrow destination. |
| `amount` | `Float64` DEFAULT 0 | Escrow amount (drops→XRP; from tx or node). |
| `fee` | `Float64` | Transaction fee (drops→XRP). |
| `flags` | `String` DEFAULT '' | Flags as string. |
| `destination_tag` | `Nullable(UInt32)` | Destination tag. |
| `source_tag` | `Nullable(UInt32)` | Source tag. |
| `create_tx_seq` | `Nullable(UInt32)` | Sequence / OfferSequence of the create. |
| `create_tx` | `String` DEFAULT '' | `PreviousTxnID` or this tx hash. |
| `condition` | `String` DEFAULT '' | Crypto-condition. |
| `fulfillment` | `String` DEFAULT '' | Condition fulfillment. |
| `cancel_after` | `Nullable(UInt32)` | CancelAfter (ripple time → unix seconds). |
| `finish_after` | `Nullable(UInt32)` | FinishAfter (ripple time → unix seconds). |
| `date` | `DateTime` | Ledger close time. |
| `ledger_index` | `UInt32` | Ledger sequence. Dedup version. |
| `tx_index` | `UInt16` | Position within the ledger. |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `tx_hash` — **PARTITION BY**
`toYYYYMM(date)`. **Source:** `EscrowParser` (`escrow.parser.ts`), `ParsedEscrow`.

### 3.11 `paychannels`

**Purpose:** one row per successful payment-channel transaction (`PaymentChannelCreate` /
`PaymentChannelFund` / `PaymentChannelClaim`).

| Column | Type | Meaning |
| --- | --- | --- |
| `tx_hash` | `String` | Transaction hash. Dedup key. |
| `tx_type` | `LowCardinality(String)` | Paychannel tx type. |
| `account` | `String` | Sending account. |
| `source` | `String` DEFAULT '' | Channel source (node `Account`). |
| `destination` | `String` DEFAULT '' | Channel destination. |
| `channel` | `String` DEFAULT '' | Channel id. |
| `amount` | `Float64` DEFAULT 0 | Channel amount (drops→XRP). |
| `balance` | `Float64` DEFAULT 0 | Channel claimed balance (drops→XRP). |
| `settle` | `Nullable(UInt32)` | SettleDelay. |
| `destination_tag` | `Nullable(UInt32)` | Destination tag. |
| `source_tag` | `Nullable(UInt32)` | Source tag. |
| `fee` | `Float64` | Transaction fee (drops→XRP). |
| `flags` | `Nullable(UInt32)` | Flags (numeric only). |
| `cancel_after` | `Nullable(UInt32)` | CancelAfter. |
| `expiration` | `Nullable(UInt32)` | Channel expiration. |
| `date` | `DateTime` | Ledger close time. |
| `ledger_index` | `UInt32` | Ledger sequence. Dedup version. |
| `tx_index` | `UInt16` | Position within the ledger. |

**ENGINE** `ReplacingMergeTree(ledger_index)` — **ORDER BY** `tx_hash` — **PARTITION BY**
`toYYYYMM(date)`. **Source:** `PaychanParser` (`paychan.parser.ts`), `ParsedPayChannel`.

---

## 4. Materialized views (analytics)

These replace the old per-request Elasticsearch Painless scripts (review finding **M2**) with
incrementally-maintained aggregates. Each is a target `*MergeTree` table plus a
`MATERIALIZED VIEW … TO target` that runs its SELECT on every insert into the source table, so
the API only ever reads small, pre-rolled-up state. **A materialized view only sees rows inserted
*after* it is created** — to backfill an MV over historical data you must
`INSERT INTO target SELECT … FROM source` for the existing range.

### 4.1 `exchange_candles_1m` (← `exchanges`)

**Target table:**

| Column | Type | Meaning |
| --- | --- | --- |
| `base_currency` | `LowCardinality(String)` | Market base currency. |
| `base_issuer` | `String` | Base issuer. |
| `counter_currency` | `LowCardinality(String)` | Market counter currency. |
| `counter_issuer` | `String` | Counter issuer. |
| `minute` | `DateTime` | 1-minute bucket start. |
| `open` | `AggregateFunction(argMin, Float64, DateTime)` | OHLC open: rate at the earliest trade in the minute. |
| `close` | `AggregateFunction(argMax, Float64, DateTime)` | OHLC close: rate at the latest trade. |
| `high` | `SimpleAggregateFunction(max, Float64)` | Max rate. |
| `low` | `SimpleAggregateFunction(min, Float64)` | Min rate. |
| `base_volume` | `SimpleAggregateFunction(sum, Float64)` | Σ base_amount. |
| `counter_volume` | `SimpleAggregateFunction(sum, Float64)` | Σ counter_amount. |
| `trade_count` | `SimpleAggregateFunction(sum, UInt64)` | Trade count. |

**ENGINE** `AggregatingMergeTree` — **ORDER BY**
`(base_currency, base_issuer, counter_currency, counter_issuer, minute)` — **PARTITION BY**
`toYYYYMM(minute)`.

**MV SELECT** (`exchange_candles_1m_mv`): groups `exchanges` by market + `toStartOfMinute(date)`,
storing `argMinState(rate, date)` / `argMaxState(rate, date)` for open/close, `max/min(rate)` for
high/low, `sum(base_amount)`/`sum(counter_amount)` for volume, and `toUInt64(count())` for
trade_count. The `argMin/argMax` columns store partial *states* (hence read with `*Merge`); the
`SimpleAggregateFunction` columns store directly-mergeable partials.

**How the API queries it** (`exchanges.service.ts`): roll the 1-minute candles up to any interval
with `*Merge` + `GROUP BY`:

```sql
SELECT toStartOfInterval(minute, INTERVAL {n} SECOND) AS bucket,
       argMinMerge(open)  AS open,
       argMaxMerge(close) AS close,
       max(high) AS high, min(low) AS low,
       sum(base_volume)    AS base_volume,
       sum(counter_volume) AS counter_volume,
       sum(trade_count)    AS trade_count
FROM exchange_candles_1m
WHERE base_currency = … AND counter_currency = …
GROUP BY bucket ORDER BY bucket;
```

VWAP is computed straight from `exchanges` as `sum(counter_amount) / nullIf(sum(base_amount), 0)`.

### 4.2 `payment_volume_daily` (← `payments`)

**Target table:**

| Column | Type | Meaning |
| --- | --- | --- |
| `currency` | `LowCardinality(String)` | Payment currency. |
| `issuer` | `String` | Issuer. |
| `day` | `Date` | Day bucket. |
| `total_amount` | `Float64` | Σ amount. |
| `payment_count` | `UInt64` | Payment count. |

**ENGINE** `SummingMergeTree` — **ORDER BY** `(currency, issuer, day)` — **PARTITION BY**
`toYYYYMM(day)`. **MV SELECT** (`payment_volume_daily_mv`): groups `payments` by
`currency, issuer, toDate(date)` with `sum(amount)` and `toUInt64(count())`.

**How the API queries it** (`network.service.ts`): `SummingMergeTree` means a plain `sum()` over
the (already partially-summed) rows yields the total —
`SELECT sum(total_amount) AS total, sum(payment_count) AS count FROM payment_volume_daily WHERE …`.

### 4.3 `exchange_volume_daily` (← `exchanges`)

**Target table:**

| Column | Type | Meaning |
| --- | --- | --- |
| `base_currency` | `LowCardinality(String)` | Base currency. |
| `base_issuer` | `String` | Base issuer. |
| `day` | `Date` | Day bucket. |
| `total_base_amount` | `Float64` | Σ base_amount. |
| `total_counter_amount` | `Float64` | Σ counter_amount. |
| `trade_count` | `UInt64` | Trade count. |

**ENGINE** `SummingMergeTree` — **ORDER BY** `(base_currency, base_issuer, day)` — **PARTITION BY**
`toYYYYMM(day)`. **MV SELECT** (`exchange_volume_daily_mv`): groups `exchanges` by
`base_currency, base_issuer, toDate(date)` with `sum(base_amount)`, `sum(counter_amount)`,
`toUInt64(count())`.

**How the API queries it** (`network.service.ts`):
`SELECT sum(total_base_amount) AS total, sum(trade_count) AS count FROM exchange_volume_daily WHERE …`.

### 4.4 `stats_daily` (← `payments`, `exchanges`, `accounts_created`)

A single `SummingMergeTree` fed by **three** MVs, one per source table. Each MV emits the count
for its own source and `0` for the others, so the summing engine adds the per-day columns.

**Target table:**

| Column | Type | Meaning |
| --- | --- | --- |
| `day` | `Date` | Day bucket. |
| `payments` | `UInt64` | Daily payment count. |
| `exchanges` | `UInt64` | Daily exchange (trade) count. |
| `accounts_created` | `UInt64` | Daily new-account count. |

**ENGINE** `SummingMergeTree` — **ORDER BY** `day` — **PARTITION BY** `toYYYYMM(day)`.

- `stats_daily_payments_mv`: `SELECT toDate(date) day, count() payments, 0 exchanges, 0 accounts_created FROM payments GROUP BY day`
- `stats_daily_exchanges_mv`: `… 0, count() exchanges, 0 … FROM exchanges …`
- `stats_daily_accounts_mv`: `… 0, 0, count() accounts_created FROM accounts_created …`

**How the API queries it:** `SELECT day, sum(payments), sum(exchanges), sum(accounts_created) FROM stats_daily WHERE … GROUP BY day`.

---

## 5. Migrations

Runner: [`packages/shared/src/clickhouse/migrate.ts`](../packages/shared/src/clickhouse/migrate.ts).

```
pnpm --filter @gatehub/data-api-shared ch:migrate   # alias: pnpm ch:migrate
```

**How it works:**

1. Ensures the target database and a `schema_migrations` bookkeeping table exist
   (`schema_migrations(filename String, applied_at DateTime DEFAULT now()) ENGINE = MergeTree ORDER BY filename`).
2. Reads which `*.sql` files have already been recorded.
3. Lists `packages/shared/schema/*.sql` sorted **lexically** and applies only the not-yet-applied
   files, splitting each on `;` at end-of-line and skipping `--` comment lines, running statement
   by statement.
4. Records each applied filename in `schema_migrations` (an audit trail; also avoids needless
   re-runs).

**Idempotent DDL.** Every statement is `CREATE … IF NOT EXISTS`, so even a re-applied file is a
no-op — the tracking table is an optimization/audit aid, not the correctness guarantee.

**Adding a new migration.** Create a new file with the next ordinal,
e.g. `packages/shared/schema/003_add_codecs.sql`. Because files apply in lexical order and the
runner skips already-recorded files, the new file runs once on the next `ch:migrate`. For schema
changes to an existing deployment use `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` (or
`CREATE … IF NOT EXISTS` for new objects) so it stays idempotent. Then populate the column in the
relevant parser, map it in `clickhouse-data-processor.service.ts`, and select it in the API
service.

**Production approach.** Run migrations as a **one-shot, controlled step** — a CI job or the
`migrate` service in the production compose — **not** concurrently from every syncer replica and
not on boot. (The runner explicitly warns against concurrent runs.)

---

## 6. Sizing & retention

- **`transactions.tx_json` (+ `meta_json`) is the bulk of storage.** They hold the full raw
  JSON for every transaction; the derived tables are comparatively small projections. Size
  planning and retention should focus here first.
- **Monthly partitioning enables cheap retention.** Because every time-series table is
  `PARTITION BY toYYYYMM(date)`, dropping old data is a single
  `ALTER TABLE <t> DROP PARTITION 'YYYYMM'` per table per month (O(1), no row scan), and a
  partition-level TTL can automate it. Apply the most aggressive policy to `transactions`; keep
  the small derived/aggregate tables longer.
- **Codecs (future optimization).** The bulky JSON columns are strong candidates for column
  codecs — e.g. `tx_json String CODEC(ZSTD(3))` (and likewise `meta_json`) — which typically
  compress JSON several-fold at modest CPU cost. Add via an
  `ALTER TABLE transactions MODIFY COLUMN tx_json String CODEC(ZSTD(3))` in a new
  `003_*.sql` migration; new parts adopt the codec and old parts re-encode on merge.
- `issuers` has no partitioning by design (latest-state snapshot); its size is bounded by the
  number of distinct `(issuer, currency, counterparty)` trustlines, not by time.

---

## 7. Relationship overview (ER-ish)

There are no enforced foreign keys (ClickHouse has none); tables relate by shared natural keys.

```
                         ┌──────────────┐
                         │   ledgers    │   PK ledger_index  (backfill cursor / commit marker)
                         └──────┬───────┘
                                │ ledger_index
                                │
                         ┌──────▼───────────────────────────────┐
                         │            transactions               │  PK ctid
                         │   (full tx_json + meta_json)          │  hash, account (bloom)
                         └──────┬────────────────────────────────┘
        ctid / tx_hash         │  one transaction fans out into derived rows
   ┌──────────────┬────────────┼───────────────┬───────────────┬───────────────┐
   ▼              ▼            ▼                ▼               ▼               ▼
payments      exchanges   balance_changes  affected_accounts  offers     escrows / paychannels
(ctid)        (tx_hash,   (account,        (account,          (account,   (tx_hash)
              node_index)  currency,        date, tx_hash)     date,
                           date, tx_hash,                      tx_hash,
                           node_index)                         node_index)
                  │
                  │ derived from RippleState nodes
                  ▼
              issuers   PK (issuer, currency, counterparty), latest by ledger_index

accounts_created  PK account  (parent → funding account)
```

**Join keys in practice:**

- **`tx_hash`** links `payments`, `exchanges`, `balance_changes`, `affected_accounts`, `offers`,
  `escrows`, `paychannels`, and `accounts_created` back to the full record in `transactions`
  (`transactions.hash`). `transactions` itself keys on `ctid`; `payments` carries both `ctid` and
  `tx_hash`.
- **`account`** (and `source`/`destination`/`counterparty`/`provider`/`taker`) is the entity key.
  `affected_accounts` is the activity index; `balance_changes` and `issuers` give per-account
  balances; `accounts_created` records origin.
- **`ledger_index`** ties everything back to `ledgers` and is the dedup **version** on every base
  table.
- **`ctid`** = `(ledger_index, tx_index, network_id)` — the dedup key for `transactions` and
  `payments` and the conceptual identity behind the composite keys on the multi-row tables.
- The **materialized views** roll up `payments`/`exchanges`/`accounts_created` by time bucket;
  they share the source tables' currency/issuer/market columns but no per-row key.
