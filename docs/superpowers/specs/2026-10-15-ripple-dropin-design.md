# GateHub Data API: finish it as a drop-in Ripple Data API v2 replacement (XRPL + Xahau)

## Context

`data-api-new` is a pnpm monorepo: NestJS + ClickHouse, with `apps/api`, `apps/syncer` and
`packages/shared`. It was written as a ClickHouse rewrite of the **GateHub ES-era** Data API.
Its HTTP contract therefore does **not** match the old Ripple Data API v2
(rippled-historical-database):
- RFC 7807 errors
- GateHub field names
- Float64 numbers instead of strings
- custom envelopes

The ingest side also has correctness gaps:
- missed ledgers are lost
- MVs double-count when ledgers are re-ingested
- parsers mutate metadata
- no Xahau support

**Goal**
- Every listed `/v2/*` endpoint is request/response-compatible with what data.ripple.com
  actually served.
- A live syncer fills ClickHouse with everything those endpoints need, including fee stats and
  validations.
- The stack runs per network for **XRPL and Xahau**.
- SQLite history backfill is out of scope. The ingest pipeline exposes a `LedgerSource`
  interface so it can be added later without rework.

## Decisions (confirmed with user)

| Topic | Decision |
| --- | --- |
| Xahau | One deployment per network. `GH_NETWORK=xrpl\|xahau` selects node URLs, the native code (`XRP`/`XAH`), the CTID network id (0/21337), the markets config and a **separate ClickHouse DB** (default = network name). Same images. URLs stay `/v2/...` on every host. |
| Auth | API key stays **required** on `/v2/*`. This is the only deliberate contract deviation. Boot fails in production if `GH_API_KEYS` is empty. |
| Fidelity | Match what data.ripple.com **actually returned**, not its README. Outright bugs get fixed: request hangs, CSV crashes, orders `direction` always `buy`, ignored `ledger_hash`/`issuer` filters, stale tx-type/result whitelists (validate against the network definitions instead), and balances/orders reading the open ledger (default to the validated one). |
| Errors | `{result:"error", message}` with Ripple's messages and 400/404/500. Unknown query params are ignored. |
| Extras | Keep `/v2/exchanges` (all pairs) and `/v2/last_validated`. Drop `/v2/network/top_currencies` and the old GateHub `/v2/ledgers` time-range list, which collides with Ripple's "latest ledger". |
| Volumes | Live rolling mode (default) **and** historical `start/end/interval=day\|week\|month` with `limit/marker`. Components come from a versioned per-network JSON (`packages/shared/config/markets/{xrpl,xahau}.json`, overridable by an env path). |
| Schema | Not deployed anywhere, so it is replaced with a new baseline. |
| Dropped data | The `offers`, `issuers`, `escrows` and `paychannels` tables and their parsers. Escrow/paychannel typing stays in balance_changes. |
| Validations | `validations` + `manifests` streams, subscribed on a configurable list of WS endpoints per network. |
| Toolbox | `@gatehub/toolbox`:<br>• `bootstrap()` with `disableValidationPipe: true` (its pipe rejects unknown params), `versioning.disabled`, and metricz on its own port.<br>• `GateHubConfigModule.forFeature` + `@ConfigValue` for config.<br>• `GateHubLoggerModule` for logging.<br>Its global filter renders `{error:{key,…}}`, so the Ripple error filter is applied at controller level, where it takes precedence, plus a catch-all `/v2/*` 404 controller. `bootstrap()` returns no app handle, so trust-proxy, CORS and compression are applied via `HttpAdapterHost` in `onModuleInit`. |
| xrpl.js | Stay on 2.14 (API v1 shape; xahaud likely lacks api_version 2). Wrap it in a reconnect supervisor. Binary output uses `ripple-binary-codec@1.11` `XrplDefinitions`, built from the node's `server_definitions` with a bundled per-network fallback. |

## Current state (audit summary)

