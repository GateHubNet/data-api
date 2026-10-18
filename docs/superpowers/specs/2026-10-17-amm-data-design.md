# AMM data: design

Date: 2026-10-17. Status: proposed. Builds on the Ripple v2 drop-in (`2026-10-15-ripple-dropin-design.md`, rulings in `../plans/2026-10-15-ripple-dropin.rulings.md`).

## Context

The original Ripple Data API's last commit is from May 2021. Its ledger parser knew payments, offers/exchanges, escrows, payment channels, balance changes and account creation. Since then many amendments went live. Checked with `feature` on `wss://s2.ripple.com` and `wss://xahau.network` on 2026-10-17, the ones that add transaction types or ledger objects are:

| Network | Enabled amendment | New transactions | New objects |
|---|---|---|---|
| XRPL | AMM, AMMClawback | `AMMCreate`, `AMMDeposit`, `AMMWithdraw`, `AMMVote`, `AMMBid`, `AMMDelete`, `AMMClawback` | `AMM` |
| XRPL | NonFungibleTokensV1_1, NFTokenMintOffer, DynamicNFT | `NFTokenMint/Burn/CreateOffer/CancelOffer/AcceptOffer`, `NFTokenModify` | `NFTokenPage`, `NFTokenOffer` |
| XRPL | MPTokensV1, TokenEscrow | `MPTokenIssuanceCreate/Destroy/Set`, `MPTokenAuthorize`; MPT amounts in Payment and escrows | `MPTokenIssuance`, `MPToken` |
| XRPL | Clawback, PriceOracle, DID, Credentials, PermissionedDomains, PermissionDelegationV1_1, PermissionedDEX, TicketBatch, BatchV1_1, NegativeUNL | `Clawback`, `OracleSet/Delete`, `DIDSet/Delete`, `Credential*`, `PermissionedDomainSet/Delete`, `DelegateSet`, domain offers, `TicketCreate`, `Batch`, `UNLModify`, `LedgerStateFix` | `Oracle`, `DID`, `Credential`, `PermissionedDomain`, `Delegate`, `Ticket`, `NegativeUNL` |
| Xahau | Hooks, XahauGenesis/BalanceRewards, Import, URIToken, Remit, Remarks, Cron, PriceOracle, Clawback, PaychanAndEscrowForTokens | `SetHook`, `Invoke`, `ClaimReward`, `GenesisMint`, `Import`, `EmitFailure`, `URIToken*`, `Remit`, `SetRemarks`, `CronSet`, `Oracle*`, `Clawback` | `Hook`, `HookDefinition`, `HookState`, `EmittedTxn`, `ImportVLSequence`, `URIToken`, `Cron`, `Oracle`, `UNLReport` |

These are not enabled on mainnet and are out of scope: XChainBridge, SingleAssetVault, LendingProtocol, Sponsor, ConfidentialTransfer. Xahau has no AMM.

Every transaction is already stored and listable by type. What is missing is dedicated parsing, as the original had for its own types. The user decided the work is split per family, one spec and plan each, and that **AMM comes first**. This spec covers AMM only. NFTs/URITokens, MPTokens and the Xahau-native families get their own specs later.

## Decisions (from the user)

| Topic | Decision |
|---|---|
| Swaps | Swaps against a pool **are exchanges**. They appear in `/v2/exchanges` and everything built on exchanges: candles, reduce, exchange rates, normalize, active accounts and trade volume. They are marked, and they can be filtered with `amm=include\|exclude\|only` (default `include`). |
| AMM data | New endpoints cover all of: pools and pool history, liquidity events, votes and auction bids, AMM volume and daily pool stats. |
| Pools before the start ledger | Ingest only, like every other endpoint. Complete data needs a range-ingest from the AMM enablement ledger (March 2024) with `--reprocess`. Until then a pool appears when it is first touched. |
| Architecture | Approach A: one AMM parser, with swaps written into the existing `exchanges` table. |

## How AMM activity looks on the ledger

The facts below were checked on recorded mainnet ledgers in `packages/shared/test/fixtures/xrpl/amm` (README section "XRPL AMM cases", which has the counts).

- **The pool account.** Every pool has a pseudo-account: an `AccountRoot` whose fields include `AMMID`. It holds the pool's XRP in its `Balance`; an IOU/IOU pool's balance is 0. It holds IOU reserves on trust lines with each issuer. Those lines carry `lsfAMMNode` (0x01000000) and the reserve bit of the pool's side (`lsfLowReserve` 0x10000 when the pool is the low account, `lsfHighReserve` 0x20000 when it is the high one). It issues the LP token, whose currency is a 40-hex code starting with `03`; the holders' LP-token lines have no `lsfAMMNode`.
- **The `AMM` object** holds the pool's settings, not its reserves:
  - `Account` (the pool account), `Asset` and `Asset2`;
  - `LPTokenBalance` (the LP-token supply);
  - `TradingFee`, in units of 1/100000;
  - `VoteSlots` and `AuctionSlot` (`Account`, `Price`, `DiscountedFee`, `Expiration`, `AuthAccounts`).
