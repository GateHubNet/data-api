# Backfilling history

This guide answers two questions:

1. **How do I fill history before the point where the live syncer started** (and repair gaps, and reprocess after a parser
   change)?
2. **Which node should I read the history from?**

Works the same for the XRP Ledger and for Xahau; every command below takes the network's compose service
(`syncer-xrpl` or `syncer-xahau`) or the `GH_NETWORK` of your environment.

## TL;DR

- The **live syncer** (`ingest` worker) only moves forward from its start ledger. Everything before it comes from the
  **range-ingest CLI**, which runs next to the live syncer, is resumable and writes the same tables through the same writer.
- Roughly 20-23 thousand XRPL ledgers close per day; two years is about 46-57 million. Xahau has a shorter history.
- You need a node that **holds the full history of the range** you ask for. Public clusters work for live syncing but throttle a
  large sweep; for a big backfill use your own full-history node (or a full-history provider).
- Backfill is **history**: the CLI refuses a range that reaches above the live syncer's checkpoint while the syncer is running.

## 1. How a backfill works

```bash
# production compose (the live syncer keeps running; the CLI checks its lease itself)
docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm --no-deps syncer-xrpl \
  node dist/cli/range-ingest.js --from 90000000 --to 90100000

# the same from source: `ingest:range` runs the compiled dist/cli/range-ingest.js, so `pnpm build` first; it needs the syncer's GH_* environment
# (apps/syncer/.env, or GH_ENV=local with the variables exported; GH_NODE_ENDPOINTS = the node to read from)
pnpm build && GH_ENV=local pnpm --filter @gatehub/data-syncer ingest:range --from 90000000 --to 90100000 --concurrency 16
```

