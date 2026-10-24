# Supply (D7): design

Status: proposed (2026-10-24), program 2, sub-project D7. Repository `data-api`, branch `feat/explorer-data-2`.

- Boards: `x-explorer/docs/superpowers/specs/2026-10-24-explorer-mock/Supply.dc.html` (XRPL) and `SupplyXahau.dc.html` (the same board
  with `network="xahau"`): the "Where the 100 billion XRP are" bar, the six tiles, "XAH minted per day, by source", "XRP burned per day".
  The Distribution tab and board and the "Escrow releases by month" card are deferred by the owner and not designed here.
- Builds on: PR #20 (`feat/account-investigation-data`: `account_states`, migration 005, ADR-0015), D1
  (`2026-10-19-validators-amendments-design.md`: `network_state`), the AMM data (`2026-10-17-amm-data-design.md`: `amm_pools`,
  `amm_pool_states`, `fillForward`), D3 (`2026-10-17-nft-data-design.md`, revised, section 4: `FeatureCoverageService`, its
  no-amendment case, `NetworkProfile.firstLedger` and the `coverage` shape), D5 (`2026-10-24-ledger-objects-delegation-design.md`: the
  `escrows` aggregate, `readEscrowed`), and a subset of family 5 (`2026-10-17-xahau-native-design.md`, part B and C).
- Its explorer half: E12, `x-explorer/docs/superpowers/specs/2026-10-24-supply-page-design.md`. Program overview:
  `x-explorer/docs/superpowers/specs/2026-10-24-explorer-program-2-overview.md`.

## Owner decisions to confirm