- **A swap** is a `Payment` or `OfferCreate` whose path goes through the pool. Its metadata changes the pool account's `AccountRoot` and/or its trust lines. The `AMM` object is not touched. How the pool shows depends on its assets:
  - an XRP/IOU pool shows its `AccountRoot` (its XRP moved) and its one `lsfAMMNode` trust line, in every swap seen;
  - an IOU/IOU pool shows neither its `AccountRoot` nor its `AMM` node, only its two `lsfAMMNode` trust lines (all 1,852 swaps of the RLUSD/USDC pool).

  One path can cross several pools, in which case each pool appears with its own nodes.
- **Deposits, withdrawals, votes, bids, create, delete and clawback** modify the `AMM` object, so its `Account` names the pool. An IOU/IOU pool's deposits and withdrawals don't show its `AccountRoot`; single-asset XRP ones show no pool trust line; a vote shows only the pool's `AMM` node. The transaction's `Asset`/`Asset2` order is not the canonical pair order.
- **Created and deleted nodes.** `NewFields` leave out fields at their default: the `AMM` node of a new XRP/IOU pool has no `Asset` (XRP is the default). A field at its default is also left out of a stored entry: vote entries for a fee of 0 have no `TradingFee`. A pool trust line removed by a withdraw-all is a `DeletedNode` whose `Flags` no longer have the reserve bit (its `PreviousFields.Flags` still do).
- **An LP-token transfer** between holders shows only the two holders' LP-token lines, with the pool as issuer.

## 1. Storage

All new tables go into the baseline schema `packages/shared/schema/001_baseline.sql`, which is not deployed yet, so it is changed in place. They follow the existing conventions:

- `ReplacingMergeTree`, with ORDER BY as the unique key;
- exact amounts stored as `String`, with `*_f Float64` shadows where aggregated;
- `ledger_index` as the time axis;
- no FINAL on list reads.

Tables written by ingest are **ledger tables**. They join the set that `LedgerWriter`, recovery deletes and range-ingest redo already handle: dedup tokens, child tables first and `ledgers` last, partition-scoped deletes, and `non_replicated_deduplication_window`.

**Changed tables**

- `exchanges` and `account_exchanges`: add `amm_account String` (empty for order-book trades).
  - In an AMM row, `provider` is the pool account and `offer_sequence` is 0.
  - `node_index` is the index, in `AffectedNodes`, of the pool account's `AccountRoot` node. If that node is absent, it is the pool's first reserve line (an `lsfAMMNode` trust line, section 2.1). This keeps the key unique, and order-book rows never use those nodes.

**New ledger tables**

| Table | Partition | ORDER BY | Holds |
|---|---|---|---|
| `amm_pool_states` | P7 | `(amm_account, ledger_index, tx_index)` | One row per pool and transaction that touched the pool. Columns: `tx_hash`, `close_time`, `tx_type`, the pool's assets in canonical pair order (`base_*`, `counter_*`), and the values after the transaction. The values are `reserve_base`, `reserve_counter`, `lp_supply`, `lp_currency`, `trading_fee`, `auction_holder`, `auction_price`, `auction_discounted_fee`, `auction_expiration` and `deleted`. A value is `Nullable` and filled whenever its node is present in the metadata (the value after the transaction, whether or not the transaction changed it); readers carry the last known value forward. |
| `amm_pool_touches` | P6 | `(ledger_index, tx_index, amm_account)` | One row per `amm_pool_states` row, with only those three columns: a narrow index in the order of the ledgers (Ruling R-A14). `amm_pool_states` is ordered by pool, so once its parts have merged its `ledger_mm` skip index prunes no granule and a "which pools changed after this ledger" scan would read the whole partition. The aggregator's watermark scan and its `agg_dirty` slices read this table by a range of its primary key, never `amm_pool_states`; the one scan for stale pools when the aggregator starts reads all of it (it is narrower than the state table). It is built in `buildLedgerRows` next to the state rows, with the same dedup tokens, recovery and redo. |
| `amm_liquidity` | P7 | `(amm_account, ledger_index, tx_index)` | One row per create, deposit, withdraw, clawback or delete. Columns: `account` (the LP), `initiator` (differs for clawback), `event`, `mode` (from the flags: `lp_token`, `single_asset`, `two_asset`, `one_asset_lp_token`, `limit_lp_token`, `two_asset_if_empty`, `withdraw_all`, `one_asset_withdraw_all`), `base_amount`, `counter_amount` (signed, pool perspective: + in, − out), `lp_tokens` (signed: + minted, − burned), plus `_f` shadows. |
| `account_amm_liquidity` | P7 | `(account, ledger_index, tx_index, amm_account)` | A narrow index for per-account lists, like `account_payments`. It has the same columns as `amm_liquidity`. |
| `amm_governance` | P7 | `(amm_account, ledger_index, tx_index)` | One row per `AMMVote` or `AMMBid`. Columns: `kind`, `account`, `fee_voted` (vote), `trading_fee_after`, `bid_min`, `bid_max`, `price_paid` (LP tokens burned by the bid), `slot_holder`, `slot_discounted_fee`, `slot_expiration`, `auth_accounts`. |

