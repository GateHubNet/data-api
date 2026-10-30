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
- Watch the CLI's log (`Range [...] ingested: N chunks complete ... M ledgers written, K unclassified AMM pools, J skipped NFT events, L unclassified object changes`) and, in ClickHouse,
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
  Parser version 4 adds the path payments (`path_payments`, and their index by account `account_path_payments`): ledgers written by
  an older version have none, see
  [Path payments re-ingest](#path-payments-re-ingest).
  Parser version 5 adds the NFT and URIToken events (`nft_events`, `account_nft_events`, `collection_nft_events`,
  `nft_sales`, `nft_touches`): ledgers written by an older version have none, see [NFT re-ingest](#nft-re-ingest). NFT events the parser
  dropped for an amount that is an MPT amount are counted in `syncer_nft_skipped_total`, and the range-ingest log names the total of its run
  (a warning when it is not 0, and the last line always says `J skipped NFT events` and, after it, `L unclassified object changes`).
  Parser version 6 adds the Domain of every account root that has or had one (`account_domains`, a row for each change
  of such an account): ledgers written by an older version have none. **No reprocess is needed for them**: a one-off SQL seed gives every
  account its current Domain from the state history ([Account domains seed](#account-domains-seed)), and an account whose Domain was set
  before that history is learnt at its next change. A `--reprocess` of a range writes the rows of its ledgers, as for every table.
  Parser version 7 adds the history of escrows, checks, payment channels and delegations (`object_changes` and its index by
  account `account_object_changes`), gives a delegate its `account_transactions` row, books the fee of a delegated transaction to its delegate and
  types the balance changes of issued-token payment channels: ledgers written by an older version have none of these, and `--reprocess` writes them (see
  [Ledger objects and delegation re-ingest](#ledger-objects-and-delegation-re-ingest)).
  Changes of these objects that no event of the table expects are counted in `syncer_objects_unclassified_total`, and the range-ingest log names the
  total of its run (a warning when it is not 0, and `L unclassified object changes` in the last line).
  Parser version 8 adds the index of the trust lines and issuers whose token state a transaction changed (`state_touches`, a row for each
  created, modified or deleted trust line and for each account root whose flags, transfer rate or domain changed, or that sent an `AccountSet`;
  `TOKEN_PARSER_VERSION`): ledgers written by an older version have none. **The aggregate of the issued tokens needs no re-ingest of them**: its account
  pass reads `trust_line_states` as it is, and the job needs the touches only above the ledger its generation was built at. The job never applies a window that
  holds a ledger of an older version: it builds a new generation instead. A `--reprocess` of a range writes the touches of its ledgers, as for every table.
  Parser version 9 (the current one) adds the Xahau mint rows (`genesis_mints`, `imports` and `reward_claims`; `MINT_PARSER_VERSION`): the entries of a `GenesisMint`, the
  drops each `Import` brought and the `ClaimReward`s that a reward mint answers. Xahau ledgers written by an older version have none of them, and a `--reprocess` of a range
  writes them; XRPL has none of the three transaction types, so its ledgers hold no mint row of any version. Readers of the three tables gate on `MINT_PARSER_VERSION`, never on
  `PARSER_VERSION`. An `Import` whose minted drops come out below 0 (the network cannot produce one) is stored as 0 and counted in
  `syncer_parser_anomalies_total{kind="import_minted_negative"}`; the range-ingest log names the count of its run in a warning when it is not 0 (its last line does not carry it).
- **Aggregates:** every written chunk marks its hours in `agg_dirty`; the aggregator recomputes the stats and the daily volumes of
  those hours within its per-tick budgets (see [syncer](syncer.md#7-the-aggregator)). A multi-year backfill therefore takes the
  aggregator a while to digest: `SELECT count() FROM xrpl.agg_dirty` shrinks as it works.

### AMM data re-ingest

`PARSER_VERSION` became 2 with the AMM parser ([ADR-0011](adr/0011-amm-data-and-swaps-as-exchanges.md)). A ledger written by version 1 has no
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

`PARSER_VERSION` became 3 with the account and trust line state history
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

`PARSER_VERSION` became 4 with the path payments parser (`PATH_PARSER_VERSION`, spec #4). A ledger written by an older version has no
`path_payments` or `account_path_payments` rows, so `/v2/path_payments` and `/v2/accounts/{address}/path_payments` list the path
payments of the ledgers ingested since the deploy only. Nothing else
changes for those ledgers: the payments, exchanges and AMM rows a reprocess rewrites come out the same.

1. Apply migrations `007_path_payments.sql` and `008_account_path_payments.sql` **before** the syncer of this release starts: the
   syncer writes `path_payments` and `account_path_payments` with every ledger, and a write to a missing table fails the batch, so the live runner would retry it for ever
   ([operations](operations.md#apply-a-schema-migration)). Then deploy the syncer and the api.
2. To fill the history, reprocess the range you want listed, the same way as the [AMM data re-ingest](#amm-data-re-ingest):
   `range-ingest --from <A> --to <B> --reprocess`. It rewrites every table of each ledger. Path payments exist from the first ledgers
   on (rippling through market makers is as old as the ledger), so there is no natural start; filling all of history is the history
   spec's job (out of scope of spec #4).
3. Check which parser wrote a range:

   ```sql
   SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index BETWEEN <A> AND <B> GROUP BY parser_version;
   ```

### NFT re-ingest

`PARSER_VERSION` became 5 with the NFT parser (`NFT_PARSER_VERSION`, [ADR-0016](adr/0016-nft-and-uritoken-data.md)). A ledger written by an
older version has no rows in the five NFT tables, and what the live syncer writes from the deploy on is version 5 or later: **a database that
ingested a network before this release lists the NFTs of the ledgers since the deploy and nothing earlier**, and every NFT answer says so in its
`coverage` (`from_ledger_index`, and `complete: false` until the history is re-ingested). Both networks have the data: XRPL NFTokens and
Xahau URITokens.

**Where to start.** No NFT exists before the ledger that enabled the amendment (`packages/shared/config/amendments/<family>.json`):

| | XRPL | Xahau |
| --- | --- | --- |
| Amendment | `NonFungibleTokensV1_1` | `URIToken` |
| Enable ledger | **75,443,457** (2022-10-31) | **1**, the genesis: `complete_ledgers` of `xahau.network` starts at 1 and ledger 1 has `URIToken` in its `Amendments` |
| Re-ingest | `--from 75443457` | `--from 1` |

Complete coverage needs **every** ledger from the enable ledger to the checkpoint written by version 5 or later, so on Xahau it needs ledger 1 itself. Ledger
1 is the genesis: its close time is 0 (the file gives the date of ledger 2, the first closed ledger), so the daily volume back-fill that
follows starts at 1970-01-01 and walks about 19,000 days with no ledger in them, for each of the four volume metrics, newest first (the real
days come first and an empty day is cheap, but `volume_backfill` stays busy with them for a long time). Nothing is wrong with it.

**Procedure.**
1. Apply migration `011_nft_data.sql` **before** the syncer of this release starts: the syncer writes the five NFT tables with every ledger, and
   a write to a missing table fails the batch, so the live runner would retry it for ever
   ([operations](operations.md#apply-a-schema-migration)). Then deploy the syncer, then the api.
2. Re-ingest the committed history from the enable ledger up to the live checkpoint with `--reprocess`:

   ```bash
   # the checkpoint: SELECT max(ledger_index) FROM xrpl.ledgers
   docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm --no-deps syncer-xrpl \
     node dist/cli/range-ingest.js --from 75443457 --to <checkpoint> --reprocess --concurrency 16
   # Xahau: --from 1, on syncer-xahau, with --concurrency 1 on the public node
   ```

   That is 32 million ledgers on XRPL and the whole history on Xahau. **Do it once, as part of the program's one reprocess after its last
   parser version**: a reprocess rewrites every table of each ledger, and one pass serves every parser version, which is far cheaper than one
   per feature. Read [Which node?](#2-which-node) and use a node of your own. After a failure do
   not rerun the same command (see [Resuming](#resuming-gap-repair-reprocessing)). Ledgers that are not committed yet (a new database filled
   below the live start) need no `--reprocess`.
3. **The aggregates follow by themselves, in three queues.** Every written chunk marks its hours in `agg_dirty`, and its slice's hook appends
   the ledger range to `nft_dirty` (the hook rebuilds no NFT). The `nft_state` job works through the oldest range of `nft_dirty` in steps of
   10,000 ledgers within its 3 s a tick: **watch `syncer_nft_dirty_ledgers` fall to 0** (`SELECT * FROM xrpl.nft_dirty` shows the ranges), and
   `syncer_nft_state_lag_ledgers` stay near 0. A restart of the syncer while this runs adds the stretch from the oldest NFT not rebuilt yet to the
   head to `nft_dirty` once more ([operations](operations.md#the-nft-data)): avoid restarts until it is 0. The collections it rebuilt are queued for `nft_collections`: **its first fill is
   first in, first out, one 3 s run every five minutes**: plan on about 150 collections every five minutes for XRPL's large ones (batches of 50 that
   take a second; small collections go thousands to a run, as on Xahau), and `syncer_nft_collections_pending` falls. A collection that changes
   meanwhile waits behind the fill, so after a rollout collection pages update slowly until it has drained (days on XRPL). The daily
   `nft_volume` sets are filled by `volume_backfill` (the stats and the other volumes' sets are recomputed with the slices as always).
4. Check the coverage:

   ```sql
   -- the NFT data cover the ledgers above this one (NULL: every stored ledger); `complete` once this is below the enable ledger
   SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 5;
   -- which parser wrote a range
   SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 75443457 GROUP BY parser_version;
   -- the ranges the aggregator has still to rebuild the NFTs of (syncer_nft_dirty_ledgers is their size)
   SELECT from_ledger, to_ledger FROM xrpl.nft_dirty ORDER BY from_ledger;
   ```

   (Xahau: `xahau.ledgers`, `WHERE ledger_index >= 1`; on the sandbox the databases are `xrpl_testnet.` and `xahau_testnet.`.) The API keeps the
   coverage for a minute (`FEATURE_COVERAGE_CACHE_MS`). It also needs the enable ledger of the amendment, which the API reports only for an amendment that the node's
   ledger state lists as enabled: the `validators` worker polls that state into `network_state` (the ledger itself is the indexed `EnableAmendment` transaction,
   which the re-ingest brings in, or, on a mainnet, the amendment metadata file). A deployment without that worker reads its amendments as `voting` and never says
   `complete`.
5. **The testnets** (XRPL Testnet, Xahau Testnet) get no backfill: their index starts at the validated head of their deployment's first boot, and
   their NFT answers stay `complete: false`.

### Account domains seed

`PARSER_VERSION` became 6 with the Domain of accounts (`DOMAIN_PARSER_VERSION`, [ADR-0017](adr/0017-display-names.md)): from the deploy on, the
live syncer writes an `account_domains` row for every change of an account that has a Domain. The ledgers written before it have none, and
without more **no account would have an account domain, and so no verified name, until it next changed**. The state history already holds each
account's Domain (`account_states.fields`), so the operator **seeds** the table from it, once per network, instead of reprocessing the history: the
seed copies the newest state row of every account that has a Domain, in 16 buckets of accounts (`cityHash64(account) % 16`) so that the `GROUP BY account`
of one statement stays within memory. **No reprocess is needed for D4**, and `domain_tomls` needs no backfill: the `tomls` worker's first sweep fills it.

**When.** After migration `012_display_names.sql` is applied and the syncer of this release is running ([the rollout](operations.md#the-display-names)): from
then on every new ledger is written by parser version 6 or later, so `X` stops moving, and no change falls between the seed and the live rows. Before it, the old
parser would go on writing ledgers that have no `account_domains` rows.

**`X`** is the last ledger an older parser wrote: the seed reads the state history up to it, and the ledgers above it are the parser's own.

```sql
SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 6;
```

(NULL, `\N` in the client: every stored ledger was written by parser version 6 or later, and there is nothing to seed.)

**The statement**, run once for each `bucket` from 0 to 15, with `X` and `bucket` as query parameters:

```sql
INSERT INTO account_domains (account, ledger_index, tx_index, node_index, version, domain_hex, deleted)
SELECT account, top.1, top.2, top.3,
       bitOr(bitShiftLeft(toUInt64(top.1), 32), bitOr(bitShiftLeft(toUInt64(top.2), 16), toUInt64(top.3))), hex, 0
  FROM (SELECT account,
               argMax((ledger_index, tx_index, node_index), (ledger_index, tx_index, node_index)) AS top,
               argMax(JSONExtractString(fields, 'Domain'), (ledger_index, tx_index, node_index)) AS hex,
               argMax(deleted, (ledger_index, tx_index, node_index)) AS gone
          FROM account_states
         WHERE ledger_index <= {X:UInt32} AND cityHash64(account) % 16 = {bucket:UInt8}
         GROUP BY account)
 WHERE hex != '' AND gone = 0
```

**Running it.** For example, with the statement saved as `account-domains-seed.sql`, from the repo root, `dc` as in [operations](operations.md) (the container's
own environment authenticates, the password stays off the host command line):

```bash
ch() { dc exec -T clickhouse sh -c 'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" "$@"' sh "$@"; }
X=$(ch -q "SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 6")
if [ "$X" = '\N' ] || [ -z "$X" ]; then echo 'nothing to seed: every ledger was written by parser version 6 or later'; else
  for bucket in $(seq 0 15); do ch --database xrpl --param_X="$X" --param_bucket="$bucket" < account-domains-seed.sql || break; done
fi
```

The guard matters: with `X` NULL (`\N`) every statement would fail on its `UInt32` parameter, sixteen times. On Xahau use `xahau.ledgers` and
`--database xahau`; on the sandbox `xrpl_testnet` and `xahau_testnet`.

**What it costs.** Each bucket reads the whole of `account_states` up to `X` (the bucket is a condition on a hash of the account, not a range of the key),
the `fields` column included, so the seed reads that table **16 times**; only the `GROUP BY` of one bucket's accounts is held in memory. **Time one bucket on
the sandbox first** (and watch its memory in `system.query_log`) to know how long the sixteen take on a mainnet.

**Checking it.** The accounts that have a domain now (a deleted account and an empty Domain are not one), which is what the discovery of the `tomls` worker finds:

```sql
SELECT count() FROM (SELECT account, argMax(domain_hex, version) AS hex, argMax(deleted, version) AS gone FROM xrpl.account_domains GROUP BY account)
 WHERE hex != '' AND gone = 0;
```

Then watch `syncer_tomls_domains` and `syncer_tomls_due` ([observability](observability.md#4-metrics-syncer)): the worker discovers the seeded domains within five
minutes, and its first sweep reads their tomls at about 300 domains a minute.

How the seed behaves:

- **The seed's row sits on the account's newest state row at or below `X`**: its `ledger_index`, `tx_index` and `node_index`, and the `version` the parser
  gives that row. So a later `--reprocess` of that ledger deletes it and the parser writes the same row back.
- **It is safe to run twice**, or again for one bucket after a failure: the same rows are inserted again, and the row with the largest `version` of an
  account is its current Domain either way (readers take `argMax(domain_hex, version)`, never `FINAL`). An account without a Domain and a deleted account get no row.
- **Run it again after a rollback.** A syncer of an older release writes no `account_domains`: when this release is deployed again after one ran, the
  ledgers it wrote have no rows, and `X` has moved to the last of them. The seed with the new `X` fills them (the newest row of an account wins).
- **It agrees with the parser.** The shared e2e writes recorded ledgers, sets the parser's rows aside, seeds from `account_states` and compares the newest
  row of every account: the same Domain on the same (ledger, tx, node), and no row for an account without a Domain.
- **Coverage.** The seed is as good as `account_states`: the state tables start at the first ledger parser version 3 wrote
  ([Account state history re-ingest](#account-state-history-re-ingest)), and an account whose Domain was set before that and whose root has not changed since has no
  row. It has **no domain, and so no verified name, until its next change** (a payment received is enough), or until the history is filled from ledger 32570
  and ingested again with parser version 6 or later. The names answer carries no `coverage` for this ([api-reference](api-reference.md#account-names-and-tomls)).

### Ledger objects and delegation re-ingest

`PARSER_VERSION` became 7 with the ledger objects (`OBJECT_PARSER_VERSION`, [ADR-0018](adr/0018-ledger-object-history.md)). From the deploy on, the live syncer writes
the history of every escrow, check, payment channel and delegation (`object_changes` and its index by account `account_object_changes`), lists a delegate in its
own `account_transactions`, books the fee of a delegated transaction to its delegate, and types the balance changes of issued-token payment channels. The ledgers written
before it have none of that, so **the objects they created are not in the index, and the fee rows of the delegated transactions in them are the sender's**. Both
networks have escrows, checks and payment channels; only the XRP Ledger has delegation.

**Where to start.** Each feature has the ledger from which no object can be missing, and its `coverage` is `complete` when the index is whole from there
([Coverage](api-reference.md#coverage)):

| Feature | XRPL | Xahau |
| --- | --- | --- |
| Delegations (`PermissionDelegationV1_1`) | **107,524,865** (2026-10-08) | none: the network cannot have it, `complete: true` with no table read |
| Escrows (`Escrow`) and payment channels (`PayChan`) | 28,685,313 | **1**, the first ledger of the network (no amendment: `Escrow` and `PayChan` are retired there) |
| Checks (`Checks`) | 56,219,905 | **1**, as above |

**Delegation is the re-ingest this release asks for.** It is short because the amendment is recent: `--from 107524865` is about 415,000 ledgers on 2026-10-28, and about
20,800 more a day. **Escrows, checks and channels are not part of it**: their coverage stays `complete: false` until every ledger from 28,685,313 (checks:
56,219,905; Xahau: 1) is written by parser version 7 or later, which is **the program's one reprocess after its last parser version**, or the history load from ledger
32,570 ([Account state history re-ingest](#account-state-history-re-ingest)), and no part of D5 does it. Until then **an object created before the first ledger the new
parser wrote and untouched since is not in the index**: its route answers 404 and the explorer shows it from the node; one created before it and changed after it has a
history that starts in the middle, with no `created`, and says `complete: false`.

**Procedure.**
1. Apply migration `013_ledger_objects.sql` **before** the syncer of this release starts: the syncer writes the two ledger tables with every ledger, and a write to a
   missing table fails the batch, so the live runner would retry it for ever ([operations](operations.md#apply-a-schema-migration)). Then deploy the syncer, then the api.
   A Xahau syncer that is **halted on a ledger with an issued-token payment channel** (the old parser threw on it: `Cannot parse ledger <n>`, `state=halted`) goes on from
   its checkpoint when this release is deployed (a restart), because the ledger parses now: no other step is needed for it.
2. On the XRP Ledger, re-ingest the committed history from the amendment's enable ledger up to the ledger the syncer started writing parser version 7 at (the deploy
   ledger) with `--reprocess`:

   ```bash
   # the deploy ledger, the first one the new syncer wrote: SELECT min(ledger_index) FROM xrpl.ledgers WHERE parser_version >= 7
   docker compose -f docker-compose.prod.yaml --env-file deploy/.env.prod run --rm --no-deps syncer-xrpl \
     node dist/cli/range-ingest.js --from 107524865 --to <deploy ledger> --reprocess --concurrency 16
   ```

   `--to` is inclusive, and rewriting the deploy ledger writes the rows its version-7 parser wrote already. It is hours on Ripple's full-history node
   ([Which node?](#2-which-node)). After a failure do **not** rerun the same command (see [Resuming](#resuming-gap-repair-reprocessing)). If the program's full reprocess is
   about to run, it covers this range, and running both writes these ledgers twice, which does no harm.
   It writes the `Delegate` rows, the delegates' `account_transactions` rows, the fee rows of the delegated transactions on their delegates and the object rows of
   escrows, checks and channels for these ledgers. Xahau has no delegation: nothing is re-ingested there for it.
3. **The aggregates follow by themselves, all of them.** Every written chunk marks its hours in `agg_dirty`, so the reprocess queues its whole range: the days since
   the amendment (2026-10-08), about 20 of them on 2026-10-28. `stats_dirty` drains it a slice (at most a day) at a time, and **every aggregate's dirty work runs for
   those days**, although only the rows of the delegated transactions changed: `stats_hourly` and the daily volume sets of each day, the AMM pools with a state row in
   the slice and the `amm_daily` sets of its days, the rates of its days and of the 14 days after them (marked stale, then computed again), its hours of
   `pair_hourly`, the day rollups of the heavy accounts, the ledgers marked in `nft_dirty` (the dirty sweep of `nft_state` then rebuilds every NFT touched in those
   days), **the `escrows` hook**, which recomputes the escrows of the slice's ledgers as of the job's watermark and reads the total again if one changed
   ([syncer](syncer.md#the-escrows-job)), and, last, **the `tokens` hook**, which marks the slice for the repair of the generations of the issued tokens (the next run of the `tokens` job applies the
   touches of those ledgers again; [syncer](syncer.md#76-the-agg_dirty-hooks)). Until a slice is drained its hours show the old numbers. Watch the queue drain (only `range-ingest` adds to it):

   ```sql
   SELECT count() FROM xrpl.agg_dirty;
   ```

   The `escrows` job itself builds its table from the rows there are, in steps of 1,000,000 ledgers, until **`syncer_escrows_lag_ledgers` is a few ledgers**
   ([operations](operations.md#ledger-objects-and-delegation)).
4. Check the coverage:

   ```sql
   -- the object data cover the ledgers above this one (NULL: every stored ledger); delegations are `complete` once this is below 107,524,865
   SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 7;
   -- which parser wrote a range
   SELECT parser_version, count() FROM xrpl.ledgers WHERE ledger_index >= 107524865 GROUP BY parser_version;
   -- the rows the new parser has written so far, by type
   SELECT object_type, count() FROM xrpl.object_changes GROUP BY object_type;
   -- the sentinel of the escrows job: the open native escrows, their drops and the ledger it is as of
   SELECT open_count, amount_drops, through_ledger FROM xrpl.escrows WHERE escrow_id = '' ORDER BY version DESC LIMIT 1;
   ```

   (Xahau: `xahau.ledgers`, from ledger 1; on the sandbox the databases are `xrpl_testnet.` and `xahau_testnet.`.) The API keeps the coverage for a minute
   (`FEATURE_COVERAGE_CACHE_MS`). It also needs the enable ledger of the amendment, which it reports only for an amendment that the node's ledger state lists as
   enabled (`PermissionDelegationV1_1`: the `validators` worker polls that state into `network_state`); a deployment without that worker never says `complete`.
5. **The testnets** (XRPL Testnet, Xahau Testnet) get no backfill: their index starts at the validated head of their deployment's first boot, and their object answers stay
   `complete: false` (the delegations of Xahau Testnet are `complete: true`, as on Xahau).

How it behaves:

- **What a reprocess changes in the books.** A delegated transaction in the range gets its `transaction_cost` row on the delegate (and none on the sender), the source
  columns of `payments` and `path_payments` stop adding the fee back to a sender who did not pay it, `payments.destination_balance_changes` adds it back to a delegate
  that is the Payment's `Destination` (a sweep to itself: what arrived, with no native change for a token payment to it), and the delegate lists the transaction. The
  balance changes, stats, reports and analytics of the accounts concerned are different from before for those ledgers, and the rollups follow through `agg_dirty` ([operations](operations.md#what-a-re-ingest-does-to-them)).
- **Changes the table does not expect** (an object of a tracked type changed by a transaction no event of its type covers) are written as event `update` and counted
  in `syncer_objects_unclassified_total`; the range-ingest log warns with the total of its run and its last line ends with `L unclassified object changes`.
- **The reprocess of a range that is already version 7** deletes and writes its rows again, in both tables, like every child table; the `escrows` hook then recomputes
  the escrows of the range, so an escrow whose rows a reprocess made vanish is removed from the aggregate.

### Issued tokens re-ingest

`PARSER_VERSION` became 8 with the touch index of the issued tokens (`TOKEN_PARSER_VERSION`, [ADR-0019](adr/0019-issued-tokens-from-state-history.md)). From the deploy on, the live syncer writes `state_touches`: a row for
each trust line a transaction created, deleted or changed and for each issuer whose flags, transfer rate or domain changed (or that sent an `AccountSet`), in the order of the ledgers. The ledgers written before it
have none. Both networks have the data: the XRP Ledger's trust lines and Xahau's.

**The aggregate of the issued tokens needs no re-ingest.** The `tokens` job builds its first generation from `trust_line_states` as it is (the account pass), and needs the touches only above the ledger the
generation was built at. What decides how much of the history the tokens show is the **state tables**, not this parser: the `coverage` of `/v2/tokens`, `/v2/tokens/{currency}.{issuer}` and `/holders` is the feature `issued_tokens`,
which starts at the first ledger of the network (32,570 on the XRP Ledger, 1 on Xahau) and is `complete` when every ledger from there is written by parser version 3 or later, the
[account state history](#account-state-history-re-ingest) back to its first ledger. The transfers (`token_transfers`) are payments, which every stored ledger has.

| | XRPL | Xahau |
| --- | --- | --- |
| Coverage of the tokens starts at | **32,570**, the first ledger | **1**, the genesis |
| Fill the state tables with | `--from 32570` | `--from 1` (`--concurrency 1` on the public node) |

**What a re-ingest does to the tokens.**
- **Filling the state tables further back** moves the state coverage start, and the job builds a **new generation** by itself (its `coverage_from` is no longer the start): the pass over the wider
  `trust_line_states`, an hour to a few hours, with the live generation serving until it is promoted ([operations](operations.md#issued-tokens)). **Do not fill the history while the first generation is
  building**: the job compares the coverage start with the one a generation was built on at every housekeeping (about every ten minutes; the promotion does not check it, so a build that finishes in between is promoted and
  replaced at the next one), and retires a building generation whose start has moved (the oldest stored ledger when no ledger of a parser older than 3 is stored, else one above the newest of them) and starts another
  from the first account. A fill that keeps writing ledgers below the oldest stored one (a single ascending `--from/--to` run moves the start once, at its first chunk; a fill from the top down moves it with every chunk)
  therefore restarts a first build every ten minutes until it ends; finish the fill first, or expect the restarts (the log says `tokens: generation N was stale while it built; it is retired`). Only the building
  generation restarts: the live one keeps serving.
- **A `--reprocess` of a range** writes the touches of its ledgers, as for every table, and marks its hours in `agg_dirty`. Each slice's **`tokens` hook**, the last of the hooks, lowers the `repair_from` of the live and the
  building generation to the slice's first ledger, and the job applies the touches of `[repair_from, through_ledger]` again, 500 ledgers a window, reading the state at `through_ledger` (a line changed in the range
  and again later keeps its later state). A window that meets a ledger written by an **older parser** (one without touches) ends the repair and marks a **rebuild**: a new generation is built from the state
  tables beside the live one and swapped in, which is how the **program's one reprocess**, over the whole history after its last parser version (about **108 million ledgers, 216,000 windows of 500**), reaches the tokens.
  The rebuild is an hour to a few hours, once at a time; expect more than one while a reprocess runs from the oldest ledger up, because the repair keeps reaching ledgers not yet reprocessed ([operations](operations.md#issued-tokens)).
- **The testnets** get no backfill, and their tokens stay `complete: false`.

**Prerequisites for the listing.** A token is `listed`, and has a `domain`, only when the issuer's account domain is known and its toml was read: seed `account_domains` from the state history first
([Account domains seed](#account-domains-seed)) and let the `tomls` worker make its first sweep ([operations](operations.md#the-display-names)), or the tokens are built with no domain and no listing, and the job's
toml sweep corrects them as the domains are read.

Check the coverage and the build:

```sql
-- the state tables cover the ledgers above this one (NULL: every stored ledger)
SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 3;
-- the touches exist from this ledger on (the ledgers below it were written before parser version 8)
SELECT maxOrNull(ledger_index) FROM xrpl.ledgers WHERE parser_version < 8;
-- the generations of the issued tokens (building, live, retired) and how far each is
SELECT generation, argMax(state, version) AS state, argMax(through_ledger, version) AS through_ledger, argMax(repair_from, version) AS repair_from
FROM xrpl.token_generations GROUP BY generation ORDER BY generation;
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