**API** (`apps/api/src`)
- 22 of the 27 routes exist, and none of them is drop-in:
  - wrong field names
  - Float64 amounts
  - RFC 7807 errors
  - `forbidNonWhitelisted`
  - CSV is a no-op
  - account tx history only covers transactions the account sent
  - keyset keys are not unique
- Missing endpoints:
  - active_accounts
  - account tx by sequence
  - account stats/value
  - network fees
  - fee_stats
  - both validations routes

**Syncer** (`apps/syncer/src`)
- No checkpoint and no gap catch-up.
- No validated gating.
- Live ingest and backfill share one buffer.
- A failed flush drops its batch.
- xrpl.js 2.14 reconnect is one-shot: after a failed reconnect the client stays down.

**Shared** (`packages/shared`)
- Insert-triggered MVs double-count when ledgers are re-ingested.
- Parsers mutate metadata and hardcode `'XRP'`.
- RippleState balance changes are produced only for Payment/OfferCreate.
- Payment volume uses `Amount` instead of `delivered_amount`.
- `migrate.ts` can't create a fresh DB.
- `INTERVAL_TO_CH` aligns n-day buckets to 1970.

**Reuse as-is**
- `packages/shared/src/util/ctid.ts` (+ spec)
- the `quality.ts` algorithm (only its signature changes)
- `from-client.parser.ts`
- `util/helpers.ts` (`retry`, `chunk`)
- the tuple clause in `apps/api/src/common/pagination.ts`
- `common/cache.service.ts`
- `common/metrics.interceptor.ts`
- `auth/api-key.guard.ts`
- the liveliness and prometheus modules
- `apps/*/test/clickhouse-container.ts`: merge the two copies into a single shared test util

## Storage design (ClickHouse, one DB per network)

**Principles**
- **`ledger_index` is the time axis.** `close_time` increases monotonically with it.
  - `start`/`end` are resolved once per request to a `[L1, L2]` range via a minmax index on `ledgers.close_time`, with an LRU cache in the API.
  - Markers encode `(ledger_index, tx_index[, node_index])` and never a DateTime.
- **Wide base tables are ordered by ledger.** Narrow secondary index tables are written explicitly by the syncer; there are no aggregate MVs.
  - A page is fetched with `WHERE (ledger_index, tx_index) IN (SELECT … ORDER BY … LIMIT n+1)`.
  - Fetching `limit+1` rows decides whether `marker` and `Link` are emitted.
- **Engines and partitioning**
  - Engine: `ReplacingMergeTree`. ORDER BY is the unique key. It is only a safety net; list queries never use FINAL.
  - P6 = `PARTITION BY intDiv(ledger_index, 1e6)` for ledger-prefixed tables.
  - P7 = `intDiv(ledger_index, 1e7)` for prefix-keyed tables.
  - No projections, because they conflict with lightweight DELETE.
- **Amounts** are stored as exact `String`. A `*_f Float64` shadow column exists only where we aggregate. Native amounts are `UInt64` drops.