**New aggregate tables.** These are written by the syncer's aggregator, are recomputable, and use `ReplacingMergeTree(version)`.

| Table | ORDER BY | Holds |
|---|---|---|
| `amm_pools` | `amm_account` | The current state of each pool, for the pool list. Columns: the assets, `lp_currency`, `created_ledger`, `created_by`, `last_ledger`, `reserve_base`, `reserve_counter`, `lp_supply`, `trading_fee`, the auction slot, `deleted`, `value_native` and `version`. `created_ledger` and `created_by` are the ledger and the sender of the earliest ingested `amm_liquidity` row with event `create` for the pool, and null when none was ingested (a pool first seen in the middle of its life). The aggregator rebuilds it from `amm_pool_states` (and that create row), never ingest. A crash recovery that deletes a newer state row therefore cannot lose a pool's state after a merge. |
| `amm_daily` | `(amm_account, day)` | One row per pool per UTC day with activity, plus a closing state. Columns: `swap_count`, `volume_base`, `volume_counter` (the amounts that went in, by side), `fees_base_est`, `fees_counter_est`, `deposit_count`, `withdraw_count`, liquidity in and out per side, the end-of-day reserves, `lp_supply`, `trading_fee`, `value_native`, `final`, `config_version` and `version`. A day is a **version set**: its pool rows and a **sentinel** row (`amm_account` `''`, empty assets, zero amounts and counts, null state) carry one `version`. A reader takes the version of a day from its sentinel (`WHERE amm_account = '' AND day = ...` is a prefix of the primary key), keeps the pool rows with that version, and never returns the sentinel itself or a row of an older set (a pool-day that vanished from a recompute has no row in the newer set). `final` is 1 on the sentinel of a set made once the ingest had passed the day, 0 on every other row; `config_version` is the version of the computation (`AMM_DAILY_CONFIG_VERSION`, bumped when it changes so that the days are computed again). |

**AMM network volume** becomes a third metric, `amm_volume`, in the existing `volume_live` and `volume_daily` sets. It needs no new table.

**LP positions** need no table either. LP tokens are trust lines issued by the pool account, so `balance_changes` already records them.

## 2. Parsing

A new pure parser, `packages/shared/src/parsers/amm.parser.ts`, plugs into `buildLedgerRows` next to the existing ones. It follows the same rules: deep-frozen input, `ParseContext`, and a successful (`tes*`) transaction only.

1. **Pools in a transaction** (amended by ruling R-A6). The pools are:
   - the `Account` of every `AccountRoot` node with `AMMID`;
   - the `Account` of every `AMM` node (created, modified or deleted);
   - for every `RippleState` node with `lsfAMMNode` (0x01000000), the side that holds the reserve: `LowLimit.issuer` for `lsfLowReserve` (0x10000), `HighLimit.issuer` for `lsfHighReserve` (0x20000). A line with neither bit (a deleted line) or both belongs to whichever of its two sides is a pool named by an `AccountRoot` or `AMM` node of the same transaction. A line for which that is not exactly one side names no pool and counts as unclassified (2.3).

   These `lsfAMMNode` lines are the pool's **reserve lines**. A trust line without `lsfAMMNode`, such as an LP-token line the pool issues, belongs to no pool: an LP-token transfer touches none and gives no rows. Nodes without `NewFields` or `FinalFields` are skipped. The parser does not keep state across ledgers.
2. **Pool deltas and pair.** For each pool, take the change in each asset it holds, from `PreviousFields` to `FinalFields` (from nothing to `NewFields` for a created node; a field absent from `PreviousFields` did not change):
   - XRP from `AccountRoot.Balance`, in drops, turned into whole XRP the way order-book rows are;
   - an IOU from the reserve line with its issuer, from the pool's side, which means flipping the sign when the pool is the high account.

   An asset with no node in the metadata has a delta of 0 and no known reserve. LP amounts come from `LPTokenBalance` (2.4), not from trust lines. The pool's pair is `Asset` and `Asset2` of its `AMM` node when that is present, a missing asset being XRP. Otherwise it is the assets of its reserve lines, plus XRP when its `AccountRoot` shows a non-zero balance before or after. Base and counter follow `canonicalPair`. A pool whose pair this does not give as exactly two assets gets no rows and counts as unclassified. That includes a pool with an MPT asset (an `Asset` or `Asset2` with an `mpt_issuance_id`, which this parser does not know): it is unclassified and gets no rows.
