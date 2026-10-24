# Data model and ClickHouse schema

The source of truth is the migration files of [`packages/shared/schema/`](../packages/shared/schema/):
[`001_baseline.sql`](../packages/shared/schema/001_baseline.sql) and
[`002_validators_amendments.sql`](../packages/shared/schema/002_validators_amendments.sql) and
[`003_account_market_aggregates.sql`](../packages/shared/schema/003_account_market_aggregates.sql) and
[`004_amm_fee_estimates.sql`](../packages/shared/schema/004_amm_fee_estimates.sql) and
[`005_account_states.sql`](../packages/shared/schema/005_account_states.sql) and
[`007_path_payments.sql`](../packages/shared/schema/007_path_payments.sql) and
[`009_account_network_names.sql`](../packages/shared/schema/009_account_network_names.sql) and
[`010_export_jobs.sql`](../packages/shared/schema/010_export_jobs.sql) (applied in file-name order, per network
database, by the `migrate` job); the row types are in
[`packages/shared/src/clickhouse/rows.ts`](../packages/shared/src/clickhouse/rows.ts) and the table names in `tables.ts` (the `Table`
enum: queries use `${Table.X}`, never string literals). **53 tables** per network database, in eight groups:

| Group | Tables | Written by |
| --- | --- | --- |
| Ledger-derived (21) | `ledgers`, `ledger_by_hash`, `transactions`, `tx_by_hash`, `tx_by_type`, `account_transactions`, `account_tx_by_sequence`, `payments`, `payments_by_currency`, `account_payments`, `exchanges`, `account_exchanges`, `balance_changes`, `accounts_created`, the five AMM tables `amm_pool_states`, `amm_pool_touches`, `amm_liquidity`, `account_amm_liquidity`, `amm_governance`, the account state history `account_states` (migration 005), and `path_payments` (migration 007) | the `ingest` worker and `range-ingest` (one `LedgerWriter`) |
| Node-sourced (3) | `fee_stats`, `validations`, `validator_manifests` | the `fee_stats` and `validations` workers |
| Validators and amendments (10, migration 002) | `validator_validations`, `validator_seen`, `unl_lists`, `unl_publishers`, `validator_domains`, `network_state`, `amendment_features`, `validator_votes`, `amendment_tallies`, `validator_agreement_hourly` | the `validations` worker (the first two) and the `validators` worker (the rest) |
| Aggregates (5) | `stats_hourly`, `volume_daily`, `volume_live`, `amm_pools`, `amm_daily` | the `aggregator` worker |
| Account and market aggregates (9, migration 003) | `native_rates_daily`, `pair_hourly`, `markets_live`, `account_rollup_state`, `account_partition_rows`, `account_rollup_days`, `account_lines_daily`, `account_tx_daily`, `account_trades_daily` | the `aggregator` worker (jobs `rates_daily`, `pair_hourly`, `markets_live`, `account_rollups`) |
| Operator-written (1, migration 009) | `account_network_names` | the operator, by hand, with plain SQL inserts ([operations](operations.md#name-an-account-on-one-network)) |
| Internal (3) | `ingest_log`, `agg_dirty`, `syncer_lease` | the syncer |
| Exports (1, migration 010) | `export_jobs` | the api (`queued`) and the exporter (`running`, `done`, `failed`) |

Plus `schema_migrations` (the migration runner's bookkeeping). Apart from the network databases, one **shared database** on the
same server holds what belongs to an address on every network (account names and labels, [ADR-0014](adr/0014-address-names-and-labels-in-a-shared-database.md)),
with its own migrations: see [section 8](#8-the-shared-database). The previous design (CTID-keyed tables, insert-triggered materialized
views, offers/issuers/escrows/paychannels tables) is gone: see [ADR-0002](adr/0002-ctid-idempotent-ingest.md) (superseded),
[ADR-0007](adr/0007-ledger-index-axis-and-secondary-tables.md) and [ADR-0008](adr/0008-no-aggregate-materialized-views.md).

## 1. Conventions

### `ledger_index` is the time axis

Close times grow monotonically with `ledger_index`. A request's `start`/`end` is resolved once to a ledger range through the
`minmax` index on `ledgers.close_time` (LRU-cached in the API), and every list is a range of a primary key. Markers encode the
key of the last row (`ledger_index, tx_index[, node_index]`) and never a DateTime.

### Engines and partitions

| Kind | Engine | Partition | Why |
| --- | --- | --- | --- |
| Ledger-prefixed (`ledgers`, `transactions`, `payments`, `amm_pool_touches`, `path_payments`) | `ReplacingMergeTree` | **P6**: `intDiv(ledger_index, 1000000)` | A commit and a recovery delete never span two partitions; deletes are partition-scoped |
| Prefix-keyed secondary tables, `exchanges`, the AMM tables ordered by pool or account, and `account_states` | `ReplacingMergeTree` | **P7**: `intDiv(ledger_index, 10000000)` | Fewer, larger partitions for tables ordered by something other than the ledger |
| `accounts_created`, `volume_live`, `stats_hourly`, `amm_pools`, internal | `ReplacingMergeTree` | none (`volume_daily` and `amm_daily`: `toYYYYMM(day)`) | Small tables |
| `fee_stats` | `MergeTree` | `toYYYYMM(ts)` | Append-only samples |
| `account_network_names` (migration 009) | `MergeTree` | none | Append-only, the operator's history; small |
| The nine tables of migration 003 | `ReplacingMergeTree(version)` | `toYear(day)` for the rates and the account rollups, `toDate(hour)` for `pair_hourly` (TTL 45 days, `ttl_only_drop_parts = 1`), none for the others | Recomputable aggregates written as complete sets; a year of days is a small partition, an hour table expires by whole days |
| `validations` | `AggregatingMergeTree` | `toYYYYMMDD(last_datetime)`, TTL 90 days | Partial sightings add up |
| `validator_validations` | `AggregatingMergeTree` | `intDiv(ledger_index, 100000)`, TTL 7 days, `ttl_only_drop_parts = 1` | Sightings add up; a partition is about four days of ledgers, so expiry drops whole parts |
| `validator_seen` | `AggregatingMergeTree` | none, no TTL | One row per validator: min / max / max |
| The other validators and amendments tables | `ReplacingMergeTree` | none | Small tables, newest row (or newest `version`) wins |

`ORDER BY` of a `ReplacingMergeTree` is its **natural unique key**. That is a safety net only: list queries never use `FINAL`, and
recovery deletes before it rewrites ([clickhouse](clickhouse.md#the-final-rule)). The 21 ledger-derived tables carry
`non_replicated_deduplication_window = 1000` so that a retried insert with the same `insert_deduplication_token` is dropped; the
two collector tables `validator_validations` and `validator_seen` (not ledger tables) carry a window of 100 for the same reason. The nine tables of
migration 003 have no window: a set is written whole under a new `version`, so a retry is idempotent without one.
There are no projections (they conflict with lightweight `DELETE`) and no materialized views.

### Value types

- **Times:** `DateTime('UTC')` (unix seconds) for ledger times; `DateTime64(3, 'UTC')` for sampled data (`fee_stats.ts`,
  validations). JSON inserts of a `DateTime64(3)` take **seconds** with a fraction.
- **Amounts** are exact decimal **strings** in whole units (`amount`, `base_amount`, `final_balance`, ...). A `*_f Float64` shadow
  exists only where the server aggregates or sorts numerically (`delivered_amount_f`, `base_amount_f`, `rate_f`, `final_balance_f`,
  `amount_f`, `converted_f`). Native amounts that are drops are `UInt64` (`ledgers.total_coins`, `fee_*`, `transactions.fee`,
  `payments.fee`). Sums that must be exact use `Decimal256(30)` on the stored text.
- `LowCardinality(String)` for codes (currencies, types, results). The native currency is stored with an **empty issuer** (`''`).
- `sequence`, `tx_index`, `ledger_index` are `UInt32`; `node_index` is `UInt16` (exchanges) or `Int16` (balance changes, where the fee
  row is `-1`).

### Idempotency and the commit marker

A ledger is **committed exactly when its `ledgers` row exists.** The writer inserts the child tables, then `ledger_by_hash`, then
`ledgers`. A crash in between leaves child rows of an uncommitted ledger, which no reader looks at and which recovery deletes
(everything above the checkpoint = `max(ledgers.ledger_index)`). Replays are exact: the same ledger always produces the same keys
and the same dedup tokens, and a rewrite (`--reprocess`) deletes first. This replaces the CTID-based design of ADR-0002; the CTID
helpers survive in `packages/shared/src/util/ctid.ts` only as utilities.

Readers therefore see either all of a ledger or none of it, with two caveats: rows of an uncommitted ledger can be visible to a
query that reads a child table directly until recovery has removed them (the API's lists resolve their range through `ledgers`),
and a ledger rewritten with `--reprocess` is briefly absent.

### Read-side rule: no `FINAL` on lists

Lists read in key order with a plain `LIMIT` (the page and room for duplicates) and dedupe outside that read with `LIMIT 1 BY <key>`,
so ClickHouse stops after the page ([clickhouse](clickhouse.md#reading-a-page-what-stops-the-read)); aggregates read the same deduplicated rows;
rollups are read by newest `version`; `validations` is read with `GROUP BY` and added up. See [clickhouse](clickhouse.md#the-final-rule)
and [ADR-0003](adr/0003-no-final-on-list-queries.md).

## 2. Ledger-derived tables

`ORDER BY` is the key; `Partition` is P6 or P7 above; "read by" lists the endpoints ([api-reference](api-reference.md)).

### `ledgers` (P6, `ORDER BY ledger_index`)
Header and summary of a ledger; **the commit marker**. Columns: `ledger_index UInt32`, `ledger_hash`, `parent_hash`, `account_hash`,
`transaction_hash` (String), `total_coins UInt64`, `close_time`, `parent_close_time` (DateTime), `close_time_resolution UInt8`,
`close_flags UInt8`, `tx_count UInt32`, `type_counts` / `result_counts Map(LowCardinality(String), UInt32)`, `payments_count`,
`exchanges_count` (order-book exchanges and AMM swaps), `accounts_created UInt32`, `fee_total`, `fee_min`, `fee_max UInt64` (drops), `parser_version UInt16` (2 since the AMM parser: a ledger written by version 1 has no AMM rows, see [backfill](backfill.md#amm-data-re-ingest); 3 since the account state history: a ledger written by an older version has no `account_states` rows, and the state tables cover only the ledgers above the newest one an older version wrote, see [`account_states`](#account_states-p7-order-by-account-ledger_index-tx_index-node_index); 4 since the path payments parser: a ledger written by an older version has no `path_payments` rows, see [backfill](backfill.md#path-payments-re-ingest)),
`ingested_at DateTime DEFAULT now()`; skip index `close_time_mm` (`minmax` on `close_time`, granularity 1). Read by `/ledgers`,
`/last_validated`, `/network/fees`, the stats rollup, the date resolver of every list.

### `ledger_by_hash` (P7, `ORDER BY ledger_hash`)
`ledger_hash`, `ledger_index`. Read by `/ledgers/{hash}` (the answer requires `ledgers.ledger_hash` to agree).

### `transactions` (P6, `ORDER BY (ledger_index, tx_index)`, `index_granularity = 1024`)
`ledger_index`, `tx_index`, `hash`, `tx_type`, `result`, `account`, `sequence UInt32`, `fee UInt64`, `close_time`, `tx_json String
ZSTD(3)` (the transaction **without** metadata), `meta_json String ZSTD(3)` (the metadata, unaltered). Every transaction object of the
API is made from here. This is the largest table.

`account` is the sender (`Account`). Pseudo-transactions carry the zero account `rrrrrrrrrrrrrrrrrrrrrhoLvTp` there; Xahau's
`UNLReport` (one per active validator in every flag ledger, the ledgers whose index is divisible by 256) leaves its `Account` empty
(`""`, a zero-length AccountID), and is indexed under the zero account too (`account`, `account_tx_by_sequence`, the `parent` of
`accounts_created`), while `tx_json` keeps the node's `""`. The API shows `""` like the node, and its `binary=true` form is the
node's zero-length field (`81 00`).

### `tx_by_hash` (P7, `ORDER BY hash`), `tx_by_type` (P7, `ORDER BY (tx_type, ledger_index, tx_index)`)
Narrow lookups into `transactions`: `hash` -> `(ledger_index, tx_index)`; `tx_by_type` also carries `result`. Read by
`/transactions/{hash}` and `/transactions?type=`.

### `account_transactions` (P7, `ORDER BY (account, ledger_index, tx_index)`)
One row per **affected account** of a transaction, with `tx_type`, `result`, `is_initiator UInt8` (1 for the sender) and
`close_time`. Read by `/accounts/{a}/transactions` and `/accounts/{a}/stats/transactions`.

### `account_tx_by_sequence` (P7, `ORDER BY (account, sequence, ledger_index, tx_index)`)
Sender only. Read by `/accounts/{a}/transactions/{sequence}` and `min_sequence`/`max_sequence`.

### `payments` (P6, `ORDER BY (ledger_index, tx_index)`)
One row per successful `Payment` between two different accounts: `tx_hash`, `close_time`, `source`, `destination`, `currency`
(LowCardinality), `issuer`, `amount`, `delivered_amount` (strings), `delivered_amount_f Float64`, `max_amount Nullable(String)`,
`source_currency`, `source_tag` / `destination_tag Nullable(UInt32)`, `invoice_id Nullable(String)`, `fee UInt64`,
`source_balance_changes` / `destination_balance_changes String` (JSON arrays of `{counterparty, currency, value}`), `client
Nullable(String)`. Read by `/payments` and the payment volume aggregation.

### `payments_by_currency` (P7, `ORDER BY (currency, issuer, ledger_index, tx_index)`)
Narrow index for `/payments/{currency}`.

### `account_payments` (P7, `ORDER BY (account, ledger_index, tx_index, direction)`)
One row per account and payment with `direction Enum8('sent'=1,'received'=2)`, `counterparty`, `currency`, `issuer`,
`delivered_amount[_f]`, the tags and `tx_hash`, `close_time`: a `sent` row for the source and a `received` row for the destination.
Read by `/accounts/{a}/payments` and `/accounts/{a}/reports`.

`direction` closes the key (Ruling R112): a ReplacingMergeTree keeps one row per key, and a payment from an account to itself has
both rows for the same account and `(ledger_index, tx_index)`, so with the key `(account, ledger_index, tx_index)` a merge kept
one of them, whichever, and `type=sent` (or `received`) lost the payment at random. The ingest drops a payment to oneself today (a
conversion, not a payment, as in the original), so this is the table not depending on that rule. The readers keep the original's
behaviour for such a payment: `/accounts/{a}/payments` lists it **once** (the page dedupes on `(ledger_index, tx_index)`, markers
unchanged) and it matches **both** `type=sent` and `type=received` (a filter on `direction`; the original filtered on
`source == account` / `destination == account`); `/accounts/{a}/reports` counts it **once, as sent** (the original tested
`payment.account === payment.data.source` first, so the receiver's side was never reached), with the account among its own
`receiving_counterparties`. The baseline was changed in place (it had not been deployed); a development database created from the old
baseline keeps the old key (`CREATE TABLE IF NOT EXISTS`) and fails the checksum of `001_baseline.sql`: recreate it.

### `exchanges` (P7, `ORDER BY (base_currency, base_issuer, counter_currency, counter_issuer, ledger_index, tx_index, node_index)`)
One row per trade. **The pair is stored in Ripple's canonical order** (lexicographic on the lower-cased `currency+issuer`), so a pair
is a prefix of the primary key and a request for the reverse order is read as stored and inverted. Columns: the pair, the key tail,
`tx_hash`, `close_time`, `base_amount`, `counter_amount`, `rate` (exact strings) with `base_amount_f`, `counter_amount_f`, `rate_f`,
`buyer`, `seller`, `taker`, `provider`, `offer_sequence`, `amm_account String`, `autobridged_currency` / `autobridged_issuer
Nullable(String)`, `tx_type`, `client Nullable(String)`, and the skip index `amm_account_set` (`amm_account TYPE set(1024) GRANULARITY 1`).
A trade with a zero leg or an MPT amount is skipped. Read by the pair endpoints, rates, normalize, active accounts, the trade volume
aggregation and the AMM jobs.

**AMM swaps are exchanges** ([ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md)). A swap against a pool is a row of this table,
written by the AMM parser, with `amm_account` the pool account and `''` for an order-book trade. In an AMM row `provider` is the pool
account and `offer_sequence` is 0; the amounts are the pool's deltas, so on the asset the pool pays out they include the issuer's
transfer fee (Ruling R-A10). `node_index` is the index, in `AffectedNodes`, of the pool account's `AccountRoot` node, or of the pool's
first reserve line (a trust line with `lsfAMMNode`) when that node is absent (an IOU/IOU pool): that keeps the key unique, because
order-book rows never use those nodes. `amm_account` is not in the key. The set index (Ruling R-A1) is what lets `amm=only` reads and the
swap reads of the AMM jobs skip the granules that hold no swap. The `amm` filter is a condition of the capped read itself (`only`:
`amm_account != ''`, `exclude`: `amm_account = ''`, `include`: none), never a step after the page, which would leave pages short.

### `account_exchanges` (P7, `ORDER BY (account, ledger_index, tx_index, node_index)`)
A full copy of every `exchanges` row per participating account (a self-trade appears once), `amm_account` and its `amm_account_set`
index included. A swap is copied for its taker and for the pool, which is its buyer or its seller, so a pool account lists its own
swaps here too. Read by `/accounts/{a}/exchanges`.

### `balance_changes` (P7, `ORDER BY (account, ledger_index, tx_index, node_index)`)
`account`, key tail, `tx_hash`, `close_time`, `currency`, `counterparty` (`''` for the native currency), `amount_change`,
`final_balance` (strings), `final_balance_f`, `change_type` (`transaction_cost`, `payment_source`, `payment_destination`, `exchange`,
`intermediary`, `escrow_*`, `paychannel_*`, or empty), nullable `escrow_*` and `paychannel_*` amounts, `client`. The fee of a
transaction is a row with `node_index = -1` (hidden in output). Read by `/accounts/{a}/balance_changes` and `/accounts/{a}/stats/value`.

### `accounts_created` (no partition, `ORDER BY (ledger_index, tx_index, account)`)
`account`, `parent`, `initial_balance`, `ledger_index`, `tx_index`, `tx_hash`, `inception`, `genesis_balance` / `genesis_index`
(nullable, empty until a history import loads ledger 32570); bloom-filter index on `account`. The lookup returns the **latest**
creation of an address. Read by `/accounts` and `/accounts/{a}`.

### `path_payments` (P6, `ORDER BY (ledger_index, tx_index)`, migration 007)
One row per **path payment** ([glossary](../GLOSSARY.md)): a successful `Payment` whose delivery used someone else's liquidity. A
payment to oneself is a row too (an arbitrage loop, or a conversion through an offer or a pool), although `payments` leaves such
payments out. Columns: `tx_hash`, `close_time`, `source`, `destination`, `delivered_amount`, `currency` (LowCardinality),
`issuer` (what reached the destination), `source_amount`, `source_currency` (LowCardinality), `source_issuer` (what left the source,
the fee not counted), `offers_crossed UInt32`, `amm_pools Array(String)`, `rippled_through Array(String)` (accounts, in the order of
the metadata). Amounts are exact `String`s in whole units; the issuers are `''` for the native currency. Written by
[`PathPaymentParser`](../packages/shared/src/parsers/path-payments.parser.ts) from the metadata of every successful Payment, from
`PARSER_VERSION` 4 on (`PATH_PARSER_VERSION`): an offer crossed is an Offer node whose `TakerPays` or `TakerGets` moved (an
unfunded or expired offer removed on the way is not one); a pool crossed is a pool whose AccountRoot balance or reserve line moved;
an account rippled through is one, other than the source, the destination, the delivered currency's issuer, a pool and the owner of
an offer crossed, whose balance went up on one trust line and down on another of the same currency while it holds a balance on one
of them (an issuer passing its own currency between two holders is not rippling). A payment with none of the three is not a path
payment: rippling only through the issuer, or a `Paths` field that went unused. In `CHILD_TABLES` and `LEDGER_KEYED_TABLES`, with the
dedup window; a ledger written by an older parser has no rows until it is re-ingested. Read by `/path_payments`.

### AMM tables (five ledger tables, two aggregates)

Written together with the other ledger tables, so they are in `CHILD_TABLES`, in `LEDGER_KEYED_TABLES`, have the deduplication window
and are deleted by recovery and `--reprocess` partition by partition. Every one is rebuilt by re-ingesting a ledger range
(`PARSER_VERSION` 2). Readers of all five read up to the newest committed ledger (`ledgers`), never past it. Amounts are exact `String`s
in whole units; the fee is `UInt16` in units of 1/100000; the pair is in Ripple's canonical order (`base_*`, `counter_*`).

#### `amm_pool_states` (P7, `ORDER BY (amm_account, ledger_index, tx_index)`)
One row per pool and transaction that touched it: `tx_hash`, `close_time`, `tx_type`, the pair (`base_currency`, `base_issuer`,
`counter_currency`, `counter_issuer`), `reserve_base`, `reserve_counter`, `lp_supply`, `lp_currency` (`Nullable(String)`),
`reserve_base_f`, `reserve_counter_f`, `lp_supply_f`, `auction_price_f` (Float64 shadows, Ruling R-A8), `trading_fee Nullable(UInt16)`,
`auction_holder`, `auction_price`, `auction_discounted_fee Nullable(UInt16)`, `auction_expiration Nullable(UInt32)` (Ripple seconds) and
`deleted UInt8`. Skip index `ledger_mm` (`minmax` on `ledger_index`, Ruling R-A2).

**A value is filled whenever its node is present in the transaction's metadata** (the value after the transaction, whether or not the
transaction changed it), and is `NULL` when the metadata has no such node: a swap through an XRP/IOU pool says nothing of the LP supply,
the fee or the auction slot, a vote nothing of the reserves. **Readers carry the last known value forward**: a column's value after a
row is its newest non-null value over that row and the rows before it. `deleted` is 1 when the transaction deleted the `AMM` node or the
pool's `AccountRoot`; `lp_supply` is then `'0'` if the `AMM` node was in the metadata. The same transaction can touch several pools (one
row each). The `ledger_mm` index prunes nothing once the parts have merged, because the table is ordered by pool: scans by ledger
read `amm_pool_touches` instead.

#### `amm_pool_touches` (P6, `ORDER BY (ledger_index, tx_index, amm_account)`)
One row per `amm_pool_states` row with only those three columns: a narrow index in the order of the ledgers (Ruling R-A14). The aggregator's
watermark scan, the `agg_dirty` slices and the day scans ("which pools were touched in these ledgers, and since when") read it by a
range of its primary key; the one scan that reads all of it is the stale-pool scan at the start of the aggregator.

#### `amm_liquidity` (P7, `ORDER BY (amm_account, ledger_index, tx_index)`)
One row per `create`, `deposit`, `withdraw`, `clawback` or `delete`: `tx_hash`, `close_time`, `account` (the liquidity provider; the
`Holder` of a clawback), `initiator` (the sender), `event`, `mode` (`''` when the event has none), `base_amount`, `counter_amount`
(signed, from the pool's side: positive into the pool), `lp_tokens` (positive minted, negative burned) and the `*_f` shadows. Skip
index `ledger_mm`. Read by `/amm/pools/{pool}/liquidity`; the earliest `create` row gives `amm_pools.created_ledger` and `created_by`.

#### `account_amm_liquidity` (P7, `ORDER BY (account, ledger_index, tx_index, amm_account)`)
The per-account index of `amm_liquidity`: the same columns, ordered by account (as `account_payments` is for payments). Read by
`/accounts/{a}/amm_liquidity`.

#### `amm_governance` (P7, `ORDER BY (amm_account, ledger_index, tx_index)`)
One row per `AMMVote` or `AMMBid`: `kind` (`vote` or `bid`), `account`, `fee_voted`, `trading_fee_after` (votes), `bid_min`, `bid_max`,
`price_paid` (the LP tokens a bid burned), `slot_holder`, `slot_discounted_fee`, `slot_expiration` (the slot after the bid) and
`auth_accounts Array(String)`. Skip index `ledger_mm`. Read by `/amm/pools/{pool}/governance`, and by `amm_daily` for the authorized
accounts of the holder's last bid.

#### `amm_pools` (no partition, `ReplacingMergeTree(version)`, `ORDER BY amm_account`)
The current state of each pool, for the pool list. Columns: the pair, `lp_currency`, `created_ledger` / `created_by` (`Nullable`: null
for a pool whose creation was not ingested), `last_ledger` (the newest state row the row has seen), `reserve_base`, `reserve_counter`,
`lp_supply`, `trading_fee`, the four auction columns, `deleted`, `value_native Nullable(Float64)` (null when no asset has a rate, and for a
deleted pool) and `version`. **Written by the aggregator, never by ingest**: every recompute of a pool writes a whole new row under a
newer version, rebuilt from `amm_pool_states` by the fill-forward, so a recovery delete of a newer state row cannot lose a pool's state
after merges. **Readers keep the newest version of each pool without `FINAL`**: `ORDER BY amm_account, version DESC LIMIT 1 BY
amm_account`, and what a pool can lose between versions (`deleted`) is filtered after that. A recompute of a pool that has no state row
left (a re-ingest dropped them all) deletes its rows with a lightweight `DELETE` (Ruling R-A28).

#### `amm_daily` (`toYYYYMM(day)`, `ReplacingMergeTree(version)`, `ORDER BY (amm_account, day)`)
One row per pool and UTC day with activity, with the closing state of the pool: the pair, `swap_count`, `volume_base`, `volume_counter`
(the amounts that went into the pool, by side), `fees_base_est`, `fees_counter_est` (estimates, `Nullable(String)`: null when a swap into
that side had no known fee, Ruling R-A26), `deposit_count`, `withdraw_count`,
`liquidity_in_base`, `liquidity_in_counter`, `liquidity_out_base`, `liquidity_out_counter`, the end-of-day `reserve_base`,
`reserve_counter`, `lp_supply`, `trading_fee`, `value_native`, then `final`, `config_version` and `version`. Written by the aggregator.

**A day is a version set.** One insert writes, under one `version`, a row for every pool with activity that day and a **sentinel** row
(`amm_account = ''`, empty assets, zero amounts and counts, null state) that stands for the day: a day without any pool is still a set,
which is how it is known to be computed. **The sentinel carries the version of the set; readers keep the pool rows with that version**
and never return the sentinel itself or a row of an older set, so a pool-day that vanished from a recompute (a re-ingest removed its
activity) has no row in the newest set and is not served. The sentinel read is a prefix of the primary key (`WHERE amm_account = '' AND
day = ...`), and the API applies the rule inside its capped read: `(day, version) IN (SELECT day, max(version) ... WHERE amm_account = ''
... GROUP BY day)`. Nothing relies on a merge. A day whose recompute failed on the dirty path is **marked owed**: its newest set is
copied under a newer version with `final = 0` (Ruling R-A27), so readers see the same rows and the day is no longer done.

`final` is 1 on the sentinel of a set made once the ingest had passed the day (the newest committed ledger closed at least an hour after
its end, Ruling R86) and 0 on every other row. `config_version` is the version of the computation, `AMM_DAILY_CONFIG_VERSION` (1 today)
in `packages/shared/src/aggregate/amm-daily.job.ts`. **Bump it whenever a change makes the rows come out differently**: a day counts
as done only for a final set of the current number, so a bump makes the aggregator compute every closed day again (the back-fill, newest
first). The version is the ClickHouse clock in milliseconds, never lower than one more than the day's newest.

#### The AMM reader rules
- **Committed head.** Every AMM read is capped at the newest `ledgers` row: the writer fills the tables of a ledger at the same time and
  writes the marker last, so a row above it may be there while another table's rows are not.
- **Pool prefix.** The history, liquidity and governance of a pool are a range of the primary key (the pool, then the ledgers), read a
  page at a time by `readDistinctPage`. The filters (`event`, `account`, `type`) are conditions of the inner capped read, never a step
  after the page.
- **Narrow account index.** The per-account lists read `account_amm_liquidity` (the account, then the ledgers), with the `pool` filter
  inside the read.
- **LP positions** read `balance_changes` (an LP token is a trust line issued by the pool, so the ledger tables already record it): the
  account's rows up to the ledger asked for with `match(currency, '^03[0-9A-Fa-f]{38}$')`, grouped to the latest balance of each
  `(currency, counterparty)` (`argMax(final_balance, (ledger_index, tx_index, node_index))`). A line is a position only when its
  counterparty is a pool whose LP currency, as of that ledger, is the line's currency. There is no currency index on this table: the
  read is bounded by the account prefix.
- **Fill-forward** (`fillForward`, shared by the jobs and the API): the state rows of a window of ledgers before the point asked for, per
  pool, a range of the primary key (`argMaxIf(column, (ledger_index, tx_index), isNotNull(column))`), and, for the pools the window leaves
  incomplete and that have older rows, older ledgers in doubling steps until every column has a value or the pool's own first state
  ledger is reached (one grouped read finds those ledgers; Rulings R-A21, R-A23 and R-A25).
  The answer is exactly the one the whole history gives. The window is `AMM_FILL_WINDOW_LEDGERS` (160,000 ledgers, about a week) for
  the aggregators and `AMM_HISTORY_CARRY_LEDGERS` (2,048, about two hours) for the history of a pool and for positions. Pools are read in
  batches of `AMM_POOLS_CHUNK` / `AMM_CHUNK` (200).
- **Pair key for swaps.** The swaps of a pool are read through the pair prefix of `exchanges` and the `amm_account_set` index; the
  exchanges are never scanned across pairs (Rulings R-A3 and R-A18).

### `account_states` (P7, `ORDER BY (account, ledger_index, tx_index, node_index)`)
The account state history (ADR-0015, migration 005): one row per account root a transaction changed, with the state after it. The
parser takes every created, modified and deleted `AccountRoot` node of the transaction's metadata, whatever the transaction's result,
with its final fields (`NewFields` of a created node, else `FinalFields`); a modified node without `PreviousFields` was only threaded
and has no row. Columns: `tx_hash`, `close_time`, `node_index UInt16` (the node's position in `AffectedNodes`), `balance` (the native
balance in whole units, exact `String`), `flags UInt32` (the AccountRoot `Flags`), `sequence`, `owner_count UInt32`, `fields` (the
JSON of every field of the node: `Domain`, `RegularKey`, `TransferRate`, the hook fields of Xahau, ...) and `deleted UInt8` (1 for the
node an AccountDelete removed). A created node lists only the fields that are not at their default, so an absent `Flags`,
`Sequence` or `OwnerCount` is 0.

It is a child table like the others (`CHILD_TABLES`, `LEDGER_KEYED_TABLES`, the deduplication window, deleted by recovery and
`--reprocess`), written from `PARSER_VERSION` 3 (`STATE_PARSER_VERSION`). **The state of an account at ledger L is its newest row at or
before L**, and none when that row is deleted: a read `ORDER BY ledger_index DESC, tx_index DESC, node_index DESC LIMIT 1` in the
account's prefix. **Coverage**: the table holds the state of ledger L when every stored ledger from L up was written by version 3 or
later (gaps in the ledger numbers do not matter), so it starts above the newest ledger an older parser wrote, and an account that has
not changed since then has no row yet; the history spec fills it back to ledger 32570. Read by `/accounts/{a}?flags=true` with a
ledger named (`StateLedgerService` resolves the ledger and checks the coverage).

## 3. Node-sourced, aggregate and internal tables

The AMM aggregates `amm_pools` and `amm_daily` are described with the other AMM tables above.

| Table | Key / engine | Contents | Used by |
| --- | --- | --- | --- |
| `fee_stats` | `MergeTree`, `ORDER BY ts`, `toYYYYMM(ts)` | One rippled `fee` snapshot every ~5 s: `ts DateTime64(3)`, `current_ledger_size`, `expected_ledger_size`, `current_queue_size`, `max_queue_size UInt32`, `pct_max_queue_size Float64`, `median_fee`, `minimum_fee`, `open_ledger_fee UInt64` (drops) | `/network/fee_stats` |
| `validations` | `AggregatingMergeTree`, `ORDER BY (ledger_hash, validation_public_key)`, TTL 90 d | `SimpleAggregateFunction` columns: `count sum`, `first_datetime min`, `last_datetime max`, the rest `any` (`ledger_index`, `reporter_public_key`, `ephemeral_public_key`, `signature`, `signing_time`, `flags`, `full`, `amendments`, `base_fee`, `load_fee`, `reserve_base`, `reserve_inc`, and, added by migration 002, `server_version Nullable(UInt64)`: the software version, only in the validation of a voting ledger). Rows are partial sightings, split across days and flushes: **always `GROUP BY (ledger_hash, validation_public_key)`** | `/ledgers/{hash}/validations` |
| `validator_manifests` | `ReplacingMergeTree(seq)`, `ORDER BY ephemeral_key` | `ephemeral_key`, `master_key`, `seq` (highest wins); added by migration 002: `domain` (`''` when none), `manifest` (raw, upper-case hex, `''` when unknown), `source` (`stream`, `rpc` or `unl`; a row written before 002 reads `stream`) | the validations collector |
| `validator_validations` | `AggregatingMergeTree`, `ORDER BY (validation_public_key, ledger_index, ledger_hash)`, `intDiv(ledger_index, 100000)`, TTL 7 d on `last_datetime`, dedup window 100 | A validator's validations, one row per (validator, ledger, hash): `count sum`, `first_datetime min`, `last_datetime max`, `full max`, `ephemeral_public_key`, `signing_time`, `server_version` (`any`). Sightings are partial: **`GROUP BY (validation_public_key, ledger_index, ledger_hash)`** | validators endpoints (recent validations) |
| `validator_seen` | `AggregatingMergeTree`, `ORDER BY validation_public_key`, no TTL, dedup window 100 | `first_seen min`, `last_seen max`, `last_ledger_index max` per validator: when this deployment first and last saw it | validators endpoints |
| `unl_lists` | `ReplacingMergeTree(fetched_at)`, `ORDER BY (publisher, sequence)` | Every UNL list a publisher served: `publisher_key` (hex), `version` (1 or 2), `effective` (nullable), `expiration`, `validators` (master keys, sorted), `blob_sha256`, `response` (the JSON as served, `ZSTD(3)`) | validators worker, validators endpoints |
| `unl_publishers` | `ReplacingMergeTree(checked_at)`, `ORDER BY publisher` | State of each configured publisher: `url`, `publisher_key`, `configured`, `threshold`, `status` (`ok` / `error`), `error` (reason code), `last_ok_at` | validators worker, validators endpoints |
| `validator_domains` | `ReplacingMergeTree(checked_at)`, `ORDER BY (validation_public_key, domain)` | Domain verification: `status` (`verified` / `unverified`), `reason`, `status_code`, `toml_url`, `verified_at` (last success), `next_check_at`, `accounts` (the `[[ACCOUNTS]]` addresses of the last TOML that verified) | validators worker, validators endpoints |
| `network_state` | `ReplacingMergeTree(polled_at)`, `ORDER BY ledger_index`, TTL 100 d | The ledger state read from the node at `ledger_index`: `amendments` (enabled IDs), `majorities` (`Array(Tuple(amendment, since))`), `negative_unl` (`Array(Tuple(validation_public_key, first_ledger))`), `to_disable`, `to_reenable`, the fees in force (`base_fee`, `reserve_base`, `reserve_inc`, drops) and `node_quorum` (0 = none reported) | validators worker, amendments endpoints |
| `amendment_features` | `ReplacingMergeTree(polled_at)`, `ORDER BY amendment_id` | The `name` and `supported` flag the node reports per amendment ID | validators worker, amendments endpoints |
| `validator_votes` | `ReplacingMergeTree(version)`, `ORDER BY (ledger_index, validation_public_key)` | Each validator's vote in a voting ledger (`ledger_index` = 256k - 1): `amendments`, the fee votes (`Nullable`, drops) and `server_version`. A **version set** | validators worker, amendments endpoints |
| `amendment_tallies` | `ReplacingMergeTree(version)`, `ORDER BY (amendment_id, ledger_index)` | Per voting ledger and amendment: `yes`, `trusted`, `threshold`, `unl_size`, `observed`; the sentinel row (`amendment_id = ''`) also holds `unl`, `negative_unl` and the fees in force. A **version set** | validators worker, amendments endpoints |
| `validator_agreement_hourly` | `ReplacingMergeTree(version)`, `ORDER BY (hour, validation_public_key)`, TTL 400 d on `hour` | Per hour and validator: `agreed`, `missed`, `partial`, `last_seen`; the sentinel row (`validation_public_key = ''`) holds the hour's `ledgers`, `unobserved`, `gaps`, `unl_size`, `quorum` and `final`. A **version set** | validators worker, validators endpoints |
| `stats_hourly` | `ReplacingMergeTree(version)`, `ORDER BY hour` | Per hour: `transaction_count`, `payments_count`, `exchanges_count`, `accounts_created`, `ledger_count`, `first_close_time`, `last_close_time`, `type_counts`, `result_counts` (`Map(..., UInt64)`), `version` | `/stats` |
| `volume_daily` | `ReplacingMergeTree(version)`, `ORDER BY (metric, day, component)`, `toYYYYMM(day)` | Per metric (`trade_volume` / `payment_volume` / `amm_volume`) and UTC day, one row per component (market or currency; for `amm_volume` the **pool account**): the pair, `amount` (exact string) and `amount_f`, `count`, `rate_f`, `converted_f` (value in the native currency), `config_version`, `version`. A sentinel row (empty component) marks a computed day with no volume. A day's rows are written as one set under one `version`; readers keep the highest | `/network/*_volume` (historical) |
| `volume_live` | `ReplacingMergeTree(version)`, `ORDER BY (metric, period, component)` | The same for the rolling live periods, with `start_time`, `end_time`, and `fees_est_f Nullable(Float64)` (migration 004): the estimated fees the pool charged on the swaps of the window, in the native currency, on the component rows of the `amm_volume` set of the period `day` only; NULL when a side's fee is not known (a swap with no known fee, so part of the fees is never shown as all of them), on the sentinel and on every row of the other sets. Twelve sets: `trade_volume` and `amm_volume` for hour, day, 3day, 7day and 30day, `payment_volume` for hour and day | `/network/*_volume` (live) |
| `ingest_log` | `ReplacingMergeTree(updated_at)`, `ORDER BY (range_start, range_end)` | Range-ingest intent: `status Enum8('started'=1,'done'=2)`. Live first-write intents use `run_id live:<bootId>` and `range_end = 0` | range-ingest, ingest boot |
| `agg_dirty` | `ReplacingMergeTree(created_at)`, `ORDER BY (from_hour, to_hour)` | Hour ranges whose stats must be recomputed because ingest rewrote ledgers behind the aggregator | aggregator |
| `syncer_lease` | `ReplacingMergeTree(heartbeat)`, `ORDER BY network` | One row per network: `holder`, `heartbeat`. A release is a newer row with an empty holder | the single-writer lease |
| `account_network_names` | `MergeTree`, `ORDER BY (address, added_at)`, no partition (migration 009) | One row per change of the **account network name** of an address on this network ("USD Issuer"): the columns of [`account_names`](#account_names-no-partition-mergetree-order-by-address-added_at) of the shared database (`address`, `name`, `removed UInt8`, `added_by`, `added_at DateTime64(3, 'UTC')`) and its rules: append-only, the newest row of an address wins (at the same `added_at` a removal wins), a newest row that is a removal or names nothing means no network name. Written by the operator ([operations](operations.md#name-an-account-on-one-network)); never `FINAL`, read whole with `LIMIT 1 BY address` and reloaded with the names every 60 s | `/v2/accounts/{address}` (`account_network_name`) |
| `export_jobs` | `MergeTree`, `ORDER BY (id, seq)`, TTL 7 d on `created` | The states of an export job, append-only in the manner of `ingest_log`: `id` (32 random hex digits), `seq` (0 for the api's `queued` row, one more for every state the exporter writes), `key_hash` (the hex SHA-256 of the creating API key, never the key; `''` without one), `path`, `format`, `status Enum8('queued'=1,'running'=2,'done'=3,'failed'=4)`, `created` and `at` (`DateTime64(3,'UTC')`), `rows`, `object` (the storage key `<network>/<id>.csv`) and `error`. Every row repeats the job, so the row with the highest `seq` of an id is the job: `ORDER BY id, seq DESC LIMIT 1 BY id`, no `FINAL`. Each `POST /v2/exports` counts the jobs of its `key_hash` whose newest row is `queued` or `running` (the limit per key, ticket #16): a scan of 7 days of jobs, as the key is not in the `ORDER BY` | `/v2/exports`, the exporter |

The three **version sets** (`validator_votes` with `amendment_tallies` for a voting ledger, `validator_agreement_hourly` for an hour)
follow the pattern of `volume_daily`: a unit is written whole under one `version` (wall-clock milliseconds, greater than any version
already stored for it), its sentinel row last; a reader takes the newest sentinel's `version` and keeps only that version's rows, so
no reader mixes two. None of the ten tables of migration 002 is a ledger table: none is in `CHILD_TABLES` or `LEDGER_KEYED_TABLES`,
so ingest recovery never deletes from them.

### Account and market aggregates (migration 003)

Nine tables, all `ReplacingMergeTree(version)`, all **recomputable** from the ledger tables and written only by the aggregator ([syncer](syncer.md#7-the-aggregator),
[ADR-0013](adr/0013-account-and-market-aggregates.md)). None is a ledger table: none is in `CHILD_TABLES` or `LEDGER_KEYED_TABLES`, so ingest
recovery never deletes from them; a re-ingest reaches them through `agg_dirty` (the hooks of [syncer](syncer.md#76-the-agg_dirty-hooks)). Amounts are exact
decimal strings with a `Float64` shadow (`_f`) where SQL ranks or falls back (the `sumOf` rule of `decimal.ts`).

| Table | `ORDER BY`, partition | Contents | Used by |
| --- | --- | --- | --- |
| `native_rates_daily` | `(currency, issuer, day)`, `toYear(day)` | Per closed UTC day, the rate of every issued asset whose rate that day is above 0: `rate` (exact text), `rate_f`, `daily_count` and `latest_count` (diagnostics: the kept trades of the day, and how many of them are among the newest 50), `config_version`, `stale`, `version`. A day is a **set**; its **sentinel** is the row with `currency = ''` and `issuer = ''`, which carries `config_version` and `stale` | `DailyRates` (every value of `stats/value`, `reports`, `analytics/*`) |
| `pair_hourly` | `(hour, base_currency, base_issuer, counter_currency, counter_issuer, source)`, `toDate(hour)`, TTL `hour + INTERVAL 45 DAY`, `ttl_only_drop_parts = 1` | Per UTC hour, pair (canonical order) and `source Enum8('book' = 1, 'amm' = 2)` (`amm` for a swap against a pool, a row of `exchanges` with `amm_account` set, else `book`; a pair with both in an hour has a row of each): `count`, `base_sum`, `counter_sum`, `unfit`, `base_sum_f`, `counter_sum_f`; `open_rate` with its key (`open_ledger`, `open_tx`, `open_node`) and `open_time`; `close_rate`, its key and `close_time`; `high_rate`, `high_rate_f` and its key; `low_rate`, `low_rate_f` and its key. An hour is a set; its sentinel (the empty pair, source `book`) carries `is_final`, `config_version` (2 since the split by source) and `through_time` (the close time of the newest ledger the read covered). The flag is `is_final`: `FINAL` is a ClickHouse keyword | `markets_live` job |
| `markets_live` | `(period, amm, base_currency, base_issuer, counter_currency, counter_issuer)`, none | Per period (`day`, `7day`, `30day`), filter `amm Enum8('include' = 1, 'exclude' = 2, 'only' = 3)` (all three are written, see below) and pair: `count`, `base_volume`, `counter_volume`, `native_volume Nullable(String)`, `open`, `high`, `low`, `last` (exact rate text), `open_time`, `last_time`, `closes Array(Nullable(String))` (7 daily closes, oldest first), `amm_share Nullable(String)` and `amm_pool Nullable(UInt8)` (NULL while the AMM data of the window is not known, see below). A (period, filter) is a set written in one insert; its sentinel (the empty pair) carries `start_time`, `end_time`, `pairs_traded`, `total_count`, `total_native_volume` and `total_amm_share Nullable(String)` (NULL likewise) | `/network/markets` |
| `account_rollup_state` | `account`, none | One row per heavy account: `rows` (its balance changes when counted), `first_day`, `rolled_from Nullable(Date)` and `rolled_through Nullable(Date)` (the contiguous days its rollups cover), `config_version`. The newest row of an account is its state | `AccountDayGroupsService` (cached 60 s per account), the `account_rollups` job |
| `account_partition_rows` | `(partition, account)`, none | Per partition of `balance_changes` (`partition UInt16` = `intDiv(ledger_index, 10000000)`), the accounts with at least 10,000 (`ACCOUNT_PARTITION_ROWS_FLOOR`) balance changes in it and their count; a partition is a set, its sentinel has `account = ''` | the discovery of heavy accounts |
| `account_rollup_days` | `(account, day)`, `toYear(day)` | The sentinel of an (account, day) rollup set: `version` only, written **after** the rows of the set | the day-groups read |
| `account_lines_daily` | `(account, day, currency, counterparty, change_type, owes, version)`, `toYear(day)` | From `balance_changes`: `count`, `in_sum` and `out_sum` (the sum of the positive and of the negative `amount_change`s, exact, the negatives as positive amounts), `unfit`, `in_sum_f`, `out_sum_f` and `end_balance` (the line's last `final_balance` of the day by `(ledger_index, tx_index, node_index)`, the same on every row of the line and day). `owes` is `final_balance < 0` | `analytics/balances`, `analytics/balance_changes`, `stats/value` |
| `account_tx_daily` | `(account, day, tx_type, result, version)`, `toYear(day)` | From `account_transactions`, the transactions the account sent (`is_initiator = 1`): `count` | `stats/transactions` |
| `account_trades_daily` | `(account, day, base_currency, base_issuer, counter_currency, counter_issuer, version)`, `toYear(day)` | From `account_exchanges`: `count`, `base_sum`, `counter_sum`, `bought_sum` (the base where the account is the buyer), `sold_sum` (the base where it is the seller; a self-trade is in both), `bought_counter_sum` and `sold_counter_sum` (the counter of those same trades), `unfit` and the six `_f` shadows | `analytics/exchanges` |

**The AMM columns of the markets (D2b).** The three `markets_live` filters are three sets of a period, written by one run from one read of the
hour rows (`pair_hourly`), in the order `exclude`, `only`, `include`: `include` takes the hour rows of both sources, `exclude` those of `book` (the
order-book trades) and `only` those of `amm` (the swaps); a pair is in a set only with a kept trade of its filter. The rates a pair's
`native_volume` goes through come from the `include` rows in all three sets. `amm_share` (the swaps' part of the pair's base volume over the base
volume of all its trades, text with 4 decimals, rounded half up, `"0.0000"` without swaps), `amm_pool` (1 when a pool of the pair has a newest row
of `amm_pools` that is not deleted, else 0) and the sentinel's `total_amm_share` (the swaps' part of the native volume, Σ native × share ÷ Σ native
over the pairs with a native volume, rounded once) describe the pair and the network, not the filter, so they are the same in the three sets.
They are written NULL on every row of the three sets when a ledger that closed in the window (`start_time` to `end_time`) was written by a parser
older than `AMM_PARSER_VERSION` (2, beside `PARSER_VERSION`): the parser gate, which the API turns into absent fields. The columns exist since
migration 003, so the markets' AMM additions need no migration (004 is for `fees_est_f` only). [Syncer 7.3](syncer.md#73-markets_live).

**Sets and sentinels.** A recompute writes a complete set in one insert under one new `version`: the larger of the ClickHouse clock in
milliseconds and the newest version of the set plus one (so a retry never reuses the version of a failed attempt). A reader keeps the rows
of the **newest version** of a set and never uses `FINAL`: for `markets_live` the rows whose `version` is the largest of the period and
filter (a set is one insert); for `native_rates_daily`, `pair_hourly` and the rollups the version of the newest sentinel of the day, hour
or (account, day), which says which rows are the set; a row that was written twice is read once (`LIMIT 1 BY` its key). The day of
`native_rates_daily` is *valid* when its newest sentinel has `stale = 0` and the current `config_version` (`RATES_DAILY_CONFIG_VERSION`,
1); the hour of `pair_hourly` when its sentinel has the current `config_version` (`PAIR_HOURLY_CONFIG_VERSION`, 2: the sets of version 1 had one row per pair, the order book and the pools together, and are computed again); the rollups of an
account when its state row has the current `ACCOUNT_ROLLUP_CONFIG_VERSION` (1).

**The rollup sets keep their own rows.** `account_lines_daily`, `account_tx_daily` and `account_trades_daily` have `version` as the **last**
column of their `ORDER BY`. A rollup set is three inserts of rows and then the sentinel of each (account, day) in `account_rollup_days`; a
merge keeps one row per sorting key, so without `version` in the key the rows of a newer set that is still being written (and whose
sentinel may never come) would replace the same groups of the set the sentinel points to, and a reader would find them gone. With it every
set keeps its rows and a merge only collapses a row written twice. The writer's version is the largest over all four rollup tables.
**Superseded rollup versions are never pruned**: a correction of a covered day (a re-ingest of history, through `agg_dirty`) writes one more
copy of the day's rows for each covered account beside the old one, one copy per correction pass (the ranges of a day that were marked
before its roll began share one roll, they do not make one copy each), and every earlier copy stays. They are not read, and they are small
next to the rollups themselves. Dropping them is a manual operation with a documented query
([operations](operations.md#superseded-rollup-versions)); no cleanup is shipped.

**Retention and size.** `pair_hourly` is the only table that expires (45 days after its hour; the aggregator keeps the last 31 days
complete). `markets_live` holds a row per period, filter and pair ever seen (a few thousand); `native_rates_daily` some million rows over
the history; the rollups of a few thousand heavy accounts some hundred million rows, mostly the lines of issuers.

## 4. Relationships

```
 transactions (ledger_index, tx_index) ◀── tx_by_hash, tx_by_type, account_transactions, account_tx_by_sequence   (keys -> full rows)
 payments     (ledger_index, tx_index) ◀── payments_by_currency, account_payments
 exchanges    (pair prefix)            ──▶ account_exchanges (copy per account)
 ledgers (commit marker) ◀── ledger_by_hash;  ledger_index -> close_time resolves every start/end
 ledgers ──▶ stats_hourly (rollup);  exchanges + payments + RatesService ──▶ volume_daily / volume_live
 amm_pool_states (pool prefix)  ◀── amm_pool_touches (ledger order: which pools, since when)
 amm_pool_states ──▶ amm_pools (current state);  + amm_liquidity + amm_governance + exchanges (amm_account) ──▶ amm_daily
 amm_liquidity (pool prefix)    ──▶ account_amm_liquidity (copy per liquidity provider)
 exchanges (amm_account set) + amm_pool_touches + amm_pool_states ──▶ volume_* (metric amm_volume)
 balance_changes (LP-token lines of an account) + amm_pool_states ──▶ /accounts/{a}/amm_positions
 exchanges ──▶ native_rates_daily, pair_hourly ──▶ markets_live;  balance_changes + account_transactions + account_exchanges ──▶
 account_lines_daily / account_tx_daily / account_trades_daily (heavy accounts only; sentinels in account_rollup_days)
```

## 5. Migrations

[`clickhouse/migrate.ts`](../packages/shared/src/clickhouse/migrate.ts) is a minimal tracked runner. Every `*.sql` file of
`packages/shared/schema/` (or `GH_SCHEMA_DIR`) is one migration unit:

1. It creates the target database (through a client bound to `default`, which always exists; the name is validated as a plain
   lowercase identifier because it is written into DDL) and a `schema_migrations` table.
2. It verifies the SHA-256 checksum of every applied file; **an applied file that changed is a hard error**
   (`Migration ... was modified after being applied`).
3. It applies the new files in file-name order, statement by statement, and records each with its checksum. All DDL is `CREATE ...
   IF NOT EXISTS` (or `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`), so a file that failed halfway can be run again.

The files so far:

| File | Contents |
| --- | --- |
| `001_baseline.sql` | The 23 tables of the baseline |
| `002_validators_amendments.sql` | Two `ALTER TABLE` statements (`validations.server_version`; `validator_manifests.domain`, `.manifest`, `.source`) and the ten validators and amendments tables. Additive: it reads nothing of 001 but those two tables, so it applies on a database that already ran 001, and a half-applied run is completed by running it again |
| `003_account_market_aggregates.sql` | The nine tables of the account and market aggregates, nine `CREATE TABLE IF NOT EXISTS` statements and nothing else. Additive: it reads no table of 001 or 002 and none of its tables depends on them, so it applies after 001 alone or after 001 and 002, on a fresh and on a migrated database |
| `004_amm_fee_estimates.sql` | One statement, `ALTER TABLE volume_live ADD COLUMN IF NOT EXISTS fees_est_f Nullable(Float64)`: the 24 h fee estimates of the AMM volume. Additive and run again safely. A set written before it reads as "not known" until the next tick writes it with the column; the syncer writes the column on every live volume row and the API reads it on the live `amm_volume` read of the period `day`. The migration is required before the API (that read fails without the column) and advisable before the syncer (a syncer before it still inserts, ClickHouse skips the field the table lacks, but the estimates of those ticks are lost, and the error counter does not show it) (rollout: [operations](operations.md#the-amm-data-additions)) |
| `005_account_states.sql` | One `CREATE TABLE IF NOT EXISTS`: `account_states`, the account state history of ADR-0015 (a ledger-derived table, written from parser version 3). Additive and run again safely. Required before the syncer (its ledger writer inserts into the table on every ledger, and fails without it) and before the API (`?flags=true` with a ledger reads it) |
| `007_path_payments.sql` | One `CREATE TABLE IF NOT EXISTS`: the ledger-derived `path_payments`. Additive: it depends on no other table, so it applies on a fresh and on a migrated database. It is required before a syncer with `PARSER_VERSION` 4 (that syncer's writes fail without the table) and before the API serves `/path_payments` (rollout: [backfill](backfill.md#path-payments-re-ingest)). |
| `009_account_network_names.sql` | `account_network_names`, one `CREATE TABLE IF NOT EXISTS` ([ADR-0014](adr/0014-address-names-and-labels-in-a-shared-database.md)). Additive: it reads no other table. 005 to 008 are numbers reserved by other changes of spec #4; the runner applies whatever files there are in file-name order, so a gap is harmless and a later 005 applies after 009 on a database that already ran 009. Required before an api that reads it: without it the api serves every account without a network name and logs `Could not load the account network names` at every reload |
| `010_export_jobs.sql` | One `CREATE TABLE IF NOT EXISTS`: `export_jobs`, the states of the export jobs (ticket #15). Additive: it reads no other table. Numbers 006 and 008 are kept for the other tables of spec #4. Required before the api serves `/v2/exports` and before the exporter starts |

Constraints on the SQL files: the splitter cuts on a semicolon at the **end of a line**, and drops lines that start with `--`, so
every statement ends with its semicolon on its last line and no other line (comment lines included) may end with one. The files are
`eol=lf` (a CRLF would change the checksum, `.gitattributes` enforces it).

```bash
pnpm ch:migrate                                              # from source: GH_NETWORK / GH_CLICKHOUSE_* from the environment
docker compose run --rm migrate-xrpl                         # dev compose, per network
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm migrate-xrpl   # prod compose
node node_modules/@gatehub/data-api-shared/dist/clickhouse/migrate.js   # the command inside the image
```

To change the schema, add the next `NNN_*.sql`; never edit an applied file (`001_baseline.sql`, `002_validators_amendments.sql`, `003_account_market_aggregates.sql`, `004_amm_fee_estimates.sql`, `005_account_states.sql`, `007_path_payments.sql`, `009_account_network_names.sql`, `010_export_jobs.sql`). A database created by the
earlier stack (`001_tables.sql` / `002_materialized_views.sql`) cannot be migrated: recreate it (`docker compose down -v` for
local volumes).

## 6. Sizing and retention

- `transactions.tx_json` and `meta_json` dominate (full XRPL history is roughly 1-1.5 TB compressed). Everything else together is a
  fraction of it.
- Retention is by partition, but always the same ledger block from all 21 ledger-derived tables, never one table alone ([clickhouse](clickhouse.md#retention-and-ttl), [operations](operations.md#retention)). `validations`
  expires by TTL after 90 days.
- The tables of migration 002 are not ledger tables, so no ledger retention touches them. They expire by TTL: `validator_validations`
  after 7 days of `last_datetime` (about 1 GB on XRPL; whole parts are dropped), `network_state` after 100 days of `polled_at` and
  `validator_agreement_hourly` after 400 days of its `hour`. `validator_seen`, `validator_votes`, `amendment_tallies`, `unl_lists`,
  `unl_publishers`, `validator_domains` and `amendment_features` are kept for ever (small); `validations` keeps its 90 days.
- The tables of migration 003 are not ledger tables either, so no ledger retention touches them. Only `pair_hourly` expires, 45 days after its hour
  (about a day per part, whole parts are dropped); `native_rates_daily`, `markets_live` and the six account rollup tables are recomputable and kept.
- Rollups (`stats_hourly`, `volume_*`, `amm_pools`, `amm_daily`) and `fee_stats` are small; keep them.
- `export_jobs` expires by TTL 7 days after a job was created, as its file does (a lifecycle rule of the bucket).

## 7. Adding a table or column

1. Add a `NNN_*.sql` migration (never edit an applied one).
2. Add the name to the `Table` enum and the row type to `rows.ts`.
3. If it is derived from a ledger: add it to `buildLedgerRows` / `CHILD_TABLES`, to `LEDGER_KEYED_TABLES` in `ingest-state.ts` (so
   recovery deletes it; the e2e suite compares that list with the schema's partitioning) and give it the dedup window.
4. Read it with `${Table.X}`, bound parameters, a key-ordered scan and no `FINAL`.

A table of the shared database instead gets a migration of `schema-shared/`, a member of the `SharedTable` enum (never of `Table`)
and a row type in `rows.ts`, and is read qualified by the shared database ([section 8](#8-the-shared-database)).

## 8. The shared database

One database on the ClickHouse server, `shared` (`GH_CLICKHOUSE_SHARED_DATABASE`), next to the network databases: it holds what the
operator writes about an **address**, which holds on every network ([ADR-0014](adr/0014-address-names-and-labels-in-a-shared-database.md), the
first exception to [ADR-0009](adr/0009-one-deployment-per-network.md)). The apis of every network read it; nothing derived from a ledger is
in it, and the syncers never touch it.

- **Migrations.** Its own set, [`packages/shared/schema-shared/`](../packages/shared/schema-shared/), numbered from 001, with its own
  `schema_migrations` in the shared database. The same runner applies it (`runSharedMigrations`, the command
  `migrate.js shared`, from source `pnpm ch:migrate:shared`), one job for every network: the `migrate-shared` service of both compose
  files, which the apis wait for. It must run before an api that reads the shared database.
- **Names.** The table names are the `SharedTable` enum of `tables.ts`, apart from `Table` (which is exactly the tables of a network
  database). Queries qualify them: `${shared}.${SharedTable.AccountNames}`; the api's `sql-tables.spec.ts` refuses one written by hand.
- **Not here: account network names.** A name that holds on one network only is in that network's own database,
  `account_network_names` (migration 009, [section 3](#3-node-sourced-aggregate-and-internal-tables)), with the same columns and rules as
  `account_names`, and loaded and reloaded with the names.
- **Append-only.** Every table is written by the operator with plain SQL inserts ([operations](operations.md#name-an-address)) and is
  never updated or deleted: the newest row of a key (largest `added_at`) wins, a row with `removed = 1` removes the key, and the rows
  are the audit trail. A plain `MergeTree` keeps them all; readers take the newest row of each key with `LIMIT 1 BY`, never `FINAL`.
- **Read.** The api loads every table whole when it starts and again every `GH_NAMES_AND_LABELS_RELOAD_MS` (60 s), and serves from
  that copy (`NamesAndLabelsService`): a row shows within a reload. A load that fails is logged and keeps the previous copy.

| File | Contents |
| --- | --- |
| `001_account_names.sql` | `account_names`: one `CREATE TABLE IF NOT EXISTS` |
| `002_account_labels.sql` | `account_labels`: one `CREATE TABLE IF NOT EXISTS` |

### `account_names` (no partition, `MergeTree ORDER BY (address, added_at)`)

One row per change of the **account name** of an address: `address`, `name`, `removed UInt8` (default 0; 1 removes the name),
`added_by` (who wrote the row) and `added_at DateTime64(3, 'UTC')` (default: the insert time). The newest row of an address wins; at the
same `added_at` a removal wins. An address whose newest row is a removal, or names nothing (`name = ''`), has no name. Read by
`/v2/accounts/{address}` (`account_name`).

### `account_labels` (no partition, `MergeTree ORDER BY (address, label, added_at)`)

One row per change of a **label** of an address: `address`, `label Enum8('scam' = 1, 'spam' = 2, 'advisory' = 3)`, `description`,
`source` (who says so) and `url` (where), both `String` with `''` (default) for none, `removed UInt8` (default 0; 1 removes that label
from the address), `added_by` and `added_at DateTime64(3, 'UTC')` (default: the insert time). The key is (address, label): an address
has each label at most once, and the newest row of a key wins; at the same `added_at` a removal wins. The `Enum8` rejects a misspelt
label at insert, so a new label is a migration that widens it. Read by `/v2/accounts/{address}` (`account_labels`, in the order of
the `Enum8`).