| Table | Partition | ORDER BY | Notes / read by |
| --- | --- | --- | --- |
| `ledgers` | P6 | `ledger_index` | Header fields, minmax index on `close_time`, `tx_count`, `type_counts`/`result_counts` Maps, `payments_count`, `exchanges_count`, `accounts_created`, `fee_total/min/max`, `parser_version`. **Commit-marker row.** Read by `/ledgers`, `/network/fees`, the stats rollup and the date resolver. |
| `ledger_by_hash` | P7 | `ledger_hash` | `/ledgers/{hash}` |
| `transactions` | P6, `index_granularity=1024`, ZSTD blobs | `(ledger_index, tx_index)` | Columns: hash, type, result, account, sequence, fee, close_time, `tx_json` (without meta), `meta_json` (unaltered). Every TxObject response reads from here. |
| `tx_by_hash` | P7 | `hash` | `/transactions/{hash}` |
| `tx_by_type` | P7 | `(tx_type, ledger_index, tx_index)` | `/transactions?type=` |
| `account_transactions` | P7 | `(account, ledger_index, tx_index)` | All affected accounts, plus type, result and `is_initiator`. Read by `/accounts/{a}/transactions` and `/stats/transactions`. |
| `account_tx_by_sequence` | P7 | `(account, sequence, ledger_index, tx_index)` | Sender only. Read by `/transactions/{seq}` and `min/max_sequence`. |
| `payments` | P6 | `(ledger_index, tx_index)` | Full Payment row, including balance-change JSON. Read by `/payments` and the volume aggregator. |
| `payments_by_currency` | P7 | `(currency, issuer, ledger_index, tx_index)` | `/payments/{cur}` |
| `account_payments` | P7 | `(account, ledger_index, tx_index)` | Columns: direction, currency, issuer, tags. Read by `/accounts/{a}/payments` and `/reports`. |
| `exchanges` | P7 | `(base_cur, base_iss, counter_cur, counter_iss, ledger_index, tx_index, node_index)` | The pair is stored in Ripple's canonical order: lexicographic on the lower-cased `currency+issuer`. Read by the pair endpoints, rates, normalize, active_accounts and the volume aggregator. |
| `account_exchanges` | P7 | `(account, ledger_index, tx_index, node_index)` | Full copy plus `role`; a self-trade appears once. Read by `/accounts/{a}/exchanges`. |
| `balance_changes` | P7 | `(account, ledger_index, tx_index, node_index)` | String amounts plus `final_f`, `change_type`, and escrow/paychannel fields. The fee row has `node_index=-1`, which is hidden in output. Read by `/balance_changes` and `/stats/value`. |
| `accounts_created` | none | `(ledger_index, tx_index, account)` | Bloom filter on `account`. `/accounts/{a}` returns the **latest** inception (AccountDelete + re-fund case). `genesis_*` stays empty until the (out-of-scope) history import loads ledger 32570. |
| `fee_stats` | `toYYYYMM(ts)` | `ts` | rippled `fee` snapshot every 5 s. |
| `validations` | `toYYYYMMDD`, TTL 90 d | `(ledger_hash, validation_public_key)` | **AggregatingMergeTree**: sum(count), min(first), max(last), any(other fields). |
| `validator_manifests` | — | `ephemeral_key` | ReplacingMergeTree(seq) |
| `stats_hourly` | — | `hour` | Rolled up from `ledgers`. ReplacingMergeTree(version). |
| `volume_daily` / `volume_live` | — | `(metric, day\|period, component)` | Written by the aggregator. ReplacingMergeTree(version). |
| `ingest_log`, `agg_dirty`, `syncer_lease` | — | — | Internal. |

Query-time aggregates:
- candles, using arithmetic bucket alignment:
  - n-day buckets are aligned to 2013-01-01
  - `week`/`7day` buckets start on Monday (`toMonday`)
  - month and year buckets are calendar months and years
- rates, normalize, active_accounts, reports, account stats
- these are guarded by `max_rows_to_read` / `max_execution_time`
- results for closed past days are cached

## Syncer design (`apps/syncer`)

**Components**
- **`NodeClient` supervisor**, shared with the API:
  - multi-endpoint failover
  - a 5 s watchdog that replaces a dead or silent client
  - re-subscribes on reconnect
  - request timeout, retry and failover
  - boot check that `server_info.network_id` matches the profile
- **`LedgerSource`** with `validatedHead()` and `fetch(index)`:
  - `RpcLedgerSource` now
  - `FixtureLedgerSource` for tests
  - `SqliteLedgerSource` later
- **`buildLedgerRows(raw, ctx)`**: a pure function in shared that produces per-table rows plus the ledger summary row.
- **`LedgerWriter`**: one per runner.
  - Inserts all child tables in parallel, each with `insert_deduplication_token = ${runId}:${table}:${first}-${last}` (and `non_replicated_deduplication_window` set on the tables).
  - Then inserts `ledger_by_hash`, then `ledgers`. The `ledgers` insert is the atomic commit.
