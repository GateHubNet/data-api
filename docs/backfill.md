# Backfilling 2 years of history

This guide answers two questions:

1. **How do I backfill ~2 years of XRPL data?**
2. **Should I run my own rippled to get that history?**

## TL;DR

- ~2 years ≈ **~57 million ledgers** (XRPL closes a ledger every ~3–4 s ⇒ ~21–23k/day ⇒
  ~7.7M every 3 months ⇒ ~46–57M in 2 years).
- You need a data source that **has those ledgers as full-history transaction data**.
- **Recommended: run your own full-history rippled** (or use a paid full-history provider)
  for the backfill. Public clusters work but will rate-limit / throttle a 50M-ledger sweep
  and make it slow and unreliable. For ongoing **live** sync, a public/cluster node is fine.

## 1. How the backfill works

The syncer (`apps/syncer`) has two modes, toggled by env (see `apps/syncer/.env.example`):

- `GH_BACKFILL_ENABLED=true` with `GH_BACKFILL_START_LEDGER` / `GH_BACKFILL_END_LEDGER`
  — a worker pool (`GH_BACKFILL_WORKERS`) fetches each ledger with expanded transactions,
  parses it, and bulk-inserts into ClickHouse. Already-indexed ledgers are skipped
  (windowed lookup against the `ledgers` table), so it resumes cleanly after a restart.
- `GH_SUBSCRIBE_LIVE=true` — subscribes to the `ledger` stream and ingests new ledgers as
  they close.

You can (and for a fresh deployment, should) run both at once: live keeps the head current
while the pool fills history behind it. Because writes are idempotent (CTID +
`ReplacingMergeTree`), the overlap is harmless.

### Picking the ledger range for "2 years"

```bash
# Ask any node for its available range:
#   { "command": "server_info" } -> result.info.complete_ledgers  e.g. "32570-86000000"
# Current validated ledger index ≈ <LEDGER_NOW>. Two years back ≈ <LEDGER_NOW> - 57_000_000.
GH_BACKFILL_START_LEDGER=<LEDGER_NOW_MINUS_~57M>
GH_BACKFILL_END_LEDGER=<LEDGER_NOW>
GH_BACKFILL_WORKERS=12        # tune to your node's rate limit
GH_FETCH_THROTTLE_MS=100      # per-worker pause; raise if you see rate-limit errors
```

The syncer clamps the range to the node's `complete_ledgers` and logs a warning if your
start is older than the node has.

### Throughput & expectations

- Each ledger = one `ledger` request (expanded). Realistic sustained rates against a
  healthy local full-history node are roughly **hundreds of ledgers/second** with 8–16
  workers — i.e. a full 2-year backfill is on the order of **a couple of days**, dominated
  by node fetch latency, not ClickHouse (which ingests this volume easily).
- ClickHouse write amplification is low: bulk JSONEachRow inserts, monthly partitions,
  background merges. Budget disk for the raw `transactions.tx_json` (the largest table).
- Watch `/metricz` (`syncer_ledgers_processed_total`, `syncer_latest_synced_ledger`) and the
  log line `Backfilled N ledgers (R/s)`.

### Resuming / gap repair

- Restarting the syncer re-derives what's already indexed and continues — no duplicates.
- Ledgers that exhaust their retries are logged at the end (`… ledgers failed and were not
  indexed: …`). Re-run the syncer with `GH_BACKFILL_START_LEDGER`/`END` narrowed to those
  ranges to fill the gaps.

## 2. Should you run your own rippled?

### What the data source must provide

The backfill calls `ledger` with `transactions:true, expand:true`. That requires the node to
**hold full transaction history for the range you want**. Three options:

| Source | History | Rate limits | Cost | Good for |
| --- | --- | --- | --- | --- |
| **Your own full-history rippled** | Complete (if configured) | None (it's yours) | High disk (multi-TB), ops effort | **Backfill** + live |
| Paid full-history API (e.g. providers offering full-history XRPL) | Complete | Per plan | $$ | Backfill without running infra |
| Public cluster (`xrplcluster.com`, `s2.ripple.com`) | Often full or deep | Yes — throttled/blocked under sweep load | Free | **Live** sync, light backfill |

### Recommendation

- **For a one-time 2-year backfill: run your own full-history `rippled`** (or rent a
  full-history API for the duration). A 50M+ ledger sweep against a public endpoint will be
  rate-limited, will intermittently fail (your retries will mask but slow it), and is
  impolite to a shared resource. A local node removes the network bottleneck and the limits,
  and lets you push `GH_BACKFILL_WORKERS` higher.
- **For ongoing live sync afterwards: a public cluster endpoint is fine** — the live stream
  is ~1 ledger every 3–4 s, nowhere near any limit. You can decommission the local node once
  history is loaded, or keep it for resilience.

### Running your own rippled (outline)

1. Provision a host with **fast NVMe SSD and lots of it** — full transaction history is
   multi-terabyte and grows continuously. Plan headroom.
2. Install `rippled` and configure it for history:
   - In `rippled.cfg`, set `[ledger_history] full` (or a large number to cap to ~2 years,
     e.g. enough ledgers to cover 57M back from the head) and enable online delete / advisory
     settings appropriate to your disk.
   - Use the `NuDB`/`RocksDB` node store per the current rippled guidance for full history.
3. Let it acquire history (this itself takes time and bandwidth), or start from a
   full-history database shard/snapshot if available.
4. Point the syncer at it:
   ```bash
   GH_XRPL_NODE_ENDPOINT=ws://your-rippled-host:6006
   ```
5. Run the backfill. Once complete, optionally switch `GH_XRPL_NODE_ENDPOINT` to a public
   cluster for live-only operation.

> Sizing/operational specifics for rippled (exact config keys, disk, sync time) change over
> releases — follow the current XRPL.org "Capacity Planning" and "Run rippled in full
> history mode" docs when you provision. The point for this project is only that the syncer
> needs a node (yours or a provider's) that actually holds the 2-year range.

### Alternative: don't backfill transaction-by-transaction

If you ever need *only* aggregates and not full per-transaction history, XRPL full-history
data dumps / third-party datasets can be loaded straight into ClickHouse, skipping the
node-fetch bottleneck. The schema in this repo is plain SQL, so a bulk `INSERT ... FROM`
loader is straightforward to add. For the current product (which serves per-transaction
endpoints) the node-driven backfill above is the right path.