3. **Swaps.** In a `Payment` or `OfferCreate`, a pool whose two non-LP deltas have opposite signs is a swap: one asset in, the other out.
   - It becomes one `exchanges` row in the canonical pair order of the existing exchange parser, with amounts equal to the absolute deltas.
   - `rate` uses the same formula and string rules as the order-book rows: counter over base, exact text. It is what `ExchangeParser` gives for an offer owned by the pool with these amounts: the quality is what the pool received over what it paid, in whole units, and it is inverted when base is what the pool received.
   - `taker` is the transaction `Account`. If base flowed out of the pool, `buyer` is the taker and `seller` is the pool; otherwise the reverse.
   - `node_index` is the index of the pool's `AccountRoot` node, or of its first reserve line when that is absent (section 1).
   - `provider` and `amm_account` are the pool, and `offer_sequence` is 0.
   - `tx_type`, `client` and the autobridged fields follow the existing rules. An `OfferCreate` crossing books through XRP is autobridged whether a leg was an offer or a pool.
   - A pool whose deltas don't form exactly one in and one out in a `Payment` or `OfferCreate` writes a state row but no swap. It is also counted in a Prometheus counter, `syncer_amm_unclassified_total`. The count takes every pool of a transaction that gets no swap, liquidity event or governance row, plus the pools and reserve lines of 2.1 and 2.2 that give no rows at all.
4. **Liquidity events.** These come from `AMMCreate`, `AMMDeposit`, `AMMWithdraw`, `AMMClawback` and `AMMDelete`:
   - Amounts are the pool deltas.
   - `lp_tokens` is the change in `LPTokenBalance` on the `AMM` node: the `NewFields` value for a create, and the full previous balance, negated, when the node is deleted.
   - `account` is the transaction `Account`, except for `AMMClawback`, where it is the `Holder` and `initiator` is the issuer.
   - `mode` is derived from the transaction flags of an `AMMDeposit` or `AMMWithdraw`: the one mode flag set. Create, delete and clawback have no mode, and neither has a transaction with no mode flag or several.
   - A withdrawal that empties the pool deletes the `AMM` node. It writes a `withdraw` event, and the state row is marked `deleted`.
5. **Governance.**
   - An `AMMVote` row records the voter, the transaction's `TradingFee` and the resulting `TradingFee` of the `AMM` node.
   - An `AMMBid` row records the bidder, `BidMin` and `BidMax`, and `price_paid` (the LP tokens the bid burned, from the change in `LPTokenBalance`). It also records the new `AuctionSlot` fields; `auth_accounts` is empty when the slot has none.
6. **State rows.** Every pool touched by a transaction gets one `amm_pool_states` row:
   - The reserves come from the nodes present: the balance after the transaction, in whole units.
   - `lp_supply`, `trading_fee` and the auction fields come from the `AMM` node, when it is in the metadata. A missing `TradingFee` or `DiscountedFee` is 0.
   - `deleted` is set when the `AMM` node or the pool `AccountRoot` is deleted. `lp_supply` is then '0', but only when the `AMM` node is in the metadata; without it `lp_supply` stays null like the other `AMM` fields.
   - Anything the transaction did not touch is left null.
   - Rows come in the order of each pool's first node in `AffectedNodes`.
7. **Balance changes.** Nothing changes in `balance_changes`. Pool accounts are already treated as ordinary accounts there (ruling R14).

The parser version is bumped (`ledgers.parser_version`) so that `--reprocess` over existing ranges is needed and visible.

## 3. API

All new routes use the existing contract layer:

- `@RippleController` / `@RippleRoute` with Ripple-shaped errors (`unable to retrieve <thing>` on 500);
- the API key and rate limit;
- `limitParam` (default 200, max 1000), base64url keyset markers, the `Link` header, and `format=csv` with flattening;
- dates resolved once to a ledger range, and the shared bounded paging helper (`readDistinctPage`, R106).

New objects follow the existing formatting rules:

- amounts are exact strings, and `rate` uses `precision8`;
- times use `fmtTime`;
- undefined keys are omitted.

Key order is fixed by tests. There is no Ripple contract to match, so the order is ours. A pool is addressed by its pool account address. The pair form is `{base}/{counter}`, using the same asset syntax as `/v2/exchanges/:base/:counter`, in either order.

