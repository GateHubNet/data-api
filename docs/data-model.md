# Data model and ClickHouse schema

The source of truth is the migration files of [`packages/shared/schema/`](../packages/shared/schema/):
[`001_baseline.sql`](../packages/shared/schema/001_baseline.sql) and
[`002_validators_amendments.sql`](../packages/shared/schema/002_validators_amendments.sql) and
[`003_account_market_aggregates.sql`](../packages/shared/schema/003_account_market_aggregates.sql) (applied in file-name order, per network
database, by the `migrate` job); the row types are in
[`packages/shared/src/clickhouse/rows.ts`](../packages/shared/src/clickhouse/rows.ts) and the table names in `tables.ts` (the `Table`
enum: queries use `${Table.X}`, never string literals). **42 tables** per network database, in six groups:

| Group | Tables | Written by |
| --- | --- | --- |
| Ledger-derived (14) | `ledgers`, `ledger_by_hash`, `transactions`, `tx_by_hash`, `tx_by_type`, `account_transactions`, `account_tx_by_sequence`, `payments`, `payments_by_currency`, `account_payments`, `exchanges`, `account_exchanges`, `balance_changes`, `accounts_created` | the `ingest` worker and `range-ingest` (one `LedgerWriter`) |
| Node-sourced (3) | `fee_stats`, `validations`, `validator_manifests` | the `fee_stats` and `validations` workers |
| Validators and amendments (10, migration 002) | `validator_validations`, `validator_seen`, `unl_lists`, `unl_publishers`, `validator_domains`, `network_state`, `amendment_features`, `validator_votes`, `amendment_tallies`, `validator_agreement_hourly` | the `validations` worker (the first two) and the `validators` worker (the rest) |
| Aggregates (3) | `stats_hourly`, `volume_daily`, `volume_live` | the `aggregator` worker |
| Account and market aggregates (9, migration 003) | `native_rates_daily`, `pair_hourly`, `markets_live`, `account_rollup_state`, `account_partition_rows`, `account_rollup_days`, `account_lines_daily`, `account_tx_daily`, `account_trades_daily` | the `aggregator` worker (jobs `rates_daily`, `pair_hourly`, `markets_live`, `account_rollups`) |
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
| Ledger-prefixed (`ledgers`, `transactions`, `payments`) | `ReplacingMergeTree` | **P6**: `intDiv(ledger_index, 1000000)` | A commit and a recovery delete never span two partitions; deletes are partition-scoped |
| Prefix-keyed secondary tables and `exchanges` | `ReplacingMergeTree` | **P7**: `intDiv(ledger_index, 10000000)` | Fewer, larger partitions for tables ordered by something other than the ledger |
| `accounts_created`, `volume_live`, `stats_hourly`, internal | `ReplacingMergeTree` | none (`volume_daily`: `toYYYYMM(day)`) | Small tables |
| `fee_stats` | `MergeTree` | `toYYYYMM(ts)` | Append-only samples |
| The nine tables of migration 003 | `ReplacingMergeTree(version)` | `toYear(day)` for the rates and the account rollups, `toDate(hour)` for `pair_hourly` (TTL 45 days, `ttl_only_drop_parts = 1`), none for the others | Recomputable aggregates written as complete sets; a year of days is a small partition, an hour table expires by whole days |
| `validations` | `AggregatingMergeTree` | `toYYYYMMDD(last_datetime)`, TTL 90 days | Partial sightings add up |
| `validator_validations` | `AggregatingMergeTree` | `intDiv(ledger_index, 100000)`, TTL 7 days, `ttl_only_drop_parts = 1` | Sightings add up; a partition is about four days of ledgers, so expiry drops whole parts |
| `validator_seen` | `AggregatingMergeTree` | none, no TTL | One row per validator: min / max / max |
| The other validators and amendments tables | `ReplacingMergeTree` | none | Small tables, newest row (or newest `version`) wins |

