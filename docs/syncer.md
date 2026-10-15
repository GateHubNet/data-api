# The XRPL Syncer (ingestion service)

A deep-dive into `apps/syncer` — the service that pulls ledgers from an XRPL node,
parses every transaction into analytics rows, and bulk-writes them into ClickHouse.

This document describes exactly what the code does. For the *operational* question of
**how to backfill ~2 years of history and whether to run your own rippled**, see
[docs/backfill.md](./backfill.md) — that discussion (history sizing, node choice, rate
limits) is not repeated here.

---

## 1. Purpose & high-level flow

The syncer is a NestJS worker. Its job is to keep ClickHouse in sync with the XRPL,
in two complementary modes:

- **backfill** — sweep a `[from, to]` ledger range as fast as the node allows.
- **live-subscribe** — follow the `ledgerClosed` stream and ingest each new ledger.

Both modes share one pipeline: *fetch a ledger (with expanded transactions) → run the
parser suite over each transaction → buffer the resulting rows → bulk-INSERT per table
into ClickHouse*.

```
                                    apps/syncer
 ┌──────────────┐   ws/wss    ┌───────────────────────────────────────────────┐
 │  XRPL node   │◄───────────►│ XrplConnectionService                         │
 │  (rippled /  │             │  - owns the xrpl.js Client                    │
 │   cluster)   │  ledger     │  - ledger$ Subject (ledgerClosed events)      │
 └──────────────┘  request    │  - re-subscribes on reconnect                 │
        ▲                     └───────────────┬───────────────────────────────┘
        │ command:'ledger'                    │
        │ transactions+expand                 ▼
        │                     ┌───────────────────────────────────────────────┐
        │                     │ LedgerIngestor.fetchAndParse(index)           │
        └─────────────────────│  - retry(fetch ledger)                        │
                              │  - rippleTime → unix seconds                   │
                              │  - enrich each tx, ParsingService.parse        │
                              └───────────────┬───────────────────────────────┘
                                              │ FetchedLedger { ledger, parsed[] }
                  ┌───────────────────────────┴───────────────────────┐
                  ▼ (backfill: pool)                                   ▼ (live: serial chain)
 ┌────────────────────────────────────┐           ┌──────────────────────────────────────┐
 │ SyncProcessorService.backfill      │           │ SyncProcessorService.subscribeLive   │
 │  - worker pool over [from,to]      │           │  - promise-chain, one ledger at a time│
 │  - skip already-inserted (window)  │           │  - insertLedger() (flush immediately) │
 │  - enqueueLedger + maybeFlush(N)   │           └──────────────────┬───────────────────┘
 └────────────────┬───────────────────┘                              │
                  ▼                                                   ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────┐
 │ ClickHouseDataProcessorService                                                         │
 │  - buffers N ledgers' rows in per-table maps                                           │
 │  - flush(): all CHILD_TABLES (parallel) → then the `ledgers` commit marker             │
 │  - getInsertedLedgers(from,to): the skip-window lookup                                  │
 └──────────────────────────────────────────────┬───────────────────────────────────────┘
                                                 ▼  JSONEachRow, insert_deduplicate=1
                                  ┌────────────────────────────────┐
                                  │ ClickHouse (ReplacingMergeTree) │
                                  └────────────────────────────────┘
```

A separate HTTP server runs the whole time for `/liveliness/healthz` and `/metricz`.

---

## 2. Boot & modes

### Boot sequence

`apps/syncer/src/main.ts`:

1. Loads `dotenv/config`, creates the Nest app (`NestExpressApplication`).
2. Disables `x-powered-by`, enables shutdown hooks.
3. Listens on `GH_HTTP_API_PORT` (default `3002`). **The HTTP server exists purely so an
   orchestrator can probe health and scrape metrics** while ingestion runs — the actual
   work is kicked off in a lifecycle hook, not by an HTTP request.

`apps/syncer/src/app.module.ts` wires up: `ConfigModule`, `ClickHouseModule.forRoot()`,
`PrometheusModule`, `LivelinessModule`, `SyncModule`, plus the `AppService`.

