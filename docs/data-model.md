# Data model and ClickHouse schema

The source of truth is [`packages/shared/schema/001_baseline.sql`](../packages/shared/schema/001_baseline.sql) (one migration file,
applied per network database by the `migrate` job); the row types are in
[`packages/shared/src/clickhouse/rows.ts`](../packages/shared/src/clickhouse/rows.ts) and the table names in `tables.ts` (the `Table`
enum: queries use `${Table.X}`, never string literals). **30 tables** per network database, in four groups:

| Group | Tables | Written by |
| --- | --- | --- |
| Ledger-derived (19) | `ledgers`, `ledger_by_hash`, `transactions`, `tx_by_hash`, `tx_by_type`, `account_transactions`, `account_tx_by_sequence`, `payments`, `payments_by_currency`, `account_payments`, `exchanges`, `account_exchanges`, `balance_changes`, `accounts_created`, and the five AMM tables `amm_pool_states`, `amm_pool_touches`, `amm_liquidity`, `account_amm_liquidity`, `amm_governance` | the `ingest` worker and `range-ingest` (one `LedgerWriter`) |
| Node-sourced (3) | `fee_stats`, `validations`, `validator_manifests` | the `fee_stats` and `validations` workers |
| Aggregates (5) | `stats_hourly`, `volume_daily`, `volume_live`, `amm_pools`, `amm_daily` | the `aggregator` worker |
| Internal (3) | `ingest_log`, `agg_dirty`, `syncer_lease` | the syncer |