`ORDER BY` of a `ReplacingMergeTree` is its **natural unique key**. That is a safety net only: list queries never use `FINAL`, and
recovery deletes before it rewrites ([clickhouse](clickhouse.md#the-final-rule)). The 14 ledger-derived tables carry
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
`exchanges_count`, `accounts_created UInt32`, `fee_total`, `fee_min`, `fee_max UInt64` (drops), `parser_version UInt16`,
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
`buyer`, `seller`, `taker`, `provider`, `offer_sequence`, `autobridged_currency` / `autobridged_issuer Nullable(String)`, `tx_type`,
`client Nullable(String)`. A trade with a zero leg or an MPT amount is skipped. Read by the pair endpoints, rates, normalize, active
accounts and the trade volume aggregation.

### `account_exchanges` (P7, `ORDER BY (account, ledger_index, tx_index, node_index)`)
A full copy of every `exchanges` row per participating account (a self-trade appears once). Read by `/accounts/{a}/exchanges`.

### `balance_changes` (P7, `ORDER BY (account, ledger_index, tx_index, node_index)`)
`account`, key tail, `tx_hash`, `close_time`, `currency`, `counterparty` (`''` for the native currency), `amount_change`,
`final_balance` (strings), `final_balance_f`, `change_type` (`transaction_cost`, `payment_source`, `payment_destination`, `exchange`,
`intermediary`, `escrow_*`, `paychannel_*`, or empty), nullable `escrow_*` and `paychannel_*` amounts, `client`. The fee of a
transaction is a row with `node_index = -1` (hidden in output). Read by `/accounts/{a}/balance_changes` and `/accounts/{a}/stats/value`.

### `accounts_created` (no partition, `ORDER BY (ledger_index, tx_index, account)`)
`account`, `parent`, `initial_balance`, `ledger_index`, `tx_index`, `tx_hash`, `inception`, `genesis_balance` / `genesis_index`
(nullable, empty until a history import loads ledger 32570); bloom-filter index on `account`. The lookup returns the **latest**
creation of an address. Read by `/accounts` and `/accounts/{a}`.

## 3. Node-sourced, aggregate and internal tables

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
| `volume_daily` | `ReplacingMergeTree(version)`, `ORDER BY (metric, day, component)`, `toYYYYMM(day)` | Per metric (`trade_volume` / `payment_volume`) and UTC day, one row per component (market or currency): the pair, `amount` (exact string) and `amount_f`, `count`, `rate_f`, `converted_f` (value in the native currency), `config_version`, `version`. A sentinel row (empty component) marks a computed day with no volume. A day's rows are written as one set under one `version`; readers keep the highest | `/network/*_volume` (historical) |
| `volume_live` | `ReplacingMergeTree(version)`, `ORDER BY (metric, period, component)` | The same for the rolling live periods, with `start_time`, `end_time` | `/network/*_volume` (live) |
| `ingest_log` | `ReplacingMergeTree(updated_at)`, `ORDER BY (range_start, range_end)` | Range-ingest intent: `status Enum8('started'=1,'done'=2)`. Live first-write intents use `run_id live:<bootId>` and `range_end = 0` | range-ingest, ingest boot |
| `agg_dirty` | `ReplacingMergeTree(created_at)`, `ORDER BY (from_hour, to_hour)` | Hour ranges whose stats must be recomputed because ingest rewrote ledgers behind the aggregator | aggregator |
| `syncer_lease` | `ReplacingMergeTree(heartbeat)`, `ORDER BY network` | One row per network: `holder`, `heartbeat`. A release is a newer row with an empty holder | the single-writer lease |

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
| `pair_hourly` | `(hour, base_currency, base_issuer, counter_currency, counter_issuer, source)`, `toDate(hour)`, TTL `hour + INTERVAL 45 DAY`, `ttl_only_drop_parts = 1` | Per UTC hour, pair (canonical order) and `source Enum8('book' = 1, 'amm' = 2)` (only `book` is written): `count`, `base_sum`, `counter_sum`, `unfit`, `base_sum_f`, `counter_sum_f`; `open_rate` with its key (`open_ledger`, `open_tx`, `open_node`) and `open_time`; `close_rate`, its key and `close_time`; `high_rate`, `high_rate_f` and its key; `low_rate`, `low_rate_f` and its key. An hour is a set; its sentinel (the empty pair, source `book`) carries `is_final`, `config_version` and `through_time` (the close time of the newest ledger the read covered). The flag is `is_final`: `FINAL` is a ClickHouse keyword | `markets_live` job |
| `markets_live` | `(period, amm, base_currency, base_issuer, counter_currency, counter_issuer)`, none | Per period (`day`, `7day`, `30day`), filter `amm Enum8('include' = 1, 'exclude' = 2, 'only' = 3)` (only `include` is written) and pair: `count`, `base_volume`, `counter_volume`, `native_volume Nullable(String)`, `open`, `high`, `low`, `last` (exact rate text), `open_time`, `last_time`, `closes Array(Nullable(String))` (7 daily closes, oldest first), `amm_share Nullable(String)` and `amm_pool Nullable(UInt8)` (always NULL). A (period, filter) is a set written in one insert; its sentinel (the empty pair) carries `start_time`, `end_time`, `pairs_traded`, `total_count`, `total_native_volume` and `total_amm_share Nullable(String)` (NULL) | `/network/markets` |
| `account_rollup_state` | `account`, none | One row per heavy account: `rows` (its balance changes when counted), `first_day`, `rolled_from Nullable(Date)` and `rolled_through Nullable(Date)` (the contiguous days its rollups cover), `config_version`. The newest row of an account is its state | `AccountDayGroupsService` (cached 60 s per account), the `account_rollups` job |
| `account_partition_rows` | `(partition, account)`, none | Per partition of `balance_changes` (`partition UInt16` = `intDiv(ledger_index, 10000000)`), the accounts with at least 10,000 (`ACCOUNT_PARTITION_ROWS_FLOOR`) balance changes in it and their count; a partition is a set, its sentinel has `account = ''` | the discovery of heavy accounts |
| `account_rollup_days` | `(account, day)`, `toYear(day)` | The sentinel of an (account, day) rollup set: `version` only, written **after** the rows of the set | the day-groups read |
| `account_lines_daily` | `(account, day, currency, counterparty, change_type, owes, version)`, `toYear(day)` | From `balance_changes`: `count`, `in_sum` and `out_sum` (the sum of the positive and of the negative `amount_change`s, exact, the negatives as positive amounts), `unfit`, `in_sum_f`, `out_sum_f` and `end_balance` (the line's last `final_balance` of the day by `(ledger_index, tx_index, node_index)`, the same on every row of the line and day). `owes` is `final_balance < 0` | `analytics/balances`, `analytics/balance_changes`, `stats/value` |
| `account_tx_daily` | `(account, day, tx_type, result, version)`, `toYear(day)` | From `account_transactions`, the transactions the account sent (`is_initiator = 1`): `count` | `stats/transactions` |
| `account_trades_daily` | `(account, day, base_currency, base_issuer, counter_currency, counter_issuer, version)`, `toYear(day)` | From `account_exchanges`: `count`, `base_sum`, `counter_sum`, `bought_sum` (the base where the account is the buyer), `sold_sum` (the base where it is the seller; a self-trade is in both), `bought_counter_sum` and `sold_counter_sum` (the counter of those same trades), `unfit` and the six `_f` shadows | `analytics/exchanges` |

**Sets and sentinels.** A recompute writes a complete set in one insert under one new `version`: the larger of the ClickHouse clock in
milliseconds and the newest version of the set plus one (so a retry never reuses the version of a failed attempt). A reader keeps the rows
of the **newest version** of a set and never uses `FINAL`: for `markets_live` the rows whose `version` is the largest of the period and
filter (a set is one insert); for `native_rates_daily`, `pair_hourly` and the rollups the version of the newest sentinel of the day, hour
or (account, day), which says which rows are the set; a row that was written twice is read once (`LIMIT 1 BY` its key). The day of
`native_rates_daily` is *valid* when its newest sentinel has `stale = 0` and the current `config_version` (`RATES_DAILY_CONFIG_VERSION`,
1); the hour of `pair_hourly` when its sentinel has the current `config_version` (`PAIR_HOURLY_CONFIG_VERSION`, 1); the rollups of an
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

Constraints on the SQL files: the splitter cuts on a semicolon at the **end of a line**, and drops lines that start with `--`, so
every statement ends with its semicolon on its last line and no other line (comment lines included) may end with one. The files are
`eol=lf` (a CRLF would change the checksum, `.gitattributes` enforces it).

```bash
pnpm ch:migrate                                              # from source: GH_NETWORK / GH_CLICKHOUSE_* from the environment
docker compose run --rm migrate-xrpl                         # dev compose, per network
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm migrate-xrpl   # prod compose
node node_modules/@gatehub/data-api-shared/dist/clickhouse/migrate.js   # the command inside the image
```

To change the schema, add the next `NNN_*.sql`; never edit an applied file (`001_baseline.sql`, `002_validators_amendments.sql`, `003_account_market_aggregates.sql`). A database created by the
earlier stack (`001_tables.sql` / `002_materialized_views.sql`) cannot be migrated: recreate it (`docker compose down -v` for
local volumes).

## 6. Sizing and retention

- `transactions.tx_json` and `meta_json` dominate (full XRPL history is roughly 1-1.5 TB compressed). Everything else together is a
  fraction of it.
- Retention is by partition, but always the same ledger block from all 14 ledger-derived tables, never one table alone ([clickhouse](clickhouse.md#retention-and-ttl), [operations](operations.md#retention)). `validations`
  expires by TTL after 90 days.
- The tables of migration 002 are not ledger tables, so no ledger retention touches them. They expire by TTL: `validator_validations`
  after 7 days of `last_datetime` (about 1 GB on XRPL; whole parts are dropped), `network_state` after 100 days of `polled_at` and
  `validator_agreement_hourly` after 400 days of its `hour`. `validator_seen`, `validator_votes`, `amendment_tallies`, `unl_lists`,
  `unl_publishers`, `validator_domains` and `amendment_features` are kept for ever (small); `validations` keeps its 90 days.
- The tables of migration 003 are not ledger tables either, so no ledger retention touches them. Only `pair_hourly` expires, 45 days after its hour
  (about a day per part, whole parts are dropped); `native_rates_daily`, `markets_live` and the six account rollup tables are recomputable and kept.
- Rollups (`stats_hourly`, `volume_*`) and `fee_stats` are small; keep them.

## 7. Adding a table or column

1. Add a `NNN_*.sql` migration (never edit an applied one).
2. Add the name to the `Table` enum and the row type to `rows.ts`.
3. If it is derived from a ledger: add it to `buildLedgerRows` / `CHILD_TABLES`, to `LEDGER_KEYED_TABLES` in `ingest-state.ts` (so
   recovery deletes it; the e2e suite compares that list with the schema's partitioning) and give it the dedup window.
4. Read it with `${Table.X}`, bound parameters, a key-ordered scan and no `FINAL`.