| # | Decision (and deviation from the board) | Recommendation |
| --- | --- | --- |
| 1 | One route, `GET /v2/network/supply`, answers the newest **snapshot**: every figure computed at one ledger by an aggregator job that starts a new cycle every hour (the board's "updated hourly"). Not live, no `ledger_index` parameter. | Keep |
| 2 | XRPL burned is exact from the ledger header (100,000,000,000 XRP − `total_coins`) and carries no `coverage`. Xahau has no cap, so its burned is the sum of every indexed ledger's fees, with `coverage`. | Keep |
| 3 | Account reserves are what accounts **must keep**: accounts × base reserve + Σ `OwnerCount` × owner reserve, at the reserve values in force at the snapshot ledger. Not Σ min(balance, requirement): a few accounts hold less than their requirement after paying fees. AMM pool accounts (pseudo-accounts, no reserve) are left out of the count. | Keep |
| 4 | Escrowed counts native escrows only (D5's sentinel): token escrows (XRPL TokenEscrow, Xahau issued-token escrows) are not supply. Native currency in payment channels counts as circulating (the glossary's definition). | Keep |
| 5 | Xahau minted, by source: **rewards** = every entry of a `GenesisMint` whose parent (`EmitDetails.EmitParentTxnID`) is a `ClaimReward` (the governance members' share of a reward included); **genesis_mint** = every other `GenesisMint`; **import** = what an `Import` credits (the burned XRP, scaled by xahaud's B2M schedule, plus the starting bonus of an account it creates). The supply the network started with (XahauGenesis) is not minted. | Keep |
| 6 | Minted per day by source is served (the board's stacked chart): it is a cheap query over the three tables this spec adds anyway, `GET /v2/network/supply/minted?interval=day`. Burned per day needs no route: the explorer reads the existing `/v2/network/fees?interval=day` (`total`), not the board's `/v2/network/supply/burned`. | Keep |
| 7 | `reward_claims` is ordered by ledger (P6), not by account as family 5 has it, so that the reward test is a range join; family 5 adds its per-account index when it is built. `imports` holds only what supply needs; family 5 adds its decoded-blob columns. | Keep |
| 8 | Before the first snapshot the route answers 404 `supply not computed yet`. | Keep |
| 9 | Snapshots are kept (one row an hour, no TTL); only the newest is served. A supply-over-time chart (deferred) could read them later. | Keep |
| 10 | Reserve values come from `network_state` (D1) at the snapshot ledger, else from the newest `SetFee` in the index; with neither, `reserves` is left out of the answer. | Keep |
| 11 | Each history-derived part carries its own `coverage` (D3's shape and service), not one for the answer: on XRPL total and burned need no history while reserves will stay incomplete until the history spec. | Keep |
| 12 | **Consistency pass:** on XRPL `/v2/network/supply/minted` answers its empty list with `coverage` `complete: true` (D3's rule for a feature the network cannot have, as D5 and D9 do), not without `coverage`. | Keep: one rule for every list. |

## Goal

Serve, per network, what the Supply board shows: the total supply, burned, escrowed, circulating supply, the native currency in AMM
pools and held as account reserves, and on Xahau what was minted, by source, in total and per day, each figure exact (drops) and each one
that depends on indexed history with its `coverage`.

## Scope

- A snapshot table `network_supply` and an aggregator job `supply` that fills it, one cycle an hour, within a budget.
- Three Xahau ledger tables for minting (`genesis_mints`, `imports`, `reward_claims`) and their parsers, a new parser version.
- `GET /v2/network/supply` and `GET /v2/network/supply/minted`.

## Non-goals

- Distribution (rich list, balance brackets, percentiles), the escrow-release forecast, the network-wide escrows list (owner, deferred).
- Supply over time (a daily statistics job): deferred; the hourly rows are kept but not served.
- A live answer: the board says "updated hourly"; nothing here follows the chain ledger by ledger.
- Pseudo-accounts other than AMM pools (a vault's, XLS-65, once enabled): counted as accounts until a follow-up leaves them out.
- The rest of family 5 (hooks, remit, cron, remarks, reward and import volumes, per-account mint lists, `Blob` decoding).

## Facts this design relies on (checked 2026-10-24)

| # | Fact | Source |
| --- | --- | --- |
| F1 | `ledgers.total_coins` (`UInt64`, drops) is the native currency in existence after the ledger; `fee_total` is the sum of its transactions' `Fee`. On XRPL only fees destroy coins and nothing creates them, so burned = 10¹⁷ drops − `total_coins` exactly. | data-model §2; rippled |
| F2 | On Xahau, minting raises `total_coins`: from recorded ledger 26540187 to 26540188, `total_coins` grew by 15,852,989 drops, ledger 26540188's fees were 14,122, and its one `GenesisMint` credited 8 entries summing 15,867,111 = 15,852,989 + 14,122. So per ledger: Σ minted = Δ`total_coins` + `fee_total`. | `packages/shared/test/fixtures/xahau/recorded/` |
| F3 | A reward is minted by the `GenesisMint` the genesis account's reward hook emits for a `ClaimReward`: the mint's `EmitDetails.EmitParentTxnID` is the claim's hash, its `FirstLedgerSequence` is the claim's ledger + 1 and `LastLedgerSequence` the claim's ledger + 5. The claim itself mints nothing. | fixtures above; `balance-changes.parser.spec.ts` |
| F4 | xahaud `GenesisMint.cpp`: an entry's `Amount` must be native (an entry may carry only governance flags or marks and no amount); the header grows by the sum (`rawDestroyXRP(-dropsAdded)`). | Xahau/xahaud `src/xrpld/app/tx/detail/GenesisMint.cpp` |
| F5 | xahaud `Import.cpp` `doApply`: credit = the XRPL transaction's `Fee` (1:1 for the first 2,000,000 ledgers after Xahau's activation, then declining linearly to 0 at 30,000,000, 0 with `ZeroB2M`); an account the Import creates also gets `computeStartingBonus`; the header grows by what was added (`rawDestroyXRP(-added)`). A first Import pays no fee; a later one pays its `Fee` before the credit. So minted = balance after − balance before + `Fee`. | Xahau/xahaud `src/xrpld/app/tx/detail/Import.cpp` |
| F6 | `account_states` holds, per account root a transaction changed, the state after it (`owner_count`, `deleted`, `balance`, `fields`); the state at L is the newest row at or before L; coverage is "above the newest ledger an older parser wrote". | migration 005, ADR-0015, `StateLedgerService` |
| F7 | `network_state` holds `reserve_base` and `reserve_inc` (drops) per polled ledger (`ORDER BY ledger_index`, TTL 100 days). `SetFee` carries `ReserveBase`/`ReserveIncrement`, or `ReserveBaseDrops`/`ReserveIncrementDrops` since XRPFees. | migration 002 |
| F8 | D5's `escrows` sentinel holds the open native escrows' count and drops at `through_ledger`; `readEscrowed(ch)` returns `{ drops, open, through_ledger }`; the escrows coverage is the api's `FeatureCoverageService.coverage('escrows')`. | D5 §1.3, §4.3 |
| F9 | `amm_pools` (newest version per pool) holds each pool's reserves as of `last_ledger`; `ammPoolsWatermark` is the ledger before the oldest touch a pool's row has not seen; `fillForward(ch, accounts, upTo, from, query)` gives exact state at any ledger. AMM enabled at XRPL 86,795,265. | `amm-pools.job.ts`, backfill.md |

## 1. Data model

All new tables come in **the next migration** (`NNN_supply.sql`; the plan assigns the number), `CREATE TABLE IF NOT EXISTS`, one
statement per table, members of `Table` and row types in `rows.ts`. The three ledger tables are created in every network database and
stay empty on XRPL.

### 1.1 `genesis_mints` (ledger table, P6)

One row per `GenesisMints` entry with a native `Amount` of a successful `GenesisMint` (family 5's table, the columns supply needs).

```sql
CREATE TABLE IF NOT EXISTS genesis_mints
(
  ledger_index   UInt32,
  tx_index       UInt32,
  mint_index     UInt16,          -- the entry's position in GenesisMints
  tx_hash        String,
  close_time     DateTime('UTC'),
  destination    String,
  amount         UInt64,          -- drops
  parent_tx_hash String,          -- EmitDetails.EmitParentTxnID, '' when absent
  emit_hook_hash String           -- EmitDetails.EmitHookHash, '' when absent
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index, mint_index)
SETTINGS non_replicated_deduplication_window = 1000;
```

### 1.2 `imports` (ledger table, P6)

One row per successful `Import` (family 5's table, its supply columns only; family 5 adds `kind`, `xrpl_*`, `burned`, `issuer` with
`ALTER TABLE ... ADD COLUMN` and a reprocess of its own).

```sql
CREATE TABLE IF NOT EXISTS imports
(
  ledger_index    UInt32,
  tx_index        UInt32,
  tx_hash         String,
  close_time      DateTime('UTC'),
  account         String,
  minted          UInt64,         -- drops: balance after − balance before + Fee (F5)
  account_created UInt8
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;
```

### 1.3 `reward_claims` (ledger table, P6)

One row per `ClaimReward`, whatever its result (a mint's parent is a claim whether or not the claim succeeded).

```sql
CREATE TABLE IF NOT EXISTS reward_claims
(
  ledger_index UInt32,
  tx_index     UInt32,
  tx_hash      String,
  close_time   DateTime('UTC'),
  account      String,
  issuer       String,
  opt_out      UInt8             -- tfOptOut set
)
ENGINE = ReplacingMergeTree
PARTITION BY intDiv(ledger_index, 1000000)
ORDER BY (ledger_index, tx_index)
SETTINGS non_replicated_deduplication_window = 1000;
```

The three are child tables like the others: in `CHILD_TABLES` (`build-rows.ts`), in `LEDGER_KEYED_TABLES` (`ingest-state.ts`, same
partitioning as the DDL), deleted by recovery and `--reprocess`, written with the ledger before its `ledgers` row.

### 1.4 `network_supply` (aggregate, no partition)

One row per snapshot, written by the `supply` job in one insert.

```sql
CREATE TABLE IF NOT EXISTS network_supply
(
  ledger_index      UInt32,             -- the snapshot ledger L
  close_time        DateTime('UTC'),
  started_at        DateTime('UTC'),    -- when the cycle began (the cadence reads it)
  computed_at       DateTime('UTC'),    -- when the row was written
  total_coins       UInt64,             -- drops
  burned            UInt64,             -- drops: XRPL 10^17 − total_coins; Xahau Σ fee_total ≤ L
  escrowed          UInt64,             -- drops, open native escrows (D5)
  escrow_count      UInt64,
  amm               Nullable(UInt64),   -- drops in pools; NULL on a network without AMM
  amm_pools         UInt32,             -- live pools with a native reserve above 0
  reserve_base      Nullable(UInt64),   -- drops; NULL when no reserve value is known at L
  reserve_inc       Nullable(UInt64),
  accounts          UInt64,             -- existing accounts at L, AMM pool accounts left out
  owner_count       UInt64,             -- Σ OwnerCount of those accounts
  minted_rewards    Nullable(UInt64),   -- drops, every indexed mint ≤ L; NULL on XRPL
  minted_import     Nullable(UInt64),
  minted_genesis    Nullable(UInt64),
  version           UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY ledger_index;
```

- **Readers** take the newest snapshot without `FINAL`: `ORDER BY ledger_index DESC, version DESC LIMIT 1` (a read of the end of the key).
  A cycle that is redone at the same ledger (a retry after a failed insert) writes the same key under a newer `version`.
- Not a ledger table (not in `CHILD_TABLES` / `LEDGER_KEYED_TABLES`): recovery never deletes it. Every cycle recomputes everything
  from the tables, so a re-ingest needs no `agg_dirty` hook: the next cycle (at most an hour later) carries it (section 4.5).
- Size: 24 rows a day, a few hundred bytes each. No TTL (decision 9).

### 1.5 Coverage

D7 designs no coverage of its own. Every `coverage` object of its answers is D3's (`2026-10-17-nft-data-design.md` section 4):
`FeatureCoverageService.coverage(feature)` (`apps/api/src/common/feature-coverage.service.ts`), with D3's rule (`from_ledger_index` one
above the newest stored ledger an older parser wrote, through the shared `newestLedgerBelowVersion`; gaps ignored; `complete` when
`from_ledger_index` is at or below the feature's start), D3's 60 s cache and D3's shape. D7 only declares its features:

| Part | Feature `{ parserVersion, amendment }` | Start (XRPL / Xahau) |
| --- | --- | --- |
| burned (Xahau only) | `{ 1, none }`: every stored ledger has `fee_total`, so `from` is the oldest stored ledger | Xahau's first ledger |
| escrowed, circulating | D5's escrows feature, `{ OBJECT_PARSER_VERSION, 'Escrow' }` (the coverage of D5's own escrow answers) | 28,685,313 / first ledger |
| amm (XRPL) | `{ AMM_PARSER_VERSION, 'AMM' }` | 86,795,265 / — |
| reserves | `{ STATE_PARSER_VERSION, none }` | 32,570 (the history spec writes that ledger's state, ADR-0015) / first ledger |
| minted (Xahau) | `{ MINT_PARSER_VERSION, none }` | — / first ledger |

"none" is D3's case of a feature with no amendment, whose start is the network's first ledger (`NetworkProfile.firstLedger`, D3's:
XRPL 32,570, Xahau its genesis read from a node's `complete_ledgers`, none on the testnets, which answer `complete: false`). D7 adds
nothing to the service.

The answer's coverage is the index's at the time of the request, and the snapshot is up to an hour old: when a reprocess or the history
backfill completes a feature, `complete` turns true at once and the figure follows at the next cycle. `docs/operations.md` says to read
the figures one cycle after such a run.

## 2. Parsing

A new parser version (the plan numbers it). Its constant `MINT_PARSER_VERSION` goes in `rows.ts` beside `STATE_PARSER_VERSION`, with
a line in the `PARSER_VERSION` history comment; readers gate on it, never on `PARSER_VERSION`. Two pure parsers with family 5's names,
fed into `buildLedgerRows`:

**`packages/shared/src/parsers/rewards.parser.ts`** (`RewardsParser`):
- `ClaimReward` (any result): one `reward_claims` row: `account` = `Account`, `issuer` = `Issuer` (`''` without), `opt_out` = `Flags &
  1` (tfOptOut; Task 1 confirms the bit on a recorded opt-out claim, else from xahaud's `TxFlags.h`).
- `GenesisMint` with result `tesSUCCESS`: one `genesis_mints` row per entry of `GenesisMints` that has a native `Amount` (a string of
  drops), in entry order (`mint_index` = the entry's index, so a skipped entry leaves a gap and the key never moves): `destination`,
  `amount`, `parent_tx_hash` and `emit_hook_hash` from `EmitDetails` (`''` without). An entry with a non-native or absent `Amount` has
  no row (F4: xahaud rejects the first and the second mints nothing). A failed `GenesisMint` has no rows.

**`packages/shared/src/parsers/import.parser.ts`** (`ImportParser`):
- `Import` with result `tesSUCCESS`: one `imports` row. `minted` = final `Balance` − previous `Balance` + `Fee` of the `Account`'s
  `AccountRoot` node (F5): a `CreatedNode` counts from 0 (`account_created` = 1), a `ModifiedNode` without `Balance` in
  `PreviousFields` has a delta of 0, and an `Import` whose node is missing has `minted` = `Fee` (nothing credited, the fee burned) and
  is logged by the parser's tests as impossible. Negative results (cannot happen by F5) are clamped to 0 and counted
  (`syncer_parser_anomalies_total{kind="import_minted_negative"}`, the existing anomaly counter if one exists, else this one).
- `Import` with another result: no row (the fee is burned like any fee; nothing is minted).

**Invariant (the golden test).** For every recorded Xahau ledger whose parent is recorded too: Σ `genesis_mints.amount` + Σ
`imports.minted` = Δ`total_coins` + `fee_total` (F2). Today that is 26540187 → 26540188; Task 1 records the ledgers below so it covers an
Import of each kind.

**Edge cases.** Hooks run on the genesis account for a `ClaimReward` and emit the mint; an emitted `GenesisMint` is applied in a later
ledger (F3). Xahau's `EnableAmendment` for XahauGenesis changes `total_coins` once at the network's start: that is the supply it began
with, not a mint (decision 5), and its ledger is the only one where the invariant does not hold (the test skips a ledger with an
`EnableAmendment` of XahauGenesis). On XRPL none of the three types exists: the parsers return nothing.

## 3. Reads shared by the job and the api

`packages/shared/src/query/supply.ts` (pure SQL builders and small readers; every user value bound):

- `newestSnapshot(ch)`: `SELECT * FROM network_supply ORDER BY ledger_index DESC, version DESC LIMIT 1`.
- `mintSums(ch, from, to, byDay)`: the minted drops by source over ledgers `[from, to]`, in total or per UTC day. It reads in slices of
  `SUPPLY_MINT_SLICE_LEDGERS` = 1,000,000 ledgers (one P6 partition), so the set of claim hashes a read builds is one slice's
  (plus `SUPPLY_PARENT_LEDGERS` = 256 ledgers before it):

```sql
SELECT toDate(close_time) AS day,
       sumIf(amount, parent_tx_hash IN (SELECT tx_hash FROM reward_claims
                                         WHERE ledger_index BETWEEN {claimsFrom:UInt32} AND {to:UInt32})) AS rewards,
       sumIf(amount, parent_tx_hash NOT IN (SELECT tx_hash FROM reward_claims
                                             WHERE ledger_index BETWEEN {claimsFrom:UInt32} AND {to:UInt32})) AS genesis_mint
FROM (SELECT close_time, amount, parent_tx_hash FROM genesis_mints
       WHERE ledger_index BETWEEN {from:UInt32} AND {to:UInt32}
       ORDER BY ledger_index, tx_index, mint_index LIMIT 1 BY ledger_index, tx_index, mint_index)
GROUP BY day
```

  plus the same shape over `imports` (`sum(minted)`, deduplicated by `(ledger_index, tx_index)`). `claimsFrom = max(0, from − 256)`: a
  reward's claim is at most 5 ledgers before it (F3); the margin is 256 so that a slower hook still classifies. The total form drops
  `day`. Callers cap `to` at the committed head.

## 4. The `supply` job

`computeSupplyCycle` and its steps in `packages/shared/src/aggregate/supply.job.ts`; the runner
`apps/syncer/src/aggregator/supply.job-runner.ts` (the `AggregateJobDeps` pattern of `rates-daily.job-runner.ts`); job name `supply` in
`AggregatorJobName`, the **last job of a tick** (after `volume_backfill` and after the jobs program 2 adds before it, `escrows` among
them), budget `AGGREGATOR_SUPPLY_BUDGET_MS` = 5,000. Like `amm_daily`, a step is never cut by the budget; a step that takes longer is
warned about once.

### 4.1 The cycle

A **cycle** computes one snapshot at one ledger L. Its state (L, the partial sums, the step it is on, failures) is in memory; a
restart forgets it and the next tick starts a fresh cycle.

- **When.** A cycle starts at a tick when there is no cycle in progress and the newest snapshot's `started_at` is at least
  `SUPPLY_INTERVAL_MS` = 3,600,000 ago (or there is none).
- **L.** L = the `through_ledger` of D5's escrows sentinel (`readEscrowed`), which is the state escrowed describes (D7 requires D5's job
  to write the sentinel with its watermark on every run, changed or not: D5 §4.1 step 5). On XRPL the cycle also needs
  `ammPoolsWatermark(ch) >= L` (no pool has a touch at or below L that its row has not seen). When either is not met (no sentinel yet,
  the AMM job behind), the cycle does not start and the next tick tries again; after `SUPPLY_START_WAIT_TICKS` = 10 such ticks it warns
  once (`supply: waiting for escrows/amm_pools to reach the head`). Both jobs run earlier in the same tick, so this is rare.
- **First tick** (the current-state reads, which must be taken at the tick L is chosen): L's `close_time` and `total_coins` from
  `ledgers`; escrowed (`drops`, `open` from `readEscrowed`); on XRPL the AMM step (4.2, part 1); the reserve values (4.3); the AMM pool
  accounts (for the reserves step). The job stores no coverage: the api adds it per part (1.5).
- **Later steps**, in this order, as many as the budget allows per tick: the account ranges (4.3), the AMM fill-forwards (4.2, part 2),
  on Xahau burned and minted (4.4). Each step's result is added to the cycle's sums.
- **End.** One insert of the `network_supply` row (`version` = `nextSetVersion` over `ledger_index = L`), then the gauges.
- **Failures.** A step that fails is logged and counted (`syncer_aggregator_errors_total{job="supply"}`) and tried again at the next
  tick; the cycle keeps its place. After 3 failures of the same step the cycle is dropped and the next one waits 5 minutes, doubling up
  to an hour (the other jobs' backoff). A shutdown aborts the step in flight and writes nothing.

### 4.2 AMM (XRPL)

Part 1, at the first tick: the newest `amm_pools` row of every pool (`ORDER BY amm_account, version DESC LIMIT 1 BY amm_account`, about
15,000 rows). A row with `last_ledger <= L` is the pool's state at L (the watermark condition of 4.1 says no touch in `(last_ledger, L]`
is unseen); its native reserve is `reserve_base` when the base is the native currency (`base_currency = 'XRP' AND base_issuer = ''`),
else `reserve_counter` when the counter is, else 0; a `deleted` pool holds nothing. Part 2: the pools whose row is past L (`last_ledger >
L`: touched since, usually a few hundred at most) are filled forward at L with the shared `fillForward(ch, chunk, L, L −
AMM_FILL_WINDOW_LEDGERS, …)` over the reserve columns, `AMM_POOLS_CHUNK` (200) at a time, one chunk a step. `amm` = Σ native reserves
(exact, from the reserve strings, in drops); `amm_pools` = the pools with a native reserve above 0 and not deleted.

### 4.3 Reserves

**Reserve values** at L: `SELECT reserve_base, reserve_inc FROM network_state WHERE ledger_index <= {L:UInt32} ORDER BY ledger_index
DESC, polled_at DESC LIMIT 1`; with no row (the validators worker off, or past the 100-day TTL), the newest `SetFee` at or before L
(`tx_by_type` prefix `('SetFee')`, newest first, `LIMIT 1`, then its `tx_json` from `transactions` by key: `ReserveBaseDrops` /
`ReserveIncrementDrops`, else `ReserveBase` / `ReserveIncrement`); with neither, `reserve_base`/`reserve_inc` are NULL and the api
leaves `reserves` out (decision 10). The two numbers are those in force at L, so a reserve change shows in the next snapshot.

**Accounts and owner count.** The state of every account at L, read in **account ranges**: the key space of `account_states` cut by the
two characters after `r` (3,364 prefixes in byte order of the XRPL base58 alphabet, `SUPPLY_ACCOUNT_PREFIXES`), `SUPPLY_PREFIXES_PER_READ`
= 32 prefixes a read, about 105 reads a cycle. A simulation of random account IDs puts at most 0.1% of accounts under one prefix, so a
read is about 1% of the table (3% at most). One read:

```sql
SELECT count() AS accounts, sum(s.1) AS owner_count
FROM (SELECT account, argMax(tuple(owner_count, deleted), (ledger_index, tx_index, node_index)) AS s
        FROM account_states
       WHERE account >= {lo:String} AND account < {hi:String} AND ledger_index <= {L:UInt32}
       GROUP BY account)
WHERE s.2 = 0 AND NOT has({pools:Array(String)}, account)
SETTINGS optimize_aggregation_in_order = 1
```

`pools` = the AMM pool accounts (every `amm_account` of `amm_pools`) inside `[lo, hi)`, from the first tick. A row written twice (an
unmerged part) gives the same `argMax`. The read never touches `fields` (the wide column). `optimize_aggregation_in_order` streams the
groups in key order, so memory stays small; the API's `max_memory_usage` guard applies to the syncer's reads too.

**Cost.** Each cycle reads every row of `account_states` up to L once (four narrow columns and the key). Today that is the rows since
PR #20's deploy; at full XRPL history the plan estimates some billions of rows, about a minute or two of reads a cycle, so 20 to 40 ticks
of 5 s. Should a cycle take longer than an hour, cycles simply run back to back: the snapshot says its own ledger and time, and
`syncer_supply_cycle_seconds` shows it.

### 4.4 Burned and minted (Xahau)

- **Burned**: `SELECT sum(fee_total) FROM (SELECT fee_total FROM ledgers WHERE ledger_index <= {L} ORDER BY ledger_index LIMIT 1 BY
  ledger_index)`: one read of the narrow `ledgers` columns (Xahau: about 27 million rows). XRPL: `burned` = 10¹⁷ − `total_coins` (no
  history, no read).
- **Minted**: `mintSums(ch, first, L, false)` from the oldest ledger the three tables can hold (`newestLedgerBelowVersion(ch,
  MINT_PARSER_VERSION) + 1`, or the oldest stored ledger), one slice a step (about 27 on Xahau). XRPL: the three columns NULL.

### 4.5 Re-ingests and consistency

Every cycle reads committed ledgers at or below L only, and current-state tables only at the tick L is chosen, so a snapshot is the
state of one ledger. A `--reprocess` that rewrites ledgers at or below L while a cycle runs may leave that cycle's figures off for the
rewritten accounts or mints (a range read between the delete and the rewrite); the next cycle, an hour later, is right again. No
`agg_dirty` hook: there is no incremental state to repair. `docs/operations.md` says so.

### 4.6 Gauges and logs

`syncer_supply_snapshot_age_seconds` (now − `close_time` of the newest snapshot; alert above 3 hours), `syncer_supply_cycle_seconds` (wall
time of the last finished cycle), and the job's error counter. One log line per finished cycle: L, the step count, the time, and the
figures in drops.

## 5. Endpoints

Both in `apps/api/src/network/` (`supply.controller.ts`, `supply.service.ts`, `supply-object.ts` with its spec), registered in
`NetworkModule`; `@RippleController('v2/network/supply')`. Amounts are exact decimal strings of the native currency in whole units
(drops ÷ 10⁶, trailing zeros dropped, as everywhere); counts are JSON numbers; absent parts are left out.

### 5.1 `GET /v2/network/supply`

No parameters (unknown ones are ignored). Reads `newestSnapshot`; computes the amounts from drops (exact `bigint`):
`circulating = total − escrowed`; `reserves = accounts × reserve_base + owner_count × reserve_inc`; and asks
`FeatureCoverageService` (D3) for the `coverage` of each history-derived part present (1.5; at most four features, each cached 60 s).

XRPL:

```json
{
  "result": "success",
  "ledger_index": 107747456,
  "close_time": "2026-10-24T21:00:00Z",
  "computed_at": "2026-10-24T21:01:47Z",
  "currency": "XRP",
  "total": "99985312374.716318",
  "burned": { "amount": "14687625.283682" },
  "escrowed": { "amount": "35212847105.402318", "escrows": 12879,
                "coverage": { "from_ledger_index": 28685313, "complete": true } },
  "circulating": { "amount": "64772465269.314",
                   "coverage": { "from_ledger_index": 28685313, "complete": true } },
  "amm": { "amount": "46218377.402915", "pools": 14594,
           "coverage": { "from_ledger_index": 86795265, "complete": true } },
  "reserves": { "amount": "9810004", "accounts": 6410280, "owner_count": 16998620, "base": "1", "increment": "0.2",
                "coverage": { "from_ledger_index": 107480321, "complete": false } }
}
```

Xahau:

```json
{
  "result": "success",
  "ledger_index": 26603520,
  "close_time": "2026-10-24T21:00:02Z",
  "computed_at": "2026-10-24T21:00:31Z",
  "currency": "XAH",
  "total": "613401782.117306",
  "burned": { "amount": "2318.640227", "coverage": { "from_ledger_index": 2, "complete": true } },
  "minted": { "amount": "49425551.616207", "rewards": "41203318.512207", "import": "8102233.104", "genesis_mint": "120000",
              "coverage": { "from_ledger_index": 2, "complete": true } },
  "escrowed": { "amount": "18406227.318004", "escrows": 2140, "coverage": { "from_ledger_index": 2, "complete": true } },
  "circulating": { "amount": "594995554.799302", "coverage": { "from_ledger_index": 2, "complete": true } },
  "reserves": { "amount": "268973.2", "accounts": 186412, "owner_count": 412806, "base": "1", "increment": "0.2",
                "coverage": { "from_ledger_index": 2, "complete": true } }
}
```

- **Key order**: `result, ledger_index, close_time, computed_at, currency, total, burned, minted, escrowed, circulating, amm, reserves`;
  inside a part, its amount first, then its counts, then `coverage` last. `minted` only on a network that mints (its columns not NULL),
  `amm` only where AMM exists, `reserves` only with reserve values; `burned` has `coverage` only on Xahau. `circulating` repeats
  escrowed's coverage (total needs none). `minted.amount` = the sum of the three sources.
- `close_time` is the snapshot ledger's (`YYYY-MM-DDTHH:mm:ssZ`); `computed_at` when the row was written.
- **Errors**: 404 `supply not computed yet` (no snapshot); 500 `unable to retrieve supply`.
- **Cache**: the default `Cache-Control: private, max-age=60`. **Query bound**: one granule of `network_supply` (the read of the end of
  the key).

### 5.2 `GET /v2/network/supply/minted`

The native currency minted per UTC day, by source (Xahau). Parameters in the style of `network/fees`:

| Parameter | Default | Meaning |
| --- | --- | --- |
| `interval` | `day` | `day` only; anything else answers 400 `invalid interval` |
| `start` | the minted coverage start | |
| `end` | the newest ledger | |
| `descending` | false | |
| `limit` | 200 (max 1000) | |
| `marker` | | the start of the last row's day (unix seconds) |
| `format` | json | `csv`: file `network minted.csv` |

A day is a row when it starts within `start` and `end`, the index has a ledger in it, and every ledger of it is covered (the day after
the day `coverage.from_ledger_index` closed in, unless that ledger is `firstLedger`): a covered day with no mint is a row of zeros. The
newest day is the running one, summed so far.

```json
{ "result": "success", "coverage": { "from_ledger_index": 2, "complete": true }, "marker": "…", "count": 2,
  "rows": [
    { "date": "2026-10-22T00:00:00Z", "amount": "33012.405218", "rewards": "29512.338912", "import": "3500.066306", "genesis_mint": "0" },
    { "date": "2026-10-23T00:00:00Z", "amount": "71203.1", "rewards": "30102.5", "import": "1100.6", "genesis_mint": "40000" }
  ] }
```

- Key order: `result, coverage, marker, count, rows` (`coverage` right after `result`, D3's convention for lists; the minted feature of
  1.5); a row `date, amount, rewards, import, genesis_mint` (`amount` the day's sum).
- On XRPL: `{ "result": "success", "coverage": { "from_ledger_index": …, "complete": true }, "count": 0, "rows": [] }` (nothing is
  minted: D3's rule for a feature the network cannot have, as D5's delegations on Xahau; no table is read).
- Reads: the days resolve to a ledger range through `LedgerRangeResolver`; `mintSums(ch, L1, L2, true)`; the zero days and the page are
  made in the service, `limit + 1` days, the marker by `paginate`. Errors: 400 `invalid start date format`, `invalid end date format`,
  `invalid interval`, `invalid marker`; 500 `unable to retrieve minted supply`.
- **Query bound**: the P6 key ranges of the window's ledgers in `genesis_mints`, `imports` and `reward_claims` (256 ledgers more), at most
  1,000,000 ledgers a read.

### 5.3 Documentation of the wire

- `docs/api-reference.md`, Network: both routes with the examples above, the parts and their definitions (Facts F1 to F5 in words), the
  coverage of each part, and the Compatibility list of routes the original did not have.
- `docs/adr/0010-ripple-v2-wire-compatibility.md`: the next items: "`GET /v2/network/supply`. The original had
  `/v2/network/xrp_distribution` (out of scope, 404) and no supply route. Here one snapshot an hour, every figure in exact text and
  each history-derived part with its coverage" and "`GET /v2/network/supply/minted`: Xahau's minting, by day and source; empty on XRPL".
- `docs/openapi.yaml` regenerated.

## 6. Query bounds (what the tests pin)

| Read | Bound | Test |
| --- | --- | --- |
| `newestSnapshot` | one granule (`read_rows` ≤ 8,192) | `supply.e2e-spec.ts` |
| an account range | `EXPLAIN indexes = 1` shows the primary key condition on `account`; `read_rows` ≤ the rows of `[lo, hi)` (seeded bulk of four parts) | `supply-job.e2e-spec.ts` |
| the AMM fill-forward | `fillForward`'s own bounds (unchanged) | existing |
| Xahau burned | `ledgers` up to L, nothing else | `supply-job.e2e-spec.ts` |
| `mintSums` slice | the P6 key ranges of the slice (`read_rows` ≤ the slice's rows + 256 ledgers of claims) | `supply-minted.e2e-spec.ts` |
| the network_state / SetFee read | one granule each | `supply-job.e2e-spec.ts` |

## 7. XRPL, Xahau and the sandbox

| | XRPL | Xahau |
| --- | --- | --- |
| total | `total_coins` | `total_coins` |
| burned | 10¹⁷ − `total_coins`, exact, no coverage | Σ `fee_total`, coverage from the first stored ledger |
| minted | none | rewards, import, genesis_mint |
| escrowed | D5 (XRP) | D5 (XAH) |
| AMM | yes | none (no amendment): `amm` left out, step skipped |
| reserves | yes | yes |

The sandbox's testnets (D-env profiles) are the same code: XRPL Testnet's genesis has 100 billion XRP too. A testnet has no
`firstLedger` and ignores the metadata file's enable ledgers (D3 §4, D-env §12), so every part's `complete` is false there.

## 8. Backfill, reprocess and rollout

1. Apply the migration before the syncer and the api of this release (the writer fails without the three tables; the api reads
   `network_supply`).
2. Deploy the syncer and the api. The `supply` job starts its first cycle once D5's escrows sentinel exists; the route answers 404 `supply
   not computed yet` until the first cycle ends (minutes today; up to an hour at full history).
3. **Xahau minting history**: `range-ingest --from <firstLedger> --to <deploy ledger> --reprocess` on Xahau writes the three tables for
   the whole history (Xahau is about 27 million ledgers; the same command as D5's re-ingest, so the two can share one run when D5's has
   not been done). Until then `minted` and the minted days start at the deploy ledger (`complete: false`).
4. XRPL needs no reprocess for D7: total and burned need no history; escrowed, AMM and reserves follow D5's, the AMM data's and PR #20's
   coverage. Reserves become complete only with the history spec (ledger 32,570's state); until then the explorer shows the notice.
5. `docs/backfill.md` gets "Supply" (the Xahau reprocess and D3's coverage query for `MINT_PARSER_VERSION`: `SELECT
   maxOrNull(ledger_index) FROM xahau.ledgers WHERE parser_version < <MINT_PARSER_VERSION>`) and `docs/operations.md` "Supply snapshots"
   (how to read the newest snapshot, the gauges, that a reprocess or backfill shows in the figures at the next cycle, within an hour,
   while `coverage` changes at once).

## 9. Documentation to update (in the same change)

- `docs/data-model.md`: the four tables (sections 2 and 3), the migration row, the table count, the relationships diagram.
- `docs/syncer.md` §7: the `supply` row of the jobs table and a subsection "7.x `supply`" (the cycle, L, the steps, the budget, the cost).
- `docs/api-reference.md`, ADR-0010, `openapi.yaml` (5.3); `docs/backfill.md`, `docs/operations.md` (8); `docs/observability.md` (the two
  gauges and the alert).
- `rows.ts` (`MINT_PARSER_VERSION` and its history line), `packages/shared/test/fixtures/README.md` (the new recordings).
- No new ADR: the job is a precomputed aggregate of ADR-0008's kind, and the snapshot rule is in syncer.md.

## 10. Testing

**Task 1, recordings** (`record:fixtures`, `packages/shared/test/fixtures/xahau/recorded/`, manifest `found` and `cases`): an `Import`
that creates its account (first import: fee 0, starting bonus), an `Import` into an existing account (fee > 0), each together with its
parent ledger (for the invariant); a `ClaimReward` with `tfOptOut`; a `GenesisMint` whose parent is not a `ClaimReward`, if mainnet has
one (the plan searches `tx_by_type` of a full-history node; if there is none, a hand-made case derived from 26540188 with another parent
hash); an `AccountDelete` on Xahau (reserves). XRPL needs no new recording (`account-state/` has an `AccountDelete`, `amm/` the pools).
Task 1's `FINDINGS.md` confirms the opt-out bit, the Xahau `firstLedger`, and that an `Import` with a non-`tes` inner transaction still
mints (F5 says it does: the key imports only depend on it).

**Unit** (`packages/shared`):
- `rewards.parser.spec.ts`, `import.parser.spec.ts`: rows of every recorded case; a failed `GenesisMint`/`Import` gives none; an entry
  without `Amount` is skipped with its index kept; deep-frozen input; XRPL ledgers give no rows.
- `build-rows.spec.ts`: the snapshot of 26540187 and 26540188 gains the new rows; **the invariant** of section 2 on every recorded parent
  and child pair; key uniqueness per table.
- `supply.spec.ts` (shared): the account prefixes (3,364, byte order, the last range ends at `s`), the reserve arithmetic, the native
  side of a pool, the parts that are NULL per network.
- `supply.job-runner.spec.ts`: a cycle starts only after `SUPPLY_INTERVAL_MS` from the newest `started_at`; waits while L's conditions
  fail and warns once after 10 ticks; runs steps until the budget and resumes at the next tick; a failed step is retried, three failures
  drop the cycle with the backoff; a shutdown writes nothing; the row has the sums of every step.
- `aggregator.schedule.spec.ts`: `supply` is last and does not starve the live jobs.

**End-to-end** (seeded ClickHouse, `apps/api/test/`, `apps/syncer/test/`):
- `supply-job.e2e-spec.ts`: a seeded database (ledgers with `total_coins` and fees, `account_states` with created, modified, deleted and
  pool accounts across two partitions and rows written twice, `network_state` and a `SetFee` fallback, `amm_pools` rows before and after L,
  `amm_pool_states` for the fill-forward, D5's escrows sentinel, Xahau mint rows): one full cycle's row equals a hand-computed one; the
  query bounds of section 6.
- `supply.e2e-spec.ts`: both networks' answers with exact key order; 404 `supply not computed yet`; parts left out (no AMM, no reserve
  values, XRPL without `minted`); coverage complete and incomplete; 401 without a key.
- `supply-minted.e2e-spec.ts`: days with mints, zero days, the first covered day, the running day, `descending`, `limit` clamp, marker
  pages concatenated = the unpaged list, CSV, every error message, XRPL empty with `complete: true`.
- `ingest-state` e2e: `LEDGER_KEYED_TABLES` matches the schema's partitioning (the existing comparison catches the three tables).

## Dependencies

- **D3**: `FeatureCoverageService` with its no-amendment case, `NetworkProfile.firstLedger`, `newestLedgerBelowVersion` and the
  `coverage` shape and placement (D7 declares five features, 1.5; its per-part `coverage` is D3's rule for an answer with parts).
- **D5**: `readEscrowed`, the escrows sentinel written with its watermark on every run (D5 §4.1 step 5), the amendments config, the
  escrows coverage feature. D7 is built after D5.
- **PR #20**: `account_states` (migration 005, `STATE_PARSER_VERSION`); reserves are complete only after the history spec's ledger 32,570.
- **D1**: `network_state` (reserves; the `SetFee` fallback covers its absence).
- **The AMM data**: `amm_pools`, `ammPoolsWatermark`, `fillForward`.
- **Family 5** (Xahau-native, not built): D7 builds `genesis_mints`, `imports` (subset), `reward_claims` (ledger-ordered) and the two
  parsers with family 5's names; family 5 extends them and must read this spec's decision 7.
- **E12** reads both routes; it reads burned per day from the existing `/v2/network/fees?interval=day`.
