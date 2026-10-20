# The syncer (ingestion service)

`apps/syncer` (`@gatehub/data-syncer`) fills the ClickHouse database of **one network** with everything the
[API](api-reference.md) serves. It is a NestJS process that runs up to five **workers** and exposes a liveliness probe
(`GET /liveliness/healthz`, port 3002) and Prometheus metrics (`GET /metricz`, port 3000). Run **exactly one syncer per network
and database**. Settings: [configuration](configuration.md#5-syncer-appssyncer); metrics: [observability](observability.md).

```
                      GH_NODE_ENDPOINTS (rippled / xahaud, websocket)
                                  │  NodeClient: failover, watchdog, re-subscribe
   ┌──────────────┬───────────────┼────────────────┬─────────────────┬──────────────────┐
   │ ingest       │ validations   │ fee_stats      │ aggregator      │ validators       │   <- GH_WORKERS
   │ LiveRunner   │ Collector     │ FeeStatsPoller │ stats, volumes, │ lists, domains,  │
   │              │               │                │ rates, markets, │ state, rounds,   │
   │              │               │                │ account rollups │ agreement        │
   └──────┬───────┴───────┬───────┴───────┬────────┴────────┬────────┴─────────┬────────┘
          ▼               ▼               ▼                 ▼                  ▼
   14 ledger tables   validations    fee_stats        stats_hourly,      unl_lists, unl_publishers,
   (ledgers = commit  validator_     (every 5 s)      volume_live,       validator_domains,
    marker)           manifests,                      volume_daily,      validator_manifests (rpc),
                      validator_                      + 9 tables of 003  network_state,
                      validations,                    (read the ledger   amendment_features,
                      validator_seen                  tables)            validator_votes,
                                                                         amendment_tallies,
                                                                         validator_agreement_hourly
                          ClickHouse, database = the network name
```

Besides the node, the fifth worker, `validators` ([section 8](#8-the-validators-worker)), fetches the validator lists of the UNL publishers and
the TOML files of the validators' domains over HTTPS, and reads the ledgers and validations the other workers stored.

## 1. Boot

`main.ts` loads and validates the configuration (the process exits with a message naming the bad variable), builds the app from
the **enabled workers** only (`GH_WORKERS`, default all five), and starts the toolbox bootstrap (probe + metrics ports).
Then, in order:

1. If `GH_RUN_MIGRATIONS_ON_BOOT=true`, the schema is applied (the compose stacks leave this off: the `migrate-<network>` job
   owns it). Then, with the `validations` or `validators` worker enabled, the schema of `002_validators_amendments.sql` is checked
   (`system.columns`): a database without it refuses the boot with a message that names the file and what is missing (a check
   that cannot reach ClickHouse is logged and the boot goes on).
2. The shared **`NodeClient`** connects to `GH_NODE_ENDPOINTS` and checks that the node belongs to `GH_NETWORK`
   (`server_info.network_id`: XRPL reports 0 or nothing, Xahau 21337/21338). A node of another network refuses the boot.
3. The workers start in their lifecycle hooks. SIGTERM/SIGINT run the registered cleanups (workers stop, the lease is released,
   the node client stops) within 10 s; the compose `stop_grace_period` is 30 s.

The probe port opens only after the node connection is up.

## 2. NodeClient

One resilient websocket connection (`packages/shared/src/xrpl/node-client.ts`), shared by everything in a process that talks
to a node, and by the API (which uses it for balances and orders). It owns one `xrpl.js` client at a time and never relies on
`xrpl.js` reconnecting (xrpl.js 2.14 gives up after a failed reconnect):

- **Failover:** endpoints are tried round-robin, with a capped exponential backoff (1 s doubling to 30 s) after a failed round.
- **Watchdog (every 5 s):** a dead connection, or one whose subscribed streams have been silent for 30 s, is retired and
  replaced.
- **Re-subscribe:** subscribed streams are remembered and sent again on every new connection.
- **Requests:** timeout (default 30 s, waiting for a connection and again for the answer), up to 3 retries on a fresh
  connection after a disconnect or timeout. A timeout recycles the shared connection (a timed-out socket is the usual stuck
  socket). `tooBusy` / `noCurrent` style errors come back as `RippledError` and are the caller's to retry.
- **Network check:** `server_info.network_id` must match the profile.

Do not send `api_version` to the node: both rippled and xahaud default to API v1, which is the shape the parsers expect.

## 3. The ingest worker (`LiveRunner`)

The single writer of the ledger tables. It follows the validated chain, one ledger at a time in order, and makes every ledger
**atomic**: a ledger exists for readers exactly when its `ledgers` row does.

### Writing a ledger: `buildLedgerRows` and `LedgerWriter`

For each ledger, `buildLedgerRows` (pure, in the shared package) turns the node's expanded ledger into rows of the 14
**ledger-derived tables** (`ledgers`, `ledger_by_hash`, `transactions`, `tx_by_hash`, `tx_by_type`, `account_transactions`,
`account_tx_by_sequence`, `payments`, `payments_by_currency`, `account_payments`, `exchanges`, `account_exchanges`,
`balance_changes`, `accounts_created`; see [data-model](data-model.md)). The parsers never mutate their input and take the
network profile (native currency, CTID network id, the ledger from which partial payments report `delivered_amount`).
`LedgerWriter.write()` then inserts, in this order:

1. all child tables, in parallel (each insert is chunked at 50,000 rows),
2. `ledger_by_hash`,
3. `ledgers` — **the commit marker**, in ascending order, so the checkpoint never skips an uncommitted ledger.

Every insert is synchronous (`async_insert=0`) and carries an `insert_deduplication_token`
`<runId>:<table>:<first>-<last>:<chunk>` (the tables keep the tokens of their last 1000 inserts, `non_replicated_deduplication_window`)
and the same string as its `query_id`. So a retried batch re-sends only what did not go in, and everything a run has in flight
can be found, waited for and killed by its `runId` prefix. Nothing reads rows of a ledger that has no `ledgers` row, so a
half-written ledger is invisible; recovery removes it.

### Checkpoint, boot and recovery

- **Checkpoint** = `max(ledger_index)` of `ledgers`. There is no separate cursor to lose.
- **Lease.** Before anything else the runner takes the `syncer_lease` row of the network. A lease whose heartbeat (server clock)
  is younger than **30 s** belongs to its holder and refuses the boot (an old syncer that is still running holds it: stop it
  first, see [deployment](deployment.md#cutover-on-an-existing-host)). The holder heartbeats every 10 s, and every heartbeat
  first checks that the newest lease row is still its own: if another syncer took over after a stall, the runner **halts**
  (`lease lost to <holder>`), writes nothing more and the probe goes 503. Releasing the lease inserts a newer row with an empty
  holder.
- **Verify.** The node must confirm the hash stored for the checkpoint, else the runner halts (data and node disagree about
  history; only an operator can tell which is wrong).
- **Clean the tail.** Rows above the checkpoint are rows of ledgers that never committed. They are deleted with partition-scoped
  lightweight `DELETE`s (the `ledgers` row first) and the runner waits for the deletes (`lightweight_deletes_sync=2`).
- **First boot** (no checkpoint): the start is `GH_SYNC_START_LEDGER` (default: the validated head). The start is recorded as a
  *live intent* in `ingest_log` (`run_id live:<bootId>`, key `(start, 0)`) until the first commit, so that a crash during the
  first write is cleaned up at the next boot even though the head has moved. `GH_SYNC_START_LEDGER` is ignored once a ledger
  exists.
- **Failed write.** Wait until the failed run's queries are really gone (`awaitQuiescence`: a request the client gave up on may
  still run on the server and land behind a delete), re-read the checkpoint, delete everything above it and wait for that too,
  then carry on with a **new `runId`** (the tables remember the tokens of deleted rows; reusing a `runId` would silently drop the
  rewrite) and a pipeline rebuilt from checkpoint + 1. A recovery step that fails (a stuck mutation) is logged, shown in the
  probe (`recovering`, `error`) and retried with backoff; nothing is written meanwhile.

### The loop

- **The head.** The `ledgerClosed` stream is only a hint; ledgers are always **fetched by index** (`ledger` with
  `transactions` and `expand`). When no hint has arrived for 15 s the runner polls `validatedHead()` instead. The head never
  goes down, so the lag stays defined while the node is away.
- **Catch-up.** Up to `GH_CATCHUP_CONCURRENCY` (4) ledgers are fetched at once, each retried **forever** with a capped backoff
  (0.5 s doubling to 30 s): a ledger is never skipped. A node that rate limits the syncer is waited out instead, for as long as
  it asks (see [Rate limits](#rate-limits)). A fetched ledger is accepted only if the node says it is `validated`.
  Accepted ledgers are reordered and chained in index order: each `parent_hash` must be the hash of the ledger before it. A break
  commits the verified prefix and **halts** the runner (probe 503).
- **A ledger the parser rejects** (`Cannot parse ledger <index>: <reason>`) is not retried: parsing is pure and would fail the
  same way after any recovery. The ledgers of the batch before it are committed, then the runner **halts** like on a chain break
  (probe 503 with the error, `syncer_ingest_halts_total{reason="parse_error"}`). It needs a parser fix; after the restart the
  runner carries on after the checkpoint, at the ledger that failed.
- **Flush.** An accepted batch is written when it holds `GH_CATCHUP_FLUSH_LEDGERS` (300) ledgers or `GH_CATCHUP_FLUSH_TXS`
  (100,000) transactions, is `GH_CATCHUP_FLUSH_MS` (5 s) old, reaches the head (live: every ledger is its own commit), or the
  next ledger starts a new `ledgers` partition: a commit never spans two partitions of a million ledgers, so a half-applied
  commit cannot leave a marker above a gap.
- **Shutdown.** A write in progress finishes, a partial batch is dropped and refetched next time, the lease is released.

States (probe and `syncer_*` metrics): `starting`, `catching_up`, `live`, `halted`. Lag = validated head − committed checkpoint.

### Rate limits

Public nodes limit what one client may ask (`rate limit: units quota (50000 per 10s) exhausted, retry in ~12376ms` on
`xahau.network` and `xrplcluster.com`, rippled's own `slowDown` / `tooBusy`). The node client of the process honours that
answer, for requests and for refused connections alike: the endpoint gets **nothing** (no request, no connection attempt, from
any client of the process: ingest, fee poller, validations collector) until the wait it named is over (plus 250 ms; 10 s when
it names none; at most 20 minutes). Meanwhile another endpoint of `GH_NODE_ENDPOINTS` takes the requests; when every endpoint
is paused a request fails at once and its caller waits: the live runner fetches the ledger again when the pause ends, the fee
poller skips its samples (counted in `syncer_fee_stats_errors_total`), the boot network check retries. Each pause is logged
once (`... It rate limits this client: nothing is sent to it for 12.6 s`) and counted in
`syncer_node_rate_limited_total{endpoint}`.

The XRPL default is `wss://s2.ripple.com,wss://xrplcluster.com` (Ripple's full-history server first; it did not throttle a
first sync at concurrency 2 in the verification run) and `GH_CATCHUP_CONCURRENCY` defaults to 4. A Xahau ledger is about 260 KB:
`wss://xahau.network` throttles a catch-up even at concurrency 1 (its 50,000 units per 10 s let 2 to 3 such ledgers through), and
the syncer waits each pause out: the catch-up is slow, it does not fail.

### Boot without a node

The shared node client is made only when a worker reads from it (`ingest`, `fee_stats`, `validators`); the validations collector opens its own
client per node. A syncer with `GH_WORKERS=aggregator` boots and serves its probe while every node is down. The boot network check
(`server_info`, which must report the network of `GH_NETWORK`) is retried with a backoff (1 s doubling to 30 s, or the wait a
rate-limiting node asks for) instead of ending the boot; only a node of another network ends it.

### Catch-up after an outage

Nothing special is needed: restart (or let `restart: unless-stopped` restart) the syncer. It reads the checkpoint, cleans the
tail, and catches up from checkpoint + 1 at the speed the node allows. Needs a node that still **has** those ledgers
(`complete_ledgers` of `server_info`); a ledger the node no longer has fails the fetch forever and the runner keeps retrying,
visible as lag that does not shrink. Point `GH_NODE_ENDPOINTS` at a full-history node (see [backfill](backfill.md)).

## 4. Range ingest (CLI)

For history, gaps and parser changes. It runs next to the live syncer, in the same image:

```bash
# from source: `ingest:range` runs the compiled dist/cli/range-ingest.js, so run `pnpm build` first; it needs the syncer's GH_* environment
# (apps/syncer/.env, or GH_ENV=local with the variables exported)
pnpm build && GH_ENV=local pnpm --filter @gatehub/data-syncer ingest:range --from 90000000 --to 90100000

# in the container stack
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm --no-deps syncer-xrpl \
  node dist/cli/range-ingest.js --from 90000000 --to 90100000
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--from <n>`, `--to <n>` | required | Both inclusive. |
| `--chunk <n>` | 1000 | Ledgers per chunk; must divide 1,000,000. A chunk is fetched and written as a whole, so it is also the memory the run needs. |
| `--concurrency <n>` | 8 | Ledgers of a chunk fetched at once. On XRPL's public nodes 2, on `wss://xahau.network` 1 (see [backfill](backfill.md#public-nodes-and-rate-limits)). |
| `--max-wait <s>` | 1200 | Seconds a chunk may go without a ledger arriving while its fetches wait for a rate-limited node (as long as it asks) or retry a ledger the node lacks right now (`lgrNotFound`, after 0.5 s doubling to 30 s). Every ledger fetched starts it again; past it the chunk fails (the log names `--max-wait`). A pause the node asks for that is longer than it fails the chunk at once, and the log says so. |
| `--reprocess` | off | Delete and rewrite ledgers that are already committed (after a parser change); default: skip them. |
| `--allow-gap` | off | Allow a range that starts above the highest committed ledger + 1 on a database a live syncer has run on; refused by default because the live syncer would skip the ledgers in between (Ruling R110). |
| `--run-id <id>` | random | Name of the run in `ingest_log` and in query ids (a per-invocation nonce is appended). Must not start with `live:`. |
| `--help` | | Prints the usage. |

Exit status: `0` ingested, `1` the run failed (**rerun the same command**: finished chunks are skipped, unfinished ones redone),
`2` wrong command line.

How it works (aligned chunks, `ingest_log` intents):

1. Per chunk, the ledgers already committed are skipped (unless `--reprocess`).
2. An `ingest_log` row `started` is written **before** anything is deleted or written, the ledgers are fetched (and, when they
   replace committed ones, dry-parsed, so that a missing ledger, a failing node or a parser error leaves the committed chunk
   untouched), the chunk is written with one `LedgerWriter.write()`, then `ingest_log` gets `done`.
3. A chunk whose newest log row is `started` is an **unfinished intent**: a run died (or gave up) in the middle of it. The next run
   whose range overlaps it waits for that run's queries to be gone, then, **before its own chunks**, redoes the intent over its
   whole recorded range, whatever `--chunk` and the range of this run are (overlapping intents as one range): a ledger committed in
   the range is complete and stays as it is; every other ledger of the recorded range is fetched and dry-parsed, also those
   outside `--from`..`--to` (an index-list run of the API keeps to its listed ledgers inside its own range), then every uncommitted
   span of the range is deleted (with the child rows a crashed write left) and they are written; the intent gets `done`, and the
   hours of all the committed ledgers of the range are marked in `agg_dirty` (Ruling R110: the run that died may have committed
   some and never marked them). So an intent is redone once, not by every run after it, and changing `--chunk` or narrowing the
   range between runs is safe.
4. Every written chunk marks its hour range in **`agg_dirty`** so the aggregator recomputes the stats and daily volumes. Committed
   ledgers a run skipped get one row at the end.
5. A failed attempt is recovered like a failed live write (wait for the queries, delete the chunk, new `runId`); a chunk gets 3
   attempts. A rate-limited fetch is retried when the node's pause is over, and a ledger the node does not have right now
   (`lgrNotFound`, e.g. one member of a cluster without it) after a backoff. The chunk fails, and the run stops, only when
   `--max-wait` passes with no ledger of the chunk arriving (every ledger fetched starts it again); when another fetch of the
   chunk fails, the fetches that wait are woken and the attempt ends at once. A ledger the parser rejects (`Cannot parse ledger <n>: ...`) and a live syncer that appeared are not
   retried: they stop the run.
6. **The live syncer owns everything above its checkpoint.** A range that reaches above the committed checkpoint is refused while
   the syncer's lease is fresh (< 30 s), and this is re-checked per chunk. Backfill is history: below the checkpoint. On a database
   a live syncer has run on (a `syncer_lease` row), a range that starts above the checkpoint + 1 is refused even with the lease
   released, unless `--allow-gap`: the live syncer resumes after the highest committed ledger and would never fetch the ledgers in
   between (Ruling R110).
7. `--reprocess` rewrites the whole requested range; it fetches and dry-parses before it deletes anything.

Do not run two range ingests over overlapping ranges at the same time. Throughput is bound first by the node, then by
ClickHouse; raise `--concurrency` with your own node.

## 5. The validations worker

`ValidationsCollector` listens to the `validations` and `manifests` streams of every node of `GH_VALIDATION_ENDPOINTS` (one
`NodeClient` per endpoint, so each reporter is distinct; a node that is down does not hold up the others) and writes
`validator_manifests`, `validations`, `validator_validations` and `validator_seen`:

- **`reporter_public_key`** is the `pubkey_node` of the node the message came from (asked of `server_info` on each (re)connect).
  A message that arrives while it is unknown is dropped and counted (`reason="no_reporter"`).
- **`validation_public_key`** (the validator's master key) is the `master_key` of the message, else the manifest map (loaded from
  `validator_manifests`, kept current from the `manifests` stream), else the `manifest` RPC (waits at most 4 s; a miss is
  remembered for 10 minutes, a failure for 30 s), else the signing key. `ephemeral_public_key` is the signing key.
- **Merging:** one row per (`ledger_hash`, `validator`); `count` goes up, first/last time of receipt are kept; the table adds
  partial sightings up on merge (AggregatingMergeTree) and the API on read.
- **`validations.server_version`** is the `server_version` of the message (the software version the validator reports in its
  validation of a voting ledger; absent elsewhere, so NULL), kept as exact digits of the UInt64.
- **Manifests** keep the `domain` they name and the raw manifest as upper-case hex (the stream gives hex, the `manifest` RPC
  base64), with `source` `stream` or `rpc`. The highest `seq` per signing key still wins.
- **Per-validator tables.** The same sightings are also merged into `validator_validations` (one row per master key, ledger index
  and ledger hash: narrow, `full` the max; kept 7 days) and `validator_seen` (one row per master key: first and last time seen and
  the newest ledger; kept for ever). A flush writes the four tables in the order `validator_manifests`, `validations`,
  `validator_validations`, `validator_seen`; a table that fails neither stops the ones after it nor makes the ones before it be
  written again.
- **Flush every 20 s.** A failed `validations` flush puts its rows back into the buffer (at-least-once; an insert that times out
  after ClickHouse took the rows is written twice and that validation's `count` is too high — rare, accepted). The two
  per-validator tables have no duplicates on a retried batch instead: their rows leave in one batch per flush with the
  `insert_deduplication_token` `vc:<bootId>:<table>:<flushSeq>` (`bootId` is random per process), and both tables keep a dedup
  window of 100 inserts. A batch that failed stays as it was and is sent again, oldest first, before the new one, with its own
  token, so a retry of an insert that landed after all is dropped by the server. A table whose oldest batch fails again is
  left alone for that flush, and what is seen meanwhile collects in a new batch. Failures are counted in
  `syncer_validations_errors_total{stage}` (`flush`, `flush_by_validator`, `flush_seen`), and the rows written in
  `syncer_validator_validations_flushed_total{table}`.
- **Bounds.** Each of the three buffers holds at most 50,000 rows (for the per-validator tables: all of their pending batches
  together); past it the oldest rows are dropped, counted (`syncer_validations_dropped_total{reason="buffer_full"}`) and logged
  (`validations`: at most once a minute; the per-validator tables: one line per flush that dropped rows, with the table).
- Messages in the replay window of a reconnect are lost; a node of another network is refused. `validations` rows expire after
  90 days (TTL), `validator_validations` rows after 7.
- Shutdown: lookups get 1 s, the final flush (all four tables) at most 3 s in total; nothing starts after that.

## 6. The fee_stats worker

`FeeStatsPoller` asks the node for `fee` every **5 s** and writes one `fee_stats` row (`pct_max_queue_size =
current_queue_size / (expected_ledger_size × 20) × 100`). Ticks never overlap (a slow one is skipped and logged); a failed sample
is logged and counted (`syncer_fee_stats_errors_total`) and the next tick is the retry. Request timeout 4 s; shutdown waits at
most 2 s for the sample in flight.

## 7. The aggregator

Once a minute (`AGGREGATOR_INTERVAL_MS`), within a 30 s tick budget, the aggregator runs nine jobs **in priority order**; a job
gets what the earlier ones left and has a budget of its own so that a long sweep never starves the live work:

| # | Job | Budget | What |
| --- | --- | --- | --- |
| 1 | `volume_live` | 5 s | The seven live volume sets (trade volume for hour, day, 3day, 7day, 30day; payment volume for hour, day), each recomputed whole under one version. **Stalest set first**, and sets that failed on their last attempt go behind the healthy ones (one bad set cannot starve the others). |
| 2 | `volume_daily` | 4 s | The daily volume sets of today and yesterday (UTC), both metrics, stalest first. |
| 3 | `pair_hourly` | 3 s | The candle of every pair in each UTC hour of the last 31 days (`pair_hourly`), the live hours first, then the back-fill. See [7.2](#72-pair_hourly). |
| 4 | `markets_live` | 3 s | The Markets sets (`markets_live`) of the periods `day`, `7day` and `30day`, made of the hours of `pair_hourly`; `day` at every tick, the other two every fifth. See [7.3](#73-markets_live). |
| 5 | `stats_live` | 20 s | Recomputes `stats_hourly` from `ledgers`: a **catch-up** from the newest hour that has ledgers (the watermark) to two hours ago, then the **tail** (the last two hours to the end of the current hour). With no stats at all it starts at the hour of the **first ledger**; a slice with no ledger jumps to the hour of the next one. |
| 6 | `stats_dirty` | 10 s | Drains `agg_dirty`, the hour ranges that ingest rewrote behind the aggregator, oldest first, in slices of at most a day; also recomputes the daily volume sets of the days a slice covers, and runs the hooks of the account and market jobs ([7.6](#76-the-agg_dirty-hooks)). |
| 7 | `rates_daily` | 8 s | The rate of every asset against the native currency for each closed, final UTC day (`native_rates_daily`), newest first. See [7.1](#71-rates_daily). |
| 8 | `account_rollups` | 8 s | The discovery of heavy accounts and their daily rollups: the increment of each new day and the promotion of the days before. Off with `GH_ACCOUNT_ROLLUP_MIN_ROWS=0`. See [7.4](#74-account_rollups). |
| 9 | `volume_backfill` | 10 s | The closed days that have no final daily set for the current `version` of the markets config, **newest first**. |

Properties that matter operationally:

- **Idempotent and resumable.** A stats slice is `recomputeStatsHourly` (deduplicated by `LIMIT 1 BY ledger_index`, written with a
  new version); a volume set is a complete set of rows under one version and readers keep only the highest version of a set. A
  failed slice or set is retried on the next tick; errors are logged and counted (`syncer_aggregator_errors_total{job}`) and never
  stop the loop.
- **A mark is never lost.** An `agg_dirty` range is deleted only after all its slices succeeded, and only if it was not marked
  again meanwhile; an unfinished range is replaced by one that starts where the work stopped.
- **During a long catch-up the tail does not run**, so the current hour's stats are stale until the catch-up is over (a database with years of history,
  or after a long outage). `syncer_aggregator_stats_lag_seconds` says how many seconds of history are still to do; it is 0 when
  the stats are current.
- **A closed day is final only once the ingest has passed it**: back-fill covers days that ended at least an hour before the
  *newest ingested ledger's* close time (the sentinel row of a set records whether the newest ledger had passed the day end
  when the set was written), not by the wall clock. After an ingest lag of more than a day the days are not computed until their
  ledgers are in.
- A set that keeps failing waits 5 minutes, doubling up to an hour, and older days go on; the memory of this is lost on restart.
- **No overlap, graceful stop** (a tick still running is skipped; shutdown aborts the slice in flight and waits at most 2 s).
- Volume jobs need the **markets config** (`config/markets/<network>.json` or `GH_MARKETS_CONFIG`): without markets there is
  nothing to compute. (The shipped Xahau list, version 3, was derived from a small sample, about 3,800 ledgers spread over three days,
  and is short: one trade market (`EVR`/`XAH`) and three payment currencies; `XXX`, a test token whose ISO code means "no
  currency", was left out. Re-derive it from a full-history node with the queries of the
  [verification report](superpowers/plans/2026-10-15-ripple-dropin.verification.md#8-step-6-packagessharedconfigmarketsxahaujson),
  then bump `version`.) A new `version` in the file recomputes the closed days.

### 7.1 `rates_daily`

Writes `native_rates_daily` ([data-model](data-model.md#account-and-market-aggregates-migration-003)): for a closed, **final** UTC day D, the rate against the
native currency of every issued asset that has one above 0, exactly what `RatesService.dailyNativeRates([asset], D, D + 1)` gives (the e2e
suite proves they agree for every asset: `RatesService.dailyNativeRatesOfDay(D)` is the same computation for all assets in two reads of 15 days
of native-pair trades). A day is final when the newest committed ledger closed at least `VOLUME_DAY_SETTLE_MS` (one hour) after its end, so
today is never final and yesterday only once the ingest has passed it; today, and yesterday until it is final, are valued on read by the API.

- **A day is a set**: the assets with a rate and a sentinel (`currency = ''`, `issuer = ''`) with `config_version = RATES_DAILY_CONFIG_VERSION`
  (1) and `stale = 0`, in one insert. A day is **valid** when its newest sentinel is not stale and has the current config version.
- **Per run**, newest first, one day at a time: yesterday once it is final and not valid, then the closed final days that are not valid, down to
  the day of the first trade against the native currency (read once, and again only while there is none). **At least one day per run**,
  whatever is left of the budget (the readers value an uncovered day on read, the slow path); the others only while the tick's deadline
  has not passed.
- **A re-ingest marks days stale** (the hook, [7.6](#76-the-agg_dirty-hooks)); the same list brings them back, newest first.
- Gauge `syncer_rates_daily_missing_days`: the closed final days, from the first native trade, that have no valid set (0 once the back-fill is done).
  Log lines: `Rates back-fill: N day(s) to compute, newest first` once when it starts and `Rates back-fill is done: every closed final day has its set` once when it ends.

### 7.2 `pair_hourly`

Writes the hourly trade statistics of every pair for the last 31 days (`PAIR_HOURLY_DAYS`); the table's TTL drops what is older than 45 days.

- **An hour is a set**: from `exchanges` in the ledger range of the hour, all pairs, each row once, the kept trades only (native legs of 0.0005 or less are
  left out, as in candles and `reduce`), grouped by pair and source, with the candle expressions of the API (open and close by key, high and low by
  rate with the key as tie-break) and the keys of the trades they name. Every row is `book` (the column `source` exists for the AMM work). The sentinel
  (the empty pair) carries `is_final` (a ledger that closed at or after the hour's end was there), `config_version` (`PAIR_HOURLY_CONFIG_VERSION`, 1) and `through_time`.
- **Per run**: the current hour (always) and the previous hour until its set is final, the stalest first; then the **back-fill**, the hours of the
  last 31 days that have no final set of the current config version, newest first. An hour whose set is not final is done again only once a **newer ledger
  closed after its end** (until then a new set would be the same). A run of consecutive hours inside one UTC day is one call, so a day without a set is one
  read of the trades and 24 inserts; **a multi-hour call that fails is retried hour by hour**, so one bad hour does not keep the day. No hour before the hour of
  the first ledger is computed. At first start the 31 days take minutes.
- Gauge `syncer_pair_hourly_missing_hours`: the hours of the last 31 days without a set of the current config version. Log lines `Pair-hourly back-fill: N hour(s) to compute, newest first`
  and `Pair-hourly back-fill is done: every hour of the last 31 days has its set`.

### 7.3 `markets_live`

Writes the Markets sets from `pair_hourly` (`markets_live`; read by `GET /v2/network/markets`, [api-reference](api-reference.md#get-v2networkmarkets)).

- **Window** of a period P (24 h, 7 days or 30 days): the hours from `floorHour(t) - P` to `floorHour(t)`, where t is the `through_time` of the newest set of the
  current hour; `start_time = floorHour(t) - P`, `end_time = t`. The window is at least P and at most P + 59 min 59 s long. A set is written only when every hour of its
  window and of its 7 sparkline days has a set of the current config version (final, except the last two hours); otherwise it is **skipped** (logged once per gap:
  `Markets set of period <p> not written: N hour(s) of pair_hourly have no usable set ...; the previous set stays`) and the previous set stays.
- **Per pair**, over the window's hour rows (sums exact, with the `sumOf` fallback when an hour is unfit or a sum is at or above 1e36): `count`, the volumes, `open` and `last`
  (first and last trade by key), `high` and `low` (by rate, key as tie-break), the two times, the native volume, and the 7 daily `closes`. The **native volume** of a pair is the
  volume of its native side; otherwise the base volume over the base's rate, else the counter volume over the counter's rate (an asset's rate is its volume over the native volume of
  its pair against the native currency in the same window, all trades; the quotient has 17 significant digits); without a rate on either side there is none. The sentinel carries the
  window and the totals (`pairs_traded`, `total_count`, `total_native_volume`). `amm_share`, `amm_pool` and `total_amm_share` are NULL.
- **Cadence**: the `day` set at every run, the `7day` and `30day` sets on the 1st, 6th, 11th ... run (`MARKETS_LONG_EVERY_TICKS` = 5, **counted by the runner itself**). A long set that the budget kept
  from starting is **written on the next run**, after the `day` set.
- Gauge `syncer_markets_live_age_seconds{period}`: now minus the `end_time` of the newest `include` set of the period (set after the sets of each run).

### 7.4 `account_rollups`

Keeps **daily rollups of the heavy accounts** (the accounts with `GH_ACCOUNT_ROLLUP_MIN_ROWS` balance changes or more, default 1,000,000), in `account_lines_daily`,
`account_tx_daily` and `account_trades_daily`, so that a read of years of such an account (`stats/*` with `interval`, `reports`, `analytics/*`) reads thousands of day groups instead
of tens of millions of rows. A rollup stores amounts, never values, so it does not depend on `native_rates_daily`. **The API's answer is the same with or without it**: it uses a rollup only
for the days its state row says it covers and reads the raw rows for every other day. The job is off with `GH_ACCOUNT_ROLLUP_MIN_ROWS=0` (the run reads and writes nothing; existing coverage is still used by the API
and still corrected by the hook). A value below 10,000 (`ACCOUNT_PARTITION_ROWS_FLOOR`) behaves like 10,000: the discovery only keeps accounts with that many rows in a partition. Per run, in order, each set only while
the tick's deadline has not passed, the shutdown has not begun and fewer than 3 sets have failed:

1. **Discovery.** The partitions of `balance_changes` (P7: `intDiv(ledger_index, 10000000)`) that are due are recounted (`account_partition_rows`), newest first: one without a set, the newest partition when its set is older than 24 hours,
   any other when it is older than 7 days, and one that a slice of `agg_dirty` touched. A recount is `SELECT account, count()` over the partition's ledger range in 58 slices by the second character of the address, keeping the accounts with
   at least 10,000 rows. An account is **heavy** when its rows over the newest set of every partition reach the minimum. A new heavy account gets a state row with its `first_day` (the day of its first balance change) and no coverage; an account
   that is no longer heavy (the setting was raised) loses its coverage (its rollup rows stay, unused); a state of another `ACCOUNT_ROLLUP_CONFIG_VERSION` is an account without coverage, promoted again.
2. **The daily increment.** For each final day d after an account's `rolled_through`, oldest first, the accounts whose `rolled_through` is d - 1 are rolled together: three reads (`balance_changes`, the transactions the account sent, `account_exchanges`)
   with `account IN (...)` and the ledger range of d, each row once, grouped by account and the table's group columns; the rows are inserted under one version, then a sentinel per (account, day), then the state rows with `rolled_through = d`.
   **At most 500 accounts per call** (`ACCOUNT_ROLLUPS_BATCH_ACCOUNTS`: they travel in a URL parameter and the URI limit is 1 MiB); an account that failed inside a call of several is rolled alone until it works.
3. **The promotion**, in rounds: every account whose coverage does not reach back to its first day gets a slice, the accounts without coverage first, then the newest `rolled_from` first, so that a year is covered before all of it. An account
   without coverage starts at the newest final day. A slice is as many whole days as hold about 2,000,000 rows (`ACCOUNT_ROLLUP_SLICE_ROWS`) at the account's rows per day in the partition of the slice's end, at least one day, and it **never crosses the
   start of that partition** (its count says nothing of older ones). An account whose slice ends in a partition with no `account_partition_rows` set yet **is deferred** to the next run (no error), and under the 10,000-row floor the slice is the rest of the partition.
   The rollup is written first and the state only when it worked, so a state never claims days that are not there.
4. The gauges `syncer_account_rollups_heavy_accounts` and `syncer_account_rollups_pending_accounts` (heavy accounts whose coverage does not reach from `first_day` to the newest final day), and the log lines of the back-fill, like the other two jobs: `Account-rollups back-fill: N heavy account(s) to cover, newest days first` once when a run finds heavy accounts whose coverage has to grow back (the promotion is under way), and `Account-rollups back-fill is done: every heavy account is covered from its first day to the newest final day` once when no heavy account is pending any more; again if accounts become pending again. A new day that only rolls the accounts on (the daily increment) says nothing.

The writer's version is the largest over all four rollup tables, so a retry never reuses the version of a failed attempt. The rollup rows of a set stay beside those of a newer set (`version` is in the key); superseded versions are never pruned
([data-model](data-model.md#account-and-market-aggregates-migration-003)).

### 7.5 Runners, registration and failures

Each job is a **runner** in a file of its own in `apps/syncer/src/aggregator/` (`rates-daily`, `pair-hourly`, `markets-live` and `account-rollups` `.job-runner.ts`). A runner keeps its own state (cursors, waits, announcements,
the run counter of `markets_live`) and gets what it needs of the service through one small interface of its own, **`AggregateJobDeps`** (`aggregate-job-deps.ts`): the `ClickHouseService`, the logger, the metrics, the clock, `closing()`,
`failed(job, err, where?)` and the job's budget. A runner imports only the shared package, that file and the types of `aggregator.service.ts` (`AggregatorTick`, `AggregatorJob`); its constructor takes the deps, the shared options
(`AggregatorAggregates`: the `RatesService` and the minimum of rows) and, for tests, the functions of the shared package to replace. A runner's `job()` is its entry in the jobs list, and three of them have an `ofSlice(start, end, tick)` hook.

The **registration** is all that changes in the service: the four names in `AggregatorJobName`, four budget constants (`AGGREGATOR_PAIR_HOURLY_BUDGET_MS`, `AGGREGATOR_MARKETS_LIVE_BUDGET_MS`, `AGGREGATOR_RATES_DAILY_BUDGET_MS`,
`AGGREGATOR_ACCOUNT_ROLLUPS_BUDGET_MS`), the option `aggregates` (without it the four jobs and their hooks do not exist, as in the unit tests of the volume jobs), the four entries of the jobs list at the places of the table above, and one
private method, `hooksOfSlice`, called once after a slice's volume sets. `aggregator.module.ts` builds `aggregates` from the one `RatesService` that the volume jobs share and `GH_ACCOUNT_ROLLUP_MIN_ROWS`. Budgets and cadences are constants, not
settings. The scheduling test (`aggregator.schedule.spec.ts`) pins the order and shows that the live volume jobs are not starved with every job registered.

**Failures follow the rules of the other jobs.** Only committed ledgers count (a window becomes a range of `ledgers` first). A set is idempotent and retried at the next tick; a failure is logged and counted
(`syncer_aggregator_errors_total{job}`) and never stops the loop; a set that keeps failing waits 5 minutes, doubling up to an hour, while the others go on (the waits are in memory: a restart tries them all again); a runner gives up after 3 failed sets
in a tick; a shutdown aborts the set in flight before it writes (`AggregateSetAborted`), which is neither logged as an error nor counted. A job that reaches its budget says so once (a warning) until a run finishes in time.

### 7.6 The `agg_dirty` hooks

A range that `range-ingest` rewrote is queued in `agg_dirty` and drained by `stats_dirty` in slices of at most a day. After a slice's `stats_hourly` and volume sets, `hooksOfSlice` runs three hooks **in this order**:

1. `rates_daily`: a slice that touches the days X..Y marks the days X..Y+14 **stale** (the rate of a day reads the trades of the 14 days before it): for each of them that has a valid set, a new sentinel with `stale = 1` and no rows. The back-fill then computes them again, newest first; until it has, the readers value those days on read.
2. `pair_hourly`: the hours of the slice that lie in the last 31 days are recomputed, a call for each UTC day.
3. `account_rollups`: for every account whose rollups cover a day of the slice (its newest state row is of the current config version and its coverage holds the day: the state rows say so, not the heavy accounts), that (account, day) is recomputed, a call for each day of 500 accounts at most, and the partitions of the slice's ledgers are
   marked for the next discovery to recount. With `GH_ACCOUNT_ROLLUP_MIN_ROWS=0` the job is off but the slice **still recomputes the covered days** (the API still uses that coverage, so a re-ingest must not leave it stale) and marks no partition.
   A re-ingested day comes as many ranges (one per chunk of ledgers, about an hour), so the hook is given the mark of the range (`agg_dirty.created_at`) and remembers in memory, across ticks, which days it rolled and when each roll began (at most 1000 days). A day that was rolled by a roll that began at or after the mark is not rolled again, as the daily volume sets are not; a range marked after the roll began rolls the day again, and a roll that failed is not remembered.

A hook that fails is logged and counted as `<job>_dirty` (`rates_daily_dirty`, `pair_hourly_dirty`, `account_rollups_dirty`) and **fails the slice**, which keeps its range in `agg_dirty` for the next tick (a mark is never lost), as the failure of a volume set does. A hook does nothing once the shutdown has begun, which is safe
because the range is not changed after it. Between the rewrite and the hook the aggregates show the old data (eventual, like `stats_hourly`).

### 7.7 The back-fills

A fresh deployment (or a database recreated for a new baseline) fills the new tables by itself, each back-fill under the budget of its job and newest first: `pair_hourly` its 31 days in minutes (the Markets sets appear at once); `rates_daily` the closed days back to the first native trade, which for
about 5,000 XRPL days takes some hours of query time, so about a day within its budget; `account_rollups` the heavy accounts (a third to half of all balance changes), one to two days. Each says once in the log that it is under way and once that it is done, and each has a gauge that reaches 0 (`syncer_pair_hourly_missing_hours`, `syncer_rates_daily_missing_days`,
`syncer_account_rollups_pending_accounts`). Until then the API is right and slower ([operations](operations.md#account-and-market-aggregates)).

## 8. The validators worker

The `validators` worker (`apps/syncer/src/validators/`) keeps the data behind the validators and amendments endpoints current:
which validators the UNL publishers name, their domains, the state of the ledger, and the votes and the agreement derived from it. Its
design is in the [validators and amendments design](superpowers/specs/2026-10-19-validators-amendments-design.md), section 2, and the
decision in [ADR-0012](adr/0012-validators-and-amendments-data.md). Like every worker it is switched on and off with `GH_WORKERS`.

**Why a worker, and not steps of the aggregator.**

1. It needs the node and outbound HTTPS to third-party sites. The aggregator needs neither and boots while every node is down.
2. Its cadences (flag rounds, hours, re-check intervals) and failure modes (a publisher or a domain is down) are its own.
3. The aggregator's 30 s tick is shared by the volume and stats jobs: the new jobs must neither compete for that budget nor change
   its job order, and keeping out of the aggregator's code keeps the two branches apart.
4. An operator can switch the whole feature on or off with `GH_WORKERS`.

**Two loops.** An **I/O loop** that fetches the UNL lists (below), checks validator domains and polls the node, each on its own
timer; and a **compute loop**, once a minute, that runs two ClickHouse jobs in the aggregator's job model (a budget per job, a job
that fails is logged and counted and retried at the next tick, no overlap, shutdown waits at most 2 s). The UNL fetcher, the
domain checker and the network state poller are the I/O loop, and the compute loop runs the `rounds` job
([voting rounds](#voting-rounds-and-tallies)) and the `agreement` job ([hourly agreement](#hourly-agreement)); both loops start from the
same bootstrap. A stop ends every loop and waits for them for at most 2 s. Everything that goes out to the internet goes through the safe
fetcher (HTTPS only, no private, loopback or reserved address, no redirect to one, 20 s, 1 MiB, 3 redirects), which also sends the
`User-Agent` `gatehub-data-api/<version> (validators)`.

### The UNL lists

`UnlFetcher` fetches the validator list of every publisher of `GH_UNL_PUBLISHERS` (`url=publicKeyHex` pairs; a publisher's id is its
URL without the scheme and the trailing slash, `vl.ripple.com`) and stores the ones that verify. `GH_UNL_THRESHOLD` (0 = rippled's
rule: 1 below three publishers, else ⌊n / 2⌋ + 1) is how many current lists must name a validator for it to be trusted.

- **Schedule.** One timer per publisher, never two fetches of one publisher at a time. A fetch at start, then one after
  `GH_UNL_REFRESH_MS` (5 min), or after the `refresh_interval` of the last list (minutes) when the list gives one; either wait is
  kept between 1 min and 24 h (rippled does so for the interval of a list), so that `GH_UNL_REFRESH_MS=1` cannot make a loop
  and a huge value cannot overflow a timer. After a failure the wait is 30 s and doubles with each failure in a row to 10 min; any outcome other
  than `ok` and `unchanged` counts as a failure, a list that is `stale` or `expired` included.
- **Verification**, in the order rippled's `ValidatorList::verify` uses. A response that fails any of steps 1–5 is rejected whole,
  and each failure has a reason code:
  1. The body is JSON with `public_key`, `manifest` and `version` 1 (`blob`, `signature`) or 2 (`blobs_v2`, 1 to 5 entries); any
     other version is read as 2. Else `invalid_format`.
  2. `public_key` is the configured key (case does not matter). Else `untrusted_key`.
  3. The publisher manifest decodes, is the configured key's own and both its signatures verify; a manifest with the sequence
     `0xFFFFFFFF` revokes the key. Else `manifest_invalid`, or `revoked`. A version 2 entry's own manifest counts when its sequence is
     higher, and the highest manifest signs every blob of the response.
  4. Each blob's signature verifies over the decoded blob with that manifest's signing key. Else `signature_invalid`.
  5. The blob is JSON with an integer `sequence` and `expiration`, an optional `effective` before the expiration, and validators
     with 33-byte keys. Else `blob_invalid`.
  6. Each blob is then compared with the newest sequence stored for the publisher **under its configured key** (see below): a lower one is `stale`, the same one
     `unchanged` (nothing is written), a newer one that has expired `expired`, else it is new. The outcome of the attempt is `ok`
     if any blob was new, else `unchanged` if any was unchanged, else the outcome of the first blob.
- **A publisher cannot take a key back.** When a publisher rotates its signing key it serves a manifest of a higher sequence. A
  body that replays an older manifest, with a list signed by the superseded key, is refused (`signature_invalid`): the highest
  publisher manifest seen is kept in memory (a response that revokes the key leaves the revoking manifest behind, so an older
  body that follows is `revoked` too) and, after a restart, rebuilt from the newest stored response under the configured key. What
  only a response that stored nothing showed, a revocation or a rotation, is then forgotten: the next response has to show it again.
- **Lists are told apart by key.** The id of a publisher is its URL, but sequences are numbered by its key and a manifest belongs to
  it. The newest stored sequence a blob is compared with, the manifest above, and the gauges come from the rows stored under the
  **configured** key (`unl_lists.publisher_key`); the lists of an earlier key stay in the table and count for nothing. A publisher
  that changes its master key and starts numbering anew is therefore not `stale`. `readStoredLists` gives each list its
  `publisherKey` for the readers that need the same.
- **Writes.** Each new blob is one `unl_lists` row: the publisher, its key, `sequence`, `version`, `effective`, `expiration`, the
  validators' master keys (base58, sorted), the SHA-256 of the blob, the time of the fetch, and the JSON as served. The manifest
  of every validator in a new list is decoded, checked to be that validator's own, verified, and written to `validator_manifests`
  with `source = 'unl'` (before the list, so that a list is never visible without its manifests; a revoked manifest has no signing
  key and is skipped; one that fails is skipped, logged, and counted as `validator_manifest_invalid`). Every attempt, whatever its
  outcome, writes the `unl_publishers` row of the publisher: `status` `ok` (outcomes `ok` and `unchanged`) or `error` with the
  outcome as `error`, `checked_at`, the `threshold` in force, and `last_ok_at` (the time of the last ok attempt, kept through
  failures). At start the worker writes a row for every configured publisher (a new one is `ok` with no `last_ok_at`, a known one
  keeps its status) and sets `configured = 0` on stored publishers that are no longer configured. A ClickHouse failure ends the
  attempt with no outcome: a warning and the same backoff, and no metric. Rows inserted earlier in the same attempt can remain: the
  manifests go in first, then the lists, then the publisher row. The retry reports `unchanged` only when the list insert had landed
  (the list is then stored, and its sequence is the newest); when it had not (the manifests only, or nothing), the list is still new
  and the retry reports `ok`.
- **The list in use, and the trusted UNL.** The current list of a publisher at time *t* is the stored one with the highest
  `sequence` whose `effective` (none = always) is at or before *t* and whose `expiration` is after it. When none is current, the
  newest is used and reported as expired: a flagged old UNL is better than none. The trusted UNL at *t* is the validators on at
  least `threshold` of the current lists (for a time before the first fetch, the oldest stored list stands in). Both are in
  `packages/shared` (`listInUse`, `trustedUnl`); `readStoredLists` reads the stored lists, one per publisher and sequence.
- **Observability.** `syncer_validators_unl_fetches_total{publisher, outcome}` counts every attempt (`ok`, `unchanged`, or the
  reason), `syncer_validators_unl_expiry_seconds{publisher}` is the expiration of the list in use minus now (negative when it
  expired) and `syncer_validators_unl_size{publisher}` its validators. The status of a publisher is logged when it changes, not on
  every retry, and a stored list is logged once. A log line names the publisher, the reason and the message of the failure, never
  the body of a response.

### Domain verification

`DomainChecker` (`domain-checker.ts`, with the pure `matchToml` of `toml-match.ts`) verifies the domain each validator names in its
manifest, as `validator_domains` rows. The worker makes a **pass every 60 s** (the first at start, the next 60 s after the previous
one ended, never two at a time) while `GH_DOMAIN_VERIFICATION` is `true`; a pass that fails (ClickHouse) is logged with its message
and the next one is made on time.

- **Which validators.** The masters on the list in use of each configured publisher (only the lists stored under the key configured
  for it: a list of an earlier key of the same URL counts for nothing), and those in `validator_seen` with `last_seen` in the last 30
  days. A key seen under a signing key is mapped to its master through the manifest map first (per `ephemeral_key`, the
  `master_key` of the highest `seq`), as every read that aggregates by validator does: the map is computed inside the statement
  (`KEY_MAP_WITH` and `mappedKey` of `packages/shared`), never sent with it as parameters, which the client would put in the URL
  (a map of every manifest stored outgrows the 1 MiB of a URL ClickHouse takes). Of each, the newest manifest (the highest `seq`
  per master key; of one `seq`, the row with the raw manifest: `NEWEST_MANIFEST_ORDER`).
- **The manifest is verified here.** A manifest with raw bytes is decoded and its signatures verified, and it must be the key's own;
  the domain is that of the verified manifest, so the stream's word is not enough, and a manifest that does not verify gives
  `manifest_unverified` with no fetch. A validator whose newest manifest has no raw bytes (rows from before migration 002) is asked of
  the node (`manifest` with the master key; 5 s, no retry) at most once in 10 minutes per key, at most 100 keys and 4 requests at a
  time in a pass, and the answer is stored with `source = 'rpc'` and checked in a later pass like any manifest. No domain: no check
  and no row.
- **Which pairs are due.** A (validator, domain) pair with no stored row, or with `next_check_at` passed; a changed domain is a new
  pair, checked in the next pass. Never-checked pairs first, then the oldest `next_check_at`, at most 100 a pass.
- **The checks.** A domain that is not properly formed (rippled's `isProperlyFormedTomlDomain`: no IP literal, port, path or single
  label) is `domain_invalid` before any DNS query. Otherwise the file `https://{domain}/.well-known/xrp-ledger.toml` (Xahau:
  `/.well-known/xahau.toml`; no fall-back to the other name) is fetched through the safe fetcher (`GH_DOMAIN_FETCH_TIMEOUT_MS`, 256
  KiB, 3 redirects, each checked like the first URL): **one fetch per domain per pass**, shared by the validators that name it, at
  most **4 in flight**. The rows of a domain are written as soon as it is done.
- **What is read of the file.** It is parsed (`smol-toml`), never evaluated. The key is listed when a `[[VALIDATORS]]` entry has it as
  `public_key` (trimmed). Only then are the `[[ACCOUNTS]]` read: the `address` of each entry (trimmed), kept when it is a classic
  address with a valid checksum (an X-address, a bad checksum, a missing or non-text address is skipped), once each, sorted, the first
  10. Every other field is ignored, and nothing in the file is fetched or followed. A byte order mark at the start of the file is ignored. A file that
  is not TOML is `toml_invalid`, and its error says nothing of its content.
- **The result of a pair.**

  | Result | Reason | Next check |
  | --- | --- | --- |
  | `verified` | `''` (with the `accounts`) | `GH_DOMAIN_RECHECK_MS` (6 h) |
  | `unverified` | `not_listed`, `toml_invalid`, `too_large`, `redirect_rejected`, `blocked_address`, `domain_invalid`, `manifest_unverified`, `http_status` with a 4xx other than 429 (`status_code` is the status) | 6 h |
  | `unverified` | transient: `dns_error`, `connect_error`, `tls_error`, `timeout`, `http_status` 5xx or 429 | 1 h |

  A transient failure within 24 h of the last success keeps `verified` (with `verified_at` and `accounts` unchanged), so that a website
  that blips does not flap the badge; after 24 h of failures it is `unverified` with the transient reason and no accounts. A definite
  failure takes the badge at once and keeps `verified_at`, the time of the last success.
- **Observability.** `syncer_validators_domain_checks_total{outcome}` counts every check as `verified` or the reason (also a
  transient failure that left the domain `verified`). The result of a pair is logged when it changes (the validator, the domain
  quoted, the status, the reason and the status code); a fetch refused by the address policy is logged at `warn` every time, with the
  domain and the blocked range (`addressClass`). Once a pass, one `warn` says how many manifest lookups the node
  could not answer (and the first message) and how many it answered with an error (their codes, only the codes), and one how many
  fetches failed with an error that is not the safe fetcher's own (the names of the errors, recorded as `connect_error`). A log line
  never holds the body of a response, an error object or the message of a fetch failure, and a domain is quoted because it comes
  from a manifest.

### Network state and amendment names

`NetworkStatePoller` (`network-state-poller.ts`) reads the ledger state and the names of the amendments from the node, on two timers of
the worker (each a pass at start and then one after the previous one ended, never two of a kind at a time; `start.state` switches both
off in a test).

- **Every 60 s, the state.** `ledger_entry` of the Amendments object (index `7DB0788C…`) at the `validated` ledger; its `ledger_index`
  *L* is the ledger the other two objects are read at, `ledger_entry` of NegativeUNL (`2E8A59AA…`) and FeeSettings (`4BC50C9B…`), together
  with `server_info` for `validation_quorum` (0 when the node reports none, an error when it reports something that is not a count;
  `server_info` takes no ledger, so it is the node's current answer, read together with the state at *L*). An answer for either object
  that is not of *L* fails the poll. **One `network_state` row**: the enabled amendment IDs; the
  majorities (`Majorities[].Majority.{Amendment, CloseTime}`, a CloseTime in Ripple time, stored as unix time); the negative UNL
  (`DisabledValidators[].DisabledValidator.{PublicKey, FirstLedgerSequence}`, the hex key stored as a base58 node public key) and
  `ValidatorToDisable` / `ValidatorToReEnable` (base58, `''` when none); and the fees in drops, from `BaseFeeDrops`,
  `ReserveBaseDrops` and `ReserveIncrementDrops`, or from the legacy `BaseFee` (hex), `ReserveBase` and `ReserveIncrement` of a ledger
  before the XRPFees amendment (a field with both forms is read from the drops one). NegativeUNL does not exist while no validator is
  disabled: the node answers `entryNotFound`, which is an answer (empty arrays), whereas FeeSettings that is not found is an error.
- **At start and every 10 min, the features.** `feature`: one `amendment_features` row per amendment ID (`name` is `''` when the node has
  none, `supported` 1 or 0).
- **No retry, no partial write.** Every request has a timeout of 5 s and is not retried; a poll in which a request fails, or an answer
  cannot be stored, writes nothing, and the next poll is the retry. A ClickHouse that fails makes the pass fail (logged, retried on
  time).
- **The gauge** `syncer_amendments_without_metadata`, set after each feature poll that resolved, also one that wrote nothing (it reads what is stored); a poll that rejects (a ClickHouse failure) skips it: the
  number of amendment IDs in the newest `amendment_features` rows, in the newest `network_state` row (enabled, or in `Majorities`) and in
  the newest round of `amendment_tallies` that the amendment metadata (`GH_AMENDMENTS_CONFIG`, else the file shipped with the shared
  package) does not list. Each ID is warned about once, `amendment <ID> has no metadata entry`, and remembered until the syncer restarts.
  An invalid metadata file does not load and so fails the boot.
- **Observability.** `syncer_validators_node_polls_total{request, outcome}` counts every request (`amendments`, `negative_unl`,
  `fee_settings`, `server_info`, `feature`; `ok` or `error`: an `entryNotFound` for the NegativeUNL is `ok`, an answer that is not what was
  asked for is `error`). A failure is logged at `warn` when it starts or changes, naming the request and the error code of the node
  (`the node answered slowDown`) or the message of the error, and its end once at `log`; an answer whose fields cannot be stored is
  logged with the field at fault. A log line never holds an error object.

### Voting rounds and tallies

The compute loop (`ComputeLoop`, `compute-loop.ts`) is the aggregator's job model without its file: once a minute it runs its jobs in
order inside a tick of 20 s, each with a deadline of its own (`rounds` 5 s, `agreement` 10 s), so what has to run at
every tick goes first and none takes the tick from the ones after it. A job that throws is logged (its message) and counted
(`syncer_validators_jobs_total{job, outcome="error"}`, `ok` otherwise) and the next job still runs; a tick called while one runs is
skipped with a warning; a stop aborts the signal of the tick, so that nothing more is written or started, and waits for it at most 2 s.
`start.compute` switches the loop (and the seeding below) off in a test.

Alongside the compute loop, in the background, the worker fills `validator_seen` from `validations` when that was not done
(`seedValidatorSeen`, `seen-seed.ts`): one row per validator key with its first and last time of receipt and its newest ledger. It is
needed when the table has no row, or when its oldest `first_seen` is more than an hour newer than the oldest validation of the oldest
partition of `validations` (the collector wrote its first rows before the seeding did). It does one `INSERT ... SELECT` per partition
of `validations`, **newest first**, so that each statement fits the request timeout of ClickHouse and an interrupted seeding (a failure,
a shutdown between two partitions) shows at the next start: the oldest partition is the last one done, until then the oldest
`first_seen` is still newer than the oldest validation and the seeding is made again (`min` and `max` are idempotent). It neither
delays nor fails the boot: a failure is logged (`Seeding validator_seen failed: <message>; it is tried again at the next start`)
and left for the next start.

`RoundsJob` (`rounds.job.ts`) writes, for each voting ledger V (index % 256 = 255), `validator_votes` (each validator's vote) and
`amendment_tallies` (the tally of each amendment):

- **Which rounds.** A round is ready when `ledgers` holds a committed ledger at or above V and it is 120 s past the close of V (of
  the first committed ledger above V when V is missing). Rounds are done oldest first until the deadline. The first round is the first
  voting ledger at or after the higher of the lowest ledger (above 0) that the oldest active partition of `validations` (`system.parts`)
  holds a validation of, and the lowest ledger of `ledgers`; then always the newest stored round (its newest sentinel) + 256, so a
  restart goes on where the last run ended. A voting ledger `ledgers` lacks gets only a sentinel: `observed 0`, `trusted 0`,
  `threshold 1`, the size of the UNL, the close time of the first committed ledger above it, and no vote. The first round is looked
  for with the ingest first: without a ledger the partitions of `validations` are not read.
- **A voting ledger that arrives late.** A range ingest can fill `ledgers` below the checkpoint of the live ingest, after the rounds
  of the gap were sealed as missing. After the forward rounds of a run, inside its deadline, the job redoes such a round, oldest first,
  as a new version with its hash and its votes. A candidate is a round whose newest sentinel has `observed 0` and `trusted 0` and a close
  time that is not the one of its own ledger now in `ledgers` (a round that was real with nobody observed has the close time of its
  ledger and is never redone), past the 120 s delay, while that ledger is inside the 90 days `validations` keeps. Every stored round
  whose close time is within 24 h after the late one is redone too, because its records may be carried from it: those first, oldest
  first, each with the late round in its history, then the late round last, so that a run that is cut short leaves the late round a
  candidate and the whole is done again. A follower whose own ledger is still missing is left as it is, and so is a follower that is a
  candidate itself (a gap of several voting ledgers): its own unit comes next and redoes the rounds up to 24 h after it, which the
  unit before it would leave out. A follower is rewritten with both its inserts once its votes are in (a merge of `validator_votes`
  could otherwise leave the set of the old sentinel without votes); a shutdown stops the job between rounds.
- **Votes.** The hash H of V from `ledgers`; the validations of H, one row per validator, keys mapped to master keys through the
  manifest map (a validation recorded under a signing key counts for its master), with the values of the earliest sighting
  (`argMin(…, first_datetime)`: `full`, the amendments, the fee votes, the server version). A validation of another hash at V is
  ignored, as rippled ignores it. The `amendments` text is read as a list of IDs (upper case; an entry that is not an ID is dropped).
- **UNL and negative UNL.** UNL(V) is the trusted UNL at the close of V from every stored list of the configured publishers (each
  key a publisher served under was trusted in its time; the filter by the configured key is for "in use now" only), with
  `GH_UNL_THRESHOLD`; nUNL(V) is the negative UNL of the newest `network_state` row at or before V (none: empty).
- **Records and tallies** (`tallyRound`, `tally.ts`, F7). The vote record of a UNL member is its newest full validation from a round
  it was on the UNL of and off the negative UNL of, no more than 24 h before V. The history is the votes and sentinels of the stored
  rounds of the last 24 h (the rows of the newest sentinel's version of each, their keys mapped through the manifest map like those
  of the votes), plus V. `trusted` is the members with a record,
  `yes` of an amendment the records that name it, `threshold` is max(1, ⌊trusted × 80 / 100⌋), `observed` the members with a full
  validation of H, `unl_size` the size of UNL(V). One row per amendment with a yes or in the `Majorities` of the newest
  `network_state` row, in the order of the IDs, and then the sentinel (`amendment_id ''`) with the UNL, the negative UNL and the fees.
- **Fees.** The fees in force at V: the newest `SetFee` with `ledger_index <= V` (found through `tx_by_type`; `BaseFeeDrops`,
  `ReserveBaseDrops`, `ReserveIncrementDrops`, or the legacy `BaseFee` in hex, `ReserveBase`, `ReserveIncrement`), else the newest
  `network_state` row, else zeros.
- **Version sets.** The votes are inserted first, then the tallies with the sentinel last, all under one `version` (wall-clock
  milliseconds, above any version the round has stored). A reader keeps the rows of the newest sentinel's version of a round, so a round
  that crashed half way is invisible until its sentinel is in, and is redone as a newer set; the job itself reads the history that way.
- **Observability.** `syncer_validators_rounds_lag_ledgers` is the newest committed voting ledger minus the newest stored round, set
  at the end of every run (also one that failed or ran out of time). A round recorded with fewer validations than the quorum of its UNL
  and negative UNL is warned about: `round <V>: recorded <n> of <unl size> UNL validations, below quorum <quorum>`. The warning
  excludes the members of the negative UNL, whose validations rippled discounts, from `n`, so `n` can be below the stored `observed`,
  which counts them.

### Hourly agreement

`AgreementJob` (`agreement.job.ts`, with the counting itself in the pure `agreement.ts`) writes `validator_agreement_hourly` (spec 2.5): per
UTC hour, how many of the ledgers of the indexed validated chain each tracked validator agreed with, missed, or only partially validated.

- **What counts.** The reference is `ledgers`, the chain the ingest committed. Only **full** validations agree. A ledger is **observed**
  when full validations of its hash are recorded from at least quorum(h) members of UNL(h) (keys mapped to master keys through the manifest
  map); a ledger with fewer recorded is **unobserved**: it is left out for everybody and counted in the hour's `unobserved`, so a collector
  outage never shows as validators missing ledgers. UNL(h) is the trusted UNL at the end of the hour from every stored list of the
  configured publishers (as in a voting round, each key a publisher served under was trusted in its time); nUNL(h) is the negative UNL of
  the newest `network_state` row polled at or before that time (none: empty); quorum(h) = `quorumOf(|UNL|, |nUNL ∩ UNL|)`.
- **Hours.** An hour is ready when it ended at least 10 minutes ago and the newest committed ledger closed at or after its end (the ingest
  has passed it). Hours are computed oldest first, until the deadline of the job (10 s), because the tracked set carries from the hour
  before. The first hour is the first whole hour at or after both the first ledger of `ledgers` and the oldest validation of the oldest
  active partition of `validations` (`system.parts`); then always the hour after the newest stored one (its newest sentinel), so a
  restart goes on where the last run ended. Neither starts before the first hour whose validations `validations` still holds whole
  (90 days back, less the 10 minutes read before the hour), so an hour whose validations are past their TTL is never sealed. While no UNL is known (no list stored, or the threshold not met) nothing is computed, and
  `Agreement: no UNL is known at the end of <hour>, the hour waits for a validator list` is logged once: an hour with an empty UNL would be
  written final with nothing observed.
- **A read.** One hour, or, from midnight UTC, a whole day when it ended more than 24 hours ago, is ready, and every hour of it has the
  same UNL and quorum (a day that does not goes hour by hour; so do the hours before the first midnight). The hashes of the window come from a subquery on `ledgers` (the ledger-index
  range of the window and its close times, one hash per hash, each with its hour: a day's 21,600 hashes would not fit the query string),
  the validations from the rows received between 10 minutes before the window and 2 hours after it (a ledger that closes just before the end
  of an hour has validations received just after it: they count for the hour of the ledger). The per-validator counts and the observed
  ledgers of each hour come from one query (`GROUP BY hour, key WITH ROLLUP`), so one snapshot of `validations` decides both. The day's rows
  are the same as the hours' one by one. "Heard in the hour" is the newest receipt of every validator among the validations received in
  the hour, of any ledger. Rows with an empty key are left out of every read of `validations`: that key is the sentinel's.
- **An hour's rows** (`agreementRows`). Tracked validators, exactly: the UNL, those heard in the hour, and those of the hour before (the
  rows of its newest sentinel's version, keys mapped through the manifest map) whose `last_seen` is no more than 24 hours before the end of
  the hour, so a validator that goes quiet keeps missing ledgers for a day. A validator whose only validations of the hour's ledgers were
  received after the hour ended is not tracked for it (it is for the hour they were received in). Per tracked validator: `agreed` = observed ledgers with a full
  validation of the hash by it, `partial` = observed ledgers with only a partial one, `missed` = observed - `agreed` (the partial ones
  included), `last_seen` = the newest receipt known (the hour's; else the newer of a receipt of the hour's ledgers that came after the hour
  and the row before's; 0 for a UNL member never heard). The sentinel
  (`validation_public_key ''`) holds `ledgers` (the observed ones), `unobserved`, `gaps`, `unl_size`, `quorum` and `final`.
- **Gaps and `final`.** `gaps` counts the ledger indices missing in the hour, as spec 2.5 has it, and also those missing between the hour
  and the nearest committed ledger before it and after it (an hour with no ledger counts the indices between its neighbours): a ledger
  missing at the border of two hours keeps both of them from being final. This deliberately goes beyond the spec's formula (ADR-0012). An
  hour with `gaps = 0` is written once, with `final = 1`, and never again. An hour with gaps is written with `final = 0` and recomputed,
  as a new version, at most once an hour (by the age of its version) while `validations` still holds its validations (90 days), oldest
  first and after the new hours of a run; filling the ledgers (a range ingest) is what makes it final. A recomputed hour does not change
  the hours after it: what carries over is who was tracked, not what was counted.
- **Version sets.** An hour is one `INSERT` under one `version` (wall-clock milliseconds, above any version stored for the hour), the
  sentinel its last row. One insert is one part, so a reader never sees half an hour even when a recompute replaces rows of the old
  version, and a reader keeps the rows of the newest sentinel's version of each hour. A shutdown stops the job between hours and before an
  insert.
- **Observability.** `syncer_validators_agreement_lag_seconds` is now minus the end of the newest final hour, set at the end of every run
  (also one that failed or ran out of time), and not set while no hour is final. The newest final hour is searched for from the newest
  hour stored back, 720 hours (a range of the key) at a time, the next range only when one has none, and no further than the 400 days
  the table keeps: a run reads the sentinels of one range, not of the table.

## 9. What the syncer does not do

- It does not fill history before `GH_SYNC_START_LEDGER`: use [range ingest](#4-range-ingest-cli).
- It does not write `agg_dirty` for live ingest (the aggregator's catch-up watermark covers that); only range ingest does.
- It never deletes a committed ledger except through `--reprocess` or its own recovery of an uncommitted tail.
- It has no SQLite history importer (the `LedgerSource` interface is there for one; `genesis_*` of `accounts_created` stays empty
  until such an import loads ledger 32570).

## 10. Failure modes

| Symptom | Cause | What happens |
| --- | --- | --- |
| Probe 503, `state=halted`, `error: ...parent_hash...` | Chain break: the node's history differs from what is stored | The verified prefix is committed, then nothing. Operator decision: see [operations](operations.md#syncer-halted). |
| Probe 503, `state=halted`, `error: Cannot parse ledger <index>: ...` | The parser rejects a ledger (a transaction shape it does not know) | The ledgers before it are committed, then nothing; not retried. Needs a parser fix and a restart, see [operations](operations.md#syncer-halted). |
| Probe 503, `lease lost to ...` | Another syncer took the lease | This one stopped writing. Find and stop the other one. |
| Boot refuses: lease held | A previous syncer (or an old-stack container) is still running or died less than 30 s ago | Stop it; wait 30 s. |
| Lag grows, `last_commit_age` grows | Node unreachable or slow; ClickHouse refusing writes; recovery stuck (`recovering`) | Retries forever; see [operations](operations.md#syncer-falling-behind). |
| `Node network_id ... does not match GH_NETWORK` | Wrong node for the network | Boot refused. |
| `... It rate limits this client: nothing is sent to it for N s` | A public node throttles the process | That endpoint is left alone for N s, the next one is used; with none left the syncer waits. See [Rate limits](#rate-limits). |
| `The boot network check (server_info) failed: ...; retry in N s` | The node is unreachable, busy or rate limiting at boot | Retried until it answers; only a node of another network ends the boot. |
| `UNL publisher <id>: error (<reason>): ...` | A publisher cannot be fetched, serves a list that fails verification, or serves one that is stale or expired | The list is not stored and the last stored one stays in use (reported as expired once it expires). Retried after 30 s, doubling to 10 min; the line is logged once, when the status changes. The reason is in `unl_publishers.error` and `syncer_validators_unl_fetches_total`. |
| `Validator <key>: domain "<domain>" is unverified (<reason>)` | A validator's domain does not serve a TOML file that lists it, or cannot be reached | The domain shows `unverified` with the reason in `validator_domains` and `syncer_validators_domain_checks_total`; a definite failure is checked again in 6 h, a transient one in 1 h, and a domain verified within 24 h stays verified through transient failures. Logged once, when the result changes. |
| `Domain "<domain>": the fetch was blocked (blocked_address, <range>)` | A validator's domain resolves to a private, loopback or reserved address | Nothing is requested; the pair is `unverified` (`blocked_address`) and is checked again in 6 h. Logged at every check. |
| `Domain verification: N of M manifest lookups failed (...)`, `... were answered with an error (<codes>)` | The node cannot be asked, or answers an error (`actNotFound`, `slowDown`, ...), for the manifests that were stored before migration 002 | Those validators are not checked until an answer is stored; each key is asked again after 10 minutes. |
| `Network state poll failed: <request>: ...`, `Amendment features poll failed: ...` | The node cannot be asked, times out (5 s), answers an error, or answers with something that cannot be stored | No row is written for that poll; the next one (60 s, or 10 min for the features) is the retry. Logged when the failure starts or changes, and `... recovered` once when it ends; counted in `syncer_validators_node_polls_total{outcome="error"}`. |
| `Compute job <name> failed: ...` | A job of the compute loop threw (ClickHouse refusing a query or an insert, mostly) | Counted in `syncer_validators_jobs_total{outcome="error"}`; the other jobs of the tick still ran. The job runs again at the next tick from the newest stored round, and a round that was half written is redone as a newer set. |
| `round <V>: recorded N of M UNL validations, below quorum Q` | The collector missed validations of the round (it was down or behind), the ingest lacks the voting ledger, or the UNL validators did not validate it | The round is recorded as it is, with `observed N`; the votes of the validators that were missed are carried from their last record (24 h). |
| `Agreement: no UNL is known at the end of <hour>, the hour waits for a validator list` | No list of a configured publisher is stored (or too few agree for `GH_UNL_THRESHOLD`), so the UNL of the hour is empty | No hour is written, and the lag gauge of the agreement grows. Logged once; the hour is computed when a list is stored. |
| `syncer_validators_agreement_lag_seconds` grows | The ingest is behind (an hour is ready when the newest committed ledger closed after its end), or the job fails (`Compute job agreement failed: ...`), or the budget of 10 s is spent on a backlog | Hours are done oldest first and the job resumes from the newest stored hour. An hour with a gap is `final = 0` and recomputed once an hour; the gauge counts from the newest final hour. |
| `Seeding validator_seen failed: <message>; it is tried again at the next start` | ClickHouse refused a statement of the one-off seeding of `validator_seen` | The worker is booted and the compute loop runs. The partitions done stay; the next start seeds again until the oldest partition of `validations` is covered. |
| `Skipping a compute tick: ...`, `Abandoning the compute tick in flight: ...` | A tick took longer than a minute, or did not end within 2 s of the shutdown | The tick was skipped, or was left to finish by itself (it was told to write nothing more). |
| `amendment <ID> has no metadata entry` | The node, the ledger or the votes name an amendment that the amendment metadata lacks | Warned once per ID; `syncer_amendments_without_metadata` counts them. Add the entry (`amendments:check` lists them). |

## 11. Source map

| Where | What |
| --- | --- |
| `apps/syncer/src/main.ts`, `app.module.ts`, `worker-registry.ts`, `core/*` | Bootstrap, worker selection, node client provider, migrate-on-boot |
| `apps/syncer/src/ingest/{live-runner,rpc-ledger-source}.ts` | The ingest worker and its ledger source |
| `apps/syncer/src/cli/range-ingest.ts` | The range-ingest CLI and runner |
| `apps/syncer/src/validations/*`, `fees/*`, `aggregator/*` | Three more workers |
| `apps/syncer/src/validators/*` | The validators worker: `unl-fetcher` (UNL lists), `domain-checker` and `toml-match` (domain verification), `network-state-poller` (ledger state, amendment names, the metadata gauge), `compute-loop`, `rounds.job` and `tally` (the compute loop, the voting rounds and the pure tally), `agreement.job` and `agreement` (the hourly agreement and its pure counting), `seen-seed`, `stored-lists`, `safe-fetch` (the only outbound HTTP) |
| `apps/syncer/src/modules/{liveliness,prometheus}/*` | Probe and metrics |
| `packages/shared/src/ingest/*` | `buildLedgerRows`, `LedgerWriter`, ingest-state (checkpoint, deletes, quiescence), `LedgerSource` |
| `packages/shared/src/parsers/*` | Payment, exchanges, balance changes, accounts created, affected accounts |
| `packages/shared/src/aggregate/{stats,volume}.job.ts`, `query/rates.service.ts` | Aggregation and rates |
| `apps/syncer/src/aggregator/{rates-daily,pair-hourly,markets-live,account-rollups}.job-runner.ts`, `aggregate-job-deps.ts` | The four account and market jobs: the runners and `AggregateJobDeps` ([7.5](#75-runners-registration-and-failures)) |
| `packages/shared/src/aggregate/{rates-daily,pair-hourly,markets-live,account-rollups}.job.ts`, `aggregate-sets.ts` | What the runners write: the sets, their versions and their readers |
| `packages/shared/src/query/{daily-rates,account-day-groups,valuation}.ts` | What the API reads them with: `DailyRates`, the day groups (raw or rollup), the valuation rule |
| `packages/shared/src/xrpl/node-client.ts` | The node client |