| Route | Params | Response |
|---|---|---|
| `GET /v2/amm/pools` | `asset`, `asset2` (either or both filter pools containing them), `include_deleted` (default false), `limit`, `marker`, `format` | `{result, count, marker?, pools:[Pool]}`, ordered by `value_native` desc, then `amm_account` |
| `GET /v2/amm/pools/:pool` and `GET /v2/amm/pools/:base/:counter` | — | `{result, pool: Pool}`; 404 `pool not found` |
| `GET /v2/amm/pools/:pool/history` | `start`, `end`, `interval` (none = every state change; `day` = `amm_daily` rows), `descending`, `limit`, `marker`, `format` | `{result, count, marker?, history:[PoolState] \| days:[PoolDay]}`, with values carried forward |
| `GET /v2/amm/pools/:pool/swaps` | the same params as `/v2/exchanges/:base/:counter` (no `interval` or `reduce`) | `{result, count, marker?, exchanges:[Exchange]}`: the pool's exchange rows, in the pool's canonical pair |
| `GET /v2/amm/pools/:pool/liquidity` | `start`, `end`, `event`, `account`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, liquidity:[LiquidityEvent]}` |
| `GET /v2/amm/pools/:pool/governance` | `start`, `end`, `type=vote\|bid`, `descending`, `limit`, `marker`, `format` | `{result, count, marker?, governance:[Vote \| Bid]}` |
| `GET /v2/accounts/:address/amm_liquidity` | `start`, `end`, `pool`, `event`, `descending`, `limit`, `marker`, `format` | the account's liquidity events |
| `GET /v2/accounts/:address/amm_positions` | `date` (default now) | `{result, positions:[{pool, lp_currency, lp_balance, share, base_amount, counter_amount}]}` |
| `GET /v2/network/amm_volume` | the same params and semantics as `/v2/network/exchange_volume`: live periods hour/day/3day/7day/30day, or `start`/`end`/`interval` day/week/month, plus `exchange_currency`/`exchange_issuer`, `limit`, `marker`, `format` | `{result, count, marker?, rows}`. Each row's components are pools with swap volume in the window, as `{amm_account, base, counter, count, amount, rate, converted_amount}`, sorted by `converted_amount` desc. |

**`amm_positions` details.** It takes the account's last LP-token balance per pool at `date` from `balance_changes`, for LP currencies of known pools with a non-zero balance. Then:

- `share` is `lp_balance / lp_supply` of that pool at the same point.
- The base and counter amounts are the share times the reserves.

**Pair form.** `GET /v2/amm/pools/:base/:counter` serves the **live pool of the pair** and, when the pair has none, the pool that was deleted last (the highest `last_ledger`), then the lowest account: a pair can have had several pools, each deleted before the next was created. The assets may be given in either order.

**History carry-forward.** A state row holds only the values its transaction's metadata carried, so the history of a pool fills every value from the newest earlier row, also from before `start`. The carry-in for a page is read from a window of `AMM_HISTORY_CARRY_LEDGERS` (2,048, about two hours) ledgers before the page, a range of the pool's primary key, and further back in doubling steps only for a column that is still null and a pool that has older rows (`fillForward`, Rulings R-A21 and R-A23). The aggregators use a window of `AMM_FILL_WINDOW_LEDGERS` (160,000, about a week).

**Object shapes** (Ruling R-A24). There is no Ripple contract, so the shapes are ours, written once in `apps/api/src/amm/amm-objects.ts` (the key order is pinned by tests and is the order below). Keys are flat (`base_currency`, `base_issuer`, `counter_currency`, `counter_issuer`, in the pool's canonical pair order, no issuer key for the native currency); amounts are exact strings; `value_native` is a string, a plain decimal of eight significant digits without the exponent form; `trading_fee` is a number in units of 1/100000; times are `fmtTime`; an undefined or null value is left out; `deleted` is a boolean; the auction fields are grouped as `auction_slot {holder?, price?, discounted_fee?, expiration?}` and left out when the pool has none of them.

| Object | Keys, in order |
|---|---|
| `Pool` | `amm_account, base_currency, base_issuer?, counter_currency, counter_issuer?, reserve_base?, reserve_counter?, lp_supply?, lp_currency?, trading_fee?, auction_slot?, value_native?, created_ledger?, created_by?, last_ledger, deleted` |
| `PoolState` | `amm_account, ledger_index, tx_index, tx_hash, tx_type, executed_time, base_currency, base_issuer?, counter_currency, counter_issuer?, reserve_base?, reserve_counter?, lp_supply?, lp_currency?, trading_fee?, auction_slot?, deleted` |
| `PoolDay` | `amm_account, date, base_currency, base_issuer?, counter_currency, counter_issuer?, swap_count, volume_base, volume_counter, fees_base_est, fees_counter_est, deposit_count, withdraw_count, liquidity_in_base, liquidity_in_counter, liquidity_out_base, liquidity_out_counter, reserve_base?, reserve_counter?, lp_supply?, trading_fee?, value_native?` |
| `LiquidityEvent` | `amm_account, ledger_index, tx_index, tx_hash, executed_time, account, initiator, event, mode?, base_amount, counter_amount, lp_tokens` |
| `Vote` | `amm_account, ledger_index, tx_index, tx_hash, executed_time, type, account, fee_voted?, trading_fee_after?` |
| `Bid` | `amm_account, ledger_index, tx_index, tx_hash, executed_time, type, account, bid_min?, bid_max?, price_paid?, auction_slot?` (`auction_slot {holder?, discounted_fee?, expiration?, auth_accounts}`) |
| `Position` | `pool, lp_currency, lp_balance, share, base_amount?, counter_amount?` |

`volume_*` of a `PoolDay` are the amounts that went into the pool, by side, and `fees_*_est` are estimates. The event objects carry no pair (read it from `GET /v2/amm/pools/:pool`). A pool found as soon as one of its ledgers is committed (`amm_pool_states`) is the rule of the history, days, swaps, liquidity and governance routes; the detail and the pair form read `amm_pools` and so answer 404 for a brand-new pool until the next aggregator tick (about a minute).

**Changes to existing routes**

- **Exchange objects** gain a last key, `amm_account`, only on AMM rows. Order-book rows are unchanged.
- **The `amm` filter** is accepted by `/v2/exchanges/:base/:counter` (raw, `interval` and `reduce`), `/v2/exchanges` and `/v2/accounts/:address/exchanges`.
  - Values are `include` (default), `exclude` and `only`.
  - Anything else gives 400 `invalid amm filter - use: include, exclude, only`.
- **Exchange rates, normalize, active accounts and trade volume** always include AMM swaps. They take no filter parameter.
- **Native dust legs** (≤ 0.0005) are dropped from AMM rows exactly as from order-book rows in the aggregates built on exchanges (candles, `reduce`, exchange rates, normalize, active accounts, trade volume and AMM volume). The per-pool daily stats (`amm_daily`) count every swap (Ruling R-A20): they describe the pool, not a price series.

**Pool value.** `value_native` is computed as follows:

- If one of the assets is native, it is 2 × the native reserve. This is exact for a constant-product pool at equilibrium.
- Otherwise it is 2 × a reserve ÷ that asset's daily native rate. The rate is the units of the asset that one native coin buys, from `RatesService.dailyNativeRates` for the UTC day of the pool's last state, and the same one the volume sets divide by (`converted = amount / rate`). The asset tried first is the base, then the counter, and one without a reserve or a rate is skipped.
- If neither asset has a rate, `value_native` is omitted.
- A deleted pool has no value (`value_native` is omitted), so that it does not rank among the live pools in a list sorted by value.

**Fees.** Earned fees are estimates. Each swap's input amount is multiplied by the pool's trading fee at that point, or by the auction slot's discounted fee when the taker is the slot holder or one of its authorized accounts, divided by 100000. They are named `*_est` in responses and documented as estimates.

**Xahau.** The AMM routes exist there too, and answer empty lists, 404 `pool not found`, or zero volume.

## 4. Aggregation

There are two new aggregator jobs in `apps/syncer/src/aggregator`, `amm_pools` and `amm_daily`, and one new metric of the volume jobs, `amm_volume`. They use the existing tick, budgets (R83), finality rules (R86) and failure ordering (R87). The budgets and the cadence are constants of `aggregator.service.ts`, not environment variables.

- **`amm_pools`.** Every tick, it recomputes the pools whose states changed since its watermark, plus pools in `agg_dirty` ranges. Both are found in `amm_pool_touches`.
  - The watermark is a ledger index kept in memory and found again at start: the ledger before the oldest state row that its pool's newest `amm_pools` row has not seen.
  - Only committed ledgers count: the ledger writer fills the tables of a ledger at the same time and writes its `ledgers` row last, so the scans and the rebuild read up to the newest `ledgers` row, and a pool is returned only while it has a row above what its `amm_pools` row has seen (a busy pool rebuilt up to the head is not returned again).
  - A batch of pools that fails is halved to find the pools that fail on their own (Ruling R-A15). The halving is kept **across ticks**: when the budget runs out in the middle of it, the next tick goes on with the same batch from the list it stopped at and the cursor stays where it was, instead of asking for the pools again and halving from the whole batch (which would never get further). More than three pools failing on their own in one batch means the cause is not the pools, and the batch is the failure of the job.
  - The pools that fail alone are set aside in memory, each counted as an error, with a backoff of 5 minutes doubling up to an hour, and the cursor goes on (the retries run at every tick, also when the live part failed). This happens on **partial success** only: something in the batch worked, or the batch is a **repeat** (the very same batch comes again after every one of its lists failed, and the same pools fail alone again). A batch in which everything fails the first time is the failure of the job: it is counted and logged, the cursor stays behind it, and the next tick tries it again.
  - A list that failed as a whole but whose halves were rebuilt, with no pool found below it (it fails for its size), is counted once as an error and logged as the **warning** `a batch of N pool(s) failed as a whole, but its halves were rebuilt`, so that it leaves a trace.
  - Each field is filled forward from the latest non-null value over that pool's state rows: `argMaxIf(field, (ledger_index, tx_index), isNotNull(field))`. The rows are read from a window of the last `AMM_FILL_WINDOW_LEDGERS` (160,000, about seven days) ledgers first, a range of the primary key of each pool, and a pool for which a column is still null in it (or that has no row in it) is read further back in steps that double, each reading only the ledgers before the ones already read, until it has every column or its first ledger is reached: the answer is the one the whole history gives, and a pool pays for the distance back to its oldest needed value (an AMM-node row: a swap carries neither the fee, nor the LP supply, nor the slot), the whole history only if a value is null for ever (Rulings R-A21 and R-A23).
  - `value_native` is then computed.
  - Each pool's row is rewritten under a new version.
- **`amm_daily`.** It works like `volume_daily`: one version per day set (every pool active that day, plus the sentinel), and closed days back-filled newest first under a budget. It runs at the first tick and then every 5 ticks (not every tick), with a budget of 4 s (`AGGREGATOR_AMM_DAILY_BUDGET_MS`), after `stats_dirty`. A run does today, and yesterday until its set is final for the current `AMM_DAILY_CONFIG_VERSION` (the stalest first, a day that failed last time behind the other), then the days that failed on the dirty path and are due again, then the closed days from the day of the first pool activity, newest first; the back-fill starts at least one closed day at each run, whatever is left of the budget. The state of a pool (the closing state and the fee state at the start of the day) is read like that of `amm_pools`: from a window of `AMM_FILL_WINDOW_LEDGERS` ledgers before the day, then in older, doubling steps for the pools the window does not answer for; the fee state at the start of the day (the fee and the slot) is looked for further back only for the pools with swaps that day. The floor of a run is one day that starts whatever is left of the budget: a due owed day if there is one, else the newest wanted closed day.
  - A day counts as final once the newest committed ledger is at least an hour past that day's end; the sentinel records it (`final`), and a day is back-filled only when it is before yesterday and the ingest has passed it. A day that fails is counted once in `syncer_aggregator_errors_total{job="amm_daily"}` and tried again at the next run (a closed day waits 5 minutes, doubling, while the older days go on).
  - It recomputes days in `agg_dirty` ranges (errors under `job="amm_daily_dirty"`). A day that fails there does not hold its range: it is counted, owed to the `amm_daily` job, which tries it again after 5 minutes, doubling up to an hour, and the slice and the range go on (Ruling R-A22).
  - Only committed ledgers are read: the day is cut at the newest `ledgers` row, read once per run before any other table.
  - The pools of a day come from `amm_pool_touches`, by a range of its primary key. Their swaps come from the `exchanges` rows where `amm_account` is set, read through the pair key of each pool (its four asset columns, then the ledgers) and the `amm_account_set` skip index; the exchanges are never scanned across pairs. Liquidity comes from `amm_liquidity` and the closing state from `amm_pool_states`, carried forward up to the last ledger of the day. A create counts as a deposit and a clawback as a withdrawal.
  - For a swap, the asset that flowed into the pool is the input: `volume_base` and `volume_counter` are the sums of the inputs by side. The fee estimate of a swap is the input times the fee in force at that swap over 100000: the pool's trading fee filled forward over its state rows up to the swap (no fee is charged for a swap before any row shows it), or the auction slot's discounted fee when the taker is the slot holder or one of the `auth_accounts` of the holder's last bid (`amm_governance`), unless the slot has expired (the expiration is in the AMM node's slot and stays there after the slot ran out; rippled gives no discount then).
  - A pool deleted during the day has its row (its activity counts), the deleted state as its closing state, and no value.
- **`amm_volume`.** It is a new metric in the volume job (`VOLUME_METRICS`), written by the existing `volume_live`, `volume_daily` and `volume_backfill` jobs, with their version sets, sentinel, `config_version` and `volumeDaysDone`; no new table and no new job. Live sets are written for hour, day, 3day, 7day and 30day (`TRADE_LIVE_PERIODS`); daily sets are written per day. Xahau has no AMM: its sets are the sentinel only, and the route answers rows of zero totals and no component.
  - Components are per pool (`component` is the pool account, `amount` the volume of the pool's base), built from the `exchanges` rows where `amm_account` is set, read through the keys of the tables and never by a scan of the exchanges across the pairs (Rulings R-A3 and R-A18):
    1. the window becomes a range of ledgers from `ledgers` (as `RatesService` does), so only committed ledgers are read, never past the newest `ledgers` row;
    2. the pools of the window are the `amm_account` of `amm_pool_touches` over that range, each with the first ledger it was touched in (a range of its primary key);
    3. their pairs are one row per pool of `amm_pool_states`, read by the pool key and that first ledger (two columns of its primary key: about a granule a pool, not the pool's state rows of the window; not `amm_pools`, which the aggregator may not have built yet);
    4. their swaps are read in chunks of `AMM_CHUNK` (200) pools: the pair tuples (the pair prefix of the primary key of `exchanges`, as `RatesService.pairSums` reads them) and `amm_account` and the range, each swap once (`LIMIT 1 BY` the key), the native legs of 0.0005 or less left out, summed per pool. `amm_daily` finds its pools and swaps the same way (`amm-reads.ts`).
  - It is not limited to configured markets: every pool with volume counts.
  - Each component is converted to native like a trade component, with the shared code (Ruling R-A19). The units of an asset per native coin are taken from the configured trade markets against the native currency in the same window, exactly as the trade components take them, and for an asset they have none for (or a rate of 0) from the pools against the native currency in the same window (all their base volume over all their native volume). Only the pools that are not against the native currency use a rate, so only the configured markets against the native currency whose base is one of their two assets are read, and none when there is no such pool. A pool against the native currency is converted to its own native volume, with its own base volume over native volume as the `rate` (a pool whose canonical pair puts the native currency first is turned round, as the config turns a market round). Any other pool is converted through the rate of its base, else through that of its counter (base and counter swapped, `amount` the counter volume). A pool without a rate on either side is dropped; components are sorted by `converted_amount` desc, then by account.
  - The trade volume (`exchange_volume`) keeps counting the swaps (Ruling R-A11): this metric adds a view, it changes nothing of that one.

Budget order inside the existing tick:

1. `volume_live` (now including `amm_volume` live)
2. `volume_daily`
3. `amm_pools`
4. `stats_live`
5. `stats_dirty`
6. `amm_daily`
7. `volume_backfill`

Each job has its own `budgetMs`, and the tests show that no job starves the live jobs.

## 5. Testing

- **Fixtures.** Extend `scripts/record-fixtures.ts` with a mode that records the ledgers of given transaction hashes. Find the hashes with `account_tx` on a few busy pool accounts, using at most 2 requests in flight against `wss://s2.ripple.com` (`xrplcluster.com` throttles). Record at least these cases:
  - an XRP/IOU swap via `Payment` and via `OfferCreate`;
  - an IOU/IOU-pool swap, checking whether the pool's `AccountRoot` appears;
  - a payment that crosses two pools;
  - a payment that crosses a pool and an order book;
  - an autobridged `OfferCreate` with a pool leg;
  - each deposit and withdraw mode, including a withdraw-all that deletes the pool;
  - `AMMVote`, `AMMBid`, `AMMClawback` and `AMMDelete`;
  - an LP-token transfer.
