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

The facts below were checked on recorded mainnet ledgers in `packages/shared/test/fixtures/xrpl/recorded`.

- **The pool account.** Every pool has a pseudo-account: an `AccountRoot` whose fields include `AMMID`. It holds the pool's XRP in its `Balance`. It holds IOU reserves on trust lines with each issuer. It issues the LP token, whose currency is a 40-hex code starting with `03`.
- **The `AMM` object** holds the pool's settings, not its reserves:
  - `Account` (the pool account), `Asset` and `Asset2`;
  - `LPTokenBalance` (the LP-token supply);
  - `TradingFee`, in units of 1/100000;
  - `VoteSlots` and `AuctionSlot` (`Account`, `Price`, `DiscountedFee`, `Expiration`, `AuthAccounts`).
- **A swap** is a `Payment` or `OfferCreate` whose path goes through the pool. Its metadata changes the pool account's `AccountRoot` and/or its trust lines. The `AMM` object is not touched. In the recorded sample the pool's `AccountRoot` was present in all 14 swap cases. One path can cross several pools, in which case each pool appears with its own nodes.
- **Deposits, withdrawals, votes, bids, create, delete and clawback** modify the `AMM` object, so its `Account` names the pool. One recorded `AMMWithdraw` changed a pool trust line without the pool `AccountRoot` being in the metadata.

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
  - `node_index` is the index, in `AffectedNodes`, of the pool account's `AccountRoot` node. If that node is absent, it is the pool's first trust-line node. This keeps the key unique, and order-book rows never use those nodes.

**New ledger tables**

| Table | Partition | ORDER BY | Holds |
|---|---|---|---|
| `amm_pool_states` | P7 | `(amm_account, ledger_index, tx_index)` | One row per pool and transaction that touched the pool. Columns: `tx_hash`, `close_time`, `tx_type`, the pool's assets in canonical pair order (`base_*`, `counter_*`), and the values after the transaction. The values are `reserve_base`, `reserve_counter`, `lp_supply`, `lp_currency`, `trading_fee`, `auction_holder`, `auction_price`, `auction_discounted_fee`, `auction_expiration` and `deleted`. A value is `Nullable` and filled only when the transaction changed it; readers carry the last known value forward. |
| `amm_liquidity` | P7 | `(amm_account, ledger_index, tx_index)` | One row per create, deposit, withdraw, clawback or delete. Columns: `account` (the LP), `initiator` (differs for clawback), `event`, `mode` (from the flags: `lp_token`, `single_asset`, `two_asset`, `one_asset_lp_token`, `limit_lp_token`, `two_asset_if_empty`, `withdraw_all`, `one_asset_withdraw_all`), `base_amount`, `counter_amount` (signed, pool perspective: + in, − out), `lp_tokens` (signed: + minted, − burned), plus `_f` shadows. |
| `account_amm_liquidity` | P7 | `(account, ledger_index, tx_index, amm_account)` | A narrow index for per-account lists, like `account_payments`. It has the same columns as `amm_liquidity`. |
| `amm_governance` | P7 | `(amm_account, ledger_index, tx_index)` | One row per `AMMVote` or `AMMBid`. Columns: `kind`, `account`, `fee_voted` (vote), `trading_fee_after`, `bid_min`, `bid_max`, `price_paid` (LP tokens burned by the bid), `slot_holder`, `slot_discounted_fee`, `slot_expiration`, `auth_accounts`. |

**New aggregate tables.** These are written by the syncer's aggregator, are recomputable, and use `ReplacingMergeTree(version)`.

| Table | ORDER BY | Holds |
|---|---|---|
| `amm_pools` | `amm_account` | The current state of each pool, for the pool list. Columns: the assets, `lp_currency`, `created_ledger`, `created_by`, `last_ledger`, `reserve_base`, `reserve_counter`, `lp_supply`, `trading_fee`, the auction slot, `deleted`, `value_native` and `version`. The aggregator rebuilds it from `amm_pool_states`, never ingest. A crash recovery that deletes a newer state row therefore cannot lose a pool's state after a merge. |
| `amm_daily` | `(amm_account, day)` | One row per pool per UTC day with activity, plus a closing state. Columns: `swap_count`, `volume_base`, `volume_counter` (the amounts that went in, by side), `fees_base_est`, `fees_counter_est`, `deposit_count`, `withdraw_count`, liquidity in and out per side, the end-of-day reserves, `lp_supply`, `trading_fee`, `value_native`, `config_version` and `version`. |

**AMM network volume** becomes a third metric, `amm_volume`, in the existing `volume_live` and `volume_daily` sets. It needs no new table.

**LP positions** need no table either. LP tokens are trust lines issued by the pool account, so `balance_changes` already records them.

## 2. Parsing

A new pure parser, `packages/shared/src/parsers/amm.parser.ts`, plugs into `buildLedgerRows` next to the existing ones. It follows the same rules: deep-frozen input, `ParseContext`, and a successful (`tes*`) transaction only.

