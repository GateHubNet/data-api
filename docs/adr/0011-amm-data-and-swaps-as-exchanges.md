# ADR-0011: AMM data, and swaps as exchanges

**Status:** Accepted. Amends [ADR-0010](0010-ripple-v2-wire-compatibility.md) (deviations 40-44).

## Context
The original Ripple Data API stopped in May 2021, before the XRP Ledger had automated market makers (the AMM amendment was enabled in
ledger 86795265, 2024-03-22; see [backfill](../backfill.md#amm-data-re-ingest)). A swap against a pool is a `Payment` or `OfferCreate`
whose path crosses the pool: its metadata moves the pool account's balances, and no offer is consumed. Deposits, withdrawals, votes, bids,
creation, deletion and clawback are `AMM*` transactions that change the `AMM` object. A client of the original sees none of this unless
the service decides how to show it. Xahau has no AMM.

The design is in [the AMM spec](../superpowers/specs/2026-10-17-amm-data-design.md) and the program rules in
[the roadmap](../superpowers/specs/2026-10-17-amendments-roadmap.md). This ADR holds the decisions the user made, and the rulings made
while building it, each with its reason. The ruling numbers are the ones of the build ledger and appear in comments in the code; the rulings that only concerned how the work was done (R-A5, R-A7) are not recorded here.

## Decision

### What the user decided

| Topic | Decision |
| --- | --- |
| Swaps | A swap against a pool **is an exchange**. It appears in `/v2/exchanges` and everything built on exchanges: candles, `reduce`, exchange rates, normalize, active accounts and trade volume. It is marked (`amm_account`) and can be filtered with `amm=include\|exclude\|only` (default `include`). |
| AMM data | New endpoints cover pools and pool history, swaps, liquidity events, votes and bids, LP positions, network AMM volume and daily pool stats. |
| Pools before the start ledger | Ingest only, like every other endpoint. Complete data needs `range-ingest --reprocess` from the enablement ledger (March 2024); until then a pool appears when it is first touched. |
| Architecture | One pure AMM parser, with swaps written into the existing `exchanges` table. Current state and daily stats are aggregates the aggregator rebuilds, never written by ingest. |

### What was built
- **Ingest.** `AmmParser` turns each successful transaction into swap rows (`exchanges` and `account_exchanges`, with `amm_account`), pool
  state rows (`amm_pool_states`, `amm_pool_touches`), liquidity rows (`amm_liquidity`, `account_amm_liquidity`) and governance rows
  (`amm_governance`). `PARSER_VERSION` is 2. Pools or reserve lines it cannot turn into rows are counted in `syncer_amm_unclassified_total`.
- **Aggregation.** `amm_pools` (the current state of each pool) and `amm_daily` (one row per pool and UTC day) are new aggregator jobs;
  `amm_volume` is a third metric of the volume jobs. See [syncer](../syncer.md#7-the-aggregator).
- **API.** Ten routes under `/v2/amm`, `/v2/accounts/{address}` and `/v2/network`, the `amm` filter, and `amm_account` on exchange
  objects. See [api-reference](../api-reference.md#amm).

### Rulings
Each ruling is a decision with the reason it was made.

| Ruling | Decision | Reason |
| --- | --- | --- |
| R-A1 | `exchanges` and `account_exchanges` carry `INDEX amm_account_set amm_account TYPE set(1024) GRANULARITY 1`. "Bounded" for `amm=only` means `read_rows` at most (granules holding AMM rows + 2) × `index_granularity`. | `amm_account` is not in the key, so a filter on it cannot bound a read by itself. The set index skips the granules that hold no swap. |
| R-A2 | Every AMM ledger table that is ordered by pool or account gets `INDEX ledger_mm ledger_index TYPE minmax GRANULARITY 1`. | "Changed since ledger" and day scans have to skip parts. R-A14 explains why that is not enough once parts merge. |
| R-A3 | `amm_daily` and `amm_volume` read swaps per active pool through the pair key (`pair = the pool's pair AND amm_account = pool AND a range of ledgers`). They never scan `exchanges` across pairs. | The exchanges table is ordered by pair; a cross-pair scan reads the whole window. |
| R-A4 | `GET /v2/amm/pools` sorts the latest-version set of `amm_pools` in SQL by `(value_native DESC NULLS LAST, amm_account)` with a keyset marker on both. It is exempt from the in-order EXPLAIN test, and its `read_rows` bound is the table's row count. | `amm_pools` is ordered by account and has thousands of rows, so no in-order read by value exists. Revisit with an ordered aggregate if pools reach millions. |
| R-A6 | An IOU/IOU pool appears in swap metadata only as `RippleState` nodes carrying `lsfAMMNode` (0x01000000), with neither the pool `AccountRoot` nor the `AMM` node. Pool detection is: `AccountRoot` nodes with `AMMID`, plus `AMM` nodes' `Account`, plus, for every `RippleState` with `lsfAMMNode`, the side that holds the reserve (`lsfLowReserve` gives `LowLimit.issuer`, `lsfHighReserve` gives `HighLimit.issuer`). An LP-token line alone does not make a pool "touched". | Recorded mainnet ledgers show all 1,852 swaps of the RLUSD/USDC pool without the pool account. The first design (find the `AccountRoot` or the `AMM` node) would have missed every IOU/IOU swap. |
| R-A8 | `*_f` Float64 shadows exist on state and liquidity amounts (aggregates keep exact `String` sums; only `value_native` is Float64). `amm_daily` is partitioned by `toYYYYMM(day)`. `amm_pools.created_ledger` and `created_by` are `Nullable`. The liquidity and governance tables carry no pair columns. | A pool first seen in the middle of its life has no creation row. The pair of a pool never changes, so it is read from `amm_pool_states`. |
| R-A9 | A swap row may carry the autobridged currency and issuer. `unclassified` counts every touched pool that yields no swap, liquidity or governance row, plus pools with an unknown pair and `lsfAMMNode` lines nothing can place. A deleted pool's state keeps the fee and auction fields from `FinalFields`, with `lp_supply` `'0'`. XRP amounts are whole XRP, as in order-book rows. The `mode` is set only when exactly one mode flag is set. | Follows the existing exchange parser. Some counter noise is accepted: the counter flags shapes the parser does not know. |
| R-A10 | An AMM swap's amounts are the **pool's deltas** (spec section 2.3). On the asset the pool pays out they include the issuer's transfer fee: 83.28354 paid by the pool against 83.11731 received, for a transfer rate of 0.2%. Book rows use the offer's `TakerGets` change, which excludes the fee. Fee estimates use the pool's input side only. | A pure parser cannot know an issuer's `TransferRate`. The rate of a pool with a fee-charging issuer is biased by at most the transfer fee. |
| R-A11 | `ledgers.exchanges_count`, and so the `exchanges_count` of `/v2/stats`, counts AMM swaps. | AMM swaps are exchanges everywhere. A filter can follow if anyone needs the old figure. |
| R-A12 | `/v2/exchanges?amm=only` reads the remaining range in one read narrowed by the skip index, not in the windows of Ruling R107. The exchange objects of `active_accounts` with `include_exchanges` carry `amm_account` too. | A page costs about all the swap granules of the range; a ledger-ordered swaps index is the follow-up if swaps reach millions. The active-accounts objects are exchange objects. |
| R-A13 | `amm_daily` runs at the first tick and then every 5 ticks, not every tick. | The roadmap's cadence rule: daily-stats jobs run once per N ticks so the 30 s tick is not over-committed. Daily AMM stats lag up to five minutes. |
| R-A14 | A narrow ledger table `amm_pool_touches` (`ledger_index, tx_index, amm_account`, P6) has one row per `amm_pool_states` row. The watermark, the stale-pool scan and the day scans read it by a range of its primary key. | `amm_pool_states` is ordered by pool. Once its parts merge, its `ledger_mm` index prunes no granule and a "which pools changed after ledger L" scan reads the whole partition. |
| R-A15 | A failing `amm_pools` batch is halved to find the pools that fail on their own. Those go to an in-memory retry set with a back-off of 5 minutes doubling to 1 hour, are counted as errors, and the cursor goes on. | One poison pool must not stop the others. A restart recomputes the watermark from the stale pools, which includes them. |
| R-A16 | The value of a pool without a native asset is 2 × the reserve of the first asset (base, then counter) that has a rate, divided by that rate. `created_ledger` and `created_by` come from the earliest `create` row of `amm_liquidity`. | The rate is the one the volume sets divide by, so the figures agree. |
| R-A17 | A day of `amm_daily` is a version set. Its sentinel row (`amm_account` `''`) carries the set's version, a `final` column (1 on the sentinel of a set made after the ingest passed the day) and `config_version`. Readers keep the pool rows with the sentinel's version. | The volume tables' trick of finality in `rate_f` has no analogue here. Without a sentinel a pool-day that vanished from a recompute would linger. |
| R-A18 | `amm_volume` reads active pools from `amm_pool_touches` (primary-key range), their pairs from `amm_pool_states` (primary-key prefix, not `amm_pools`), then one `exchanges` read by pair tuples and `amm_account`. | R-A3. `amm_pools` may not exist yet for a new pool. |
| R-A19 | `amm_volume` converts like the trade components, with the shared code. The native rates come from the configured native markets first, then from the AMM pools against the native currency in the same window. | Pool assets the markets config does not list would otherwise all be dropped. Tokens that trade only on AMM get an AMM-derived rate. |
| R-A20 | The auction slot's discounted fee applies only while the slot is unexpired. An unknown fee counts as 0 with the volume still counted. `amm_daily` has no dust filter. A create counts as a deposit and a clawback as a withdrawal. | rippled gives no discount once the slot ran out, and stale slots in real data would overstate discounts. Per-pool stats describe the pool, not a price series. |
| R-A21 | The fill-forward (the newest non-null value of each state column) reads a window of `AMM_FILL_WINDOW_LEDGERS` (160,000, about a week) first, then goes further back only for the pools the window leaves incomplete. Yesterday is not recomputed once its newest set is final for the current config version. | The unbounded form was quadratic in a back-fill. The result is identical to reading the whole history. |
| R-A22 | A failure of an `amm_daily_dirty` day is counted, the day goes to an in-memory retry set with the closed-day back-off, and the `agg_dirty` slice completes. | A failing day must not hold its range (and the stats behind it) for ever. |
| R-A23 | The walk back from the window runs in disjoint doubling steps (the last one reaches the first ledger). One floor day starts at each `amm_daily` run, a due owed day first. `amm_daily` requires the carry columns only for pools with swaps. | A busy pool without LP activity for a week would otherwise be read whole at every recompute. Owed days would otherwise starve while today takes the budget. |
| R-A24 | AMM objects use flat Ripple-style keys (`base_currency`, `base_issuer`, ...), exact string amounts, `value_native` as a string, `trading_fee` as stored, the auction fields grouped as `auction_slot {holder, price, discounted_fee, expiration}`, and a `deleted` boolean. The key order is written once in `amm-objects.ts` and pinned by tests. | There is no Ripple contract to match, so the shape is ours. One place for it avoids drift. |
| `amm_daily` spec text | The aggregation text of the spec (sections 1 and 4) written by the implementer of `amm_daily` is accepted as part of the spec. | It matches R-A17 and R-A20. |
| `amm_volume` reads | The AMM live sets read only the native markets whose base is an asset of a non-native pool, and skip the read when every pool is native. The touches read returns `min(ledger_index)` per pool and pairs are read by `(amm_account, first ledger)`. A market rate of 0 no longer blocks the pool-derived rate. | Cost on every tick: about one granule per pool instead of the pool's history in the window. |
| Pool routes: `value_native`, the 404 rule | `value_native` is served as a plain decimal of 8 significant digits, trailing zeros dropped, never in exponent form (`valueText`). `GET /v2/amm/pools/:pool` and the pair form answer 404 until the pool's first `amm_pools` tick (at most about a minute), while history and days are found as soon as the ledger is committed. The asset filter of the list is applied before the newest version of each pool is picked. | `precision8`, the text of a rate, writes `1.2345679e+8` from 1e8 up. A pool account's pair never changes, so filtering first is equivalent and keeps the sort small. |
| Pool event routes and positions | `/pools/:pool/swaps` keeps the exchange route's limit (default 200, maximum 400). It ignores `amm`. Positions are not paged. There is no currency index on `balance_changes`. Event objects carry no pair. The quotients of a position are exact decimals, with 30 significant digits only when the quotient does not terminate. | The spec says "the same params as `/v2/exchanges/:base/:counter`", the more specific rule over the global limit of 1000. A balance read is bounded by the account prefix. The pair of a pool is on `GET /v2/amm/pools/:pool`. |

## Consequences
**Positive**
- A client sees AMM swaps in every exchange-based answer without changing a call, and can ask for the old view with `amm=exclude`.
- Pool state is rebuilt from append-only history by the aggregator, so a recovery delete can never lose a state after merges have dropped older rows.
- Every AMM read is a range of a primary key up to the newest committed ledger, with no `FINAL` and no cross-pair scan.

**Negative / trade-offs**
- Exchange-based Ripple endpoints now differ from `data.ripple.com` (deviations 40-44 of [ADR-0010](0010-ripple-v2-wire-compatibility.md)).
- Swap amounts on the paid-out side include the issuer's transfer fee, and the rate of such a swap is biased by it (R-A10).
- A brand-new pool answers 404 on `GET /v2/amm/pools/:pool` for up to a minute (the pool routes ruling above), though its swaps, liquidity and history are already served.
- Complete history needs a reprocess from ledger 86795265 on XRPL, and the aggregator then rebuilds the pool and daily tables from `agg_dirty`.
- Daily AMM stats lag up to five minutes (R-A13), and a pool that keeps failing is stale until its retry (R-A15).
- The fee figures (`fees_*_est`) are estimates, and `amm_positions` reads a holder's whole LP-token balance history up to the date.