### `AppService.onApplicationBootstrap` (`app.service.ts`)

This is the orchestrator that runs once the Nest container is ready:

1. **Migrations on boot** — if `runMigrationsOnBoot` (`GH_RUN_MIGRATIONS_ON_BOOT`, default
   `true` — only `"false"` disables it) it calls `runMigrations()` from the shared package.
   The runner is idempotent (`schema_migrations` bookkeeping table + `CREATE … IF NOT
   EXISTS`). Note: the migrate module's own header recommends running migrations as a
   single controlled step, **not** concurrently from every replica — if you scale the
   syncer horizontally, set `GH_RUN_MIGRATIONS_ON_BOOT=false` on all but one and run a
   dedicated migrate step.
2. **Node range probe** — issues `server_info`, reads `info.complete_ledgers` (e.g.
   `"32570-86000000"`), and splits it into `serverFrom`/`serverTo`.
3. **Mode selection** (the two are independent and may both run):
   - If `subscribeLive` (`GH_SUBSCRIBE_LIVE=true`): `sync.subscribeLive()`.
   - If `backfillEnabled` (`GH_BACKFILL_ENABLED=true`): computes `from`/`to`, defaulting to
     the node's range and **clamping** the requested `GH_BACKFILL_START_LEDGER` /
     `GH_BACKFILL_END_LEDGER` to what the node actually holds (logs a warning, points to
     `docs/backfill.md`). Backfill is started with `void this.sync.backfill(from, to)` —
     fire-and-forget in the background so liveliness/metrics stay responsive; a crash is
     caught and logged.
   - If **neither** is enabled: logs `syncer is idle`.

### Running both modes together

This is the recommended fresh-deployment setup: live keeps the head current while the pool
fills history behind it. The overlap is harmless because writes are idempotent (CTID +
`ReplacingMergeTree`; see §5).

### Health & metrics endpoints

- `GET /liveliness/healthz` (`LivelinessController`) — Terminus health check; the single
  indicator pings ClickHouse (`LivelinessService.clickhouse()`), throwing
  `HealthCheckError` if the ping fails.
- `GET /metricz` (`PrometheusController`) — returns the Prometheus registry text. The
  registry has default process metrics (prefixed `syncer_`) plus the two domain gauges
  described in §10.

---

## 3. The ingestion unit: `LedgerIngestor.fetchAndParse`

`apps/syncer/src/sync/ledger-ingestor.ts`. This is the **parallelizable, network-bound unit
of work**: it only *fetches and parses* — it never writes. Writing is the data processor's
job, so many ingestors can run concurrently.

`fetchAndParse(ledgerIndex)`:

1. **Fetch (retried).** `fetchLedger` issues:
   ```
   command: 'ledger', ledger_index, transactions: true, expand: true, binary: false
   ```
   i.e. the full ledger header plus every transaction with its metadata expanded inline.
   The fetch is wrapped in `retry(…, { attempts: 5 })` so a transient node error does not
   create a permanent gap. If the response has no `ledger`, it throws `Ledger N not found`.

2. **Time normalization (ripple time → unix seconds).** On the wire, `close_time` and
   `parent_close_time` are **ripple time** (seconds since the ripple epoch, 2000-01-01).
   The ingestor converts them **once**, here, via
   `xrpl.rippleTimeToUnixTime(...) / 1000` (that helper returns ms, hence the `/1000`),
   so every downstream parser and the processor see a consistent unix-seconds `date`.
   `ledger_index` is coerced to a `Number`. The normalized object is what gets enqueued.

3. **Per-transaction enrichment.** Each transaction is reshaped into an `XrplTx` carrying
   the ledger-level context the parsers need:
   - `meta` ← the tx's `metaData`,
   - `hash`,
   - `date` ← the ledger's unix `close_time` (every tx in a ledger shares the close time),
   - `ledger_index`,
   - `client` ← `parseClient(tx)` (the memo-derived client string, see §4).

   Then `ParsingService.parseTransaction(enriched)` runs the full parser suite, producing
   a `ParsedTransaction`.

