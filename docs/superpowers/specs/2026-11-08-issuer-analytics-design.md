# Issuer analytics: design

Status: proposed (2026-11-08). Issue [GateHubNet/data-api#28](https://github.com/GateHubNet/data-api/issues/28). Repository `GateHubNet/data-api`, branch
`feature/issuer-analytics`, on `master` e6b445b. The storage decision is [ADR-0021](../../adr/0021-token-history-in-clickhouse.md).

- **Builds on:**
  - ADR-0015's state history: `trust_line_states` (migration 006) and `account_states` (005).
  - D6's issued tokens (ADR-0019): `state_touches`, the shared rules of `token-rules.ts` (`countsFor`, `orientations`), the generation pattern of `token_generations`, `touchesOfWindow`, `stateCoverageStart`, and the route `GET /v2/tokens/{currency}.{issuer}/holders`.
  - D9's MPT data (ADR-0020): `mpt_holder_states`, `mpt_touches`, the issuance ID as the asset, integer units.
  - D2's `pair_hourly` (ADR-0013).
  - D3's `FeatureCoverageService`.
  - The exact decimals of `query/decimal.ts`.
- **Fills the gap ADR-0019 left:** "No supply or holders history is kept (a daily statistics job, deferred)", and ADR-0010 item 102.

## Intent

What the owner asked for (issue #28 and the brainstorming of 2026-11-08):

- **The outcome.** One exact, reproducible source for how a token is doing: its supply, holders, distribution and flows, for every issued token and
  MPT, at the head (seconds after a ledger closes) and at any ledger in the indexed history.
- **Who it is for, in order.**
  1. GateHub compliance and finance: the EURGH monthly MiCA reporting and the reserve attestations.
  2. Other MiCA EMIs and issuers on the XRP Ledger, the paying customers.
  3. Exchanges and analytics vendors.
  4. The explorer's token pages.
- **Success.**
  - The EURGH monthly report is produced from these endpoints with no manual reconciliation.
  - The numbers match an independent recomputation from the ledger for a sample of tokens and ledgers.
  - An external issuer uses them within a quarter of launch.
- **Constraints the owner set.**
  - Exactness over speed: no sampling, no HyperLogLog. Approximation is allowed only on the explorer-facing summary, and flagged there; this design needs none.
  - Amounts are strings end to end (BigNumber), never JS numbers.
  - Full history from the network's first ledger, with the backfill cost estimated and the backfill resumable.
  - Reuse the existing balance derivation from `AffectedNodes`; do not build a second one.
  - Every endpoint has an OpenAPI entry and an Ajv response schema.
  - Pagination and errors follow the v2 conventions.
- **Assumed here** (not said by the owner):
  - The feature runs on every network that has issued tokens: XRPL, Xahau and the testnets.
  - MPTs are covered where the network has them.
  - Coverage follows the state tables.

## Owner decisions (2026-11-08)

| # | Question | Decision |
|---|---|---|
| 1 | The brief put derived tables in Postgres, but the system has no Postgres: all 85 tables, derived ones included, are in ClickHouse, and `data-model.md` and the migrations agree. | **ClickHouse**, with the case made in ADR-0021. |
| 2 | `GET /v2/tokens/{token}/holders` already exists (D6) and the explorer reads it. | **Extend it in place.** Same path, keys and order; it adds a ledger, first and last activity, MPT IDs and an exact marker, and reads the new tables once they are built (§5.5). |
| 3 | The EURGH report may need the issuer's own wallets left out of supply. | **`exclude=` parameter.** The caller names addresses, and the answer adds the figures without them. Nothing about whose wallets they are is stored, so entity attribution stays a non-goal. |
| 4 | Approach. | **A:** a new syncer worker writes a token-ordered change log with checkpoints and hourly rollups from the state history. Rejected: writing the change log in ingest (a parser version and a node-bound reprocess of ~108M ledgers), and daily full snapshots (a snapshot between days scans an issuer's whole history; storage grows with lines × days). |
| 5 | Sections 1 to 4 of the design. | Approved as presented. They are §§2 to 11 below. |
| 6 | The deployment runs the api and a syncer that follows the head, and the owner fills the history with `range-ingest`. A build started by the worker on its own would run on a history that a fill is still changing. | **The build is an operator command**, `token-history-build`, run like `range-ingest` once the fill is done. The worker only follows the head and repairs, and says when a build is needed (§4.6). |

Decided here and open to the owner's correction: the checkpoint floor (50,000), the limits of `exclude` (20 addresses), of `/flows` (366 days, hourly at most
31) and of `interval=ledger` (100,000 ledgers); the snapshot `digest`; and the change of D6's holders marker (§5.5). See §14.

## Scope and non-goals

In scope: the seven routes of the issue (§5), the tables, the worker and the build command that feed them (§§2 to 4), and the build of their history from the network's first ledger.

Not in v1, as the issue says:
- fiat valuations and market cap, which need a price oracle;
- entity attribution, that is, saying who an address belongs to;
- AMM pool analytics (a pool is an ordinary holder here, and its swaps are exchanges);
- alerting and webhooks.

Also not in v1: frozen or locked amounts as series of their own (a snapshot row carries `frozen`), Xahau MPTs (Xahau has none), and any read of a node.

## 1. Definitions

The glossary's terms (**token**, **issued token**, **MPT**, **issuer**, **holder**, **supply**, **outstanding amount**, **trust line**,
**transfer**) hold. The terms below are new to the glossary; the docs PR adds them (§12).

- **Token side of a line.** A `trust_line_states` row is the state of a line from its `account`'s side. For the token
  `(currency, account)` of that row, the holder is `counterparty`, the issuer-side balance is `balance` and the holder's limit is `limit_peer`. The line
  **counts** when `countsFor(balance, limit_peer)` holds and the row is not `deleted`. LP currencies count for nothing (`isLpCurrency`).
  - The holder's **amount** is `-balance` when the line counts, else `0`.
  - The line's `limit` is `limit_peer`. `frozen` and `authorized` are the issuer side's `freeze` and `authorized`.
  - This is the second element of `orientations()` applied to the row. Both sides' rows exist for every change, so the two rows give the line's two tokens, as `orientations()` does from the low side.
- **Token side of an `MPToken`.** For the MPT `(issuance ID, issuer of the ID)`, the holder is `holder`. The amount is `amount + escrowed_amount` (ADR-0020's balance), with
  `escrowed` its escrowed part. The entry counts while it is not `deleted`. `frozen` is the holder's `lsfMPTLocked`, `authorized` its `lsfMPTAuthorized`, and `limit` is `''`.
- **Holder** (glossary): a counting line or `MPToken` with an amount above 0. **Trust lines** of a token: its counting lines, zero amounts included (for an MPT,
  its `MPToken` entries). **Supply**: the sum of the holders' amounts. For an MPT this is its outstanding amount, and the tests check it equals the issuance's
  `outstanding_amount`.
- **Change.** One row of the change log: a node of a transaction that changed a line's or an `MPToken`'s state for a token, where the line counted before
  or after. It has `amount_before` and `amount_after`.
- **Flows of a transaction**, per token. `net` is the sum over the transaction's changes of `amount_after − amount_before`.
  - A `Clawback` or `AMMClawback` transaction is **clawed back** by `max(−net, 0)` and **issued** by `max(net, 0)`.
  - Any other transaction is **issued** by `max(net, 0)` and **redeemed** by `max(−net, 0)`. A transfer fee is redeemed supply: the issuer's obligation falls by it.
  - It is **transferred** by `Σ max(change, 0) − max(net, 0)`: what moved from holder to holder. It counts as one **transfer** when that is above 0.
  - So over any range, `supply_end − supply_start = issued − redeemed − clawed_back`, exactly.
  - A change whose before-state is not known (`before_known = 0`, §2.1) is in the levels and in no flow.
- **Exchanged.** The token's amounts in the `exchanges` rows (order-book trades and AMM swaps, as ADR-0011 stores them), on whichever side of the pair it
  is. **Trades** is the count of those rows.
- **First and last activity.** For a holder of a token, the ledger of its first change where the line counted (`first_ledger`) and of its newest change
  (`last_ledger`). For a token, the ledgers of its first and newest change.
- **Token history**: the derived data of this design, one **generation** at a time. **Checkpoint**: the full set of a token's counting lines at the end of a
  ledger.

## 2. Data model: migration `019_token_history.sql`

Number 018 is taken by the destination-tag PR (#26). The migration is seven `CREATE TABLE IF NOT EXISTS` statements, nothing else. It is additive and reads no
other table.

None of the seven is a ledger table: none is in `CHILD_TABLES` or `LEDGER_KEYED_TABLES`, so ingest recovery and the retention never delete from them. Every table but
`token_hourly_dex` and `token_history_dirty` carries `generation` (§4.6). The four **generation tables** (`token_holder_changes`, `token_checkpoints`,
`token_checkpoint_heads`, `token_hourly`) are partitioned by it, and `token_history_state` is keyed by it. The change log and the checkpoints are partitioned by `(generation, intDiv(<ledger>, 10000000))`, so a retired generation drops as partitions
and a repair deletes inside one partition. Amounts are exact decimal text: issued tokens as the ledger writes them, MPTs as integer units, never scaled.
Readers never use `FINAL`.

### 2.1 `token_holder_changes`: the change log

`ReplacingMergeTree`, `PARTITION BY (generation, intDiv(ledger_index, 10000000))`,
`ORDER BY (issuer, currency, ledger_index, tx_index, node_index, holder)`, `non_replicated_deduplication_window = 1000` (a retried insert must not count twice).

| Column | Type | Meaning |
|---|---|---|
| `generation` | `UInt32` | §4.6 |
| `issuer`, `currency` | `String`, `LowCardinality(String)` | The token. An MPT: the issuance ID and its issuer. |
| `ledger_index`, `tx_index`, `node_index` | `UInt32`, `UInt32`, `UInt16` | The node of the change. One node can be a change of two tokens, and `holder` keeps their keys apart. |
| `holder` | `String` | |
| `close_time` | `DateTime('UTC')` | |
| `clawback` | `UInt8` | 1 when the transaction is a `Clawback` or `AMMClawback`. |
| `amount_before`, `amount_after` | `String` | The holder's amount before and after, `'0'` when the line does not count. |
| `counted_before`, `counted_after` | `UInt8` | |
| `before_known` | `UInt8` | 0 when the line's first state row in the coverage is not its creation, so its earlier state is unknown (the coverage is incomplete). |
| `limit`, `frozen`, `authorized`, `escrowed` | `String`, `UInt8`, `UInt8`, `String` | The state after, from the token's side (§1). `escrowed` is `'0'` for an issued token. |
| `order_exp`, `order_mant` | `Int16`, `UInt64` | The order key of `amount_after` (§3.4). |

A row exists for every change where `counted_before = 1 OR counted_after = 1`.

### 2.2 `token_checkpoints` and `token_checkpoint_heads`

`token_checkpoints`: `ReplacingMergeTree`, `PARTITION BY (generation, intDiv(checkpoint_ledger, 10000000))`,
`ORDER BY (issuer, currency, checkpoint_ledger, holder)`.
- One row per counting line of the token at the end of `checkpoint_ledger`, with the holder's state: `amount`, `escrowed`, `limit`, `frozen`,
  `authorized`, `order_exp`, `order_mant`, `first_ledger` and `last_ledger`.

`token_checkpoint_heads`: `ReplacingMergeTree`, `PARTITION BY generation`, `ORDER BY (issuer, currency, checkpoint_ledger)`.
- One row per checkpoint: `supply`, `holders` and `trust_lines` (`UInt64`), `changes_since` (the changes since the previous checkpoint), and the token's
  `first_ledger`.
- The head is written **after** the checkpoint's rows. It is the checkpoint's commit marker: a reader reaches rows only through a head.
- A token with no head at or before N has an empty, implicit checkpoint at 0.

### 2.3 `token_hourly`

`ReplacingMergeTree(version)`, `PARTITION BY (generation, toYear(hour))`, `ORDER BY (issuer, currency, hour)`.
- One row per token and UTC hour that has a change. The hour is that of the ledger's `close_time`.
- **Levels** at the end of the hour: `supply` (text), `holders`, `trust_lines`. "The end" is the newest ledger of the hour the row covers: the hour's last ledger
  once `final = 1`, else `through_ledger`.
- **Flows** in the hour: `issued`, `redeemed`, `clawed_back`, `transferred` (text), `transfers`, `changes`, `unknown_before` (`UInt32`).
- The hour's `first_ledger` and `last_ledger`, `final` (`UInt8`), and `version` (the writer's clock in milliseconds, above the key's newest).
- A row is written whole; readers keep the newest `version` of each key (`LIMIT 1 BY`).

### 2.4 `token_hourly_dex`

`ReplacingMergeTree(version)`, no generation (it depends on neither the state coverage nor the token rules), `PARTITION BY toYear(hour)`,
`ORDER BY (issuer, currency, hour)`.
- Per token and hour with trades: `exchanged` (text) and `trades`.
- **The hour's sentinel** (`issuer = ''`, `currency = ''`) is written after the hour's rows, so a missing row means no trades only when the sentinel exists. It carries
  `config_version`.
- How far the DEX data reach is the newest sentinel hour of the unbroken run, read from the sentinel prefix.

### 2.5 `token_history_state` and `token_history_dirty`

`token_history_state`: `ReplacingMergeTree(version)`, `ORDER BY generation`, as `token_generations`. It holds one row for every change of a generation:
- `state` (`building`, `live`, `retired`) and `config_version` (`TOKEN_HISTORY_CONFIG_VERSION`, 1);
- `coverage_from` (§4.6), `h0` (the commit marker when the build started) and `h1` (the ledger the build's levels are made up to);
- `phase` (`changes`, `mpt_changes`, `levels`, `dex`, `done`), with the cursors `account_cursor`, `token_cursor_issuer`, `token_cursor_currency`;
- `through_ledger` (every change up to it is written), `levels_through` (every level and checkpoint up to it is written), `started_at`, `changed_at`, `version`.

**`through_ledger` and `levels_through` are the token history's commit marker.** In a live generation the two are equal: no reader reads past them, and the worker
writes them last in every window. A building generation's `levels_through` lags until the worker has caught its levels up (§4.6).

`token_history_dirty`: `(from_ledger, to_ledger, created_at)`, `ReplacingMergeTree(created_at)`, `ORDER BY (from_ledger, to_ledger)`, as `nft_dirty`.

### 2.6 Size on XRPL (estimates; PR 1 measures them, §9)

| Table | Rows | Disk |
|---|---|---|
| `token_holder_changes` | 1 to 3.5 billion: 10 to 31 counting line changes a ledger over ~108M ledgers (31 is today's rate, from operations "Measured on synthetic data"; earlier years have fewer) | 60 to 90 bytes a row: 60 to 300 GB |
| `token_checkpoints` | At most the change log's rows, by the rule of §4.3; in practice far fewer, since most tokens never reach 50,000 changes | — |
| `token_hourly` | 50 to 200 million (active token-hours) | 4 to 16 GB |
| `token_hourly_dex` | Under `token_hourly` | Small |

During a rebuild a second generation exists (§4.6), which doubles the generation-scoped tables until the old one is dropped.

## 3. Reads

### 3.1 Holders at a ledger N (`holdersAt`)

Every holder read is the same read, at the head and at a historical N (`packages/shared/src/token-history/holders-at.ts`, used by the api and the worker):

1. `cp = max(checkpoint_ledger)` of the token's heads with `checkpoint_ledger <= N`, or 0. This is a prefix read of the small heads table.
2. `cp`'s rows `UNION ALL` the token's changes in `(cp, N]`.
   - Each source is first deduplicated in a capped inner read (`LIMIT 1 BY` its key, ADR-0003).
   - The rows are then grouped by `holder` with `argMax` of the state by `(ledger_index, tx_index, node_index)`; a checkpoint row ranks as `(cp, 0, 0)`.
   - The lines that count are kept.
3. `first_ledger` is the checkpoint's or else the first counting change in the range. `last_ledger` is the newest change.

**Bound:** at most `lines(cp) + max(lines(N), 50,000) + one ledger's changes` rows, about `2 × max(lines, 50,000)`, wherever N is.

### 3.2 Totals at N, without the fold

- `supply` is the head's `supply` plus `Σ(amount_after − amount_before)` over the changes in `(cp, N]`.
- `holders` and `trust_lines` are the head's counts plus the sums of `(amount_after > 0) − (amount_before > 0)` and `counted_after − counted_before`.
- These read only the changes, so a list of an issuer's tokens never folds.

### 3.3 Exact sums

- Sums in SQL use `Decimal256(30)` through `exactAmount`'s rule, and count the amounts it cannot hold (`unfit`).
- When a sum has `unfit > 0`, the same bounded rows are streamed into BigNumber and summed there.
- A Float64 sum is never served, unlike D6's `sumOf`. The helper `exactSum` lives beside `sumOf` in `query/decimal.ts`, and the metric `syncer_token_history_unfit_sums_total` and the api log count the BigNumber path.

### 3.4 The order key

- Holder balances of an issued token are ledger `STAmount`s: a mantissa of 16 digits and an exponent from −96 to 80. The order key of an amount above 0 is
  `(exponent, mantissa)` with the mantissa normalised to `[10^15, 10^16)`; of 0 it is `(−32768, 0)`. An MPT amount (an integer below 2^64) is `(0, amount)`.
- One SQL expression (for the build's `INSERT … SELECT`) and one TypeScript function (for the live writes) compute it. A property test pins both against
  BigNumber's comparison.
- A text the key cannot hold (more than 16 significant digits, which a ledger balance cannot have) fails the write and is counted.
- Holders are ordered by the key, then by `holder`, so the order is exact and the marker carries the balance as text.

### 3.5 Windows of time

- A window `[t0, t1]` resolves to ledgers through `LedgerRangeResolver`.
- Its flows are the `token_hourly` rows of the hours wholly inside it, plus the change log of the two partial edge hours (at most two hours of the token's
  changes). The 24 h, 7 d and 30 d figures are therefore exact.
- DEX figures come only from `token_hourly_dex`'s whole hours (§5.2).

## 4. The worker: `token_history`

Two writers share the seven tables, each with its own part of them:

- **The worker `token_history`**, the seventh syncer worker, in `GH_WORKERS` and on by default. It needs no node, and it **follows the head**: the live
  windows, the repairs, catching a finished build's levels up to the head, and the promotion. It never starts a build. Its code is in `apps/syncer/src/token-history/`.
- **The command `token-history-build`**, in the syncer image beside `range-ingest`. It does **the build**: the heavy one-off work of a new generation (§4.6). It runs
  only when the operator starts it, with the syncer running.

Their rules and reads are in `packages/shared/src/token-history/`.

### 4.1 The worker's loop

- Every `TOKEN_HISTORY_POLL_MS` (1 s) it reads the commit marker.
- If a ledger was committed since `through_ledger`, it applies the live windows (§4.2) until it has caught up. Then it spends what is left of `TOKEN_HISTORY_PASS_BUDGET_MS` (1 s) on one
  step of the repair (§4.7) or of a finished build's catch-up (§4.6): the live window always comes first.
- Its work is a few small reads and inserts per ledger. It has its own loop and budget, so the aggregator's 17 jobs and their 30 s tick are unchanged.
- A step is never cut once started (as in the tokens job), and a shutdown waits at most 2 s for the step in flight.
- It holds a `syncer_lease` row named `<network>:token_history`, so two workers never run against one database.

### 4.2 The live window

1. **The window.** `(through_ledger, to]` from `touchesOfWindow` (reused: at most 500 ledgers, halved above 20,000 lines), capped at the commit marker. It is normally one ledger.
2. **What changed.**
   - The issued-token lines come from `state_touches` (`kind = 'line'`). The MPT pairs come from `mpt_touches` (`holder != ''`) on a network with `hasMpt`.
   - Then, per line, its `trust_line_states` rows in the window, plus its newest row before the window for the before-state (a prefix of the key per line, as `LINE_STATES_SQL`).
   - For MPTs, the same over `mpt_holder_states`.
   - `clawback` comes from `tx_by_type` (`tx_type IN ('Clawback', 'AMMClawback')`, a key prefix with the window's ledger range).
3. **Writes, in this order:**
   1. the change rows, to the live generation and to a building one (whatever its phase: the command's `changes` pass stops at `h0`, and the windows write every
      change above it);
   2. the hour sets of the touched (token, hour) pairs (§4.4), in each generation whose `levels_through` has reached the window's start: the live one, and a
      building one once the worker has caught its levels up;
   3. the checkpoints the rule calls for (§4.3), rows then head, in the same generations;
   4. the state row of each generation, with the new `through_ledger` (and `levels_through` where step 2 ran).

   A crash before the state row leaves invisible rows (readers stop at the live generation's `levels_through`), and the window is applied again with the same keys.
4. **Ledgers of an older parser.** A window holding a ledger of a parser older than `TOKEN_PARSER_VERSION` (8), or for MPTs `MPT_PARSER_VERSION`, is never applied live (`parserFloorOf`). A
   live window at the head never holds one; a repair that meets one reports a build as due (§4.7).

### 4.3 The checkpoint rule

- After applying a ledger L, each token with changes in L gets a checkpoint at L when its changes since its previous checkpoint (or since its first change)
  reach `max(trust_lines after L, TOKEN_HISTORY_CHECKPOINT_FLOOR)`. The floor is 50,000 and is part of the config version.
- The rule is a pure function of the history, so a rebuild writes the same checkpoints.
- A checkpoint of S lines is written only after at least S changes, so the checkpoints never hold more rows than the change log.
- A checkpoint is written server-side as the fold of §3.1 at L.

### 4.4 Hour sets

- For each touched (token, hour), the row is recomputed whole from the change log.
- The flows are grouped by transaction first (§1), then summed.
- The levels are the previous hour row's levels (the newest row of an earlier hour), plus the hour's net change.
- An hour is `final` once `through_ledger` has passed its last ledger.
- A repair that changes an hour's levels rewrites that token's later hour rows whole, in one `INSERT … SELECT` with a running sum.

### 4.5 DEX hours

**Live.**
- Each UTC hour whose `pair_hourly` set is final and of the current `PAIR_HOURLY_CONFIG_VERSION` gives its `token_hourly_dex` rows: per pair row (the `book` and `amm` rows
  both), `base_sum` to the base token and `counter_sum` to the counter token, `count` to both. The native currency is no token and is skipped.
- A pair-hour with `unfit > 0` on a side is summed again exactly from `exchanges` (the pair's prefix and the hour's ledgers) in BigNumber.
- The sentinel is written last.

**History** (hours older than the oldest final `pair_hourly` hour, whose TTL is 45 days), by the command's `dex` phase (§4.6):
- one scan of `exchanges` per P7 partition, newest first, grouped by hour, base and counter, with the same exact rule, then the sentinels of every hour of the partition;
- resumable from the sentinels.
- Until it has run, the DEX figures of hours before `pair_hourly`'s window are absent, and `exchanged_through` says where the unbroken run of DEX hours ends (§5.2).

### 4.6 Generations and the build

**What a generation is.**
- A generation is one build of the token history. Readers name the `live` one.
- **Its coverage start, `coverage_from`, is the first ledger of the newest unbroken run of stored ledgers that reaches the head**, and never below
  `stateCoverageStart` (reused: the ledgers written by a parser older than 3 have no state rows).
  - "Unbroken" means no ledger number is missing: `count()` of `ledgers` over `[a, head]` equals `head − a + 1`. The command finds the lowest such `a` by a binary search over index-only
    counts.
  - This differs on purpose from the coverage of the other features, which ignore gaps (api-reference, Coverage). The token history adds levels up ledger by
    ledger, so a missing ledger would be wrong in every figure after it, not missing from one list.
  - During an ascending `range-ingest` from 32,570, the run that reaches the head is the one the live syncer wrote, until the fill joins it.

**When a build is needed.** The worker checks every `TOKEN_HISTORY_CHECK_MS` (10 minutes) and logs once when one is due. The gauge
`syncer_token_history_rebuild_needed{reason}` names the reason:
- `none`: there is no generation yet;
- `coverage`: the start of the unbroken run is below the live generation's `coverage_from` (a fill has joined the head's run);
- `config`: `TOKEN_HISTORY_CONFIG_VERSION` differs from the live generation's;
- `repair`: a repair met an older parser (§4.7).

The worker builds nothing itself. The answers keep the live generation's `coverage`, so a generation built on part of the history says `complete: false` until a new one replaces it.

**The command `token-history-build`.**
- It refuses to start, with a message that names why:
  - while another build holds the lease `<network>:token_history_build`;
  - while a `range-ingest` run is in progress (an `ingest_log` range whose newest row is `started`, the live intents left out);
  - while the worker's lease shows no worker (the build needs its live windows above `h0`).
- It checks the same `range-ingest` condition between batches, and stops with the generation `retired` if one starts: the build would read a history that is changing.
- It resumes a building generation of the current config and coverage if there is one, else it starts a new one at `h0` = the commit marker.
- It logs its progress as `range-ingest` does (phase, cursor, rows, rate), and exits when its last phase is done.
- It runs its statements as `INSERT … SELECT` in ClickHouse with `max_threads = TOKEN_HISTORY_BUILD_THREADS` (default 4; `--threads` sets it), and does little work in Node.

**The phases of a build**, each resumable from the state row:

1. **`changes`.** One pass over `trust_line_states` in key order, by batches of `TOKEN_HISTORY_PASS_ACCOUNTS` accounts (`nextPassAccounts`, reused), the rows
   from `coverage_from` up to `h0`.
   - Each batch is one `INSERT … SELECT`: the token side of every row (§1) as sign tests on the text, so no decimal range is involved; the before-state by
     `lagInFrame` over the line's rows ordered by `(ledger_index, tx_index, node_index)`; `before_known = 0` on a line's first row from `coverage_from` when that row
     is not a creation (a row below `coverage_from` never serves as a before-state);
     the order key; and `clawback` by `(ledger_index, tx_index) IN` the `tx_by_type` rows of the two types.
   - A batch is deterministic and has a dedup token `token_history:<g>:changes:<first>-<last>`, so running it again is harmless.
   - A property test pins the SQL rule to the TypeScript rule over generated lines.
   - Live windows already write the changes above `h0` for this generation.
2. **`mpt_changes`.** The same over `mpt_holder_states` by holder batches, where `hasMpt`.
3. **`levels`.** `h1` is the generation's `through_ledger` when the phase begins, fixed for the phase. Per token, in key order (the cursor):
   - stream the token's per-ledger totals from the change log (`ledger_index`, changes, net, trust lines), up to `h1`;
   - apply §4.3 and write its checkpoints and its hour rows;
   - a token with more than 5,000,000 changes is done in ledger slices of that many, resumable inside the token.
   - At the end, `levels_through = h1`.
4. **`dex`.** The DEX history of §4.5, once per database: hours that already have a sentinel are skipped, so a later build costs nothing here.
5. **`done`.** The command exits.

**The worker finishes the build.**
- It sees a building generation that is `done` with `levels_through < through_ledger`. It applies levels and checkpoints to it in windows over
  `(levels_through, through_ledger]`, with the live window's level logic, a step per pass.
- Once `levels_through` is within 10 ledgers of its own `through_ledger` (which the worker keeps at the head), it promotes it: a `live` row, then a `retired` row for the old
  one, if there is one. Readers switch at the first row.
- The retired generation's partitions are dropped 15 minutes later (`ALTER TABLE … DROP PARTITION`, so the syncer's user needs `ALTER DELETE` on the four generation
  tables, as it does for D6's).
- For a build of two days, the catch-up is about 40,000 ledgers: minutes.

**Who writes what.**
- The command writes a building generation's changes up to `h0`, its levels up to `h1`, and the DEX history.
- The worker writes every change above `h0`, the levels above `levels_through` once the build is `done`, and everything of the live generation.
- The two never write the same rows.

### 4.7 Re-ingest and repair

- The aggregator gets an eighth `agg_dirty` hook, after `mpt_state`'s. It only appends the slice's ledger range to `token_history_dirty` and rebuilds nothing. It
  runs whether or not the worker is enabled.
- The worker takes the oldest range.
  - **Its part below the live generation's `coverage_from` is dropped.** Those ledgers are outside the generation: a fill writing below the head's run. When
    the fill joins the run, the gauge says `coverage` (§4.6).
  - **Its part in `[coverage_from, through_ledger]` is repaired:**
    1. It rewrites the change rows of the tokens that `state_touches` and `mpt_touches` name in the range.
    2. It deletes, by a lightweight `DELETE` inside the range's partition, the keys of those tokens in the range that the rewrite did not produce.
    3. It deletes those tokens' checkpoints at or above the range's first ledger, and recomputes their hours and checkpoints from the checkpoint before it.
    4. It deletes the range row.
- A building generation gets the same repair once its build is `done`; until then its ranges are kept. A range inside a build's `[coverage_from, h0]` cannot be
  written while it builds: the command stops when a `range-ingest` starts (§4.6).
- A range that holds a ledger of an older parser is not repaired. The gauge says `repair` (§4.6), as the tokens job marks a rebuild.
- Between the rewrite and the end of the repair the token history is eventual, as every aggregate here is after a re-ingest (ADR-0008). A given ledger always gets the same
  answer, except across the repair of a ledger at or below it.

### 4.8 Boot, metrics and alerts

**Boot.** With the worker enabled, the boot checks the tables of 019 and the tables it reads (014, 017, `tx_by_type`), and refuses with
`lacks the schema of 019_token_history.sql`. With the aggregator enabled it checks `token_history_dirty`.

**Metrics of the worker**, every labelled counter seeded at 0:
- `syncer_token_history_lag_ledgers` (commit marker − the live generation's `levels_through`);
- `syncer_token_history_rebuild_needed{reason}` (1 for the reason a build is due, §4.6; `remove()` when none);
- `syncer_token_history_building{phase}` (1 while a building generation is in that phase, read from the state rows);
- `syncer_token_history_window_seconds`;
- `syncer_token_history_errors_total{step}`;
- `syncer_token_history_unfit_sums_total`.

The command is short-lived and reports in its log, as `range-ingest` does. The state rows are the record of a build (`operations.md` gets the query).

**Alerts:**
- the lag above 30 ledgers for 10 minutes while a generation is live;
- errors rising for 15 minutes.

A build that is due raises no alert: it waits for the operator by design, and the gauge and the coverage say so.

## 5. Endpoints

### 5.0 Common to every route

- **Envelope.** `result, coverage, ledger_index, close_time, …`.
  - `ledger_index` is the ledger the answer is as of: the one asked for, or the live generation's `through_ledger`.
  - `coverage` is the feature `token_history` (§6).
- **`{token}`.** D6's `{currency}.{issuer}` (split at its last `.`, `+` or `|`, with D6's messages), or an issuance ID: `<48hex>`, or `<48hex>+<issuer>` with
  ADR-0020's `issuer does not match mpt issuance`. On a network without MPT an issuance ID is 404 `token not found`.
- **A ledger** (the routes marked so below): `ledger_index` (alias `ledger`), `ledger_hash` or `date` (alias `close_time`), with the trust-lines route's
  parameters and messages (`invalid ledger hash`, `invalid date format`).
  - A ledger above `through_ledger` is 400 `ledger is not in the token history yet`.
  - One below the coverage's `from_ledger_index` is 400 `the date provided is too old`.
- **`exclude`.** 1 to 20 comma-separated addresses: 400 `invalid ripple address`, or `too many addresses to exclude`; duplicates are ignored.
  - The figures are unchanged, and the answer adds `excluded` (the addresses, sorted) and `without_excluded: {supply, holders, trust_lines}`.
  - The excluded holders' amounts come from the fold where one is read, else from their own key prefixes of `trust_line_states` (`(issuer, holder, currency)`) or
    `mpt_holder_states` (`(holder, issuance)`), through the same token-side rule.
- **v2 conventions.**
  - Errors are `{result:"error", message}`, and every 400 is checked before any read.
  - 404 `token not found`: no change of the token in the live generation, an LP currency.
  - 404 `token history is not built yet`: before the first generation is live.
  - 500 `unable to retrieve <what>`.
  - Lists have `limit` (default 200, max 1000 unless said), `marker` (base64url of the last row's key; a bad one is 400 `invalid marker`), `count` and `Link`.
  - `Cache-Control: private, max-age=60`, and `no-store` on errors. CSV as the reference's §CSV, without `coverage`.
- **Amounts** are text in every answer. Counts and ledgers are numbers. A key with no value is left out, never `null`.

### 5.1 `GET /v2/issuers/{issuer}/tokens` (at a ledger)

- Every token of the issuer with a change in the live generation, issued tokens and MPTs together, ordered by `currency`, paged (marker: `currency`).
- Row keys: `currency`, `code?` (the currency as text, as D6), `kind` (`issued` or `mpt`), `supply`, `holders`, `trust_lines`, `first_ledger`, `last_ledger`.
- Totals by §3.2, no fold.
- CSV `<issuer> - tokens.csv`. 400 `invalid issuer address`; an issuer with no token is an empty list, not a 404.

### 5.2 `GET /v2/tokens/{token}/summary` (at a ledger)

- **Keys:** `result, coverage, ledger_index, close_time, token: {currency, issuer, kind, code?}, supply, holders, trust_lines, first_ledger, first_time,
  last_ledger, last_time, windows: {"24h", "7d", "30d"}`.
- **Each window:** `{start, end, issued, redeemed, clawed_back, transferred, transfers, changes, exchanged?, trades?, exchanged_through?}`.
  - The windows end at the close time of the answer's ledger.
  - The flows are exact (§3.5).
  - `exchanged` and `trades` sum the whole DEX hours of the window up to the newest computed one, and `exchanged_through` names that hour's end. They are partial and say so, never estimated.
- `exclude` applies to the levels. No CSV. **Nothing in the summary is approximate**, so the brief's allowance for an approximate summary is not used.

### 5.3 `GET /v2/tokens/{token}/supply`

**Parameters:** `interval` = `day` (default), `hour` or `ledger`; `start` and `end` (the v2 date parameters, `end` inclusive at its granularity;
defaults: the token's first change and the answer's ledger); `descending`; `limit`/`marker`; `format=csv`; `exclude`.

**Rows.**
- `hour` and `day`: every bucket of the window, levels at the bucket's end carried forward and flows of the bucket (0 when none): `{time, ledger_index,
  supply, holders, trust_lines, issued, redeemed, clawed_back, net}`, plus `without_excluded` with `exclude`. A day is the sum of its 24 hour rows.
- `ledger`: the ledgers with a change, with the same keys. The window is at most 100,000 ledgers, else 400 `window too large for interval ledger`.

400 `invalid interval - use: day, hour, ledger`, the date messages, `invalid marker`. CSV `<code or currency> <issuer> - supply.csv`.

### 5.4 `GET /v2/tokens/{token}/distribution` (at a ledger)

- **Keys:** `result, coverage, ledger_index, close_time, supply, holders, buckets, top`.
- `buckets`: one per power of ten from the smallest holder's to the largest's, empty ones in between included: `{min, max, holders, balance}` (`min`
  inclusive, `max` exclusive, as text; MPT in raw units).
- `top`: `{"10": {balance, share}, "100": {balance, share}}`, the sum of the largest 10 and 100 holdings and their share of supply (6 decimals, half up, as D6's
  `share`).
- `exclude` adds `without_excluded`, with its own `buckets` and `top`. No CSV.

### 5.5 `GET /v2/tokens/{token}/holders` (D6's route, extended; at a ledger)

**Kept from D6:** the path, the parameters, the messages and the keys in their order: `result, coverage, ledger_index, close_time, supply, count, marker?,
holders: [{rank, holder, balance, share, limit, frozen, authorized}]`.

**Added:**
- the ledger parameters;
- `descending` (default `true`; `false` gives the smallest balances first);
- `first_ledger` and `last_ledger` as the last keys of a row, and `escrowed` after them for an MPT;
- the MPT ID form of `{token}`.

**Changed:**
- **The source.** Once a generation is live, the route reads `holdersAt` (seconds behind the head) instead of `token_lines` (a minute behind). Until then it is exactly D6's, and the ledger parameters answer
  404 `token history is not built yet`.
- **The order** is exact (§3.4) instead of by double. **The marker** holds the balance text and the holder, so a marker from D6's route is `invalid marker` once after
  the switch. Ranks and shares are D6's rules over the whole holder set.

### 5.6 `GET /v2/tokens/{token}/flows`

**Parameters:** `start` and `end` (required, at most 366 days, else 400 `window too large`); `interval` = `day` (default), `hour` (window at most 31 days) or
`month`; `counterparties` (default 10, max 100).

**Keys:**
- `result, coverage, ledger_index, close_time, start, end, interval`;
- `totals: {issued, redeemed, clawed_back, transferred, transfers, exchanged?, trades?, exchanged_through?}`;
- `periods: [{start, …the same keys}]`;
- `counterparties: [{account, received, sent, net, changes}]`. These are the holders with the largest `received + sent` in the window, then by account, read from the change log's key range of the window (bounded by the token's changes in it).
- `exchanged` and `trades` are present only when every hour of the window has its DEX sentinel (§2.4). Otherwise they are left out, never given as part of the window's figure.

No CSV, no pagination.

### 5.7 `GET /v2/tokens/{token}/snapshot` (at a ledger, required)

- A ledger is required: 400 `a ledger is required` before any other check of the ledger.
- **Keys:** `result, coverage, ledger_index, ledger_hash, close_time, token, supply, holders, trust_lines, digest, without_excluded?, excluded?, count, marker?,
  balances: [{holder, balance, escrowed?, limit, frozen, authorized}]`.
- The holders (amount above 0) are ordered by `holder` (the byte order of the address), with `limit` default 1000 and max 10,000.
- `digest` is the lower-case hex SHA-256 of the UTF-8 text made of one line `<holder>,<balance>\n` per holder of the whole set at the ledger, in that order. `balance` is the served text; for an MPT it
  is `amount + escrowed`.
  - It is the same on every page and does not depend on `exclude`, so an auditor can check any page against the whole and the whole against an independent recount.
  - The spec's test vectors (PR 3) fix it.
- CSV `<code or currency> <issuer> - snapshot <ledger_index>.csv`.

## 6. Coverage

`token_history` is a feature of `FeatureCoverageService` whose start is not read from the ledgers at request time: it is the **live generation's
`coverage_from`** (§4.6), the history that generation was built on.
- `from_ledger_index` is that ledger.
- For an issued token, `complete` is true when it is at or before the network's first ledger (D3's case of a feature with no amendment, as `issued_tokens`).
- For an MPT, `complete` is true when it is at or before the ledger `MPTokensV1` was enabled in (the feature `mpt`'s start). A network without MPT has none to answer.
- `/issuers/{issuer}/tokens` uses the issued tokens' rule, the stricter of the two.

Until the history is filled back to ledger 32,570 (ADR-0015's history fill) and a build has run on it, `complete` is false:
- a line untouched since the coverage start is missing from every figure, as it is from D6;
- the first known change of a line that existed before has `before_known = 0` and no flow.

A fill that joins the head's run makes the worker report a build as due (`coverage`). The answers stay those of the live generation, with its `complete: false`, until the operator's
build replaces it.

## 7. Query bounds

Every read starts from a key prefix, and the e2e suites pin its `read_rows` over a bulk of other tokens' rows:

| Read | Bound |
|---|---|
| Holder reads (`holdersAt`) | `2 × max(lines, 50,000)` rows plus 2 granules a part |
| Totals | The changes since the checkpoint |
| Hour series | The token's hour rows in the window |
| Flows and counterparties | The token's changes in the window |
| DEX | The token's DEX rows in the window |
| The worker's windows | Key ranges of `state_touches`, `mpt_touches`, `tx_by_type` and the per-line prefixes of the state tables |

## 8. Networks

| Network | Issued tokens | MPTs | Coverage |
|---|---|---|---|
| XRPL | Yes | Yes | Complete from 32,570 |
| Xahau | Yes | No (`hasMpt` false: no MPT read, an issuance ID is 404) | Complete from ledger 1 |
| The testnets | Yes | XRPL Testnet only | Never complete; from the sandbox's first boot |

## 9. Build cost, measurement and rollout

**Estimates for XRPL** (assumptions stated; PR 1 replaces them with measurements on real-shaped data and the scratch sync's tables, and
`operations.md` records them):

| Step | Estimate |
|---|---|
| `changes` | Reads 2 to 7 billion `trust_line_states` rows (both sides of 1 to 3.5 billion changes). D6's pass ran at about 1M rows/s warm, so 1 to 2 hours warm and a few hours to a day cold. It writes 1 to 3.5 billion rows. |
| `mpt_changes` | `mpt_holder_states` since ledger 99,226,369: minutes |
| `levels` | One read of the change log in token order; writes 50 to 200 million hour rows and the checkpoints: hours |
| DEX history (`dex`) | One scan of `exchanges`, one partition at a time: hours |
| **Total** | **Half a day to two days** of `token-history-build` running without pause at 4 threads (D6's rate was measured with ClickHouse's default threads on 16 CPUs). More `--threads` shorten it and load the server more. |

These are the costs of the build alone. Filling the history with `range-ingest` first is the existing, node-bound job of `backfill.md`: days to weeks for full XRPL
history, with or without this feature.

**What the build costs the rest of the system.** The ingest never waits for the build: they are separate processes, and the build's work happens in
ClickHouse. But they share one ClickHouse server. While the command runs, it reads hundreds of GB from disk and writes tens to hundreds, and the merges of what it
writes follow. So the ingest's inserts and the api's reads can be slower, and a heavy api read can come nearer its 30 s guard. The command runs only when the operator starts it, so
it can be run off-peak, stopped (it resumes where it was) and given fewer threads.

**Disk:** about 70 to 350 GB in steady state, twice the generation tables while a new build exists beside the live one.

**Rollout order** (a deployment that runs the api and a syncer at the head and fills its history with `range-ingest`):
1. `migrate` (019).
2. The syncer (worker and hook). The worker follows the head with no generation to write to yet, and reports `rebuild_needed{reason="none"}`.
3. The api, at any time after 019. The new routes answer 404 `token history is not built yet`, and D6's `/holders` serves as today until a generation is live.
4. `range-ingest` from the first ledger to the head, as `backfill.md` says (the command refuses to start while it runs).
5. `token-history-build`, once. The worker catches the levels up and promotes the generation, and the routes answer with `complete: true`.
6. The explorer, when it wants the extended `/holders`.

**For analytics before the fill ends,** run the command after step 3. It builds on the head's unbroken run (`complete: false`). After step 4 the gauge says `coverage`,
and one more run of the command replaces that generation.

Until a first generation exists, the worker's live windows have no generation to write to. The first build's `changes` pass therefore reads the state tables up
to its own `h0`, and the live windows write from `h0` on, so no ledger is missed.

## 10. OpenAPI and Ajv

- **OpenAPI.** Every route has its Swagger decorators (summary, description, parameters) and `@ApiOkResponse({ schema })`. The schema is a JSON Schema
  exported from `apps/api/src/token-history/schemas.ts`.
  - `docs/openapi.yaml` is regenerated as its header says, so these are its first routes with response schemas.
  - The header comment says which routes have response schemas.
- **Ajv.** `ajv` and `ajv-formats` are devDependencies of `apps/api`. The e2e suites compile the same schemas, and every response of the new routes must validate:
  - `required` and `additionalProperties: false` at every level;
  - amounts are `type: string` with the pattern `^\d+(\.\d+)?(e[-+]?\d+)?$`, so a number or a negative amount fails. The one signed key, `net` of `/supply`, has the
    same pattern with an optional leading `-`;
  - counts are integers.
- Key order is still pinned by the `*_KEYS` constants and `api-reference.spec.ts`, as in every module: Ajv does not check order.

## 11. Testing

TDD in every PR, and the gates of `docs/development.md`.

**Unit**
- The token-side rule against `orientations()`, as a property test.
- The SQL token-side rule against the TypeScript one, over generated lines run in ClickHouse.
- The order key against BigNumber's comparison, including 1e-81, 9.999999999999999e80, and ties in the double.
- The checkpoint rule: deterministic over the same history, and no more checkpoint rows than changes.
- The flow identity `Δsupply = issued − redeemed − clawed_back` over generated transactions, a transfer fee, a clawback and an `AMMClawback`.
- `exactSum` against BigNumber, with unfit amounts.
- The digest test vectors, and the parsers of every parameter in the order of their checks.

**e2e** (testcontainers ClickHouse, seeded through the real `LedgerWriter` from fixtures and generated ledgers)
- **Build equals live:** a generation built by `token-history-build` and one built by live windows over the same ledgers give byte-identical answers on every route.
- **An independent oracle:** a naive `argMax` over `trust_line_states` (and `mpt_holder_states`) at N gives the same holders, balances and supply as
  `/snapshot`, `/holders` and `/supply` at sampled ledgers, including ledgers on, just before and just after checkpoints. An MPT's supply equals its issuance's
  `outstanding_amount`.
- **Read bounds:** `read_rows` over a bulk of other tokens, with a mutant. The query condition cache is dropped before a measured read (agent-handoffs lesson).
- **Repair:** a `--reprocess` of a range gives the same answers; a changed fixture in the range changes exactly the tokens it touches. A range of an older parser
  is not repaired and sets `rebuild_needed{reason="repair"}`. A range below the live generation's `coverage_from` is dropped.
- **The command:**
  - it refuses to start during a `range-ingest`, while another build holds its lease, and without a worker;
  - it stops, retiring the generation, when a `range-ingest` starts;
  - it resumes after a kill at every phase.
  - `coverage_from` is the start of the head's unbroken run: a gap below it is never crossed, and a gap filled moves it.
- **Generations:** a build alongside live windows (the hand-over at `h0` and at `h1` loses no ledger and writes no row twice), the worker's catch-up and promotion, the
  drop, and readers that never mix generations.
- `exclude`, D6's `/holders` before and after the switch (keys and order unchanged), the 404 before the first generation, Xahau (no MPT read), and every route's Ajv schema.
- **Boot checks and the hook:** the hook appends and rebuilds nothing.

**Mainnet check** (the success criterion, run at rollout, not in CI)
- A script compares `/snapshot` with a node's `gateway_balances` and `account_lines` of the issuer at a sample of tokens and ledgers, EURGH among them, one
  request in flight, against a node GateHub runs.
- Its report goes in the plan's verification file. Fewer samples than asked are reported as such, as D9's comparison was.

## 12. Docs to update (PR 4)

- `GLOSSARY.md`: the terms of §1 (token side, change, issued, redeemed, clawed back, exchanged, token history, checkpoint).
- `docs/api-reference.md`: a section per route, the `/holders` changes, the "Keys of" lines and "Differences from data.ripple.com" (none: the routes are new).
- `docs/data-model.md` (the seven tables, 85 → 92 tables, the relationships and migration 019).
- `docs/syncer.md` (the worker, and the eighth hook).
- `docs/architecture.md`.
- `docs/clickhouse.md` (the reads, and `ALTER DELETE` on the generation tables).
- `docs/operations.md` (the build, measured; a forced rebuild; the alerts; retention).
- `docs/backfill.md` (what a fill and a reprocess do to the token history).
- `docs/observability.md`, `docs/configuration.md` (`GH_WORKERS` gains `token_history`) and `docs/openapi.yaml` (regenerated).
- ADR-0010 Amendment 12 (the routes, the `/holders` changes, the messages), and a note in ADR-0019 that its deferred history is ADR-0021's.

## 13. PR stack (for the plan)

Each PR is mergeable on its own, with its own tests, stacked in this order, each with a sub-issue of #28:

1. **Derived tables and the build.**
   - Migration 019, `Table` entries and row types.
   - The shared rules (token side, order key, `exactSum`, checkpoint rule, flows, the start of the head's unbroken run).
   - The build's phases of §4.6 and the DEX history of §4.5, with the state rows and generations.
   - The `token-history-build` command with its refusals, its lease and its log.
   - The measurements of §9. Until PR 2, the command's tests stand in for the worker's live windows above `h0`.
2. **Syncer integration.** The `token_history` worker: its loop and lease, live windows, hour sets and checkpoints live, DEX from `pair_hourly`, the catch-up of a finished
   build, promotion and drop, repair and the eighth hook, the `rebuild_needed` gauge, boot checks, metrics and alerts.
3. **Read endpoints.** The shared reads (§3), `TokensModule`'s new controllers and `IssuersController`, the `/holders` extension and switch, the JSON Schemas and the Ajv e2e checks, and the digest test vectors.
4. **OpenAPI and docs.** `openapi.yaml` regenerated, and every document of §12.

## 14. Risks and open items for the owner

- **Disk:** 70 to 350 GB, doubled during a rebuild. The real figure comes from PR 1's measurement before production.
- **The build shares ClickHouse with everything else.** The ingest never waits for it, but while `token-history-build` runs (half a day to two days on
  XRPL, estimated), the ingest's inserts and the api's reads compete with it for the server's disk and CPU (§9). It runs only when the operator starts it, and can
  be stopped and resumed and given fewer threads. The measurement of PR 1 sets its default thread count.
- **D6's marker change** invalidates markers in flight once (§5.5).
- **Decided here, open to the owner:**
  - the checkpoint floor of 50,000;
  - 20 excluded addresses;
  - `/flows` at most 366 days (hourly at most 31);
  - `interval=ledger` at most 100,000 ledgers;
  - the snapshot `digest` and its definition;
  - transfer fees counted as redeemed;
  - `AMMClawback` counted as clawed back.
- **The mainnet check needs a node GateHub runs:** public nodes pushed back on D9's comparison after 39 requests.
