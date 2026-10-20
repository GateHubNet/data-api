# Load and capacity testing

Two dimensions matter: **API read throughput/latency** and **syncer ingest throughput**. They are tested separately.

## 1. API read load (k6)

`seed.js` writes SYNTHETIC ledgers straight into the tables of the current schema (ledgers, transactions and their lookup tables, payments,
exchanges, balance changes, hourly stats, fee snapshots), so no node is needed. Use a **throwaway database**: never one that a live syncer
writes to.

```bash
# a) build the workspace (the seeder and the migration use the compiled shared package)
pnpm build

# b) ClickHouse + a scratch database with the real schema (the database name is the one you choose)
docker compose up -d clickhouse
export GH_NETWORK=xrpl GH_CLICKHOUSE_DATABASE=loadtest GH_CLICKHOUSE_URL=http://localhost:8123
pnpm ch:migrate

# c) seed: 20,000 ledgers x 10 transactions (about 2.5 million rows, a few seconds)
node load/seed.js 20000 10            # usage: [ledgers=20000] [txPerLedger=10] [firstLedger=90000000]
#    it prints the account and ledger range to pass to k6

# d) run the API against that database, with a known key and a rate limit the test cannot hit
#    (a single client address makes all the requests)
GH_ENV=local GH_API_KEYS=test-key-123 GH_RATE_LIMIT=1000000 pnpm start:api     # GH_ENV skips the .env file; GH_CLICKHOUSE_* are exported from b)

# e) run the load test (install k6 first: `brew install k6`)
BASE_URL=http://localhost:3001 API_KEY=test-key-123 \
ACCOUNT=<printed by the seeder> FIRST_LEDGER=90000000 LEDGERS=20000 k6 run load/api-load.js
```

The synthetic window ends "now" (one ledger every 4 s), every fifth transaction is an `OfferCreate` with one USD/XRP or EUR/XRP exchange, the others
are payments in XRP, USD, EUR or BTC. Not seeded: `validations` and the volume rollups (the aggregator writes those), so the volume endpoints
answer an empty 200. The seeder refuses a database that already has ledgers (`SEED_ALLOW_NONEMPTY=1` overrides it).

`api-load.js` ramps 0 -> 500 virtual users across the read endpoints that exist in `apps/api`: payments (all and per currency), transactions,
ledgers (latest and by index with transactions), stats, network fees, exchange and payment volume, candles, exchange rates, active accounts, the
account lists and, in the group `aggregates`, the account analytics and Markets routes (below). Thresholds (the test **fails** if breached):

- `http_req_duration` p95 < 500 ms, p99 < 1500 ms
- error rate < 1 %

Tune `stages` and `thresholds` to your SLO. Watch the API's `/metricz` (`api_http_request_duration_seconds`) and ClickHouse's own metrics
(`system.query_log`, `system.processes`) during the run.

### The `aggregates` group: account analytics and Markets

`api-load.js` sends 30 % of its requests (`AGGREGATE_SHARE`, default 0.3) to the five routes of the account and market aggregates, in a k6 group named `aggregates`
with a threshold of its own (`http_req_duration{group:::aggregates}`, p95 < 500 ms, p99 < 1500 ms). They are the four routes under
`/v2/accounts/{ACCOUNT}/analytics/` (`balances` and `balance_changes` per day, `balance_changes` per type and asset, `counterparties?limit=6`, `exchanges`) for the
account the seeder prints (`ACCOUNT`), over the last 30 days, and `/v2/network/markets?period=day`. What to expect: an ordinary account is 20 to 100 ms, an account read from
rollups 100 to 500 ms, `network/markets` 10 to 30 ms; `analytics/counterparties` of an account with tens of millions of payments is seconds, by design (it is always read on request).
To try the group on its own, with a few users (the command line replaces the ramp, and k6 says so): `k6 run --vus 4 --duration 20s load/api-load.js` with the variables of step e).

What the seeded database has and has not for them:

- **The rates and the rollups are not seeded.** The analytics routes work without them (the rates are worked out on read, and an account is read from its own rows), which is the slow path; the stored rates
  (`native_rates_daily`) and the rollups are what the syncer's aggregator writes. Run it against the throwaway database to measure the fast path:
  `GH_ENV=local GH_WORKERS=aggregator GH_METRICZ_PORT=3010 pnpm start:syncer` with the `GH_CLICKHOUSE_*` variables of step b) (an aggregator-only syncer makes no node connection; the API has the metrics port 3000).
- **`/v2/network/markets` answers an empty 200** until the aggregator has written the Markets sets, which need hourly statistics for the 7 UTC days of the sparkline (and for the 30 days of `30day`):
  a seed of a day is too short. Seed at least 8 days of ledgers (`node load/seed.js 172800 10`: about 1.7 million transactions, a minute or two) and let the aggregator run.