4. Returns `{ ledger: normalizedLedger, parsed: ParsedTransaction[] }`.

---

## 4. The parser suite

`packages/shared/src/parsers/`. `ParsingService.parseTransaction` (`parsing.service.ts`)
runs every parser over one transaction and returns a `ParsedTransaction`:

```
{ rawTransaction, payment?, exchanges[], balanceChanges[], accountsCreated[],
  affectedAccounts[], offers[], issuers[], escrow?, paychannel? }
```

The suite is **pure and synchronous — no network calls**. Each parser reads the transaction
fields and its metadata `AffectedNodes`. The shared gate `txSucceededOrClaimed(meta)`
(`parser.interface.ts`) treats `tesSUCCESS` or any `tec*` result as "had ledger effects",
though most parsers apply their own stricter `tesSUCCESS` check.

### `parseClient` — `from-client.parser.ts`
**Input:** a transaction's `Memos`. **Output:** a string (≤100 chars) or `null`.
Scans memos for one whose `MemoType` decodes (hex or base64) to `"client"`, then decodes
its `MemoData`/`MemoFormat` payload. Wrapped in try/catch per memo so malformed memos are
ignored. This is the attribution tag (which app submitted the tx) propagated onto every
child row as `client`.

### `payment.parser.ts` — `payment?`
**Input:** `Payment` transactions with `tesSUCCESS`. **Output:** one `ParsedPayment` or
`undefined`.
- Returns `undefined` for non-Payments, failures, or **self-payments**
  (`Account === Destination` is an exchange/no-op, not a real payment).
- Uses `parseBalanceChanges(meta)` from `ripple-lib-transactionparser` to compute
  source/destination changes; subtracts the fee from the source's XRP change.
- **Correctness fix (review C4/H4):** `destination_balance_changes` and the source changes
  are guarded with `?? []` — a missing entry no longer throws (the old code assumed it
  existed).
