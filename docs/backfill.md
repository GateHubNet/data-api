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
`--run-id`, `--help`. Exit status: `0` done, `1` failed (rerun the same command), `2` wrong command line. The
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

### Throughput

- Each ledger is one expanded `ledger` request, so throughput is bound by the node's latency and rate limits, not by ClickHouse
  (bulk synchronous inserts, partitions of a million ledgers, background merges). Raise `--concurrency` until the node is the
  bottleneck; with your own node, hundreds of ledgers per second are realistic.
- A chunk is held in memory (1000 ledgers by default); busy ledgers can have hundreds of transactions, so lower `--chunk` (it must
  divide 1,000,000: 500, 250, 100, ...) if memory is tight.
- Budget disk for `transactions` (`tx_json` and `meta_json` are ZSTD-compressed text and by far the largest columns): roughly
  1-1.5 TB compressed for full XRPL history.
- Watch the CLI's log (`Range [...] ingested: N chunks complete ... M ledgers written`) and, in ClickHouse,
  `SELECT count(), max(ledger_index) FROM xrpl.ledgers`. The aggregator follows by itself (see below).

### Resuming, gap repair, reprocessing

- **Resume:** rerun the same command, or one with another `--chunk`: finished chunks (`ingest_log` `done`) are skipped, and an
  unfinished one (an intent a failed or killed run left `started`) is redone over its whole recorded range first and closed, so
  it is redone once whatever the chunk size of the rerun.
- **Gaps:** find them with the SQL in [operations](operations.md#sql-health-checks) and ingest exactly those ranges.
- **Reprocess:** after a parser change (the `parser_version` of `ledgers` records which parser wrote a ledger),
  `--reprocess --from A --to B` fetches and dry-parses first, then deletes and rewrites the committed ledgers of the range.
  It rewrites the whole requested range, not only ledgers of an older parser version.
- **Aggregates:** every written chunk marks its hours in `agg_dirty`; the aggregator recomputes the stats and the daily volumes of
  those hours within its per-tick budgets (see [syncer](syncer.md#7-the-aggregator)). A multi-year backfill therefore takes the
  aggregator a while to digest: `SELECT count() FROM xrpl.agg_dirty` shrinks as it works.

### Public nodes and rate limits

Public nodes limit what one client may ask, and say how long to wait: `rate limit: units quota (50000 per 10s) exhausted, retry in
~12376ms` (`wss://xahau.network`, `wss://xrplcluster.com`), and a second, hourly quota (`10000000 per 3600s`) that pauses a client
for up to about 15 minutes. The node client honours the answer (nothing is sent to that node until the pause is over; another
endpoint of `GH_NODE_ENDPOINTS` is used meanwhile), and range-ingest waits for it, so a throttled backfill slows down instead of
failing. A chunk fails only when `--max-wait` seconds pass without any of its ledgers arriving: every ledger fetched starts that time
again, however long the chunk takes in all. What keeps it moving:

- `--concurrency 2` (Xahau ledgers are about 260 KB; one 10-second window of 50,000 units lets through roughly 100 to 370 of them).
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
  --from 26505727 --to 26570726 --concurrency 2 --chunk 100 --max-wait 1200
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
