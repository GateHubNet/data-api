# Data model and ClickHouse schema

The source of truth is [`packages/shared/schema/001_baseline.sql`](../packages/shared/schema/001_baseline.sql) (one migration file,
applied per network database by the `migrate` job); the row types are in
[`packages/shared/src/clickhouse/rows.ts`](../packages/shared/src/clickhouse/rows.ts) and the table names in `tables.ts` (the `Table`
enum: queries use `${Table.X}`, never string literals). **23 tables** per network database, in four groups:

| Group | Tables | Written by |
| --- | --- | --- |
| Ledger-derived (14) | `ledgers`, `ledger_by_hash`, `transactions`, `tx_by_hash`, `tx_by_type`, `account_transactions`, `account_tx_by_sequence`, `payments`, `payments_by_currency`, `account_payments`, `exchanges`, `account_exchanges`, `balance_changes`, `accounts_created` | the `ingest` worker and `range-ingest` (one `LedgerWriter`) |
| Node-sourced (3) | `fee_stats`, `validations`, `validator_manifests` | the `fee_stats` and `validations` workers |
| Aggregates (3) | `stats_hourly`, `volume_daily`, `volume_live` | the `aggregator` worker |
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
| `validations` | `AggregatingMergeTree` | `toYYYYMMDD(last_datetime)`, TTL 90 days | Partial sightings add up |

`ORDER BY` of a `ReplacingMergeTree` is its **natural unique key**. That is a safety net only: list queries never use `FINAL`, and
recovery deletes before it rewrites ([clickhouse](clickhouse.md#the-final-rule)). The 14 ledger-derived tables carry
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

Lists read in key order with `LIMIT 1 BY <key>` and stop after `limit + 1` rows; aggregates read the same deduplicated rows;
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
Narrow index for `/payments/{currency}`. `account_payments` (P7, `ORDER BY (account, ledger_index, tx_index)`): one row per account
and payment with `direction Enum8('sent'=1,'received'=2)`, `counterparty`, `currency`, `issuer`, `delivered_amount[_f]`, the tags and
`tx_hash`, `close_time`. Read by `/accounts/{a}/payments` and `/accounts/{a}/reports`.

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
| `validations` | `AggregatingMergeTree`, `ORDER BY (ledger_hash, validation_public_key)`, TTL 90 d | `SimpleAggregateFunction` columns: `count sum`, `first_datetime min`, `last_datetime max`, the rest `any` (`ledger_index`, `reporter_public_key`, `ephemeral_public_key`, `signature`, `signing_time`, `flags`, `full`, `amendments`, `base_fee`, `load_fee`, `reserve_base`, `reserve_inc`). Rows are partial sightings, split across days and flushes: **always `GROUP BY (ledger_hash, validation_public_key)`** | `/ledgers/{hash}/validations` |
| `validator_manifests` | `ReplacingMergeTree(seq)`, `ORDER BY ephemeral_key` | `ephemeral_key`, `master_key`, `seq` (highest wins) | the validations collector |
| `stats_hourly` | `ReplacingMergeTree(version)`, `ORDER BY hour` | Per hour: `transaction_count`, `payments_count`, `exchanges_count`, `accounts_created`, `ledger_count`, `first_close_time`, `last_close_time`, `type_counts`, `result_counts` (`Map(..., UInt64)`), `version` | `/stats` |
| `volume_daily` | `ReplacingMergeTree(version)`, `ORDER BY (metric, day, component)`, `toYYYYMM(day)` | Per metric (`trade_volume` / `payment_volume`) and UTC day, one row per component (market or currency): the pair, `amount` (exact string) and `amount_f`, `count`, `rate_f`, `converted_f` (value in the native currency), `config_version`, `version`. A sentinel row (empty component) marks a computed day with no volume. A day's rows are written as one set under one `version`; readers keep the highest | `/network/*_volume` (historical) |
| `volume_live` | `ReplacingMergeTree(version)`, `ORDER BY (metric, period, component)` | The same for the rolling live periods, with `start_time`, `end_time` | `/network/*_volume` (live) |
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
- Retention is by partition: `ALTER TABLE ... DROP PARTITION n` ([clickhouse](clickhouse.md#retention-and-ttl)). `validations`
  expires by TTL after 90 days.
- Rollups (`stats_hourly`, `volume_*`) and `fee_stats` are small; keep them.

## 7. Adding a table or column

1. Add a `NNN_*.sql` migration (never edit an applied one).
2. Add the name to the `Table` enum and the row type to `rows.ts`.
3. If it is derived from a ledger: add it to `buildLedgerRows` / `CHILD_TABLES`, to `LEDGER_KEYED_TABLES` in `ingest-state.ts` (so
   recovery deletes it; the e2e suite compares that list with the schema's partitioning) and give it the dedup window.
4. Read it with `${Table.X}`, bound parameters, a key-ordered scan and no `FINAL`.