- **Parser golden tests, with invariants.**
  - For each swap, the pool's in and out deltas equal the exchange row amounts.
  - For each transaction, the IOU and native conservation checks of R4/R4b still hold.
  - Liquidity LP deltas equal the `LPTokenBalance` delta.
  - Every row key is unique per table.
  - An independent oracle, written in the spec's terms, reproduces the parser's rows for every recorded case.
- **Ingest and recovery.** The new tables join the existing tests:
  - fault injection between child inserts and the commit;
  - range-ingest redo;
  - partition deletes;
  - real-duplicate reads: STOP MERGES, then a separate insert with `insert_deduplicate: 0`.
- **API end-to-end.** Seed the recorded fixtures through the real `LedgerWriter`. Each new route gets:
  - an empty range, marker pages that concatenate to the unpaged list, and descending order;
  - unknown params ignored, exact error messages, CSV, and `Object.keys` order pinned;
  - an EXPLAIN plus a `read_rows` bound for each paged read (R106 pattern);
  - an empty-answer case on Xahau.
- **Existing exchange endpoints** get these cases:
  - `amm=include|exclude|only` behaves as specified, and an invalid value gives 400;
  - the existing parity tests still pass, since the mock ledgers predate AMM and so have no AMM rows;
  - rates and volumes include AMM swaps.