- **Issuer resolution** (`setIssuer`): XRP has none. Otherwise, if the amount's issuer is
  neither source nor destination, that issuer is used directly. Failing that, it inspects
  the `RippleState` `AffectedNodes`: matching the destination on `HighLimit`/`LowLimit`, a
  **negative (or previously-negative) balance means the low-limit account is the issuer**
  (XRPL signs RippleState balances from the low account's perspective).
- Emits `currency`, `amount`, `delivered_amount` (prefers `DeliveredAmount`), `max_amount`
  / `source_currency` (from `SendMax`), tags, `invoice_id`, `fee` (in XRP).

### `exchanges.parser.ts` — `exchanges[]`
**Input:** `Payment` and `OfferCreate` with `tesSUCCESS`. **Output:** one `ParsedExchange`
per exercised offer.
- Walks `AffectedNodes`, picking `ModifiedNode`/`DeletedNode` of type `Offer` that have
  `PreviousFields.TakerPays` **and** `TakerGets` (i.e. the offer actually moved).
- Computes the traded `base`/`counter` sides from `Previous − Final`, converting XRP drops.
- Rate from `parseQuality(BookDirectory, …)`, falling back to the amount ratio.
- **Autobridging detection:** for `OfferCreate` with two IOU legs bridged through XRP, sets
  `autobridged`.
- `orderPair` canonicalizes side order (lexicographic on `currency+issuer`) so the same
  pair always sorts consistently, inverting the rate accordingly.
- Carries `node_index` (its index in `AffectedNodes`) — part of the natural key.

### `balance-changes.parser.ts` — `balanceChanges[]`
**Input:** any tx whose result is `tesSUCCESS` or `tec*`. **Output:** one row per affected
`AccountRoot`/`RippleState` node.
- `parseAccountRoot`: XRP balance deltas. For the sending account it emits a separate
  `type: 'fee'` row and nets the fee out of the real change.
- `parseRippleState`: emits **two mirror rows** (low party and high party) for an IOU
  trustline, with `final_balance` negated for the high side.
- `findType` classifies each change: `fee`, `payment_source`, `payment_destination`,
  `exchange`, `intermediary`.
  **Correctness fix (review C3):** one branch was `data.account = transaction.Account`
  (an **assignment** that always truthy-evaluated and corrupted `data.account`); it is now
  the intended `===` **comparison**. This is a load-bearing fix — without it, payment-source
  classification and the account it was attributed to were both wrong.
- After the main pass, escrow/paychannel `AffectedNodes` are matched onto the relevant
  account rows to annotate `escrow_*` / `paychannel_*` fields and refine `type`.

### `accounts-created.parser.ts` — `accountsCreated[]`
**Input:** `tesSUCCESS` txs. **Output:** one row per `CreatedNode` of type `AccountRoot`.
Records the new `account`, its funding `parent` (the tx `Account`), and starting `balance`
(XRP).

### `affected-accounts.parser.ts` — `affectedAccounts[]`
**Input:** any tx with metadata. **Output:** one row per affected account address.
Uses `getAffectedAccounts(meta)`; filters to addresses starting with `r`. This is the
"which accounts did this tx touch" index, carrying `tx_result` and `tx_type`.

### `offers.parser.ts` — `offers[]`
**Input:** `Payment`/`OfferCancel`/`OfferCreate` with `tesSUCCESS`. **Output:** one row per
Offer node (Created/Modified/Deleted).
Captures `account`, `offer_sequence`, `book_directory`, `taker_pays`/`taker_gets`
(normalizing XRP drops), `rate` (`parseQuality`), and `pays_change`/`gets_change` deltas.
`change_type` is classified: `create`, `partial_fill`, `cancel`, `replace`, `fill`,
`unfunded_cancel`, `unfunded_partial_fill`. Carries `node_index`.

### `issuers.parser.ts` — `issuers[]` (the historically-correct trustline snapshot)
**Input:** any tx with metadata. **Output:** one `ParsedIssuerTrustline` per affected
`RippleState` node with a non-zero balance.
- For each RippleState node it reads `Balance.value`, `HighLimit.issuer`, `LowLimit.issuer`.
  **Sign convention:** the balance is signed from the low account's perspective — positive
  ⇒ `issuer = high`, `counterparty = low`; negative ⇒ the reverse. The stored `balance` is
  the absolute value.
- **Why this matters (review H6):** the old pipeline derived issuer trustlines from a
  **per-transaction `account_lines` RPC**. That was (a) a throughput bottleneck — one
  network round-trip *per transaction* — and (b) **historically wrong**, because it always
  queried `ledger_index: 'validated'` ("now") rather than the ledger being processed.
  Deriving the snapshot from the affected RippleState nodes gives the balance **as of this
  ledger** and needs **no network call** — so it is both correct for backfilled history and
  fast. Rows dedup downstream in a `ReplacingMergeTree` keyed on
  `(issuer, currency, counterparty)` with `ledger_index` as the version, so the latest
  snapshot wins.

### `escrow.parser.ts` — `escrow?`
**Input:** `EscrowCreate`/`Cancel`/`Finish` with `tesSUCCESS`. **Output:** one
`ParsedEscrow` or `undefined`.
Finds the escrow node (Deleted or Created) in the metadata.
**Guard (review H4):** `EscrowCancel`/`Finish` carry no top-level `Amount`, so amount falls
back to the node fields and is only converted when present (`rawAmount != null`). Converts
`CancelAfter`/`FinishAfter` from ripple time to unix seconds.

### `paychan.parser.ts` — `paychannel?`
**Input:** `PaymentChannelCreate`/`Fund`/`Claim` with `tesSUCCESS`. **Output:** one
`ParsedPayChannel` or `undefined`.
Finds the `PayChannel` node and reads `f.Account`/`Destination`/`Amount`/`Balance` from its
`NewFields`/`FinalFields`. **Guard:** if no PayChannel node is present it defaults to
`{ fields: {} }` so field access never throws, and amount/balance conversions are only done
when the field exists.

### CTID — `packages/shared/src/util/ctid.ts`
The **Concise Transaction Identifier** (XLS-37d): a deterministic id from
`(ledger_index, tx_index, network_id)`, e.g. `getTxCtid` produces
`C` + 7-hex ledger + 4-hex tx-index + 4-hex network. It is computed in the processor (not
the parsers) and used as the ClickHouse sort/dedup key for per-tx rows, making replay
idempotent. `getNodeCtid` appends a 4-digit node index for per-node rows. `parseCtid`
inverts it. This replaces Elasticsearch's auto-generated `_id`, which produced duplicate
documents on any replay.

### Time helpers — `packages/shared/src/util/time.ts`
`RIPPLE_EPOCH_MS`, ISO↔ripple/unix converters, and `toClickHouseDateTime(seconds)` which
formats unix seconds as a UTC `'YYYY-MM-DD HH:MM:SS'` string (ClickHouse `DateTime`). The
processor uses the latter for every `date`/`close_time` column.

### Retry helper — `packages/shared/src/util/helpers.ts`
`retry(fn, { attempts=5, baseDelayMs=250, maxDelayMs=10_000, onRetry })` — bounded retries
with **exponential backoff** (`base * 2^(attempt-1)`, capped), re-throwing the last error
on exhaustion. Used for ledger fetch (§3) and the ClickHouse flush (§5). Also exports
`wait(ms)` (used for the per-worker throttle) and `chunk`.

---

## 5. Batched writing & idempotency: `ClickHouseDataProcessorService`

`apps/syncer/src/processor/clickhouse-data-processor.service.ts`.

### Buffering & flush

- `enqueueLedger(ledger, parsed)` is **synchronous** — safe to call from concurrent
  backfill workers. For each parsed tx it computes the `ctid` and appends rows to per-table
  buffers (a `Map<table, rows[]>`) plus one `ledgers` "commit marker" row. It increments
  `bufferedLedgers`.
- `maybeFlush(threshold)` flushes once `bufferedLedgers >= threshold` (the threshold is
  `GH_BACKFILL_BATCH_LEDGERS`, default 500).
- `flush()`:
  1. Snapshots and **clears the buffers up-front** (`resetBuffers`) so concurrent workers
     can keep enqueuing during the network I/O.
  2. Inserts **all `CHILD_TABLES` in parallel** (skipping empty ones), then inserts the
     `ledgers` markers **last**.
  3. The whole batch is wrapped in `retry(…, { attempts: 5 })`.
- `insertLedger(ledger, parsed)` = `enqueueLedger` + immediate `flush()` — used by live sync
  (ledgers arrive ~1 per 3–4 s, so there's nothing to batch).

### Why batch matters

**ClickHouse creates one storage "part" per INSERT.** A ledger produces ~11 inserts; over a
multi-million-ledger backfill, per-ledger inserts would create an unsustainable number of
tiny parts ("too many parts" errors) and waste round-trips. Buffering N ledgers and issuing
**one INSERT per table per flush** cuts round-trips roughly 100× and keeps part counts sane.
Inserts use `JSONEachRow` (`ClickHouseService.insert`).

### Children-then-marker ordering

`CHILD_TABLES` (transactions, payments, exchanges, balance_changes, affected_accounts,
accounts_created, offers, issuers, escrows, paychannels) are always written **before** the
`ledgers` row for that batch. The `ledgers` row acts as a **commit marker**: a ledger
present in `ledgers` is taken to mean its children were written. This ordering is what makes
the skip-window (§6) safe.

### Idempotency & crash-safety

- Every table is a **`ReplacingMergeTree(ledger_index)`** (the `ledger_index` is the
  version column — latest wins on merge). Each table dedups on its `ORDER BY` natural key:
  - `transactions`, `payments` → `ctid`
  - `exchanges` → `(base_currency, base_issuer, counter_currency, counter_issuer, date, tx_hash, node_index)`
  - `balance_changes` → `(account, currency, date, tx_hash, node_index)`
  - `offers` → `(account, date, tx_hash, node_index)`
  - `affected_accounts` → `(account, date, tx_hash)`
  - `accounts_created` → `account`; `escrows`/`paychannels` → `tx_hash`
  - `issuers` → `(issuer, currency, counterparty)`
  - `ledgers` → `ledger_index`
  So **re-processing a ledger collapses to identical rows** — replay is a no-op once merges
  run.
- The ClickHouse client no longer sets global `insert_deduplicate` / `async_insert`
  settings. Server-side insert-time de-duplication is opted into **per insert**:
  `ClickHouseService.insert(table, rows, { dedupToken })` sends `insert_deduplication_token`,
  which only takes effect on a table created with `non_replicated_deduplication_window > 0`.
- **Mid-batch crash:** if the process dies after writing some child tables but before the
  `ledgers` markers, those ledgers are simply *not* recorded as inserted. The next run sees
  them missing in the skip-window and **re-ingests them** — which, thanks to the dedup keys
  + `insert_deduplicate`, is harmless. The only "cost" is re-writing a few already-present
  child rows that merges will collapse.

### `getInsertedLedgers(from, to)`

A parameterised query — `SELECT ledger_index FROM ledgers WHERE ledger_index BETWEEN
{from} AND {to}` — returning a `Set<number>`. This is the source of truth for "what's
already done" and drives the skip-window.

---

## 6. Backfill mechanics

`SyncProcessorService.backfill` (`sync-processor.service.ts`).

- **Worker pool.** `workers = max(1, GH_BACKFILL_WORKERS)` worker coroutines run
  concurrently via `Promise.all`. Each worker loops, claiming the next ledger.
- **Cursor.** `claimNext()` hands out `cursor++` (a shared integer) until `cursor > to`.
  This is a simple atomic-ish claim (single-threaded JS event loop), so each ledger is
  processed by exactly one worker.
- **Windowed skip of already-inserted ledgers (single-flight).** A `SKIP_WINDOW = 10_000`
  block of "already inserted" indices is cached in a `Set`. `refreshWindowIfNeeded(index)`
  reloads the window when `index` falls outside it. **Only one worker loads the window at a
  time** — others `await` the same in-flight `windowLoad` promise (this fixes a shared-state
  race in the old version). If `inserted.has(index)`, the worker counts it done and skips
  the fetch entirely. This is what makes restarts cheap: a re-run skips everything already
  present instead of re-fetching it.
- **Per-ledger work:** `fetchAndParse(index)` → `enqueueLedger` → `maybeFlush(batch)`. On
  success it bumps `done`, updates `maxSynced` + the `latestSyncedLedger` gauge, increments
  `ledgersProcessed`, and every 1000 ledgers logs the rate (`N ledgers (R/s)`).
- **Retries & failed-ledger handling.** The fetch itself is retried inside `fetchAndParse`
  (5 attempts, backoff). If a ledger still throws (exhausted retries), the worker logs
  `Ledger N permanently failed after retries` and pushes `N` onto a `failed[]` list —
  it does **not** abort the whole backfill. At the end, `failed.length` and (up to 50 of)
  the indices are logged.
- **Throttle.** After each ledger, if `GH_FETCH_THROTTLE_MS > 0`, the worker `wait`s that
  long — a per-worker pause to stay under a node's rate limit.
- **Tail drain.** After all workers finish, `processor.flush()` writes whatever is left in
  the buffer (the last partial batch).

### Re-running gaps

Restarting resumes cleanly (skip-window). To repair the ledgers reported in the
`… failed and were not indexed: …` line, re-run with `GH_BACKFILL_START_LEDGER` /
`GH_BACKFILL_END_LEDGER` narrowed to those ranges. See
[docs/backfill.md](./backfill.md#resuming--gap-repair).

---

## 7. Horizontal scaling (sharding)

`shardRange(from, to)` splits `[from, to]` into `shardTotal` **contiguous** slices and
returns the slice for `shardIndex`:

```
size      = ceil((to - from + 1) / shardTotal)
shardFrom = from + shardIndex * size
shardTo   = min(to, shardFrom + size - 1)
```

(`shardTotal <= 1` ⇒ the whole range.) If a shard's `from > to` it logs "empty" and
returns. So you can run **N syncer instances** with the same `GH_BACKFILL_START_LEDGER` /
`END_LEDGER` but different `GH_BACKFILL_SHARD_INDEX` (`0..N-1`) and `GH_BACKFILL_SHARD_TOTAL
= N`, and each handles a disjoint contiguous slice. Point each instance at its **own XRPL
node** (`GH_XRPL_NODE_ENDPOINT`) to multiply fetch throughput — fetch latency, not
ClickHouse, is the bottleneck. Because writes are idempotent, even overlapping shards are
safe. Remember to run migrations from only one place (§2).

---

## 8. Live sync

`SyncProcessorService.subscribeLive`:

- Subscribes to `XrplConnectionService.ledger$` (the `ledgerClosed` event Subject).
- **Promise-chain serialization.** Each incoming ledger appends to a `chain` promise:
  `chain = chain.then(process(index)).catch(log)`. This processes ledgers **strictly one at
  a time, in order**, with **no shared mutable `isWorking` flag** — the old design used such
  a flag and could *drop* a ledger that arrived while idle (review M7). With the chain, a
  ledger arriving during processing simply queues behind the current one.
- Each step does `fetchAndParse(index)` → `insertLedger` (immediate flush, since live
  ledgers are infrequent) → updates the `latestSyncedLedger` and `ledgersProcessed` gauges.
- Finally calls `xrpl.subscribeToLedgers()` to start the stream.

### XRPL connection (`xrpl-connection.service.ts`)

- Owns the `xrpl.js` `Client` (20 s connection timeout). On `onModuleInit` it connects and
  registers handlers; `ledgerClosed` events are pushed into `ledger$`.
- **Reconnect & re-subscribe.** `xrpl.js` auto-reconnects internally. On every `connected`
  event, if a live subscription was ever established (`liveSubscribed`), it
  **re-subscribes** to the `ledger` stream — so the live feed is not silently lost after a
  reconnect. `subscribeToLedgers` throws if the subscribe response is empty and sets
  `liveSubscribed = true`.
- The class header notes it fixed prior review findings: no more `assert` from `console`
  (which never throws in prod), guarded/awaited reconnects, and the re-subscribe.

---

## 9. Resilience & failure modes (honest)

**Handled:**
- *XRPL transient errors / "ledger not found":* retried 5× with backoff per ledger; a
  permanent failure is recorded and reported, not fatal.
- *XRPL disconnect:* `xrpl.js` auto-reconnects; live re-subscribes automatically.
- *ClickHouse transient errors:* the whole flush batch is retried 5× with backoff.
- *Replay / restart / overlap / mid-batch crash:* idempotent via CTID-keyed
  `ReplacingMergeTree` + `insert_deduplicate=1` + children-before-marker ordering. Re-runs
  skip already-inserted ledgers via the window.
- *Process probeability:* HTTP health/metrics stay up independently of ingestion.

**Not handled yet (be aware):**
- **Reorgs / non-validated ledgers.** The backfill fetches by `ledger_index` without an
  explicit *validated* gate, and live ingests on `ledgerClosed`. There is no reorg detection
  or rollback — the design assumes the node serves validated, final ledgers (true for
  historical backfill; a theoretical edge for the very head in live mode).
- **Dead-letter / durable failed-ledger queue.** Permanently-failed ledgers are only
  *logged* (in-memory `failed[]`, list truncated to 50 in the message). There is no
  persistent dead-letter store; gap repair is manual (re-run a narrowed range, §6).
- **Validated-ledger gating / completeness verification.** No post-hoc check that the
  `[from, to]` range is fully contiguous in ClickHouse beyond the skip-window lookup.
- **Mid-batch atomicity across tables.** Children and the ledger marker are separate
  inserts; a crash between them is *recovered by re-ingest*, not by a transaction (ClickHouse
  has none). This is safe but not atomic.
- **Backpressure between fetch and write.** Buffers grow in memory until the flush
  threshold; an extended ClickHouse outage (beyond the 5 retries) would surface as an error,
  not graceful backpressure.

---

## 10. Operational tips

### Throughput knobs (`syncer.config.ts` ← env)

| Env var | Config | Default | Effect |
| --- | --- | --- | --- |
| `GH_XRPL_NODE_ENDPOINT` | `xrplEndpoint` | *(required)* | ws/wss node URL. Own full-history node for backfill (see backfill.md). |
| `GH_XRPL_NETWORK_ID` | `networkId` | 0 | Goes into the CTID. |
| `GH_RUN_MIGRATIONS_ON_BOOT` | `runMigrationsOnBoot` | true | Set `false` on extra replicas. |
| `GH_BACKFILL_ENABLED` | `backfillEnabled` | (`true` only if `="true"`) | Enable the sweep. |
| `GH_BACKFILL_START_LEDGER` / `_END_LEDGER` | `backfill{Start,End}Ledger` | node range | Clamped to node `complete_ledgers`. |
| `GH_BACKFILL_WORKERS` | `backfillWorkers` | 8 (example: 12) | Concurrency of the fetch pool — the main throughput lever; raise toward your node's rate limit. |
| `GH_BACKFILL_BATCH_LEDGERS` | `backfillBatchLedgers` | 500 | Ledgers buffered per flush. Bigger = fewer/larger inserts, more memory & more re-work on crash. |
| `GH_FETCH_THROTTLE_MS` | `fetchThrottleMs` | 100 | Per-worker pause; raise if you see rate-limit errors, lower (0) for a dedicated local node. |
| `GH_BACKFILL_SHARD_INDEX` / `_TOTAL` | `shardIndex` / `shardTotal` | 0 / 1 | Horizontal sharding (§7). |
| `GH_SUBSCRIBE_LIVE` | `subscribeLive` | (`true` only if `="true"`) | Follow the head. |
| `GH_HTTP_API_PORT` | — | 3002 | Health/metrics port. |

Practical tuning: for a fast local full-history node, push `GH_BACKFILL_WORKERS` up
(12–16+) and drop `GH_FETCH_THROTTLE_MS` toward 0. Against a public cluster, keep workers
modest and the throttle ≥100 ms (see backfill.md for the rationale and node-choice
trade-offs).

### Metrics to watch (`/metricz`)

- **`syncer_ledgers_processed_total`** — gauge incremented per successfully processed ledger
  (since process start). Watch its *rate* for throughput.
- **`syncer_latest_synced_ledger`** — highest ledger index written. In live mode it should
  track the network head (advance every ~3–4 s); in backfill it climbs through the range.
- Plus default process metrics (prefixed `syncer_`).
- Useful log lines: `Backfilled N ledgers (R/s), cursor X` (every 1000), the final
  `Backfill complete` / `… ledgers failed and were not indexed: …`, and the XRPL
  connect/disconnect/re-subscribe logs.

---

## File map

| Concern | File |
| --- | --- |
| Boot / HTTP server | `apps/syncer/src/main.ts` |
| Module wiring | `apps/syncer/src/app.module.ts`, `sync/sync.module.ts` |
| Mode selection / migrations on boot | `apps/syncer/src/app.service.ts` |
| XRPL websocket / reconnect | `apps/syncer/src/xrpl/xrpl-connection.service.ts` |
| Fetch + parse one ledger | `apps/syncer/src/sync/ledger-ingestor.ts` |
| Backfill pool + live chain | `apps/syncer/src/sync/sync-processor.service.ts` |
| Buffering / batched writes / idempotency | `apps/syncer/src/processor/clickhouse-data-processor.service.ts` |
| Config knobs | `apps/syncer/src/config/syncer.config.ts` |
| Parser suite | `packages/shared/src/parsers/*` |
| CTID / time / retry | `packages/shared/src/util/{ctid,time,helpers}.ts` |
| ClickHouse client (per-insert dedup token) | `packages/shared/src/clickhouse/clickhouse.service.ts` |
| Table names / schema engines | `packages/shared/src/clickhouse/tables.ts`, `packages/shared/schema/001_tables.sql` |
| Metrics / health | `apps/syncer/src/modules/{prometheus,liveliness}/*` |

See also: [docs/backfill.md](./backfill.md) (history sizing & running rippled),
[docs/architecture.md](./architecture.md), [docs/data-model.md](./data-model.md).