1. **Pools in a transaction.** The pools are the `Account` of every `AccountRoot` node with `AMMID`, plus the `Account` of every `AMM` node (created, modified or deleted). A pool trust line is a `RippleState` whose high or low limit issuer is one of those accounts. The parser does not keep state across ledgers.
2. **Pool deltas.** For each pool, take the change in each asset it holds from Previous to Final fields:
   - XRP from `AccountRoot.Balance`, in drops;
   - an IOU from the trust line with its issuer, from the pool's side, which means flipping the sign when the pool is the high account.

   LP-token trust lines, where the pool is the issuer and the currency starts with `03`, are excluded from reserves. They are used for LP deltas.
3. **Swaps.** In a `Payment` or `OfferCreate`, a pool whose two non-LP deltas have opposite signs is a swap: one asset in, the other out.
   - It becomes one `exchanges` row in the canonical pair order of the existing exchange parser, with amounts equal to the absolute deltas.
   - `rate` uses the same formula and string rules as the order-book rows: counter over base, exact text.
   - `taker` is the transaction `Account`. If base flowed out of the pool, `buyer` is the taker and `seller` is the pool; otherwise the reverse.
   - `provider` and `amm_account` are the pool, and `offer_sequence` is 0.
   - `tx_type`, `client` and the autobridged fields follow the existing rules. An `OfferCreate` crossing books through XRP is autobridged whether a leg was an offer or a pool.
   - A pool whose deltas don't form exactly one in and one out in a `Payment` or `OfferCreate` writes a state row but no swap. It is also counted in a Prometheus counter, `syncer_amm_unclassified_total`.
4. **Liquidity events.** These come from `AMMCreate`, `AMMDeposit`, `AMMWithdraw`, `AMMClawback` and `AMMDelete`:
   - Amounts are the pool deltas.
   - `lp_tokens` is the change in `LPTokenBalance` on the `AMM` node: the `NewFields` value for a create, and the full previous balance, negated, when the node is deleted.
   - `account` is the transaction `Account`, except for `AMMClawback`, where it is the `Holder` and `initiator` is the issuer.
   - `mode` is derived from the transaction flags.
   - A withdrawal that empties the pool deletes the `AMM` node. It writes a `withdraw` event, and the state row is marked `deleted`.
5. **Governance.**
   - An `AMMVote` row records the voter, `FeeVal` and the resulting `TradingFee`.
   - An `AMMBid` row records the bidder, `BidMin` and `BidMax`, and `price_paid` (the LP tokens the bid burned, from the change in `LPTokenBalance`). It also records the new `AuctionSlot` fields.
6. **State rows.** Every pool touched by a transaction gets one `amm_pool_states` row:
   - The reserves come from the nodes present.
   - `lp_supply`, `trading_fee` and the auction fields come from the `AMM` node, when it is in the metadata.
   - Anything the transaction did not touch is left null.
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

**Changes to existing routes**

- **Exchange objects** gain a last key, `amm_account`, only on AMM rows. Order-book rows are unchanged.
- **The `amm` filter** is accepted by `/v2/exchanges/:base/:counter` (raw, `interval` and `reduce`), `/v2/exchanges` and `/v2/accounts/:address/exchanges`.
  - Values are `include` (default), `exclude` and `only`.
  - Anything else gives 400 `invalid amm filter - use: include, exclude, only`.
- **Exchange rates, normalize, active accounts and trade volume** always include AMM swaps. They take no filter parameter.
- **Native dust legs** (≤ 0.0005) are dropped from AMM rows exactly as from order-book rows.

**Pool value.** `value_native` is computed as follows:

- If one of the assets is native, it is 2 × the native reserve. This is exact for a constant-product pool at equilibrium.
- Otherwise it is 2 × a reserve times that asset's native rate. The rate comes from `RatesService` daily native rates, base first, then counter.
- If neither asset has a rate, `value_native` is omitted.

**Fees.** Earned fees are estimates. Each swap's input amount is multiplied by the pool's trading fee at that point, or by the auction slot's discounted fee when the taker is the slot holder or one of its authorized accounts, divided by 100000. They are named `*_est` in responses and documented as estimates.

**Xahau.** The AMM routes exist there too, and answer empty lists, 404 `pool not found`, or zero volume.

## 4. Aggregation

There are three new aggregator jobs in `apps/syncer/src/aggregator`. They use the existing tick, budgets (R83), finality rules (R86) and failure ordering (R87).

- **`amm_pools`.** Every tick, it recomputes the pools whose states changed since its watermark, plus pools in `agg_dirty` ranges.
  - Each field is filled forward from the latest non-null value over that pool's state rows: `argMaxIf(field, (ledger_index, tx_index), isNotNull(field))`.
  - `value_native` is then computed.
  - Each pool's row is rewritten under a new version.
- **`amm_daily`.** It works like `volume_daily`: one version per (pool, day) set, today and yesterday every tick, and closed days back-filled newest first under a budget.
  - A day counts as final once the newest ingested ledger is at least an hour past that day's end.
  - It recomputes days in `agg_dirty` ranges.
  - Swap volume and fees come from the `exchanges` rows where `amm_account` is set. Liquidity comes from `amm_liquidity`, and the closing state from `amm_pool_states`, carried forward.
- **`amm_volume`.** It is a new metric in the volume job. Live sets are written for hour, day, 3day, 7day and 30day; daily sets are written per day.
  - Components are per pool, built from the `exchanges` rows where `amm_account` is set.
  - Each component is converted to native the same way as trade-volume components.
  - It is not limited to configured markets: every pool with volume counts.

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