- **Aggregator.** Unit tests with fake timers cover the new jobs' scheduling, budgets, finality, dirty ranges, version sets and the fill-forward. A real-ClickHouse end-to-end test covers `amm_pools` and `amm_daily` recompute idempotence.

## 6. Documentation and rollout

- **Docs:** add ADR-0011 (AMM data and swaps as exchanges). Update:
  - `docs/api-reference.md`: the new routes, the `amm` filter, and the `amm_account` field;
  - `docs/data-model.md`;
  - `docs/syncer.md` and `docs/operations.md`: the new jobs, the counter, and the re-ingest with `--reprocess` from the AMM enablement ledger;
  - `docs/openapi.yaml`.
- **ADR-0010:** record the deliberate deviation that exchange-based Ripple endpoints now include AMM swaps.
- **Rollout:** existing databases need the new baseline, by recreating them since nothing is deployed yet. Then run `range-ingest --reprocess` from the AMM enablement ledger to the live head, so past AMM data appears. Find the exact enablement ledger from the `EnableAmendment` pseudo-transaction and record it in the docs.

## Out of scope

- NFTs and URITokens, MPTokens, the Xahau-native families, and the other identity or oracle objects. They come in later specs, one per family.
- Live `amm_info` reads.
- APR or yield figures beyond the estimated fees.
- LP-token transfer endpoints: transfers are payments and balance changes already.
- Snapshot import of pools that existed before ingest.