- **`LiveRunner`**:
  - Checkpoint = `max(ledgers.ledger_index)`. If there is none, start at `GH_SYNC_START_LEDGER` (default: the validated head).
  - **On boot:**
    - Verify that the stored hash at the checkpoint matches the node.
    - Lightweight-delete the uncommitted tail (`> checkpoint`), scoped to its partitions.
  - **Catch-up:** pipelined fetches (8–16 in flight), a reorder buffer, and commits of contiguous prefixes only. Flush every 300 ledgers, 100k tx or 5 s, whichever comes first.
  - **Live:** commit one ledger per flush.
  - **Fetch rules:**
    - The stream is only a head hint. Ledgers are always fetched by index.
    - A fetched ledger is accepted only if it is `validated:true`.
    - `parent_hash` must chain to the previous ledger; a break halts the runner and alerts.
    - If the stream is silent for more than 15 s, the runner polls for the head instead.
    - A ledger is never skipped: retries continue forever with capped backoff.
  - **Failed flush:** re-read the checkpoint, clean the tail and rebuild from there.
- **`RangeRunner` CLI** (replaces the current backfill):
  - Works in aligned chunks of 1000 ledgers, writing an `ingest_log` intent before any child row.
  - On start, chunks with an unfinished intent are partition-scoped deleted and redone.
  - `--reprocess` handles parser changes, keyed on `ledgers.parser_version`.
  - When done, it marks `agg_dirty`.
- **`ValidationsCollector`**:
  - Subscribes to `validations` + `manifests` on N endpoints.
  - Maps ephemeral keys to master keys (stream `master_key` → manifests → `manifest` RPC).
  - Merges in memory for ~20 s, then flushes. `reporter_public_key` is the node's pubkey.
- **`FeeStatsPoller`**: calls `fee` every 5 s and computes `pct_max_queue_size = queue / (expected × 20) × 100`.
- **`Aggregator`**:
  - Recomputes `stats_hourly` from `ledgers` (the last 2 hours every minute, plus `agg_dirty` ranges).
  - Recomputes `volume_live` every 60 s and closed `volume_daily` buckets, using the markets config and `RatesService`.
  - Week/month volumes are sums of daily native-converted rows (a documented approximation).
- **Workers**: `GH_SYNCER_WORKERS=ingest,validations,fee_stats,aggregator`. Single writer per network: replicas=1 with the Recreate strategy, plus a soft `syncer_lease` heartbeat check. Health reports `lag` and `last_commit_age`.

## API contract layer (`apps/api/src/common`, rewrite)