- **The seeder's accounts are light**, about a hundred balance changes each with the default shape, so `ACCOUNT` is read from its own rows.

**Rolling up a seeded heavy account.** An account gets rollups when it is *heavy*: it has `GH_ACCOUNT_ROLLUP_MIN_ROWS` balance changes (default 1,000,000), and at least 10,000 of them in one partition of `balance_changes`
(the floor of the discovery: a setting below 10,000 behaves like 10,000). A seed does not get an account there by itself (that takes about 20 million transactions), so lower the setting to 10,000 and multiply the rows
of `ACCOUNT` before the aggregator runs. This copies each of its balance changes 200 times under another `node_index` (the key is `(account, ledger_index, tx_index, node_index)`): an account of the default seed
has about a hundred balance changes and ends with about 20,000, one of an 8-day seed with more than 100,000, over the same days:

```sql
-- clickhouse-client: replace <ACCOUNT> with the account the seeder printed; `loadtest` is the database of step b)
INSERT INTO loadtest.balance_changes
SELECT * EXCEPT (copy) REPLACE (toInt16(node_index + 10 * copy) AS node_index)
FROM loadtest.balance_changes
ARRAY JOIN range(1, 201) AS copy
WHERE account = '<ACCOUNT>';
```

Then run the aggregator with the setting lowered and wait for the promotion (the heavy account is found at the first run; its closed days are rolled newest first, today is always read from its rows):

```bash
GH_ENV=local GH_WORKERS=aggregator GH_ACCOUNT_ROLLUP_MIN_ROWS=10000 GH_METRICZ_PORT=3010 pnpm start:syncer   # the GH_CLICKHOUSE_* variables of step b)
curl -s localhost:3010/metricz | grep -E "^syncer_account_rollups_(heavy|pending)_accounts"   # heavy 1, pending 0 when it is done
```

Compare two runs of the same group, one before the promotion (every read of `ACCOUNT` counts `api_account_day_groups_total{source="raw"}` on the API's `/metricz`) and one after it (the days the rollups cover count `source="rollup"`;
today is read from the rows, so both grow). The answers are the same: a rollup is invisible. An account that stays under the floor is never rolled up, whatever the setting.

### What to look for
- **p95/p99 latency** against concurrency: where is the knee?
- **ClickHouse CPU and memory**: list pages are key-ordered range reads and should stay cheap; candles, rates and active accounts aggregate their
  window, so they grow with it.
- If latency degrades: scale ClickHouse (RAM, CPU), add api replicas, and check `system.query_log` for the heavy query. Raise `GH_RATE_LIMIT`
  only after confirming the backend keeps up.

## 2. Syncer ingest throughput

The syncer is network-bound on the node, then ClickHouse-bound on writes. Measure with the Prometheus gauges and the range-ingest CLI rather than a
synthetic tool:

```bash
# point at your node (GH_NODE_ENDPOINTS), pick a fixed range of a scratch database, and time it. ingest:range runs the compiled
# dist/cli/range-ingest.js (pnpm build first); GH_ENV=local makes it read the exported variables instead of an .env file, like start:syncer below
export GH_ENV=local GH_NETWORK=xrpl GH_CLICKHOUSE_DATABASE=ingesttest GH_NODE_ENDPOINTS=ws://your-node:6006
pnpm build
pnpm ch:migrate
time pnpm --filter @gatehub/data-syncer ingest:range --from 80000000 --to 80010000 --concurrency 16

# live catch-up speed: start the syncer at an old ledger of a scratch database and watch the gauges
GH_ENV=local GH_SYNC_START_LEDGER=80000000 GH_CATCHUP_CONCURRENCY=16 pnpm start:syncer
watch -n5 'curl -s localhost:3000/metricz | grep -E "^syncer_(checkpoint_ledger|head_ledger|lag_ledgers)"'
```

`rate(syncer_checkpoint_ledger[5m])` is ledgers per second while catching up; the CLI prints the number of ledgers written. To find the ceiling,
raise `--concurrency` / `GH_CATCHUP_CONCURRENCY` until ledgers per second stops improving (node-bound), then look at ClickHouse (parts, merges,
`system.mutations`). A single syncer per network cannot be sharded; for a big backfill run range ingests over *disjoint* ranges in parallel.

Capacity-plan a backfill from the measured rate: `ledgers / (ledgers per second)` seconds (about 22,000 XRPL ledgers close per day; two years is
roughly 46-57 million; see [../docs/backfill.md](../docs/backfill.md)).

## 3. ClickHouse query micro-benchmarks (optional)

For pure database capacity, `clickhouse-benchmark` against the seeded data isolates the storage layer from the API. For example the page read behind
`/v2/payments`:

```bash
echo "SELECT ledger_index, tx_index FROM loadtest.payments ORDER BY ledger_index, tx_index LIMIT 201" \
  | clickhouse-benchmark --host localhost --port 9000 -i 1000 -c 16
```