Options: `--from`, `--to` (both inclusive, required), `--chunk` (default 1000, must divide 1,000,000), `--concurrency` (default 8),
`--max-wait` (seconds a chunk may go without a ledger arriving while it waits for a rate-limited node or a ledger the node lacks
right now, default 1200), `--reprocess`,
`--run-id`, `--help`. Exit status: `0` done, `1` failed (rerun the same command; with `--reprocess` see "Resume a `--reprocess` differently" below), `2` wrong command line. The
mechanics (aligned chunks, `ingest_log` intents, recovery of a failed attempt, the lease rule, `agg_dirty`) are in
[syncer](syncer.md#4-range-ingest-cli).

### Picking the range

```text
# Ask a node what it has:   { "command": "server_info" }  ->  result.info.complete_ledgers   e.g. "32570-90100000"
# Current validated ledger  ~ LEDGER_NOW.   N days back ~ LEDGER_NOW - N * 22000   (XRPL)
```

For a fresh deployment, start the live syncer first (`GH_SYNC_START_LEDGER` empty = the validated head, or a recent ledger of your
choice) so the head stays current, then backfill the history **below** the ledger it started at:

```bash
# live syncer started at 107600000;  fill the previous year
... node dist/cli/range-ingest.js --from 85000000 --to 107599999 --concurrency 16
```

A range that runs into ledgers already committed simply skips them (unless `--reprocess`).

A range must not **start** above the highest committed ledger + 1 on a database a live syncer has run on (it has a `syncer_lease`
row): the live syncer resumes after the highest committed ledger, so the ledgers between its checkpoint and `--from` would never be
fetched, and a live syncer that boots while the range is written deletes the ledgers above its checkpoint. Such a range is refused
(`Range [a,b] starts above the live checkpoint c + 1 ...`) unless `--allow-gap` is given, for a gap you then fill with another range
ingest (Ruling R110). A database filled by range ingests only (no lease row) is not checked.

### Throughput

- Each ledger is one expanded `ledger` request, so throughput is bound by the node's latency and rate limits, not by ClickHouse
  (bulk synchronous inserts, partitions of a million ledgers, background merges). Raise `--concurrency` until the node is the
  bottleneck; with your own node, hundreds of ledgers per second are realistic.
- A chunk is held in memory (1000 ledgers by default); busy ledgers can have hundreds of transactions, so lower `--chunk` (it must
  divide 1,000,000: 500, 250, 100, ...) if memory is tight.
- Budget disk for `transactions` (`tx_json` and `meta_json` are ZSTD-compressed text and by far the largest columns): roughly
  1-1.5 TB compressed for full XRPL history.
- Watch the CLI's log (`Range [...] ingested: N chunks complete ... M ledgers written, K unclassified AMM pools`) and, in ClickHouse,
  `SELECT count(), max(ledger_index) FROM xrpl.ledgers`. The aggregator follows by itself (see below).

### Resuming, gap repair, reprocessing

- **Resume:** rerun the same command, or one with another `--chunk` or a narrower range: finished chunks (`ingest_log` `done`) are
  skipped, and an unfinished one (an intent a failed or killed run left `started`) is redone over its whole recorded range first and
  closed: its committed ledgers are kept, every other ledger of the recorded range is cleaned and written, also those outside the
  range of the rerun, and the hours of all its committed ledgers are marked in `agg_dirty` (the run that died may have committed
  some and never marked them). It is redone once, whatever the chunk size or range of the rerun (Rulings R100, R110). The redo
  fetches the ledgers of the recorded range from the same node as the rest, so a rerun can fetch more than it names.
- **Resume a `--reprocess` differently.** The skipping above is for a plain run. With `--reprocess` the run writes **every** chunk it is
  given, whether or not the chunk was finished before, so rerunning the same command rewrites the whole range again. Restart with `--from`
  just after the last chunk the failed run finished: the last log line `Chunk [a,b] done in ... ms: N ledgers written (redone)` gives it
  (`--from` = `b` + 1), or read it from `ingest_log` (a chunk is `done` when its newest row says so; set the timestamp to the UTC time
  the failed run started, because the chunks that earlier runs finished are `done` as well):

  ```sql
  SELECT max(range_end) + 1 AS restart_from
  FROM (SELECT range_end, argMax(status, updated_at) AS last_status, max(updated_at) AS last_at
          FROM xrpl.ingest_log
         WHERE NOT startsWith(run_id, 'live:') AND range_end > 0
         GROUP BY range_start, range_end)
  WHERE last_status = 'done' AND last_at >= toDateTime64('2026-10-18 09:00:00', 3, 'UTC');   -- when the failed run started
  ```

  (`restart_from` is 1 when the run finished no chunk: keep the original `--from`.) The chunk that was running when the run failed is
  left `started`; the restart redoes it first over its whole recorded range, with the same `--to` and a `--from` at or below its end.
- **Gaps:** find them with the SQL in [operations](operations.md#sql-health-checks) and ingest exactly those ranges.
- **Reprocess:** after a parser change (the `parser_version` of `ledgers` records which parser wrote a ledger),
  `--reprocess --from A --to B` fetches and dry-parses first, then deletes and rewrites the committed ledgers of the range.
  It rewrites the whole requested range, not only ledgers of an older parser version.
  Parser version 2 adds the AMM rows (swaps against pools among the `exchanges`, and `amm_pool_states`, `amm_pool_touches`,
  `amm_liquidity`, `account_amm_liquidity` and `amm_governance`): ledgers written by version 1 lack them, so on the XRP Ledger a
  reprocess from the AMM enablement ledger (86795265) on is needed for complete pool data: see
  [AMM data re-ingest](#amm-data-re-ingest). Pools or reserve lines the parser could not turn into rows
  are counted in `syncer_amm_unclassified_total` (and the range-ingest log names the total of its run).
  Parser version 4 adds the path payments (`path_payments`): ledgers written by an older version have none, see
  [Path payments re-ingest](#path-payments-re-ingest).
- **Aggregates:** every written chunk marks its hours in `agg_dirty`; the aggregator recomputes the stats and the daily volumes of
  those hours within its per-tick budgets (see [syncer](syncer.md#7-the-aggregator)). A multi-year backfill therefore takes the
  aggregator a while to digest: `SELECT count() FROM xrpl.agg_dirty` shrinks as it works.

### AMM data re-ingest

`PARSER_VERSION` is 2 since the AMM parser ([ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md)). A ledger written by version 1 has no
AMM rows, and what the live syncer writes from the deploy on is version 2 only: **a database that ingested the XRP Ledger before this
release is missing every swap, liquidity event and pool state before it**, and `ledgers.exchanges_count` and `/v2/stats` lack the swaps.
A pool appears in the API when its first transaction is ingested, so until the history is re-ingested the pool list has the pools that were
touched since the deploy and no earlier history. Xahau has no AMM: there is nothing to re-ingest there.

**Where to start.** No AMM transaction exists before the ledger that enabled the amendment:

| | |
| --- | --- |
| Enablement ledger | **86795265**, closed 2024-03-22 20:11:41 UTC (ledger hash `438E0988A35F030ED73C4F3F7C02981485599ABAA9913805EDD7D2B970FD4B33`) |
| `EnableAmendment` transaction | `75F52BB86416717288999523063D54E24290EFEA2E99DF78E80A12BD1C8FAC99` |
| Amendment id (`AMM`) | `8CC0774A3BF66D1D22E76BBDA8E8A232E6B6313834301B3B23E8601196AE6455` |

How it was found (bisecting `ledger_entry` on the `Amendments` object: 54 enabled amendments without AMM at ledger 86795009, 55 with it at
86795265) is in the "XRPL AMM cases" section of [`packages/shared/test/fixtures/README.md`](../packages/shared/test/fixtures/README.md).

**Procedure.**
1. Deploy the release (schema, syncer, api) and let the live syncer run: it writes version-2 rows from now on.
2. Re-ingest the committed history from the enablement ledger up to the live checkpoint. The range is committed, so it needs
   `--reprocess` (it fetches and dry-parses before it deletes anything, then rewrites the ledgers in every table):

   ```bash
   # the checkpoint: SELECT max(ledger_index) FROM xrpl.ledgers
   docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm --no-deps syncer-xrpl \
     node dist/cli/range-ingest.js --from 86795265 --to <checkpoint> --reprocess --concurrency 16
   ```

   That is about 21 million ledgers at the time of writing (the validated head was 107.7 million on 2026-10-17): read
   [Which node?](#2-which-node) and use a node of your own. The reprocess rewrites every table of each ledger, not only the AMM
   tables, so it costs what the first ingest did. **After a failure do not rerun the same command**: with `--reprocess` every chunk is
   written again, so that repeats the whole rewrite. Restart with `--from` just after the last chunk the failed run finished (see
   [Resuming](#resuming-gap-repair-reprocessing): the `Chunk [a,b] done ... (redone)` log line, or `ingest_log`).
   Ledgers that are not committed yet (a new database that is filled below the live start) need no `--reprocess`: a plain
   `range-ingest --from 86795265 --to <live start - 1>` writes version-2 rows at once.
3. The aggregates follow by themselves. Every written chunk marks its hours in `agg_dirty`, and for each slice the aggregator
   rebuilds the **`amm_pools`** rows of the pools with a touch in it, the **`amm_daily`** sets of its days and the daily **`amm_volume`**
   sets, with the stats, within the per-tick budgets ([syncer](syncer.md#7-the-aggregator)). After that the `amm_daily` back-fill
   fills any closed day that still has no final set, newest first, from the day of the first pool touch. Watch
   `SELECT count() FROM xrpl.agg_dirty`. A multi-year re-ingest takes the aggregator a while to digest.
4. Check:

   ```sql
   -- every ledger from the enablement on is written by parser version 2 or later
   SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 86795265 GROUP BY parser_version;
   -- how many pools and days the aggregator has built so far
   SELECT uniqExact(amm_account) FROM xrpl.amm_pools;
   SELECT uniqExactIf(day, amm_account = '') AS days, uniqExactIf(day, amm_account = '' AND final = 1) AS days_with_a_final_set FROM xrpl.amm_daily;
   ```

   `syncer_amm_unclassified_total` counts the pools the parser could not place, and the range-ingest log ends with a warning that names
   the total of the run. A pool whose creation is older than the first ledger you ingested has no `created_ledger` / `created_by`.

### Account state history re-ingest

`PARSER_VERSION` is 3 since the account and trust line state history
([ADR-0015](adr/0015-historical-account-state-from-clickhouse.md)): every ledger written by version 3 has its `account_states` and
`trust_line_states` rows, and a ledger written by an older version has none. The API answers a historical read of the state tables
(`/v2/accounts/{address}?flags=true` with a ledger named, `/v2/accounts/{address}/trustlines`) only above the **newest ledger an older
parser wrote** (`STATE_PARSER_VERSION`, `StateLedgerService`); a ledger at or below it answers 400 `the date provided is too old`. Gaps in the
ledger numbers do not matter, only the versions of the stored ledgers do.

So after the deploy, the coverage starts at the first ledger the live syncer writes, and **a single ledger of an older version left
anywhere above an older range moves the start up to it**. To extend the coverage downwards, re-ingest from the start you want up to the
live checkpoint with `--reprocess`, as for the AMM data above (the same command, another `--from`; a range that is not committed yet
needs no `--reprocess`). The state of an account that has not changed since the coverage start is not known: the history spec fills
the tables back to ledger 32570 with the state of that ledger. Check the coverage start:

```sql
-- the state tables cover the ledgers above this one (NULL: every stored ledger)
SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 3;
```

The API keeps that answer for a minute (`STATE_COVERAGE_CACHE_MS`).
### Path payments re-ingest

`PARSER_VERSION` is 4 since the path payments parser (`PATH_PARSER_VERSION`, spec #4). A ledger written by an older version has no
`path_payments` rows, so `/v2/path_payments` lists the path payments of the ledgers ingested since the deploy only. Nothing else
changes for those ledgers: the payments, exchanges and AMM rows a reprocess rewrites come out the same.

1. Apply migration `007_path_payments.sql` **before** the syncer of this release starts: the syncer writes `path_payments` with every
   ledger, and a write to a missing table fails the batch, so the live runner would retry it for ever
   ([operations](operations.md#apply-a-schema-migration)). Then deploy the syncer and the api.
2. To fill the history, reprocess the range you want listed, the same way as the [AMM data re-ingest](#amm-data-re-ingest):
   `range-ingest --from <A> --to <B> --reprocess`. It rewrites every table of each ledger. Path payments exist from the first ledgers
   on (rippling through market makers is as old as the ledger), so there is no natural start; filling all of history is the history
   spec's job (out of scope of spec #4).
3. Check which parser wrote a range:

   ```sql
   SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index BETWEEN <A> AND <B> GROUP BY parser_version;
   ```

### Public nodes and rate limits

Public nodes limit what one client may ask, and say how long to wait: `rate limit: units quota (50000 per 10s) exhausted, retry in
~12376ms` (`wss://xahau.network`, `wss://xrplcluster.com`), and a second, hourly quota (`10000000 per 3600s`) that pauses a client
for up to about 15 minutes. The node client honours the answer (nothing is sent to that node until the pause is over; another
endpoint of `GH_NODE_ENDPOINTS` is used meanwhile), and range-ingest waits for it, so a throttled backfill slows down instead of
failing. A chunk fails only when `--max-wait` seconds pass without any of its ledgers arriving: every ledger fetched starts that time
again, however long the chunk takes in all. What keeps it moving:

- `--concurrency 1`: Xahau ledgers are about 260 KB, and `wss://xahau.network` throttles even one fetch at a time (the live
  re-check of Task 38 saw 2 to 3 ledgers per 10-second window at concurrency 1); more in flight only meets the pauses sooner and
  spends the quota on fetches that are refused. On XRPL's public nodes use 1 as well: `wss://s2.ripple.com` throttled at 2 in flight
  (2026-10-18); 1 in flight at about 1.5 requests a second or less, or your own node.
- `--chunk 100`: a chunk is written only once all of its ledgers are in, and a chunk that fails (a ledger the node lacks, or a
  pause longer than `--max-wait`) is redone by the next run; a small chunk keeps both the memory and that redo cheap.
- `--max-wait` longer than the pauses the node asks for. The 10-second quota asks for seconds. The hourly quota asked for about
  930 s in the verification run: the default 1200 rides that out when it starts within about 4.5 minutes of the last ledger
  fetched, which is the usual case (the answer comes on the next fetch); raise `--max-wait` for margin. A pause the node client
  caps at 20 minutes never fits in 1200 s: that chunk fails and the rerun picks it up.
- Expect tens of ledgers per minute, not hundreds: a backfill of more than a few thousand ledgers wants a node of your own.
- Run one backfill per node at a time, and not while the live syncer catches up from the same node: they share its quota.

Example for a few days of Xahau history from the public node:

```bash
GH_ENV=local GH_NETWORK=xahau pnpm --filter @gatehub/data-syncer ingest:range \
  --from 26505727 --to 26570726 --concurrency 1 --chunk 100 --max-wait 1200
```

## 2. Which node?

The backfill calls `ledger` with `transactions: true, expand: true`, which needs a node that holds the **full transaction history**
of the range:

| Source | History | Rate limits | Good for |
| --- | --- | --- | --- |
| **Your own full-history rippled / Clio** | Complete if configured | None | Backfill and live |
| A full-history provider | Complete | Per plan | Backfill without running infrastructure |
| Public cluster (`xrplcluster.com`, `s2.ripple.com`) | Often deep (`s2` is Ripple's full-history server) | Yes, throttled under sweep load | Live syncing, light backfill |
| Xahau (`wss://xahau.network`) | Check `complete_ledgers` (full history from ledger 1 at the time of writing) | Yes: 50,000 units per 10 s, 10,000,000 per hour | Live; light backfill (see above) |

- **One-time deep backfill:** your own full-history node (or a rented full-history API for the duration). A sweep of tens of millions
  of ledgers against a public endpoint is rate-limited, fails intermittently (retries mask but slow it) and is impolite to a shared
  resource.
- **Live syncing afterwards:** a public cluster is fine (one ledger every 3-4 s). Keep your own node for resilience if you can.
- Point the process at it with `GH_NODE_ENDPOINTS` (a comma separated list; credentials in the URL are never logged). For the
  compose stack set `XRPL_NODE_ENDPOINTS` / `XAHAU_NODE_ENDPOINTS` in `deploy/.env.prod`; note that it also becomes the api's
  live-state node.

### Running your own rippled (outline)

1. Provision fast NVMe storage, lots of it: full history is multi-terabyte and grows.
2. Install `rippled`, configure it for full history (`[ledger_history]`, `[node_db]` NuDB per the current guidance), let it acquire
   history or start from a snapshot.
3. Point the syncer at it (`XRPL_NODE_ENDPOINTS=ws://your-host:6006`) and run the backfill; afterwards you may switch back to a
   public endpoint for live-only operation.

Exact configuration keys, disk and sync time change between releases: follow the current XRPL.org capacity-planning and full-history
documents when you provision.

## 3. Things a backfill does not do

- No genesis import: `accounts_created.genesis_*` stays empty until a history import loads ledger 32570. The `LedgerSource`
  interface is the seam for an importer of older data (e.g. from SQLite dumps).
- No ingest of pre-2013 data that the node does not hold.
- It does not touch `fee_stats` or `validations` (they exist only from when their workers ran: they are collected live, not derived
  from ledgers).