| Piece | Behavior |
| --- | --- |
| `@RippleController(path)` | `@Controller` + `@UseFilters(RippleErrorFilter)` + Swagger tag, with explicit `v2/...` paths. Ops controllers are unversioned. |
| `RippleErrorFilter` | Renders `{result:"error", message}`. 4xx statuses are kept; anything else becomes a 500 with the per-route Ripple message. Throttler errors become 429 `{error:"Rate limit exceeded, retry in Xsec"}` with `X-RateLimit-*` and `Retry-After`. |
| `ripple-params.ts` | Hand-written parsers; DTO classes are kept only for Swagger.<br>• Booleans match `/true/i`. Exceptions: `strict` is false only on `/false/i`, and `include_exchanges` is true for any value.<br>• The first value wins for repeated params; unknown params are ignored.<br>• `limit` default/max is per endpoint (NaN → default, over max → clamp).<br>• Accepted dates: Ripple formats, `YYYY`, `YYYY-MM`, `YYYYMMDDHHmmss` and unix seconds. `end` is inclusive at its own granularity.<br>• Error messages are exactly Ripple's. |
| `asset-param.ts` | Accepts `CUR+issuer` with `+`, `\|` or `.` as separator. The native code comes from the profile. Issuers are validated with `ripple-address-codec`. Errors: `XRP cannot have an issuer`, `base issuer is required`, and so on. |
| `pagination.ts` | Uses a ledger-key marker (base64url) and `limit+1`. A malformed marker returns 400. Emits `Link: <…>; rel="next"`. |
| `format.ts` | Omits undefined keys. Formats:<br>• `YYYY-MM-DDTHH:mm:ssZ` by default<br>• tx `date` as `…+00:00`<br>• `close_time_human` as `YYYY-MMM-DD HH:mm:ss`<br>• validation datetimes with milliseconds<br>• amounts as strings, `rate`/`vwap` with `toPrecision(8)`<br>• stats and fees as numbers |
| `csv.interceptor.ts` | Activated by `format=csv`. Flattens nested fields to `a.b` / `a[0].c` and takes the header from the first row. Sends `text/csv` with `Content-Disposition: attachment`. |
| `LedgerRangeResolver`, `BinaryCodecService`, `TxObjectMapper` | Resolve a date to a ledger range (cached). Encode `binary=true` responses using the node's definitions. Inject `meta.delivered_amount` into TxObjects (`DeliveredAmount` → `Amount` if the payment is not partial or the ledger is > 4594094 → `"unavailable"`). |

## Endpoint contract (data.ripple.com behavior, with bugs fixed)