Plus `schema_migrations` (the migration runner's bookkeeping). The previous design (CTID-keyed tables, insert-triggered materialized
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
| Ledger-prefixed (`ledgers`, `transactions`, `payments`, `amm_pool_touches`) | `ReplacingMergeTree` | **P6**: `intDiv(ledger_index, 1000000)` | A commit and a recovery delete never span two partitions; deletes are partition-scoped |
| Prefix-keyed secondary tables, `exchanges` and the AMM tables ordered by pool or account | `ReplacingMergeTree` | **P7**: `intDiv(ledger_index, 10000000)` | Fewer, larger partitions for tables ordered by something other than the ledger |
| `accounts_created`, `volume_live`, `stats_hourly`, `amm_pools`, internal | `ReplacingMergeTree` | none (`volume_daily` and `amm_daily`: `toYYYYMM(day)`) | Small tables |
| `fee_stats` | `MergeTree` | `toYYYYMM(ts)` | Append-only samples |
| `validations` | `AggregatingMergeTree` | `toYYYYMMDD(last_datetime)`, TTL 90 days | Partial sightings add up |

`ORDER BY` of a `ReplacingMergeTree` is its **natural unique key**. That is a safety net only: list queries never use `FINAL`, and
recovery deletes before it rewrites ([clickhouse](clickhouse.md#the-final-rule)). The 19 ledger-derived tables carry
`non_replicated_deduplication_window = 1000` so that a retried insert with the same `insert_deduplication_token` is dropped.
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
`exchanges_count` (order-book exchanges and AMM swaps), `accounts_created UInt32`, `fee_total`, `fee_min`, `fee_max UInt64` (drops), `parser_version UInt16` (2 since the AMM parser: a ledger written by version 1 has no AMM rows, see [backfill](backfill.md#amm-data-re-ingest)),
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
amm_account`, and what a pool can lose between versions (`deleted`) is filtered after that.

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
... GROUP BY day)`. Nothing relies on a merge.

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

## 3. Node-sourced, aggregate and internal tables

The AMM aggregates `amm_pools` and `amm_daily` are described with the other AMM tables above.

| Table | Key / engine | Contents | Used by |
| --- | --- | --- | --- |
| `fee_stats` | `MergeTree`, `ORDER BY ts`, `toYYYYMM(ts)` | One rippled `fee` snapshot every ~5 s: `ts DateTime64(3)`, `current_ledger_size`, `expected_ledger_size`, `current_queue_size`, `max_queue_size UInt32`, `pct_max_queue_size Float64`, `median_fee`, `minimum_fee`, `open_ledger_fee UInt64` (drops) | `/network/fee_stats` |
| `validations` | `AggregatingMergeTree`, `ORDER BY (ledger_hash, validation_public_key)`, TTL 90 d | `SimpleAggregateFunction` columns: `count sum`, `first_datetime min`, `last_datetime max`, the rest `any` (`ledger_index`, `reporter_public_key`, `ephemeral_public_key`, `signature`, `signing_time`, `flags`, `full`, `amendments`, `base_fee`, `load_fee`, `reserve_base`, `reserve_inc`). Rows are partial sightings, split across days and flushes: **always `GROUP BY (ledger_hash, validation_public_key)`** | `/ledgers/{hash}/validations` |
| `validator_manifests` | `ReplacingMergeTree(seq)`, `ORDER BY ephemeral_key` | `ephemeral_key`, `master_key`, `seq` (highest wins) | the validations collector |
| `stats_hourly` | `ReplacingMergeTree(version)`, `ORDER BY hour` | Per hour: `transaction_count`, `payments_count`, `exchanges_count`, `accounts_created`, `ledger_count`, `first_close_time`, `last_close_time`, `type_counts`, `result_counts` (`Map(..., UInt64)`), `version` | `/stats` |
| `volume_daily` | `ReplacingMergeTree(version)`, `ORDER BY (metric, day, component)`, `toYYYYMM(day)` | Per metric (`trade_volume` / `payment_volume` / `amm_volume`) and UTC day, one row per component (market or currency; for `amm_volume` the **pool account**): the pair, `amount` (exact string) and `amount_f`, `count`, `rate_f`, `converted_f` (value in the native currency), `config_version`, `version`. A sentinel row (empty component) marks a computed day with no volume. A day's rows are written as one set under one `version`; readers keep the highest | `/network/*_volume` (historical) |
| `volume_live` | `ReplacingMergeTree(version)`, `ORDER BY (metric, period, component)` | The same for the rolling live periods, with `start_time`, `end_time`. Twelve sets: `trade_volume` and `amm_volume` for hour, day, 3day, 7day and 30day, `payment_volume` for hour and day | `/network/*_volume` (live) |
| `ingest_log` | `ReplacingMergeTree(updated_at)`, `ORDER BY (range_start, range_end)` | Range-ingest intent: `status Enum8('started'=1,'done'=2)`. Live first-write intents use `run_id live:<bootId>` and `range_end = 0` | range-ingest, ingest boot |
| `agg_dirty` | `ReplacingMergeTree(created_at)`, `ORDER BY (from_hour, to_hour)` | Hour ranges whose stats must be recomputed because ingest rewrote ledgers behind the aggregator | aggregator |
| `syncer_lease` | `ReplacingMergeTree(heartbeat)`, `ORDER BY network` | One row per network: `holder`, `heartbeat`. A release is a newer row with an empty holder | the single-writer lease |

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
```

## 5. Migrations

[`clickhouse/migrate.ts`](../packages/shared/src/clickhouse/migrate.ts) is a minimal tracked runner. Every `*.sql` file of
`packages/shared/schema/` (or `GH_SCHEMA_DIR`) is one migration unit:

1. It creates the target database (through a client bound to `default`, which always exists; the name is validated as a plain
   lowercase identifier because it is written into DDL) and a `schema_migrations` table.
2. It verifies the SHA-256 checksum of every applied file; **an applied file that changed is a hard error**
   (`Migration ... was modified after being applied`).
3. It applies the new files in file-name order, statement by statement, and records each with its checksum. All DDL is `CREATE ...
   IF NOT EXISTS`, so a file that failed halfway can be run again.

Constraints on the SQL files: the splitter cuts on a semicolon at the **end of a line**, and drops lines that start with `--`, so
every statement ends with its semicolon on its last line and no other line (comment lines included) may end with one. The files are
`eol=lf` (a CRLF would change the checksum, `.gitattributes` enforces it).

```bash
pnpm ch:migrate                                              # from source: GH_NETWORK / GH_CLICKHOUSE_* from the environment
docker compose run --rm migrate-xrpl                         # dev compose, per network
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm migrate-xrpl   # prod compose
node node_modules/@gatehub/data-api-shared/dist/clickhouse/migrate.js   # the command inside the image
```

To change the schema, add `002_*.sql`; never edit `001_baseline.sql` once it has been applied anywhere. A database created by the
earlier stack (`001_tables.sql` / `002_materialized_views.sql`) cannot be migrated: recreate it (`docker compose down -v` for
local volumes).

## 6. Sizing and retention

- `transactions.tx_json` and `meta_json` dominate (full XRPL history is roughly 1-1.5 TB compressed). Everything else together is a
  fraction of it.
- Retention is by partition, but always the same ledger block from all 19 ledger-derived tables, never one table alone ([clickhouse](clickhouse.md#retention-and-ttl), [operations](operations.md#retention)). `validations`
  expires by TTL after 90 days.
- Rollups (`stats_hourly`, `volume_*`, `amm_pools`, `amm_daily`) and `fee_stats` are small; keep them.

## 7. Adding a table or column

1. Add a `NNN_*.sql` migration (never edit an applied one).
2. Add the name to the `Table` enum and the row type to `rows.ts`.
3. If it is derived from a ledger: add it to `buildLedgerRows` / `CHILD_TABLES`, to `LEDGER_KEYED_TABLES` in `ingest-state.ts` (so
   recovery deletes it; the e2e suite compares that list with the schema's partitioning) and give it the dedup window.
4. Read it with `${Table.X}`, bound parameters, a key-ordered scan and no `FINAL`.