| Endpoint | Key params (default / max) | Response |
| --- | --- | --- |
| `/v2/ledgers/{id?}` | `id`: digits → index, a date → the ledger closed at or before it, even-length hex → hash, omitted → latest. Flags `transactions`, `expand`, `binary` (binary wins). | `{result, ledger:{ledger_hash, ledger_index, parent_hash, total_coins, close_time, close_time_human, close_time_resolution, close_flags, parent_close_time, account_hash, transaction_hash, transactions?}}`. 404 `ledger not found`. |
| `/v2/transactions/{hash}` | `binary` | `{result, transaction}`. 404 `transaction not found`. |
| `/v2/transactions` | `start` (2013-01-01), `end`, `type`, `result`, `binary`, `descending`, `limit` 20/100, `marker` | `{result, count, marker?, transactions:[TxObject + ledger_hash]}` |
| `/v2/payments/{currency?}` | `start`, `end`, `descending`, `limit` 200/1000, `marker`, `format` | `{result, currency?, issuer?, count, marker?, payments:[Payment]}`. Payment fields: `amount`, `delivered_amount`, `source/destination_balance_changes`, `transaction_cost`, `max_amount?`, `source_currency`, tags, `invoice_id?`, `executed_time`, `ledger_index`, `tx_index`, `tx_hash`. |
| `/v2/exchanges/{base}/{counter}` | `start`, `end`, `interval` (1minute…1year, plus `week`), `reduce`, `autobridged`, `descending`, `limit` 200/400, `marker`, `format` | Raw trades, inverted when the pair is requested in reverse order. With `interval`/`reduce`: rows `{open, high, low, close, vwap, count, base_volume, counter_volume, buy_volume, open_time, close_time, start, base_*, counter_*}`. XRP legs ≤ 0.0005 are dropped. |
| `/v2/exchange_rates/{base}/{counter}` | `date`, `strict` (true, needs ≥ 10 trades), `period`, `live` | `{result, rate:"<8 sig>"}`. Rate = average of (daily VWAP, VWAP of the last 50 trades over 14 days). |
| `/v2/normalize` | `amount` (required), `currency`, `issuer`, `exchange_currency`, `exchange_issuer`, `date`, `strict` | `{result, amount, converted, rate}`, converted via the native currency. |
| `/v2/stats[/{family}[/{metric}]]` | `interval` hour/day/week, `metrics`, `start`, `end`, `limit` 200/1000, `marker`, `descending`, `format` | Nested rows without a family, flat rows with one. Built from `stats_hourly`. |
| `/v2/active_accounts/{base}/{counter}` | `period` 1day/3day/7day, `date`, `include_exchanges`, `format` | `{result, count, exchanges_count, accounts:[{account, buy, sell, base_volume, counter_volume, count, exchanges?}]}` |
| `/v2/network/exchange_volume`, `/payment_volume` | `live` (trade: hour/day/3day/7day/30day; payment: hour/day) **or** `start`/`end`/`interval` + `limit`/`marker`; `exchange_currency`/`exchange_issuer`; `format` | `{result, count, marker?, rows:[{components, count, start_time, end_time, exchange, exchange_rate, total}]}` |
| `/v2/accounts`, `/v2/accounts/{a}` | `start`, `end`, `parent`, `descending`, `limit` 200/1000, `marker`, `format` | `accounts:[{account, parent, initial_balance, inception, ledger_index, tx_hash, genesis_*?}]` / `{result, account_data}`. 404 `Account not found`. |
| `/v2/accounts/{a}/balances` (live node) | `ledger_index`/`ledger`, `ledger_hash`, `date`/`close_time`, `currency`, `counterparty`/`issuer`, `limit` 200/400 or `all` | `{result, ledger_index, close_time?, limit, balances:[{currency, counterparty?, value}]}`. Native first. |
| `/v2/accounts/{a}/orders` (live node) | same, minus `counterparty` | `orders:[{specification:{direction, quantity, totalPrice}, properties:{maker, flags, sequence, makerExchangeRate}}]` |
| `/v2/accounts/{a}/transactions[/{seq}]` | `start`, `end`, `min_sequence`/`max_sequence`, `type`, `result`, `binary`, `descending`, `limit` 20/1000, `marker` | **All** transactions affecting the account. `/{seq}` → `{result, transaction}`; 400 `invalid sequence number`. |
| `/v2/accounts/{a}/payments` | `type` sent/received, `currency`, `issuer`, `source_tag`, `destination_tag`, plus the common params | `payments:[Payment]` |
| `/v2/accounts/{a}/exchanges[/{base}[/{counter}]]` | common params | `exchanges:[Exchange + client]` |
| `/v2/accounts/{a}/balance_changes` | `currency`, `counterparty`/`issuer`, `change_type`/`type`, plus the common params | `balance_changes:[{amount_change, final_balance, node_index?, tx_index, change_type, currency, counterparty?, executed_time, ledger_index, tx_hash, escrow_*?, paychannel_*?}]` |
| `/v2/accounts/{a}/reports[/{date}]` | `start`/`end` (≤ 200 days), `accounts`, `payments`, `descending`, `format` | `{result, start, end, count, reports:[Report]}`. One row per UTC day, zero-filled, normalized to the native currency. |
| `/v2/accounts/{a}/stats/transactions` and `/stats/value` | `start`, `end` (exclusive), `limit`, `marker`, `descending`, `format` | `rows:[{date, transaction_count, result, type}]` / `rows:[{date, account_value, balance_change_count}]` |
| `/v2/network/fees` | `interval` ledger/hour/day, plus the common params | `rows:[{avg, min, max, total, tx_count, date, ledger_index?}]` |
| `/v2/network/fee_stats` | `interval` minute/hour/day (default: raw, 5 s), `start` (2016-07-01), plus the common params | `rows:[{date, current_ledger_size, expected_ledger_size, current_queue_size, pct_max_queue_size, median_fee, minimum_fee, open_ledger_fee}]` |
| `/v2/ledgers/{hash}/validations[/{pubkey}]` | `limit` 200/1000, `marker`, `format` | `{result, ledger_hash, count, marker?, validations}` sorted by validator key / a flat Validation. 404 `validation not found`. The singular `/v2/ledger/...` is also registered as an alias. |

## Implementation phases

Each phase is independently reviewable and leaves the build green.

0. **Foundations**
   - Add `packages/shared/src/network/` (`NetworkProfile`, profiles for xrpl/xahau, bundled definitions JSON, markets JSON). Delete `constants.ts`.
   - `clickhouse/migrate.ts`: create the DB through a client bound to `default`, validate DB names, store checksums.
   - Wire toolbox config/logger/bootstrap in `apps/*/src/main.ts`, `config/*.ts`, and `app.module.ts`.
1. **Schema**
   - Replace `packages/shared/schema/*` with `001_baseline.sql`.
   - Update `clickhouse/tables.ts` (drop `View`).
2. **Shared parsing**
   - Make the parsers pure, with a `ParseContext{nativeCurrency, networkId}`.
   - Produce RippleState balance changes for all tx types, with the Ripple `change_type` mapping. Types Ripple never knew get no `change_type`.
   - Payment volume and issuer use `delivered_amount`.
   - Exchanges keep the exact rate string plus `autobridged_*`.
   - `quality.ts` takes native flags.
   - Add a new `build-rows.ts` + ledger summary.
   - Delete the offers, issuers, escrow and paychan parsers and their table writes.
   - Main files: `packages/shared/src/parsers/{payment,exchanges,balance-changes,accounts-created,affected-accounts}.parser.ts`, `util/{amount,quality}.ts`.
3. **Ingest**
   - `apps/syncer/src/xrpl/xrpl-connection.service.ts` → `node-client.ts`. Shared with the API, so place it in `packages/shared/src/xrpl/`.
   - `sync/ledger-ingestor.ts` → `rpc-ledger-source.ts`.
   - `processor/clickhouse-data-processor.service.ts` → `ledger-writer.ts`.
   - `sync/sync-processor.service.ts` → `live-runner.ts` + `range-runner.ts`, with a CLI at `src/cli/range-ingest.ts`.
   - Also update `app.service.ts`, metrics and health.
4. **API base**: the `apps/api/src/common/*` rewrite above, a catch-all 404, and `xrpl/xrpl.service.ts` on top of `NodeClient`. Delete `problem-details.filter.ts` and `query.dto.ts`.
5. **Core endpoints**
   - ledgers, transactions, payments
   - accounts: list, lookup, transactions, `/{seq}`, payments, exchanges, balance_changes, balances, orders
   - exchanges (raw, interval, reduce), `/v2/exchanges` extra, `/v2/last_validated`
   - Files: `apps/api/src/{ledgers,transactions,payments,accounts,exchanges}/*`
6. **Rate-derived endpoints**
   - `packages/shared/src/query/rates.ts` (`RatesService`, also used by the aggregator)
   - exchange_rates, normalize, active_accounts (new module), reports, stats/transactions, stats/value
7. **Collectors**
   - `apps/syncer/src/{validations,fees}/*`
   - API: validations routes, `/network/fees`, `/network/fee_stats`
8. **Aggregator**
   - `apps/syncer/src/aggregator/*` (`stats_hourly`, `volume_live`, `volume_daily`)
   - API: `/stats` and `/network/{exchange,payment}_volume`
9. **Xahau + deploy + docs**
   - Compose: one ClickHouse server with `api-xrpl`/`syncer-xrpl` and `api-xahau`/`syncer-xahau` services, and migrate jobs per DB.
   - Bump ClickHouse from 24.8 to the current LTS (pin after verifying partition-scoped lightweight DELETE).
   - Rewrite `docs/api-reference.md` and `openapi.yaml`.
   - Supersede ADR-0002/0003; add ADRs for "ledger-index axis + secondary tables" and "no aggregate MVs".

## Testing

- **Fixtures**
  - `scripts/record-fixtures.ts` saves `ledger` (expand), `server_definitions` and `server_info` as gzipped JSON under `packages/shared/test/fixtures/{xrpl,xahau}/`.
  - **XRPL** coverage:
    - genesis-era ledgers
    - autobridged OfferCreate
    - partial and cross-currency payments
    - escrow and paychannel transactions
    - AMM transactions
    - AccountDelete followed by re-funding
    - Tickets
    - tec failures
  - **Xahau** coverage:
    - Import
    - ClaimReward
    - SetHook/Invoke
    - emitted transactions
    - URIToken
    - pseudo-transactions
- **Parser golden tests**
  - Snapshot the `build-rows` output.
  - Inputs are deep-frozen.
  - Keys are unique per table.
  - Every amount parses with BigNumber.
  - Per-currency balance changes sum to zero, except fee burn and XAH mint.
  - Port the assertions from the original rippled-historical-database mocha tests as the parity oracle.
- **Contract e2e tests**, one per endpoint
  - Testcontainers ClickHouse, seeded through the real `LedgerWriter` from a `FixtureLedgerSource`, queried with supertest.
  - Snapshot the JSON body, the CSV body and the `Link` header.
  - Check:
    - limit clamps
    - descending order
    - concatenated marker pages equal the unpaged list
    - unknown params are ignored
    - exact error messages
    - 401 without a key
  - Run with both `GH_NETWORK=xrpl` and `GH_NETWORK=xahau`.
- **Syncer recovery tests**
  - Fault injection between the child inserts and the commit.
  - An ambiguous timeout after a commit; after restart, `count() == uniqExact(key)` and the aggregates are exact.
  - A ledger gap (100 → 103) is filled.
  - `validated:false` triggers a retry.
  - A `parent_hash` mismatch halts the runner.
  - A WS close 1006 plus a refused reconnect recovers.
  - A range-ingest intent is redone.
  - The aggregator is idempotent when run twice.

## Verification (end-to-end)

1. `pnpm install && pnpm build && pnpm test`: unit and golden tests pass.
2. `pnpm --filter @gatehub/data-api-service test:e2e` and `pnpm --filter @gatehub/data-syncer test:e2e`: contract and recovery suites pass for both networks.
3. Live smoke test:
   - Run `docker compose up clickhouse` and the migrate jobs for the `xrpl` and `xahau` DBs.
   - Start `syncer-xrpl` (a full-history node, e.g. `wss://s2.ripple.com`) and `syncer-xahau` (`wss://xahau.network`). Use `GH_SYNC_START_LEDGER` set to roughly the validated head minus 500.
   - Wait until health reports `lag ≤ 1`.
4. `kill -9` the syncer during catch-up and restart it. Then check in SQL:
   - no gaps: `max - min + 1 == count()` on `ledgers`
   - no duplicates: `count() == uniqExact(ledger_index, tx_index)` on `transactions`
5. Call every endpoint on both API instances with `X-API-Key`, plus `format=csv`, marker paging and bad params.
6. Spot-check against the node:
   - `/balances` against `account_lines`
   - `/transactions/{hash}?binary=true` re-hashes to `hash`
   - `/ledgers/{index}` against `ledger`
   - validations show up for recent ledgers
   - fee_stats rows land every ~5 s

## Risks and open items

- **Node history**
  - Catch-up, historical `/balances`/`/orders` and range ingest need full-history nodes. Clio is a good fit for XRPL.
  - Xahau full history is uncertain.
  - The SQLite source will matter for the deep past.
- **ClickHouse lightweight DELETE**: partition-scoped DELETE must be verified on the pinned ClickHouse version.
- **Single writer**: enforced by the deployment (replicas=1, Recreate). The lease only narrows the race.
- **Undefined semantics in Ripple's model**
  - `change_type` for new tx types: left undefined.
  - Volume week/month sums: an approximation.
- **Query cost for very large accounts** (`/reports`, `/stats/value`, filtered balance_changes): bounded by guards and caching.
- **Storage**: full XRPL history is roughly 1–1.5 TB compressed for tx blobs. Size disks before the backfill starts.
- **Old spec reference**: after approval, this plan is also saved as the design spec at `docs/superpowers/specs/2026-10-15-ripple-dropin-design.md`. The repo is not a git repo yet; commit after `git init` if desired.
